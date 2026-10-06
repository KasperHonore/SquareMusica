#!/usr/bin/env python3
"""Get a Spec Kit feature (or a reported bug) ready for a Nightshift run.

``check`` (read-only, no GitHub calls) derives and validates the pieces, prints
the readiness table, the recommended loop per piece, a run-contract summary and
the issues that would be published. Exits 1 when validation fails. A piece
waiting on a product question does not block the batch: it stays parked (P6).

``go`` is the owner's approval: it freezes the run contract and baseline
(``shape --approve``) and publishes the issues (``publish --apply``) to the
repository named by ``--repo``, which must match ``origin``. Re-running it is
idempotent: an approved batch is not re-approved and issues are found by marker.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import grounding  # noqa: E402
import nightshift_config as config  # noqa: E402
import nightshift_core as core  # noqa: E402
import nightshift_github as github  # noqa: E402
import nightshift_model as model  # noqa: E402
import publish  # noqa: E402
import shape  # noqa: E402
import validate  # noqa: E402

# What to fix, and with which Spec Kit command, per finding code.
FIX = {
    "task-outside-phase": "fix tasks.md with /speckit-tasks",
    "duplicate-task-id": "fix tasks.md with /speckit-tasks",
    "no-phases": "regenerate tasks.md with /speckit-tasks",
    "dependency-cycle": "fix the phase dependencies with /speckit-tasks",
    "remap-required": "tasks were renumbered after approval; say how old IDs map to new ones, then shape --revoke and go",
    "description-changed": "the approved batch no longer matches tasks.md: shape --revoke, then ready again",
    "scheduling-changed": "the approved batch no longer matches tasks.md: shape --revoke, then ready again",
    "task-added": "the approved batch no longer matches tasks.md: shape --revoke, then ready again",
    "acceptance-changed": "the approved batch no longer matches spec.md: shape --revoke, then ready again",
    "acceptance-removed": "the approved batch no longer matches spec.md: shape --revoke, then ready again",
    "loop-prerequisite": "add the missing item through /speckit-specify or /speckit-clarify (bug: bug.assess)",
    "contract-changed": "the run contract was edited after approval: shape --revoke, then ready again",
    "contract-missing": "the run contract is missing: shape --revoke, then ready again",
    "quality-bar": "name a quality bar that is text or a file under .specify/delivery/",
    "bug-verdict-missing": "finish the assessment with bug.assess",
    "bug-not-a-loop": "route it as the reason says",
}
REASON_FIX = {
    "clarification": "open product question: answer it with /speckit-clarify",
    "decision": "open product decision on a blocker: answer it",
    "no acceptance check": "add an Independent Test or acceptance scenarios with /speckit-specify",
    "drift": "tasks or acceptance changed since approval",
    "loop prerequisites": "see the loop-prerequisite error",
    "plan stale": "the code now contradicts the plan: re-run /speckit-plan (and /speckit-tasks) for it",
}


def parse_bars(values: list[str]) -> dict[str, str]:
    out = {}
    for v in values or []:
        key, sep, bar = v.partition("=")
        if not sep or not key.strip() or not bar.strip():
            raise core.NightshiftError(f"--quality-bar expects PIECE=TEXT-or-PATH, got {v!r}")
        out[key.strip()] = bar.strip()
    return out


def _fixes(findings: list[model.Finding], readiness: dict[str, dict[str, Any]]) -> list[str]:
    out: list[str] = []
    for f in findings:
        if f.severity == "error":
            hint = FIX.get(f.code)
            out.append(f"{f.code}: {hint}" if hint else f.code)
    for key, r in readiness.items():
        for reason in r["reasons"]:
            if reason in REASON_FIX:
                out.append(f"{key}: {REASON_FIX[reason]}")
    return list(dict.fromkeys(out))


def _limits(root: Path) -> dict[str, Any]:
    try:
        cfg = config.load(root)
    except core.NightshiftError:
        cfg = {}
    return {"max_rounds": cfg.get("max_rounds", 3), "wall_clock": cfg.get("wall_clock", "8h")}


DONE = {
    "build": "checks green, every acceptance scenario passes, a fresh critic approves at the SHA",
    "fix": "a reproduction that failed before passes after, a regression test, checks green",
}


def contract_summary(root: Path, rep: model.Report, record: dict[str, Any]) -> dict[str, Any]:
    d = rep.derivation
    entries = record.get("pieces") or {}
    title = rep.spec.title if rep.spec else d.name
    pieces = []
    for p in d.pieces:
        e = entries.get(p.key) or {}
        done = DONE.get(e.get("loop", ""), "")
        if e.get("quality_bar"):
            done += f"; quality bar met: {str(e['quality_bar']).strip()}"
        pieces.append({"key": p.key, "title": p.title, "loop": e.get("loop", ""),
                       "reason": e.get("reason", ""), "done": done})
    return {
        "outcome": f"{title}: {len(d.pieces)} pieces delivered or honestly parked",
        "constraints": "spec.md is the source of truth; protected paths: "
        + (", ".join(record.get("protected_paths") or []) or "none recorded"),
        "pieces": pieces,
        "limits": _limits(root),
        "stop": "a product decision parks the piece and its dependants; the round cap parks a piece",
        "handover": "one feature PR into main with a preview at its head SHA; you merge",
    }


def check_feature(root: Path, fdir: Path, bars: dict[str, str]) -> tuple[dict[str, Any], bool]:
    stored = core.load_record(core.record_path(root, fdir.name))
    approved = bool(stored.get("approval"))
    if approved and bars:
        raise core.NightshiftError("the batch is approved; a new quality bar needs shape --revoke first")
    record = stored if approved else shape.proposed_record(
        root, model.derive(root, fdir, stored), stored, bars)
    ground = grounding.for_ready(root, fdir, record)
    rep = model.validate_feature(root, fdir, record, assume_approved=True, grounding=ground)
    # Something must be able to start, now or after its dependencies (live L1 1.1.0:
    # "Ready. Say go" with every piece parked).
    runnable = [k for k, r in rep.readiness.items() if r["status"] in ("ready", "waiting")]
    ready = rep.ok and bool(runnable)
    out: dict[str, Any] = {**rep.as_dict(), "ready": ready, "approved": approved, "grounding": ground,
                           "fix": _fixes(rep.findings, rep.readiness), "runnable": runnable}
    if rep.ok and not runnable:
        out["fix"] = ["no piece can start, now or after its dependencies; resolve the items below first",
                      *out["fix"]]
    if out["ready"]:
        out["contract"] = contract_summary(root, rep, record)
        plan, _ = publish.feature_plan(root, fdir, record)
        out["publish"] = plan
    return out, out["ready"]


def check_bug(root: Path, slug: str) -> tuple[dict[str, Any], bool]:
    route, reason = model.bug_route(core.parse_bug(model.bug_dir(root, slug)))
    bug, findings = model.validate_bug(root, slug, "fix" if route == "fix" else None)
    if route not in core.LOOPS:
        findings.append(model.Finding("error", "bug-not-a-loop", f"route to {route}: {reason}"))
    ready = not any(f.severity == "error" for f in findings)
    out: dict[str, Any] = {"bug": slug, "verdict": bug.verdict, "route": route,
                           "loop": route if route in core.LOOPS else None, "reason": reason,
                           "ready": ready, "findings": [f.as_dict() for f in findings],
                           "fix": _fixes(findings, {})}
    if ready:
        plan, _ = publish.bug_plan(root, slug, {"loop": route, "reason": reason})
        out["publish"] = plan
    return out, ready


def print_check(out: dict[str, Any]) -> None:
    if "bug" in out:
        print(f"Bug: {out['bug']}  verdict={out['verdict'] or '-'}")
        print(f"  {'loop' if out['loop'] else 'route to'}: {out['route']}  {out['reason']}")
        validate.print_findings([model.Finding(**f) for f in out["findings"]])
    else:
        print(f"Feature: {out['feature']}{'  (approved)' if out['approved'] else ''}")
        for p in out["pieces"]:
            print(f"  {p['key']:<16} loop={p['loop'] or '-':<8} {model.readiness_label(p['readiness'])}")
        validate.print_findings([model.Finding(**f) for f in out["findings"]])
        print("\nGrounding (plan vs. code): " + "\n".join(grounding.summary(out["grounding"])))
    if not out["ready"]:
        print("\nNot ready. To fix:")
        for line in out["fix"] or ["see the errors above"]:
            print(f"  - {line}")
        return
    if out["fix"]:
        print("\nThese pieces stay parked (the rest can run):")
        for line in out["fix"]:
            print(f"  - {line}")
    c = out.get("contract")
    if c:
        print("\nRun contract")
        print(f"  Outcome:     {c['outcome']}")
        print(f"  Constraints: {c['constraints']}")
        for p in c["pieces"]:
            print(f"  {p['key']:<16} {p['loop']:<6} {p['reason']}. Done: {p['done']}")
        print(f"  Limits:      {c['limits']['max_rounds']} review rounds per piece, "
              f"{c['limits']['wall_clock']} wall clock, the Claude plan's usage limit")
        print(f"  Stop:        {c['stop']}")
        print(f"  Handover:    {c['handover']}")
    print()
    publish.print_plan(out["publish"], False)
    print("\nReady. Say \"go\" to approve and publish (ready.py go --repo <owner/name>).")


def _refuse(out: dict[str, Any], what: str) -> None:
    for f in out["findings"]:
        if f["severity"] == "error":
            print(f"ERROR [{f['code']}] {f['message']}", file=sys.stderr)
    for line in out["fix"]:
        print(f"  - {line}", file=sys.stderr)
    raise core.NightshiftError(f"not ready; {what}. Run ready check")


def go_feature(root: Path, fdir: Path, args: argparse.Namespace) -> dict[str, Any]:
    out, ready = check_feature(root, fdir, parse_bars(args.quality_bar))
    if not ready:
        _refuse(out, "nothing approved or published")
    rpath = core.record_path(root, fdir.name)
    if out["approved"]:
        record = core.load_record(rpath)
        approved_now = False
    else:
        record = shape.approve(root, fdir, args.approved_by, parse_bars(args.quality_bar), out["grounding"])
        approved_now = True
    plan, rep = publish.feature_plan(root, fdir)
    if not rep.ok:
        raise core.NightshiftError("validation failed after approval; nothing published")
    published = publish.apply_plan(root, rpath, plan, record, args.repo)
    return {"feature": out["feature"], "approved_now": approved_now,
            "contract": record["approval"]["contract"],
            "contract_hash": record["approval"]["contract_hash"], **published}


def go_bug(root: Path, slug: str, args: argparse.Namespace) -> dict[str, Any]:
    out, ready = check_bug(root, slug)
    if not ready:
        _refuse(out, "nothing recorded or published")
    record = shape.record_bug(root, slug)
    plan, findings = publish.bug_plan(root, slug)
    if any(f.severity == "error" for f in findings):
        raise core.NightshiftError("validation failed; nothing published")
    published = publish.apply_plan(root, core.record_path(root, f"bug-{slug}"), plan, record, args.repo)
    return {"bug": slug, "loop": record["loop"], **published}


def check_repo(root: Path, args: argparse.Namespace) -> None:
    """Refuse before approving anything when ``--repo`` is not ``origin`` (H15).
    ``publish.apply_plan`` checks again, with the record, before any GitHub call."""
    remote = github.remote_repo(root)
    if not args.repo:
        raise core.NightshiftError(f"go needs --repo; origin is {remote}")
    if args.repo.lower() != remote.lower():
        raise core.NightshiftError(f"--repo {args.repo} does not match origin ({remote}); nothing written")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("action", choices=("check", "go"))
    ap.add_argument("--feature", help="feature directory (default: SPECIFY_FEATURE_DIRECTORY or .specify/feature.json)")
    ap.add_argument("--bug", metavar="SLUG", help="a reported bug instead of a feature")
    ap.add_argument("--quality-bar", action="append", metavar="PIECE=TEXT-or-PATH",
                    help="a quality bar the owner named for a piece (gauntlet style); repeatable")
    ap.add_argument("--repo", metavar="OWNER/NAME", help="go: the repository to publish to; must match origin")
    ap.add_argument("--approved-by", default="user", help="go: name recorded with the approval")
    ap.add_argument("--json", action="store_true", help="print JSON")
    args = ap.parse_args(argv)
    root = core.find_project_root()
    if args.bug and args.quality_bar:
        raise core.NightshiftError("--quality-bar applies to feature pieces, not a bug")
    if args.action == "check":
        if args.bug:
            out, ready = check_bug(root, args.bug)
        else:
            out, ready = check_feature(root, core.resolve_feature_dir(root, args.feature),
                                       parse_bars(args.quality_bar))
        if args.json:
            core.emit_json(out)
        else:
            print_check(out)
        return 0 if ready else 1
    check_repo(root, args)
    if args.bug:
        res = go_bug(root, args.bug, args)
    else:
        res = go_feature(root, core.resolve_feature_dir(root, args.feature), args)
    if args.json:
        core.emit_json(res)
    else:
        if "contract" in res:
            print(("Approved" if res["approved_now"] else "Already approved")
                  + f". Run contract: {res['contract']} (hash {res['contract_hash']})")
        else:
            print(f"Bug {res['bug']} recorded in the {res['loop']} loop.")
        print(f"Published to {res['repo']}")
        for a in res["actions"]:
            num = f"#{a['number']}" if a["number"] else "-"
            print(f"  {a['action']:<18} {a['key']:<16} {num:<6} {a['detail']}")
        for w in res["warnings"]:
            print(f"WARNING {w}")
        print(f"Apply: {res['writes']} write call(s) to GitHub")
        print("Commit .specify/delivery/ before the run (preflight refuses a dirty tree).")
    return 0


if __name__ == "__main__":
    core.run_main(main)
