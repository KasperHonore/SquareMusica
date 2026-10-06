# Third-party notices

As of 2026-10-02, **no third-party code or substantial text is included** in the
shipped files of Spec Kit Nightshift (`scripts/python/*.py`, `commands/*.md`,
`templates/*`, `extension.yml`, `nightshift-config.yml`). Nightshift is licensed
under the MIT License (see `LICENSE`).

The design draws on ideas and general approaches from other projects. These are
credited in `docs/design-proposal.md` section 13 (Borrowed material and attribution).
Among them: re-grounding's `grounded_at` (2026-10-05) takes the idea of AI Build Kit's
"Trued against <commit>" mark (`setup-ai-build-kit/references/masterplan-changes.md:26`,
ABK `fd0780a`); no code or text is copied.
Ideas are not copied material. If code or substantial text is adapted later, add an
entry here with the source, path, pinned commit, licence and verbatim copyright line,
and include the licence text.

## Audit record

Compared against clones in `.research/` at these commits (line-level and token-shingle
comparison of every shipped file, plus a manual read of the closest hits):

| Source | Commit | Licence | Result |
|---|---|---|---|
| AI Build Kit | fd0780a | MIT, Copyright (c) 2025 Guillaume Picard | No copied code or text |
| spec-kit-ralph | 81acf81 | MIT, Copyright (c) 2026 Rubiss | No copied code or text |
| spec-kit-loop | e216b4c | MIT, Copyright (c) 2026 formin | No copied code or text |
| ESF / Machinist | 0124210 | MIT, Copyright (c) 2026 Owain Lewis; Copyright (c) 2026 mitkox and ESF contributors | No copied code or text |
| Claude-of-Duty (Gauntlet) | not cloned | MIT | Not compared; ideas only per design section 13 |
| Open Code Review | a758d9c | Apache-2.0 | No copied code or text |
| Spec Kit | 838f1184 (v0.1.10-1537) | MIT, Copyright GitHub, Inc. | No substantial code or text; see de minimis note |

De minimis note (Spec Kit): the command files begin with the standard Spec Kit
"User Input" block (a fenced `$ARGUMENTS` and one sentence telling the agent to
consider it). Project-root discovery in `scripts/python/nightshift_core.py` uses
the same `.specify/` upward walk and `SPECIFY_INIT_DIR` override as Spec Kit's
scripts. Both are short conventions of the extension interface, not substantial
expression, and the surrounding code and text are original.

## Runtime tools invoked but not bundled

Nightshift calls these tools; it does not include or redistribute any of them.

- Spec Kit (`specify` and its commands, MIT, Copyright GitHub, Inc.)
- GitHub CLI `gh` (MIT)
- Claude Code (Anthropic; commercial terms)

Open Code Review `ocr` (Apache-2.0) was invoked in delegation mode until 2026-10-05; it
is no longer called (D-OCR shelved, core review stage 3). Its plan-then-review,
every-file coverage and fact-check concepts remain as ideas in
`templates/prompt-critic.md`, written in our own words; no OCR text or rules are
included (design section 13).
