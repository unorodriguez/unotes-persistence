import { createNotebookStore } from '../../src/index.js';
const store = createNotebookStore({ namespace: 'tests' });
export const { load, stage, schedule, flush, subscribe, writeText, authorizeDraftResurrection,
    cancelDraftResurrection, protectNote, isNoteProtected, applyReplicaChanges, readRecordSnapshots } = store;
