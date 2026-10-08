#!/usr/bin/env python3
"""Get a Spec Kit feature ready for a Nightshift run, then approve and publish it.

``check`` (read-only, no GitHub calls) derives the pieces from ``tasks.md``, validates
them, and prints the readiness table, the grounding line, the run contract and the
issues ``go`` would publish. It exits 1 when validation fails or no piece can start. A
piece waiting on a product question does not block the batch: it stays parked (P6).
When the batch was approved before, what changed since is listed; ``go`` re-approves it.

``go`` is the owner's approval. It refuses before anything is written unless ``--repo``
is ``origin`` and ``check`` passes. Then it records a loop per piece, renders the run
contract, freezes the task and acceptance baseline in the delivery record, and creates or
updates the issues by marker. Re-running it re-approves the current files and is
otherwise idempotent. Only the delivery record, the run contract and (through ``gh``)
the issues are written; never ``spec.md``, ``plan.md`` or ``tasks.md`` (P1).
"""

from __future__ import annotations

import argparse
import json
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

VERSION = core.VERSION

# What to fix, and with which Spec Kit command, per finding code.
FIX = {
    "task-outside-phase": "fix tasks.md with /speckit-tasks",
    "duplicate-task-id": "fix tasks.md with /speckit-tasks",
    "no-phases": "regenerate tasks.md with /speckit-tasks",
    "dependency-cycle": "fix the phase dependencies with /speckit-tasks",
    "quality-bar": "name a quality bar that is text or a file under .specify/delivery/",
}
REASON_FIX = {
    "clarification": "open product question: answer it with /speckit-clarify",
    "no acceptance check": "add an Independent Test or acceptance scenarios with /speckit-specify",
}
DONE = "checks green, every acceptance scenario passes, a fresh critic approves at the SHA"


def parse_bars(values: list[str] | None) -> dict[str, str]:
    out = {}
    for v in values or []:
        key, sep, bar = v.partition("=")
        if not sep or not key.strip() or not bar.strip():
            raise core.NightshiftError(f"--quality-bar expects PIECE=TEXT-or-PATH, got {v!r}")
        out[key.strip()] = bar.strip()
    return out


# ---------------------------------------------------------------------------
# The record go would write, and the run contract
# ---------------------------------------------------------------------------


def proposed_record(d: model.Derivation, stored: dict[str, Any], bars: dict[str, str]) -> dict[str, Any]:
    """The delivery record with a loop for every derived piece and the named quality
    bars (a bar named earlier is kept). A copy; nothing is written."""
    unknown = [k for k in bars if k not in {p.key for p in d.pieces}]
    if unknown:
        raise core.NightshiftError(f"quality bar names unknown piece(s): {', '.join(unknown)}")
    old = stored.get("pieces") or {}
    pieces = {}
    for p in d.pieces:
        bar = bars.get(p.key) or (old.get(p.key) or {}).get("quality_bar")
        pieces[p.key] = {"loop": "build", **({"quality_bar": bar} if bar else {})}
    return {"schema": core.SCHEMA_VERSION, "feature": d.feature, "pieces": pieces,
            "protected_paths": stored.get("protected_paths") or [],
            "issues": stored.get("issues") or {"parent": None, "pieces": {}},
            "approval": stored.get("approval")}


def render_contract(root: Path, rep: model.Report, record: dict[str, Any], approved: str) -> str:
    """The run contract: the rendered goal of the night (P4). It binds nothing by hash;
    the approval baseline in the delivery record is what the run checks."""
    d = rep.derivation
    try:
        cfg = config.load(root)
    except core.NightshiftError:
        cfg = dict(config.DEFAULTS)
    entries = record.get("pieces") or {}
    lines = []
    for p in d.pieces:
        bar = (entries.get(p.key) or {}).get("quality_bar")
        lines.append(f"- `{p.key}` ({p.title}): **build**. Done: {DONE}"
                     + (f". Quality bar: {bar.strip()}" if bar else ""))
    return core.render_template(root, "run-contract.md", {
        "feature": d.feature, "approved": approved,
        "outcome": f"{rep.spec.title if rep.spec else d.name}: {len(d.pieces)} pieces delivered or honestly parked",
        "scope": ", ".join(p.key for p in d.pieces),
        "protected_paths": ", ".join(f"`{x}`" for x in record.get("protected_paths") or []) or "none recorded",
        "max_rounds": cfg.get("max_rounds", 3), "wall_clock": cfg.get("wall_clock", "8h"),
        "converge_rounds": (cfg.get("converge") or {}).get("max_rounds", 2),
        "pieces": "\n".join(lines)})


def approve(root: Path, fdir: Path, approved_by: str = "user", bars: dict[str, str] | None = None,
            checked: dict[str, Any] | None = None) -> dict[str, Any]:
    """Record the loops, render the run contract and freeze the task/acceptance baseline.
    Re-approves an approved batch. Refuses with nothing written when validation fails."""
    rpath = core.record_path(root, fdir.name)
    stored = core.load_record(rpath)
    record = proposed_record(model.derive(root, fdir), stored, bars or {})
    rep = model.validate_feature(root, fdir, {**record, "approval": None})
    errors = [f for f in rep.findings if f.severity == "error"]
    if errors:
        raise core.NightshiftError("validation failed; nothing approved: "
                                   + "; ".join(f"[{f.code}] {f.message}" for f in errors[:5]))
    at = core.now_iso()
    cpath = model.contract_path(root, fdir.name)
    cpath.parent.mkdir(parents=True, exist_ok=True)
    cpath.write_text(render_contract(root, rep, record, f"by {approved_by} at {at}"), encoding="utf-8")
    record["approval"] = {"approved_at": at, "approved_by": approved_by,
                          "contract": cpath.relative_to(root).as_posix(),
                          "baseline": model.baseline(rep.derivation, rep.spec),
                          **grounding.record_fields(root, fdir, checked)}
    core.save_record(rpath, record)
    return record


def rebaseline(root: Path, fdir: Path, answer: str, notes: list[dict[str, str]] | None = None) -> dict[str, Any]:
    """Re-freeze the baseline of an approved batch after an owner's answer changed
    spec.md/tasks.md (``blocker.py``). Keeps who approved and when; appends
    ``{at, answer, notes}`` to ``approval.amendments``. The caller decided the change is
    absorbable."""
    rpath = core.record_path(root, fdir.name)
    record = core.load_record(rpath)
    approval = dict(record.get("approval") or {})
    if not approval:
        raise core.NightshiftError("the batch is not approved; nothing to rebaseline")
    rep = model.validate_feature(root, fdir, {**record, "approval": None})
    errors = [f for f in rep.findings if f.severity == "error"]
    if errors:
        raise core.NightshiftError("validation failed: " + "; ".join(f"[{f.code}] {f.message}" for f in errors[:5]))
    approval["baseline"] = model.baseline(rep.derivation, rep.spec)
    approval.setdefault("amendments", []).append({"at": core.now_iso(), "answer": answer,
                                                  **({"notes": notes} if notes else {})})
    record["approval"] = approval
    core.save_record(rpath, record)
    return approval


# ---------------------------------------------------------------------------
# Issues (a one-way projection of the repository, idempotent by marker)
# ---------------------------------------------------------------------------


def marker(**fields: str) -> str:
    return "<!-- " + core.MARKER_PREFIX + " " + " ".join(f"{k}={v}" for k, v in fields.items()) + " -->"


def _acceptance_lines(spec: core.SpecDoc | None, story: str = "") -> str:
    if spec is None:
        return "_No spec.md found._"
    return "\n".join(f"- [ ] **{s.ref}**: {s.text}" for s in spec.scenarios
                     if not story or s.story == story) or "_No acceptance scenarios._"


def issue_plan(root: Path, rep: model.Report) -> dict[str, Any]:
    """The parent issue, one sub-issue per piece and their links, each with its marker."""
    d, spec, record = rep.derivation, rep.spec, rep.record
    cached = (record.get("issues") or {}).get("pieces") or {}
    parent_cached = (record.get("issues") or {}).get("parent")
    title = spec.title if spec else d.name
    parent_body = core.render_template(root, "issue-parent.md", {
        "feature": d.feature, "title": title, "acceptance": _acceptance_lines(spec), "version": VERSION,
        "piece_list": "\n".join(f"- [ ] `{p.key}`: {p.title} ({len(p.tasks)} tasks)" for p in d.pieces)})
    issues = []
    for p in d.pieces:
        acceptance = []
        if p.labels.get("Independent Test"):
            acceptance.append(f"**Independent Test**: {p.labels['Independent Test']}")
        if p.story:
            acceptance.append(_acceptance_lines(spec, p.story))
        elif p.labels.get("Purpose"):
            acceptance.append(f"**Purpose**: {p.labels['Purpose']}")
        body = core.render_template(root, "issue-phase.md", {
            "feature": d.feature, "piece": p.key, "title": f"{title}: {p.title}",
            "phases": ", ".join(str(n) for n in p.phases),
            "readiness": model.readiness_label(rep.readiness[p.key]),
            "depends_on": ", ".join(f"`{x}`" for x in p.depends_on) or "nothing",
            "acceptance": "\n\n".join(acceptance) or "_None found._",
            "tasks": "\n".join(model.task_line(t) for t in p.tasks) or "_No tasks._", "version": VERSION})
        issues.append({"piece": p.key, "title": f"[{d.name}] {p.title}",
                       "marker": marker(feature=d.feature, phase=p.key),
                       "action": "update" if cached.get(p.key) else "create",
                       "cached_number": cached.get(p.key), "refs": p.refs(d.feature),
                       "depends_on": p.depends_on, "body": body})
    return {
        "mode": "dry-run", "feature": d.feature, "writes": 0,
        "parent": {"title": f"[{d.name}] {title}", "marker": marker(feature=d.feature, kind="parent"),
                   "action": "update" if parent_cached else "create", "cached_number": parent_cached,
                   "body": parent_body},
        "sub_issues": issues,
        "links": [{"type": "sub-issue", "parent": "parent", "child": i["piece"]} for i in issues]
        + [{"type": "blocked-by", "issue": i["piece"], "blocked_by": dep} for i in issues for dep in i["depends_on"]],
    }


def check_repo(root: Path, repo: str | None, record: dict[str, Any] | None = None) -> str:
    """The target repository, or a refusal before any GitHub call or write (H15)."""
    remote = github.remote_repo(root)
    if not repo:
        raise core.NightshiftError(f"go needs --repo; origin is {remote}")
    if repo.lower() != remote.lower():
        raise core.NightshiftError(f"--repo {repo} does not match origin ({remote}); nothing written")
    known = ((record or {}).get("issues") or {}).get("repo")
    if known and known.lower() != remote.lower():
        raise core.NightshiftError(f"the delivery record was published to {known}, but origin is now "
                                   f"{remote}; nothing written")
    return remote


def publish(root: Path, rpath: Path, plan: dict[str, Any], record: dict[str, Any], repo: str) -> dict[str, Any]:
    """Write the plan to GitHub (idempotent by marker) and cache the issue numbers."""
    gh = github.Gh(repo, root)
    issues = record.get("issues") or {}
    out = github.apply(gh, plan, issues.get("published") or {})
    record["issues"] = {**issues, "repo": repo, "published": out.published, "parent": out.numbers.get("parent"),
                        "pieces": {k: v for k, v in out.numbers.items() if k != "parent"}}
    core.save_record(rpath, record)
    return {"repo": repo, "actions": out.actions, "warnings": out.warnings, "writes": gh.writes,
            "numbers": out.numbers}


# ---------------------------------------------------------------------------
# check and go
# ---------------------------------------------------------------------------


def _fixes(findings: list[model.Finding], readiness: dict[str, dict[str, Any]]) -> list[str]:
    out = [f"{f.code}: {FIX[f.code]}" if f.code in FIX else f.code for f in findings if f.severity == "error"]
    out += [f"{k}: {REASON_FIX[r]}" for k, rd in readiness.items() for r in rd["reasons"] if r in REASON_FIX]
    return list(dict.fromkeys(out))


def check(root: Path, fdir: Path, bars: dict[str, str]) -> tuple[dict[str, Any], model.Report]:
    """What ``go`` would approve now. Read-only."""
    stored = core.load_record(core.record_path(root, fdir.name))
    record = proposed_record(model.derive(root, fdir), stored, bars)
    ground = grounding.for_ready(root, fdir, record)
    rep = model.validate_feature(root, fdir, {**record, "approval": None}, assume_approved=True,
                                 grounding=ground)
    base = (stored.get("approval") or {}).get("baseline")
    changed = model.check_drift(rep.derivation, rep.spec, base)[0] if base else []
    # Something must be able to start, now or after its dependencies (live L1 1.1.0:
    # "Ready. Say go" with every piece parked).
    runnable = [k for k, r in rep.readiness.items() if r["status"] in ("ready", "waiting")]
    out: dict[str, Any] = {**rep.as_dict(), "ready": rep.ok and bool(runnable), "runnable": runnable,
                           "approved": bool(stored.get("approval")), "grounding": ground,
                           "changed_since_approval": [{"code": f.code, "message": f.message} for f in changed],
                           "fix": _fixes(rep.findings, rep.readiness), "released_on_go": parked_in_run(root, fdir)}
    if rep.ok and not runnable:
        out["fix"].insert(0, "no piece can start, now or after its dependencies; resolve the items below first")
    if out["ready"]:
        out["contract"] = render_contract(root, rep, record, "on go")
        out["publish"] = issue_plan(root, rep)
    return out, rep


def parked_in_run(root: Path, fdir: Path) -> list[dict[str, Any]]:
    """Pieces parked in this feature's run: ``go`` releases them to ``pending`` with a fresh
    round budget (``blocker.release_reapproved``, at the next pick). Read-only."""
    path = root / ".nightshift" / fdir.name / "state.json"
    try:
        pieces = json.loads(path.read_text(encoding="utf-8")).get("pieces") or {}
    except (OSError, ValueError):
        return []
    return [{"piece": k, "reason": p.get("reason"), "question": p.get("question")}
            for k, p in pieces.items() if p.get("status") == "parked"]


def print_check(out: dict[str, Any]) -> None:
    print(f"Feature: {out['feature']}{'  (approved before)' if out['approved'] else ''}")
    for p in out["pieces"]:
        print(f"  {p['key']:<16} {model.readiness_label(p['readiness'])}")
    for f in out["findings"]:
        print(f"{f['severity'].upper()} [{f['code']}] {f['message']}")
    print("\nGrounding (plan vs. code): " + "\n".join(grounding.summary(out["grounding"])))
    if out["changed_since_approval"]:
        print("\nChanged since the last approval (go re-approves these):")
        for c in out["changed_since_approval"]:
            print(f"  - [{c['code']}] {c['message']}")
    if not out["ready"]:
        print("\nNot ready. To fix:")
        for line in out["fix"] or ["see the errors above"]:
            print(f"  - {line}")
        return
    if out["fix"]:
        print("\nThese pieces stay parked (the rest can run):")
        for line in out["fix"]:
            print(f"  - {line}")
    if out["released_on_go"]:
        print("\nParked in the run; go puts them back in the queue with fresh review rounds:")
        for r in out["released_on_go"]:
            print(f"  - {r['piece']} ({r['reason']})" + (f": {r['question']}" if r["question"] else ""))
    print("\n" + out["contract"])
    plan = out["publish"]
    print(f"Issues (dry run): {plan['parent']['action']} parent {plan['parent']['title']}")
    for i in plan["sub_issues"]:
        num = f" #{i['cached_number']}" if i["cached_number"] else ""
        print(f"  {i['action']} sub-issue{num} {i['title']}  ({', '.join(i['refs'])})")
    for link in plan["links"]:
        if link["type"] == "blocked-by":
            print(f"  {link['issue']} blocked by {link['blocked_by']}")
    print("\nReady. Say \"go\" to approve and publish (ready.py go --repo <owner/name>).")


def go(root: Path, fdir: Path, repo: str | None, approved_by: str, bars: dict[str, str]) -> dict[str, Any]:
    repo = check_repo(root, repo, core.load_record(core.record_path(root, fdir.name)))
    out, _ = check(root, fdir, bars)
    if not out["ready"]:
        for f in out["findings"]:
            if f["severity"] == "error":
                print(f"ERROR [{f['code']}] {f['message']}", file=sys.stderr)
        for line in out["fix"]:
            print(f"  - {line}", file=sys.stderr)
        raise core.NightshiftError("not ready; nothing approved or published. Run ready check")
    record = approve(root, fdir, approved_by, bars, out["grounding"])
    rep = model.validate_feature(root, fdir, record)
    published = publish(root, core.record_path(root, fdir.name), issue_plan(root, rep), record, repo)
    return {"feature": out["feature"], "reapproved": out["approved"], "contract": record["approval"]["contract"],
            **published}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", choices=("check", "go"))
    ap.add_argument("--feature", help="feature directory (default: SPECIFY_FEATURE_DIRECTORY or .specify/feature.json)")
    ap.add_argument("--quality-bar", action="append", metavar="PIECE=TEXT-or-PATH",
                    help="a quality bar the owner named for a piece (gauntlet style); repeatable")
    ap.add_argument("--repo", metavar="OWNER/NAME", help="go: the repository to publish to; must match origin")
    ap.add_argument("--approved-by", default="user", help="go: name recorded with the approval")
    ap.add_argument("--json", action="store_true", help="print JSON")
    args = ap.parse_args(argv)
    root = core.find_project_root()
    fdir = core.resolve_feature_dir(root, args.feature)
    bars = parse_bars(args.quality_bar)
    if args.action == "check":
        out, _ = check(root, fdir, bars)
        core.emit_json(out) if args.json else print_check(out)
        return 0 if out["ready"] else 1
    res = go(root, fdir, args.repo, args.approved_by, bars)
    if args.json:
        core.emit_json(res)
        return 0
    print(f"{'Re-approved' if res['reapproved'] else 'Approved'}. Run contract: {res['contract']}")
    print(f"Published to {res['repo']}")
    for a in res["actions"]:
        print(f"  {a['action']:<18} {a['key']:<16} {'#' + str(a['number']) if a['number'] else '-':<6} {a['detail']}")
    for w in res["warnings"]:
        print(f"WARNING {w}")
    print("Commit .specify/delivery/ before the run (preflight refuses a dirty tree).")
    return 0


if __name__ == "__main__":
    core.run_main(main)
