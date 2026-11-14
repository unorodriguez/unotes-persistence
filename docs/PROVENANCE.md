# Source provenance and rights review

## Technical source boundary

Derived from Unotes release `724b3dfaeab4ee8f7c261f432518eecfc5f2e64e`:

- `frontend/services/storage.ts`: local IndexedDB/localStorage/session storage, migration/backups, record merge/tombstones, notifications, staging, draft intent, local replica application and write-fence safeguards.
- `frontend/utils/manualOrder.ts`: all existing ordering/hierarchy helpers.
- `frontend/types.ts`: only structural fields needed by ordering comparators, reduced to `NoteOrderItem` and `FolderOrderItem`.
- `frontend/services/storage.test.ts`, `frontend/services/storage.syncApply.test.ts`, `frontend/utils/manualOrder.test.ts`, and `frontend/test/helpers/makeNote.ts`: synthetic regression tests/fixture. All 53 baseline cases remain; API/namespace/initialization and two replica fixture dependencies are adapted. No assertion was removed to hide a failure.

Source object/hash receipts are retained in the owner's local review records; no original Git history, author emails or private operational report is copied into this candidate. Storage source is present from initial reachable `cf019a4`; later storage/test changes are recorded in project commits including concurrency, recovery and ordering work. Manual ordering entered at `a577c46`. This establishes repository provenance, not independent proof of originality.

No selected file contained an external license/copyright header, upstream attribution, copied-template marker or external implementation reference. The reviewed history/implementation did not identify an incorporated external project in this boundary. Browser storage APIs, three-way comparison and ranking primitives are not by themselves proof of copied implementation. No global similarity/copyright search or legal certification is claimed.

Known Google 2025 Apache-2.0 files (`backend/server.js` and the Vertex interceptor), all application assets/fonts, the full UI, real accounts, Cloudflare services, publication and collaboration state machinery are **excluded**. A minimal local protection record replaces account/operation/CRDT conversion receipts; the replica merge primitive has no Sync server dependency. The two baseline replica tests now use explicitly sorted synthetic data with an empty compatibility field, not the private Sync envelope validator; their merge assertions remain.

## Owner-reported contributor history

The owner reports being Unotes' creator and lead developer, directing OpenAI Codex to generate/modify much of the implementation through requirements, design decisions, testing feedback and release instructions. As far as the owner knows, no other human developer contributed code. This candidate does not claim the owner personally handwrote all code.

Codex is developer tooling, not a separate human contributor. Based on this owner statement and the selected-file evidence, **no additional human contributor permission has been identified as necessary for this boundary**. The earlier broad concern based on public developer credits is not evidence of an actual code contribution. No new permission from a credited person is demanded without source-specific evidence. A later identified third-party contribution would need its actual rights reviewed.

## OpenAI output terms and limits

Official terms checked 14 November 2026:

- [Terms of Use](https://openai.com/policies/terms-of-use/) (effective January 1, 2026), Content: assigns OpenAI's rights, if any, in output to the user as between those parties and to the extent law permits; also explains similar output and third-party limits.
- [Services Agreement](https://openai.com/policies/services-agreement/) (effective January 1, 2026), section 4: the business/API route likewise assigns OpenAI's output rights, if any, to its customer and leaves input/output responsibility with that customer.
- [Service Terms](https://openai.com/policies/service-terms/) (updated November 13, 2026), Codex and Code Generation: generated code may be subject to third-party licenses.

These support redistribution of rights actually available under the applicable agreement; they do not make every generated line copyrightable, certify originality, clear third-party material, or establish another person's rights. The actual account/contract route and any special agreement were not inspected. No separate OpenAI human-contributor permission is identified by these terms. No claim is made that these output terms license the Codex tooling itself for copying into this project; no tooling source is included.

The owner explicitly approved MIT for this standalone library with Copyright (c) 2026 unorodriguez. This covers rights held in its own software and documentation; third-party terms and excluded private application assets remain separate. No specific outside author/assignment problem or incorporated restricted snippet was established in the selected code. The test toolchain has independent third-party grants/evidence and is not bundled into runtime output. No legal opinion on jurisdiction-specific copyright eligibility or patent clearance is claimed.

## Extraction behavior changes

1. Required namespace, fixed safe prefix and per-instance state replace live application keys/module globals. Existing Unotes data is never automatically read. No same-database compatibility is claimed.
2. The public API requires initialization before record replacement, clones scheduled values, rejects malformed/duplicate identities and unsupported value types, and supports explicit close/recovery inspection.
3. Local note protection keeps the original write-fence invariant without account/room/conversion state. Local replica merging remains; network delivery and server authorization do not.
4. Own-property/null-prototype three-way assembly preserves `__proto__` data safely. Observer exceptions are isolated from durable commit results. Implicit console logging is removed to avoid leaking malformed stored content. Backup preservation returns a truthful boolean; inspection never automatically restores it.
5. Core schema v2, aggregate-to-record migration/backups, tombstones, field-merge/conflict semantics and ordering algorithms remain. A failed harness experiment preloaded data before a one-shot read-error regression; it was replaced by explicit initialization in relevant fixtures, preserving the original error assertion.

The adaptations belong only to this standalone library. The Unotes 1.11.0 source, storage and production deployment remain unchanged.
