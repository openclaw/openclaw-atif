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
In 1-3 plain-language sentences, explain the affected task, what fails or is
missing, and why it matters. Include the trigger when known. Do not invent a bug
for other changes. These examples illustrate wording, not an observed defect:
Good: "Developers exporting a session bundle see no explanation when its format is
unsupported, so they cannot correct the input."
Bad: "Updates an internal handler and adds a missing check."
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
