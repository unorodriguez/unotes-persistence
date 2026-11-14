export const makeNote = (id: string, title: string, html = '<p>base</p>') => ({
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
