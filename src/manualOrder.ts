import type { NoteOrderItem as Note, FolderOrderItem as NoteFolder } from './types.js';

/** The suffix makes ranks unique even when two devices choose the same slot. */
export const validOrderKey = (value: unknown): value is string =>
    typeof value === 'string' && value.length <= 1024 && /^\d{12}:[A-Za-z0-9._~!()*'%\-]+$/.test(value);

/** Copies and repaired IDs retain their position with a distinct rank key. */
export const orderKeyForId = (value: unknown, id: string): string | undefined => {
    if (!validOrderKey(value)) return undefined;
    try {
        const key = `${value.slice(0, 13)}${encodeURIComponent(id)}`;
        return validOrderKey(key) ? key : undefined;
    } catch { return undefined; }
};

const compareIds = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

const compareOrder = (left: { id: string; orderKey?: string }, right: { id: string; orderKey?: string }) => {
    const leftKey = validOrderKey(left.orderKey) ? left.orderKey : undefined;
    const rightKey = validOrderKey(right.orderKey) ? right.orderKey : undefined;
    if (leftKey && rightKey) return compareIds(leftKey, rightKey) || compareIds(left.id, right.id);
    if (leftKey) return -1;
    if (rightKey) return 1;
    return 0;
};

export const compareNotes = (left: Note, right: Note) =>
    compareOrder(left, right) || Number(right.isPinned) - Number(left.isPinned) || right.lastOpened - left.lastOpened || compareIds(left.id, right.id);

export const compareFolders = (left: NoteFolder, right: NoteFolder) =>
    compareOrder(left, right) || left.createdAt - right.createdAt || compareIds(left.id, right.id);

/** Assign sibling positions at settlement, never during pointer movement. */
export function placeInOrder<T extends { id: string; orderKey?: string }>(
    siblings: readonly T[], moving: T, beforeId: string | null, compare: (left: T, right: T) => number
): T[] {
    const remaining = siblings.filter(item => item.id !== moving.id).sort(compare);
    const index = beforeId === null ? remaining.length : remaining.findIndex(item => item.id === beforeId);
    // A stale target must not silently move an item to a different position.
    if (index < 0 || beforeId === moving.id) return [...siblings];
    remaining.splice(index, 0, moving);
    return remaining.map((item, rank) => ({
        ...item,
        orderKey: `${String(rank + 1).padStart(12, '0')}:${encodeURIComponent(item.id)}`
    }));
}

/** The established editor supports roots and one subfolder level. */
export const canMoveFolder = (folders: readonly NoteFolder[], id: string, parentId: string | null): boolean => {
    const moving = folders.find(folder => folder.id === id);
    if (!moving || id === parentId) return false;
    if (parentId === null) return true;
    const target = folders.find(folder => folder.id === parentId);
    if (!target || target.parentId !== null) return false;
    // Moving a root with children would add an unsupported third level.
    if (folders.some(folder => folder.parentId === id)) return false;
    const seen = new Set([id]);
    let ancestor: NoteFolder | undefined = target;
    while (ancestor) {
        if (seen.has(ancestor.id)) return false;
        seen.add(ancestor.id);
        ancestor = ancestor.parentId === null ? undefined : folders.find(folder => folder.id === ancestor!.parentId);
    }
    return true;
};
