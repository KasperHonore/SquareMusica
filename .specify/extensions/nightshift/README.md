# Spec Kit Nightshift

> **Status: 2.0.0, built offline 2026-10-07 (full suite green); not yet confirmed by a
> live run.** v1.0.0 was signed off on 2026-10-04 (`docs/v1-signoff.md`); 1.1.x followed
> the core review (`docs/core-review.md`); 2.0.0 is the rebuild in `docs/rebuild-plan.md`.
> Extension id `nightshift`, commands `speckit.nightshift.*`.

Prepare the work during the day; Nightshift builds, checks, reviews and integrates it
unattended, and hands you back one running PR to accept.

## Purpose

A [Spec Kit](https://github.com/github/spec-kit)-native extension for **unattended batch
delivery**. Spec Kit stays the only foundation and owns the spec, plan, tasks and
implementation. Nightshift owns only what nobody else does: the batch, running the night
(a loop per piece, parking, continuing), integration into the feature branch, the
handover and the dashboard. Principles: `docs/philosophy.md`. Ideas and text borrowed
from [AI Build Kit](https://github.com/gwpicard/ai-build-kit) and others are credited in
`THIRD_PARTY.md`.

## How a run is layered

- **Dispatcher** (`/speckit-nightshift-run`, your session). It holds the run lease, picks
  the next ready piece, starts it with `piece.py start`, waits with `piece.py wait --max
  540` (each call under Claude Code's 10-minute Bash cap) and acts on one short result per
  piece. It posts product questions, absorbs answers, runs converge rounds and writes the
  handover notes. It never builds, reviews or merges.
- **Piece process** (one fresh `claude -p` per piece, `templates/prompt-piece.md`). It runs
  that piece's loop through the scripts: builder round, postconditions, checks at the SHA,
  one critic, merge into the feature branch, combined checks. It inherits the lease and
  never posts blockers or edits state.
- **Builder and critic** (separate fresh processes started by `phase.py`). The builder runs
  `/speckit-implement` scoped to the phase; the critic is read-only and judges the frozen
  bar at the exact SHA. The piece process never grades its own work.

The result of a piece (`passed`, `parked`, `blocked`, or `stopped` with `usage_limit`,
`environment_failure`, `safety_stop`, `timeout` or `crashed`) is read from state and the
logbook, never from the session. The session's own `summary.md` is shown as a claim.

## Use it

Requirements: Spec Kit `>=1.0.13` and Python 3.11+; `git`, `gh` (signed in) and Claude
Code signed in with your subscription. No other review tool is needed.

```bash
specify extension add --dev /path/to/spec-kit-nightshift           # in your Spec Kit project
specify extension add --dev /path/to/spec-kit-nightshift --force   # update after a pull
specify extension list                                             # installed version
```

Or install a tagged release without a clone (asks you to confirm the source). The latest
tag is `v2.0.0` (built and tested offline, not yet confirmed live):

```bash
specify extension add nightshift --from https://github.com/KasperHonore/spec-kit-nightshift/archive/refs/tags/v2.0.0.zip
specify extension add nightshift --from <newer tag URL> --force    # update
```

The repository is private. Spec Kit sends a GitHub token only to hosts listed in
`~/.specify/auth.json` (per user, not per project); `GH_TOKEN` and the `gh` login alone
are ignored, and a missing token shows as a 404 (research §13). One-time setup, with no
token on disk:

```bash
mkdir -p ~/.specify && chmod 700 ~/.specify
cat > ~/.specify/auth.json <<'EOF'
{"providers": [{"provider": "github", "auth": "bearer",
  "token_env": "SPECIFY_GITHUB_TOKEN",
  "hosts": ["github.com", "api.github.com", "codeload.github.com", "raw.githubusercontent.com"]}]}
EOF
chmod 600 ~/.specify/auth.json

# in ~/.bashrc: fill the token from the gh login on each run
specify() { SPECIFY_GITHUB_TOKEN="$(gh auth token 2>/dev/null)" command specify "$@"; }
```

Open a new shell afterwards. The wrapper covers interactive bash only; scripts set
`SPECIFY_GITHUB_TOKEN` themselves. The token then goes with every `specify` download
from those hosts, in every project. Undo: delete `auth.json` and the function.

`specify extension update` does not apply (Nightshift is not in a catalog, research §13).
`--force` keeps `nightshift-config.yml` and `nightshift-config.local.yml`; missing keys
default. Avoid a plain `extension remove`: re-adding loses the local config.

| Command | What it does |
|---|---|
| `/speckit-nightshift-ready` | `check`, then `go` on your word (workflow steps 2–3) |
| `/speckit-nightshift-run [--resume]` | The night and the handover (steps 4–5); the dispatcher in `commands/speckit.nightshift.run.md` |

To change an approved batch by day, edit through Spec Kit and run `ready` and "go" again
(re-running `go` re-approves). No Nightshift code merges or pushes to `main`, and no
Nightshift code writes `spec.md`, `plan.md` or `tasks.md`.

### Configure

Edit `.specify/extensions/nightshift/nightshift-config.yml` (a YAML subset: block
mappings and lists, flow lists of scalars, no `{...}` flow mappings). Defaults shown:

```yaml
max_rounds: 3          # review rounds per piece before it is parked
wall_clock: 8h         # one run; enforced by piece.py next (budget_exhausted)
phase_budget: 2h       # one builder round
review_budget: 1h      # one critic call
checks:                # default []; run at the exact SHA
  - id: unit
    argv: [make, check]
    timeout: 600
preview:
  command: [make, preview]               # default []; "{port}" becomes a free port
  health_url: "http://127.0.0.1:{port}/"
  health_timeout: 30
cli:                   # the unmodified Claude Code CLI, signed in by subscription
  piece: claude        # one fresh orchestrator process per piece
  builder: claude
  critic: claude       # one fresh, read-only critic per review round
  converge: claude     # /speckit-converge rounds
converge:
  max_rounds: 2        # open gaps after the cap are known gaps
ci:
  require: true        # wait for the repo's GitHub checks on a phase PR
  wait_timeout: 30m
  poll_interval: 30s
min_free_mb:
  warn: 1536
  refuse: 500
  probe: 32            # MB actually written (user quotas are invisible to df); 0: off
# gate_paths: [...]    # edits fail the attempt; default Makefile, .github/workflows/**, config, delivery record
# base_branch: main
# notify: your-login   # @mentioned on blocker questions (default: the gh user)
```

Add `.nightshift/` to `.gitignore`, and protect `main` on GitHub.

There is no setup command: edit the file by hand or ask Claude to fill it in from your
CI. `checks` and `preview.command` are required: the run's preflight refuses without
them (`scripts/python/preflight.py`). `ready` does not check the config. A guided setup
prompt is in `docs/prompts/install-and-first-run.md` (steps 3–5).

### Workflow

**Once per project:** configure `checks` and `preview` (above), gitignore
`.nightshift/`, protect `main`, and sign in `gh`.

**Per feature:**

1. **Plan, attended.** `/speckit-specify`, `/speckit-clarify`, `/speckit-plan`,
   `/speckit-tasks`. Each `tasks.md` phase becomes one piece, so shape phases as
   outcomes. Answer product questions now; open ones park their piece.
2. **`/speckit-nightshift-ready`.** Shows the readiness table, a drift note where code
   the plan names has changed since it was grounded (it reaches that piece's builder; it
   does not hold the piece), the run contract and the issues it would create. If not
   ready, it names the Spec Kit command that fixes it. Name a quality bar for a piece
   here if you want one.
3. **Say "go"** and confirm the repository. It approves the batch (baseline and
   `grounded_at` in `.specify/delivery/<feature>.yml`) and publishes a parent issue and
   one sub-issue per piece. Commit and push `.specify/delivery/`.
4. **`/speckit-nightshift-run`, unattended.** One fresh piece process per ready piece
   (see above); a passed piece is merged into the feature branch after CI, and combined
   checks run. An open question is posted on the sub-issue with an @mention; independent
   pieces continue. A dashboard shows progress.
   - **Answers.** When you reply on the issue, the dispatcher runs `/speckit-clarify`
     (and `/speckit-tasks` if the work changed), commits, and `blocker.py resolve`
     absorbs it. A renumbering or a changed acceptance criterion blocks the piece
     `needs_kasper` instead: re-run `ready` and "go" by day.
   - **Converge rounds.** When every piece has passed, `/speckit-converge` runs (at most
     `converge.max_rounds`, default 2). It may only append to `tasks.md`. Gaps that trace
     to `spec.md` become one more piece, `convergence-N`, built like any other; untraced
     gaps (all `unrequested` ones) are listed for your decision. A run with a parked or
     blocked piece skips converge.
5. **Handover.** One feature PR into `main` with a preview at its exact head SHA, or a
   stated stop reason. The PR body: *Needs your decision* (parked and blocked pieces with
   their questions verbatim, untraced gaps), *Summary*, *Evidence* per piece at the head
   SHA, *Merge danger* (door, blast radius, and mechanically detected one-way signals such
   as migrations, deleted files, lockfiles and CI paths), *Acceptance criteria* verbatim,
   *Changed during the run*, *Known gaps*. Summary and Merge danger are agent-written.
6. **Accept, attended.** Test the preview at the PR's head SHA. Say "accepted" or
   "accepted except AC-3". A defect or a wish goes to `/speckit-clarify` by day and is
   picked up by the next run's converge. **You merge to `main`**, then ask Claude to
   close the issues and clean up.

| Situation | Do |
|---|---|
| Usage limit (`budget_exhausted`) | `/speckit-nightshift-run --resume` after the reset |
| Parked question | Reply on the sub-issue; the dispatcher absorbs it, or blocks `needs_kasper` |
| Parked piece (`max_rounds`, `stagnation`, CI, …) | Fix what it needs through Spec Kit if anything, then `ready` and "go": every parked piece returns to the queue with fresh review rounds at the next pick (`--resume`); its park stays in the record |
| Change the plan after "go" | Edit through Spec Kit, `/speckit-nightshift-ready`, "go" again (re-approves) |
| A reported bug | Specify the fix as a feature through Spec Kit (bug runs were shelved in 2.0.0) |

Start with a feature of two or three phases and watch the dashboard the first time.

### Tests

```bash
python3 -m unittest discover -s tests -t .
# optional, against real tools (no tokens):
NIGHTSHIFT_SPECIFY=/path/to/specify python3 -m unittest discover -s tests -t .
```

## Documents

- [docs/philosophy.md](docs/philosophy.md): the principles; the authority on what
  Nightshift is and why.
- [docs/design-proposal.md](docs/design-proposal.md): the 2.0 design, ownership,
  enforcement and the decisions log. [docs/rebuild-plan.md](docs/rebuild-plan.md) and
  [docs/core-review.md](docs/core-review.md) are history.
- [docs/research.md](docs/research.md): pinned upstream evidence.
- [docs/handoff.md](docs/handoff.md): where things stand and the next task.
- [docs/prompts/](docs/prompts/): install-and-run and run-report prompts; reports go to
  [docs/field-reports/](docs/field-reports/). Spike reports: [docs/spikes/](docs/spikes/).
- [AGENTS.md](AGENTS.md): instructions for agents working in this repository.

## Changes in 2.0.3 (2026-10-08)

- Postcondition violations reach the next builder with their detail, and
  `blocker_history` keeps their codes (`postconditions:found-invalid`). Before, `phase
  build` had already moved the piece to `checking`, so the builder saw only "postconditions"
  (SquareMusica 002 us3, 2.0.1).
- A dependency bullet's sentences are separate clauses, and a story the piece "works
  without" or uses "if present" is no prerequisite. Before, "Works without US3" made US4
  wait behind a parked US3 (SquareMusica 002, 2.0.1).
- Acceptance scenarios and the Independent Test keep their wrapped lines. Before, they
  were cut at the first line (US3/AC2 ended "**Then** it"); approved records with the cut
  quotes now report those scenarios as changed (SquareMusica 002, 2.0.1).

## Changes in 2.0.2 (2026-10-08)

- The builder prompt states the `.nightshift/found.json` shape postconditions accept
  (`kind` `blocker` with a check id, or `nonblocker`, plus a `summary`). Before, a builder
  guessed the shape and lost a round to `found-invalid` (SquareMusica 002, 2.0.1).

## Changes in 2.0.1 (2026-10-08)

- Task IDs with a one-letter suffix (`T019a`) are tasks. Before, ticking one counted as
  editing `tasks.md` and parked the piece (first live 2.0 run, SquareMusica 002).

## Changes in 2.0.0 (2026-10-07, rebuild)

- Layered run (D-LAYER): the run session is a dispatcher; each piece gets its own fresh
  orchestrator process (`piece.py`, `templates/prompt-piece.md`, `cli.piece`).
- Converge rounds (D-3'): traced gaps are built as `convergence-N` before the PR opens;
  `converge.max_rounds`, `cli.converge`; append-only checked mechanically.
- Reviewer PR body: Summary, Evidence, Merge danger with one-way signals
  (`handover.py pr --notes`).
- Day path folded into `ready.py`; re-running `go` re-approves. Answers are one
  `blocker.py resolve` with a rebaseline.
- Grounding is record, detect and a drift note; no analyst role (`cli.grounding` gone).
- `wall_clock` enforced; a quota or full disk inside a check is an environment failure,
  never a cached red; passed worktrees removed after combined checks.
- Removed: bug runs (`--bug`, the fix loop), feedback corrections (`feedback.py`),
  `shape`/`derive`/`validate`/`publish` CLIs, revoke and the contract-hash rebind,
  `tasks_stale`/`reapproval_needed`/`plan_stale`, `publish --reconcile`.

## License

MIT (see [LICENSE](LICENSE)). Adapted third-party material keeps its own notices; see
`THIRD_PARTY.md` and `docs/design-proposal.md` §13.
