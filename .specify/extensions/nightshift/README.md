# Spec Kit Nightshift

> **Status: v1.1.0, core review 2026-10-05; not yet confirmed by a live run.** v1.0.0 was
> signed off on 2026-10-04 after live sandbox runs (`docs/v1-signoff.md`). The core review
> (`docs/core-review.md`) then simplified it: two commands (`ready`, `run`), one critic,
> bug runs in the build path, re-grounding. 1.1.0 needs its own confirmation run.
> Extension id `nightshift`, commands `speckit.nightshift.*`.

Prepare the work during the day; Nightshift builds, checks, reviews and integrates it
unattended, and hands you back one running PR to accept.

## Purpose

A [Spec Kit](https://github.com/github/spec-kit)-native extension for **unattended batch
delivery**. Spec Kit stays the only foundation and owns the spec, plan, tasks and
implementation. Nightshift owns only what nobody else does: the batch, running the night
(a loop per piece, parking, continuing), integration into the feature branch, the
handover and the dashboard. Principles: `docs/philosophy.md`. Ideas borrowed from
[AI Build Kit](https://github.com/gwpicard/ai-build-kit) and others are credited in
`THIRD_PARTY.md`.

## Intended user flow

1. **Prepare (attended).** With an agent, use Spec Kit to specify, clarify, research the
   current code, plan and produce tasks (`bug.assess` for a reported bug).
2. **`/speckit-nightshift-ready`.** Derives one piece per `tasks.md` phase, validates
   them, checks the plan against the current code (re-grounding), recommends a loop per
   piece (build; fix for a bug; a quality bar only where you name one), and shows the
   run contract and the issues it would create. If something is wrong it names the Spec
   Kit command that fixes it.
3. **"go".** Freezes the contract and baseline in `.specify/delivery/<feature>.yml` and
   publishes a parent issue plus sub-issues, idempotently.
4. **Night (unattended).** For each ready piece a fresh builder implements it with Spec
   Kit's `implement`; scripts check gates and run the checks at the exact SHA; one fresh,
   read-only critic judges it. The piece merges into the feature branch, then combined
   checks run. An open product question parks that piece and its dependants (posted on
   the sub-issue with an @mention); independent pieces continue. A dashboard and a
   logbook show progress.
5. **Accept (attended).** You test the preview of the feature PR at its exact head SHA,
   then say "accepted" or give feedback (a defect gets a correction round). You merge to
   `main` yourself.

## Use it

Requirements: Spec Kit `>=1.0.13` and Python 3.11+; `git`, `gh` (signed in) and Claude
Code signed in with your subscription. No other review tool is needed.

```bash
specify extension add --dev /path/to/spec-kit-nightshift           # in your Spec Kit project
specify extension add --dev /path/to/spec-kit-nightshift --force   # update after a pull
specify extension list                                             # installed version
```

`specify extension update` does not apply (Nightshift is not in a catalog, research §13).
`--force` keeps `nightshift-config.yml` and `nightshift-config.local.yml`; missing keys
default. Avoid a plain `extension remove`: re-adding loses the local config.

| Command | What it does |
|---|---|
| `/speckit-nightshift-ready` | `check`, then `go` on your word (flow steps 2–3) |
| `/speckit-nightshift-run [--resume]` | The night (step 4) and the handover; follows `commands/speckit.nightshift.run.md` |

To withdraw an approved batch by day, run `shape.py --revoke`, then `ready` again.
Answers to parked questions need no re-approval: commit them through `/speckit-clarify`
and the run absorbs them. No Nightshift code merges or pushes to `main`, and nothing
writes `spec.md`, `plan.md` or `tasks.md`.

### Configure

Edit `.specify/extensions/nightshift/nightshift-config.yml` (a YAML subset: block
mappings and lists, flow lists of scalars, no `{...}` flow mappings). Defaults shown:

```yaml
max_rounds: 3          # review rounds per piece before it is parked
wall_clock: 8h         # one run
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
cli:
  builder: claude
  critic: claude
  # grounding: claude  # read-only plan-vs-code analyst; defaults to cli.critic
ci:
  require: true        # wait for the repo's GitHub checks on a phase PR
  wait_timeout: 30m
  poll_interval: 30s
min_free_mb:
  warn: 1536
  refuse: 500
# gate_paths: [...]    # edits fail the attempt; default Makefile, .github/workflows/**, config, delivery record
# base_branch: main
# notify: your-login   # @mentioned on blocker questions (default: the gh user)
```

Add `.nightshift/` to `.gitignore`, and protect `main` on GitHub.

### Tests

```bash
python3 -m unittest discover -s tests -t .
# optional, against real tools (no tokens):
NIGHTSHIFT_SPECIFY=/path/to/specify python3 -m unittest discover -s tests -t .
```

## Documents

- [docs/philosophy.md](docs/philosophy.md) and [docs/core-review.md](docs/core-review.md):
  the current authority on what Nightshift is and why.
- [docs/design-proposal.md](docs/design-proposal.md): architecture, ownership,
  boundaries and the decisions log (history; dated "Changed/Shelved" notes).
- [docs/research.md](docs/research.md): pinned upstream evidence.
- [docs/handoff.md](docs/handoff.md): where things stand and the next task.
- [docs/prompts/](docs/prompts/): install-and-run and run-report prompts; reports go to
  [docs/field-reports/](docs/field-reports/). Spike reports: [docs/spikes/](docs/spikes/).
- [AGENTS.md](AGENTS.md): instructions for agents working in this repository.

## Changes in 1.1.0 (2026-10-05, core review)

- `validate`, `shape` and `publish` commands replaced by `speckit.nightshift.ready`
  (`check`, then `go`).
- One fresh, read-only critic per review round; Open Code Review, the second critic and
  triage removed (OCR no longer required).
- Bug runs are fix pieces in the build path ("fails before, passes after").
- Optional quality bar per piece, judged by the same critic (gauntlet style).
- Re-grounding: plan-vs-code drift checked in `ready` and at run start (issue #1).
- `run` rewritten as a goal plus rules.
- Shelved: verify and improve loops, convergence auto-fixing and the requirement map,
  the non-conformance log, per-call cost recording.

## License

MIT (see [LICENSE](LICENSE)). Adapted third-party material keeps its own notices; see
the attribution table in `docs/design-proposal.md` §13.
