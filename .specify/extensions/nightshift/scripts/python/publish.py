#!/usr/bin/env python3
"""Project a feature or a reported bug to GitHub issues.

By default this is a dry run: it renders the parent issue, one sub-issue per
piece and the links, each carrying a hidden ``speckit-nightshift`` marker, and
makes no network or ``gh`` calls at all. ``--apply --repo OWNER/NAME`` writes
them through ``gh``, idempotently by marker, and only for an approved, valid
batch whose repository matches ``origin``. ``--reconcile`` reports what was
changed on GitHub by hand without writing anything.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_core as core  # noqa: E402
import nightshift_github as github  # noqa: E402
import nightshift_model as model  # noqa: E402

VERSION = core.VERSION


def marker(**fields: str) -> str:
    return "<!-- " + core.MARKER_PREFIX + " " + " ".join(f"{k}={v}" for k, v in fields.items()) + " -->"


def _acceptance_lines(spec: core.SpecDoc | None, story: str = "") -> str:
    if spec is None:
        return "_No spec.md found._"
    lines = []
    for s in spec.scenarios:
        if story and s.story != story:
            continue
        lines.append(f"- [ ] **{s.ref}**: {s.text}")
    return "\n".join(lines) or "_No acceptance scenarios._"


def feature_plan(root: Path, fdir: Path, record: dict[str, Any] | None = None
                 ) -> tuple[dict[str, Any], model.Report]:
    """``record`` replaces the stored delivery record (``ready check`` shows the plan
    with the recommended loops before anything is written)."""
    rep = model.validate_feature(root, fdir, record, assume_approved=record is not None)
    d, spec, record = rep.derivation, rep.spec, rep.record
    entries = record.get("pieces") or {}
    cached = ((record.get("issues") or {}).get("pieces") or {})
    parent_cached = (record.get("issues") or {}).get("parent")
    title = spec.title if spec else d.name
    piece_list = "\n".join(
        f"- [ ] `{p.key}`: {p.title} ({len(p.tasks)} tasks, loop {(entries.get(p.key) or {}).get('loop') or 'not shaped'})"
        for p in d.pieces
    )
    parent_body = core.render_template(root, "issue-parent.md", {
        "feature": d.feature,
        "title": title,
        "piece_list": piece_list,
        "acceptance": _acceptance_lines(spec),
        "version": VERSION,
    })
    issues = []
    for p in d.pieces:
        e = entries.get(p.key) or {}
        acceptance = []
        if p.labels.get("Independent Test"):
            acceptance.append(f"**Independent Test**: {p.labels['Independent Test']}")
        if p.story:
            acceptance.append(_acceptance_lines(spec, p.story))
        elif p.labels.get("Purpose"):
            acceptance.append(f"**Purpose**: {p.labels['Purpose']}")
        tasks = "\n".join(
            f"- [{'x' if t.done else ' '}] {t.id}{' [P]' if t.parallel else ''}"
            f"{' [' + t.story + ']' if t.story else ''} {t.description}"
            for t in p.tasks
        )
        body = core.render_template(root, "issue-phase.md", {
            "feature": d.feature,
            "piece": p.key,
            "title": f"{title}: {p.title}",
            "phases": ", ".join(str(n) for n in p.phases),
            "loop": e.get("loop") or "not shaped",
            "loop_reason": e.get("reason", ""),
            "readiness": model.readiness_label(rep.readiness[p.key]),
            "depends_on": ", ".join(f"`{x}`" for x in p.depends_on) or "nothing",
            "acceptance": "\n\n".join(acceptance) or "_None found._",
            "tasks": tasks or "_No tasks._",
            "version": VERSION,
        })
        issues.append({
            "piece": p.key,
            "title": f"[{d.name}] {p.title}",
            "marker": marker(feature=d.feature, phase=p.key),
            "action": "update" if cached.get(p.key) else "create",
            "cached_number": cached.get(p.key),
            "refs": p.refs(d.feature),
            "depends_on": p.depends_on,
            "body": body,
        })
    plan = {
        "mode": "dry-run",
        "kind": "feature",
        "feature": d.feature,
        "parent": {
            "title": f"[{d.name}] {title}",
            "marker": marker(feature=d.feature, kind="parent"),
            "action": "update" if parent_cached else "create",
            "cached_number": parent_cached,
            "body": parent_body,
        },
        "sub_issues": issues,
        "links": [{"type": "sub-issue", "parent": "parent", "child": i["piece"]} for i in issues]
        + [{"type": "blocked-by", "issue": i["piece"], "blocked_by": dep} for i in issues for dep in i["depends_on"]],
        "writes": 0,
    }
    return plan, rep


def bug_plan(root: Path, slug: str, record: dict[str, Any] | None = None
             ) -> tuple[dict[str, Any], list[model.Finding]]:
    bug, findings = model.validate_bug(root, slug, None)
    route, reason = model.bug_route(bug)
    if record is None:
        record = core.load_record(core.record_path(root, f"bug-{slug}"))
    loop = record.get("loop") or (route if route in core.LOOPS else "")
    if route not in core.LOOPS:
        findings.append(model.Finding("error", "bug-not-a-loop", f"bug {slug} is not published as a fix: {reason}"))
    body = core.render_template(root, "issue-bug.md", {
        "slug": slug,
        "title": bug.title,
        "verdict": bug.verdict or "-",
        "severity": bug.fields.get("Severity", "-"),
        "loop": loop or "none",
        "loop_reason": record.get("reason") or reason,
        "symptom": bug.sections.get("Symptom", "_Missing._"),
        "reproduction": bug.reproduction or "_Missing._",
        "version": VERSION,
    })
    cached = (record.get("issues") or {}).get("bug")
    plan = {
        "mode": "dry-run",
        "kind": "bug",
        "bug": slug,
        "issue": {
            "title": f"[bug] {bug.title}",
            "marker": marker(bug=slug),
            "action": "update" if cached else "create",
            "cached_number": cached,
            "body": body,
        },
        "sub_issues": [],
        "links": [],
        "writes": 0,
    }
    return plan, findings


def print_plan(plan: dict[str, Any], show_bodies: bool) -> None:
    print("Publish plan (dry-run: nothing is written to GitHub)")
    if plan["kind"] == "bug":
        i = plan["issue"]
        print(f"\n{i['action'].upper()} issue  {i['title']}\n  marker: {i['marker']}")
        if show_bodies:
            print("\n" + i["body"])
        print("\nSub-issues: none")
        return
    p = plan["parent"]
    print(f"\n{p['action'].upper()} parent  {p['title']}\n  marker: {p['marker']}")
    if show_bodies:
        print("\n" + p["body"])
    for i in plan["sub_issues"]:
        num = f" (#{i['cached_number']})" if i["cached_number"] else ""
        print(f"\n{i['action'].upper()} sub-issue{num}  {i['title']}\n  marker: {i['marker']}")
        print(f"  tasks: {', '.join(i['refs'])}")
        if show_bodies:
            print("\n" + i["body"])
    print("\nLinks:")
    for link in plan["links"]:
        if link["type"] == "sub-issue":
            print(f"  parent <- sub-issue {link['child']}")
        else:
            print(f"  {link['issue']} blocked by {link['blocked_by']}")


def cached_numbers(plan: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    issues = record.get("issues") or {}
    if plan["kind"] == "bug":
        return {"bug": issues.get("bug")}
    return {"parent": issues.get("parent"), **(issues.get("pieces") or {})}


def check_apply_preconditions(root: Path, plan: dict[str, Any], record: dict[str, Any],
                              repo_arg: str | None) -> str:
    """Return the target repo, or raise before any GitHub call (H15)."""
    if plan["kind"] == "feature" and not record.get("approval"):
        raise core.NightshiftError("the batch is not approved; run ready go first")
    if plan["kind"] == "bug" and record.get("loop") != "fix":
        raise core.NightshiftError("the bug is not shaped into the fix loop; run ready go --bug <slug> first")
    remote = github.remote_repo(root)
    if not repo_arg:
        raise core.NightshiftError(f"--apply needs --repo; origin is {remote}")
    if repo_arg.lower() != remote.lower():
        raise core.NightshiftError(f"--repo {repo_arg} does not match origin ({remote}); nothing written")
    known = (record.get("issues") or {}).get("repo")
    if known and known.lower() != remote.lower():
        raise core.NightshiftError(f"the delivery record was published to {known}, but origin is now "
                                   f"{remote}; nothing written")
    return remote


def save_numbers(rpath: Path, record: dict[str, Any], plan: dict[str, Any], repo: str,
                 numbers: dict[str, int], published: dict[str, str] | None = None) -> None:
    issues = dict(record.get("issues") or {})
    issues["repo"] = repo
    if published is not None:
        issues["published"] = published
    if plan["kind"] == "bug":
        issues["bug"] = numbers.get("bug")
    else:
        issues["parent"] = numbers.get("parent")
        issues["pieces"] = {k: v for k, v in numbers.items() if k != "parent"}
    record["issues"] = issues
    core.save_record(rpath, record)


def apply_plan(root: Path, rpath: Path, plan: dict[str, Any], record: dict[str, Any],
               repo_arg: str | None) -> dict[str, Any]:
    """Write the plan to GitHub (idempotent by marker) and record the issue numbers."""
    repo = check_apply_preconditions(root, plan, record, repo_arg)
    gh = github.Gh(repo, root)
    out = github.apply(gh, plan, (record.get("issues") or {}).get("published") or {})
    save_numbers(rpath, record, plan, repo, out.numbers, out.published)
    return {"repo": repo, "actions": out.actions, "warnings": out.warnings,
            "writes": gh.writes, "numbers": out.numbers}


def print_outcome(out: github.Outcome, writes: int, mode: str) -> None:
    for a in out.actions:
        num = f"#{a['number']}" if a["number"] else "-"
        print(f"  {a['action']:<18} {a['key']:<16} {num:<6} {a['detail']}")
    for w in out.warnings:
        print(f"WARNING {w}")
    print(f"{mode}: {writes} write call(s) to GitHub")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--feature", help="feature directory (default: SPECIFY_FEATURE_DIRECTORY or .specify/feature.json)")
    ap.add_argument("--bug", metavar="SLUG", help="publish a reported bug instead of a feature")
    ap.add_argument("--dry-run", action="store_true", default=True, help="print the plan (the default)")
    ap.add_argument("--apply", action="store_true", help="create or update the issues on GitHub")
    ap.add_argument("--repo", metavar="OWNER/NAME", help="with --apply: the target repository, must match origin")
    ap.add_argument("--reconcile", action="store_true", help="report hand edits on GitHub; writes nothing")
    ap.add_argument("--bodies", action="store_true", help="print the rendered issue bodies")
    ap.add_argument("--json", action="store_true", help="print JSON")
    args = ap.parse_args(argv)
    if args.apply and args.reconcile:
        raise core.NightshiftError("choose one of --apply and --reconcile")
    root = core.find_project_root()
    if args.bug:
        plan, findings = bug_plan(root, args.bug)
        errors = [f for f in findings if f.severity == "error"]
        rpath = core.record_path(root, f"bug-{args.bug}")
    else:
        plan, rep = feature_plan(root, core.resolve_feature_dir(root, args.feature))
        errors = [f for f in rep.findings if f.severity == "error"]
        rpath = rep.record_path
        if rep.remap_required:
            plan["refused"] = "remap required"
    record = core.load_record(rpath)
    if args.reconcile:
        gh = github.Gh(github.remote_repo(root), root)
        out = github.reconcile(gh, plan, cached_numbers(plan, record),
                               (record.get("issues") or {}).get("published") or {})
        if args.json:
            core.emit_json({"mode": "reconcile", "actions": out.actions, "warnings": out.warnings,
                            "writes": gh.writes})
        else:
            print(f"Reconcile against {gh.repo} (read-only; the delivery record is not changed)")
            print_outcome(out, gh.writes, "Reconcile")
        drift = [a for a in out.actions if a["action"] != "in-sync"]
        return 2 if drift else 0
    if errors:
        for f in errors:
            print(f"ERROR [{f.code}] {f.message}", file=sys.stderr)
        print("Publish refused: validation failed. Nothing was planned or written.", file=sys.stderr)
        return 1
    if args.apply:
        res = apply_plan(root, rpath, plan, record, args.repo)
        if args.json:
            core.emit_json({"mode": "apply", **res})
        else:
            print(f"Published to {res['repo']}")
            print_outcome(github.Outcome(actions=res["actions"], warnings=res["warnings"]),
                          res["writes"], "Apply")
        return 0
    if args.json:
        core.emit_json(plan)
    else:
        print_plan(plan, args.bodies)
    return 0


if __name__ == "__main__":
    core.run_main(main)
