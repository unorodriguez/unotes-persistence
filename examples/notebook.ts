import { createNotebookStore } from '../src/index.js';

// For a bundler consumer after local tarball installation, import from 'unotes-persistence'.
export async function appendSyntheticNote() {
    const store = createNotebookStore({ namespace: 'example-notebook' });
    const snapshot = await store.load();
    if (snapshot.readFailures.length) throw new Error('Inspect recovery state before editing.');
    const savedNotes = snapshot.savedNotes as Array<Record<string, unknown>>;
    const note = { id: 'synthetic-example', title: 'Example', data: { html: '<p>Local only</p>' } };
    store.schedule('savedNotes', [...savedNotes.filter(item => item.id !== note.id), note]);
    if (!await store.flush()) throw new Error('Keep the unsaved note and offer retry.');
    await store.close();
}
