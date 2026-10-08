#!/usr/bin/env python3
"""Read and write the run state (``.nightshift/<feature>/state.json``).

A thin CLI over ``nightshift_state``. The orchestrator rereads state before every
step and writes it after (design §7):

- ``init``: create the run from the approved delivery record (loop per piece,
  feature branch ``feat/<name>`` or ``--branch``);
- ``show``, ``pending``: read;
- ``transition --piece --to [--reason]``: move a piece; illegal moves are refused,
  and ``passed`` is never accepted here (only ``phase_merge`` sets it);
- ``set --piece --field --value``: sub-statuses and bookkeeping fields. A
  sub-status may be set to anything except ``passed``: a pass is recorded only by
  the script that observed it (checks, postconditions, verdict), per D-HONEST;
- ``stop --reason``: end the run with one of the design §6.5 stop reasons;
- ``step-intent`` / ``step-done``: the resume records;
- ``should-skip``: exit 0 when a ``done`` record with the same inputs hash exists
  (skip), 1 otherwise (run).

The refusals are **mechanical** for callers that use this CLI; nothing stops an
agent from editing ``state.json`` directly, which is why ``state.json`` is never
evidence on its own (scripts re-derive facts from git and evidence files).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_core as core  # noqa: E402
import nightshift_model as model  # noqa: E402
import nightshift_state as nstate  # noqa: E402

SETTABLE = {"round", "base_sha", "candidate_sha", "bar_hash", "question", "pr", "merged_sha"}


def _inputs(raw: str) -> Any:
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise core.NightshiftError(f"--inputs-json is not valid JSON: {exc}") from exc


def cmd_init(root: Path, fdir: Path, args: argparse.Namespace) -> dict[str, Any]:
    rep = model.validate_feature(root, fdir)
    errors = [f for f in rep.findings if f.severity == "error"]
    if errors:
        raise core.NightshiftError("validation failed: " + "; ".join(f"[{f.code}] {f.message}" for f in errors))
    if not rep.record.get("approval"):
        raise core.NightshiftError("the batch is not approved; run ready go first")
    entries = rep.record.get("pieces") or {}
    loops = {p.key: (entries.get(p.key) or {}).get("loop") for p in rep.derivation.pieces}
    missing = [k for k, v in loops.items() if not v]
    if missing:
        raise core.NightshiftError(f"pieces without a loop: {', '.join(missing)}")
    branch = args.branch or f"feat/{fdir.name}"
    return nstate.init(root, fdir.name, rep.derivation.feature, branch, loops)



def coerce(field: str, value: str) -> Any:
    if value in ("null", ""):
        return None
    if field in ("round", "pr"):
        try:
            return int(value)
        except ValueError as exc:
            raise core.NightshiftError(f"{field} must be an integer") from exc
    return value


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--feature", help="feature directory")
    ap.add_argument("--json", action="store_true", help="print JSON")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("init")
    p.add_argument("--branch", help="feature branch (default feat/<feature-name>)")
    sub.add_parser("show")
    sub.add_parser("pending")
    p = sub.add_parser("transition")
    p.add_argument("--piece", required=True)
    p.add_argument("--to", required=True)
    p.add_argument("--reason")
    p = sub.add_parser("set")
    p.add_argument("--piece", required=True)
    p.add_argument("--field", required=True)
    p.add_argument("--value", required=True)
    p = sub.add_parser("stop")
    p.add_argument("--reason", required=True)
    p = sub.add_parser("lease", help="acquire or release the orchestrator lease")
    p.add_argument("action", choices=("acquire", "release", "show"))
    p.add_argument("--owner", help="orchestrator id (default: NIGHTSHIFT_LEASE)")
    p.add_argument("--take-over", action="store_true",
                   help="on resume: take over a stale lease, or at once when its holder pid is provably gone")
    p.add_argument("--holder-pid", type=int,
                   help="pid of this session's long-lived process (the agent CLI); lets a later "
                        "--take-over succeed as soon as that process is gone")
    for name in ("step-intent", "step-done", "should-skip"):
        p = sub.add_parser(name)
        p.add_argument("--step", required=True, help="<piece>:<round>:<kind>")
        p.add_argument("--inputs-json", required=True, help="the step's inputs as JSON")
        if name == "step-done":
            p.add_argument("--result-json", default="{}", help="the verified result as JSON")
    # Accept --json after the subcommand too.
    for sp in sub.choices.values():
        sp.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="print JSON")
    args = ap.parse_args(argv)
    root = core.find_project_root()
    fdir = core.resolve_feature_dir(root, args.feature)
    name = fdir.name
    rc = 0

    if args.cmd == "lease":
        import os
        owner = args.owner or os.environ.get("NIGHTSHIFT_LEASE", "")
        if args.action == "show":
            out: Any = nstate.read_lease(root, name) or {"owner": None}
        elif not owner:
            raise core.NightshiftError("lease needs --owner or NIGHTSHIFT_LEASE")
        elif args.action == "acquire":
            out = nstate.acquire_lease(root, name, owner, take_over=args.take_over,
                                       holder_pid=args.holder_pid)
        else:
            nstate.release_lease(root, name, owner)
            out = {"released": owner}
    elif args.cmd == "init":
        out = cmd_init(root, fdir, args)
    else:
        st = nstate.load(root, name)
        out = st
        if args.cmd == "pending":
            # A running piece process is tracked by piece.py, not re-run from here.
            out = {"pending": [k for k in nstate.pending_intents(st) if nstate.step_kind(k) != "piece"]}
        elif args.cmd == "transition":
            if args.to in nstate.RESERVED:
                raise core.NightshiftError(f"{args.to} is set only by {nstate.RESERVED[args.to]}")
            nstate.transition(st, args.piece, args.to, by="state", reason=args.reason)
            nstate.save(root, name, st)
            out = nstate.piece(st, args.piece)
        elif args.cmd == "set":
            piece = nstate.piece(st, args.piece)
            if args.field in nstate.SUB_FIELDS:
                if args.value == "passed":
                    raise core.NightshiftError(
                        f"{args.field}=passed is recorded only by the script that observed it (D-HONEST)")
                nstate.set_sub(st, args.piece, args.field, args.value)
            elif args.field in SETTABLE:
                piece[args.field] = coerce(args.field, args.value)
            else:
                raise core.NightshiftError(
                    f"field {args.field!r} cannot be set here (status: use transition; "
                    f"settable: {', '.join(sorted(SETTABLE | set(nstate.SUB_FIELDS)))})")
            nstate.save(root, name, st)
            out = piece
        elif args.cmd == "stop":
            nstate.stop(st, args.reason)
            nstate.save(root, name, st)
            out = {"status": st["status"], "stop_reason": st["stop_reason"]}
        elif args.cmd == "step-intent":
            nstate.step_intent(st, args.step, _inputs(args.inputs_json))
            nstate.save(root, name, st)
            out = st["steps"][args.step]
        elif args.cmd == "step-done":
            nstate.step_complete(st, args.step, _inputs(args.inputs_json), _inputs(args.result_json))
            nstate.save(root, name, st)
            out = st["steps"][args.step]
        elif args.cmd == "should-skip":
            done = nstate.step_done(st, args.step, _inputs(args.inputs_json))
            rec = st["steps"].get(args.step) or {}
            out = {"step": args.step, "skip": done is not None, "result": (done or {}).get("result"),
                   "intent_without_done": bool(rec.get("intent")) and done is None}
            rc = 0 if done is not None else 1

    if args.json or args.cmd in ("show",):
        core.emit_json(out)
    elif args.cmd == "should-skip":
        print("skip" if rc == 0 else "run")
    elif args.cmd == "pending":
        print("\n".join(out["pending"]) or "(no pending intents)")
    else:
        print(json.dumps(out, indent=2))
    return rc


if __name__ == "__main__":
    core.run_main(main)
