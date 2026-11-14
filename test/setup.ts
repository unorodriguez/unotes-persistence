import { vi } from 'vitest';
// Unit tests use synthetic IndexedDB; native Node channels would outlive jsdom.
vi.stubGlobal('BroadcastChannel', undefined);
