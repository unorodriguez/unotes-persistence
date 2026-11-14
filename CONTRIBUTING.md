# Contributing

Report ordinary bugs and propose focused changes through this library's [issues](https://github.com/unorodriguez/unotes-persistence/issues) and pull requests. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Contributions to project software are under the [MIT License](LICENSE); submit only material you are authorized to license under those terms. No separate CLA or copyright assignment is requested.

Use Node 24+, run `npm ci --ignore-scripts`, then `npm run verify`. Keep `package-lock.json` and the deterministic development-license inventory consistent. Use focused tests while iterating; run the complete standalone gate on the final candidate. Changes to storage schema, namespaces, migration, backup or merge behavior need a compatibility/recovery explanation and meaningful regression coverage. Do not weaken assertions, hide failures or increase timeouts to manufacture a pass.

Use synthetic notebook records and a unique local namespace/origin. Never attach real notes, browser profiles, env files, account data, payment images or credentials. A minimal reproduction should include the library version, browser/runtime, IndexedDB availability, method calls and observed versus expected behavior.

The library and maintained Unotes product remain AI-free. AI-assisted developer tooling is allowed; describe assistance honestly and check generated code for applicable upstream licenses. Do not claim AI-assisted output was entirely handwritten or universally original. Submit only material you are authorized to contribute; preserve identified third-party notices. New AI product features, authentication, cloud services and the full Unotes UI are outside this library's scope.

The planned maintainer workflow is small reviewed changes, regression tests, explicit compatibility notes and release tags only after local/public CI gates. No release cadence or response-time promise is made. npm publishing remains disabled. This repository does not authorize changes to the private Unotes application or production services.
