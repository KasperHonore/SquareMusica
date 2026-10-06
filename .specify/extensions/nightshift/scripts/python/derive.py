#!/usr/bin/env python3
"""Derive Nightshift pieces (one per tasks.md phase) for a Spec Kit feature.

Read-only: prints the pieces in dependency order. Pieces are never stored.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_core as core  # noqa: E402
import nightshift_model as model  # noqa: E402


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--feature", help="feature directory (default: SPECIFY_FEATURE_DIRECTORY or .specify/feature.json)")
    ap.add_argument("--json", action="store_true", help="print JSON")
    args = ap.parse_args(argv)
    root = core.find_project_root()
    fdir = core.resolve_feature_dir(root, args.feature)
    record = core.load_record(core.record_path(root, fdir.name))
    d = model.derive(root, fdir, record)
    if args.json:
        core.emit_json(model.derivation_json(d))
    else:
        print(f"Feature: {d.feature}  ({len(d.pieces)} pieces, {len(d.doc.tasks)} tasks)")
        for i, p in enumerate(d.pieces, 1):
            ids = [t.id for t in p.tasks]
            span = f"{ids[0]}..{ids[-1]}" if ids else "-"
            after = f"  after: {', '.join(p.depends_on)}" if p.depends_on else ""
            print(f"{i}. {p.key:<16} {p.title}  [{len(ids)} tasks {span}]{after}")
        for prob in d.problems:
            print(f"ERROR: {prob['message']}", file=sys.stderr)
    return 1 if d.problems else 0


if __name__ == "__main__":
    core.run_main(main)
