// Real Vite and HTTP sockets; the upstream is a held synthetic peer, not an LLM.
import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent, createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createServer as createViteServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function bounded(promise) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(3000, undefined, { signal: controller.signal }).then(() => {
        throw new Error("Timed out waiting for the native HTTP boundary");
      }),
    ]);
  } finally { controller.abort(); }
}

async function fixture(singleSocket = false) {
  const rows = new Map();
  const expected = new Map();
  const upstream = createHttpServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const row = { response, body, closed: deferred(), cancelled: false };
    response.once("close", () => {
      row.cancelled = !response.writableEnded;
      row.closed.resolve();
    });
    rows.set(body, row);
    expected.get(body)?.resolve(row);
    // Deliberately no headers until the test owner explicitly releases it.
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const previousPort = process.env.API_PORT;
  process.env.API_PORT = String(upstream.address().port);
  let vite;
  const agent = singleSocket ? new Agent({ keepAlive: true, maxSockets: 1 }) : undefined;
  try {
    vite = await createViteServer({
      root, configFile: root + "vite.config.ts", logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false,
        ...(agent ? { proxy: { "/api": { agent } } } : {}),
      },
    });
    await vite.listen();
  } catch (error) {
    upstream.closeAllConnections();
    agent?.destroy();
    await vite?.close();
    await new Promise(resolve => upstream.close(resolve));
    throw error;
  } finally {
    if (previousPort === undefined) delete process.env.API_PORT;
    else process.env.API_PORT = previousPort;
  }
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const pending = [];
  return {
    rows,
    agent,
    send(body, path = "/api/wiki/chat", method = "POST") {
      const accepted = deferred(); expected.set(body, accepted);
      const controller = new AbortController();
      const result = fetch(base + path, { method, body, signal: controller.signal });
      // Observe errors immediately, including deliberate client cancellation.
      pending.push(result.catch(() => undefined));
      return { controller, result, get accepted() { return bounded(accepted.promise); } };
    },
    async close() {
      for (const row of rows.values()) if (!row.response.destroyed) row.response.end();
      upstream.closeAllConnections();
      agent?.destroy();
      await vite.close();
      await new Promise(resolve => upstream.close(resolve));
      await Promise.all(pending);
    },
  };
}

test("fully received chat POST disconnect cancels only its waiting upstream", async () => {
  const f = await fixture();
  try {
    const stopped = f.send("stopped", "/api/wiki/chat?test=held");
    const active = f.send("active");
    const [stopRow, activeRow] = await Promise.all([stopped.accepted, active.accepted]);
    assert.equal(stopRow.body, "stopped");
    stopped.controller.abort();
    await assert.rejects(stopped.result, { name: "AbortError" });
    await bounded(stopRow.closed.promise);
    assert.equal(stopRow.cancelled, true);
    assert.equal(activeRow.response.destroyed, false);
    activeRow.response.end("completed independent chat");
    const response = await active.result;
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "completed independent chat");
    await bounded(activeRow.closed.promise);
    assert.equal(activeRow.cancelled, false);
  } finally { await f.close(); }
});

test("chat already disconnected while waiting for an upstream socket never executes", async () => {
  const f = await fixture(true);
  try {
    const first = f.send("occupies only upstream socket");
    const firstRow = await first.accepted;
    const queued = f.send("already disconnected queued chat");
    // Observe the actual Node Agent queue after the complete POST is buffered.
    let buffered = false;
    for (let i = 0; i < 100; i++) {
      buffered = Object.values(f.agent.requests).flat().some(request => request.writableEnded);
      if (buffered) break;
      await delay(10);
    }
    assert.equal(buffered, true);
    queued.controller.abort();
    await assert.rejects(queued.result, { name: "AbortError" });
    // Let the close event reach Vite before the queued request obtains a socket.
    await delay(50);
    firstRow.response.end("first completed");
    assert.equal(await (await first.result).text(), "first completed");
    await delay(100);
    assert.equal(f.rows.has("already disconnected queued chat"), false);
  } finally { await f.close(); }
});

for (const status of [200, 503]) {
  test(`completed chat HTTP ${status} is preserved and allows another request`, async () => {
    const f = await fixture();
    try {
      for (const key of ["first", "next"]) {
        const sent = f.send(key);
        const row = await sent.accepted;
        row.response.writeHead(status, { "Content-Type": "application/json" });
        row.response.end(JSON.stringify({ synthetic: key }));
        const response = await sent.result;
        assert.equal(response.status, status);
        assert.deepEqual(await response.json(), { synthetic: key });
        await bounded(row.closed.promise);
        assert.equal(row.cancelled, false);
      }
    } finally { await f.close(); }
  });
}

test("the new pre-header cancellation hook does not change page writes", async () => {
  const f = await fixture();
  try {
    const sent = f.send("synthetic page mutation", "/api/wiki/pages/harbor");
    const row = await sent.accepted;
    sent.controller.abort();
    await assert.rejects(sent.result, { name: "AbortError" });
    await delay(100);
    assert.equal(row.response.destroyed, false);
    row.response.end("owner completed fixture mutation");
    await bounded(row.closed.promise);
    assert.equal(row.cancelled, false);
  } finally { await f.close(); }
});
