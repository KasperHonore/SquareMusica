---
description: "Check a feature is ready for a Nightshift run, show the run contract and issue plan, then approve and publish on the owner's go"
scripts:
  py: scripts/python/ready.py
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Rules

- Never edit `spec.md`, `plan.md` or `tasks.md`; only Spec Kit commands write them. The
  script writes only the delivery record, the run contract and, through `gh`, the issues.
- The script is the authority. Report what it prints; add no verdicts of your own.
- Every piece runs the build loop. Pass `--quality-bar <piece>=<text or path>` only for a
  bar the user named, never one you made up.
- Run `go` only after the user has seen the `check` output here and said "go" (or
  equivalent) for the named repository. A product question goes to `/speckit-clarify`.

## Outline

1. Run `{SCRIPT}` from the repository root with the action `check` (and
   `--feature specs/<NNN-name>` when the user names one, and any `--quality-bar` they named).
2. Exit 1: not ready. Show the table, every `ERROR` line verbatim and the "To fix" list
   (each names the Spec Kit command to use), then stop.
3. Otherwise show briefly: the readiness table, the grounding line (a drift note reaches
   that piece's builder; it does not hold the piece), what changed since the last approval,
   the pieces that stay parked and why, the parked pieces of the run that "go" returns to
   the queue (with fresh review rounds), the run contract and the issues. Ask for "go" and
   the repository (`origin` is the only one accepted).
4. On "go": the same script with `go --repo <owner/name> --approved-by "<name>"` (same
   `--feature` and `--quality-bar`). It refuses with nothing written if the repository is not `origin` or
   the check fails. Re-running re-approves the current files. Report the issues created,
   updated or unchanged, and every `WARNING`.
5. Tell the user to commit `.specify/delivery/` before `/speckit.nightshift.run`.
