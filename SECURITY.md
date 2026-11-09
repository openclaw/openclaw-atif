# Security policy

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/openclaw/openclaw-atif/security/advisories/new)
or email `security@openclaw.ai`. Do not include private session bundles in public issues.

Include the affected package version or commit, Node.js and OpenClaw versions,
operating system, a minimal synthetic reproduction, and demonstrated impact.

Relevant boundaries include:

- output escaping its selected directory or losing owner-only permissions;
- migration-on-copy modifying the original OpenClaw state;
- unsafe local media paths or unintended network retrieval;
- credentials or private session content leaking through exports, logs, or diagnostics;
- dependency or release-pipeline compromise affecting the published package.

Exports can contain sensitive conversation content even when their source bundle
has been redacted. Review trajectories and receipts before sharing them. This
package does not upload exports or recover facts removed from source bundles.

Security fixes target the latest release. There is no paid bug bounty program.
