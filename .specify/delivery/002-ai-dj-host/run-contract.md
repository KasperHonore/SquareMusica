# Run contract: specs/002-ai-dj-host

Approved by the user at 2026-10-06T22:00:39+02:00. Its hash is frozen in the delivery record; any
edit after approval makes `ready check` fail until the batch is re-approved.

| Field | Value |
|---|---|
| Outcome | AI DJ Host: 6 pieces delivered or honestly parked |
| Scope | Pieces: foundation, us1, us2, us3, us4, polish. Protected paths: none recorded |
| Source of truth | `specs/002-ai-dj-host/spec.md` |
| Evidence | build: script-run checks green, every acceptance scenario passes, the critic approves at the SHA |
| Allowed iteration | Breakage found mid-phase (D-FOUND), at most 3 review rounds per piece. Convergence gaps are reported, not fixed |
| Escalation | `decision_needed`, a needed loop change, or more authority: block the piece and continue with independent work |
| Limits | 3 rounds per piece, 8h wall clock, the Claude plan's usage limit |
| Handover | One feature PR into `main` with a preview at the PR head SHA and a report. The run never merges to `main`. |

## Pieces and loops

- `foundation` (Setup + Foundational): **build**. Shared infrastructure with settled tasks
- `us1` (User Story 1 - The DJ introduces songs out loud): **build**. US1 behaviour is specified and its tasks are settled
- `us2` (User Story 2 - Members control the DJ): **build**. US2 behaviour is specified and its tasks are settled
- `us3` (User Story 3 - Personal shout-outs to people in the room): **build**. US3 behaviour is specified and its tasks are settled
- `us4` (User Story 4 - Themed DJ mode builds and keeps the set going): **build**. US4 behaviour is specified and its tasks are settled
- `polish` (Polish & Cross-Cutting Concerns): **build**. Cross-cutting tasks are settled
