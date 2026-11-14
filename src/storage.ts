import { orderKeyForId } from './manualOrder.js';
import type { StorageField, HeavyStorageField, RecordStorageField, StorageFailureHandler, StorageSnapshot, StateRecord, BackupRecord, EntityRecord, ReplicaRecordField, EntityRecordSnapshot, ReplicaChange, ReplicaApplyResult, ReplicaApplyOptions, StorageChange, StorageChangeHandler, StorageChangeSubscriptionOptions, StorageChangeSubscription, PendingWrite, LocalJsonReadResult, LocalTextReadResult, HeavyFieldLoadResult, ProtectedNoteRecord, NotebookStoreOptions } from './types.js';

/** Create an isolated, browser-local notebook store. No network or account API. */
export function createNotebookStore({ namespace }: NotebookStoreOptions) {
    if (typeof namespace !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(namespace)) {
        throw new TypeError('namespace must be 1–64 lowercase ASCII letters, digits or hyphens, starting with a letter.');
    }
    if (typeof window === 'undefined') throw new Error('Creating a store requires a browser Window. Importing the package does not.');
    const DATABASE_NAME = `unotes-persistence:${namespace}`;
    const storagePrefix = `${DATABASE_NAME}:`;
    const DATABASE_VERSION = 2;
    const STORAGE_SCHEMA_VERSION = 2;
    const STATE_STORE = 'state';
    const BACKUP_STORE = 'backups';
    const RECORD_STORE = 'records';
    const SYNC_CHANNEL = `${DATABASE_NAME}:changes`;
    const SYNC_SIGNAL_KEY = `${storagePrefix}storage_sync_signal`;
    const STORAGE_KEYS = Object.freeze({
        savedNotes: `${storagePrefix}savedNotes`, drafts: `${storagePrefix}drafts`,
        folders: `${storagePrefix}folders`, explorer: `${storagePrefix}explorerRecords`,
        activeDraftId: `${storagePrefix}activeDraftId`, appSettings: `${storagePrefix}appSettings`,
        tutorialLastSeen: `${storagePrefix}tutorialLastSeen`
    });
    const protectionKey = (noteId: string) => `protected-note:${noteId}`;
    const protectionRange = () => IDBKeyRange.bound('protected-note:', 'protected-note:\uffff');

    const HEAVY_FIELDS = new Set<StorageField>(['savedNotes', 'drafts']);
    const RECORD_FIELDS = new Set<StorageField>(['savedNotes', 'drafts', 'folders', 'explorer', 'appSettings']);
    const pendingWrites = new Map<StorageField, PendingWrite>();
    const writeChains = new Map<StorageField, Promise<void>>();
    const recentScheduledWriteValues = new Map<StorageField, unknown>();
    const blockedWriteReasons = new Map<StorageField, unknown>();
    const knownRecords = new Map<RecordStorageField, Map<string, EntityRecord>>();
    let observationGeneration = 0;
    let unsettledWrites = 0;
    const authorizedDraftResurrections = new Map<string, 'open' | 'continue'>();
    const storageChangeHandlers = new Map<StorageChangeHandler, StorageChangeSubscription>();
    const writerId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let databasePromise: Promise<IDBDatabase | null> | null = null;
    let indexedDbDisabled = false;
    let indexedDbOpenFailure: unknown | null = null;
    let syncChannel: BroadcastChannel | null = null;

    /**
     * Authorizes one deliberate saved-note-to-draft open or continued live edit.
     * The authorization is consumed by the next successful draft write, so stale
     * editor callbacks
     * can never revive a tombstone merely because they observed its latest revision.
     */
    const authorizeDraftResurrection = (draftId: string, intent: 'open' | 'continue' = 'open') => {
        if (draftId) authorizedDraftResurrections.set(draftId, intent);
    };

    const cancelDraftResurrection = (draftId: string) => {
        authorizedDraftResurrections.delete(draftId);
    };

    const readLocalTextResult = (key: string): LocalTextReadResult => {
        try {
            return { value: window.localStorage.getItem(key), readError: null };
        } catch (error) {
            return { value: null, readError: error };
        }
    };

    const readTabTextResult = (key: string): LocalTextReadResult => {
        try {
            const tabValue = window.sessionStorage.getItem(key);
            return tabValue === null ? readLocalTextResult(key) : { value: tabValue, readError: null };
        } catch (error) {
            return { value: null, readError: error };
        }
    };

    const readLocalJsonResult = (key: string, fallback: unknown): LocalJsonReadResult => {
        const result = readLocalTextResult(key);
        const raw = result.value;
        if (raw === null) {
            return { raw, value: fallback, parseError: null, readError: result.readError };
        }
        try {
            return { raw, value: JSON.parse(raw), parseError: null, readError: null };
        } catch (error) {
            return { raw, value: fallback, parseError: error, readError: null };
        }
    };

    const writeLocalText = (key: string, value: string) => {
        window.localStorage.setItem(key, value);
    };

    const writeLocalJson = (key: string, value: unknown) => {
        writeLocalText(key, JSON.stringify(value));
    };

    const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
        new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
        });

    const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
        new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
            transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
        });

    const isRecordValue = (value: unknown): value is Record<string, unknown> =>
        Boolean(value) && typeof value === 'object' && !Array.isArray(value);

    /** Replica payloads may sort keys; editor snapshots may insert paper metadata first. */
    const serializeStorageValue = (value: unknown) => {
        const sortedObjects = new WeakMap<object, Record<string, unknown>>();
        return JSON.stringify(value, (_key, candidate: unknown) => {
            if (!isRecordValue(candidate)) return candidate;
            const known = sortedObjects.get(candidate);
            if (known) return known;
            const sorted = Object.fromEntries(Object.keys(candidate).sort().map(key => [key, candidate[key]]));
            sortedObjects.set(candidate, sorted);
            return sorted;
        });
    };

    const valuesEqual = (left: unknown, right: unknown) => {
        if (Object.is(left, right)) return true;
        try {
            return serializeStorageValue(left) === serializeStorageValue(right);
        } catch {
            return false;
        }
    };

    const DRAFT_SESSION_FIELDS = new Set(['lastOpened', 'totalTime', 'sessions', 'scrollPos']);

    /** Concurrent tabs can derive the same draft from one saved note before either
     * sees the other's first write. Session counters/positions are tab-local
     * lifecycle metadata and must not manufacture a user-visible conflict copy. */
    const draftUserContentMatches = (
        left: Record<string, unknown>,
        right: Record<string, unknown>
    ) => valuesEqual(
        Object.fromEntries(Object.entries(left).filter(([key]) => !DRAFT_SESSION_FIELDS.has(key))),
        Object.fromEntries(Object.entries(right).filter(([key]) => !DRAFT_SESSION_FIELDS.has(key)))
    );

    const cloneEntityRecord = (record: EntityRecord): EntityRecord => ({
        ...record,
        value: record.value ? structuredClone(record.value) : undefined
    });

    const getEntityKey = (field: RecordStorageField, entityId: string) => `${field}:${entityId}`;

    const readEntityRecords = async (
        database: IDBDatabase,
        field: RecordStorageField,
        mode: IDBTransactionMode = 'readonly'
    ) => {
        const transaction = database.transaction(RECORD_STORE, mode);
        const records = await requestResult(
            transaction.objectStore(RECORD_STORE).index('field').getAll(field) as IDBRequest<EntityRecord[]>
        );
        return { transaction, records };
    };

    const toFieldEntities = (field: RecordStorageField, value: unknown) => {
        if (field === 'appSettings') {
            return isRecordValue(value) ? [{ entityId: '$settings', value, order: 0 }] : [];
        }
        if (!Array.isArray(value)) return [];
        return value.flatMap((candidate, order) =>
            isRecordValue(candidate) && typeof candidate.id === 'string' && candidate.id
                ? [{ entityId: candidate.id, value: candidate, order }]
                : []
        );
    };

    const getLiveFieldValue = (
        field: RecordStorageField,
        records: Iterable<EntityRecord>,
        preferredOrder: string[] = []
    ) => {
        const live = Array.from(records).filter(record => !record.deleted && record.value);
        if (field === 'appSettings') {
            return live.find(record => record.entityId === '$settings')?.value || {};
        }
        const order = new Map(preferredOrder.map((id, index) => [id, index]));
        live.sort((left, right) => {
            const leftOrder = order.get(left.entityId);
            const rightOrder = order.get(right.entityId);
            if (leftOrder !== undefined || rightOrder !== undefined) {
                if (leftOrder === undefined) return 1;
                if (rightOrder === undefined) return -1;
                return leftOrder - rightOrder;
            }
            return left.order - right.order || left.updatedAt - right.updatedAt;
        });
        return live.map(record => record.value);
    };

    const ORGANIZATION_FIELDS = new Set(['orderKey', 'folderId', 'parentId', 'archivedAt']);

    /** A missing common ancestor needs a content copy only when content differs. */
    const organizationOnlyDifferences = (
        local: Record<string, unknown>,
        remote: Record<string, unknown>
    ) => Array.from(new Set([...Object.keys(local), ...Object.keys(remote)]))
        .every(key => ORGANIZATION_FIELDS.has(key) || valuesEqual(local[key], remote[key]) || (
            // The v1 validator adds an empty forward-compatibility container to
            // legacy notes. It carries no content and is not a conflicting edit.
            key === 'extraFields' &&
            [local[key], remote[key]].every(value => value === undefined || (isRecordValue(value) && Object.keys(value).length === 0))
        ));

    const mergeRecordValues = (
        base: Record<string, unknown>,
        local: Record<string, unknown>,
        remote: Record<string, unknown>
    ) => {
        const merged: Record<string, unknown> = Object.create(null);
        const conflictingKeys: string[] = [];
        const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
        for (const key of keys) {
            const baseValue = Object.hasOwn(base, key) ? base[key] : undefined;
            const localValue = Object.hasOwn(local, key) ? local[key] : undefined;
            const remoteValue = Object.hasOwn(remote, key) ? remote[key] : undefined;
            if (valuesEqual(localValue, remoteValue)) {
                if (localValue !== undefined) merged[key] = localValue;
            } else if (valuesEqual(localValue, baseValue)) {
                if (remoteValue !== undefined) merged[key] = remoteValue;
            } else if (valuesEqual(remoteValue, baseValue)) {
                if (localValue !== undefined) merged[key] = localValue;
            } else if (ORGANIZATION_FIELDS.has(key)) {
                // Competing organization choices converge on the committed remote
                // revision. Content conflicts below still preserve a conflict copy.
                if (remoteValue !== undefined) merged[key] = remoteValue;
            } else if (
                (key === 'totalTime' || key === 'sessions') &&
                typeof baseValue === 'number' &&
                typeof localValue === 'number' &&
                typeof remoteValue === 'number'
            ) {
                merged[key] = baseValue + (localValue - baseValue) + (remoteValue - baseValue);
            } else if (
                (key === 'lastOpened' || key === 'trashedAt') &&
                typeof localValue === 'number' &&
                typeof remoteValue === 'number'
            ) {
                merged[key] = Math.max(localValue, remoteValue);
            } else {
                if (remoteValue !== undefined) merged[key] = remoteValue;
                conflictingKeys.push(key);
            }
        }
        return { merged, conflictingKeys };
    };

    const createConflictValue = (value: Record<string, unknown>, originalId: string) => {
        const now = Date.now();
        const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${now}-${Math.random().toString(36).slice(2)}`;
        const entityId = `${originalId}-conflict-${suffix}`;
        return {
            entityId,
            value: {
                ...value,
                id: entityId,
                orderKey: orderKeyForId(value.orderKey, entityId),
                title: `${typeof value.title === 'string' && value.title.trim() ? value.title : 'Untitled'} (conflict copy)`,
                ...(typeof value.ownerScope === 'string' && typeof value.name === 'string' ? { name: `${value.name} (conflict copy)` } : {}),
                lastOpened: now
            }
        };
    };

    const publishStorageChange = (change: StorageChange, notifyCurrentTab: boolean) => {
        // Source fences and remote applies also invalidate a read which is still
        // waiting for its UI to decide whether to adopt the observed revisions.
        observationGeneration += 1;
        const messageId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? `${writerId}:${crypto.randomUUID()}`
            : `${writerId}:${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const payload = { source: writerId, messageId, ...change };
        storageChangeHandlers.forEach(subscription => {
            if (notifyCurrentTab || subscription.includeLocalCommits) {
                try { subscription.handler(structuredClone(change)); } catch { /* Observers do not decide commit success. */ }
            }
        });
        try {
            if (typeof BroadcastChannel !== 'undefined') {
                syncChannel ||= new BroadcastChannel(SYNC_CHANNEL);
                syncChannel.postMessage(payload);
            }
        } catch (error) {
        }
        try {
            window.localStorage.setItem(SYNC_SIGNAL_KEY, JSON.stringify({
                ...payload,
                nonce: `${Date.now()}-${Math.random()}`,
            }));
        } catch {
            // BroadcastChannel is the primary transport; this is only its compatibility fallback.
        }
    };

    const subscribeToStorageChanges = (
        handler: StorageChangeHandler,
        options: StorageChangeSubscriptionOptions = {}
    ) => {
        storageChangeHandlers.set(handler, {
            handler,
            includeLocalCommits: options.includeLocalCommits !== false
        });
        const seenMessageIds = new Set<string>();
        const receive = (payload: unknown) => {
            if (!isRecordValue(payload) || payload.source === writerId || !Array.isArray(payload.fields)) return;
            if (typeof payload.messageId === 'string') {
                if (seenMessageIds.has(payload.messageId)) return;
                seenMessageIds.add(payload.messageId);
                if (seenMessageIds.size > 64) {
                    const oldest = seenMessageIds.values().next().value;
                    if (typeof oldest === 'string') seenMessageIds.delete(oldest);
                }
            }
            observationGeneration += 1;
            const change: StorageChange = {
                fields: payload.fields.filter(field => RECORD_FIELDS.has(field as StorageField)) as RecordStorageField[],
                conflicts: Array.isArray(payload.conflicts)
                    ? payload.conflicts.filter((item): item is string => typeof item === 'string')
                    : []
            };
            try { handler(change); } catch { /* Observer failure does not affect persistence. */ }
        };
        let channel: BroadcastChannel | null = null;
        try {
            if (typeof BroadcastChannel !== 'undefined') {
                channel = new BroadcastChannel(SYNC_CHANNEL);
                channel.addEventListener('message', event => receive(event.data));
            }
        } catch { /* Storage events remain available when channel construction fails. */ }
        const onStorage = (event: StorageEvent) => {
            if (event.key !== SYNC_SIGNAL_KEY || !event.newValue) return;
            try {
                receive(JSON.parse(event.newValue));
            } catch {
                // Ignore unrelated or malformed compatibility signals.
            }
        };
        window.addEventListener('storage', onStorage);
        return () => {
            storageChangeHandlers.delete(handler);
            channel?.close();
            window.removeEventListener('storage', onStorage);
        };
    };

    const openDatabase = (): Promise<IDBDatabase | null> => {
        if (indexedDbDisabled || typeof window.indexedDB === 'undefined') {
            return Promise.resolve(null);
        }
        if (databasePromise) return databasePromise;

        databasePromise = new Promise(resolve => {
            let settled = false;
            const finish = (database: IDBDatabase | null) => {
                if (settled) {
                    database?.close();
                    return;
                }
                settled = true;
                resolve(database);
            };
            let request: IDBOpenDBRequest;
            try {
                request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
            } catch (error) {
                indexedDbDisabled = true;
                indexedDbOpenFailure = error;
                finish(null);
                return;
            }

            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(STATE_STORE)) {
                    database.createObjectStore(STATE_STORE, { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains(BACKUP_STORE)) {
                    database.createObjectStore(BACKUP_STORE, { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains(RECORD_STORE)) {
                    const records = database.createObjectStore(RECORD_STORE, { keyPath: 'key' });
                    records.createIndex('field', 'field', { unique: false });
                }
            };
            request.onsuccess = () => {
                const database = request.result;
                database.onversionchange = () => database.close();
                if (settled) {
                    database.close();
                    return;
                }
                indexedDbOpenFailure = null;
                finish(database);
            };
            request.onerror = () => {
                indexedDbDisabled = true;
                indexedDbOpenFailure = request.error || new Error('IndexedDB could not be opened.');
                finish(null);
            };
            request.onblocked = () => {
                indexedDbDisabled = true;
                indexedDbOpenFailure = new Error('IndexedDB access is blocked by another tab.');
                finish(null);
            };
        });

        return databasePromise;
    };

    const readStateRecord = async (
        database: IDBDatabase,
        field: HeavyStorageField
    ): Promise<StateRecord | undefined> => {
        const transaction = database.transaction(STATE_STORE, 'readonly');
        return requestResult(
            transaction.objectStore(STATE_STORE).get(field) as IDBRequest<StateRecord | undefined>
        );
    };

    const preserveLegacyBackup = async (
        database: IDBDatabase,
        field: HeavyStorageField,
        value: unknown
    ) => {
        const backupKey = `legacy-v${STORAGE_SCHEMA_VERSION}:${field}`;
        const transaction = database.transaction(BACKUP_STORE, 'readwrite');
        const store = transaction.objectStore(BACKUP_STORE);
        const existing = await requestResult(
            store.get(backupKey) as IDBRequest<BackupRecord | undefined>
        );
        if (!existing) {
            store.put({
                key: backupKey,
                createdAt: Date.now(),
                sourceKey: STORAGE_KEYS[field],
                value
            } satisfies BackupRecord);
        }
        await transactionComplete(transaction);
    };

    const getMalformedBackupKey = (field: StorageField, raw: string) => {
        let fingerprint = 2166136261;
        for (let index = 0; index < raw.length; index += 1) {
            fingerprint ^= raw.charCodeAt(index);
            fingerprint = Math.imul(fingerprint, 16777619);
        }
        return `malformed-v${STORAGE_SCHEMA_VERSION}:${field}:${raw.length}:${(fingerprint >>> 0).toString(36)}`;
    };

    const preserveMalformedLegacyBackup = async (
        database: IDBDatabase | null,
        field: StorageField,
        raw: string
    ): Promise<boolean> => {
        const backupKey = getMalformedBackupKey(field, raw);
        if (database) {
            try {
                const transaction = database.transaction(BACKUP_STORE, 'readwrite');
                const store = transaction.objectStore(BACKUP_STORE);
                const existing = await requestResult(
                    store.get(backupKey) as IDBRequest<BackupRecord | undefined>
                );
                if (!existing) {
                    store.put({
                        key: backupKey,
                        createdAt: Date.now(),
                        sourceKey: STORAGE_KEYS[field],
                        value: raw
                    } satisfies BackupRecord);
                }
                await transactionComplete(transaction);
                return true;
            } catch (error) {
            }
        }

        try {
            writeLocalJson(`${storagePrefix}malformedBackup_v${STORAGE_SCHEMA_VERSION}_${backupKey}`, {
                createdAt: Date.now(),
                sourceKey: STORAGE_KEYS[field],
                value: raw
            });
            return true;
        } catch (error) {
            return false;
        }
    };

    const writeHeavyState = async (
        database: IDBDatabase,
        field: HeavyStorageField,
        value: unknown
    ) => {
        const transaction = database.transaction(STATE_STORE, 'readwrite');
        transaction.objectStore(STATE_STORE).put({
            key: field,
            schemaVersion: STORAGE_SCHEMA_VERSION,
            updatedAt: Date.now(),
            value
        } satisfies StateRecord);
        await transactionComplete(transaction);
    };

    const markHeavyMigrationComplete = (field: HeavyStorageField) => {
        const legacyKey = STORAGE_KEYS[field];
        try {
            writeLocalText(`${storagePrefix}storage_v${STORAGE_SCHEMA_VERSION}_${field}_migrated`, Date.now().toString());
            window.localStorage.removeItem(`${storagePrefix}storage_v${STORAGE_SCHEMA_VERSION}_${field}_fallback`);
            window.localStorage.removeItem(legacyKey);
        } catch (error) {
            // A retained legacy copy is safe; IndexedDB remains canonical.
        }
    };

    const migrateLegacyHeavyValue = async (
        database: IDBDatabase,
        field: HeavyStorageField,
        value: unknown
    ) => {
        const transaction = database.transaction([STATE_STORE, BACKUP_STORE], 'readwrite');
        const stateStore = transaction.objectStore(STATE_STORE);
        const backupStore = transaction.objectStore(BACKUP_STORE);
        const backupKey = `legacy-v${STORAGE_SCHEMA_VERSION}:${field}`;
        const existingBackup = await requestResult(
            backupStore.get(backupKey) as IDBRequest<BackupRecord | undefined>
        );

        if (!existingBackup) {
            backupStore.put({
                key: backupKey,
                createdAt: Date.now(),
                sourceKey: STORAGE_KEYS[field],
                value
            } satisfies BackupRecord);
        }
        stateStore.put({
            key: field,
            schemaVersion: STORAGE_SCHEMA_VERSION,
            updatedAt: Date.now(),
            value
        } satisfies StateRecord);
        await transactionComplete(transaction);

        const verifiedRecord = await readStateRecord(database, field);
        if (!verifiedRecord || verifiedRecord.schemaVersion !== STORAGE_SCHEMA_VERSION) {
            throw new Error(`IndexedDB migration verification failed for ${field}.`);
        }
        markHeavyMigrationComplete(field);
        return verifiedRecord.value;
    };

    const loadHeavyField = async (
        field: HeavyStorageField,
        fallback: unknown
    ): Promise<HeavyFieldLoadResult> => {
        const legacyKey = STORAGE_KEYS[field];
        const legacy = readLocalJsonResult(legacyKey, fallback);
        const legacyValueIsValid = legacy.raw !== null &&
            legacy.parseError === null &&
            Array.isArray(legacy.value);
        const fallbackMarker = readLocalTextResult(
            `${storagePrefix}storage_v${STORAGE_SCHEMA_VERSION}_${field}_fallback`
        );
        const fallbackWrittenAt = Number.parseInt(fallbackMarker.value || '', 10);
        const database = await openDatabase();
        if (!database) {
            blockedWriteReasons.delete(field);
            const readFailure = indexedDbOpenFailure || legacy.readError;
            if (readFailure) {
                blockedWriteReasons.set(field, readFailure);
                return {
                    value: legacyValueIsValid ? legacy.value : fallback,
                    readFailed: true
                };
            }
            if (legacy.raw !== null && legacy.parseError !== null) {
                const preserved = await preserveMalformedLegacyBackup(null, field, legacy.raw);
                if (!preserved) {
                    blockedWriteReasons.set(field, legacy.parseError);
                    return { value: fallback, readFailed: true };
                }
            }
            return {
                value: legacyValueIsValid ? legacy.value : fallback,
                readFailed: false
            };
        }

        let record: StateRecord | undefined;
        try {
            record = await readStateRecord(database, field);
            blockedWriteReasons.delete(field);
        } catch (error) {
            blockedWriteReasons.set(field, error);
            return {
                value: legacyValueIsValid ? legacy.value : fallback,
                readFailed: true
            };
        }

        if (!record && legacy.readError) {
            blockedWriteReasons.set(field, legacy.readError);
            return { value: fallback, readFailed: true };
        }

        if (legacy.raw !== null && legacy.parseError !== null) {
            const preserved = await preserveMalformedLegacyBackup(database, field, legacy.raw);
            if (!preserved) {
                blockedWriteReasons.set(field, legacy.parseError);
                return {
                    value: record && Array.isArray(record.value) ? record.value : fallback,
                    readFailed: true
                };
            }

            if (record && Array.isArray(record.value)) {
                markHeavyMigrationComplete(field);
                return { value: record.value, readFailed: false };
            }

            if (!record) {
                try {
                    await writeHeavyState(database, field, fallback);
                    markHeavyMigrationComplete(field);
                } catch (error) {
                }
                return { value: fallback, readFailed: false };
            }
        }

        if (record && !Array.isArray(record.value)) {
            const error = new Error(`IndexedDB contains an invalid ${field} record.`);
            blockedWriteReasons.set(field, error);
            return {
                value: legacyValueIsValid ? legacy.value : fallback,
                readFailed: true
            };
        }

        if (record && legacyValueIsValid && fallbackMarker.readError) {
            blockedWriteReasons.set(field, fallbackMarker.readError);
            return { value: record.value, readFailed: true };
        }

        if (
            legacyValueIsValid &&
            Number.isFinite(fallbackWrittenAt) &&
            (!record || fallbackWrittenAt >= record.updatedAt)
        ) {
            try {
                return {
                    value: await migrateLegacyHeavyValue(database, field, legacy.value),
                    readFailed: false
                };
            } catch (error) {
                return { value: legacy.value, readFailed: false };
            }
        }

        if (record && Array.isArray(record.value)) {
            if (legacyValueIsValid) {
                try {
                    await preserveLegacyBackup(database, field, legacy.value);
                    markHeavyMigrationComplete(field);
                } catch (error) {
                    blockedWriteReasons.set(field, error);
                    return { value: record.value, readFailed: true };
                }
            }
            return { value: record.value, readFailed: false };
        }

        if (legacyValueIsValid) {
            try {
                return {
                    value: await migrateLegacyHeavyValue(database, field, legacy.value),
                    readFailed: false
                };
            } catch (error) {
                return { value: legacy.value, readFailed: false };
            }
        }

        return { value: fallback, readFailed: false };
    };

    const loadRecordField = async (
        field: RecordStorageField,
        fallback: unknown,
        stagedRecords?: Map<RecordStorageField, Map<string, EntityRecord>>
    ): Promise<{ value: unknown; readFailed: boolean }> => {
        const database = await openDatabase();
        if (!database) return { value: fallback, readFailed: false };
        try {
            const { records } = await readEntityRecords(database, field);
            if (records.length > 0) {
                const recordMap = new Map(records.map(record => [record.entityId, cloneEntityRecord(record)]));
                if (stagedRecords) stagedRecords.set(field, recordMap);
                else {
                    knownRecords.set(field, recordMap);
                    recentScheduledWriteValues.delete(field);
                    observationGeneration += 1;
                }
                blockedWriteReasons.delete(field);
                return { value: getLiveFieldValue(field, recordMap.values()), readFailed: false };
            }

            const entities = toFieldEntities(field, fallback);
            const migrated = new Map<string, EntityRecord>();
            if (entities.length > 0) {
                const storeNames = field === 'savedNotes' || field === 'drafts'
                    ? [RECORD_STORE, STATE_STORE]
                    : [RECORD_STORE];
                const transaction = database.transaction(storeNames, 'readwrite');
                const store = transaction.objectStore(RECORD_STORE);
                const now = Date.now();
                entities.forEach(entity => {
                    const record: EntityRecord = {
                        key: getEntityKey(field, entity.entityId),
                        field,
                        entityId: entity.entityId,
                        revision: 1,
                        updatedAt: now,
                        writerId,
                        deleted: false,
                        order: entity.order,
                        value: structuredClone(entity.value)
                    };
                    migrated.set(entity.entityId, record);
                    store.put(record);
                });
                if (field === 'savedNotes' || field === 'drafts') {
                    transaction.objectStore(STATE_STORE).put({
                        key: field,
                        schemaVersion: STORAGE_SCHEMA_VERSION,
                        updatedAt: now,
                        value: getLiveFieldValue(field, migrated.values())
                    } satisfies StateRecord);
                }
                await transactionComplete(transaction);
            }
            if (stagedRecords) stagedRecords.set(field, migrated);
            else {
                knownRecords.set(field, migrated);
                recentScheduledWriteValues.delete(field);
                observationGeneration += 1;
            }
            blockedWriteReasons.delete(field);
            return { value: getLiveFieldValue(field, migrated.values()), readFailed: false };
        } catch (error) {
            blockedWriteReasons.set(field, error);
            return { value: fallback, readFailed: true };
        }
    };

    const persistRecordField = async (
        database: IDBDatabase,
        field: RecordStorageField,
        value: unknown
    ) => {
        const transaction = database.transaction([RECORD_STORE,STATE_STORE], 'readwrite');
        const store = transaction.objectStore(RECORD_STORE);
        const currentRecords = await requestResult(
            store.index('field').getAll(field) as IDBRequest<EntityRecord[]>
        );
        const current = new Map(currentRecords.map(record => [record.entityId, cloneEntityRecord(record)]));
        const fences = (field === 'savedNotes' || field === 'drafts')
            ? await requestResult(transaction.objectStore(STATE_STORE).getAll(protectionRange()) as IDBRequest<ProtectedNoteRecord[]>) : [];
        const fenced = new Map(fences.map(receipt => [receipt.noteId,receipt]));
        const base = knownRecords.get(field) || new Map(currentRecords.map(record => [record.entityId, cloneEntityRecord(record)]));
        const localEntities = toFieldEntities(field, value);
        const local = new Map(localEntities.map(entity => [entity.entityId, entity]));
        const draftResurrectionAuthorizations = field === 'drafts'
            ? new Map(authorizedDraftResurrections)
            : new Map<string, 'open' | 'continue'>();
        const consumedDraftResurrectionAuthorizations = new Set<string>();
        const finalRecords = new Map(current);
        const recordsToWrite: EntityRecord[] = [];
        const conflicts: string[] = [];
        const now = Date.now();

        const writeRecord = (record: EntityRecord) => {
            finalRecords.set(record.entityId, record);
            recordsToWrite.push(record);
            store.put(record);
        };
        const preserveConflict = (candidate: Record<string, unknown>, originalId: string) => {
            if (field === 'appSettings') return;
            const conflict = createConflictValue(candidate, originalId);
            const title = typeof candidate.title === 'string' && candidate.title.trim()
                ? candidate.title
                : typeof candidate.name === 'string' && candidate.name.trim()
                    ? candidate.name
                    : originalId;
            conflicts.push(title);
            writeRecord({
                key: getEntityKey(field, conflict.entityId),
                field,
                entityId: conflict.entityId,
                revision: 1,
                updatedAt: now,
                writerId,
                deleted: false,
                order: localEntities.length + conflicts.length,
                value: conflict.value
            });
            return conflict.entityId;
        };
        const nextRecord = (
            entityId: string,
            revision: number,
            order: number,
            entityValue?: Record<string, unknown>,
            deleted = false
        ): EntityRecord => ({
            key: getEntityKey(field, entityId),
            field,
            entityId,
            revision,
            updatedAt: now,
            writerId,
            deleted,
            order,
            value: entityValue ? structuredClone(entityValue) : undefined
        });

        for (const entity of localEntities) {
            const protection = field === 'explorer' ? undefined : fenced.get(entity.entityId);
            if (protection) {
                // Preserve genuinely new stale private work under a new identity;
                // the protected original remains untouched.
                if (!valuesEqual(entity.value.data,protection.snapshot.data) && (field === 'savedNotes' || field === 'drafts')) {
                    const previousId = protection.recoveryIds?.[field];
                    const previous = previousId ? finalRecords.get(previousId) : undefined;
                    if (!previous || previous.deleted || !valuesEqual(previous.value?.data,entity.value.data)) {
                        const recoveryId = preserveConflict(entity.value,entity.entityId)!;
                        protection.recoveryIds = { ...protection.recoveryIds,[field]: recoveryId };
                        transaction.objectStore(STATE_STORE).put(protection);
                    }
                }
                continue;
            }
            if (draftResurrectionAuthorizations.has(entity.entityId)) {
                consumedDraftResurrectionAuthorizations.add(entity.entityId);
            }
            const baseRecord = base.get(entity.entityId);
            const currentRecord = current.get(entity.entityId);
            if (!currentRecord) {
                writeRecord(nextRecord(entity.entityId, (baseRecord?.revision || 0) + 1, entity.order, entity.value));
                continue;
            }
            let mayResurrectDraft = draftResurrectionAuthorizations.get(entity.entityId) === 'open' &&
                baseRecord?.revision === currentRecord.revision;
            if (currentRecord.deleted && draftResurrectionAuthorizations.get(entity.entityId) === 'continue') {
                const savedNote = await requestResult(store.get(getEntityKey('savedNotes', entity.entityId)) as IDBRequest<EntityRecord | undefined>);
                // A remote draft close may be overridden by a mounted editor; a
                // real note deletion or move to Trash must remain authoritative.
                mayResurrectDraft = Boolean(savedNote && !savedNote.deleted && savedNote.value && !savedNote.value.trashedAt);
            }
            if (currentRecord.deleted && field === 'drafts' && mayResurrectDraft) {
                // A user may keep editing an open note before this tab observes
                // another tab's close. The deliberate open/edit authorization is
                // valid across that unseen tombstone too; stale callbacks without
                // authorization still preserve a conflict copy below. Local
                // write fences have already rejected competing writers.
                writeRecord(nextRecord(entity.entityId, currentRecord.revision + 1, entity.order, entity.value));
                continue;
            }
            if (!baseRecord) {
                if (currentRecord.deleted) preserveConflict(entity.value, entity.entityId);
                else if (
                    field === 'drafts' &&
                    currentRecord.value &&
                    draftUserContentMatches(currentRecord.value, entity.value)
                ) {
                    // Both tabs opened the same saved note concurrently. Adopt the
                    // first live record; the sync signal will align both editors.
                } else if (
                    currentRecord.value &&
                    organizationOnlyDifferences(currentRecord.value, entity.value)
                ) {
                    // An unobserved insert/reorder already committed in another tab.
                    // Its organization wins without duplicating identical content.
                } else if (!valuesEqual(currentRecord.value, entity.value)) {
                    preserveConflict(entity.value, entity.entityId);
                }
                continue;
            }
            if (currentRecord.revision === baseRecord.revision) {
                if (baseRecord.deleted) {
                    // Observing a tombstone alone never authorizes resurrection.
                    preserveConflict(entity.value, entity.entityId);
                } else if (!valuesEqual(currentRecord.value, entity.value) || currentRecord.order !== entity.order) {
                    writeRecord(nextRecord(entity.entityId, currentRecord.revision + 1, entity.order, entity.value));
                }
                continue;
            }
            if (currentRecord.deleted) {
                if (!valuesEqual(baseRecord.value, entity.value)) preserveConflict(entity.value, entity.entityId);
                continue;
            }
            if (baseRecord.deleted || !baseRecord.value || !currentRecord.value) {
                preserveConflict(entity.value, entity.entityId);
                continue;
            }
            const merged = mergeRecordValues(baseRecord.value, entity.value, currentRecord.value);
            if (merged.conflictingKeys.length > 0) preserveConflict(entity.value, entity.entityId);
            if (!valuesEqual(merged.merged, currentRecord.value) || currentRecord.order !== entity.order) {
                writeRecord(nextRecord(
                    entity.entityId,
                    currentRecord.revision + 1,
                    entity.order,
                    merged.merged
                ));
            }
        }

        if (field !== 'appSettings') {
            for (const [entityId, baseRecord] of base) {
                if (field !== 'explorer' && fenced.has(entityId)) continue;
                if (baseRecord.deleted || local.has(entityId)) continue;
                const currentRecord = current.get(entityId);
                if (!currentRecord || currentRecord.deleted) continue;
                if (currentRecord.revision !== baseRecord.revision && currentRecord.value) {
                    preserveConflict(currentRecord.value, entityId);
                }
                writeRecord(nextRecord(entityId, currentRecord.revision + 1, currentRecord.order, undefined, true));
            }
        }

        const preferredOrder = localEntities.map(entity => entity.entityId);
        const resolvedValue = getLiveFieldValue(field, finalRecords.values(), preferredOrder);
        await transactionComplete(transaction);
        if (field === 'drafts') {
            consumedDraftResurrectionAuthorizations.forEach(draftId => {
                authorizedDraftResurrections.delete(draftId);
            });
        }
        knownRecords.set(
            field,
            new Map(Array.from(finalRecords, ([id, record]) => [id, cloneEntityRecord(record)]))
        );
        observationGeneration += 1;

        if (field === 'folders' || field === 'explorer' || field === 'appSettings') {
            writeLocalJson(STORAGE_KEYS[field], resolvedValue);
        }
        if ((field === 'savedNotes' || field === 'drafts') && recordsToWrite.length > 0) {
            markHeavyMigrationComplete(field);
        }
        if (recordsToWrite.length > 0) {
            publishStorageChange(
                { fields: [field], conflicts },
                conflicts.length > 0 || !valuesEqual(resolvedValue, value)
            );
        }
        return resolvedValue;
    };

    const readStorageSnapshot = async (
        stagedRecords?: Map<RecordStorageField, Map<string, EntityRecord>>
    ): Promise<StorageSnapshot> => {
        const [legacySavedNotes, legacyDrafts] = await Promise.all([
            loadHeavyField('savedNotes', []),
            loadHeavyField('drafts', [])
        ]);
        const foldersResult = readLocalJsonResult(STORAGE_KEYS.folders, []);
        const explorerResult = readLocalJsonResult(STORAGE_KEYS.explorer, []);
        const appSettingsResult = readLocalJsonResult(STORAGE_KEYS.appSettings, {});
        const activeDraftIdResult = readTabTextResult(STORAGE_KEYS.activeDraftId);
        const tutorialLastSeenResult = readLocalTextResult(STORAGE_KEYS.tutorialLastSeen);
        const readFailures: StorageField[] = [];
        if (legacySavedNotes.readFailed) readFailures.push('savedNotes');
        if (legacyDrafts.readFailed) readFailures.push('drafts');

        for (const [field, result] of [
            ['folders', foldersResult],
            ['explorer', explorerResult],
            ['appSettings', appSettingsResult]
        ] as const) {
            if (result.readError) {
                blockedWriteReasons.set(field, result.readError);
                readFailures.push(field);
                continue;
            }
            if (result.raw === null || result.parseError === null) {
                blockedWriteReasons.delete(field);
                continue;
            }
            const preserved = await preserveMalformedLegacyBackup(await openDatabase(), field, result.raw);
            if (!preserved) {
                blockedWriteReasons.set(field, result.parseError);
                readFailures.push(field);
            }
        }

        for (const [field, result] of [
            ['activeDraftId', activeDraftIdResult],
            ['tutorialLastSeen', tutorialLastSeenResult]
        ] as const) {
            if (result.readError) {
                blockedWriteReasons.set(field, result.readError);
                readFailures.push(field);
            } else {
                blockedWriteReasons.delete(field);
            }
        }

        const [savedNotesResult, draftsResult, versionedFolders, versionedSettings, versionedExplorer] = await Promise.all([
            legacySavedNotes.readFailed
                ? Promise.resolve(legacySavedNotes)
                : loadRecordField('savedNotes', legacySavedNotes.value, stagedRecords),
            legacyDrafts.readFailed
                ? Promise.resolve(legacyDrafts)
                : loadRecordField('drafts', legacyDrafts.value, stagedRecords),
            foldersResult.readError
                ? Promise.resolve({ value: foldersResult.value, readFailed: true })
                : loadRecordField('folders', foldersResult.value, stagedRecords),
            appSettingsResult.readError
                ? Promise.resolve({ value: appSettingsResult.value, readFailed: true })
                : loadRecordField('appSettings', appSettingsResult.value, stagedRecords),
            explorerResult.readError
                ? Promise.resolve({ value: explorerResult.value, readFailed: true })
                : loadRecordField('explorer', explorerResult.value, stagedRecords)
        ]);
        for (const [field, result] of [
            ['savedNotes', savedNotesResult],
            ['drafts', draftsResult],
            ['folders', versionedFolders],
            ['appSettings', versionedSettings],
            ['explorer', versionedExplorer]
        ] as const) {
            if (result.readFailed && !readFailures.includes(field)) readFailures.push(field);
        }

        return {
            savedNotes: savedNotesResult.value,
            drafts: draftsResult.value,
            folders: versionedFolders.value,
            explorer: versionedExplorer.value,
            activeDraftId: activeDraftIdResult.value,
            appSettings: versionedSettings.value,
            tutorialLastSeen: tutorialLastSeenResult.value,
            readFailures
        };
    };

    /** Bootstrap reads adopt revisions immediately, before an editor is active. */
    const loadStorageSnapshot = (): Promise<StorageSnapshot> => readStorageSnapshot();

    /**
     * A cross-tab refresh must adopt its UI value and merge ancestor together.
     * Until accept succeeds, the observed revisions remain detached so discarding
     * a stale UI refresh cannot make later local input overwrite remote content.
     */
    const stageStorageSnapshot = async (): Promise<{
        snapshot: StorageSnapshot;
        accept: () => boolean;
    }> => {
        const generation = observationGeneration;
        const startedWithWrites = pendingWrites.size > 0 || unsettledWrites > 0;
        const stagedRecords = new Map<RecordStorageField, Map<string, EntityRecord>>();
        const snapshot = structuredClone(await readStorageSnapshot(stagedRecords));
        let used = false;
        return {
            snapshot,
            accept: () => {
                if (used) return false;
                used = true;
                if (startedWithWrites || observationGeneration !== generation || pendingWrites.size > 0 || unsettledWrites > 0) {
                    return false;
                }
                for (const [field, records] of stagedRecords) {
                    // Keep the caller's mutable UI snapshot separate from ancestry.
                    knownRecords.set(field, new Map(Array.from(records, ([id, record]) => [id, cloneEntityRecord(record)])));
                    recentScheduledWriteValues.delete(field);
                }
                observationGeneration += 1;
                return true;
            }
        };
    };

    const persistHeavyField = async (field: HeavyStorageField, value: unknown) => {
        const database = await openDatabase();
        if (database) {
            try {
                await writeHeavyState(database, field, value);
                markHeavyMigrationComplete(field);
                return;
            } catch (error) {
            }
        }
        writeLocalJson(STORAGE_KEYS[field], value);
        writeLocalText(
            `${storagePrefix}storage_v${STORAGE_SCHEMA_VERSION}_${field}_fallback`,
            Date.now().toString()
        );
    };

    const persistStorageField = async (field: StorageField, value: unknown) => {
        if (blockedWriteReasons.has(field)) {
            throw new Error(
                `Writes to ${field} are blocked because its stored value could not be read safely. Reload the store to retry.`
            );
        }
        if (RECORD_FIELDS.has(field)) {
            const database = await openDatabase();
            if (database) {
                await persistRecordField(database, field as RecordStorageField, value);
                return;
            }
            if (indexedDbOpenFailure) throw indexedDbOpenFailure;
            if (HEAVY_FIELDS.has(field)) {
                await persistHeavyField(field as HeavyStorageField, value);
            } else {
                writeLocalJson(STORAGE_KEYS[field], value);
            }
            return;
        }
        if (field === 'activeDraftId') {
            window.sessionStorage.setItem(STORAGE_KEYS[field], String(value));
            return;
        }
        if (field === 'tutorialLastSeen') {
            writeLocalText(STORAGE_KEYS[field], String(value));
            return;
        }
        writeLocalJson(STORAGE_KEYS[field], value);
    };

    const queueWrite = (write: PendingWrite) => {
        const previous = writeChains.get(write.field) || Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(() => persistStorageField(write.field, write.value));
        writeChains.set(write.field, next);
        unsettledWrites += 1;
        void next.then(() => {
            unsettledWrites -= 1;
        }, error => {
            unsettledWrites -= 1;
            recentScheduledWriteValues.delete(write.field);
            try { write.onError?.(error); } catch { /* The caller owns callback failures. */ }
        });
    };

    const getWriteDelay = (field: StorageField) => {
        if (field === 'drafts') return 300;
        if (field === 'savedNotes') return 250;
        if (field === 'activeDraftId') return 100;
        return 200;
    };

    const scheduleStorageWrite = (
        field: StorageField,
        value: unknown,
        onError?: StorageFailureHandler
    ) => {
        const existing = pendingWrites.get(field);
        if (existing) window.clearTimeout(existing.timer);

        // An identical re-schedule of a value that was just handed to the write
        // chain is an echo of state this tab already persisted (for example, the
        // debounced snapshot effect replaying a critical close-save). Re-running it
        // after the first write resolved would treat pre-merge local data as newer
        // than its own resolved record and clobber concurrent field updates, so it
        // is dropped here. Fresh loads and write failures invalidate this memory.
        const recentValue = recentScheduledWriteValues.get(field);
        if (existing === undefined && recentValue !== undefined && valuesEqual(recentValue, value)) return;
        observationGeneration += 1;
        recentScheduledWriteValues.set(field, value);

        const pending: PendingWrite = {
            field,
            value,
            onError,
            timer: window.setTimeout(() => {
                pendingWrites.delete(field);
                queueWrite(pending);
            }, getWriteDelay(field))
        };
        pendingWrites.set(field, pending);
    };

    const flushStorageWrites = async () => {
        const queued = Array.from(pendingWrites.values());
        pendingWrites.clear();
        queued.forEach(write => {
            window.clearTimeout(write.timer);
            queueWrite(write);
        });
        const results = await Promise.allSettled(Array.from(writeChains.values()));
        return results.every(result => result.status === 'fulfilled');
    };

    const writeStorageText = (field: 'tutorialLastSeen', value: string) => {
        try {
            if (blockedWriteReasons.has(field)) return false;
            writeLocalText(STORAGE_KEYS[field], value);
            observationGeneration += 1;
            return true;
        } catch (error) {
            return false;
        }
    };

    const preserveStorageBackup = async (sourceKey: string, value: unknown) => {
        const legacyBackupKey = `${storagePrefix}securityBackup_v1_${sourceKey}`;
        const localBackup = readLocalTextResult(legacyBackupKey);
        if (localBackup.readError) return false;
        if (localBackup.value !== null) return true;

        const database = await openDatabase();
        if (database) {
            const backupKey = `security-v1:${sourceKey}`;
            try {
                const transaction = database.transaction(BACKUP_STORE, 'readwrite');
                const store = transaction.objectStore(BACKUP_STORE);
                const existing = await requestResult(
                    store.get(backupKey) as IDBRequest<BackupRecord | undefined>
                );
                if (!existing) {
                    store.put({
                        key: backupKey,
                        createdAt: Date.now(),
                        sourceKey,
                        value
                    } satisfies BackupRecord);
                }
                await transactionComplete(transaction);
                return true;
            } catch (error) {
            }
        }

        try {
            writeLocalJson(legacyBackupKey, {
                createdAt: Date.now(),
                sourceKey,
                value
            });
            return true;
        } catch (error) {
            return false;
        }
    };

    /** Return retained recovery copies without automatically restoring any data. */
    const readBackups = async (): Promise<BackupRecord[]> => {
        const database = await openDatabase();
        if (!database && indexedDbOpenFailure) throw new Error('Backup storage could not be read safely.');
        const backups: BackupRecord[] = [];
        if (database) {
            const transaction = database.transaction(BACKUP_STORE, 'readonly');
            const values = await requestResult(transaction.objectStore(BACKUP_STORE).getAll() as IDBRequest<BackupRecord[]>);
            await transactionComplete(transaction);
            backups.push(...values);
        }
        for (let index = 0; index < window.localStorage.length; index += 1) {
            const key = window.localStorage.key(index);
            if (!key || !(key.startsWith(`${storagePrefix}securityBackup_v1_`) || key.startsWith(`${storagePrefix}malformedBackup_v`))) continue;
            const raw = window.localStorage.getItem(key);
            if (raw === null) continue;
            let value: unknown;
            try { value = JSON.parse(raw); } catch { throw new Error('A retained backup is malformed.'); }
            if (!isRecordValue(value) || typeof value.createdAt !== 'number' || typeof value.sourceKey !== 'string' || !Object.hasOwn(value, 'value')) {
                throw new Error('A retained backup has an unsupported format.');
            }
            backups.push({ key, createdAt: value.createdAt, sourceKey: value.sourceKey, value: value.value });
        }
        return structuredClone(backups);
    };

    /** Full record snapshot (including tombstones) for caller-managed replica diffing. */
    const readRecordSnapshots = async (
        field: ReplicaRecordField
    ): Promise<EntityRecordSnapshot[] | null> => {
        const database = await openDatabase();
        if (!database) return null;
        try {
            const transaction = database.transaction([RECORD_STORE,STATE_STORE],'readonly');
            const records = await requestResult(transaction.objectStore(RECORD_STORE).index('field').getAll(field) as IDBRequest<EntityRecord[]>);
            const fences = field === 'savedNotes'
                ? await requestResult(transaction.objectStore(STATE_STORE).getAll(protectionRange()) as IDBRequest<ProtectedNoteRecord[]>) : [];
            const fenced = new Set(fences.map(receipt => receipt.noteId));
            return records.map(record => ({
                entityId: record.entityId,
                revision: record.revision,
                deleted: record.deleted,
                value: record.value ? (structuredClone(record.value) as Record<string, unknown>) : undefined,
                ...(fenced.has(record.entityId) ? { privateWriteFenced: true } : {})
            }));
        } catch (error) {
            return null;
        }
    };

    /**
     * Applies caller-supplied replica changes through the same three-way merge / conflict-copy
     * / tombstone machinery used for concurrent local writes.
     *
     * Rules:
     * - Clean fast-forward: local equals base → adopt remote.
     * - Diverged: three-way field merge; unresolved contention preserves the local
     *   side as a user-visible conflict copy before adopting the merged result.
     * - Delete vs edit: the edit is never silently destroyed — it survives as a
     *   conflict copy; the tombstone still lands.
     * - Remote edits of a locally deleted note are NEVER auto-resurrected; they are
     *   preserved as conflict copies (mirrors draft-resurrection gating).
     * - Unknown ancestor (no acked base): any divergence preserves both sides.
     */
    const applyReplicaChanges = async (
        field: ReplicaRecordField,
        changes: ReplicaChange[],
        options: ReplicaApplyOptions = {}
    ): Promise<ReplicaApplyResult> => {
        const { signal } = options;
        const throwIfAborted = () => {
            if (!signal?.aborted) return;
            throw signal.reason ?? new DOMException('The remote apply was aborted.', 'AbortError');
        };

        throwIfAborted();
        const result: ReplicaApplyResult = { applied: [], conflicts: [], skipped: [] };
        if (changes.length === 0) return result;
        const database = await openDatabase();
        throwIfAborted();
        if (!database) {
            // Fail closed: without IndexedDB there is no safe way to apply remote data.
            throw new Error('IndexedDB is unavailable; remote changes were not applied.');
        }
        if (blockedWriteReasons.has(field)) {
            throw new Error(`Writes to ${field} are blocked; remote changes were not applied.`);
        }

        const transaction = database.transaction([RECORD_STORE,STATE_STORE], 'readwrite');
        const store = transaction.objectStore(RECORD_STORE);
        const written = new Map<string, EntityRecord>();
        const abortTransaction = () => {
            try {
                transaction.abort();
            } catch {
                // The commit or an earlier abort may already have made the transaction inactive.
            }
        };
        signal?.addEventListener('abort', abortTransaction, { once: true });

        try {
            throwIfAborted();
            const currentRecords = await requestResult(
                store.index('field').getAll(field) as IDBRequest<EntityRecord[]>
            );
            throwIfAborted();
            const currentById = new Map(currentRecords.map(record => [record.entityId, cloneEntityRecord(record)]));
            const fences = field === 'savedNotes'
                ? await requestResult(transaction.objectStore(STATE_STORE).getAll(protectionRange()) as IDBRequest<ProtectedNoteRecord[]>) : [];
            const fenced = new Set(fences.map(receipt => receipt.noteId));
            const now = Date.now();

            const writeRecord = (entityId: string, revision: number, order: number, entityValue: Record<string, unknown> | undefined, deleted: boolean) => {
                const record: EntityRecord = {
                    key: getEntityKey(field, entityId),
                    field,
                    entityId,
                    revision,
                    updatedAt: now,
                    writerId,
                    deleted,
                    order,
                    value: entityValue ? structuredClone(entityValue) : undefined
                };
                written.set(entityId, record);
                store.put(record);
            };

            const preserveConflictCopy = (candidate: Record<string, unknown>, originalId: string) => {
                const conflict = createConflictValue(candidate, originalId);
                const title = typeof candidate.title === 'string' && candidate.title.trim()
                    ? candidate.title
                    : typeof candidate.name === 'string' && candidate.name.trim()
                        ? candidate.name
                        : originalId;
                result.conflicts.push(title);
                writeRecord(conflict.entityId, 1, currentById.size + written.size + 1, conflict.value, false);
            };

            for (const change of changes) {
                throwIfAborted();
                if (fenced.has(change.entityId)) { result.skipped.push(change.entityId); continue; }
                const current = currentById.get(change.entityId) ?? written.get(change.entityId);
                const remoteValue = change.remoteValue;
                if (change.remoteDeleted || !remoteValue) {
                    if (!current) {
                        result.skipped.push(change.entityId);
                        continue;
                    }
                    if (current.deleted) {
                        result.skipped.push(change.entityId);
                        continue;
                    }
                    const hasKnownBase = change.baseValue !== undefined && change.baseDeleted === false;
                    const diverged = hasKnownBase ? !valuesEqual(current.value, change.baseValue) : true;
                    if (diverged && current.value) preserveConflictCopy(current.value, change.entityId);
                    writeRecord(change.entityId, current.revision + 1, current.order, undefined, true);
                    result.applied.push(change.entityId);
                    continue;
                }

                if (!current) {
                    writeRecord(change.entityId, 1, currentById.size + written.size + 1, remoteValue, false);
                    result.applied.push(change.entityId);
                    continue;
                }
                if (current.deleted) {
                    // Never resurrect a tombstone from a remote edit; keep both sides.
                    preserveConflictCopy(remoteValue, change.entityId);
                    result.skipped.push(change.entityId);
                    continue;
                }

                const hasBase = change.baseValue !== undefined && change.baseDeleted !== true;
                if (!hasBase) {
                    if (valuesEqual(current.value, remoteValue)) {
                        result.skipped.push(change.entityId);
                        continue;
                    }
                    if (current.value && !organizationOnlyDifferences(current.value, remoteValue)) {
                        preserveConflictCopy(current.value, change.entityId);
                    }
                    writeRecord(change.entityId, current.revision + 1, current.order, remoteValue, false);
                    result.applied.push(change.entityId);
                    continue;
                }

                if (valuesEqual(current.value, remoteValue)) {
                    result.skipped.push(change.entityId);
                    continue;
                }

                const baseForMerge = change.baseValue ?? {};
                if (valuesEqual(current.value, baseForMerge)) {
                    writeRecord(change.entityId, current.revision + 1, current.order, remoteValue, false);
                    result.applied.push(change.entityId);
                    continue;
                }
                if (!current.value || !baseForMerge) {
                    if (current.value) preserveConflictCopy(current.value, change.entityId);
                    writeRecord(change.entityId, current.revision + 1, current.order, remoteValue, false);
                    result.applied.push(change.entityId);
                    continue;
                }
                const merged = mergeRecordValues(baseForMerge, current.value, remoteValue);
                if (merged.conflictingKeys.length > 0) preserveConflictCopy(current.value, change.entityId);
                if (!valuesEqual(merged.merged, current.value)) {
                    writeRecord(change.entityId, current.revision + 1, current.order, merged.merged, false);
                    result.applied.push(change.entityId);
                } else {
                    result.skipped.push(change.entityId);
                }
            }

            throwIfAborted();
            await transactionComplete(transaction);
        } catch (error) {
            if (signal?.aborted) throwIfAborted();
            throw error;
        } finally {
            signal?.removeEventListener('abort', abortTransaction);
        }

        if (written.size > 0) {
            const known = knownRecords.get(field);
            if (known) {
                for (const [entityId, record] of written) known.set(entityId, cloneEntityRecord(record));
            }
            publishStorageChange(
                { fields: [field], conflicts: result.conflicts },
                true
            );
        }
        return result;
    };

    /** Freeze an existing original locally; later conflicting content is kept separately.
     * This is a persistence guard, not an authentication or access-control boundary. */
    const protectNote = async (snapshot: Record<string, unknown>) => {
        if (typeof snapshot.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(snapshot.id)) throw new TypeError('A valid note id is required.');
        if (!await flushStorageWrites()) throw new Error('Pending writes must succeed before protecting a note.');
        const database = await openDatabase();
        if (!database) throw new Error('IndexedDB is required to protect a note.');
        const transaction = database.transaction([STATE_STORE, RECORD_STORE], 'readwrite');
        const state = transaction.objectStore(STATE_STORE);
        const prior = await requestResult(state.get(protectionKey(snapshot.id)) as IDBRequest<ProtectedNoteRecord | undefined>);
        if (prior) { await transactionComplete(transaction); return; }
        const records = transaction.objectStore(RECORD_STORE);
        const draft = await requestResult(records.get(getEntityKey('drafts', snapshot.id)) as IDBRequest<EntityRecord | undefined>);
        const saved = await requestResult(records.get(getEntityKey('savedNotes', snapshot.id)) as IDBRequest<EntityRecord | undefined>);
        const current = draft && !draft.deleted ? draft : saved && !saved.deleted ? saved : undefined;
        if (!current?.value || current.value.trashedAt || !valuesEqual(current.value.data, snapshot.data)) {
            throw new Error('The note changed before protection. Reload and retry.');
        }
        state.put({ key: protectionKey(snapshot.id), noteId: snapshot.id, snapshot: structuredClone(snapshot) } satisfies ProtectedNoteRecord);
        await transactionComplete(transaction);
        publishStorageChange({ fields: ['savedNotes', 'drafts'], conflicts: [] }, true);
    };
    const isNoteProtected = async (noteId: string) => {
        const database = await openDatabase();
        if (!database) throw new Error('IndexedDB is required to inspect note protection.');
        return !!await requestResult(database.transaction(STATE_STORE, 'readonly').objectStore(STATE_STORE).get(protectionKey(noteId)));
    };

    let initialized = false;
    let closing = false;
    let closed = false;
    const subscriptions = new Set<() => void>();
    const operations = new Set<Promise<unknown>>();
    const assertOpen = () => { if (closed || closing) throw new Error('This store is closed or closing.'); };
    const assertField = (field: StorageField) => {
        if (typeof field !== 'string' || !Object.hasOwn(STORAGE_KEYS, field)) throw new TypeError('Unknown storage field.');
    };
    const run = <T>(task: () => Promise<T>): Promise<T> => {
        assertOpen();
        const operation = task();
        operations.add(operation);
        void operation.then(() => operations.delete(operation), () => operations.delete(operation));
        return operation;
    };
    const copyValue = (value: unknown): unknown => {
        if (value === undefined) throw new TypeError('A root value is required.');
        const visiting = new WeakSet<object>();
        const validate = (item: unknown, inArray = false): void => {
            if (item === undefined && !inArray) return; // Optional object fields follow JSON omission semantics.
            if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
            if (typeof item === 'number' && Number.isFinite(item)) return;
            if (typeof item !== 'object' || item === null) throw new TypeError('Only JSON-compatible values are supported.');
            if (visiting.has(item)) throw new TypeError('Cyclic values are not supported.');
            const prototype = Object.getPrototypeOf(item);
            if (!Array.isArray(item) && prototype !== null && Object.getPrototypeOf(prototype) !== null) throw new TypeError('Only plain objects and arrays are supported.');
            if (Object.getOwnPropertySymbols(item).length) throw new TypeError('Symbol keys are not supported.');
            visiting.add(item);
            if (Array.isArray(item)) {
                for (let i = 0; i < item.length; i += 1) {
                    if (!Object.hasOwn(item, i)) throw new TypeError('Sparse arrays are not supported.');
                    validate(item[i], true);
                }
            } else for (const key of Object.keys(item)) validate((item as Record<string, unknown>)[key]);
            visiting.delete(item);
        };
        validate(value);
        return structuredClone(value);
    };
    const close = async () => {
        if (closed) return;
        if (closing) throw new Error('This store is already closing.');
        closing = true;
        try {
            await Promise.allSettled(Array.from(operations));
            if (!await flushStorageWrites()) throw new Error('Writes failed. Retry the pending values before closing.');
            for (const unsubscribe of subscriptions) unsubscribe();
            subscriptions.clear();
            syncChannel?.close();
            const database = await databasePromise;
            database?.close();
            closed = true;
        } finally { closing = false; }
    };
    return Object.freeze({
        databaseName: DATABASE_NAME,
        keys: STORAGE_KEYS,
        load: () => run(async () => { const snapshot = await loadStorageSnapshot(); initialized = true; return snapshot; }),
        stage: () => run(async () => { const staged = await stageStorageSnapshot(); return { snapshot: staged.snapshot, accept: () => { assertOpen(); return staged.accept(); } }; }),
        schedule: (field: StorageField, value: unknown, onError?: StorageFailureHandler) => {
            assertOpen(); assertField(field);
            if (RECORD_FIELDS.has(field)) {
                if (!initialized) throw new Error('Load the store before scheduling record writes.');
                if (field === 'appSettings') {
                    if (!isRecordValue(value)) throw new TypeError('appSettings must be an object.');
                } else {
                    if (!Array.isArray(value) || value.some(item => !isRecordValue(item) || typeof item.id !== 'string' || !item.id) || new Set(value.map(item => item.id)).size !== value.length) {
                        throw new TypeError('Record arrays require unique nonempty string ids.');
                    }
                }
            } else if (typeof value !== 'string') throw new TypeError('Text fields require strings.');
            scheduleStorageWrite(field, copyValue(value), onError);
        },
        flush: () => run(flushStorageWrites),
        subscribe: (handler: StorageChangeHandler, options?: StorageChangeSubscriptionOptions) => {
            assertOpen();
            if (typeof handler !== 'function') throw new TypeError('A change handler is required.');
            const unsubscribe = subscribeToStorageChanges(handler, options);
            const remove = () => { unsubscribe(); subscriptions.delete(remove); };
            subscriptions.add(remove);
            return remove;
        },
        authorizeDraftResurrection: (id: string, intent?: 'open' | 'continue') => { assertOpen(); authorizeDraftResurrection(id, intent); },
        cancelDraftResurrection: (id: string) => { assertOpen(); cancelDraftResurrection(id); },
        preserveBackup: (key: string, value: unknown) => run(() => preserveStorageBackup(key, copyValue(value))),
        readBackups: () => run(readBackups),
        writeText: (field: 'tutorialLastSeen', value: string) => {
            assertOpen(); if (field !== 'tutorialLastSeen' || typeof value !== 'string') throw new TypeError('Invalid text field/value.');
            return writeStorageText(field, value);
        },
        readRecordSnapshots: (field: ReplicaRecordField) => {
            assertOpen(); if (field !== 'savedNotes' && field !== 'folders') throw new TypeError('Invalid replica field.');
            return run(() => readRecordSnapshots(field));
        },
        applyReplicaChanges: (field: ReplicaRecordField, changes: ReplicaChange[], options?: ReplicaApplyOptions) => {
            assertOpen(); if (field !== 'savedNotes' && field !== 'folders') throw new TypeError('Invalid replica field.');
            if (!Array.isArray(changes) || new Set(changes.map(change => change?.entityId)).size !== changes.length || changes.some(change =>
                !isRecordValue(change) || typeof change.entityId !== 'string' || !change.entityId || typeof change.remoteDeleted !== 'boolean' ||
                (change.baseDeleted !== undefined && typeof change.baseDeleted !== 'boolean') ||
                [change.remoteValue, change.baseValue].some(value => value !== undefined && (!isRecordValue(value) || value.id !== change.entityId)) ||
                (!change.remoteDeleted && change.remoteValue === undefined))) throw new TypeError('Invalid or duplicate replica changes.');
            if (!initialized) throw new Error('Load the store before applying replica changes.');
            return run(() => applyReplicaChanges(field, copyValue(changes) as ReplicaChange[], options));
        },
        protectNote: (snapshot: Record<string, unknown>) => run(() => protectNote(copyValue(snapshot) as Record<string, unknown>)),
        isNoteProtected: (id: string) => run(() => isNoteProtected(id)),
        close
    });
}
export type NotebookStore = ReturnType<typeof createNotebookStore>;
