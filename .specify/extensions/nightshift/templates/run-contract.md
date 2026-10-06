# Run contract: {{feature}}

Approved by the user at {{approved_at}}. Its hash is frozen in the delivery record; any
edit after approval makes `ready check` fail until the batch is re-approved.

| Field | Value |
|---|---|
| Outcome | {{outcome}} |
| Scope | Pieces: {{scope}}. Protected paths: {{protected_paths}} |
| Source of truth | `{{feature}}/spec.md` |
| Evidence | {{evidence}} |
| Allowed iteration | Breakage found mid-phase (D-FOUND), at most {{max_rounds}} review rounds per piece. Convergence gaps are reported, not fixed |
| Escalation | `decision_needed`, a needed loop change, or more authority: block the piece and continue with independent work |
| Limits | {{max_rounds}} rounds per piece, {{wall_clock}} wall clock, the Claude plan's usage limit |
| Handover | One feature PR into `main` with a preview at the PR head SHA and a report. The run never merges to `main`. |

## Pieces and loops

{{pieces}}
