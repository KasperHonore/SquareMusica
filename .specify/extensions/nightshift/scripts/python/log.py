#!/usr/bin/env python3
"""Append to and read the run's logbook.

- ``append --piece --step --outcome [--sha] [--detail]``: one ``log.jsonl`` entry;
- ``tail [-n N]``: the last N entries.

``--bug SLUG`` (exclusive with ``--feature``) addresses a fix run (``bug-<slug>``).

The logbook is append-only; entries are never rewritten. Timestamps are ISO 8601 with the local time zone offset
(D20). Append-only is **mechanical** for this CLI and **behavioural** otherwise:
an agent with file access could still edit the files.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_core as core  # noqa: E402
import nightshift_model as model  # noqa: E402
import nightshift_state as nstate  # noqa: E402

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    scope = ap.add_mutually_exclusive_group()
    scope.add_argument("--feature", help="feature directory")
    scope.add_argument("--bug", metavar="SLUG", help="a fix run (bug-<slug>) instead of a feature")
    ap.add_argument("--json", action="store_true", help="print JSON")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("append")
    p.add_argument("--piece", required=True)
    p.add_argument("--step", required=True)
    p.add_argument("--outcome", required=True)
    p.add_argument("--sha")
    p.add_argument("--detail", default="")
    p = sub.add_parser("tail")
    p.add_argument("-n", type=int, default=20)
    for sp in sub.choices.values():
        sp.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="print JSON")
    args = ap.parse_args(argv)
    root = core.find_project_root()
    name = f"bug-{model.bug_dir(root, args.bug).name}" if args.bug else core.resolve_feature_dir(root, args.feature).name
    st = nstate.load(root, name)

    if args.cmd == "append":
        if not args.outcome.strip() or not args.piece.strip():
            raise core.NightshiftError("--piece and --outcome must not be empty")
        detail = args.detail
        if args.step == "dashboard":  # every publish is an event; the URL alone repeats (D10 dedup)
            seen = sum(1 for e in nstate.read_jsonl(nstate.run_dir(root, name) / "log.jsonl")
                       if e.get("step") == "dashboard" and e.get("run_id") == st.get("run_id"))
            detail = f"{detail} (publish {seen + 1})".strip()
        out = nstate.log(root, name, st, piece=args.piece, step=args.step, outcome=args.outcome,
                         sha=args.sha, detail=detail)
    else:
        entries = nstate.read_jsonl(nstate.run_dir(root, name) / "log.jsonl")
        out = {"entries": entries[-args.n:] if args.n > 0 else []}
        if not args.json:
            for e in out["entries"]:
                print(f"{e['ts']}  {e['piece']:<12} {e['step']:<16} {e['outcome']:<14} "
                      f"{(e.get('sha') or '')[:12]:<12} {e.get('detail', '')}")
            return 0
    if args.json:
        core.emit_json(out)
    else:
        print(json.dumps(out))
    return 0


if __name__ == "__main__":
    core.run_main(main)
