import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Optional external test driver, not a library/runtime dependency. No browser downloads.
assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed playwright-core ESM entry point.');
const driver = await import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href);
const root = path.resolve('dist');
const server = http.createServer(async (req, res) => {
    try {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Synthetic storage acceptance</title>'); return; }
        if (!/^\/[a-zA-Z]+\.js$/.test(pathname)) { res.writeHead(404).end(); return; }
        res.setHeader('Content-Type', 'text/javascript');
        res.end(await fs.readFile(path.join(root, pathname.slice(1))));
    } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const results = [];
const engines = (process.env.BROWSER_ENGINES ?? 'chromium,webkit').split(',');
try {
    for (const engine of engines) {
        const options = { headless: true };
        if (engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE) options.executablePath = process.env.CHROMIUM_EXECUTABLE;
        if (engine === 'chromium') options.args = ['--no-sandbox'];
        const browser = await driver[engine].launch(options);
        try {
            async function run(name, body) {
                const context = await browser.newContext();
                await context.route('**/*', route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
                const page = await context.newPage();
                await page.goto(origin);
                try { await body(page, context); results.push({ engine, version: browser.version(), name, status: 'passed' }); }
                catch (error) { results.push({ engine, name, status: 'failed', error: error.message }); throw error; }
                finally { await context.close(); }
            }
            await run('namespace separation and persistence across reload', async page => {
                assert.deepEqual(await page.evaluate(async () => {
                    const { createNotebookStore } = await import('/index.js');
                    const a = createNotebookStore({ namespace: 'alpha' }), b = createNotebookStore({ namespace: 'beta' });
                    await a.load(); await b.load();
                    a.schedule('savedNotes', [{ id: 'a', title: 'Synthetic alpha' }]);
                    b.schedule('savedNotes', [{ id: 'b', title: 'Synthetic beta' }]);
                    const flushed = [await a.flush(), await b.flush()]; await a.close(); await b.close(); return flushed;
                }), [true, true]);
                await page.reload();
                assert.deepEqual(await page.evaluate(async () => {
                    const { createNotebookStore } = await import('/index.js');
                    const a = createNotebookStore({ namespace: 'alpha' }), b = createNotebookStore({ namespace: 'beta' });
                    const values = [(await a.load()).savedNotes, (await b.load()).savedNotes]; await a.close(); await b.close(); return values;
                }), [[{ id: 'a', title: 'Synthetic alpha' }], [{ id: 'b', title: 'Synthetic beta' }]]);
            });
            await run('namespaced migration and malformed-input recovery', async page => {
                const result = await page.evaluate(async () => {
                    const { createNotebookStore } = await import('/index.js');
                    const good = createNotebookStore({ namespace: 'migration' });
                    localStorage.setItem(good.keys.savedNotes, JSON.stringify([{ id: 'm', title: 'Synthetic migrated' }]));
                    const migrated = (await good.load()).savedNotes;
                    const removed = localStorage.getItem(good.keys.savedNotes) === null;
                    const bad = createNotebookStore({ namespace: 'malformed' });
                    localStorage.setItem(bad.keys.savedNotes, '{synthetic broken JSON');
                    const empty = (await bad.load()).savedNotes;
                    const backups = await bad.readBackups();
                    await good.close(); await bad.close();
                    return { migrated, removed, empty, preserved: backups.some(b => JSON.stringify(b).includes('{synthetic broken JSON')) };
                });
                assert.deepEqual(result, { migrated: [{ id: 'm', title: 'Synthetic migrated' }], removed: true, empty: [], preserved: true });
            });
            await run('manual backup survives reload and permits explicit recovery', async page => {
                assert.equal(await page.evaluate(async () => {
                    const { createNotebookStore } = await import('/index.js'); const s = createNotebookStore({ namespace: 'recovery' }); await s.load();
                    const ok = await s.preserveBackup('manual', [{ id: 'recover', title: 'Synthetic recovery' }]); await s.close(); return ok;
                }), true);
                await page.reload();
                assert.deepEqual(await page.evaluate(async () => {
                    const { createNotebookStore } = await import('/index.js'); const s = createNotebookStore({ namespace: 'recovery' }); await s.load();
                    const backup = (await s.readBackups()).find(b => b.sourceKey === 'manual');
                    if (!backup) throw new Error('Manual backup missing');
                    s.schedule('savedNotes', backup.value); if (!await s.flush()) throw new Error('Recovery write failed');
                    const notes = (await s.load()).savedNotes; await s.close(); return notes;
                }), [{ id: 'recover', title: 'Synthetic recovery' }]);
            });
            for (const deletion of [false, true]) await run(deletion ? 'cross-page deletion tombstone preserves stale conflict copy' : 'cross-page conflicting revisions preserve both values', async (page, context) => {
                await page.evaluate(async () => {
                    const { createNotebookStore } = await import('/index.js'); window.s = createNotebookStore({ namespace: 'concurrent' }); await s.load();
                    s.schedule('savedNotes', [{ id: 'note', title: 'Synthetic base' }]); if (!await s.flush()) throw new Error('Seed failed');
                });
                const peer = await context.newPage(); await peer.goto(origin);
                await peer.evaluate(async () => { const { createNotebookStore } = await import('/index.js'); window.s = createNotebookStore({ namespace: 'concurrent' }); window.base = (await s.load()).savedNotes; });
                assert.equal(await page.evaluate(async deletion => { s.schedule('savedNotes', deletion ? [] : [{ id: 'note', title: 'Synthetic first edit' }]); return s.flush(); }, deletion), true);
                assert.equal(await peer.evaluate(async () => { s.schedule('savedNotes', [{ ...base[0], title: 'Synthetic stale edit' }]); return s.flush(); }), true);
                const notes = await peer.evaluate(async () => { const snapshot = await s.load(); await s.close(); return snapshot.savedNotes; });
                assert.ok(notes.some(n => n.id !== 'note' && n.title === 'Synthetic stale edit (conflict copy)'));
                assert.equal(notes.some(n => n.id === 'note'), !deletion);
                if (!deletion) assert.ok(notes.some(n => n.title === 'Synthetic first edit'));
                await page.evaluate(() => s.close());
            });
            await run('IndexedDB write failure retains committed value and recovery', async page => {
                const result = await page.evaluate(async () => {
                    const { createNotebookStore } = await import('/index.js'); const s = createNotebookStore({ namespace: 'write-failure' }); await s.load();
                    s.schedule('savedNotes', [{ id: 'q', title: 'Synthetic committed' }]); if (!await s.flush()) throw new Error('Seed failed');
                    const original = IDBObjectStore.prototype.put; let failures = 0;
                    IDBObjectStore.prototype.put = function () { throw new DOMException('Synthetic quota fault', 'QuotaExceededError'); };
                    let ok; try { s.schedule('savedNotes', [{ id: 'q', title: 'Synthetic pending' }], () => { failures += 1; }); ok = await s.flush(); }
                    finally { IDBObjectStore.prototype.put = original; }
                    const probe = createNotebookStore({ namespace: 'write-failure' }); const persisted = (await probe.load()).savedNotes; await probe.close();
                    // Explicit retry after the fault is removed; never report the failed flush as saved.
                    s.schedule('savedNotes', [{ id: 'q', title: 'Synthetic pending' }]); const retry = await s.flush(); await s.close(); return { ok, failures, persisted, retry };
                });
                assert.equal(result.ok, false); assert.ok(result.failures > 0); assert.deepEqual(result.persisted, [{ id: 'q', title: 'Synthetic committed' }]); assert.equal(result.retry, true);
            });
            await run('fallback quota failure is observable and does not overwrite data', async page => {
                const result = await page.evaluate(async () => {
                    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
                    const { createNotebookStore } = await import('/index.js'); const s = createNotebookStore({ namespace: 'fallback' }); await s.load();
                    s.schedule('savedNotes', [{ id: 'q', title: 'Synthetic retained' }]); if (!await s.flush()) throw new Error('Seed failed');
                    const original = Storage.prototype.setItem; let failures = 0;
                    Storage.prototype.setItem = function () { throw new DOMException('Synthetic quota fault', 'QuotaExceededError'); };
                    let ok; try { s.schedule('savedNotes', [{ id: 'q', title: 'Synthetic pending' }], () => { failures += 1; }); ok = await s.flush(); }
                    finally { Storage.prototype.setItem = original; }
                    const persisted = JSON.parse(localStorage.getItem(s.keys.savedNotes)); s.schedule('savedNotes', [{ id: 'q', title: 'Synthetic pending' }]); const retry = await s.flush(); await s.close(); return { ok, failures, persisted, retry };
                });
                assert.equal(result.ok, false); assert.ok(result.failures > 0); assert.deepEqual(result.persisted, [{ id: 'q', title: 'Synthetic retained' }]); assert.equal(result.retry, true);
            });
        } finally { await browser.close(); }
    }
} finally {
    await new Promise(resolve => server.close(resolve));
    console.log(JSON.stringify({ scope: 'Fresh contexts, synthetic data, loopback-only pages. Quota faults injected; real disk exhaustion/eviction and physical devices not tested.', results }, null, 2));
}
