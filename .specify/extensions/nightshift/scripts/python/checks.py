#!/usr/bin/env python3
"""Run the configured checks at an exact SHA (design §6.2 step 4, D-VER).

Each check from ``nightshift-config.yml`` runs in argv form (no shell), with its
own timeout, in a fresh detached checkout of ``--sha`` (``git worktree add
--detach``) that is removed afterwards. Every check runs even when an earlier
one fails. Only exit codes count: a builder's claims are never read (D-VER).

Evidence goes to ``.nightshift/<feature>/evidence/<piece>/<sha>/checks.json`` (or
``evidence/_combined/<sha>/`` with ``--combined``), one log file per check beside
it. Each result is ``{id, sha, argv, exit, duration_s, log, origin:
"script-observed", timed_out}``.

With ``--piece`` and an existing run, the piece's ``checks`` sub-status is set to
``passed`` or ``failed`` and a logbook entry is appended.

**Environment error** (D23: a full /tmp made all five checks exit 1 in under 3 s with
empty logs). When every check failed *and* every log is empty (0 bytes), the run is
classified ``environment_error``, not ``failed``: the evidence says so, the piece's
``checks`` sub-status is left untouched, the logbook records outcome
``environment_error``, the resume step stays
open (a retry runs again) and the exit code is 3. The same holds when the clean
checkout or the evidence directory cannot be created or written (ENOSPC, EDQUOT,
permissions; 1.1.3, L1 phase D): no check ran, ``environment_detail`` says why. Anything else (one check green, one
byte of output, a timeout, a check that cannot start) is a normal failure. The
heuristic is mechanical; what the orchestrator does next (retry once, then stop with
``environment_failure``) is behavioural.

**A fix piece's done condition** (loop ``fix``, a bug run ``--bug SLUG``; core review
stage 2, P4). Before the configured checks, the reproduction rule runs, by script:
``.nightshift/repro.json`` in the piece's worktree names ``{check_id, argv}``. The oldest
commit after the piece's base (the *repro commit*) must change test files only, and
``argv`` must name one of them. ``argv`` runs in a clean detached checkout at the repro
commit (it must **fail**) and at ``--sha`` (it must **pass**), and the repro test files
must be unchanged between the two (they stay as the regression test). The result is the
piece's ``repro`` in run state (script-owned, P3) and ``repro`` in ``checks.json``. A
refused reproduction fails the checks without running the others; ``verdict.py next``
then restarts the round from the base. That the test exercises the reported symptom is
**behavioural** (the builder's, judged by the critic).

Safeguards: running in a clean checkout and judging by exit code are
**mechanical**. Which SHA is passed in is the orchestrator's choice
(**behavioural**); the evidence names it so a mismatch is visible.

Exit codes: 0 all checks green, 1 any check red or timed out (or a refusal),
3 environment error (see above).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_config as config  # noqa: E402
import nightshift_core as core  # noqa: E402
import nightshift_model as model  # noqa: E402
import nightshift_state as nstate  # noqa: E402
import postconditions  # noqa: E402

COMBINED = "_combined"
ENV_ERROR_EXIT = 3


def git(cwd: Path, *args: str) -> str:
    res = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=300)
    if res.returncode != 0:
        raise core.NightshiftError(f"git {' '.join(args)} failed: {res.stderr.strip()}")
    return res.stdout.strip()


def origin_feature_head(root: Path, branch: str) -> str:
    """The feature head GitHub has, never the local branch (D23b: it lagged origin).

    Fetches without ``+`` (a rewritten remote fails loudly), as ``phase_merge.fetch_branch``.
    """
    if not branch:
        raise core.NightshiftError("the run state names no feature_branch; pass --sha")
    git(root, "fetch", "-q", "origin", f"refs/heads/{branch}:refs/remotes/origin/{branch}")
    return git(root, "rev-parse", "--verify", f"refs/remotes/origin/{branch}^{{commit}}")


def run_one(check: dict[str, Any], sha: str, checkout: Path, log_path: Path) -> dict[str, Any]:
    start = time.monotonic()
    timed_out = False
    code: int | None
    env = core.tool_env({"NIGHTSHIFT_CHECK_SHA": sha})
    env.pop("SPECIFY_FEATURE_DIRECTORY", None)
    with log_path.open("wb") as log:
        try:
            proc = subprocess.Popen(check["argv"], cwd=checkout, stdout=log, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL, env=env, start_new_session=True)
        except OSError as exc:
            log.write(f"nightshift: cannot start {check['argv'][0]}: {exc}\n".encode())
            code = 127
        else:
            try:
                code = proc.wait(timeout=check["timeout"])
            except subprocess.TimeoutExpired:
                timed_out = True
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except OSError:
                    proc.kill()
                proc.wait()
                code = None
                log.write(f"\nnightshift: timed out after {check['timeout']}s\n".encode())
    return {
        "id": check["id"], "sha": sha, "argv": check["argv"],
        "exit": code, "duration_s": round(time.monotonic() - start, 3),
        "log": str(log_path), "origin": "script-observed", "timed_out": timed_out,
        "timeout_s": check["timeout"],
    }


class CheckoutFailure(core.NightshiftError):
    """The checks' clean checkout (or evidence dir) could not be created or written:
    ENOSPC, EDQUOT, permissions. An environment failure, never a red check (1.1.3)."""


def make_checkout(root: Path, out_dir: Path, sha: str) -> tuple[Path, Path]:
    tmp: Path | None = None
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkdtemp(prefix="nightshift-checks-"))
        checkout = tmp / sha[:12]
        git(root, "worktree", "add", "--detach", "--quiet", str(checkout), sha)
        return tmp, checkout
    except (OSError, core.NightshiftError) as exc:
        # ``sha`` was already resolved by rev-parse, so a failing ``worktree add`` is the
        # filesystem (L1 phase D: "unable to write file" x153 on a quota-full /tmp).
        if tmp is not None:
            subprocess.run(["git", "worktree", "prune"], cwd=root, capture_output=True, timeout=120)
            shutil.rmtree(tmp, ignore_errors=True)
        raise CheckoutFailure(f"cannot create the checks' checkout of {sha[:12]} in "
                              f"{tempfile.gettempdir()}: {str(exc)[-400:]}") from exc


def run_checks(root: Path, name: str, scope: str, sha: str, checks: list[dict[str, Any]]) -> dict[str, Any]:
    out_dir = nstate.run_dir(root, name) / "evidence" / scope / sha
    tmp, checkout = make_checkout(root, out_dir, sha)
    try:
        results = [run_one(c, sha, checkout, out_dir / f"{c['id']}.log") for c in checks]
    finally:
        subprocess.run(["git", "worktree", "remove", "--force", str(checkout)], cwd=root,
                       capture_output=True, timeout=120)
        subprocess.run(["git", "worktree", "prune"], cwd=root, capture_output=True, timeout=120)
        shutil.rmtree(tmp, ignore_errors=True)
    ok = bool(results) and all(r["exit"] == 0 and not r["timed_out"] for r in results)
    data = {"scope": scope, "sha": sha, "ok": ok, "environment_error": environment_error(results),
            "at": nstate.now(), "checks": results}
    tmpf = out_dir / "checks.json.tmp"
    tmpf.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    os.replace(tmpf, out_dir / "checks.json")
    data["evidence"] = str(out_dir / "checks.json")
    return data


def environment_error(results: list[dict[str, Any]]) -> bool:
    """Conservative: every check failed (non-zero exit, not a timeout) and every log is 0 bytes."""
    def empty(r: dict[str, Any]) -> bool:
        try:
            return Path(r["log"]).stat().st_size == 0
        except OSError:
            return False
    return bool(results) and all(r["exit"] not in (0, None) and not r["timed_out"] and empty(r)
                                 for r in results)


# ---------------------------------------------------------------------------
# The reproduction rule (a fix piece's done condition)
# ---------------------------------------------------------------------------

REPRO_FILE = ".nightshift/repro.json"


def _read_repro(wt: Path) -> dict[str, Any]:
    path = wt / REPRO_FILE
    if not path.is_file():
        raise ValueError(f"{REPRO_FILE} is missing: the builder must name its reproduction check")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{REPRO_FILE} is not valid JSON: {exc}") from exc
    argv = data.get("argv") if isinstance(data, dict) else None
    cid = str((data or {}).get("check_id") or "") if isinstance(data, dict) else ""
    if not cid or not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
        raise ValueError(f"{REPRO_FILE} needs check_id and a non-empty argv list of strings")
    return {"id": cid, "argv": argv, "timeout": int(data.get("timeout") or 300)}


def _names_test(argv: list[str], tests: list[str]) -> bool:
    joined = " ".join(argv)
    return any(t in joined or (t.endswith(".py") and t[:-3].replace("/", ".") in joined) for t in tests)


def evaluate_repro(root: Path, name: str, piece: str, wt: Path, base: str, head: str) -> dict[str, Any]:
    """Fails at the base side, passes at ``head``, test unchanged; never raises on a bad builder."""
    commits = git(wt, "rev-list", "--reverse", "--first-parent", f"{base}..{head}").split()
    out: dict[str, Any] = {"ok": False, "ran": False, "base_sha": base, "fix_sha": head, "repro_sha": None,
                           "check_id": None, "argv": None, "before_exit": None, "after_exit": None,
                           "test_files": []}
    try:
        check = _read_repro(wt)
    except ValueError as exc:
        return {**out, "reason": str(exc)}
    out.update(check_id=check["id"], argv=check["argv"])
    if len(commits) < 2:
        return {**out, "reason": "no reproduction commit before the fix commit (the failing test must be "
                                 "committed alone, first)"}
    repro = out["repro_sha"] = commits[0]
    changed = [x for x in git(wt, "diff", "--name-only", "--no-renames", base, repro).splitlines() if x]
    tests = [x for x in changed if postconditions.is_test_path(x)]
    others = [x for x in changed if not postconditions.is_test_path(x)]
    out["test_files"] = tests
    if others or not tests:
        return {**out, "reason": "the reproduction commit must add test files only; it also changes "
                                 + (", ".join(others) or "nothing testable")}
    if not _names_test(check["argv"], tests):
        return {**out, "reason": f"the reproduction argv does not name its test ({', '.join(tests)})"}
    moved = [t for t in tests if postconditions.blob(wt, repro, t) != postconditions.blob(wt, head, t)]
    if moved:
        return {**out, "reason": "the reproduction test changed after it was committed: " + ", ".join(moved)}
    before = run_checks(root, name, f"{piece}-repro", repro, [check])["checks"][0]
    after = run_checks(root, name, f"{piece}-repro", head, [check])["checks"][0]
    out.update(ran=True, before_exit=before["exit"], after_exit=after["exit"],
               before_log=before["log"], after_log=after["log"])
    if before["timed_out"] or before["exit"] == 0:
        return {**out, "reason": "the reproduction timed out before the fix" if before["timed_out"]
                else "the reproduction passes before the fix: it does not reproduce the bug"}
    if after["timed_out"] or after["exit"] != 0:
        return {**out, "reason": f"the reproduction still fails at the fix commit (exit {after['exit']})"}
    return {**out, "ok": True, "reason": "failed before the fix, passes after it"}


def run_piece(root: Path, name: str, piece: str, sha: str, checks: list[dict[str, Any]]) -> dict[str, Any]:
    """The checks of one piece at ``sha``; a fix piece runs its reproduction rule first."""
    st = nstate.load(root, name) if nstate.state_path(root, name).is_file() else None
    p = (st or {}).get("pieces", {}).get(piece) or {}
    if p.get("loop") != "fix":
        return run_checks(root, name, piece, sha, checks)
    wt = nstate.run_dir(root, name) / "worktrees" / piece
    repro = evaluate_repro(root, name, piece, wt if wt.is_dir() else root, p["base_sha"], sha)
    nstate.update(root, name, lambda s: s["pieces"][piece].__setitem__("repro", repro))
    nstate.log(root, name, nstate.load(root, name), piece=piece, step="repro",
               outcome="verified" if repro["ok"] else "refused", sha=sha,
               detail=f"{repro['reason']} (before exit {repro['before_exit']}, after exit {repro['after_exit']})")
    if repro["ok"]:
        result = run_checks(root, name, piece, sha, checks)
    else:  # the other checks would say nothing about a reproduction that does not hold
        result = run_checks(root, name, piece, sha, [])
        result["ok"] = False
    result["repro"] = repro
    path = Path(result["evidence"])
    data = json.loads(path.read_text(encoding="utf-8"))
    data.update(ok=result["ok"], repro=repro)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return result


def failure_detail(r: dict[str, Any]) -> str:
    cmd = " ".join(r["argv"])
    return f"{r['id']} ({cmd}) timed out after {r['timeout_s']}s" if r["timed_out"] else f"{r['id']} ({cmd}) exit {r['exit']}"


# Failing test names in a check log, cheaply (unittest, pytest, node:test/TAP, jest/vitest).
FAILED_TEST_RES = (
    re.compile(r"^(?:FAIL|ERROR): (\S+ \([^)]+\))", re.M),            # unittest
    re.compile(r"^FAILED (\S+::\S+)", re.M),                          # pytest -rf
    re.compile(r"^\s*not ok \d+ - (.+?)\s*$", re.M),                 # TAP / node --test
    re.compile(r"^\s*[\u2716\u2715\u00d7] (.+?)(?: \(\d+(?:\.\d+)?m?s\))?\s*$", re.M),  # node spec / vitest
    re.compile(r"^\s*\u25cf (.+?\u203a.+?)\s*$", re.M),               # jest "● Suite › test"
)
MAX_TEST_NAMES = 10


def failing_tests(log: Path) -> list[str]:
    """Up to ``MAX_TEST_NAMES`` failing test names from the tail of a check log."""
    try:
        with log.open("rb") as fh:
            fh.seek(0, 2)
            fh.seek(max(0, fh.tell() - 256_000))
            text = fh.read().decode("utf-8", "replace")
    except OSError:
        return []
    names: list[str] = []
    for rx in FAILED_TEST_RES:
        for m in rx.finditer(text):
            name = m.group(1).strip()
            if name and name not in names:
                names.append(name)
    return names[:MAX_TEST_NAMES]


def _failed_rows(ev: Path) -> list[dict[str, Any]] | None:
    try:
        data = json.loads((ev / "checks.json").read_text(encoding="utf-8"))
        rows = data.get("checks") if isinstance(data, dict) else data
        return [r for r in rows if r.get("exit") != 0 or r.get("timed_out")]
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def failing_ids(ev: Path) -> list[str]:
    """Stagnation identity of a red round: ``check:<argv>`` per failing check."""
    rows = _failed_rows(ev)
    names = sorted({" ".join(r["argv"]) if isinstance(r.get("argv"), list) else str(r.get("id"))
                    for r in rows or []})
    return [f"check:{n}" for n in names] or ["checks_failed"]


def findings(ev: Path) -> list[dict[str, Any]]:
    """One blocker finding per failing check in ``checks.json`` (check id, failing tests,
    log path) for the builder: red checks are findings (D23b)."""
    out = []
    for r in _failed_rows(ev) or []:
        state = "timed out" if r.get("timed_out") else f"exit {r.get('exit')}"
        tests = failing_tests(Path(r["log"])) if r.get("log") else []
        named = f"; failing tests: {', '.join(tests)}" if tests else ""
        out.append({"severity": "blocker", "category": "checks", "path": "-", "lines": "-",
                    "rationale": f"check `{r.get('id')}` failed at {str(r.get('sha') or '')[:12]} ({state}){named}; "
                                 f"log: {r.get('log') or '-'}"})
    return out


def record_state(root: Path, name: str, piece: str | None, result: dict[str, Any]) -> list[str]:
    if not nstate.state_path(root, name).is_file():
        return ["no run state; nothing recorded"]
    st = nstate.load(root, name)
    key = piece or COMBINED
    if result.get("environment_error"):
        nstate.log(root, name, st, piece=key, step="combined" if piece is None else "checks",
                   outcome="environment_error", sha=result["sha"],
                   detail=(result.get("environment_detail") or
                           f"all {len(result['checks'])} check(s) failed with empty logs "
                           f"(free space in {tempfile.gettempdir()}?)") + "; checks sub-status unchanged")
        return ["environment_error: not judged; retry once, then stop with environment_failure"]
    if piece:
        nstate.set_sub(st, piece, "checks", "passed" if result["ok"] else "failed")
        nstate.save(root, name, st)
    failed = [r for r in result["checks"] if r["exit"] != 0 or r["timed_out"]]
    detail = "; ".join(failure_detail(r) for r in failed) or f"{len(result['checks'])} check(s) green"
    if result.get("repro") and not result["repro"]["ok"]:
        detail = f"reproduction refused: {result['repro']['reason']}"
    nstate.log(root, name, st, piece=key, step="combined" if piece is None else "checks",
               outcome="passed" if result["ok"] else "failed", sha=result["sha"], detail=detail)
    return []


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--feature", help="feature directory")
    ap.add_argument("--bug", metavar="SLUG", help="a bug run (bug-<slug>) instead of a feature")
    scope = ap.add_mutually_exclusive_group(required=True)
    scope.add_argument("--piece", help="piece key; evidence under evidence/<piece>/<sha>/")
    scope.add_argument("--combined", action="store_true",
                       help="feature-branch head; evidence under evidence/_combined/<sha>/")
    ap.add_argument("--sha", help="commit to check (default with --combined: origin's feature-branch head, fetched; "
                         "never the local branch when a run state exists)")
    ap.add_argument("--config", help="nightshift-config.yml to use")
    ap.add_argument("--json", action="store_true", help="print JSON")
    args = ap.parse_args(argv)
    root = core.find_project_root()
    fdir, name = model.run_target(root, args.feature, args.bug)
    cfg = config.load(root, args.config)
    if not cfg["checks"]:
        raise core.NightshiftError(f"no checks configured ({cfg['source']}); nothing would be observed")
    ref = args.sha
    if not ref:
        if not args.combined:
            raise core.NightshiftError("--sha is required with --piece")
        ref = "HEAD"
        if nstate.state_path(root, name).is_file():
            ref = origin_feature_head(root, nstate.load(root, name).get("feature_branch") or "")
    sha = git(root, "rev-parse", "--verify", f"{ref}^{{commit}}")
    step = inputs = None
    if args.piece and nstate.state_path(root, name).is_file():
        st = nstate.load(root, name)
        p = nstate.piece(st, args.piece)  # refuse an unknown piece early
        # Resume record (design §7): the step is this SHA under these check definitions.
        step = f"{args.piece}:{p.get('round') or 0}:checks"
        inputs = {"sha": sha, "checks": [[c["id"], c["argv"], c["timeout"]] for c in cfg["checks"]]}
        done = nstate.step_done(st, step, inputs)
        evidence = nstate.run_dir(root, name) / "evidence" / args.piece / sha / "checks.json"
        if done and evidence.is_file():
            result = {**json.loads(evidence.read_text(encoding="utf-8")), "evidence": str(evidence),
                      "skipped": True, "notes": ["already run for this SHA and these checks"]}
            if args.json:
                core.emit_json(result)
            else:
                print(f"Checks at {sha[:12]}: already {'green' if result['ok'] else 'RED'} ({evidence})")
            return 0 if result["ok"] else 1
        nstate.step_intent(st, step, inputs)
        nstate.save(root, name, st)
    try:
        result = run_checks(root, name, COMBINED, sha, cfg["checks"]) if args.combined \
            else run_piece(root, name, args.piece, sha, cfg["checks"])
    except CheckoutFailure as exc:
        result = {"scope": COMBINED if args.combined else args.piece, "sha": sha, "ok": False,
                  "environment_error": True, "environment_detail": str(exc), "at": nstate.now(),
                  "checks": [], "evidence": None}
    result["notes"] = record_state(root, name, args.piece, result)
    if step and not result["environment_error"]:
        st = nstate.load(root, name)
        nstate.step_complete(st, step, inputs, {"ok": result["ok"], "evidence": result["evidence"]})
        nstate.save(root, name, st)
    if args.json:
        core.emit_json(result)
    else:
        for r in result["checks"]:
            state = "TIMEOUT" if r["timed_out"] else ("ok" if r["exit"] == 0 else f"exit {r['exit']}")
            print(f"  {r['id']:<20} {state:<8} {r['duration_s']:>7.2f}s  {' '.join(r['argv'])}")
        verdict = "ENVIRONMENT ERROR" if result["environment_error"] else ("green" if result["ok"] else "RED")
        print(f"Checks at {sha[:12]}: {verdict}  ({result['evidence'] or result.get('environment_detail')})")
    if result["environment_error"]:
        return ENV_ERROR_EXIT
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    core.run_main(main)
