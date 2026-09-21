# Contributing

Search existing issues and pull requests first. Discuss changes to the public
bundle contract, ATIF version, library API, or migration behavior before implementation.
Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

## Development

Use Node.js 24.11 or newer in the Node.js 24 release line and npm:

```bash
npm ci
npm run check
```

`check` runs formatting, lint, type checks, tests, coverage, and duplicate-code
checks. For focused iteration, use `npm test -- test/cli.test.ts` or another
affected test file. Keep `package-lock.json` aligned with dependency changes.

Before release, run all repository gates:

```bash
npm run check
npm run mutate
npm run slophammer
npm run validate:harbor
npm run smoke:cli
```

Harbor validation also requires Python 3.12 with venv support, Git, and network
access for the pinned Harbor source and Python dependencies. The CLI smoke test
installs a real npm tarball and checks synthetic exports, retained media, and
owner-only output permissions. Hosted CI runs these gates on each pull request
and push to `main`.

## Pull requests

- Keep one logical change per pull request and use a title such as `fix(cli): report invalid options`.
- Explain the defect, owner boundary, compatibility impact, and validation.
- Add regression coverage for behavior changes and an `Unreleased` entry in `CHANGELOG.md`.
- Keep OpenClaw storage interpretation in OpenClaw. Consume only public bundle facts.
- Use synthetic fixtures. Redact credentials, session content, personal paths, and private hostnames.
- Report fixture, installed-CLI, real OpenClaw, and live-model proof separately.

When independent review is requested, use the vendored canonical helper:

```bash
.agents/skills/autoreview/scripts/autoreview --mode local --max-priority P2
```

For committed changes, use `--mode branch --base <base-sha>` instead. Verify
findings against the source; a clean review does not replace behavior tests.
The helper is maintained in [openclaw/agent-skills](https://github.com/openclaw/agent-skills/tree/main/skills/autoreview).

## Releases

Maintainers update `package.json`, both root version fields in `package-lock.json`,
and `src/version.ts` together, and move the changelog entries to the new version.
Verify CI on that exact `main` commit before creating its `vX.Y.Z` tag and
publishing the GitHub Release. Never move an existing release tag.

The `Publish` workflow revalidates the release and publishes through npm trusted
publishing. Its identity is `openclaw/openclaw-atif`, workflow `publish.yml`, with
no GitHub environment. Do not add npm tokens or publish a real release locally.
CI and publishing use the same pinned npm version and pack the checked build once.
The workflow smoke-installs that tarball, publishes it without lifecycle scripts,
and verifies the registry's integrity, shasum, and provenance metadata.

The `0.0.0` npm bootstrap is a package-name reservation only. It is not a
functional exporter and must not replace the source package version.
