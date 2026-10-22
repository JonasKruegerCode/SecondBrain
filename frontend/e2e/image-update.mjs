import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

// A real reverse proxy: worker bytes, API replies and assets are never replaced.
let upstream, server, browser, context, a, b, origin, id, oldHash, before, draft;
let eventCursor = 0;
let closed = false, gate = 'protocol';
const counts = { requests: 0, writes: 0, externalBlocked: 0, modelRequests: 0, navigationsA: 0, navigationsB: 0 };
const events = [], pageErrors = [];
function validate(value) {
  const u = new URL(value);
  assert(u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash, 'upstream must be an exact HTTP 127.0.0.1 origin');
  return u.origin;
}
async function cleanup() {
  closed = true;
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
async function json(path) {
  const response = await fetch(origin + path, { redirect: 'error' });
  assert(response.ok, 'fixture API request failed'); return response.json();
}
async function workerHash() {
  const r = await fetch(origin + '/service-worker.js', { cache: 'no-store', redirect: 'error' });
  assert(r.ok, 'served worker unavailable');
  return createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');
}
async function preference(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('secondbrain.preferences.v1', 1);
    open.onerror = () => reject(new Error('preference open failed'));
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('preferences', 'readonly');
      const get = tx.objectStore('preferences').get('start-page');
      get.onsuccess = () => { resolve(get.result); db.close(); };
      get.onerror = () => { db.close(); reject(new Error('preference read failed')); };
    };
  }));
}
async function controlled(page) {
  await page.waitForFunction(async () => {
    const r = await navigator.serviceWorker.getRegistration('/');
    return r?.active?.state === 'activated' && !!navigator.serviceWorker.controller;
  });
}
async function snapshot() {
  return { pages: await json('/api/wiki/pages'), page: await json(`/api/wiki/pages/${id}`), history: await json(`/api/wiki/pages/${id}/history`) };
}
async function baseline(command) {
  gate = 'baseline-upstream';
  assert(!server, 'baseline already initialized'); upstream = validate(command.upstream);
  id = command.page_id || 'pwa-update-notebook'; assert(/^[a-zA-Z0-9_-]+$/.test(id), 'invalid synthetic fixture id');
  server = createServer((req, res) => {
    counts.requests++;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) counts.writes++;
    if (/^\/(?:api\/wiki\/chat|v1\/(?:chat\/completions|embeddings))(?:\/|\?|$)/.test(req.url)) { counts.modelRequests++; res.writeHead(403); res.end(); return; }
    const destination = new URL(upstream);
    const proxy = httpRequest({ hostname: destination.hostname, port: destination.port, method: req.method, path: req.url, headers: { ...req.headers } }, reply => {
      res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
    });
    proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(proxy);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  gate = 'browser-launch';
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  context = await browser.newContext({ serviceWorkers: 'allow' }); context.setDefaultTimeout(45000);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { counts.externalBlocked++; return route.abort(); }
    return route.continue();
  });
  // Worker network is not intercepted by Playwright routes; the real worker is
  // online-only and the only configured network origin is the loopback gateway.
  await context.addInitScript(() => {
    const documentId = crypto.randomUUID();
    window.__imageUpdateDocument = documentId;
    navigator.serviceWorker?.addEventListener('controllerchange', () => window.__imageUpdateTrace?.push({ type: 'controllerchange', documentId }));
    window.__imageUpdateTrace = [];
  });
  await context.exposeBinding('__imageUpdateEvent', (_source, event) => events.push(event));
  await context.addInitScript(() => {
    navigator.serviceWorker?.addEventListener('controllerchange', () => window.__imageUpdateEvent({ type: 'controllerchange', document: window.__imageUpdateDocument }));
  });
  gate = 'baseline-pages-and-controller';
  a = await context.newPage(); b = await context.newPage();
  for (const [page, label] of [[a, 'A'], [b, 'B']]) {
    page.on('pageerror', () => pageErrors.push(label));
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) counts['navigations' + label]++; });
    await page.goto(`${origin}/wiki/${id}`); await expect(page.locator('article h1')).toBeVisible(); await controlled(page);
  }
  gate = 'baseline-preference-and-draft';
  oldHash = await workerHash(); before = await snapshot();
  await a.getByRole('button', { name: 'Set as start page', exact: true }).click();
  await expect(a.locator('.notice')).toHaveText('This is now your start page.');
  assert.deepEqual(await preference(a), { version: 1, pageId: id });
  await a.evaluate(() => { window.__imageUpdateTrace = []; });
  eventCursor = events.length;
  await a.getByRole('button', { name: 'Edit page' }).click();
  draft = before.page.markdown + '\n\nSynthetic retained-image PWA draft.\n';
  await a.getByRole('textbox', { name: /Markdown/ }).fill(draft);
  await a.locator('#editor').evaluate(el => {
    el.focus(); el.setSelectionRange(4, 12, 'forward');
    window.__imageUpdateEditor = el;
    window.__imageUpdateOriginalDocument = document;
  });
  return { ok: true, phase: 'baseline', origin, worker_sha256: oldHash, preference: await preference(a), counts: { ...counts }, physical_device: false, production_https: false, secure_context: await a.evaluate(() => isSecureContext) };
}
async function forward(command) {
  gate = 'forward-served-worker';
  assert(a && !closed, 'baseline required'); upstream = validate(command.upstream);
  const newHash = await workerHash(); assert.notEqual(newHash, oldHash, 'served worker bytes did not change');
  gate = 'forward-install-waiting';
  await b.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration('/'); if (!r) throw new Error('registration missing'); await r.update(); });
  await b.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.waiting);
  const updateA = a.getByRole('button', { name: 'Update now', exact: true });
  const updateB = b.getByRole('button', { name: 'Update now', exact: true });
  await expect(updateA).toBeVisible(); await expect(updateA).toBeDisabled(); await expect(updateB).toBeEnabled();
  const docA = await a.evaluate(() => window.__imageUpdateDocument);
  const docB = await b.evaluate(() => window.__imageUpdateDocument);
  gate = 'forward-clean-tab-activation';
  await updateB.click();
  await b.waitForFunction(old => window.__imageUpdateDocument !== old, docB);
  await controlled(b); await expect(b.locator('article h1')).toBeVisible();
  await a.waitForFunction(() => window.__imageUpdateTrace.some(e => e.type === 'controllerchange'));
  gate = 'forward-native-draft-retention';
  const retained = await a.evaluate(() => ({ node: window.__imageUpdateEditor === document.querySelector('#editor'), document: window.__imageUpdateOriginalDocument === document, value: document.querySelector('#editor')?.value, start: document.querySelector('#editor')?.selectionStart, end: document.querySelector('#editor')?.selectionEnd, direction: document.querySelector('#editor')?.selectionDirection, id: window.__imageUpdateDocument }));
  assert.deepEqual(retained, { node: true, document: true, value: draft, start: 4, end: 12, direction: 'forward', id: docA });
  await expect(updateA).toBeDisabled();
  gate = 'forward-ui-save-and-reload';
  const writesBeforeSave = counts.writes;
  await a.getByRole('button', { name: 'Save changes' }).click();
  await expect(a.locator('#editor')).toHaveCount(0); await expect(a.locator('.notice')).toContainText('Saved locally');
  await expect(updateA).toBeEnabled(); await updateA.click();
  await a.waitForFunction(old => window.__imageUpdateDocument !== old, docA); await controlled(a);
  await expect(a.locator('article .prose')).toContainText('Synthetic retained-image PWA draft.');
  gate = 'forward-preference-home-root';
  for (const page of [a, b]) {
    assert.deepEqual(await preference(page), { version: 1, pageId: id });
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(page).toHaveURL(origin + '/?overview=1');
    await page.goto(origin + '/'); await expect(page).toHaveURL(origin + '/wiki/' + id);
    await expect(page.locator('article .prose')).toContainText('Synthetic retained-image PWA draft.');
    assert.deepEqual(await preference(page), { version: 1, pageId: id });
    assert.deepEqual(await page.evaluate(() => caches.keys()), []);
  }
  gate = 'forward-api-history-verification';
  const after = await snapshot();
  assert.equal(after.page.markdown, draft); assert.notEqual(after.page.revision, before.page.revision);
  assert.equal(after.history.history.length, before.history.history.length + 1);
  assert.deepEqual(after.history.history.slice(1), before.history.history);
  const pageIds = value => (Array.isArray(value) ? value : value.pages).map(p => p.id).sort();
  assert.deepEqual(pageIds(after.pages), pageIds(before.pages));
  const otherPages = value => (Array.isArray(value) ? value : value.pages).filter(p => p.id !== id).sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(otherPages(after.pages), otherPages(before.pages));
  assert.equal(counts.writes - writesBeforeSave, 1); assert.equal(counts.writes, 1);
  assert.equal(pageErrors.length, 0); assert.equal(counts.externalBlocked, 0); assert.equal(counts.modelRequests, 0);
  assert(events.slice(eventCursor).some(e => e.type === 'controllerchange' && e.document === docA), 'missing observed A controller change');
  assert(events.slice(eventCursor).some(e => e.type === 'controllerchange' && e.document === docB), 'missing observed B controller change');
  return { ok: true, phase: 'forward', worker_sha256_before: oldHash, worker_sha256_after: newHash, retained_native_editor: true, additional_history_entries: 1, page_count_before: pageIds(before.pages).length, page_count_after: pageIds(after.pages).length, history_count_before: before.history.history.length, history_count_after: after.history.history.length, preference: await preference(a), caches: [], pageerrors: 0, events, counts: { ...counts }, no_external_model_calls: true, physical_device: false, production_https: false, secure_context: await a.evaluate(() => isSecureContext) };
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  try {
    const command = JSON.parse(line), op = command.command;
    let result;
    if (op === 'baseline') result = await baseline(command);
    else if (op === 'forward') result = await forward(command);
    else if (op === 'close') { await cleanup(); result = { ok: true, phase: 'closed' }; }
    else throw new Error('unknown command');
    process.stdout.write(JSON.stringify(result) + '\n');
    if (closed) break;
  } catch (error) {
    console.error(String(error?.stack || error).slice(0, 6000));
    await cleanup();
    process.stdout.write(JSON.stringify({ ok: false, error: 'PWA retained-image browser verification failed', gate }) + '\n');
    process.exitCode = 1; break;
  }
}
if (!closed) await cleanup();
lines.close();
process.stdin.pause();
