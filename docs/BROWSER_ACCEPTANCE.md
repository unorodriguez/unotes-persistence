# Focused browser acceptance

`scripts/browser-acceptance.mjs` serves only the compiled library on a temporary loopback port and creates a fresh non-persistent browser context per scenario. It never opens a user's profile or live Unotes storage. Browser-page requests are restricted to that loopback server. No production server or credentials are needed.

Run this harness from a source checkout (tests/scripts are not in the consumer tarball). Build first. Point `PLAYWRIGHT_MODULE` to an existing `playwright-core/index.mjs` installation in a separate tooling directory, `CHROMIUM_EXECUTABLE` to an installed compatible Chrome/Chromium, and `PLAYWRIGHT_BROWSERS_PATH` to an existing compatible WebKit cache. The runner downloads nothing. Check disk space before installing any optional driver or browsers. Optional browser tooling is not a package/runtime dependency and is not redistributed.

```sh
npm run build
PLAYWRIGHT_MODULE=/path/to/tooling/node_modules/playwright-core/index.mjs \
CHROMIUM_EXECUTABLE=/path/to/chromium \
PLAYWRIGHT_BROWSERS_PATH=/path/to/browser-cache \
node scripts/browser-acceptance.mjs
```

The driver and cache must match. `BROWSER_ENGINES=chromium` selects one engine; the default requires both Chromium and WebKit and fails if either cannot launch. No automatic skips, retries, downloads or timeout inflation are used.

Seven scenarios per engine cover namespace separation/reload persistence; namespaced migration/malformed-original retention; backup inspection and explicit restore after reload; cross-page competing revisions; cross-page deletion/tombstones; injected IndexedDB write failures; and injected fallback quota failures. Failure tests assert failed acknowledgement, error notification and preservation of previously committed data, then explicitly reschedule after removing the fault.

These are focused desktop-engine checks, not full Safari/iPhone acceptance. Quota exceptions are injected at browser storage APIs; real disk exhaustion, eviction, abrupt termination, blocked upgrade UX and physical devices are not established. Unit tests use jsdom/fake-indexeddb and remain separately required. The optional browser runner is not part of the current CI workflow.
