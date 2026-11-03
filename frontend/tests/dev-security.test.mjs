// Disposable local HTTP probes; every file and disclosure sentinel is synthetic.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createServer } from "vite";

const project = fileURLToPath(new URL("../", import.meta.url));
async function fixture(mode = "development") {
  const base = await mkdtemp(join(tmpdir(), "secondbrain-vite-boundary-"));
  const root = join(base, "root");
  const allowed = join(root, "node_modules/.vite/deps/entry.js.map");
  const outside = join(base, "outside.map");
  const sourceMap = marker => JSON.stringify({
    version: 3, file: "entry.js", sources: ["synthetic.js"],
    sourcesContent: [marker], names: [], mappings: "",
  });
  let server;
  try {
    await mkdir(dirname(allowed), { recursive: true });
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(root, "index.html"), "<h1>Synthetic dev fixture</h1>");
    await writeFile(join(root, ".env"), "SYNTHETIC_ONLY=never-serve-this-fixture");
    await writeFile(outside, sourceMap("outside-map-fixture"));
    server = await createServer({
      root, mode, configFile: join(project, "vite.config.ts"), logLevel: "silent",
      cacheDir: join(root, "node_modules/.vite"),
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false,
        fs: { strict: true, allow: [root] },
      },
    });
    await server.listen();
    // Vite clears its dependency cache during startup. Seed the allowed
    // control map only after that startup boundary.
    await mkdir(dirname(allowed), { recursive: true });
    await writeFile(allowed, sourceMap("allowed-map-fixture"));
    const port = server.httpServer.address().port;
    return {
      outside, port,
      async close() {
        await server.close();
        await rm(base, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await server?.close();
    await rm(base, { recursive: true, force: true });
    throw error;
  }
}

async function get(port, path, host = "127.0.0.1") {
  // http.request preserves raw ../ segments, unlike fetch's URL normalization.
  const req = request({ host: "127.0.0.1", port, path,
    headers: { host, accept: "application/json" },
  });
  req.setTimeout(5000, () => req.destroy(new Error("Local HTTP probe timed out")));
  req.end();
  const [res] = await once(req, "response");
  let body = "";
  for await (const chunk of res) body += chunk;
  return { status: res.statusCode, body };
}

test("optimized dependency source-map paths cannot escape the allowed root", async () => {
  const f = await fixture();
  try {
    const allowed = await get(f.port, "/node_modules/.vite/deps/entry.js.map");
    assert.equal(allowed.status, 200);
    assert.match(allowed.body, /allowed-map-fixture/);
    const direct = await get(f.port, "/@fs/" + f.outside);
    assert.equal(direct.status, 403);
    const traversal = await get(f.port, "/node_modules/.vite/deps/../../../../outside.map");
    assert.notEqual(traversal.status, 200);
    assert.doesNotMatch(traversal.body, /outside-map-fixture/);
  } finally { await f.close(); }
});

test("dev server keeps denied files and untrusted hosts outside its response", async () => {
  const f = await fixture();
  try {
    const denied = await get(f.port, "/.env");
    assert.equal(denied.status, 403);
    assert.doesNotMatch(denied.body, /never-serve-this-fixture/);
    const host = await get(f.port, "/", "attacker.invalid");
    assert.equal(host.status, 403);
    assert.doesNotMatch(host.body, /Synthetic dev fixture/);
  } finally { await f.close(); }
});



async function hotReloadConnection(port) {
  return new Promise(resolve => {
    const req = request({ host: "127.0.0.1", port, path: "/", headers: {
      connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-protocol": "vite-hmr",
    } });
    let settled = false;
    const finish = accepted => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve(accepted);
    };
    req.on("upgrade", (_response, socket) => { socket.destroy(); finish(true); });
    req.on("response", response => { response.resume(); finish(false); });
    req.on("error", () => finish(false));
    req.setTimeout(1000, () => finish(false));
    req.end();
  });
}

test("demo serves pages without a reconnect reload channel; development keeps it", async () => {
  for (const mode of ["demo", "development"]) {
    const f = await fixture(mode);
    try {
      assert.equal((await get(f.port, "/index.html")).status, 200);
      assert.equal(await hotReloadConnection(f.port), mode === "development");
    } finally { await f.close(); }
  }
});
