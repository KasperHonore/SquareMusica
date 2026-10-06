---
description: "Get a feature or bug ready for a Nightshift run: validate, recommend loops, show the run contract and issue plan, then approve and publish on the owner's go"
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
- The script is the authority. Report what it prints; do not add your own verdicts.
- Do not interview the user about loops. Build is the default; fix is for a promised,
  reproduced bug. Pass `--quality-bar <piece>=<text or path>` only for a bar the user
  named, never one you made up.
- Run `go` only after the user has seen the `check` output in this conversation and said
  "go" (or equivalent) for the named repository.
- A product question is never yours to answer: it goes back to Spec Kit `clarify`.

## Outline

1. Run `{SCRIPT}` from the repository root with the action `check` (append
   `--feature specs/<NNN-name>` or `--bug <slug>` when the user names one, and any
   `--quality-bar` the user named).
2. If it exits 1, it is not ready. Show the table, every `ERROR` line verbatim and the
   printed "To fix" list (each names the Spec Kit command to use), then stop.
3. Otherwise show the user, briefly: the readiness table, the grounding line (plan vs.
   code; a `plan stale` piece needs `/speckit-plan` and `/speckit-tasks` by day, the rest
   can run), any pieces that stay parked and why, the run contract (outcome, constraints, done test per piece, limits, stop
   rules, handover) and the issues that would be created. Ask for "go" and the
   repository (`origin` is the only one accepted).
4. On "go": run the same script with `go --repo <owner/name> --approved-by "<name>"` (same
   `--feature`/`--bug`/`--quality-bar` as the check). It approves, then publishes;
   it refuses with nothing written if validation fails or the repository is not
   `origin`. Re-running is safe. Report the contract hash, the issues created,
   updated or unchanged, and every `WARNING`.
5. Tell the user to commit `.specify/delivery/` before `speckit.nightshift.run`.

To withdraw an approved batch, revoke it with
`python3 .specify/extensions/nightshift/scripts/python/shape.py --revoke`, then run this
command again; a running night binds itself to the new approval. Answers to parked
questions need no revoke: the run absorbs them. Hand edits on GitHub are reported read-only by `publish.py --reconcile`.
