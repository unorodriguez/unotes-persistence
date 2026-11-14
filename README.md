# Unotes Persistence

A small browser-local persistence library derived from Unotes: namespaced IndexedDB records, migration backups, revision-aware merges, deletion tombstones, and conflict copies for notebook-shaped data.

**Standalone library source under the [MIT License](LICENSE). Not published to npm.** This is not the complete Unotes application. It includes no artwork, account service, hosted Sync engine, collaboration, publication service, Cloudflare configuration, or AI service. Codex assisted development; no AI feature is embedded in the library.

## Install and verify from source

Use Node.js 24 or newer and npm. Verification was developed for Node 24; browser support is described below. Clone the source, then run:

```sh
git clone https://github.com/unorodriguez/unotes-persistence.git
cd unotes-persistence
npm ci --ignore-scripts
npm run verify
npm pack --ignore-scripts
```

The lockfile pins the development toolchain. The library has **zero runtime dependencies**. Installation uses public npm packages, not private Unotes infrastructure. `--ignore-scripts` prevents dependency lifecycle scripts; none is required by this verification setup.

A local consumer can install the generated tarball:

```sh
npm install /absolute/path/unotes-persistence-0.0.0-preparation.1.tgz
```

Do not run `npm install unotes-persistence` expecting this candidate: no registry publication is claimed. The package exposes ESM JavaScript and TypeScript declarations through its root export; CommonJS is not provided. No `prepare`/`postinstall` script builds or changes a consumer's environment.

## Minimal browser example

```ts
import { createNotebookStore } from 'unotes-persistence';

const store = createNotebookStore({ namespace: 'my-notebook' });
const snapshot = await store.load();
if (snapshot.readFailures.length) throw new Error('Storage needs recovery before editing.');

store.schedule('savedNotes', [{
  id: 'example-note',
  title: 'A synthetic note',
  data: { html: '<p>Hello</p>', images: [], drawingDataUrl: null }
}]);
if (!await store.flush()) throw new Error('Keep the unsaved input and offer retry.');

console.log((await store.load()).savedNotes);
await store.close();
```

See the [source example](https://github.com/unorodriguez/unotes-persistence/blob/main/examples/notebook.ts). This replaces the **entire savedNotes list**: omitted existing identities become tombstones. For an existing notebook, edit a loaded snapshot rather than constructing a one-record replacement. HTML is opaque data, not sanitized or safe to insert into a document; sanitize at your rendering boundary.

## Storage and namespace contract

`namespace` is required: 1–64 lowercase ASCII letters/digits/hyphens, beginning with a letter. Database names are always `unotes-persistence:<namespace>` and local/session storage keys use that prefix too. Change notifications are scoped to the same namespace. There is no database-name override or automatic access to `unotes-storage`, `mnp_*`, or Unotes' unprefixed tutorial key. No original application data is imported automatically.

A namespace identifies one notebook on the **current origin**. Instances of the same namespace/origin share records; different namespaces do not. This is collision avoidance, not encryption or an authentication boundary. Other scripts on that origin and browser extensions may access the data. Use a separate origin for untrusted applications. Changing namespace/origin starts a different notebook; it does not migrate data.

Call `load()` before scheduling record writes or applying replica changes. It establishes merge ancestry and reports `readFailures`. During editing, prefer `stage()` to adopt a refreshed snapshot and its ancestry together; see [API and recovery](docs/API.md).

## What is preserved

- IndexedDB version 2 with `state`, `records`, and `backups` stores; transaction-level revisions and conflict handling.
- Migration from aggregate JSON/state into record storage **within this namespace**, preserving legacy or malformed originals before removal/replacement.
- Durable deletion tombstones and named conflict copies for competing content changes; disjoint field edits merge.
- Explicit draft reopening/continued-edit intent, protected-original write fences, deterministic ordering helpers and caller-supplied replica merges.
- A localStorage fallback when IndexedDB is genuinely unsupported; ambiguous open/read failures block writes instead of assuming empty data.

This remains a notebook-oriented model: `savedNotes`, `drafts`, `folders`, `explorer`, `appSettings`, `activeDraftId`, and `tutorialLastSeen`. It is not an arbitrary database, CRDT, editor, complete sync protocol or account-partition manager. Replica merging performs no network requests and provides no remote authorization, cursors, outbox or delivery guarantee.

## Failure and data limits

`schedule()` is debounced and not durable acknowledgement. Keep unsaved values until `flush()` succeeds; write failures also reach the optional callback. Failed values are not an autonomous retry queue. `close()` waits for started operations, flushes and releases this instance's connections/listeners; it rejects on failed writes so the caller can retain/retry input. Flush explicitly before navigation; abrupt browser/OS termination can interrupt work.

Records require unique nonempty string IDs and plain JSON-compatible data. Binary objects, Dates, cyclic values, sparse arrays and nonfinite numbers are rejected on new writes. Optional object properties with `undefined` follow JSON omission semantics. Array order is meaningful. This package does not sanitize content, enforce a quota, compress/encrypt data, or resolve every application-level conflict.

The localStorage fallback lacks IndexedDB's transaction/revision protection and can lose concurrent-tab updates. Do not promise multi-tab merge safety in fallback mode. Browser quota, storage eviction/private browsing and clearing site data can remove local content. Recovery copies are on-device and are not an off-device backup or verified restore drill. Tombstones and recovery copies are retained; no automatic garbage collection or destructive wipe helper is provided.

## Environments and evidence

Runtime requires a browser Window, modern `structuredClone`, localStorage/sessionStorage and timers. IndexedDB is preferred; IDBKeyRange is needed by protection/replica operations. BroadcastChannel is optional; storage events are a fallback signal. Importing the ESM package in Node does not open storage, but creating a store without a Window is rejected. Worker/SSR store construction is unsupported.

The standalone regression suite uses jsdom and fake-indexeddb. Focused real Chromium/WebKit checks are available in [browser acceptance](docs/BROWSER_ACCEPTANCE.md), using fresh contexts and synthetic data. These checks do not establish physical Safari/iPhone, real quota exhaustion/eviction or blocked-upgrade UX acceptance. The optional browser tooling is separate from package dependencies and the CI gate.

The standalone library's own software and documentation are licensed under MIT, to the extent licensing rights exist. Copyright (c) 2026 unorodriguez. npm publishing remains disabled. Third-party tools retain their own terms; see [notices](THIRD_PARTY_NOTICES.md) and [source provenance](docs/PROVENANCE.md). No private Unotes application, artwork, branding assets or infrastructure is included.

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). No established outside adoption, download count, contributor community, npm availability or response SLA is claimed. See the security policy for the verified disclosure route and its limitations.
