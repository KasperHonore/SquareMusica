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

**Environment error.** A red that says nothing about the code is classified
``environment_error``, not ``failed``, when any of these holds:

- every check failed and every log is empty (D23: a full /tmp, five checks red in 3 s);
- a failed check's log says the disk is full or over quota (``No space left on device``,
  ``Disk quota exceeded``, ``ENOSPC``, ``EDQUOT``), or a failed install check
  (``install`` or ``npm ci`` in its id or argv) has an empty log (L1 phase E Finding 1: an
  EDQUOT inside ``npm ci`` broke the tests too, and the red was cached as a code failure);
- the clean checkout or the evidence directory cannot be created (1.1.3, L1 phase D).

Then the evidence says so, the piece's ``checks`` sub-status is left untouched, the
logbook records ``environment_error``, the step is never cached (a retry runs again) and
the exit code is 3. Anything else (a timeout, a check that cannot start, a red test with
output) is a normal failure. The classification is mechanical; what the orchestrator does
next (retry once, then stop with ``environment_failure``) is behavioural.

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
import nightshift_state as nstate  # noqa: E402

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


ENV_TEXT = re.compile(r"No space left on device|Disk quota exceeded|\bENOSPC\b|\bEDQUOT\b")
INSTALL = re.compile(r"\binstall\b|\bnpm ci\b", re.I)


def _tail(path: str) -> str:
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            fh.seek(max(0, fh.tell() - 256_000))
            return fh.read().decode("utf-8", "replace")
    except OSError:
        return ""


def environment_error(results: list[dict[str, Any]]) -> bool:
    """A red caused by the machine, not the code (see the module docstring)."""
    failed = [r for r in results if r["exit"] not in (0, None) and not r["timed_out"]]
    empty = [r for r in failed if not _tail(r["log"])]
    if results and len(empty) == len(results):
        return True
    return any(ENV_TEXT.search(_tail(r["log"])) for r in failed) or any(
        INSTALL.search(f"{r['id']} {' '.join(r['argv'])}") for r in empty)


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
                           "; ".join(failure_detail(r) for r in result["checks"] if r["exit"] != 0)
                           + f" (disk full or over quota in {tempfile.gettempdir()}?)") + "; checks sub-status unchanged")
        return ["environment_error: not judged; retry once, then stop with environment_failure"]
    if piece:
        nstate.set_sub(st, piece, "checks", "passed" if result["ok"] else "failed")
        nstate.save(root, name, st)
    failed = [r for r in result["checks"] if r["exit"] != 0 or r["timed_out"]]
    detail = "; ".join(failure_detail(r) for r in failed) or f"{len(result['checks'])} check(s) green"
    nstate.log(root, name, st, piece=key, step="combined" if piece is None else "checks",
               outcome="passed" if result["ok"] else "failed", sha=result["sha"], detail=detail)
    return []


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--feature", help="feature directory")
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
    name = core.resolve_feature_dir(root, args.feature).name
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
            else run_checks(root, name, args.piece, sha, cfg["checks"])
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
