import { IDBFactory,IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resetStorageEnvironment = () => {
    vi.resetModules();
    window.localStorage.clear();
    vi.stubGlobal('IDBKeyRange',IDBKeyRange);
    Object.defineProperty(window, 'indexedDB', {
        configurable: true,
        writable: true,
        value: new IDBFactory()
    });
};

const openTestDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open('unotes-persistence:tests', 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

const readRecordValues = async (field: 'savedNotes' | 'drafts') => {
    const database = await openTestDatabase();
    const transaction = database.transaction('records', 'readonly');
    const request = transaction.objectStore('records').index('field').getAll(field);
    const result = await new Promise<any[]>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    database.close();
    return result.filter(record => !record.deleted).map(record => record.value);
};

const makeNote = (id: string, title: string, html = '<p>base</p>') => ({
    id,
    title,
    description: '',
    data: { html, images: [], drawingDataUrl: null },
    type: 'endless',
    mode: 'note',
    createdAt: 1,
    lastOpened: 1,
    totalTime: 0,
    sessions: 0,
    scrollPos: 0,
    isPinned: false
});

const createStorageTab = async () => {
    vi.resetModules();
    const storage = await import('./helpers/store.js');
    const snapshot = await storage.load();
    return { storage, snapshot };
};

describe('offline storage service', () => {
    beforeEach(resetStorageEnvironment);

    it('migrates legacy note and draft arrays into IndexedDB without losing data', async () => {
        const savedNotes = [{ id: 'saved-1', title: 'Saved note' }];
        const drafts = [{ id: 'draft-1', title: 'Draft note' }];
        window.localStorage.setItem('unotes-persistence:tests:savedNotes', JSON.stringify(savedNotes));
        window.localStorage.setItem('unotes-persistence:tests:drafts', JSON.stringify(drafts));

        const { load } = await import('./helpers/store.js');
        const snapshot = await load();

        expect(snapshot.savedNotes).toEqual(savedNotes);
        expect(snapshot.drafts).toEqual(drafts);
        expect(window.localStorage.getItem('unotes-persistence:tests:savedNotes')).toBeNull();
        expect(window.localStorage.getItem('unotes-persistence:tests:drafts')).toBeNull();
        expect(window.localStorage.getItem('unotes-persistence:tests:storage_v2_savedNotes_migrated')).not.toBeNull();
        expect(window.localStorage.getItem('unotes-persistence:tests:storage_v2_drafts_migrated')).not.toBeNull();
    });

    it('flushes only the newest debounced value and reloads it consistently', async () => {
        const {
            flush,
            load,
            schedule,
            writeText
        } = await import('./helpers/store.js');
        await load();

        schedule('savedNotes', [{ id: 'old' }]);
        schedule('savedNotes', [{ id: 'latest' }]);
        schedule('folders', [{ id: 'folder-1', name: 'Ideas' }]);
        expect(writeText('tutorialLastSeen', '123')).toBe(true);
        await flush();

        const snapshot = await load();
        expect(snapshot.savedNotes).toEqual([{ id: 'latest' }]);
        expect(snapshot.folders).toEqual([{ id: 'folder-1', name: 'Ideas' }]);
        expect(snapshot.tutorialLastSeen).toBe('123');
    });

    it('falls back to localStorage when IndexedDB is unavailable', async () => {
        Object.defineProperty(window, 'indexedDB', {
            configurable: true,
            writable: true,
            value: undefined
        });
        vi.resetModules();

        const { flush, load, schedule } = await import('./helpers/store.js');
        await load();
        schedule('drafts', [{ id: 'fallback-draft' }]);
        await flush();

        expect(JSON.parse(window.localStorage.getItem('unotes-persistence:tests:drafts') || '[]')).toEqual([
            { id: 'fallback-draft' }
        ]);
        expect((await load()).drafts).toEqual([{ id: 'fallback-draft' }]);
    });

    it('distinguishes a transient localStorage read error from a missing lightweight field', async () => {
        const originalFolders = [{ id: 'folder-1', name: 'Keep me' }];
        window.localStorage.setItem('unotes-persistence:tests:folders', JSON.stringify(originalFolders));
        Object.defineProperty(window, 'indexedDB', {
            configurable: true,
            writable: true,
            value: undefined
        });
        const originalGetItem = Storage.prototype.getItem;
        let shouldFailFolderRead = true;
        const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
            this: Storage,
            key: string
        ) {
            if (key === 'unotes-persistence:tests:folders' && shouldFailFolderRead) {
                shouldFailFolderRead = false;
                throw new DOMException('Simulated localStorage read failure', 'SecurityError');
            }
            return originalGetItem.call(this, key);
        });
        vi.resetModules();

        const storage = await import('./helpers/store.js');
        const snapshot = await storage.load();
        expect(snapshot.readFailures).toContain('folders');
        expect(snapshot.folders).toEqual([]);

        const onError = vi.fn();
        storage.schedule('folders', [], onError);
        await storage.flush();
        expect(onError).toHaveBeenCalledOnce();

        getItemSpy.mockRestore();
        expect(JSON.parse(window.localStorage.getItem('unotes-persistence:tests:folders') || '[]')).toEqual(originalFolders);
    });

    it('resolves a blocked IndexedDB open and fails closed instead of hanging bootstrap', async () => {
        const blockedRequest = {} as IDBOpenDBRequest;
        Object.defineProperty(window, 'indexedDB', {
            configurable: true,
            writable: true,
            value: {
                open: vi.fn(() => {
                    queueMicrotask(() => blockedRequest.onblocked?.(new Event('blocked') as IDBVersionChangeEvent));
                    return blockedRequest;
                })
            }
        });
        vi.resetModules();

        const { load } = await import('./helpers/store.js');
        const snapshot = await load();

        expect(snapshot.readFailures).toEqual(expect.arrayContaining(['savedNotes', 'drafts']));
    });

    it('fails closed when indexedDB.open throws but keeps unsupported-IDB fallback separate', async () => {
        Object.defineProperty(window, 'indexedDB', {
            configurable: true,
            writable: true,
            value: {
                open: vi.fn(() => {
                    throw new DOMException('Simulated open failure', 'UnknownError');
                })
            }
        });
        vi.resetModules();

        const storage = await import('./helpers/store.js');
        const snapshot = await storage.load();
        expect(snapshot.readFailures).toEqual(expect.arrayContaining(['savedNotes', 'drafts']));

        const onError = vi.fn();
        storage.schedule('savedNotes', [], onError);
        await storage.flush();
        expect(onError).toHaveBeenCalledOnce();
    });

    it('blocks fallback writes after a canonical IndexedDB read failure', async () => {
        const storage = await import('./helpers/store.js');
        await storage.load();
        const originalNotes = [{ id: 'precious-note', title: 'Do not overwrite' }];
        storage.schedule('savedNotes', originalNotes);
        await storage.flush();

        const database = await openTestDatabase();
        const databasePrototype = Object.getPrototypeOf(database) as IDBDatabase;
        database.close();
        const originalTransaction = databasePrototype.transaction;
        let shouldFailRead = true;
        const transactionSpy = vi.spyOn(databasePrototype, 'transaction').mockImplementation(function (
            this: IDBDatabase,
            storeNames: string | Iterable<string>,
            mode?: IDBTransactionMode,
            options?: IDBTransactionOptions
        ) {
            if (shouldFailRead && mode === 'readonly') {
                shouldFailRead = false;
                throw new DOMException('Simulated transient read failure', 'UnknownError');
            }
            return originalTransaction.call(this, storeNames, mode, options);
        });

        const snapshot = await storage.load();
        expect(snapshot.readFailures).toContain('savedNotes');
        expect(snapshot.savedNotes).toEqual([]);

        const onError = vi.fn();
        storage.schedule('savedNotes', [], onError);
        await storage.flush();
        expect(onError).toHaveBeenCalledOnce();

        transactionSpy.mockRestore();
        expect(await readRecordValues('savedNotes')).toEqual(originalNotes);
    });

    it('preserves malformed legacy JSON verbatim before replacing its storage key', async () => {
        const malformedRaw = '[{"id":"recover-me","title":"Partial';
        window.localStorage.setItem('unotes-persistence:tests:savedNotes', malformedRaw);

        const { load } = await import('./helpers/store.js');
        const snapshot = await load();
        expect(snapshot.savedNotes).toEqual([]);
        expect(snapshot.readFailures).not.toContain('savedNotes');
        expect(window.localStorage.getItem('unotes-persistence:tests:savedNotes')).toBeNull();

        const database = await openTestDatabase();
        const transaction = database.transaction('backups', 'readonly');
        const request = transaction.objectStore('backups').getAll();
        const backups = await new Promise<any[]>((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        database.close();

        expect(backups).toContainEqual(expect.objectContaining({
            sourceKey: 'unotes-persistence:tests:savedNotes',
            value: malformedRaw
        }));
    });

    it('merges independent records written from two tabs without whole-array loss', async () => {
        const seed = await import('./helpers/store.js');
        await seed.load();
        const original = [makeNote('note-a', 'A'), makeNote('note-b', 'B')];
        seed.schedule('savedNotes', original);
        await seed.flush();

        const tabA = await createStorageTab();
        const tabB = await createStorageTab();
        tabA.storage.schedule('savedNotes', [
            { ...(tabA.snapshot.savedNotes as any[])[0], title: 'A from tab A' },
            (tabA.snapshot.savedNotes as any[])[1]
        ]);
        await tabA.storage.flush();
        tabB.storage.schedule('savedNotes', [
            (tabB.snapshot.savedNotes as any[])[0],
            { ...(tabB.snapshot.savedNotes as any[])[1], title: 'B from tab B' }
        ]);
        await tabB.storage.flush();

        const reloaded = await createStorageTab();
        expect(reloaded.snapshot.savedNotes).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'note-a', title: 'A from tab A' }),
            expect.objectContaining({ id: 'note-b', title: 'B from tab B' })
        ]));
    });

    it('merges metadata and body edits to the same note when their fields do not overlap', async () => {
        const seed = await import('./helpers/store.js');
        await seed.load();
        seed.schedule('savedNotes', [makeNote('shared', 'Original')]);
        await seed.flush();
        const tabA = await createStorageTab();
        const tabB = await createStorageTab();

        const noteA = (tabA.snapshot.savedNotes as any[])[0];
        tabA.storage.schedule('savedNotes', [{ ...noteA, title: 'Metadata edit' }]);
        await tabA.storage.flush();
        const noteB = (tabB.snapshot.savedNotes as any[])[0];
        tabB.storage.schedule('savedNotes', [{
            ...noteB,
            data: { ...noteB.data, html: '<p>Body edit</p>' }
        }]);
        await tabB.storage.flush();

        const reloaded = await createStorageTab();
        expect(reloaded.snapshot.savedNotes).toEqual([
            expect.objectContaining({
                id: 'shared',
                title: 'Metadata edit',
                data: expect.objectContaining({ html: '<p>Body edit</p>' })
            })
        ]);
    });

    it('does not create a conflict copy when two tabs concurrently open the same saved note', async () => {
        const tabA = await createStorageTab();
        const tabB = await createStorageTab();
        const shared = makeNote('shared-draft', 'Shared draft');

        tabA.storage.schedule('drafts', [{
            ...shared,
            lastOpened: 10,
            scrollPos: 12
        }]);
        await tabA.storage.flush();
        tabB.storage.schedule('drafts', [{
            ...shared,
            lastOpened: 20,
            scrollPos: 24
        }]);
        await tabB.storage.flush();

        const reloaded = await createStorageTab();
        const drafts = reloaded.snapshot.drafts as any[];
        expect(drafts).toHaveLength(1);
        expect(drafts[0]).toEqual(expect.objectContaining({
            id: 'shared-draft',
            title: 'Shared draft'
        }));
        expect(drafts.some(draft => String(draft.id).includes('-conflict-'))).toBe(false);
    });

    it('preserves simultaneous same-field edits as a named conflict copy', async () => {
        const seed = await import('./helpers/store.js');
        await seed.load();
        seed.schedule('savedNotes', [makeNote('shared', 'Original')]);
        await seed.flush();
        const tabA = await createStorageTab();
        const tabB = await createStorageTab();

        const noteA = (tabA.snapshot.savedNotes as any[])[0];
        tabA.storage.schedule('savedNotes', [{
            ...noteA,
            data: { ...noteA.data, html: '<p>Tab A</p>' }
        }]);
        await tabA.storage.flush();
        const noteB = (tabB.snapshot.savedNotes as any[])[0];
        tabB.storage.schedule('savedNotes', [{
            ...noteB,
            data: { ...noteB.data, html: '<p>Tab B</p>' }
        }]);
        await tabB.storage.flush();

        const reloaded = await createStorageTab();
        const notes = reloaded.snapshot.savedNotes as any[];
        expect(notes).toHaveLength(2);
        expect(notes.find(note => note.id === 'shared')?.data.html).toBe('<p>Tab A</p>');
        expect(notes.find(note => note.id !== 'shared')).toEqual(expect.objectContaining({
            title: 'Original (conflict copy)',
            data: expect.objectContaining({ html: '<p>Tab B</p>' })
        }));
    });

    it('keeps newer multi-page drawing data when a stale tab edits metadata', async () => {
        const seed = await import('./helpers/store.js');
        await seed.load();
        seed.schedule('savedNotes', [{
            ...makeNote('multi-page', 'Original'),
            data: {
                html: '<p>Long note</p>',
                images: [],
                drawingDataUrl: null,
                drawingPages: [{ pageIndex: 1, dataUrl: 'data:image/png;base64,AAAA' }]
            }
        }]);
        await seed.flush();
        const drawingTab = await createStorageTab();
        const metadataTab = await createStorageTab();

        const drawingNote = (drawingTab.snapshot.savedNotes as any[])[0];
        drawingTab.storage.schedule('savedNotes', [{
            ...drawingNote,
            data: {
                ...drawingNote.data,
                drawingPages: [
                    ...drawingNote.data.drawingPages,
                    { pageIndex: 2, dataUrl: 'data:image/png;base64,BBBB' }
                ]
            }
        }]);
        await drawingTab.storage.flush();

        const metadataNote = (metadataTab.snapshot.savedNotes as any[])[0];
        metadataTab.storage.schedule('savedNotes', [{
            ...metadataNote,
            title: 'Renamed elsewhere'
        }]);
        await metadataTab.storage.flush();

        const reloaded = await createStorageTab();
        expect((reloaded.snapshot.savedNotes as any[])[0]).toEqual(expect.objectContaining({
            title: 'Renamed elsewhere',
            data: expect.objectContaining({
                drawingPages: [
                    expect.objectContaining({ pageIndex: 1 }),
                    expect.objectContaining({ pageIndex: 2 })
                ]
            })
        }));
    });

    it('keeps a tombstone authoritative while preserving a stale edit under a new ID', async () => {
        const seed = await import('./helpers/store.js');
        await seed.load();
        seed.schedule('savedNotes', [makeNote('deleted', 'Delete me')]);
        await seed.flush();
        const deletingTab = await createStorageTab();
        const editingTab = await createStorageTab();

        deletingTab.storage.schedule('savedNotes', []);
        await deletingTab.storage.flush();
        const stale = (editingTab.snapshot.savedNotes as any[])[0];
        editingTab.storage.schedule('savedNotes', [{ ...stale, title: 'Stale edit' }]);
        await editingTab.storage.flush();

        const reloaded = await createStorageTab();
        const notes = reloaded.snapshot.savedNotes as any[];
        expect(notes.some(note => note.id === 'deleted')).toBe(false);
        expect(notes).toEqual([
            expect.objectContaining({ title: 'Stale edit (conflict copy)' })
        ]);
    });

    it('reopens a locally closed draft under its stable saved-note ID', async () => {
        const storage = await import('./helpers/store.js');
        await storage.load();
        const draft = makeNote('reopened-draft', 'Reopen me');

        storage.schedule('drafts', [draft]);
        await storage.flush();
        storage.schedule('drafts', []);
        await storage.flush();

        const reopeningTab = await createStorageTab();
        expect(reopeningTab.snapshot.drafts).toEqual([]);
        reopeningTab.storage.authorizeDraftResurrection(draft.id);
        reopeningTab.storage.schedule('drafts', [{
            ...draft,
            data: {
                ...draft.data,
                drawingDataUrl: 'data:image/png;base64,AAAA'
            }
        }]);
        await reopeningTab.storage.flush();

        const reloaded = await createStorageTab();
        expect(reloaded.snapshot.drafts).toEqual([
            expect.objectContaining({
                id: 'reopened-draft',
                title: 'Reopen me',
                data: expect.objectContaining({
                    drawingDataUrl: 'data:image/png;base64,AAAA'
                })
            })
        ]);
    });

    it('keeps an explicitly continued live edit under its stable draft ID across an unobserved remote close', async () => {
        const seed = await import('./helpers/store.js');
        await seed.load();
        const original = makeNote('continued-live-draft', 'Still open');
        seed.schedule('savedNotes', [original]);
        seed.schedule('drafts', [original]);
        await seed.flush();
        const closingTab = await createStorageTab();
        const editingTab = await createStorageTab();

        closingTab.storage.schedule('drafts', []);
        await closingTab.storage.flush();
        // The user is still typing in a mounted editor, before its remote
        // refresh has observed the close. A background stale callback does not
        // carry this explicit continued-open authorization.
        editingTab.storage.authorizeDraftResurrection(original.id, 'continue');
        editingTab.storage.schedule('drafts', [{
            ...original,
            data: { ...original.data, html: '<p>Continued live edit</p>' }
        }]);
        await editingTab.storage.flush();

        const reloaded = await createStorageTab();
        expect(reloaded.snapshot.drafts).toEqual([
            expect.objectContaining({
                id: original.id,
                title: original.title,
                data: expect.objectContaining({ html: '<p>Continued live edit</p>' })
            })
        ]);
    });

    it.each(['deleted', 'trashed'] as const)('does not revive an actively edited draft after its saved note is %s', async disposition => {
        const seed = await import('./helpers/store.js');
        await seed.load();
        const original = makeNote('deleted-live-note', 'Removed note');
        seed.schedule('savedNotes', [original]);
        seed.schedule('drafts', [original]);
        await seed.flush();
        const deletingTab = await createStorageTab();
        const editingTab = await createStorageTab();

        deletingTab.storage.schedule('savedNotes', disposition === 'deleted'
            ? [] : [{ ...original, trashedAt: Date.now() }]);
        deletingTab.storage.schedule('drafts', []);
        await deletingTab.storage.flush();
        editingTab.storage.authorizeDraftResurrection(original.id, 'continue');
        editingTab.storage.schedule('drafts', [{
            ...original,
            data: { ...original.data, html: '<p>Preserve this late edit separately</p>' }
        }]);
        await editingTab.storage.flush();

        const reloaded = await createStorageTab();
        const drafts = reloaded.snapshot.drafts as ReturnType<typeof makeNote>[];
        expect(drafts.some(draft => draft.id === original.id)).toBe(false);
        expect(drafts).toEqual([
            expect.objectContaining({
                title: 'Removed note (conflict copy)',
                data: expect.objectContaining({ html: '<p>Preserve this late edit separately</p>' })
            })
        ]);
        const notes = reloaded.snapshot.savedNotes as Array<ReturnType<typeof makeNote> & { trashedAt?: number }>;
        if (disposition === 'deleted') expect(notes).toEqual([]);
        else expect(notes).toEqual([expect.objectContaining({ id: original.id, trashedAt: expect.any(Number) })]);
    });

    it('keeps an observed remote draft tombstone authoritative over a stale callback', async () => {
        const seed = await import('./helpers/store.js');
        await seed.load();
        const original = makeNote('observed-remote-delete', 'Observed remote delete');
        seed.schedule('drafts', [original]);
        await seed.flush();
        const closingTab = await createStorageTab();
        const observingTab = await createStorageTab();
        const capturedStaleDraft = (observingTab.snapshot.drafts as any[])[0];

        closingTab.storage.schedule('drafts', []);
        await closingTab.storage.flush();
        const refreshed = await observingTab.storage.load();
        expect(refreshed.drafts).toEqual([]);

        observingTab.storage.schedule('drafts', [{
            ...capturedStaleDraft,
            data: { ...capturedStaleDraft.data, html: '<p>Late stale callback</p>' }
        }]);
        await observingTab.storage.flush();

        const reloaded = await createStorageTab();
        const drafts = reloaded.snapshot.drafts as any[];
        expect(drafts.some(draft => draft.id === original.id)).toBe(false);
        expect(drafts).toEqual([
            expect.objectContaining({
                title: 'Observed remote delete (conflict copy)',
                data: expect.objectContaining({ html: '<p>Late stale callback</p>' })
            })
        ]);
    });

    it('keeps a protected original fenced despite continued live-edit authorization', async () => {
        const storage = await import('./helpers/store.js');
        await storage.load();
        const original = makeNote('fenced-active-note', 'Frozen source');
        storage.schedule('savedNotes', [original]);
        storage.schedule('drafts', [original]);
        await storage.flush();
        await storage.protectNote(original);

        storage.authorizeDraftResurrection(original.id, 'continue');
        storage.schedule('drafts', [{
            ...original,
            data: { ...original.data, html: '<p>Recover this private edit</p>' }
        }]);
        await storage.flush();
        const drafts = await readRecordValues('drafts');
        expect(drafts.find(draft => draft.id === original.id)).toEqual(original);
        expect(drafts).toHaveLength(2);
        expect(drafts.find(draft => draft.id !== original.id)?.data.html)
            .toBe('<p>Recover this private edit</p>');
    });

    it('keeps a remote draft tombstone authoritative during a stale reopen', async () => {
        const seed = await import('./helpers/store.js');
        await seed.load();
        seed.schedule('drafts', [makeNote('remote-closed-draft', 'Remote close')]);
        await seed.flush();
        const closingTab = await createStorageTab();
        const staleTab = await createStorageTab();

        closingTab.storage.schedule('drafts', []);
        await closingTab.storage.flush();
        const staleDraft = (staleTab.snapshot.drafts as any[])[0];
        staleTab.storage.schedule('drafts', [{
            ...staleDraft,
            data: { ...staleDraft.data, html: '<p>Stale drawing tab</p>' }
        }]);
        await staleTab.storage.flush();

        const reloaded = await createStorageTab();
        const drafts = reloaded.snapshot.drafts as any[];
        expect(drafts.some(draft => draft.id === 'remote-closed-draft')).toBe(false);
        expect(drafts).toEqual([
            expect.objectContaining({
                title: 'Remote close (conflict copy)',
                data: expect.objectContaining({ html: '<p>Stale drawing tab</p>' })
            })
        ]);
    });

    it('merges concurrent folder additions and disjoint settings changes', async () => {
        const seed = await import('./helpers/store.js');
        await seed.load();
        seed.schedule('folders', []);
        seed.schedule('appSettings', { bgColor: '#ffffff', boxOpacity: 0.8 });
        await seed.flush();
        const tabA = await createStorageTab();
        const tabB = await createStorageTab();

        tabA.storage.schedule('folders', [{ id: 'folder-a', name: 'A' }]);
        tabA.storage.schedule('appSettings', {
            ...(tabA.snapshot.appSettings as Record<string, unknown>),
            bgColor: '#111111'
        });
        await tabA.storage.flush();
        tabB.storage.schedule('folders', [{ id: 'folder-b', name: 'B' }]);
        tabB.storage.schedule('appSettings', {
            ...(tabB.snapshot.appSettings as Record<string, unknown>),
            boxOpacity: 0.4
        });
        await tabB.storage.flush();

        const reloaded = await createStorageTab();
        expect(reloaded.snapshot.folders).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'folder-a' }),
            expect.objectContaining({ id: 'folder-b' })
        ]));
        expect(reloaded.snapshot.appSettings).toEqual(expect.objectContaining({
            bgColor: '#111111',
            boxOpacity: 0.4
        }));
    });

    it('drops an identical stale echo write instead of clobbering a merged concurrent title', async () => {
        window.localStorage.setItem('unotes-persistence:tests:savedNotes', JSON.stringify([makeNote('note-a', 'Alpha')]));
        vi.resetModules();
        const editorTab = await import('./helpers/store.js');
        await editorTab.load();

        // Another tab renames the note directly in IndexedDB while the editor
        // tab still holds the older snapshot in memory.
        const remoteDatabase = await openTestDatabase();
        const remoteRecords = await new Promise<any[]>((resolve, reject) => {
            const request = remoteDatabase.transaction('records', 'readonly')
                .objectStore('records')
                .index('field')
                .getAll('savedNotes');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const remoteRecord = remoteRecords.find(record => record.entityId === 'note-a');
        remoteDatabase.transaction('records', 'readwrite')
            .objectStore('records')
            .put({
                ...remoteRecord,
                revision: remoteRecord.revision + 1,
                updatedAt: Date.now() + 5,
                value: { ...remoteRecord.value, title: 'Renamed in tab B' }
            });
        remoteDatabase.close();

        // The closing editor persists its long body from the stale snapshot,
        // then the debounced snapshot effect replays the identical value.
        const staleLocalValue = [makeNote(
            'note-a',
            'Alpha',
            `<div>${'pagination content '.repeat(40)}</div>`
        )];
        editorTab.schedule('savedNotes', staleLocalValue);
        await editorTab.flush();
        editorTab.schedule('savedNotes', staleLocalValue);
        await editorTab.flush();

        const persisted = await readRecordValues('savedNotes');
        expect(persisted).toHaveLength(1);
        expect(persisted[0].title).toBe('Renamed in tab B');
        expect(persisted[0].data.html).toContain('pagination content');
    });

    it('allows an identical rewrite again once a fresh load invalidates the echo guard', async () => {
        const storage = await import('./helpers/store.js');
        await storage.load();
        const value = [makeNote('note-a', 'Alpha')];
        storage.schedule('savedNotes', value);
        await storage.flush();

        await storage.load();
        storage.schedule('savedNotes', value);
        await storage.flush();

        const persisted = await readRecordValues('savedNotes');
        expect(persisted).toHaveLength(1);
        expect(persisted[0].title).toBe('Alpha');
    });

    it('preserves remote content when a staged refresh is rejected before a local write', async () => {
        const seed = await import('./helpers/store.js');
        await seed.load();
        const original = makeNote('refresh-race', 'Original');
        seed.schedule('savedNotes', [original]);
        await seed.flush();
        const remoteTab = await createStorageTab();
        const editingTab = await createStorageTab();
        const remote = { ...original, data: { ...original.data, html: '<p>Remote content</p>' } };
        remoteTab.storage.schedule('savedNotes', [remote]);
        await remoteTab.storage.flush();

        // The UI discards this read because the user typed while it was pending.
        // Reading must not silently advance the editor's merge ancestor.
        const refreshed = await editingTab.storage.stage();
        expect(refreshed.snapshot.savedNotes).toEqual([remote]);
        const local = { ...original, data: { ...original.data, html: '<p>Local content</p>' } };
        editingTab.storage.schedule('savedNotes', [local]);
        await editingTab.storage.flush();

        const values = await readRecordValues('savedNotes');
        expect(values).toHaveLength(2);
        expect(values.find(note => note.id === original.id)).toEqual(remote);
        expect(values.find(note => note.id !== original.id)).toEqual(expect.objectContaining({
            title: 'Original (conflict copy)',
            data: expect.objectContaining({ html: '<p>Local content</p>' })
        }));
    });

    it('adopts staged revisions only once and invalidates competing staged reads', async () => {
        const storage = await import('./helpers/store.js');
        await storage.load();
        const first = await storage.stage();
        const competing = await storage.stage();
        expect(first.accept()).toBe(true);
        expect(first.accept()).toBe(false);
        expect(competing.accept()).toBe(false);
        expect((await storage.stage()).accept()).toBe(true);
    });

    it('keeps staged ancestry detached from mutable UI snapshot objects', async () => {
        const storage = await import('./helpers/store.js');
        await storage.load();
        const original = makeNote('detached-refresh', 'Original');
        storage.schedule('savedNotes', [original]);
        await storage.flush();
        const staged = await storage.stage();
        const uiNotes = staged.snapshot.savedNotes as ReturnType<typeof makeNote>[];
        uiNotes[0].data.html = '<p>Unsaved local input</p>';
        expect(staged.accept()).toBe(true);
        storage.schedule('savedNotes', uiNotes);
        await storage.flush();
        expect((await readRecordValues('savedNotes'))[0].data.html).toBe('<p>Unsaved local input</p>');
    });

    it('rejects a stage started with pending or in-flight writes even if they finish during the read', async () => {
        const storage = await import('./helpers/store.js');
        await storage.load();
        storage.schedule('activeDraftId', 'pending-draft');
        const pending = await storage.stage();
        expect(pending.accept()).toBe(false);
        const flushing = storage.flush();
        const inFlight = storage.stage();
        await flushing;
        expect((await inFlight).accept()).toBe(false);
        expect((await storage.stage()).accept()).toBe(true);
    });

    it('invalidates a staged read after a new local schedule without invalidating duplicate echoes', async () => {
        const storage = await import('./helpers/store.js');
        await storage.load();
        const value = [makeNote('echo-refresh', 'Original')];
        storage.schedule('savedNotes', value);
        await storage.flush();
        const beforeEcho = await storage.stage();
        storage.schedule('savedNotes', value);
        expect(beforeEcho.accept()).toBe(true);
        const beforeEdit = await storage.stage();
        storage.schedule('savedNotes', [{ ...value[0], title: 'Local edit' }]);
        expect(beforeEdit.accept()).toBe(false);
        await storage.flush();
    });

    it('invalidates staged reads when bootstrap or an in-place remote apply changes ancestry', async () => {
        const storage = await import('./helpers/store.js');
        await storage.load();
        const original = makeNote('remote-refresh', 'Original');
        storage.schedule('savedNotes', [original]);
        await storage.flush();
        const beforeBootstrap = await storage.stage();
        await storage.load();
        expect(beforeBootstrap.accept()).toBe(false);
        const beforeRemote = await storage.stage();
        await storage.applyReplicaChanges('savedNotes', [{
            entityId: original.id,
            remoteValue: { ...original, title: 'Remote edit' },
            remoteDeleted: false,
            baseValue: original,
            baseDeleted: false
        }]);
        expect(beforeRemote.accept()).toBe(false);
        const refreshed = await storage.stage();
        expect(refreshed.snapshot.savedNotes).toEqual([{ ...original, title: 'Remote edit' }]);
        expect(refreshed.accept()).toBe(true);
    });

    it('invalidates a staged refresh when a protected original fence commits', async () => {
        const storage = await import('./helpers/store.js');
        await storage.load();
        const original = makeNote('fenced-refresh', 'Frozen source');
        storage.schedule('savedNotes', [original]);
        await storage.flush();
        const staged = await storage.stage();
        await storage.protectNote(original);
        expect(staged.accept()).toBe(false);
        const refreshed = await storage.stage();
        expect(refreshed.accept()).toBe(true);
        expect(await storage.isNoteProtected(original.id)).toBe(true);
    });

    it('reports a failed record flush until the local value is successfully retried', async () => {
        const storage = await import('./helpers/store.js');
        await storage.load();
        const original = makeNote('failed-refresh-write', 'Original');
        storage.schedule('savedNotes', [original]);
        expect(await storage.flush()).toBe(true);
        const database = await openTestDatabase();
        const databasePrototype = Object.getPrototypeOf(database) as IDBDatabase;
        database.close();
        const originalTransaction = databasePrototype.transaction;
        const transactionSpy = vi.spyOn(databasePrototype, 'transaction').mockImplementation(function (
            this: IDBDatabase,
            storeNames: string | Iterable<string>,
            mode?: IDBTransactionMode,
            options?: IDBTransactionOptions
        ) {
            if (mode === 'readwrite' && Array.from(storeNames).includes('records')) {
                throw new DOMException('Simulated record quota failure', 'QuotaExceededError');
            }
            return originalTransaction.call(this, storeNames, mode, options);
        });
        const local = { ...original, data: { ...original.data, html: '<p>Unsaved local input</p>' } };
        const onError = vi.fn();
        storage.schedule('savedNotes', [local], onError);
        expect(await storage.flush()).toBe(false);
        expect(onError).toHaveBeenCalledOnce();
        expect(await storage.flush()).toBe(false);
        expect(await readRecordValues('savedNotes')).toEqual([original]);

        transactionSpy.mockRestore();
        storage.schedule('savedNotes', [local], onError);
        expect(await storage.flush()).toBe(true);
        expect(await readRecordValues('savedNotes')).toEqual([local]);
    });
});
