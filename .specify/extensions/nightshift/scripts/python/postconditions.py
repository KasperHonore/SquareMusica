#!/usr/bin/env python3
"""Postconditions and gate integrity after a builder turn (design §6.2 step 3, D-ESFREV).

Given the piece, the phase base SHA and the builder's worktree, check:

- ``no-commit``: HEAD moved past the base;
- ``dirty``: the worktree is clean (``.nightshift/`` ignored);
- ``edits-spec``: ``spec.md`` and ``plan.md`` are byte-identical to the base, and
  ``tasks.md`` differs only in checkboxes (any ID, description or other edit fails);
- ``ticks-other-phase``: every checkbox change belongs to a task of this piece, and never
  to an untraced task of a Convergence piece (``excluded``; D-3');
- ``protected-path``: when the delivery record lists ``protected_paths``, every
  changed path lies inside them (the feature's ``tasks.md`` is governed above);
- ``gate_tampered``: each file matching a gate glob (config ``gate_paths``) has the
  same content hash at the base, at HEAD and in the worktree: ``git rev-parse
  <base>:<path>`` against ``git rev-parse HEAD:<path>`` and ``git hash-object
  <worktree>/<path>``, never a diff. Added and deleted gate files count.

Edited test files are listed in ``edited_tests`` for the critic; that is not a
failure. Only when nothing above is violated is ``<worktree>/.nightshift/blocked.json``
honoured (outcome ``blocked``, the piece is parked ``builder_blocked``). A gate
tamper always wins over a blocked file (D5c). A builder that writes blocked.json
need not have committed, so ``no-commit`` is waived for an honest stop; every
other check still applies.

All of these are **mechanical** safeguards: they read git objects, not the
builder's account. They run after the builder, so they detect rather than prevent;
the prevention side (not handing the builder the gate files) is behavioural.

Exit codes: 0 passed, 1 violation (including ``gate_tampered``), 2 blocked.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Any

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_config as config  # noqa: E402
import nightshift_core as core  # noqa: E402
import nightshift_model as model  # noqa: E402
import nightshift_state as nstate  # noqa: E402

TEST_GLOBS = ["tests/**", "**/tests/**"]
TEST_NAME_GLOBS = ["test_*.py", "*_test.*", "*.test.*"]


def git(cwd: Path, *args: str, check: bool = True) -> str:
    try:
        res = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise core.NightshiftError(f"git {' '.join(args)} failed: {exc}") from exc
    if check and res.returncode != 0:
        raise core.NightshiftError(f"git {' '.join(args)} failed: {res.stderr.strip()}")
    return res.stdout if res.returncode == 0 else ""


def blob(cwd: Path, sha: str, path: str) -> str | None:
    res = subprocess.run(["git", "rev-parse", "--verify", "-q", f"{sha}:{path}"], cwd=cwd,
                         capture_output=True, text=True, timeout=60)
    return res.stdout.strip() if res.returncode == 0 else None


def show(cwd: Path, sha: str, path: str) -> str | None:
    res = subprocess.run(["git", "show", f"{sha}:{path}"], cwd=cwd, capture_output=True, timeout=60)
    return res.stdout.decode("utf-8", errors="replace") if res.returncode == 0 else None


def worktree_blob(wt: Path, path: str) -> str | None:
    p = wt / path
    if not p.is_file():
        return None
    return git(wt, "hash-object", "--", path).strip()


def is_test_path(path: str) -> bool:
    name = PurePosixPath(path).name
    return config.matches_any(path, TEST_GLOBS) or config.matches_any(name, TEST_NAME_GLOBS)


_CHECKBOX = core.TASK_RE


def _normalise_checkboxes(text: str) -> str:
    out = []
    for line in text.splitlines():
        m = _CHECKBOX.match(line)
        if m:
            s = m.start("check")
            line = line[:s] + " " + line[s + 1:]
        out.append(line)
    return "\n".join(out)


def check_tasks(base_text: str | None, head_text: str | None, piece: str,
                tasks_path: str, excluded: set[str] = frozenset()) -> list[dict[str, str]]:
    if base_text is None:
        return [{"code": "edits-spec", "detail": f"{tasks_path} is missing at the base commit"}]
    if head_text is None:
        return [{"code": "edits-spec", "detail": f"{tasks_path} was deleted"}]
    if base_text == head_text:
        return []
    if _normalise_checkboxes(base_text) != _normalise_checkboxes(head_text):
        return [{"code": "edits-spec",
                 "detail": f"{tasks_path} changed beyond checkboxes (task IDs, descriptions or other lines)"}]
    base_doc = core.parse_tasks_text(base_text, Path(tasks_path))
    head_doc = core.parse_tasks_text(head_text, Path(tasks_path))
    pieces = {p.key: {t.id for t in p.tasks} for p in model.group_pieces(base_doc)}
    if piece not in pieces:
        raise core.NightshiftError(f"piece {piece!r} is not derived from {tasks_path} at the base commit")
    mine = pieces[piece] - set(excluded)
    head_done = {t.line: t for t in head_doc.tasks}
    out = []
    for t in base_doc.tasks:
        h = head_done.get(t.line)
        if h is None or h.done == t.done:
            continue
        if t.id not in mine:
            verb = "ticked" if h.done else "unticked"
            why = "an untraced converge task (a product decision)" if t.id in excluded else f"not in piece {piece}"
            out.append({"code": "ticks-other-phase", "detail": f"{verb} {t.id}, which is {why}"})
    return out


FOUND_KINDS = ("blocker", "nonblocker")


def read_found(wt: Path, cfg: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    """Pre-existing breakage the builder reports in ``.nightshift/found.json`` (D-FOUND).

    Shape: ``[{"kind": "blocker"|"nonblocker", "summary": "...", "check": "<id>"}]``.
    A *blocker* is fixed inside the phase and must name its own regression check, a
    configured check id, so the fix is observed rather than claimed. A *nonblocker*
    is not fixed here; the orchestrator files it with ``found.py file``. The builder's
    classification is behavioural; the shape and the check id are mechanical."""
    path = wt / ".nightshift" / "found.json"
    if not path.is_file():
        return [], []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [], [f".nightshift/found.json is not valid JSON: {exc}"]
    if not isinstance(data, list):
        return [], [".nightshift/found.json must be a list"]
    ids = {c["id"] for c in cfg.get("checks") or []}
    out, errors = [], []
    for i, item in enumerate(data, 1):
        if not isinstance(item, dict) or item.get("kind") not in FOUND_KINDS \
                or not str(item.get("summary") or "").strip():
            errors.append(f"found.json item {i}: needs kind blocker|nonblocker and a summary")
            continue
        entry = {"kind": item["kind"], "summary": str(item["summary"]).strip()}
        if item["kind"] == "blocker":
            check = str(item.get("check") or "")
            if check not in ids:
                errors.append(f"found.json item {i}: a pre-existing blocker fixed in the phase needs its own "
                              f"check, one of the configured ids ({', '.join(sorted(ids)) or 'none'}); got {check!r}")
                continue
            entry["check"] = check
        out.append(entry)
    return out, errors


def evaluate(root: Path, fdir: Path, piece: str, base: str, wt: Path, cfg: dict[str, Any],
             record: dict[str, Any]) -> dict[str, Any]:
    feature = core.feature_id(root, fdir)
    base = git(wt, "rev-parse", "--verify", f"{base}^{{commit}}").strip()
    head = git(wt, "rev-parse", "HEAD").strip()
    violations: list[dict[str, str]] = []

    blocked_path = wt / ".nightshift" / "blocked.json"
    blocked_reason: str | None = None
    if blocked_path.is_file():
        try:
            data = json.loads(blocked_path.read_text(encoding="utf-8"))
            blocked_reason = str(data.get("reason") or "").strip() if isinstance(data, dict) else ""
        except (OSError, json.JSONDecodeError):
            blocked_reason = ""
        blocked_reason = blocked_reason or "(blocked.json without a reason)"

    if head == base and blocked_reason is None:
        violations.append({"code": "no-commit", "detail": f"HEAD is still the base {base[:12]}"})

    dirty = []
    for line in git(wt, "status", "--porcelain", "--untracked-files=all").splitlines():
        path = line[3:].split(" -> ")[-1].strip('"')
        if path == ".nightshift" or path.startswith(".nightshift/"):
            continue
        dirty.append(path)
    if dirty:
        violations.append({"code": "dirty", "detail": "uncommitted changes: " + ", ".join(sorted(dirty)[:20])})

    tasks_rel = f"{feature}/tasks.md"
    for name in ("spec.md", "plan.md"):
        rel = f"{feature}/{name}"
        if blob(wt, base, rel) != blob(wt, head, rel):
            violations.append({"code": "edits-spec", "detail": f"{rel} changed"})
    violations += check_tasks(show(wt, base, tasks_rel), show(wt, head, tasks_rel), piece, tasks_rel,
                              model.excluded_tasks(root, fdir, piece))

    changed = [p for p in git(wt, "diff", "--name-only", "--no-renames", base, head).splitlines() if p]
    protected = [str(x) for x in (record.get("protected_paths") or [])]
    if protected:
        outside = [p for p in changed if p != tasks_rel and not config.matches_any(p, protected)]
        if outside:
            violations.append({"code": "protected-path",
                               "detail": "changed outside protected_paths: " + ", ".join(outside[:20])})

    gates = cfg["gate_paths"]
    candidates = set()
    for sha in {base, head}:
        candidates.update(p for p in git(wt, "ls-tree", "-r", "--name-only", sha).splitlines()
                          if config.matches_any(p, gates))
    candidates.update(p for p in git(wt, "ls-files", "--others").splitlines()
                      if config.matches_any(p, gates))
    tampered = []
    for path in sorted(candidates):
        b, h, w = blob(wt, base, path), blob(wt, head, path), worktree_blob(wt, path)
        if b != h or b != w:
            tampered.append(path)
            violations.append({"code": "gate_tampered",
                               "detail": f"{path}: base {(b or 'absent')[:12]}, head {(h or 'absent')[:12]}, "
                                         f"worktree {(w or 'absent')[:12]}"})

    edited_tests = sorted({p for p in changed if is_test_path(p)} | {p for p in dirty if is_test_path(p)})
    found, found_errors = read_found(wt, cfg)
    for e in found_errors:
        violations.append({"code": "found-invalid", "detail": e})

    if tampered:
        outcome = "gate_tampered"
    elif violations:
        outcome = "failed"
    elif blocked_reason is not None:
        outcome = "blocked"
    else:
        outcome = "passed"
    return {
        "feature": feature, "piece": piece, "base": base, "head": head,
        "ok": not violations, "outcome": outcome, "violations": violations,
        "edited_tests": edited_tests, "found": found,
        "blocked_reason": blocked_reason if outcome == "blocked" else None,
        "blocked_ignored": blocked_reason is not None and outcome != "blocked",
    }


def record_state(root: Path, name: str, result: dict[str, Any]) -> list[str]:
    """Record the outcome in run state and logbook (if a run exists)."""
    if not nstate.state_path(root, name).is_file():
        return ["no run state; nothing recorded"]
    notes: list[str] = []
    st = nstate.load(root, name)
    key, outcome, head = result["piece"], result["outcome"], result["head"]
    p = nstate.piece(st, key)
    step = f"{key}:{p.get('round') or 0}:postconditions"
    inputs = {"base": result["base"], "head": head, "outcome": outcome,
              "violations": sorted(v["code"] for v in result["violations"])}
    if nstate.step_done(st, step, inputs):
        return ["already recorded for this round and head; nothing written twice"]
    nstate.step_intent(st, step, inputs)
    nstate.set_sub(st, key, "builder", "passed" if outcome == "passed" else "failed")
    if outcome == "passed":
        # D-FOUND: pre-existing blockers fixed in the phase, each with its own check
        # (listed separately in the feature PR); non-blockers wait for found.py.
        prefixed = p.setdefault("prefixed", [])
        for f in result.get("found") or []:
            if f["kind"] == "blocker":
                row = {"summary": f["summary"], "check_id": f["check"], "sha": head}
                if not any(x["summary"] == row["summary"] for x in prefixed):
                    prefixed.append(row)
        p["found_pending"] = [f["summary"] for f in result.get("found") or [] if f["kind"] == "nonblocker"
                              and f["summary"] not in [x.get("summary") for x in p.get("found") or []]]
    if head != result["base"]:
        p["candidate_sha"] = head
    park = {"gate_tampered": "gate_tampered", "blocked": "builder_blocked"}.get(outcome)
    if park:
        try:
            nstate.transition(st, key, "parked", by="postconditions", reason=park)
            if outcome == "blocked":
                p["question"] = result["blocked_reason"]
        except core.NightshiftError as exc:
            notes.append(f"state not changed: {exc}")
    elif outcome != "passed":
        # A failed attempt goes to `checking` with builder=failed, so `verdict next`
        # bounds the retries exactly like red checks (max_rounds, stagnation).
        # `phase build` has usually moved it there already; the violations are
        # recorded either way, so the next builder sees what failed (live 2026-10-08).
        if p["status"] == "building":
            nstate.transition(st, key, "checking")
        p["postcondition_violations"] = sorted({f"postconditions:{v['code']}" for v in result["violations"]})
        p["postcondition_details"] = [f"postconditions:{v['code']}: {v['detail']}" for v in result["violations"]]
    else:
        p.pop("postcondition_violations", None)
        p.pop("postcondition_details", None)
    nstate.save(root, name, st)
    detail = "; ".join(f"{v['code']}: {v['detail']}" for v in result["violations"])
    if outcome == "blocked":
        detail = f"builder blocked: {result['blocked_reason']}"
    if result["edited_tests"]:
        detail = (detail + "; " if detail else "") + "edited tests: " + ", ".join(result["edited_tests"])
    nstate.log(root, name, st, piece=key, step="postconditions", outcome=outcome, sha=head, detail=detail)
    for f in p.get("prefixed") or []:
        nstate.log(root, name, st, piece=key, step="found", outcome="prefixed", sha=head,
                   detail=f"pre-existing blocker fixed in the phase: {f['summary']} (check {f['check_id']})")
    nstate.step_complete(st, step, inputs, {"outcome": outcome})
    nstate.save(root, name, st)
    return notes


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--feature", help="feature directory")
    ap.add_argument("--piece", required=True, help="piece key, e.g. us1")
    ap.add_argument("--base", required=True, help="phase base SHA")
    ap.add_argument("--worktree", help="the builder's worktree (default: the current checkout)")
    ap.add_argument("--config", help="nightshift-config.yml to use")
    ap.add_argument("--no-record", action="store_true", help="do not write state or logbook")
    ap.add_argument("--json", action="store_true", help="print JSON")
    args = ap.parse_args(argv)
    root = core.find_project_root()
    fdir = core.resolve_feature_dir(root, args.feature)
    name = fdir.name
    cfg = config.load(root, args.config)
    record = core.load_record(core.record_path(root, name))
    wt = Path(args.worktree).resolve() if args.worktree else root
    if not wt.is_dir():
        raise core.NightshiftError(f"worktree not found: {wt}")
    result = evaluate(root, fdir, args.piece, args.base, wt, cfg, record)
    result["notes"] = [] if args.no_record else record_state(root, name, result)
    if args.json:
        core.emit_json(result)
    else:
        print(f"Postconditions for {result['piece']} at {result['head'][:12]}: {result['outcome']}")
        for v in result["violations"]:
            print(f"  VIOLATION [{v['code']}] {v['detail']}")
        if result["blocked_reason"]:
            print(f"  BLOCKED: {result['blocked_reason']}")
        if result["blocked_ignored"]:
            print("  blocked.json ignored: postconditions failed")
        for t in result["edited_tests"]:
            print(f"  edited test: {t}")
        for n in result["notes"]:
            print(f"  note: {n}")
    return {"passed": 0, "blocked": 2}.get(result["outcome"], 1)


if __name__ == "__main__":
    core.run_main(main)
