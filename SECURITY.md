# Security policy

## Reporting a vulnerability

Use [GitHub Private Vulnerability Reporting](https://github.com/unorodriguez/unotes-persistence/security/advisories/new) for this repository. Open **Security → Advisories → Report a vulnerability** and sign in to GitHub. Do not disclose sensitive vulnerabilities in public issues. No public email address, bounty or response-time guarantee is offered.

PVR enablement, the public reporting entry point and owner administrative access to the private advisory inbox were verified on 2026-11-14. Repository notification watching is enabled. On 2026-11-14, the owner confirmed that account-level notification delivery is enabled and that private reports will be monitored and answered. This delivery-setting confirmation is owner-verified. No fabricated vulnerability was submitted and no end-to-end report/delivery/reply test is claimed.

Provide the affected source commit or package version, browser/version, impact, prerequisites and a minimal synthetic reproduction. Do not include real notebooks, personal data, credentials or production infrastructure. The maintainer reviews reports privately, reproduces with synthetic data, assesses affected versions and coordinates fixes/disclosure with the reporter. For ordinary non-sensitive bugs, use [issues](https://github.com/unorodriguez/unotes-persistence/issues).

If the private reporting form is unavailable, do not post exploit details publicly. A public issue may state only that the private reporting route is unavailable and request its repair, without vulnerability details.

## Supported versions

This is an early source-only project. Security fixes are considered for the latest main-branch source; no stable release or npm package has been published. The manifest's `0.0.0-preparation.1` identifies the current early candidate, not a stable support commitment. Include the exact commit when reporting a problem.

## Storage limits and scope

This is origin-local storage, not a security sandbox. It provides no accounts, encryption, HTML sanitization, remote authorization or off-device backups. Sanitize untrusted stored HTML before rendering. Same-origin scripts/extensions may read or change data; `protectNote` is a write guard, not access control. Quota, eviction and site-data clearing may remove notebooks and recovery copies. The localStorage fallback has no transactional multi-tab safety guarantee.

Tests use synthetic data and isolated storage. No private Unotes access or production resources are needed. Do not send notebook contents to AI services for bug reports or automated review. The library has no AI integration, telemetry or runtime network calls.

## Maintaining private intake

The maintainer must keep PVR enabled and repository security notifications monitored. Verify the actual repository's status through its Advanced Security settings or the read-only `GET /repos/unorodriguez/unotes-persistence/private-vulnerability-reporting` endpoint. Account-level delivery preferences are separate from repository watching; review them in personal notification settings. Do not advertise a replacement route until it is verified, and do not create fabricated advisories to test it.

References: [GitHub PVR configuration and notifications](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository), [reporting privately](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).
