<!--
Write the title and opening problem statement for session-export developers.
Name the affected task and the symptom or outcome, not only the implementation.
Good: fix: tell developers why a session bundle cannot be exported
Bad: fix: add a bundle validation branch
For internal-only work, name the actual developer or operator workflow affected;
do not invent an end-user benefit.
-->

## Problem and change

<!--
In 1–3 plain sentences, say who is affected, what happens today, and why it
matters to them. For a bug, name the trigger if known. For a feature or internal
work, describe the need in the actual workflow without inventing harm.
Could a reader understand the problem without knowing your proposed fix?

Good: "Background checks can use up a new user's model allowance before they've
asked the assistant to monitor anything."
Bad: "Turn off periodic checks on fresh installs."
-->

<!-- Explain the observed defect, chosen owner boundary, and resulting behavior. Link related issues. -->

## Compatibility and privacy

<!-- Note public API, bundle/ATIF, migration, filesystem, or package changes. Keep examples synthetic. -->

## Validation

<!--
Lead with the behavior checked and the observed result in plain language, then
include exact commands and supporting evidence. Put long logs and commit hashes
in links or optional <details>. Keep meaningful gaps, risks, and required
actions visible; do not make readers decode commands to learn what was verified.
-->

<!-- List exact commands and outcomes. Separate fixtures, installed CLI, real OpenClaw, and live-model proof. -->

- [ ] Regression tests cover changed behavior.
- [ ] Changelog updated when user-visible or operationally meaningful.
- [ ] No private session data, credentials, or personal paths are included.
