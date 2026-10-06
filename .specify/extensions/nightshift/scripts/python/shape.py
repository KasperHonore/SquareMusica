#!/usr/bin/env python3
"""Loop recommendation and batch approval for Nightshift (used by ``ready.py``).

Deterministic rules (design §6.1): build by default, fix for a promised,
reproduced bug. ``--approve`` records the loops, renders the run contract and
freezes its hash and the task/acceptance baseline in the delivery record;
``--revoke`` drops the approval so the owner can change the batch by day (then
``ready go`` again). ``amend`` (internal, ``blocker.py absorb``) re-freezes an
approved batch after the owner's answer was committed, keeping the approval and
recording the answer. Only the delivery record and the run contract are written.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_core as core  # noqa: E402
import grounding  # noqa: E402
import nightshift_model as model  # noqa: E402

VERSION = core.VERSION


def recommend(piece: model.Piece, entry: dict[str, Any]) -> tuple[str, str, bool]:
    """Return (loop, one-line reason, convergence flag)."""
    if piece.kind == "convergence":
        return "build", "Convergence phase: gaps the owner chose to build", True
    if piece.kind == "module":
        return "build", "Module phase with settled tasks", False
    if piece.kind == "story":
        return "build", f"{piece.story} behaviour is specified and its tasks are settled", False
    if piece.kind in ("setup", "foundational"):
        return "build", "Shared infrastructure with settled tasks", False
    if piece.kind == "polish":
        return "build", "Cross-cutting tasks are settled", False
    return "build", "Tasks are settled", False


def render_contract(root: Path, rep: model.Report, record: dict[str, Any], approved_at: str) -> str:
    d = rep.derivation
    entries = record.get("pieces") or {}
    title = rep.spec.title if rep.spec else d.name
    loops = sorted({(entries.get(p.key) or {}).get("loop", "") for p in d.pieces})
    evidence = {
        "build": "script-run checks green, every acceptance scenario passes, the critic approves at the SHA",
        "fix": "a reproduction that failed before and passes after, a regression test, checks green",
    }
    config = record.get("limits") or {}
    return core.render_template(root, "run-contract.md", {
        "feature": d.feature,
        "approved_at": approved_at,
        "outcome": f"{title}: {len(d.pieces)} pieces delivered or honestly parked",
        "scope": ", ".join(p.key for p in d.pieces),
        "protected_paths": ", ".join(f"`{x}`" for x in record.get("protected_paths") or []) or "none recorded",
        "evidence": "; ".join(f"{l}: {evidence[l]}" for l in loops if l in evidence),
        "max_rounds": config.get("max_rounds", 3),
        "wall_clock": config.get("wall_clock", "8h"),
        "pieces": "\n".join(
            f"- `{p.key}` ({p.title}): **{(entries.get(p.key) or {}).get('loop')}**. "
            f"{(entries.get(p.key) or {}).get('reason', '')}"
            + (f". Quality bar: {(entries.get(p.key) or {})['quality_bar'].strip()}"
               if (entries.get(p.key) or {}).get("quality_bar") else "")
            for p in d.pieces
        ),
    })


def proposed_record(root: Path, d: model.Derivation, record: dict[str, Any],
                    bars: dict[str, str] | None = None) -> dict[str, Any]:
    """The delivery record with a loop for every piece and the named quality bars.

    A piece that already has a loop keeps it; the rest get the rule recommendation.
    Returns a copy; nothing is written.
    """
    bars = bars or {}
    unknown = [k for k in bars if k not in {p.key for p in d.pieces}]
    if unknown:
        raise core.NightshiftError(f"quality bar names unknown piece(s): {', '.join(unknown)}")
    out = dict(record)
    entries: dict[str, Any] = dict(out.get("pieces") or {})
    for p in d.pieces:
        entry = dict(entries.get(p.key) or {})
        if not entry.get("loop"):
            loop, reason, _ = recommend(p, entry)
            entry.update({"loop": loop, "reason": reason, "source": "rule"})
        if p.key in bars:
            entry["quality_bar"] = bars[p.key]
        entries[p.key] = entry
    out.setdefault("schema", core.SCHEMA_VERSION)
    out["feature"] = d.feature
    out["pieces"] = entries
    for k, v in (("protected_paths", []), ("blockers", []), ("issues", {"parent": None, "pieces": {}}),
                 ("approval", None)):
        out.setdefault(k, v)
    return out


def approve(root: Path, fdir: Path, approved_by: str = "user",
            bars: dict[str, str] | None = None, checked: dict[str, Any] | None = None) -> dict[str, Any]:
    """Validate, record the loops, render the run contract and freeze its hash and the
    task/acceptance baseline. Writes only the delivery record and the run contract."""
    rpath = core.record_path(root, fdir.name)
    stored = core.load_record(rpath)
    if stored.get("approval"):
        raise core.NightshiftError("already approved; run shape --revoke first to change it")
    record = proposed_record(root, model.derive(root, fdir, stored), stored, bars)
    rep = model.validate_feature(root, fdir, record)
    errors = [f for f in rep.findings if f.severity == "error"]
    if errors:
        for f in errors:
            print(f"ERROR [{f.code}] {f.message}", file=sys.stderr)
        raise core.NightshiftError("validation failed; the batch cannot be approved")
    approved_at = core.now_iso()
    contract = render_contract(root, rep, record, approved_at)
    cpath = model.contract_path(root, fdir.name)
    cpath.parent.mkdir(parents=True, exist_ok=True)
    cpath.write_text(contract, encoding="utf-8")
    record["approval"] = {
        "approved_at": approved_at,
        "approved_by": approved_by,
        "contract": cpath.relative_to(root).as_posix(),
        "contract_hash": core.sha256_text(contract),
        "baseline": model.baseline(rep.derivation, rep.spec),
        **grounding.record_fields(root, fdir, checked),
    }
    core.save_record(rpath, record)
    return record


def amend(root: Path, fdir: Path, answer: str, notes: list[dict[str, str]] | None = None) -> dict[str, Any]:
    """Re-render the run contract and re-freeze its hash and baseline of an approved
    batch, after the owner's answer changed spec.md/tasks.md (core review stage 5b).
    The caller (``blocker.py absorb``) has checked that the change is absorbable. Keeps
    ``approved_by``/``approved_at``; appends ``{at, answer, old, new}`` to
    ``approval.amendments`` (with ``notes``: criteria that absorbed the answer, old ->
    new, and reworded tasks of passed pieces). Returns ``(old hash, new hash)`` in a dict."""
    rpath = core.record_path(root, fdir.name)
    record = core.load_record(rpath)
    approval = dict(record.get("approval") or {})
    if not approval:
        raise core.NightshiftError("the batch is not approved; nothing to amend")
    rep = model.validate_feature(root, fdir, {**record, "approval": None})
    errors = [f for f in rep.findings if f.severity == "error"]
    if errors:
        raise core.NightshiftError("validation failed: " + "; ".join(f"[{f.code}] {f.message}" for f in errors[:5]))
    contract = render_contract(root, rep, record, approval["approved_at"])
    cpath = model.contract_path(root, fdir.name)
    cpath.write_text(contract, encoding="utf-8")
    old, new = approval.get("contract_hash"), core.sha256_text(contract)
    approval["contract_hash"] = new
    approval["baseline"] = model.baseline(rep.derivation, rep.spec)
    entry = {"at": core.now_iso(), "answer": answer, "old": old, "new": new}
    if notes:
        entry["notes"] = notes
    approval.setdefault("amendments", []).append(entry)
    record["approval"] = approval
    core.save_record(rpath, record)
    return {"old": old, "new": new, "approval": approval}


def revoke(root: Path, fdir: Path) -> bool:
    rpath = core.record_path(root, fdir.name)
    record = core.load_record(rpath)
    if not record.get("approval"):
        return False
    record["approval"] = None
    core.save_record(rpath, record)
    return True


def record_bug(root: Path, slug: str) -> dict[str, Any]:
    """Record a promised, reproduced bug in the fix loop (``bug-<slug>.yml``)."""
    bug = core.parse_bug(model.bug_dir(root, slug))
    route, reason = model.bug_route(bug)
    if route not in core.LOOPS:
        raise core.NightshiftError(f"bug {bug.slug} does not enter a loop: {reason}")
    rpath = core.record_path(root, f"bug-{bug.slug}")
    record = core.load_record(rpath)
    record.update({"schema": core.SCHEMA_VERSION, "bug": bug.slug,
                   "loop": route, "reason": reason, "source": "rule"})
    record.setdefault("issues", {"bug": None})
    core.save_record(rpath, record)
    return record


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--feature", help="feature directory (default: SPECIFY_FEATURE_DIRECTORY or .specify/feature.json)")
    ap.add_argument("--bug", metavar="SLUG", help="with --approve: record a reported bug in the fix loop")
    ap.add_argument("--approve", action="store_true", help="approve the batch: freeze the run contract and baseline")
    ap.add_argument("--approved-by", default="user", help="name recorded with the approval")
    ap.add_argument("--revoke", action="store_true", help="revoke the approval so the batch can change")
    args = ap.parse_args(argv)
    if args.approve == args.revoke:
        raise core.NightshiftError("choose one of --approve and --revoke (the daytime command is ready.py)")
    root = core.find_project_root()
    if args.bug:
        if args.revoke:
            raise core.NightshiftError("--revoke applies to a feature batch, not a bug")
        rec = record_bug(root, args.bug)
        print(f"Bug {args.bug} recorded in the {rec['loop']} loop: {rec['reason']}")
        return 0
    fdir = core.resolve_feature_dir(root, args.feature)
    if args.revoke:
        if revoke(root, fdir):
            print(f"Approval revoked in {core.record_path(root, fdir.name)}. Approve again with ready go.")
        else:
            print("Nothing to revoke: the batch is not approved.")
        return 0
    record = approve(root, fdir, args.approved_by)
    print(f"Approved. Run contract: {root / record['approval']['contract']}")
    print(f"Contract hash: {record['approval']['contract_hash']}")
    return 0


if __name__ == "__main__":
    core.run_main(main)
