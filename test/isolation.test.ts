import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotebookStore } from '../src/index.js';
import { makeNote } from './helpers/makeNote.js';

beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: new IDBFactory() });
});

describe('standalone namespace and lifecycle boundary', () => {
    it('requires a namespace and never adopts or changes the live application keys/database', async () => {
        for (const namespace of ['', '../unotes-storage', 'Mixed Case', 'x:other', 'a'.repeat(65)]) {
            expect(() => createNotebookStore({ namespace })).toThrow(TypeError);
        }
        const original = JSON.stringify([makeNote('private', 'Private application note')]);
        window.localStorage.setItem('mnp_savedNotes', original);
        window.localStorage.setItem('tutorialLastSeen', 'original');
        const open = vi.spyOn(window.indexedDB, 'open');
        const store = createNotebookStore({ namespace: 'example' });
        expect((await store.load()).savedNotes).toEqual([]);
        store.schedule('savedNotes', [makeNote('public-demo', 'Synthetic demo')]);
        expect(await store.flush()).toBe(true);
        expect(window.localStorage.getItem('mnp_savedNotes')).toBe(original);
        expect(window.localStorage.getItem('tutorialLastSeen')).toBe('original');
        expect(open.mock.calls.every(([name]) => name === 'unotes-persistence:example')).toBe(true);
        await store.close();
    });

    it('isolates namespaces while instances of the same namespace preserve concurrent edits', async () => {
        const a = createNotebookStore({ namespace: 'one' });
        const b = createNotebookStore({ namespace: 'two' });
        await Promise.all([a.load(), b.load()]);
        a.schedule('savedNotes', [makeNote('a', 'A')]);
        b.schedule('savedNotes', [makeNote('b', 'B')]);
        expect(await a.flush()).toBe(true);
        expect(await b.flush()).toBe(true);
        expect((await a.load()).savedNotes).toEqual([makeNote('a', 'A')]);
        const peer = createNotebookStore({ namespace: 'one' });
        await peer.load();
        a.schedule('savedNotes', [makeNote('a', 'New title')]);
        expect(await a.flush()).toBe(true);
        peer.schedule('savedNotes', [makeNote('a', 'A', '<p>new body</p>')]);
        expect(await peer.flush()).toBe(true);
        expect((await peer.load()).savedNotes).toEqual([makeNote('a', 'New title', '<p>new body</p>')]);
        expect((await b.load()).savedNotes).toEqual([makeNote('b', 'B')]);
        await Promise.all([a.close(), b.close(), peer.close()]);
    });

    it('isolates fallback localStorage keys too', async () => {
        Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
        const a = createNotebookStore({ namespace: 'one' });
        const b = createNotebookStore({ namespace: 'two' });
        await Promise.all([a.load(), b.load()]);
        a.schedule('savedNotes', [makeNote('a', 'A')]);
        expect(await a.flush()).toBe(true);
        expect((await b.load()).savedNotes).toEqual([]);
        expect(JSON.parse(window.localStorage.getItem(a.keys.savedNotes)!)).toEqual([makeNote('a', 'A')]);
        await Promise.all([a.close(), b.close()]);
    });

    it('snapshots scheduled input, flushes on close and prevents later use', async () => {
        const store = createNotebookStore({ namespace: 'closing' });
        await store.load();
        const value = [makeNote('a', 'Before')];
        store.schedule('savedNotes', value);
        value[0].title = 'Unscheduled mutation';
        await store.close();
        expect(() => store.load()).toThrow(/closed/);
        expect(() => store.schedule('savedNotes', [])).toThrow(/closed/);
        await store.close();
        const reopened = createNotebookStore({ namespace: 'closing' });
        expect((await reopened.load()).savedNotes).toEqual([makeNote('a', 'Before')]);
        await reopened.close();
    });

    it('rejects invalid fields, duplicate identities and unsupported array shape before writing', async () => {
        const store = createNotebookStore({ namespace: 'validation' });
        await store.load();
        // Deliberately cross the JS boundary; TypeScript is not runtime validation.
        expect(() => store.schedule('__proto__' as never, 'x')).toThrow(TypeError);
        expect(() => store.schedule(['savedNotes'] as never, 'x')).toThrow(TypeError);
        expect(() => store.preserveBackup('missing', undefined)).toThrow(TypeError);
        expect(() => store.schedule('savedNotes', [{ id: 'a' }, { id: 'a' }])).toThrow(TypeError);
        expect(() => store.schedule('savedNotes', [{ title: 'Missing id' }])).toThrow(TypeError);
        expect(() => store.schedule('folders', {})).toThrow(TypeError);
        expect(window.localStorage.getItem('undefined')).toBeNull();
        await store.close();
    });

    it('preserves an own __proto__ data field during a three-way merge without prototype mutation', async () => {
        const original = JSON.parse('{"id":"a","title":"Before","__proto__":{"polluted":"data"}}');
        const a = createNotebookStore({ namespace: 'prototype' });
        await a.load();
        a.schedule('savedNotes', [original]);
        expect(await a.flush()).toBe(true);
        const b = createNotebookStore({ namespace: 'prototype' });
        await b.load();
        a.schedule('savedNotes', [{ ...original, title: 'After' }]);
        expect(await a.flush()).toBe(true);
        b.schedule('savedNotes', [{ ...original, description: 'Other field' }]);
        expect(await b.flush()).toBe(true);
        const notes = (await b.load()).savedNotes as Array<Record<string, unknown>>;
        expect(Object.hasOwn(notes[0], '__proto__')).toBe(true);
        expect(notes[0].__proto__).toEqual({ polluted: 'data' });
        expect(notes[0].title).toBe('After');
        expect(notes[0].description).toBe('Other field');
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        await Promise.all([a.close(), b.close()]);
    });
});


describe('public input, privacy and failure behavior', () => {
    it('makes migrated and explicitly preserved recovery copies readable without automatic restoration', async () => {
        const store = createNotebookStore({ namespace: 'recovery' });
        const original = [makeNote('a', 'Legacy source')];
        window.localStorage.setItem(store.keys.savedNotes, JSON.stringify(original));
        expect((await store.load()).savedNotes).toEqual(original);
        expect(await store.preserveBackup('manual-copy', { text: 'first copy' })).toBe(true);
        expect(await store.preserveBackup('manual-copy', { text: 'second copy' })).toBe(true);
        const backups = await store.readBackups();
        expect(backups.find(copy => copy.key === 'legacy-v2:savedNotes')?.value).toEqual(original);
        expect(backups.find(copy => copy.sourceKey === 'manual-copy')?.value).toEqual({ text: 'first copy' });
        backups[0].value = null;
        expect((await store.readBackups()).every(copy => copy.value !== null)).toBe(true);
        await store.close();
    });

    it('reads fallback backups and rejects malformed recovery data instead of claiming an empty success', async () => {
        Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
        const store = createNotebookStore({ namespace: 'fallback-recovery' });
        expect(await store.preserveBackup('manual', { text: 'keep' })).toBe(true);
        expect((await store.readBackups())[0].value).toEqual({ text: 'keep' });
        window.localStorage.setItem(`${store.databaseName}:securityBackup_v1_bad`, 'not-json');
        await expect(store.readBackups()).rejects.toThrow(/malformed/);
        await store.close();
    });

    it('requires initialization before replacing a record array', async () => {
        const store = createNotebookStore({ namespace: 'initialization' });
        expect(() => store.schedule('savedNotes', [])).toThrow(/Load the store/);
        await store.load();
        store.schedule('savedNotes', [makeNote('a', 'Loaded')]);
        expect(await store.flush()).toBe(true);
        await store.close();
    });

    it('rejects cyclic, binary, nonfinite and sparse data before persistence', async () => {
        const store = createNotebookStore({ namespace: 'json-values' });
        await store.load();
        const cycle: Record<string, unknown> = { id: 'a' }; cycle.self = cycle;
        for (const value of [cycle, { id: 'a', binary: new Uint8Array([1]) }, { id: 'a', date: new Date() }, { id: 'a', value: NaN }, { id: 'a', values: new Array(2) }]) {
            expect(() => store.schedule('savedNotes', [value])).toThrow(TypeError);
        }
        expect((await store.load()).savedNotes).toEqual([]);
        await store.close();
    });

    it('rejects duplicate or mismatched replica identities without any partial commit', async () => {
        const store = createNotebookStore({ namespace: 'replica-validation' });
        await store.load();
        const change = { entityId: 'a', remoteValue: makeNote('a', 'A'), remoteDeleted: false };
        expect(() => store.applyReplicaChanges('savedNotes', [change, change])).toThrow(TypeError);
        expect(() => store.applyReplicaChanges('savedNotes', [{ ...change, remoteValue: makeNote('wrong', 'Wrong') }])).toThrow(TypeError);
        expect((await store.load()).savedNotes).toEqual([]);
        await store.close();
    });

    it('does not log malformed stored content', async () => {
        const warn = vi.spyOn(console, 'warn'), error = vi.spyOn(console, 'error');
        const store = createNotebookStore({ namespace: 'privacy' });
        window.localStorage.setItem(store.keys.savedNotes, '{synthetic-private-content');
        await store.load();
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        await store.close();
    });

    it('does not turn an observer exception into a failed durable write', async () => {
        const store = createNotebookStore({ namespace: 'observer' });
        await store.load();
        const observe = vi.fn();
        store.subscribe(() => { throw new Error('Synthetic observer failure'); });
        store.subscribe(observe);
        store.schedule('savedNotes', [makeNote('a', 'A')]);
        expect(await store.flush()).toBe(true);
        expect(observe).toHaveBeenCalledOnce();
        expect((await store.load()).savedNotes).toEqual([makeNote('a', 'A')]);
        await store.close();
    });

    it('waits for a started load before closing and rejects detached staged acceptance afterward', async () => {
        const store = createNotebookStore({ namespace: 'in-flight' });
        const loading = store.load();
        const closing = store.close();
        expect((await loading).readFailures).toEqual([]);
        await closing;
        const peer = createNotebookStore({ namespace: 'in-flight' });
        await peer.load();
        const staged = await peer.stage();
        await peer.close();
        expect(staged.accept).toThrow(/closed/);
    });

    it('returns false when a backup cannot be kept in either store', async () => {
        Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
        const store = createNotebookStore({ namespace: 'backup-failure' });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Synthetic quota error', 'QuotaExceededError'); });
        expect(await store.preserveBackup('synthetic', { text: 'recover me' })).toBe(false);
        await store.close();
    });

    it('scopes storage-event invalidations and removes listeners when closed', async () => {
        const a = createNotebookStore({ namespace: 'events-a' });
        const b = createNotebookStore({ namespace: 'events-b' });
        await Promise.all([a.load(), b.load()]);
        const observeA = vi.fn(), observeB = vi.fn();
        a.subscribe(observeA); b.subscribe(observeB);
        const event = () => new StorageEvent('storage', { key: `${a.databaseName}:storage_sync_signal`, newValue: JSON.stringify({ source: 'another-tab', fields: ['savedNotes'], conflicts: [], messageId: crypto.randomUUID() }) });
        window.dispatchEvent(event());
        expect(observeA).toHaveBeenCalledOnce(); expect(observeB).not.toHaveBeenCalled();
        await a.close(); window.dispatchEvent(event());
        expect(observeA).toHaveBeenCalledOnce();
        await b.close();
    });
});
