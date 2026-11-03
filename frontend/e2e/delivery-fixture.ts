/** Real local API and Git delivery fixture, isolated from every user vault. */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(process.cwd(), existsSync(join(process.cwd(), "backend/src/second_brain/wiki/api.py")) ? "." : "..");
if (!existsSync(join(root, "scripts/fixtures/delivery-app.py"))) throw new Error("Run the fixture from the repository or frontend directory.");

export async function startDeliveryFixture() {
  const directory = await mkdtemp(join(tmpdir(), "wiki-delivery-e2e-"));
  const vault = join(directory, "vault");
  const remote = join(directory, "remote.git");
  const parked = join(directory, "remote-interrupted.git");
  const python = process.env.WIKI_PYTHON || join(root, "backend/.venv/bin/python");
  // Deliberately allow only process basics; provider/auth/Git overrides cannot leak in.
  // setup-python's shared interpreter in the browser CI container needs its
  // library search path even when the child uses a Poetry virtual environment.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "SYSTEMROOT", "WINDIR", "TMPDIR", "LANG", "LC_ALL", "LD_LIBRARY_PATH"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    XDG_CONFIG_HOME: join(directory, "config"),
    PYTHONPATH: join(root, "backend/src"), PYTHONUNBUFFERED: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file",
    SECOND_BRAIN_WIKI_VAULT: vault,
    SECOND_BRAIN_WIKI_GIT_SYNC: "1", SECOND_BRAIN_WIKI_GIT_REMOTE: remote,
    SECOND_BRAIN_WIKI_GIT_BRANCH: "wiki",
    SECOND_BRAIN_WIKI_GIT_EXPECTED_REMOTE_REVISION: "empty",
    SECOND_BRAIN_WIKI_GRAPH_INDEX: "0", SECOND_BRAIN_WIKI_VECTOR_INDEX: "0",
  });
  let child: ChildProcess | undefined;
  let proxy: http.Server | undefined;
  let interrupted = false;
  const run = (program: string, args: string[]) => exec(program, args, {
    cwd: root, env, timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
  });
  const gitHead = async (repo: string) =>
    (await run("git", ["--git-dir", repo, "rev-parse", "--verify", "refs/heads/wiki"])).stdout.trim();
  const deliver = async (): Promise<Record<string, any>> => {
    const result = await run(python, ["-m", "second_brain.wiki.delivery_runtime", "--once"]);
    return JSON.parse(result.stdout);
  };
  const reconcileReviewedHeads = async (managedHead: string, remoteHead: string) => {
    if (![managedHead, remoteHead].every(head => /^[a-f0-9]{40}$/.test(head))) throw new Error("Explicit reviewed fixture heads are required");
    try {
      const result = await run(python, ["-m", "second_brain.wiki.delivery_runtime", "--reconcile", "--base-revision", managedHead, "--expected-remote-revision", remoteHead]);
      return { exitCode: 0, body: JSON.parse(result.stdout) as Record<string, any> };
    } catch (error) {
      const failed = error as { code?: string | number; stdout?: string };
      if (failed.code !== 1 || typeof failed.stdout !== "string") throw error;
      const body = JSON.parse(failed.stdout) as Record<string, any>;
      if (typeof body.error !== "string") throw error;
      return { exitCode: 1, body };
    }
  };
  const close = async ({ retain = false }: { retain?: boolean } = {}) => {
    let cleanupError: unknown;
    try {
      if (proxy?.listening) {
        const closed = new Promise<void>((resolveClose, reject) => proxy!.close(error => error ? reject(error) : resolveClose()));
        proxy.closeAllConnections();
        await closed;
      }
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const stopWithin = (signal: NodeJS.Signals) => new Promise<boolean>(resolveStop => {
          if (child!.exitCode !== null || child!.signalCode !== null) { resolveStop(true); return; }
          const onExit = () => finish(true);
          const finish = (exited: boolean) => {
            clearTimeout(timer);
            child!.off("exit", onExit);
            resolveStop(exited);
          };
          const timer = setTimeout(() => finish(false), 5000);
          child!.once("exit", onExit);
          child!.kill(signal);
        });
        if (!(await stopWithin("SIGTERM")) && !(await stopWithin("SIGKILL"))) {
          throw new Error(`Owned fixture process did not exit; retained inputs at ${directory}`);
        }
      }
    } catch (error) { cleanupError = error; }
    if (!retain && !cleanupError) await rm(directory, { recursive: true, force: true });
    if (cleanupError) throw cleanupError;
  };
  try {
    await mkdir(vault);
    await run("git", ["init", "--bare", "--initial-branch=wiki", remote]);
    child = spawn(python, [join(root, "scripts/fixtures/delivery-app.py")], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
    const apiPort = await new Promise<number>((resolvePort, reject) => {
      let output = "";
      const timer = setTimeout(() => done(new Error(`Fixture readiness timed out: ${stderr}`)), 15_000);
      const done = (error?: Error, port?: number) => {
        clearTimeout(timer);
        child!.stdout!.off("data", onData);
        child!.off("error", onError);
        child!.off("exit", onExit);
        error ? reject(error) : resolvePort(port!);
      };
      const onError = (error: Error) => done(error);
      const onExit = () => done(new Error(`Fixture exited before readiness: ${stderr}`));
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (!output.includes("\n")) return;
        try {
          const { port } = JSON.parse(output.split("\n")[0]);
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid fixture port");
          done(undefined, port);
        } catch (error) { done(error as Error); }
      };
      child!.stdout!.on("data", onData);
      child!.once("error", onError);
      child!.once("exit", onExit);
    });
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        const response = await fetch(`http://127.0.0.1:${apiPort}/api/wiki/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) break;
      } catch { /* Server bind precedes ASGI startup; retry within the deadline. */ }
      if (Date.now() > deadline) throw new Error(`Fixture health timed out: ${stderr}`);
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    const initial = await deliver();
    if (initial.remote?.state !== "current") throw new Error("Initial fixture delivery did not complete");
    proxy = http.createServer((incoming, outgoing) => {
      const isApi = incoming.url === "/api" || incoming.url?.startsWith("/api/");
      const request = http.request({
        hostname: "127.0.0.1", port: isApi ? apiPort : 5173,
        path: incoming.url, method: incoming.method, headers: incoming.headers,
      }, response => {
        outgoing.writeHead(response.statusCode || 502, response.headers);
        response.pipe(outgoing);
      });
      request.on("error", () => { outgoing.writeHead(502); outgoing.end(); });
      incoming.on("aborted", () => request.destroy());
      outgoing.on("close", () => request.destroy());
      incoming.pipe(request);
    });
    await new Promise<void>((resolveListen, reject) => {
      proxy!.once("error", reject);
      proxy!.listen(0, "127.0.0.1", () => { proxy!.off("error", reject); resolveListen(); });
    });
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing proxy address");
    return {
      origin: `http://127.0.0.1:${address.port}`, vault, remote, env,
      deliver, reconcileReviewedHeads, head: () => gitHead(join(vault, ".wiki.git")),
      remoteHead: () => gitHead(interrupted ? parked : remote),
      remoteParent: async () => (await run("git", ["--git-dir", interrupted ? parked : remote, "rev-parse", "refs/heads/wiki^"])).stdout.trim(),
      remoteMarkdown: async () => (await run("git", ["--git-dir", interrupted ? parked : remote, "show", "refs/heads/wiki:delivery-page.md"])).stdout,
      advanceRemote: async (markdown: string) => {
        if (interrupted) throw new Error("Restore the owned remote before an independent write");
        const before = await gitHead(remote);
        const writer = join(directory, "independent-writer");
        await run("git", ["clone", "--branch", "wiki", "--", remote, writer]);
        await writeFile(join(writer, "delivery-page.md"), markdown);
        await run("git", ["-C", writer, "add", "--", "delivery-page.md"]);
        await run("git", ["-C", writer, "-c", "user.name=Fixture contributor", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Independent fictional article change"]);
        await run("git", ["-C", writer, "push", "origin", "HEAD:refs/heads/wiki"]);
        const after = await gitHead(remote);
        const parent = (await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/wiki^"])).stdout.trim();
        if (after === before || parent !== before) throw new Error("Independent fixture write did not advance the owned remote");
        return after;
      },
      interruptRemote: async () => {
        if (interrupted) throw new Error("Owned remote already interrupted");
        await stat(remote);
        await rename(remote, parked);
        interrupted = true;
      },
      restoreRemote: async () => {
        if (!interrupted) throw new Error("Owned remote is not interrupted");
        await rename(parked, remote);
        interrupted = false;
      },
      close,
    };
  } catch (error) {
    await close({ retain: true });
    throw error;
  }
}
