# Run contract: {{feature}}

Approved {{approved}}. This is the goal of the night; the approval baseline in the
delivery record is what the run checks. Re-run `ready go` to change it.

| Field | Value |
|---|---|
| Outcome | {{outcome}} |
| Scope | Pieces: {{scope}}. Protected paths: {{protected_paths}} |
| Source of truth | `{{feature}}/spec.md` |
| Evidence | script-run checks green, every acceptance scenario passes, a fresh critic approves at the SHA |
| Allowed iteration | Breakage found mid-phase (D-FOUND), at most {{max_rounds}} review rounds per piece. Once every piece passed, up to {{converge_rounds}} `/speckit-converge` rounds: gaps that trace to spec.md are built as one more piece; the rest wait for your decision |
| Escalation | `decision_needed`, a needed change to the bar or scope, or more authority: block the piece and continue with independent work |
| Limits | {{max_rounds}} rounds per piece, {{wall_clock}} wall clock, the Claude plan's usage limit |
| Handover | One feature PR into `main` with a preview at the PR head SHA and a report. The run never merges to `main`. |

## Pieces

{{pieces}}
