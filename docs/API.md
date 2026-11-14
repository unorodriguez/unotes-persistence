# API, storage model and recovery

## Notebook-shaped records

`createNotebookStore({ namespace })` has no network, module-global database connection, account or service dependency. Instance state includes its own writer ID, merge ancestors, pending writes, read-failure blocks and notification subscriptions.

Array fields (`savedNotes`, `drafts`, `folders`, `explorer`) contain plain objects with unique nonempty string `id` values. `appSettings` is an object. `activeDraftId` and `tutorialLastSeen` are strings when written. Snapshots return unknown payloads because content validation belongs to the consumer. Local `data`, `title`, `name`, `folderId`, `parentId`, `orderKey`, `trashedAt`, `lastOpened`, `totalTime` and `sessions` have inherited notebook-specific merge semantics; do not assume arbitrary object merging is equivalent.

The smallest note can be `{ id: 'n', title: 'Example', data: { html: '<p>text</p>' } }`. HTML/media are stored as opaque JSON values; neither HTML safety nor image ownership is established. No binary attachment store is included. Unsupported new input types are rejected, rather than silently converted to strings.

## Methods

| Method | Contract |
| --- | --- |
| `load()` | Read/migrate this namespace and adopt record revisions. Check `readFailures` before editing. Must precede record scheduling/replica application. Calling during unsaved editing can change merge ancestry; use `stage()` for a UI refresh. |
| `stage()` | Returns `{ snapshot, accept }`. Adopt the UI snapshot only if `accept()` succeeds; it is single-use and rejects adoption after pending/in-flight/local changes invalidate the observation. Acceptance after close throws. |
| `schedule(field, value, onError?)` | Clone and debounce a whole-field replacement. Omitted IDs mean deletion. Does not acknowledge persistence. Errors are surfaced to the callback and `flush`; callbacks are not authority to change stored content. |
| `flush()` | Flush pending writes and wait for this instance's queued field chains. `true` means those writes fulfilled; `false` requires retaining/retrying unsaved values. It is not a server acknowledgement or off-device durability promise. |
| `subscribe(handler, { includeLocalCommits? })` | Local/peer invalidations containing fields/conflict titles. Unsubscribe explicitly or close. Messages are signals, not a security/authentication boundary. Observer failures cannot turn successful writes into failed commits. |
| `authorizeDraftResurrection(id, 'open' or 'continue')` | One-use explicit reopening/continued-edit intent. Existing saved-note deletion/Trash and protected-original fences still win. Do not grant for background stale callbacks. |
| `cancelDraftResurrection(id)` | Withdraw an unconsumed authorization. |
| `preserveBackup(sourceKey, value)` | First-copy-wins recovery slot; boolean indicates an existing slot or storage acceptance. It does not establish that an older copy equals the new input or prove restore usability. |
| `readBackups()` | Return retained IndexedDB and namespaced localStorage recovery records, cloned. Malformed/inaccessible recovery data rejects rather than falsely reporting no backups. Inspect and export originals before choosing a restoration. No automatic restore/deletion occurs. |
| `readRecordSnapshots('savedNotes' or 'folders')` | Local revisions, tombstones and payloads for caller-managed replica diffing; `null` if unavailable. A protected original carries `privateWriteFenced`. No server/outbox/cursor is included. |
| `applyReplicaChanges(field, changes, { signal? })` | Transactional local application of explicit trusted replica values/ancestors. Validates identities and rejects duplicate IDs. Abort rolls back a live transaction. Does not validate remote authorization or authenticate a caller. |
| `protectNote(snapshot)` | Persist a local write fence only if the existing note data matches. Changed stale content becomes a conflict copy. No account or remote transition is involved. Protection is durable; there is no release/unprotect API in this candidate. |
| `isNoteProtected(id)` | Inspect a local fence; rejects if IndexedDB cannot establish the answer. |
| `writeText('tutorialLastSeen', string)` | Immediate small-field write with a boolean result. Retained for compatibility with the notebook model, not a generic arbitrary-key writer. |
| `close()` | Reject new work, await started async operations, flush, unsubscribe and close the connection/channel. Rejects failed writes and permits caller retry. A subsequent call after successful close is harmless. |

`keys` and `databaseName` expose this instance's read-only names for diagnostics/manual controlled migration. They never equal Unotes' production storage names. There is no option to set arbitrary database/key names.

## Replica change format

A change has `entityId`, `remoteDeleted`, optional `remoteValue`, `baseValue`, and `baseDeleted`. Nondeleted values must contain a matching `id`. Input is caller-supplied plain data. Field names retain the original remote/base terminology, but the function itself performs only local transactions. Clean values fast-forward; disjoint edits merge; contested content is kept separately; tombstones do not silently resurrect. Competing organization fields prefer the committed value. Unknown ancestors conservatively preserve divergent content. Tombstones/recovery records remain until the consumer makes a separately designed retention decision.

## Ordering

`validOrderKey`, `orderKeyForId`, `compareNotes`, `compareFolders`, `placeInOrder` and `canMoveFolder` derive from the existing manual-order implementation. Comparator types include only the needed ordering fields. `placeInOrder` returns copies with ranked keys and does not mutate content. `canMoveFolder` intentionally enforces the inherited root-plus-one-subfolder model; it is not an arbitrary-depth tree algorithm.

## Compatibility boundaries

The schema remains v2 inside the **new** namespace. Namespaced aggregate JSON/state migrates to records with backups and verification before old heavy keys are removed. There is no import from the live application's keys, no production upgrade and no backwards-compatible replacement package claim. Future releases must retain schema/namespace compatibility or design an explicit migration. Renaming the namespace silently starts empty storage, so persist that configuration deliberately.

This candidate does not enforce browser storage limits or guarantee cross-tab revision safety in localStorage fallback. There is no encryption or atomic coordination with external systems. A developer must keep an independently usable export/backup for valuable user content; inspecting a recovery record is not a verified disaster-recovery drill.
