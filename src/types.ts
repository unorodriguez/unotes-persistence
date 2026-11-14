export type StorageField = 'savedNotes' | 'drafts' | 'folders' | 'explorer' | 'activeDraftId' | 'appSettings' | 'tutorialLastSeen';
export type HeavyStorageField = 'savedNotes' | 'drafts';
export type RecordStorageField = HeavyStorageField | 'folders' | 'explorer' | 'appSettings';
export type StorageFailureHandler = (error: unknown) => void;

export interface StorageSnapshot {
    savedNotes: unknown;
    drafts: unknown;
    folders: unknown;
    explorer?: unknown;
    activeDraftId: string | null;
    appSettings: unknown;
    tutorialLastSeen: string | null;
    readFailures: StorageField[];
}

export interface StateRecord {
    key: HeavyStorageField;
    schemaVersion: number;
    updatedAt: number;
    value: unknown;
}

export interface BackupRecord {
    key: string;
    createdAt: number;
    sourceKey: string;
    value: unknown;
}

export interface EntityRecord {
    key: string;
    field: RecordStorageField;
    entityId: string;
    revision: number;
    updatedAt: number;
    writerId: string;
    deleted: boolean;
    order: number;
    value?: Record<string, unknown>;
}

export type ReplicaRecordField = 'savedNotes' | 'folders';

export interface EntityRecordSnapshot {
    entityId: string;
    revision: number;
    deleted: boolean;
    value?: Record<string, unknown>;
    /** An immutable private-source archive is excluded from replica application. */
    privateWriteFenced?: boolean;
}

export interface ReplicaChange {
    entityId: string;
    /** Full note/folder payload from the caller-supplied replica (undefined for deletes). */
    remoteValue?: Record<string, unknown> | undefined;
    remoteDeleted: boolean;
    /** Last caller-supplied local snapshot used as the merge ancestor. */
    baseValue?: Record<string, unknown> | undefined;
    baseDeleted?: boolean | undefined;
}

export interface ReplicaApplyResult {
    applied: string[];
    conflicts: string[];
    skipped: string[];
}

export interface ReplicaApplyOptions {
    signal?: AbortSignal;
}

export interface StorageChange {
    fields: RecordStorageField[];
    conflicts: string[];
}

export type StorageChangeHandler = (change: StorageChange) => void;

export interface StorageChangeSubscriptionOptions {
    /** Clean writes from this document are useful to durable observers such as
     * replica observers, but a local UI bridge must not reload its own state. */
    includeLocalCommits?: boolean;
}

export interface StorageChangeSubscription {
    handler: StorageChangeHandler;
    includeLocalCommits: boolean;
}

export interface PendingWrite {
    field: StorageField;
    value: unknown;
    timer: number;
    onError?: StorageFailureHandler;
}

export interface LocalJsonReadResult {
    raw: string | null;
    value: unknown;
    parseError: unknown | null;
    readError: unknown | null;
}

export interface LocalTextReadResult {
    value: string | null;
    readError: unknown | null;
}

export interface HeavyFieldLoadResult {
    value: unknown;
    readFailed: boolean;
}

export interface ProtectedNoteRecord {
    key: string;
    noteId: string;
    snapshot: Record<string, unknown>;
    recoveryIds?: Partial<Record<'savedNotes' | 'drafts', string>>;
}

/** Required namespace. No existing Unotes database/key is read or imported. */
export interface NotebookStoreOptions { namespace: string }
export interface NoteOrderItem { id: string; isPinned: boolean; lastOpened: number; orderKey?: string }
export interface FolderOrderItem { id: string; parentId: string | null; createdAt: number; orderKey?: string }
