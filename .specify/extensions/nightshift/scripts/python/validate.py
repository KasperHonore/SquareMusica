#!/usr/bin/env python3
"""Validate a Spec Kit feature (or a reported bug) for Nightshift.

Checks structure, drift against the approved baseline, acceptance-quote
hashes, the dependency graph, loop prerequisites and the run contract, and
computes readiness. Read-only. Exits 1 when any error is found.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_core as core  # noqa: E402
import nightshift_model as model  # noqa: E402


def print_report(rep: model.Report) -> None:
    d = rep.derivation
    print(f"Feature: {d.feature}")
    print(f"Delivery record: {rep.record_path}{'' if rep.record else ' (not created yet)'}")
    for p in d.pieces:
        loop = ((rep.record.get("pieces") or {}).get(p.key) or {}).get("loop", "-")
        print(f"  {p.key:<16} loop={loop:<8} {model.readiness_label(rep.readiness[p.key])}")
    print_findings(rep.findings)


def print_findings(findings: list[model.Finding]) -> None:
    errors = [f for f in findings if f.severity == "error"]
    warnings = [f for f in findings if f.severity == "warning"]
    for f in errors:
        print(f"ERROR [{f.code}] {f.message}")
    for f in warnings:
        print(f"WARNING [{f.code}] {f.message}")
    print("Validation " + ("passed" if not errors else f"FAILED ({len(errors)} error(s))"))


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--feature", help="feature directory (default: SPECIFY_FEATURE_DIRECTORY or .specify/feature.json)")
    ap.add_argument("--bug", metavar="SLUG", help="validate a reported bug instead of a feature")
    ap.add_argument("--loop", choices=core.LOOPS, help="with --bug: check this loop's prerequisites")
    ap.add_argument("--json", action="store_true", help="print JSON")
    args = ap.parse_args(argv)
    root = core.find_project_root()
    if args.bug:
        bug, findings = model.validate_bug(root, args.bug, args.loop)
        ok = not any(f.severity == "error" for f in findings)
        if args.json:
            core.emit_json({"bug": bug.slug, "verdict": bug.verdict, "ok": ok,
                            "findings": [f.as_dict() for f in findings]})
        else:
            print(f"Bug: {bug.slug}  verdict={bug.verdict or '-'}")
            print_findings(findings)
        return 0 if ok else 1
    rep = model.validate_feature(root, core.resolve_feature_dir(root, args.feature))
    if args.json:
        core.emit_json(rep.as_dict())
    else:
        print_report(rep)
    return 0 if rep.ok else 1


if __name__ == "__main__":
    core.run_main(main)
