#!/usr/bin/env python3
"""One piece, one fresh orchestrator process (P3, D-LAYER): the dispatcher's tools.

- ``next``: pieces that may start now, the ones held back with their reasons, the ones
  whose process runs, and whether the run stopped (``wall_clock``). Same rules as
  ``phase_merge.next_ready``.
- ``start --piece P``: render ``templates/prompt-piece.md`` and launch the configured
  ``cli.piece`` (default ``claude -p``) detached, in its own process group, in the main
  checkout, with the dispatcher's ``NIGHTSHIFT_LEASE``, ``SPECIFY_FEATURE_DIRECTORY``
  pinned and the Bash tool timeouts raised to the longest script call. Its pid, start
  time, deadline and lease go into state with a ``<P>:<attempt>:piece`` step intent.
  A live recorded process that holds the same lease is adopted; any other recorded
  process is killed first (its lease is no longer valid) and the piece is relaunched
  (the scripts' step records make that safe). A piece that already ended is not
  launched: its result is returned.
- ``wait --piece P [--max 540]``: poll until the process ends or ``--max`` seconds pass,
  so each call stays under the dispatcher's 10-minute Bash cap; heartbeat the lease;
  kill the process group at the deadline
  (``max_rounds × (phase_budget + review_budget) + ci.wait_timeout + 30m``). Prints the
  result (``status: running`` while it runs).
- ``result --piece P``: write and print ``pieces/<P>/result.json``.
- ``converge``: one ``/speckit-converge`` round (D-3'), only when no piece is ready or
  running, every piece has ``passed`` (Kasper, 2026-10-07: a parked or blocked piece skips
  converge, since its gaps would be duplicated), and fewer than ``converge.max_rounds``
  (default 2) rounds ran. It runs the configured ``cli.converge`` (``claude -p``) on
  ``/speckit-converge`` in a fresh worktree at origin's feature head with the feature
  pinned. Mechanical check: only ``tasks.md`` changed and its old content is a
  byte-identical prefix of the new; otherwise nothing is pushed and the run stops
  ``safety_stop``. An append is committed and pushed (fast-forward). Its open tasks split
  by tag: *traced* (``missing``/``partial``/``contradicts`` whose refs all exist in
  ``spec.md``) become the piece ``convergence-N`` (loop ``build``; its bar is the cited
  lines verbatim; postconditions refuse a tick on an untraced task); *untraced* (every
  ``unrequested`` task too) are product decisions the PR lists. No traced task: no piece.

The result: ``{piece, status: passed|parked|blocked|stopped|running, reason, sha, rounds,
question, found, drift_seen, resets_at, summary, log}``. Every field except ``summary`` is
read from state and the logbook (mechanical), never from the session. ``reason`` is the
park or block reason, or a stop: ``usage_limit``, ``environment_failure``,
``safety_stop`` (a script refused), ``timeout``, ``crashed`` (process gone, no terminal
state). ``question`` is the critic's ``decision_needed`` (or the builder's blocked
reason), verbatim. ``summary`` is the session's ``summary.md``, labelled a claim.

Mechanical: the launch, the environment, the deadline, the result's facts. Behavioural:
what the piece session does; the scripts it calls enforce the rest.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_config as config  # noqa: E402
import nightshift_core as core  # noqa: E402
import nightshift_model as model  # noqa: E402
import nightshift_state as nsstate  # noqa: E402
import phase  # noqa: E402
import phase_merge as pm  # noqa: E402

SCRIPTS = Path(__file__).resolve().parent
TERMINAL = ("passed", "parked", "blocked")
POLL = 0.5


def piece_dir(ctx: pm.Ctx, key: str) -> Path:
    return ctx.run_dir / "pieces" / key


def budgets(cfg: dict[str, Any]) -> tuple[int, int]:
    """(seconds until the piece is killed, the longest single script call in seconds)."""
    build = core.parse_duration(cfg.get("phase_budget"), 7200)
    review = core.parse_duration(cfg.get("review_budget"), 3600)
    ci = core.parse_duration((cfg.get("ci") or {}).get("wait_timeout"), 1800)
    rounds = int(cfg.get("max_rounds") or 3)
    return rounds * (build + review) + ci + 1800, max(build, review, ci, 1800) + 300


# ---------------------------------------------------------------------------
# The process
# ---------------------------------------------------------------------------


def alive(proc: dict[str, Any]) -> bool:
    """The recorded process still runs (same host, same /proc start time, not a zombie)."""
    pid = proc.get("pid")
    if not pid or proc.get("host") != socket.gethostname():
        return False
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    try:
        if Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] == "Z":
            return False
    except (OSError, IndexError):
        pass
    started = nsstate.proc_start_time(int(pid))
    return not (started and proc.get("start_ticks") and started != proc["start_ticks"])


def kill(proc: dict[str, Any]) -> bool:
    """Kill the recorded process group; True when it was running."""
    if not alive(proc):
        return False
    try:
        os.killpg(int(proc["pid"]), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        return False
    deadline = time.monotonic() + 10
    while alive(proc) and time.monotonic() < deadline:
        time.sleep(0.05)
    return True


def render_prompt(ctx: pm.Ctx, key: str, cfg: dict[str, Any]) -> str:
    bar = model.freeze_bar(ctx.root, ctx.fdir, key, nsstate.piece(ctx.state, key)["loop"])
    d = next((p for p in model.derive(ctx.root, ctx.fdir).pieces if p.key == key), None)
    note = ((ctx.state.get("grounding") or {}).get("pieces") or {}).get(key)
    return core.render_template(ctx.root, "prompt-piece.md", {
        "piece": key, "title": d.title if d else key, "feature": ctx.feature, "branch": ctx.feature_branch,
        "scripts": f"{sys.executable} {SCRIPTS}", "max_rounds": cfg.get("max_rounds", 3),
        "summary": str(piece_dir(ctx, key) / "summary.md"), "bar": model.bar_markdown(bar),
        "drift": f"## Drift note (re-grounding)\n{note}\nRead it before the first build: judge whether "
                 "the plan's claims still hold against the code. A contradiction that needs a product "
                 "decision ends the piece with the question in your summary." if note else ""})


def start(ctx: pm.Ctx, key: str) -> dict[str, Any]:
    p = nsstate.piece(ctx.state, key)
    proc = p.get("process") or {}
    lease = os.environ.get("NIGHTSHIFT_LEASE", "")
    if alive(proc) and proc.get("lease") == lease:
        ctx.log(key, "piece", "adopted", None, f"pid {proc['pid']} (attempt {proc['attempt']})")
        return {**result(ctx, key), "action": "adopted"}
    if p["status"] in TERMINAL:
        return {**result(ctx, key), "action": "ended"}
    if p["status"] == "pending" and key not in pm.next_ready(ctx):
        raise core.NightshiftError(f"{key} is not ready to start; see `piece.py next`")
    held = nsstate.read_lease(ctx.root, ctx.name)
    if held and held.get("owner") != lease:
        raise core.NightshiftError(f"the run lease is held by {held.get('owner')}; export NIGHTSHIFT_LEASE "
                                   "for the session that holds it, so the piece process inherits it")
    if proc.get("pid"):
        if kill(proc):
            ctx.log(key, "piece", "killed-stray", None, f"pid {proc['pid']} held lease {proc.get('lease')}")
        result(ctx, key)  # closes the earlier attempt's step
    cfg = config.load(ctx.root)
    deadline, call_max = budgets(cfg)
    attempt = int(proc.get("attempt") or 0) + 1
    out = piece_dir(ctx, key)
    out.mkdir(parents=True, exist_ok=True)
    (out / "summary.md").unlink(missing_ok=True)
    prompt = out / "prompt.md"
    prompt.write_text(render_prompt(ctx, key, cfg), encoding="utf-8")
    argv = phase.role_argv(argparse.Namespace(cfg=cfg), "piece", prompt)
    env = phase.role_env(argv, {"NIGHTSHIFT_PIECE": key, "SPECIFY_FEATURE_DIRECTORY": ctx.feature,
                                "SPECIFY_FEATURE_NO_PERSIST": "1", "NIGHTSHIFT_LEASE": lease,
                                "BASH_DEFAULT_TIMEOUT_MS": str(call_max * 1000),
                                "BASH_MAX_TIMEOUT_MS": str(call_max * 1000)})
    env.pop("NIGHTSHIFT_TEST_CRASH", None)
    log = out / f"session-{attempt}.log"
    step = f"{key}:{attempt}:piece"
    nsstate.step_intent(ctx.state, step, {"attempt": attempt})
    with prompt.open("r", encoding="utf-8") as stdin, log.open("w", encoding="utf-8") as fh:
        try:
            child = subprocess.Popen(argv, cwd=ctx.root, env=env, stdin=stdin, stdout=fh, stderr=subprocess.STDOUT,
                                     start_new_session=True)
        except OSError as exc:
            raise core.NightshiftError(f"cannot start {argv[0]}: {exc}") from exc
    now = time.time()
    p["process"] = {"pid": child.pid, "host": socket.gethostname(), "start_ticks": nsstate.proc_start_time(child.pid),
                    "started_at": nsstate.now(), "deadline": now + deadline, "lease": lease, "attempt": attempt,
                    "log": str(log)}
    ctx.save()
    ctx.log(key, "piece", "started", None, f"pid {child.pid}, attempt {attempt}, deadline in {deadline // 60} min")
    return {**result(ctx, key), "action": "started"}


# ---------------------------------------------------------------------------
# The result (facts from state and the logbook)
# ---------------------------------------------------------------------------

RESETS = re.compile(r"resets (.+?)(?:;|$)")


def _since(ctx: pm.Ctx, key: str, started: str | None) -> list[dict[str, Any]]:
    t0 = datetime.fromisoformat(started) if started else None
    return [e for e in nsstate.read_jsonl(ctx.run_dir / "log.jsonl")
            if e.get("piece") == key and (t0 is None or datetime.fromisoformat(e["ts"]) >= t0)]


def _stop_reason(ctx: pm.Ctx, key: str, proc: dict[str, Any]) -> tuple[str, str | None]:
    if proc.get("timed_out"):
        return "timeout", None
    entries = _since(ctx, key, proc.get("started_at"))
    for e in entries:
        if e.get("outcome") == "usage_limit":
            m = RESETS.search(e.get("detail") or "")
            return "usage_limit", m.group(1).strip() if m else None
    try:
        limit = phase.usage_limit(Path(proc.get("log") or "").read_text(encoding="utf-8", errors="replace"), 1)
    except OSError:
        limit = None
    if limit:
        return "usage_limit", limit.get("resets")
    if any(e.get("outcome") == "environment_error" for e in entries):
        return "environment_failure", None
    if any(e.get("outcome") == "refused" for e in entries):
        return "safety_stop", None
    return "crashed", None


def result(ctx: pm.Ctx, key: str) -> dict[str, Any]:
    nsstate.refresh(ctx.root, ctx.name, ctx.state)
    p = nsstate.piece(ctx.state, key)
    proc = p.get("process") or {}
    running = alive(proc)
    status, reason, resets = p["status"], p.get("reason"), None
    if status not in TERMINAL:
        if running:
            status, reason = "running", None
        else:
            status = "stopped"
            reason, resets = _stop_reason(ctx, key, proc) if proc else ("not_started", None)
    summary_path = piece_dir(ctx, key) / "summary.md"
    claim = summary_path.read_text(encoding="utf-8", errors="replace").strip() if summary_path.is_file() else ""
    claim = "\n".join(claim.splitlines()[:3])[:600]
    out = {"piece": key, "status": status, "reason": reason,
           "sha": p.get("combined_sha") or p.get("merged_sha") or p.get("candidate_sha"),
           "rounds": p.get("round") or 0,
           "question": p.get("question") if status in ("blocked", "parked") else None,
           "found": [f["issue"] for f in p.get("found") or []],
           "drift_seen": key in ((ctx.state.get("grounding") or {}).get("pieces") or {}),
           "resets_at": resets, "summary": f"claim, not evidence: {claim}" if claim else "",
           "log": proc.get("log")}
    if proc and not running:
        step = f"{key}:{proc['attempt']}:piece"
        if not (ctx.state["steps"].get(step) or {}).get("done"):
            nsstate.step_complete(ctx.state, step, {"attempt": proc["attempt"]}, {"status": status, "reason": reason})
            ctx.save()
            ctx.log(key, "piece", status, out["sha"], reason or "")
    out_dir = piece_dir(ctx, key)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "result.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    return out


def wait(ctx: pm.Ctx, key: str, max_s: float) -> dict[str, Any]:
    end = time.monotonic() + max_s
    owner = os.environ.get("NIGHTSHIFT_LEASE", "")
    while True:
        lease = nsstate.read_lease(ctx.root, ctx.name)
        if owner and lease and lease.get("owner") == owner:
            nsstate.acquire_lease(ctx.root, ctx.name, owner)  # heartbeat while the piece runs
        nsstate.refresh(ctx.root, ctx.name, ctx.state)
        proc = nsstate.piece(ctx.state, key).get("process") or {}
        if alive(proc) and time.time() >= float(proc.get("deadline") or 0):
            kill(proc)
            proc["timed_out"] = True
            ctx.save()
            ctx.log(key, "piece", "timeout", None, f"pid {proc['pid']} killed at its deadline")
        if not alive(proc) or time.monotonic() >= end:
            return result(ctx, key)
        time.sleep(POLL)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def next_pieces(ctx: pm.Ctx) -> dict[str, Any]:
    held: dict[str, list[str]] = {}
    ready = pm.next_ready(ctx, held)
    nsstate.refresh(ctx.root, ctx.name, ctx.state)
    running = [k for k, p in ctx.state["pieces"].items() if alive(p.get("process") or {})]
    return {"ready": [k for k in ready if k not in running], "not_ready": held, "running": running,
            "stop_reason": ctx.state.get("stop_reason")}


def converge(ctx: pm.Ctx) -> dict[str, Any]:
    cfg = config.load(ctx.root)
    cap = int((cfg.get("converge") or {}).get("max_rounds", 2))
    rounds = int(ctx.state.get("converge_rounds") or 0)
    nxt = next_pieces(ctx)
    d = model.derive(ctx.root, ctx.fdir)
    waiting = [p.key for p in d.pieces if p.kind != "convergence" or p.key in ctx.state["pieces"]]
    waiting = [k for k in waiting if (ctx.state["pieces"].get(k) or {}).get("status") != "passed"]
    why = ("the run stopped" if nxt["stop_reason"] else "a piece is ready or running" if nxt["ready"] or nxt["running"]
           else f"not every piece has passed ({', '.join(waiting)})" if waiting
           else f"the round cap ({cap}) is reached" if rounds >= cap else "")
    if why:
        return {"outcome": "skipped", "reason": why, "rounds": rounds}
    fb = ctx.feature_branch
    head = pm.fetch_branch(ctx.root, fb)
    wt = ctx.run_dir / "worktrees" / "_converge"
    if wt.exists():
        pm.git(ctx.root, "worktree", "remove", "--force", str(wt), check=False)
    pm.git(ctx.root, "worktree", "add", "-q", "--detach", str(wt), head)
    rel = f"{ctx.feature}/tasks.md"
    out_dir = ctx.run_dir / "converge"
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        before = (wt / rel).read_bytes()
        prompt = out_dir / f"prompt-{rounds + 1}.md"
        prompt.write_text("/speckit-converge\n", encoding="utf-8")
        argv = phase.role_argv(argparse.Namespace(cfg=cfg), "converge", prompt)
        env = phase.role_env(argv, {"SPECIFY_FEATURE_DIRECTORY": ctx.feature, "SPECIFY_FEATURE_NO_PERSIST": "1"})
        env.pop("NIGHTSHIFT_TEST_CRASH", None)
        with (out_dir / f"session-{rounds + 1}.log").open("w", encoding="utf-8") as log:
            code, timed_out = phase.run_cli(argv, prompt, wt, env, log, core.parse_duration(cfg.get("review_budget"), 3600))
        limit = None if timed_out else phase.usage_limit((out_dir / f"session-{rounds + 1}.log").read_text(), code)
        if limit:
            phase.stop_for_usage_limit(limit, lambda *a: ctx.log("_run", *a), None, "converge", head, "converge")
        changed = sorted(set(pm.git(wt, "diff", "--name-only", head).splitlines())
                         | set(pm.git(wt, "ls-files", "--others", "--exclude-standard").splitlines()))
        after = (wt / rel).read_bytes() if (wt / rel).is_file() else b""
        if timed_out or changed not in ([], [rel]) or not after.startswith(before) or pm.git(wt, "rev-parse", "HEAD") != head:
            detail = ("timed out" if timed_out else f"changed {', '.join(changed) or 'history'}; "
                      f"tasks.md {'appended' if after.startswith(before) else 'rewritten'}")
            nsstate.stop(ctx.state, "safety_stop")
            ctx.save()
            ctx.log("_run", "converge", "safety_stop", head, f"converge broke append-only: {detail}; nothing pushed")
            return {"outcome": "safety_stop", "reason": detail, "rounds": rounds}
        ctx.state["converge_rounds"] = rounds + 1
        if after == before:
            ctx.save()
            ctx.log("_run", "converge", "converged", head, f"round {rounds + 1}: no gaps")
            return {"outcome": "converged", "rounds": rounds + 1, "piece": None, "traced": [], "untraced": []}
        pm.git(wt, "add", rel)
        pm.git(wt, "-c", "user.name=Spec Kit Nightshift", "-c", "user.email=nightshift@localhost",
               "commit", "-q", "-m", f"speckit-converge: round {rounds + 1} (nightshift)")
        pm.push_branch(ctx, pm.git(wt, "rev-parse", "HEAD"), fb)
    finally:
        pm.git(ctx.root, "worktree", "remove", "--force", str(wt), check=False)
    pm.fetch_branch(ctx.root, fb)
    # Pieces derive from this checkout's tasks.md: take the append (fast-forward only).
    if pm.git(ctx.root, "branch", "--show-current", check=False) == fb:
        pm.git(ctx.root, "merge", "-q", "--ff-only", f"refs/remotes/origin/{fb}", check=False)
    spec = core.parse_spec(ctx.fdir / "spec.md") if (ctx.fdir / "spec.md").is_file() else None
    pushed = core.parse_tasks_text(pm.git(ctx.root, "show", f"refs/remotes/origin/{fb}:{rel}"), Path(rel))
    conv = [p for p in model.group_pieces(pushed) if p.kind == "convergence" and p.key not in ctx.state["pieces"]]
    splits = {p.key: model.converge_split(p, spec) for p in conv}
    traced = [t.id for tr, _ in splits.values() for t in tr]
    untraced = [t.id for _, un in splits.values() for t in un]
    key = next((k for k, (tr, _) in splits.items() if tr), None)
    if key:
        ctx.state["pieces"][key] = nsstate.new_piece("build")
    ctx.save()
    ctx.log("_run", "converge", f"appended {len(traced) + len(untraced)}", None,
            f"round {rounds + 1}: traced {', '.join(traced) or '-'} -> {key or 'no piece'}; "
            f"untraced (product decisions) {', '.join(untraced) or '-'}")
    return {"outcome": "appended", "rounds": rounds + 1, "piece": key, "traced": traced, "untraced": untraced}


def main(argv: list[str]) -> int:
    ap, sub, common = pm.cli_parser(__doc__)
    sub.add_parser("next", parents=[common])
    sub.add_parser("converge", parents=[common])
    for name in ("start", "wait", "result"):
        sp = sub.add_parser(name, parents=[common])
        sp.add_argument("--piece", required=True)
        if name == "wait":
            sp.add_argument("--max", type=float, default=540, help="seconds to wait in this call (default 540)")
    args = ap.parse_args(argv)
    ctx = pm.load_ctx(args.feature)
    if args.cmd == "converge":
        out = converge(ctx)
        text = f"converge: {out['outcome']}" + (f" ({out['reason']})" if out.get("reason") else "") \
            + (f"; piece {out['piece']}" if out.get("piece") else "")
    elif args.cmd == "next":
        out = next_pieces(ctx)
        text = (f"ready: {', '.join(out['ready']) or '-'}; running: {', '.join(out['running']) or '-'}"
                + "".join(f"\nnot ready: {k} ({', '.join(v)})" for k, v in out["not_ready"].items())
                + (f"\nstopped: {out['stop_reason']}" if out["stop_reason"] else ""))
    else:
        out = {"start": start, "result": result}[args.cmd](ctx, args.piece) if args.cmd != "wait" \
            else wait(ctx, args.piece, args.max)
        text = (f"{out['piece']}: {out['status']}" + (f" ({out['reason']})" if out["reason"] else "")
                + (f"\nquestion: {out['question']}" if out["question"] else "")
                + (f"\n{out['summary']}" if out["summary"] else ""))
    pm.emit(args, out, text)
    return 0


if __name__ == "__main__":
    core.run_main(main)
