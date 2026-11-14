import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, expect, it, vi } from 'vitest';
import type { NotebookStore } from '../src/index.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// npm test builds first; this is the emitted ESM, not the TypeScript source.
const builtUrl = pathToFileURL(path.resolve('dist/index.js')).href;
const built = await import(/* @vite-ignore */ builtUrl);

beforeEach(() => {
    window.localStorage.clear(); window.sessionStorage.clear();
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: new IDBFactory() });
});

it('uses emitted exports to save, close and reopen a notebook independently', async () => {
    const store: NotebookStore = built.createNotebookStore({ namespace: 'built-consumer' });
    await store.load();
    store.schedule('savedNotes', [{ id: 'a', title: 'Synthetic package note' }]);
    expect(await store.flush()).toBe(true);
    await store.close();
    const reopened: NotebookStore = built.createNotebookStore({ namespace: 'built-consumer' });
    expect((await reopened.load()).savedNotes).toEqual([{ id: 'a', title: 'Synthetic package note' }]);
    await reopened.close();
});

it('preserves ordering exports in the emitted module', () => {
    expect(built.orderKeyForId('000000000001:a', 'b')).toBe('000000000001:b');
    expect(built.validOrderKey('not-a-rank')).toBe(false);
});
