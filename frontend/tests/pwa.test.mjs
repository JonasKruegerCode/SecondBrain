import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/pwa.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
let moduleId = 0;

// These fixtures exercise application event handling, not browser lifecycle fidelity.
function worker(state) {
  return Object.assign(new EventTarget(), {
    state,
    messages: [],
    postMessage(message) { this.messages.push(message); },
  });
}

async function fixture(t, { active = worker("activated"), installing = null, waiting = null } = {}) {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const registration = Object.assign(new EventTarget(), {
    active, installing, waiting, update: async () => {},
  });
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: active, register: async () => registration,
  });
  let reloads = 0;
  let allowed = true;
  const replacements = {
    window, document, navigator: { onLine: true, serviceWorker },
    location: { reload() { reloads++; } },
  };
  const descriptors = new Map(Object.keys(replacements).map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  // A unique module URL resets module-level state between tests.
  const app = await import(`data:text/javascript;base64,${Buffer.from(compiled + `\n// fixture ${++moduleId}`).toString("base64")}`);
  let state;
  app.observePwa(value => { state = value; });
  app.startPwa(() => allowed);
  window.dispatchEvent(new Event("load"));
  // register() resolves immediately; let its application continuation inspect it.
  await Promise.resolve();
  return {
    app, registration, serviceWorker,
    get state() { return state; },
    get reloads() { return reloads; },
    allowReload(value) { allowed = value; },
    installed(candidate) {
      registration.installing = null;
      registration.waiting = candidate;
      candidate.state = "installed";
      candidate.dispatchEvent(new Event("statechange"));
    },
  };
}

function assertUpdateCanActivate(f, candidate) {
  assert.equal(f.state.updateAvailable, true, "a waiting update must be offered");
  f.app.applyUpdate();
  assert.deepEqual(candidate.messages, [{ type: "SKIP_WAITING" }]);
  assert.equal(f.reloads, 0, "activation, rather than the button itself, triggers reload");
}

test("registration observes an update that is already installing", async t => {
  const candidate = worker("installing");
  const f = await fixture(t, { installing: candidate });
  assert.equal(f.state.updateAvailable, false);
  f.installed(candidate);
  assertUpdateCanActivate(f, candidate);
});

test("future updatefound observes the installing worker", async t => {
  const f = await fixture(t);
  const candidate = worker("installing");
  f.registration.installing = candidate;
  f.registration.dispatchEvent(new Event("updatefound"));
  f.installed(candidate);
  assertUpdateCanActivate(f, candidate);
});

test("registration offers a worker that is already waiting", async t => {
  const candidate = worker("installed");
  const f = await fixture(t, { waiting: candidate });
  assertUpdateCanActivate(f, candidate);
});

test("first installation stays quiet when controller arrives before installed callback", async t => {
  const f = await fixture(t, { active: null });
  const candidate = worker("installing");
  f.registration.installing = candidate;
  f.registration.dispatchEvent(new Event("updatefound"));
  // Explicit adverse callback ordering: first claim becomes visible before the
  // application's installed callback. This is a state-machine fixture only.
  candidate.state = "installed";
  f.registration.active = candidate;
  f.registration.installing = null;
  f.serviceWorker.controller = candidate;
  f.serviceWorker.dispatchEvent(new Event("controllerchange"));
  candidate.dispatchEvent(new Event("statechange"));
  assert.equal(f.state.updateAvailable, false, "the first worker is not an update");
  f.app.applyUpdate();
  assert.deepEqual(candidate.messages, []);
  assert.equal(f.reloads, 0);
});

test("dirty tab retains replacement notice until deliberate safe reload", async t => {
  const f = await fixture(t);
  f.allowReload(false);
  f.serviceWorker.controller = worker("activated");
  f.serviceWorker.dispatchEvent(new Event("controllerchange"));
  assert.equal(f.state.updateAvailable, true);
  assert.equal(f.reloads, 0);
  f.app.applyUpdate();
  assert.equal(f.reloads, 0);
  f.allowReload(true);
  assert.equal(f.state.updateAvailable, true);
  assert.equal(f.reloads, 0, "allowing reload alone must preserve the current document");
  f.app.applyUpdate();
  assert.equal(f.reloads, 1);
  f.app.applyUpdate();
  assert.equal(f.reloads, 1, "reload remains single-shot");
});
