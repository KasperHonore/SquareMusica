# Run contract: specs/002-ai-dj-host

Approved by Kasper (delegated: test loop) at 2026-10-08T16:38:01+02:00. This is the goal of the night; the approval baseline in the
delivery record is what the run checks. Re-run `ready go` to change it.

| Field | Value |
|---|---|
| Outcome | AI DJ Host: 6 pieces delivered or honestly parked |
| Scope | Pieces: foundation, us1, us2, us3, us4, polish. Protected paths: none recorded |
| Source of truth | `specs/002-ai-dj-host/spec.md` |
| Evidence | script-run checks green, every acceptance scenario passes, a fresh critic approves at the SHA |
| Allowed iteration | Breakage found mid-phase (D-FOUND), at most 3 review rounds per piece. Once every piece passed, up to 2 `/speckit-converge` rounds: gaps that trace to spec.md are built as one more piece; the rest wait for your decision |
| Escalation | `decision_needed`, a needed change to the bar or scope, or more authority: block the piece and continue with independent work |
| Limits | 3 rounds per piece, 8h wall clock, the Claude plan's usage limit |
| Handover | One feature PR into `main` with a preview at the PR head SHA and a report. The run never merges to `main`. |

## Pieces

- `foundation` (Setup + Foundational): **build**. Done: checks green, every acceptance scenario passes, a fresh critic approves at the SHA
- `us1` (User Story 1 - The DJ introduces songs out loud): **build**. Done: checks green, every acceptance scenario passes, a fresh critic approves at the SHA
- `us2` (User Story 2 - Members control the DJ): **build**. Done: checks green, every acceptance scenario passes, a fresh critic approves at the SHA
- `us3` (User Story 3 - Personal shout-outs to people in the room): **build**. Done: checks green, every acceptance scenario passes, a fresh critic approves at the SHA
- `us4` (User Story 4 - Themed DJ mode builds and keeps the set going): **build**. Done: checks green, every acceptance scenario passes, a fresh critic approves at the SHA
- `polish` (Polish & Cross-Cutting Concerns): **build**. Done: checks green, every acceptance scenario passes, a fresh critic approves at the SHA
