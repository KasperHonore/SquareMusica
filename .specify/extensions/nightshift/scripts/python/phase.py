#!/usr/bin/env python3
"""Start a phase and run one builder round (design §6.2 steps 1–2).

Subcommands:

- ``start --piece``: create the phase branch ``nightshift/<name>/<piece>`` and its
  worktree at ``.nightshift/<name>/worktrees/<piece>`` from the feature-branch head,
  and record ``base_sha``. Idempotent: an existing worktree on that branch is adopted.
- ``build --piece``: render the builder prompt (frozen bar, only the findings the
  builder has not seen, current check results) and run the configured builder CLI
  in the worktree with ``SPECIFY_FEATURE_DIRECTORY`` pinned, under the phase budget.
  The builder's exit code and claims are recorded but never count as a pass (D-VER);
  ``postconditions`` and ``checks`` decide.

``--bug SLUG`` addresses a bug run (``bug-<slug>``; its "feature branch" is
``fix/<slug>``). A ``fix`` piece gets ``templates/prompt-fix-builder.md`` (the assessment
verbatim, reproduction first) instead of the feature builder prompt, and the assessment
and every ``specs/`` file are gate paths. After a refused reproduction the next round
restarts the local, unpushed phase branch from the base (``reset_to_base``, set by
``checks.py``; mechanical).
- ``review --piece``: run the fresh, read-only critic on the prompt ``verdict.py inputs``
  rendered and store its raw answer for ``verdict.py review``.

Mechanical: the worktree and branch the builder works in, the pinned feature, the
timeout, the usage-limit stop (exit 4, spike S-7) and the credential split (only role
calls get Claude credentials). Behavioural: everything the builder does inside the worktree, which
``postconditions`` checks afterwards.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_config as config  # noqa: E402
import nightshift_core as core  # noqa: E402
import nightshift_model as model  # noqa: E402
import nightshift_state as st  # noqa: E402


def git(cwd: Path, *args: str, check: bool = True) -> str:
    res = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and res.returncode != 0:
        raise core.NightshiftError(f"git {' '.join(args)} failed: {(res.stderr or res.stdout).strip()[:400]}")
    return res.stdout.strip()


parse_duration = core.parse_duration  # '90s', '45m', '8h' or seconds


class Ctx:
    def __init__(self, args: argparse.Namespace):
        self.root = core.find_project_root()
        self.bug = getattr(args, "bug", None)
        self.fdir, self.name = model.run_target(self.root, args.feature, self.bug)
        self.feature = core.feature_id(self.root, self.fdir)
        self.state = st.load(self.root, self.name)
        self.cfg = config.load(self.root)
        if self.bug:
            self.cfg["gate_paths"] = list(self.cfg["gate_paths"]) + model.BUG_GATES
        self.key = args.piece
        self.p = st.piece(self.state, self.key)
        self.run_dir = st.run_dir(self.root, self.name)
        self.worktree = self.run_dir / "worktrees" / self.key
        self.branch = f"nightshift/{self.name}/{self.key}"

    def save(self) -> None:
        """Merge-save (``nightshift_state.save``): only what this script changed is written."""
        st.save(self.root, self.name, self.state)

    def refresh(self) -> None:
        """Reload after a long wait (builder, critic): other pieces may have
        moved meanwhile; ``self.p`` stays the same object, updated in place."""
        st.refresh(self.root, self.name, self.state)

    def log(self, step: str, outcome: str, sha: str | None, detail: str = "") -> None:
        st.log(self.root, self.name, self.state, piece=self.key, step=step, outcome=outcome,
               sha=sha, detail=detail)


def cmd_start(c: Ctx) -> dict[str, Any]:
    fb = c.state["feature_branch"]
    git(c.root, "fetch", "-q", "origin", f"refs/heads/{fb}:refs/remotes/origin/{fb}")
    head = git(c.root, "rev-parse", f"refs/remotes/origin/{fb}")
    if c.worktree.is_dir():
        current = git(c.worktree, "branch", "--show-current", check=False)
        if current != c.branch:
            raise core.NightshiftError(f"{c.worktree} exists on {current or 'a detached HEAD'}, not {c.branch}")
        action = "adopted"
    else:
        c.worktree.parent.mkdir(parents=True, exist_ok=True)
        exists = git(c.root, "rev-parse", "--verify", "--quiet", f"refs/heads/{c.branch}", check=False)
        if exists:
            git(c.root, "worktree", "add", "-q", str(c.worktree), c.branch)
        else:
            git(c.root, "worktree", "add", "-q", "-b", c.branch, str(c.worktree), head)
        action = "created"
    base = c.p.get("base_sha") or git(c.worktree, "rev-parse", "HEAD")
    c.p["base_sha"] = base
    c.save()
    c.log("start", action, base, f"{c.branch} at {c.worktree}")
    return {"piece": c.key, "action": action, "branch": c.branch, "worktree": str(c.worktree), "base_sha": base}


def _bar(c: Ctx) -> tuple[str, model.Piece | None, model.Derivation]:
    spec_path = c.fdir / "spec.md"
    spec = core.parse_spec(spec_path) if spec_path.is_file() else None
    record = core.load_record(core.record_path(c.root, c.name))
    d = model.derive(c.root, c.fdir, record)
    piece = next((p for p in d.pieces if p.key == c.key), None)
    lines = []
    refs = c.p.get("bar_refs") or []
    if refs:  # an added piece (a correction): the cited criteria are the bar
        by_ref = {s.ref: s.text for s in (spec.scenarios if spec else [])}
        lines = [f"- **{r}**: {by_ref[r]}" if r in by_ref else f"- **{r}** (see spec.md)" for r in refs]
        return "\n".join(lines), piece, d
    if piece and piece.labels.get("Independent Test"):
        lines.append(f"**Independent Test**: {piece.labels['Independent Test']}")
    if spec and piece:
        for s in spec.scenarios:
            if not piece.story or s.story == piece.story:
                lines.append(f"- **{s.ref}**: {s.text}")
    quality = model.quality_bar(c.root, (record.get("pieces") or {}).get(c.key) or {})
    if quality:  # gauntlet style (P4): the critic judges the piece against it too
        lines.append(f"\n**Quality bar** (approved; the critic judges your work against it):\n\n{quality}")
    return "\n".join(lines) or "_No acceptance scenarios; the tasks are the bar._", piece, d


def _task_refs(c: Ctx, piece: model.Piece | None) -> str:
    """The tasks the builder may work on; a correction (D-FB) has no tasks, only its bar."""
    if piece is None:
        return "_none: fix the defect against the bar below; tick no task_" if c.p.get("added") else "_unknown_"
    refs = [core.task_ref(c.feature, t.id) for t in piece.tasks]
    return ", ".join(refs) or "_none_"


def _check_results(c: Ctx) -> str:
    sha = c.p.get("candidate_sha")
    path = c.run_dir / "evidence" / c.key / (sha or "-") / "checks.json"
    if not sha or not path.is_file():
        return "_No checks have run for this phase yet._"
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = data.get("checks", data) if isinstance(data, dict) else data
    return "\n".join(f"- `{' '.join(r.get('argv') or [])}`: exit {r.get('exit')}"
                     f"{' (timed out)' if r.get('timed_out') else ''}" for r in rows) or "_None._"


def _unseen(c: Ctx, path: str | None) -> str:
    items: list[Any] = []
    if path:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        items = list(data.get("unseen_findings", data) if isinstance(data, dict) else data)
    added = c.p.get("added") or {}
    if c.p["loop"] == "fix" and added.get("source"):  # a correction of a bug run (D-FB)
        items.insert(0, {"severity": "blocker", "path": "-", "lines": "*",
                         "rationale": f"Owner feedback against {', '.join(c.p.get('bar_refs') or [])}: "
                                      f"{added['source']}"})
    return "\n".join(f"- **{f.get('severity', '?')}** `{f.get('path', '')}` {f.get('lines', '')}: "
                     f"{f.get('rationale', f)}" for f in items) or "_None._"


def _grounding(c: Ctx) -> str:
    """P2: what the run-start re-grounding found moved in code this piece's plan relies on."""
    lines = (((c.state.get("grounding") or {}).get("pieces") or {}).get(c.key) or {}).get("briefing") or []
    if not lines:
        return ""
    return ("## Code moved since planning (re-grounding; the plan's intent still stands)\n"
            + "\n".join(f"- {b}" for b in lines) + "\n")


def _render_prompt(c: Ctx, findings_file: str | None) -> tuple[str, str]:
    """(file name, text) of this round's builder prompt."""
    gates = ", ".join(f"`{g}`" for g in c.cfg["gate_paths"])
    if c.p["loop"] == "fix":
        assessment = (c.fdir / "assessment.md").read_text(encoding="utf-8").strip()
        return "prompt-fix-builder.md", core.render_template(c.root, "prompt-fix-builder.md", {
            "slug": c.bug, "round": c.p["round"], "branch": c.branch, "base": c.p["base_sha"],
            "assessment": assessment, "unseen_findings": _unseen(c, findings_file),
            "check_results": _check_results(c), "gate_paths": gates})
    bar, piece, _ = _bar(c)
    return "prompt-builder.md", core.render_template(c.root, "prompt-builder.md", {
        "grounding": _grounding(c), "piece": c.key, "phase_title": piece.title if piece else c.key, "round": c.p["round"],
        "feature": c.feature, "task_refs": _task_refs(c, piece),
        "bar": bar, "unseen_findings": _unseen(c, findings_file),
        "check_results": _check_results(c), "gate_paths": gates})


# Claude Code flags per role, checked against `claude --help` of Claude Code 2.1.287
# (runtime-tested 2026-10-02). Every role is a fresh, unsaved print-mode session.
READ_TOOLS = "Read,Grep,Glob"
ROLE_FLAGS: dict[str, list[str]] = {
    # The builder edits its own worktree and runs /speckit-implement.
    "builder": ["--permission-mode", "bypassPermissions"],
    # The critic reads the code in place; no shell, no writes (behavioural; `verdict`
    # checks the tree mechanically).
    "critic": ["--permission-mode", "dontAsk", "--tools", READ_TOOLS],
    # The grounding analyst (core review stage 7) reads like a critic; `grounding.py`
    # checks the tree mechanically.
    "grounding": ["--permission-mode", "dontAsk", "--tools", READ_TOOLS],
}


# A bare `claude` answers with one JSON object (`result`, `num_turns`, `duration_ms`,
# `is_error`, ...), so the answer can be unwrapped and a usage-limit stop recognised
# (Claude Code 2.1.288 `--help`, runtime-tested 2026-10-04).
JSON_OUTPUT = ["--output-format", "json"]


def role_env(argv: list[str], extra: dict[str, str] | None = None) -> dict[str, str]:
    """A role call's environment: Claude credentials only when the executable is Claude
    Code itself (``claude``); any other configured CLI (opencode, a script) gets the
    stripped tool environment (spike S-7 token audit; mechanical for the environment)."""
    if argv and Path(argv[0]).name == "claude":
        return core.claude_env(extra)
    return core.tool_env(extra)


def role_argv(c: Ctx, role: str, prompt_file: Path, add_dirs: list[Path] | None = None) -> list[str]:
    """The configured CLI for a role. The prompt is fed on stdin unless the configured
    command names ``{prompt_file}``. A bare ``claude`` gets print mode, no session
    persistence, JSON output (the call wrapper) and the role's flags from ``ROLE_FLAGS``; any
    other command is used as configured (it owns its own flags).

    ``add_dirs``: directories outside the role's cwd that its prompt asks it to read
    (the evidence folder). A read-only critic runs in ``dontAsk`` mode, where a Read
    outside cwd is denied, so a bare ``claude`` gets one ``--add-dir`` each (D23b,
    D24b: a critic could not read a file in the evidence folder)."""
    raw = c.cfg["cli"].get(role) or (c.cfg["cli"].get("critic") if role == "grounding" else None) or "claude"
    argv = shlex.split(raw) if isinstance(raw, str) else [str(a) for a in raw]
    if len(argv) == 1 and Path(argv[0]).name == "claude":
        if role not in ROLE_FLAGS:
            raise core.NightshiftError(f"no Claude Code flags defined for role {role!r}")
        argv += ["-p", "--no-session-persistence", *JSON_OUTPUT, *ROLE_FLAGS[role]]
        for d in add_dirs or []:
            argv += ["--add-dir", str(Path(d).resolve())]
    return [a.replace("{prompt_file}", str(prompt_file)) for a in argv]


# ---------------------------------------------------------------------------
# A role call's JSON wrapper (Claude Code)
# ---------------------------------------------------------------------------


def _wrapper(obj: Any) -> dict[str, Any] | None:
    if isinstance(obj, dict) and "total_cost_usd" in obj and isinstance(obj.get("result"), str):
        return obj
    return None


def parse_wrapper(text: str) -> dict[str, Any] | None:
    """Claude Code's ``--output-format json`` object in ``text``, or None (custom CLI,
    fakes). The whole text is tried first, then each line from the end, so stderr
    lines mixed into a builder log do not hide it."""
    try:
        return _wrapper(json.loads(text))
    except ValueError:
        pass
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                got = _wrapper(json.loads(line))
            except ValueError:
                continue
            if got:
                return got
    return None


def call_info(wrapper: dict[str, Any] | None) -> dict[str, Any] | None:
    """``{num_turns, duration_ms, is_error}`` of one wrapped call, or None. Per-call cost
    is not recorded (shelved 2026-10-05, docs/core-review.md)."""
    if not wrapper:
        return None
    return {"num_turns": wrapper.get("num_turns"), "duration_ms": wrapper.get("duration_ms"),
            "is_error": bool(wrapper.get("is_error"))}


def unwrap_answer(path: Path) -> dict[str, Any] | None:
    """If ``path`` holds a Claude Code wrapper, replace it with the wrapper's ``result``
    (the role's answer), keep the raw wrapper next to it (``<stem>.wrapper.json``) and
    return the call's info. Anything else is left untouched (None)."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    wrapper = parse_wrapper(text)
    if wrapper is None:
        return None
    path.with_name(f"{path.stem}.wrapper.json").write_text(text, encoding="utf-8")
    path.write_text(wrapper["result"], encoding="utf-8")
    return call_info(wrapper)


def call_note(info: dict[str, Any] | None) -> str:
    if not info:
        return ""
    turns = f"; {info['num_turns']} turns" if info.get("num_turns") is not None else ""
    return turns + ("; CLI reported is_error" if info.get("is_error") else "")


def builder_info(log_path: Path, offset: int = 0) -> dict[str, Any] | None:
    """Info of the builder call whose raw output starts at ``offset`` in ``log_path``."""
    try:
        with log_path.open("r", encoding="utf-8", errors="replace") as fh:
            fh.seek(offset)
            return call_info(parse_wrapper(fh.read()))
    except OSError:
        return None


# ---------------------------------------------------------------------------
# The Claude plan's usage limit (spike S-7, docs/spikes/s7-usage-limit.md)
#
# Claude Code 2.1.289 (source-inspected) turns a quota 429 into an API-error assistant
# message whose text starts with one of the prefixes below (its own list, used to
# classify quota messages), e.g. "You've hit your session limit · resets 3am
# (Europe/Copenhagen)". In `-p --output-format json` the result wrapper carries that
# text as ``result`` with ``is_error: true`` (``subtype`` stays "success",
# ``api_error_status`` 429), and the process exits 1.
# ---------------------------------------------------------------------------

USAGE_LIMIT_PREFIXES = (
    "You've hit your", "You've reached your", "You're out of usage credits", "You're out of extra usage",
    "Your org is out of usage", "Your seat type doesn't include usage", "Your seat type doesn't include extra usage",
    "Your usage allocation has been disabled by your admin", "Your group's usage limit is set to $0",
)
_CREDITS_REQUIRED = re.compile(r"^\S+(?: [^\u00b7\n]{1,40})? requires usage credits\.")
_RESETS = re.compile(r"\bresets ([^\u00b7\n]+?)\s*(?:\u00b7|$)", re.M)


def _limit_text(text: str) -> dict[str, Any] | None:
    text = text.strip()
    if not (text.startswith(USAGE_LIMIT_PREFIXES) or _CREDITS_REQUIRED.match(text)):
        return None
    m = _RESETS.search(text)
    return {"message": text.splitlines()[0][:300], "resets": m.group(1).strip() if m else None}


def usage_limit(text: str, exit_code: int | None = None) -> dict[str, Any] | None:
    """``{message, resets}`` when a role call's output reports the plan's usage limit.

    Conservative: a Claude Code wrapper must say ``is_error: true`` and its ``result``
    must start with a quota message; plain output (a configured ``claude`` without JSON
    output) must have exited non-zero and its last non-empty line must be one."""
    wrapper = parse_wrapper(text)
    if wrapper is not None:
        return _limit_text(wrapper["result"]) if wrapper.get("is_error") is True else None
    if not exit_code:
        return None
    lines = [x for x in text.splitlines() if x.strip()]
    return _limit_text(lines[-1]) if lines else None


def _read_from(path: Path, offset: int = 0) -> str:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            fh.seek(offset)
            return fh.read()
    except OSError:
        return ""


def stop_for_usage_limit(limit: dict[str, Any], log, save, label: str, sha: str | None, step: str) -> None:
    """Log ``usage_limit``, save, and raise ``UsageLimit`` (exit 4). Sub-statuses are
    left as they were: the limit is not a verdict on the work."""
    resets = f"; resets {limit['resets']}" if limit.get("resets") else ""
    log(step, "usage_limit", sha, f"{label}: {limit['message']}{resets}")
    if save is not None:
        save()
    raise core.UsageLimit(f"{label} hit the Claude plan's usage limit{resets}; stop the run with "
                          "`state.py stop --reason budget_exhausted` and resume with --resume after the reset")


def finish_critic_call(state: dict[str, Any], unit: dict[str, Any] | None, answer: Path, log, label: str,
                       sha: str | None, code: int | None = None, save=None,
                       step: str = "review") -> dict[str, Any] | None:
    """Unwrap a critic-like answer file and log a CLI-reported error.
    ``log(step, outcome, sha, detail)``. Never raises on a malformed answer: ``verdict``
    judges the file. Raises ``UsageLimit`` (after ``save()``) when the call hit the
    plan's usage limit; the answer file is then left as the CLI wrote it."""
    limit = usage_limit(_read_from(answer), code)
    if limit:
        stop_for_usage_limit(limit, log, save, label, sha, step)
    info = unwrap_answer(answer)
    if info and info["is_error"]:
        log("call", "call_failed", sha, f"{label}: Claude Code reported is_error{call_note(info)}")
    return info


def run_cli(argv: list[str], prompt_file: Path, cwd: Path, env: dict[str, str], out, timeout: int,
            err=subprocess.STDOUT, on_start=None) -> tuple[int, bool]:
    """Run a role CLI in its own process group; kill the group on timeout.

    ``on_start(pid)`` runs right after the spawn, so the caller can record the
    process group before anything else can crash."""
    with prompt_file.open("r", encoding="utf-8") as stdin:
        try:
            proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=stdin, stdout=out, stderr=err,
                                    start_new_session=True, text=True)
        except OSError as exc:
            raise core.NightshiftError(f"cannot start {argv[0]}: {exc}") from exc
        if on_start is not None:
            on_start(proc.pid)
        try:
            proc.wait(timeout=timeout)
            return proc.returncode, False
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, 9)
            proc.wait()
            return proc.returncode, True


def _alive(pid: int) -> bool:
    try:
        os.killpg(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    try:  # a zombie answers signal 0 but is gone
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[-1].split()[0] != "Z"
    except (OSError, IndexError):
        return True


def kill_stray_builder(c: Ctx) -> int | None:
    """Kill the builder recorded by an interrupted ``build`` (its process group).

    A crashed orchestrator leaves the builder running on its own (it has its own
    session), so it could commit into the worktree while a resumed builder works
    there. The pid is only trusted when the process still runs in this worktree
    (``/proc/<pid>/cwd`` where available), so a reused pid is never killed."""
    return _kill_recorded(c, "builder_pid", c.worktree, "builder")


def kill_stray_children(c: Ctx) -> list[int]:
    """Kill a critic left running by an interrupted session (known limit).

    Their answers would land in the evidence folder after a resumed review had
    already read it; a resumed step therefore stops them before running again."""
    killed = []
    for field in ("critic_pids",):
        for role, pid in list((c.p.get(field) or {}).items()):
            cwd = c.worktree if c.worktree.is_dir() else c.root
            got = _kill_recorded(c, None, cwd, role, pid=pid)
            if got:
                killed.append(got)
                c.log("resume", "killed-stray", c.p.get("candidate_sha"), f"{role} pid {got}")
        c.p[field] = {}
    return killed


def _kill_recorded(c: Ctx, field: str | None, cwd_expected: Path, label: str, pid: int | None = None) -> int | None:
    pid = pid if pid is not None else c.p.get(field or "")
    if not pid or not _alive(int(pid)):
        return None
    try:
        cwd = Path(os.readlink(f"/proc/{pid}/cwd")).resolve()
        if cwd != cwd_expected.resolve():
            return None
    except OSError:
        pass  # no /proc: trust the recorded process group
    try:
        os.killpg(int(pid), 9)
    except ProcessLookupError:
        return None
    except PermissionError as exc:
        raise core.NightshiftError(f"{c.key}: the interrupted {label} (pid {pid}) still runs in {cwd_expected} and "
                                   "cannot be stopped; inspect and adopt its work by hand, nothing started") from exc
    deadline = time.monotonic() + 10
    while _alive(int(pid)) and time.monotonic() < deadline:
        time.sleep(0.05)
    if _alive(int(pid)):
        raise core.NightshiftError(f"{c.key}: the interrupted {label} (pid {pid}) did not stop; "
                                   "inspect and adopt its work by hand, nothing started")
    return int(pid)


def _clean(wt: Path) -> bool:
    for line in git(wt, "status", "--porcelain", "--untracked-files=all").splitlines():
        path = line[3:].split(" -> ")[-1].strip('"')
        if not (path == ".nightshift" or path.startswith(".nightshift/")):
            return False
    return True


def cmd_build(c: Ctx, findings_file: str | None) -> dict[str, Any]:
    """One builder round. Resume (design §7): the round's prompt is frozen on first
    render, so the step's inputs hash is stable; a ``done`` record with those inputs
    is returned as is. An ``intent`` without ``done`` first kills a stray builder,
    then adopts a finished round (HEAD past the base, clean tree) or retries it."""
    if not c.worktree.is_dir():
        raise core.NightshiftError(f"{c.key}: no worktree; run `phase.py start` first")
    ev = c.run_dir / "evidence" / c.key / f"round-{c.p['round']}"
    ev.mkdir(parents=True, exist_ok=True)
    pname = "prompt-fix-builder.md" if c.p["loop"] == "fix" else "prompt-builder.md"
    pfile = ev / pname
    step = f"{c.key}:{c.p['round']}:build"
    resumed = bool((c.state["steps"].get(step) or {}).get("intent")) and pfile.is_file()
    if resumed:
        prompt = pfile.read_text(encoding="utf-8")
    else:
        _, prompt = _render_prompt(c, findings_file)
    inputs = {"round": c.p["round"], "base": c.p["base_sha"], "prompt": core.sha256_text(prompt)}
    done = st.step_done(c.state, step, inputs)
    if done:
        return {**done["result"], "skipped": True}
    if c.p["status"] != "building":
        raise core.NightshiftError(f"{c.key}: status is {c.p['status']}; run `verdict.py next` first")
    budget = parse_duration(c.cfg.get("phase_budget"), 2 * 3600)
    log_path = ev / "builder.log"
    if resumed:
        stray = kill_stray_builder(c)
        c.p["builder_pid"] = None
        head = git(c.worktree, "rev-parse", "HEAD")
        rec = c.state["steps"].get(step) or {}
        limited = bool(rec.get("usage_limit"))
        # Round 2+ starts on the earlier rounds' commits: "moved" is judged against the
        # HEAD the round started from (recorded with the intent), else the base (D25).
        start = (rec.get("intent") or {}).get("head") or c.p["base_sha"]
        if head != start and _clean(c.worktree) and not limited:
            result = {"piece": c.key, "round": c.p["round"], "exit": None, "timed_out": False,
                      "duration_s": None, "head": head, "log": str(log_path), "origin": "adopted",
                      "stray_killed": stray}
            st.step_complete(c.state, step, inputs, result)
            st.transition(c.state, c.key, "checking")
            c.save()
            c.log("build", "adopted", head, "builder round finished before the orchestrator stopped; "
                  "postconditions and checks decide")
            return result
        why = "round stopped by the usage limit retried" if limited else "interrupted round retried"
        c.state["steps"][step].pop("usage_limit", None)
        c.save()
        c.log("build", "retry", head, f"{why}{f'; stray builder {stray} killed' if stray else ''}")
    else:
        if c.p.pop("reset_to_base", False):
            # The reproduction was refused last round; the phase branch is local and
            # unpushed, so the script restarts it from the base instead of trusting a rewrite.
            git(c.worktree, "reset", "-q", "--hard", c.p["base_sha"])
            git(c.worktree, "clean", "-q", "-fd", "-e", ".nightshift")
        pfile.write_text(prompt, encoding="utf-8")
        st.step_intent(c.state, step, inputs)
        c.state["steps"][step]["intent"]["head"] = git(c.worktree, "rev-parse", "HEAD")
        c.save()
    if c.p["loop"] == "fix":
        stale = c.worktree / ".nightshift" / "repro.json"
        if stale.exists():
            stale.unlink()
    argv = role_argv(c, "builder", pfile)
    extra = {"NIGHTSHIFT_PIECE": c.key}
    extra.update({"NIGHTSHIFT_BUG": c.bug} if c.bug else
                 {"SPECIFY_FEATURE_DIRECTORY": c.feature, "SPECIFY_FEATURE_NO_PERSIST": "1"})
    env = role_env(argv, extra)
    if c.bug:  # a bug run has no Spec Kit feature to pin
        env.pop("SPECIFY_FEATURE_DIRECTORY", None)
    env.pop("NIGHTSHIFT_TEST_CRASH", None)

    def started_builder(pid: int) -> None:
        c.p["builder_pid"] = pid
        c.save()
        core.test_crash("after-spawn:builder")

    started = time.monotonic()
    with log_path.open("a" if resumed else "w", encoding="utf-8") as log:
        offset = log.tell()
        code, timed_out = run_cli(argv, pfile, c.worktree, env, log, budget, on_start=started_builder)
    duration = round(time.monotonic() - started, 2)
    c.refresh()
    c.p["builder_pid"] = None
    head = git(c.worktree, "rev-parse", "HEAD")
    info = builder_info(log_path, offset)
    limit = None if timed_out else usage_limit(_read_from(log_path, offset), code)
    if limit:
        # No done record: the intent stays, so --resume retries this same round (never
        # adopts it) once the limit has reset. Status and sub-statuses are untouched.
        c.state["steps"][step]["usage_limit"] = {"at": st.now(), "resets": limit.get("resets")}
        stop_for_usage_limit(limit, c.log, c.save, "builder", head, "build")
    result = {"piece": c.key, "round": c.p["round"], "exit": code, "timed_out": timed_out,
              "duration_s": duration, "head": head, "log": str(log_path), "origin": "builder-claim",
              "call": info}
    st.step_complete(c.state, step, inputs, result)
    if timed_out:
        st.set_sub(c.state, c.key, "builder", "failed")
        st.transition(c.state, c.key, "parked", reason="timeout")
        c.save()
        c.log("build", "timeout", head, f"builder exceeded {budget}s{call_note(info)}")
    else:
        st.transition(c.state, c.key, "checking")
        c.save()
        c.log("build", "finished", head, f"exit {code} (claims are not evidence){call_note(info)}")
    return result


def cmd_review(c: Ctx) -> dict[str, Any]:
    sha = c.p.get("candidate_sha")
    ev = c.run_dir / "evidence" / c.key / (sha or "-")
    if c.p["status"] != "reviewing" or not sha:
        raise core.NightshiftError(f"{c.key}: not reviewing; run checks and `verdict.py inputs` first")
    pfile = ev / "prompt-critic.md"
    if not pfile.is_file():
        raise core.NightshiftError(f"{pfile} missing; run `verdict.py inputs` first")
    kill_stray_children(c)
    c.save()
    target = ev / "critic.json"
    cwd = c.worktree if c.worktree.is_dir() else c.root

    def started(pid: int) -> None:
        c.p.setdefault("critic_pids", {})["critic"] = pid
        c.save()
        core.test_crash("after-spawn:critic")

    with target.open("w", encoding="utf-8") as fh, (ev / "critic.stderr.log").open("w", encoding="utf-8") as eh:
        argv = role_argv(c, "critic", pfile, [ev])
        code, timed_out = run_cli(argv, pfile, cwd, role_env(argv), fh,
                                  parse_duration(c.cfg.get("review_budget"), 3600), eh, on_start=started)
    c.refresh()
    c.p.setdefault("critic_pids", {}).pop("critic", None)
    info = finish_critic_call(c.state, c.p, target, c.log, "critic", sha, code, c.save)
    c.save()
    c.log("review", "timeout" if timed_out else f"critic exit {code}", sha, call_note(info).lstrip("; "))
    return {"piece": c.key, "sha": sha, "file": str(target)}


def main(argv: list[str]) -> int:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--feature", default=argparse.SUPPRESS)
    common.add_argument("--bug", metavar="SLUG", default=argparse.SUPPRESS)
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], parents=[common])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("start", "build", "review"):
        sp = sub.add_parser(name, parents=[common])
        sp.add_argument("--piece", required=True)
        if name == "build":
            sp.add_argument("--findings", help="JSON file from `verdict.py next --json` (unseen findings)")
    args = ap.parse_args(argv)
    args.feature = getattr(args, "feature", None)
    args.bug = getattr(args, "bug", None)
    args.json = getattr(args, "json", False)
    c = Ctx(args)
    if args.cmd == "start":
        out = cmd_start(c)
    elif args.cmd == "build":
        out = cmd_build(c, args.findings)
    else:
        out = cmd_review(c)
    if args.json:
        core.emit_json(out)
    else:
        for k, v in out.items():
            print(f"{k}: {v}")
    if args.cmd == "build" and out.get("timed_out"):
        return 1
    return 0


if __name__ == "__main__":
    core.run_main(main)
