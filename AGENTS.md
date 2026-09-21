# Repository guidance

- Use TypeScript and Node.js 24.11 or newer in the Node.js 24 release line.
- Keep OpenClaw storage interpretation inside OpenClaw. Do not parse private JSONL or SQLite layouts.
- Map only observed public bundle facts. Do not invent timestamps, messages, retries, rewards, or lineage.
- Keep output deterministic and owner-only.
- Run `npm run check`, `npm run mutate`, `npm run slophammer`, `npm run validate:harbor`, and `npm run smoke:cli` before release.
- Read `CONTRIBUTING.md` before changing code. Use npm and preserve `package-lock.json`.
- Add an `Unreleased` changelog entry for user-visible or operational changes.
- Keep fixtures synthetic. Never commit real session bundles, credentials, or private paths.
- Use the canonical `.agents/skills/autoreview/` helper when an independent review is requested; keep repo-specific validation here, not in the vendored skill.
- Hosted CI runs the release gates. Do not invent a Crabbox runner or add credentials without configuring and verifying the integration.
- Publish only through `.github/workflows/publish.yml`; keep its npm trusted-publisher identity aligned with the package settings.
