# Third-party notices

Spec Kit Nightshift is licensed under the MIT License (see `LICENSE`). Two shipped files
adapt substantial text from the projects below; each is MIT-licensed and its notice and
licence text follow. Neither skill is installed or called; only the adapted wording ships.
Everything else in the shipped files (`scripts/python/*.py`, `commands/*.md`,
`templates/*`, `extension.yml`, `nightshift-config.yml`) is original.

## Matt Pocock: `pr` skill

- Source: `mattpocock/skills`, commit `6fd9479`, `skills/engineering/pr/SKILL.md`
  (clone in `.research/pocock-skills`).
- Adapted in: `templates/pr-feature.md` (the Summary, Evidence and Merge danger sections,
  Door one-way/two-way and Blast radius) and `commands/speckit.nightshift.run.md` (how the
  dispatcher writes the Summary and Merge danger notes).
- Copyright (c) 2026 Matt Pocock

```text
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## HumanLayer: `visual-pr` and `show-me` skills

- Source: `humanlayer/skills`, commit `ca7c808`, `plugins/visual-pr` and `plugins/show-me`
  (clone in `.research/humanlayer-skills`). The Pocock skill above credits `show-me` too.
- Adapted in: `commands/speckit.nightshift.run.md` (the Summary as one sentence of why plus
  the smallest picture: a file tree, call tree or diff sketch) and `templates/pr-feature.md`.
- Copyright (c) 2026 HumanLayer

```text
MIT License

Copyright (c) 2026 HumanLayer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Ideas, not copied material

The design draws on ideas and general approaches from other projects. These are
credited in `docs/design-proposal.md` section 13 (Borrowed material and attribution).
Among them: re-grounding's `grounded_at` (2026-10-05) takes the idea of AI Build Kit's
"Trued against <commit>" mark (`setup-ai-build-kit/references/masterplan-changes.md:26`,
ABK `fd0780a`); no code or text is copied.

## Audit record

Compared on 2026-10-02 (before 2.0.0) against clones in `.research/` at these commits
(line-level and token-shingle comparison of every shipped file, plus a manual read of the
closest hits). The Pocock and HumanLayer adaptations above were added in 2.0.0
(2026-10-07) and are recorded where they are adapted:

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
