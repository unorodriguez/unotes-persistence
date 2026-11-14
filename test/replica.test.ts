import { IDBFactory,IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeNote } from './helpers/makeNote.js';

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

const createStorageTab = async () => {
    vi.resetModules();
    const storage = await import('./helpers/store.js');
    await storage.load();
    return storage;
};

const seedLocalNotes = async (storage: any, notes: any[]) => {
    storage.schedule('savedNotes', notes);
    await storage.flush();
};

const readRawRecords = async (field: 'savedNotes' | 'folders' = 'savedNotes'): Promise<any[]> => {
    const request = window.indexedDB.open('unotes-persistence:tests', 2);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction('records', 'readonly');
    const storeRequest = transaction.objectStore('records').index('field').getAll(field);
    const records = await new Promise<any[]>((resolve, reject) => {
        storeRequest.onsuccess = () => resolve(storeRequest.result);
        storeRequest.onerror = () => reject(storeRequest.error);
    });
    database.close();
    return records;
};

/** Phase 2 §17/§18: remote changes apply through the SAME merge/conflict/tombstone
 * machinery as local writes. Every scenario preserves BOTH divergent sides. */
describe('applyReplicaChanges (caller-supplied data → local)', () => {
    beforeEach(resetStorageEnvironment);

    it('fast-forwards a clean remote change when local matches base', async () => {
        const storage = await createStorageTab();
        await seedLocalNotes(storage, [makeNote('n1', 'Base title')]);

        const result = await storage.applyReplicaChanges('savedNotes', [
            {
                entityId: 'n1',
                remoteValue: makeNote('n1', 'Remote title'),
                remoteDeleted: false,
                baseValue: makeNote('n1', 'Base title'),
                baseDeleted: false,
            },
        ]);
        expect(result.applied).toEqual(['n1']);
        expect(result.conflicts).toEqual([]);

        const records = await readRawRecords();
        const live = records.filter(record => !record.deleted).map(record => record.value);
        expect(live).toHaveLength(1);
        expect(live[0].title).toBe('Remote title');
    });

    it('merges disjoint field edits without conflict copies (A: title, B: body)', async () => {
        const storage = await createStorageTab();
        await seedLocalNotes(storage, [{ ...makeNote('n2', 'Local title'), totalTime: 10 }]);

        const base = makeNote('n2', 'Base title');
        const result = await storage.applyReplicaChanges('savedNotes', [
            {
                entityId: 'n2',
                remoteValue: makeNote('n2', 'Base title', '<p>remote body</p>'),
                remoteDeleted: false,
                baseValue: base,
                baseDeleted: false,
            },
        ]);

        // Local edited the title; remote edited only the body → both survive.
        const records = await readRawRecords();
        const live = records.filter(record => !record.deleted).map(record => record.value);
        expect(result.conflicts).toEqual([]);
        expect(live).toHaveLength(1);
        expect(live[0].title).toBe('Local title');
        expect(live[0].data.html).toBe('<p>remote body</p>');
    });

    it('converges competing note moves and ranks without copying unchanged content', async () => {
        const storage = await createStorageTab();
        const base = { ...makeNote('move-note', 'Keep content'), folderId: 'base-folder', orderKey: '000000000001:move-note' };
        const local = { ...base, folderId: 'local-folder', orderKey: '000000000002:move-note' };
        const remote = { ...base, folderId: 'remote-folder', orderKey: '000000000003:move-note' };
        await seedLocalNotes(storage, [local]);

        const result = await storage.applyReplicaChanges('savedNotes', [{
            entityId: base.id, remoteValue: remote, remoteDeleted: false, baseValue: base, baseDeleted: false
        }]);

        expect(result.conflicts).toEqual([]);
        expect((await readRawRecords()).filter(record => !record.deleted).map(record => record.value)).toEqual([remote]);
        const reloaded = await createStorageTab();
        expect((await reloaded.load()).savedNotes).toEqual([remote]);
        const replay = await reloaded.applyReplicaChanges('savedNotes', [{
            entityId: base.id, remoteValue: remote, remoteDeleted: false, baseValue: base, baseDeleted: false
        }]);
        expect(replay).toEqual({ applied: [], conflicts: [], skipped: [base.id] });
    });

    it('adopts committed organization without a content copy when the ancestor is unavailable', async () => {
        const storage = await createStorageTab();
        const { canonicalSerialize, withExtraFields } = await import('./helpers/replicaFixture.js');
        const note = { ...makeNote('first-sync-order', 'Same body'), orderKey: '000000000001:first-sync-order' };
        await seedLocalNotes(storage, [note]);
        const remote = withExtraFields(JSON.parse(canonicalSerialize({ ...note, folderId: 'work', orderKey: '000000000002:first-sync-order' })));

        const result = await storage.applyReplicaChanges('savedNotes', [{
            entityId: note.id, remoteValue: remote as unknown as Record<string, unknown>, remoteDeleted: false
        }]);

        expect(result.conflicts).toEqual([]);
        expect((await readRawRecords()).filter(record => !record.deleted).map(record => record.value)).toEqual([remote]);
    });

    it('still preserves both contents when organization and body diverge without an ancestor', async () => {
        const storage = await createStorageTab();
        const local = { ...makeNote('first-sync-content', 'Local', '<p>local body</p>'), orderKey: '000000000001:first-sync-content' };
        const remote = { ...makeNote('first-sync-content', 'Remote', '<p>remote body</p>'), orderKey: '000000000002:first-sync-content' };
        await seedLocalNotes(storage, [local]);

        const result = await storage.applyReplicaChanges('savedNotes', [{
            entityId: local.id, remoteValue: remote, remoteDeleted: false
        }]);

        expect(result.conflicts).toHaveLength(1);
        const values = (await readRawRecords()).filter(record => !record.deleted).map(record => record.value);
        expect(values).toHaveLength(2);
        expect(values.map(value => value.data.html).sort()).toEqual(['<p>local body</p>', '<p>remote body</p>']);
        expect(new Set(values.map(value => value.orderKey)).size).toBe(2);
        const copy = values.find(value => value.id !== local.id)!;
        expect(copy.orderKey).toBe(`000000000001:${encodeURIComponent(copy.id as string)}`);
    });

    it('merges local paper and image edits with a remote organization change', async () => {
        const storage = await createStorageTab();
        const base = { ...makeNote('paper-order', 'Paper'), orderKey: '000000000001:paper-order' };
        const paper = { preset: 'custom', widthMm: 180, heightMm: 240, orientation: 'landscape',
            margins: { top: 5, right: 8, bottom: 12, left: 15 }, color: '#fff8dc', inkColor: '#123456' };
        const html = '<p>local text</p><img data-unotes-image="true" src="data:image/png;base64,iVBORw0KGgo=" style="width: 120px; height: 60px;">';
        const local = { ...base, data: { ...base.data, paper, html } };
        await seedLocalNotes(storage, [local]);
        const result = await storage.applyReplicaChanges('savedNotes', [{
            entityId: base.id, remoteValue: { ...base, folderId: 'moved', orderKey: '000000000004:paper-order' },
            remoteDeleted: false, baseValue: base, baseDeleted: false
        }]);

        expect(result.conflicts).toEqual([]);
        const reloaded = await createStorageTab();
        expect((await reloaded.load()).savedNotes).toEqual([
            { ...local, folderId: 'moved', orderKey: '000000000004:paper-order' }
        ]);
    });

    it('compares sorted replica data semantically when merging a reorder with local paper edits', async () => {
        const storage = await createStorageTab();
        const { canonicalSerialize, withExtraFields } = await import('./helpers/replicaFixture.js');
        const paper = { preset: 'custom', widthMm: 180, heightMm: 240, orientation: 'landscape',
            margins: { top: 5, right: 8, bottom: 12, left: 15 }, color: '#FFFFFF', inkColor: '#123456' };
        const raw = { ...makeNote('canonical-paper', 'Paper'), data: { paper, ...makeNote('canonical-paper', 'Paper').data } };
        const base = JSON.parse(canonicalSerialize(raw));
        const local = { ...raw, data: { ...raw.data, paper: { ...paper, color: '#FFF8DC' } }, orderKey: '000000000001:canonical-paper' };
        const remote = withExtraFields(JSON.parse(canonicalSerialize({ ...raw, orderKey: '000000000002:canonical-paper' })));
        await seedLocalNotes(storage, [local]);

        const result = await storage.applyReplicaChanges('savedNotes', [{
            entityId: raw.id, remoteValue: remote as unknown as Record<string, unknown>, remoteDeleted: false,
            baseValue: base, baseDeleted: false
        }]);

        expect(result.conflicts).toEqual([]);
        const records = (await readRawRecords()).filter(record => !record.deleted);
        expect(records).toHaveLength(1);
        expect(records[0].value.data.paper.color).toBe('#FFF8DC');
        expect(records[0].value.orderKey).toBe('000000000002:canonical-paper');
    });

    it('converges folder parent and sibling ordering while retaining a local folder rename', async () => {
        const storage = await createStorageTab();
        const base = { id: 'folder', name: 'Original', color: '#fff', createdAt: 1, parentId: null, orderKey: '000000000001:folder' };
        storage.schedule('folders', [{ ...base, name: 'Local name', parentId: 'local-parent', orderKey: '000000000002:folder' }]);
        await storage.flush();
        const remote = { ...base, parentId: 'remote-parent', orderKey: '000000000003:folder' };
        const result = await storage.applyReplicaChanges('folders', [{
            entityId: base.id, remoteValue: remote, remoteDeleted: false, baseValue: base, baseDeleted: false
        }]);

        expect(result.conflicts).toEqual([]);
        expect((await readRawRecords('folders')).filter(record => !record.deleted).map(record => record.value)).toEqual([
            { ...remote, name: 'Local name' }
        ]);
    });

    it('preserves both sides via conflict copy on same-field contention', async () => {
        const storage = await createStorageTab();
        await seedLocalNotes(storage, [makeNote('n3', 'Local says A')]);

        const result = await storage.applyReplicaChanges('savedNotes', [
            {
                entityId: 'n3',
                remoteValue: makeNote('n3', 'Remote says B'),
                remoteDeleted: false,
                baseValue: makeNote('n3', 'Original'),
                baseDeleted: false,
            },
        ]);
        expect(result.conflicts.length).toBe(1);

        const records = await readRawRecords();
        const values = records.filter(record => !record.deleted).map(record => record.value);
        // The local side survives as a user-visible "(conflict copy)" note.
        expect(values.map(v => v.title as string)).toContain('Local says A (conflict copy)');
        expect(values.find(value => (value.title as string).includes('conflict copy'))?.id).not.toBe('n3');
        expect(values.some(value => value.title === 'Remote says B')).toBe(true);
    });

    it('never resurrects a local tombstone from a remote edit; keeps the edit visible', async () => {
        const storage = await createStorageTab();
        await seedLocalNotes(storage, []);
        // Simulate an existing local tombstone for n4.
        const rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = window.indexedDB.open('unotes-persistence:tests', 2);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        void rawDb;

        // Delete n4 locally first.
        await seedLocalNotes(storage, [makeNote('n4', 'Doomed')]);
        await seedLocalNotes(storage, []);

        const before = await readRawRecords();
        const tombstone = before.find(record => record.entityId === 'n4');
        expect(tombstone?.deleted).toBe(true);

        // Remote device edited n4 and pushes that edit here.
        const result = await storage.applyReplicaChanges('savedNotes', [
            {
                entityId: 'n4',
                remoteValue: makeNote('n4', 'Edited elsewhere'),
                remoteDeleted: false,
                baseValue: makeNote('n4', 'Doomed'),
                baseDeleted: false,
            },
        ]);
        expect(result.skipped).toContain('n4');

        const after = await readRawRecords();
        expect(after.find(record => record.entityId === 'n4')?.deleted).toBe(true); // Tombstone stands.
        const copies = after.filter(record => record.entityId !== 'n4' && !record.deleted).map(record => record.value);
        expect(copies.some(value => (value.title as string).includes('Edited elsewhere'))).toBe(true);
    });

    it('applies remote deletes; locally diverged edits survive as conflict copies', async () => {
        const storage = await createStorageTab();

        // Case 1: unchanged locally → deletion propagates cleanly.
        await seedLocalNotes(storage, [makeNote('n5', 'Unchanged')]);
        const first = await storage.applyReplicaChanges('savedNotes', [
            { entityId: 'n5', remoteDeleted: true, baseValue: makeNote('n5', 'Unchanged'), baseDeleted: false },
        ]);
        expect(first.applied).toContain('n5');
        expect(first.conflicts).toEqual([]);
        const afterDelete = await readRawRecords();
        expect(afterDelete.find(record => record.entityId === 'n5')?.deleted).toBe(true);

        // Case 2: cloud deleted while THIS device edited since the shared base
        // → the local edit survives as a conflict copy; the tombstone lands.
        await seedLocalNotes(storage, [makeNote('n6', 'Unchanged')]);
        await seedLocalNotes(storage, [{ ...makeNote('n6', 'Unchanged'), data: { ...makeNote('n6', 'Unchanged').data, html: '<p>local edit</p>' } }]);
        const third = await storage.applyReplicaChanges('savedNotes', [
            {
                entityId: 'n6',
                remoteDeleted: true,
                baseValue: makeNote('n6', 'Unchanged'),
                baseDeleted: false,
            },
        ]);
        expect(third.applied).toContain('n6');
        expect(third.conflicts.length).toBe(1);
        const records = await readRawRecords();
        expect(records.find(record => record.entityId === 'n6')?.deleted).toBe(true);
        const survivingCopy = records.filter(record => !record.deleted && record.entityId !== 'n6').map(record => record.value);
        expect(survivingCopy.some(value => value.data?.html === '<p>local edit</p>')).toBe(true);
    });

    it('adopts brand-new remote documents into the local library', async () => {
        const storage = await createStorageTab();
        await seedLocalNotes(storage, []);
        const result = await storage.applyReplicaChanges('savedNotes', [
            { entityId: 'n7', remoteValue: makeNote('n7', 'From the cloud'), remoteDeleted: false },
        ]);
        expect(result.applied).toEqual(['n7']);
        const records = await readRawRecords();
        const live = records.filter(record => !record.deleted).map(record => record.value);
        expect(live).toHaveLength(1);
        expect(live[0].title).toBe('From the cloud');
    });

    it('rolls back a live remote apply when its abort signal fires', async () => {
        const storage = await createStorageTab();
        await seedLocalNotes(storage, [makeNote('n8', 'Local title')]);
        const notifications: unknown[] = [];
        const unsubscribe = storage.subscribe(change => notifications.push(change));
        const controller = new AbortController();

        const databaseRequest = window.indexedDB.open('unotes-persistence:tests', 2);
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
            databaseRequest.onsuccess = () => resolve(databaseRequest.result);
            databaseRequest.onerror = () => reject(databaseRequest.error);
        });
        const probeTransaction = database.transaction('records', 'readonly');
        const objectStorePrototype = Object.getPrototypeOf(
            probeTransaction.objectStore('records')
        ) as IDBObjectStore;
        const originalPut = objectStorePrototype.put;
        database.close();

        const putSpy = vi.spyOn(objectStorePrototype, 'put').mockImplementation(function (
            this: IDBObjectStore,
            value: unknown
        ) {
            const request = originalPut.call(this, value);
            controller.abort();
            return request;
        });
        try {
            await expect(storage.applyReplicaChanges('savedNotes', [
                {
                    entityId: 'n8',
                    remoteValue: makeNote('n8', 'Remote title'),
                    remoteDeleted: false,
                    baseValue: makeNote('n8', 'Local title'),
                    baseDeleted: false,
                },
            ], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        } finally {
            putSpy.mockRestore();
            unsubscribe();
        }

        expect(notifications).toEqual([]);
        const records = await readRawRecords();
        const local = records.find(record => record.entityId === 'n8');
        expect(local?.deleted).toBe(false);
        expect(local?.value.title).toBe('Local title');
    });

    it('rejects an already-aborted apply before even an empty batch can start', async () => {
        const storage = await createStorageTab();
        const controller = new AbortController();
        controller.abort();

        await expect(storage.applyReplicaChanges(
            'savedNotes',
            [],
            { signal: controller.signal }
        )).rejects.toMatchObject({ name: 'AbortError' });
    });
});
