import { describe, expect, it } from 'vitest';
import type { NoteOrderItem, FolderOrderItem } from '../src/index.js';
type Note = NoteOrderItem & ReturnType<typeof makeNote> & { folderId?: string };
type NoteFolder = FolderOrderItem & { name: string; color: string };
import { canMoveFolder, compareFolders, compareNotes, orderKeyForId, placeInOrder, validOrderKey } from '../src/manualOrder.js';
import { makeNote } from './helpers/makeNote.js';

const note = (id: string, lastOpened = 1): Note => ({ ...makeNote(id, id), lastOpened } as Note);
const folder = (id: string, parentId: string | null = null, createdAt = 1): NoteFolder => ({
    id, name: id, color: 'transparent', parentId, createdAt
});

describe('persistent manual sibling ordering', () => {
    it('retains existing recency/creation ordering until a manual placement', () => {
        expect([note('old', 1), note('new', 5)].sort(compareNotes).map(item => item.id)).toEqual(['new', 'old']);
        expect([note('new', 5), { ...note('pinned'), isPinned: true }].sort(compareNotes).map(item => item.id)).toEqual(['pinned', 'new']);
        expect([folder('new', null, 5), folder('old')].sort(compareFolders).map(item => item.id)).toEqual(['old', 'new']);
    });

    it('supports top, between, bottom, and cross-folder insertion without mutating content', () => {
        const a = note('a', 4), b = note('b', 3), c = note('c', 2);
        const originalHtml = c.data.html;
        expect(placeInOrder([a, b, c], c, 'a', compareNotes).map(item => item.id)).toEqual(['c', 'a', 'b']);
        expect(placeInOrder([a, b, c], c, 'b', compareNotes).map(item => item.id)).toEqual(['a', 'c', 'b']);
        const bottom = placeInOrder([a, b, c], a, null, compareNotes);
        expect(bottom.map(item => item.id)).toEqual(['b', 'c', 'a']);
        const moved = placeInOrder([a, b], { ...c, folderId: 'destination' }, 'b', compareNotes);
        expect(moved.find(item => item.id === 'c')).toMatchObject({ folderId: 'destination', data: { html: originalHtml } });
        expect(a.orderKey).toBeUndefined();
        expect(c.folderId).toBeUndefined();
        expect(new Set(moved.map(item => item.orderKey)).size).toBe(3);
        expect(moved.every(item => validOrderKey(item.orderKey))).toBe(true);
    });

    it('survives JSON reload and later access without resetting manual order', () => {
        const ordered = placeInOrder([note('a'), note('b'), note('c')], note('c'), 'a', compareNotes);
        const reloaded: Note[] = JSON.parse(JSON.stringify(ordered));
        reloaded[2].lastOpened = 1000;
        expect(reloaded.sort(compareNotes).map(item => item.id)).toEqual(['c', 'a', 'b']);
    });

    it('keeps concurrent same-rank keys unique and sorts them deterministically', () => {
        const a = placeInOrder([], note('a'), null, compareNotes)[0];
        const b = placeInOrder([], note('b'), null, compareNotes)[0];
        expect(a.orderKey).not.toBe(b.orderKey);
        expect([b, a].sort(compareNotes).map(item => item.id)).toEqual(['a', 'b']);
        expect([a, b].sort(compareNotes).map(item => item.id)).toEqual(['a', 'b']);
        expect(orderKeyForId(a.orderKey, 'copy')).toBe('000000000001:copy');
        expect(orderKeyForId('invalid', 'copy')).toBeUndefined();
        expect(orderKeyForId(a.orderKey, '\ud800')).toBeUndefined();
    });

    it('ignores a stale insertion target and rejects malformed rank metadata', () => {
        const original = [note('a'), note('b')];
        expect(placeInOrder(original, original[1], 'deleted', compareNotes)).toEqual(original);
        expect(placeInOrder(original, original[1], 'b', compareNotes)).toEqual(original);
        for (const value of [null, 1, '', 'a', '000000000001:', '000000000001:x\n', '9:x', '0'.repeat(1100)]) {
            expect(validOrderKey(value)).toBe(false);
        }
        expect(validOrderKey('000000000001:unicode%20name')).toBe(true);
    });
});

describe('folder move safety within the existing one-level hierarchy', () => {
    const folders = [folder('root'), folder('other'), folder('child', 'root'), folder('leaf')];
    it('allows sibling reorder, leaf nesting, outward movement and changing parents', () => {
        expect(canMoveFolder(folders, 'root', null)).toBe(true);
        expect(canMoveFolder(folders, 'leaf', 'root')).toBe(true);
        expect(canMoveFolder(folders, 'child', null)).toBe(true);
        expect(canMoveFolder(folders, 'child', 'other')).toBe(true);
    });
    it('rejects self, descendants, unsupported depth, missing entities and parents with children', () => {
        expect(canMoveFolder(folders, 'root', 'root')).toBe(false);
        expect(canMoveFolder(folders, 'root', 'child')).toBe(false);
        expect(canMoveFolder(folders, 'leaf', 'child')).toBe(false);
        expect(canMoveFolder(folders, 'root', 'other')).toBe(false);
        expect(canMoveFolder(folders, 'child', 'missing')).toBe(false);
        expect(canMoveFolder(folders, 'missing', null)).toBe(false);
    });
});
