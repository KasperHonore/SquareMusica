#!/usr/bin/env python3
"""Open, merge and verify phase PRs into the feature branch (design §6.2 step 6, D-M).

Subcommands:

- ``next-ready``: pieces that may start now (pending in run state, own readiness
  clean, every prerequisite satisfied in the delivery record or ``passed`` in state).
- ``open-pr --piece P``: push ``nightshift/<name>/<piece>`` and open or update its PR
  into the feature branch. Idempotent: an open PR with that head is reused.
- ``merge --piece P --sha S``: merge that PR, only if checks, code review, spec review
  and verdict all passed at ``candidate_sha == S`` and the PR head is still ``S``.
  Then, unless ``ci.require`` is false, it waits for the repository's own GitHub checks
  on ``S`` (check runs and the combined status; ``ci.poll_interval``, default 30s, up to
  ``ci.wait_timeout``, default 30m) and merges only if at least one check reported and
  every one passed (success, neutral or skipped). No check registered (yet) is pending,
  never terminal: if none registers within the timeout the piece parks ``ci_timeout``
  (1.1.3; a repository without CI sets ``ci.require: false``). A red check
  parks the piece ``ci_failed`` (failing names logged); a
  timeout, or a name in ``ci.required`` that never reported, parks it ``ci_timeout``.
  The result is in the merge step, ``evidence/<piece>/<S>/ci.json`` and the PR body
  (D-CIWAIT). Exit 1 when parked.
- ``combined --piece P``: fetch origin's feature branch, require its head to contain the
  merge commit recorded by ``merge`` (else refuse), and run the combined checks at exactly
  that origin head (``checks.py --combined --sha``; recorded as ``combined_sha``). The
  local feature branch is never used: in D23b it lagged origin. Green
  sets the piece ``passed`` and returns to ``pending`` every dependent blocked
  ``dependency_blocked`` that now waits only on passed pieces; red reverts the merge with a new commit, pushes it
  (never force) and parks the piece ``combined_checks_failed``. Green also, on its sub-issue,
  posts a marker-deduplicated "merged into" comment and ticks the task checklist from
  ``tasks.md`` at that head (Spec Kit's implement ticks ``[X]``); the sub-issue stays
  open (``handover.py close-issues`` closes it after the feature PR merges). A GitHub
  error there is logged, never undoes the pass.

``--bug SLUG`` addresses a bug run (``bug-<slug>``): its one ``fix`` piece merges into
``fix/<slug>``, the run's feature branch, exactly like a feature phase (core review stage
2). ``merge`` additionally refuses a fix piece whose reproduction was not verified at the
evidence SHA, and green ``combined`` records the outcome ``verified`` instead of
``completed``.

Safeguards:

- *mechanical*: ``guard_branch`` refuses every push and merge target that is ``main``,
  ``master``, origin's default branch or the configured ``base_branch``, and anything
  outside the feature branch and this run's phase branches. ``push_branch`` is the
  only place that pushes; it never passes ``--force`` or a ``+`` refspec. The merge
  call carries the evidence SHA, so GitHub (or the fake) refuses it if the head moved.
  A static test (``tests/test_merge_handover.py``) checks these properties in the
  source of every script.
- *mechanical*: ``passed`` is set only here, after green combined checks
  (``nightshift_state.transition`` enforces ``by="phase_merge"``).
- *mechanical*: the CI gate reads GitHub's check runs and statuses for the exact
  evidence SHA; it cannot see a required check that is configured on GitHub but never
  reported (list those in ``ci.required``). Not a security boundary.
- *behavioural*: the orchestrator is expected to call ``combined`` right after
  ``merge``; until it does, the piece stays ``merging`` and its dependents wait.
"""

from __future__ import annotations

import argparse
import os
import json
import re
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_config as nsconfig  # noqa: E402
import nightshift_core as core  # noqa: E402
import nightshift_github as github  # noqa: E402
import nightshift_model as model  # noqa: E402
import nightshift_state as nsstate  # noqa: E402

VERSION = core.VERSION
ALWAYS_PROTECTED = ("main", "master")
REVIEW_FIELDS = ("checks", "verdict")


# ---------------------------------------------------------------------------
# Shared helpers (also used by blocker, handover and render_dashboard)
# ---------------------------------------------------------------------------


@dataclass
class Ctx:
    root: Path
    fdir: Path
    name: str
    feature: str
    state: dict[str, Any]
    config: dict[str, Any]

    @property
    def run_dir(self) -> Path:
        return nsstate.run_dir(self.root, self.name)

    @property
    def feature_branch(self) -> str:
        return self.state["feature_branch"]

    def save(self) -> None:
        nsstate.save(self.root, self.name, self.state)

    def log(self, piece: str, step: str, outcome: str, sha: str | None = None, detail: str = "") -> None:
        nsstate.log(self.root, self.name, self.state, piece=piece, step=step, outcome=outcome,
                    sha=sha, detail=detail)


def load_config(root: Path) -> dict[str, Any]:
    """Nightshift config: the installed copy wins over a repo-root file; missing is empty."""
    for path in (root / ".specify" / "extensions" / "nightshift" / "nightshift-config.yml",
                 root / "nightshift-config.yml"):
        if path.is_file():
            data = core.yaml_load(path.read_text(encoding="utf-8"), str(path))
            return data if isinstance(data, dict) else {}
    return {}


def load_ctx(feature_arg: str | None, need_state: bool = True, bug: str | None = None) -> Ctx:
    """The run context of a feature, or of a bug run (``bug-<slug>``, branch ``fix/<slug>``)."""
    root = core.find_project_root()
    fdir, name = model.run_target(root, feature_arg, bug)
    state = nsstate.load(root, name) if need_state else {}
    return Ctx(root, fdir, name, core.feature_id(root, fdir), state, load_config(root))


def git(root: Path, *args: str, check: bool = True, timeout: int = 300) -> str:
    try:
        res = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise core.NightshiftError(f"git {' '.join(args)} failed: {exc}") from exc
    if check and res.returncode != 0:
        raise core.NightshiftError(f"git {' '.join(args)} failed: {(res.stderr or res.stdout).strip()[:500]}")
    return res.stdout.strip()


def resolve_repo(root: Path, explicit: str | None = None) -> str:
    """``--repo``, then ``NIGHTSHIFT_GH_REPO``, then the GitHub ``origin`` remote."""
    return explicit or os.environ.get("NIGHTSHIFT_GH_REPO") or github.remote_repo(root)


def default_branch(root: Path) -> str:
    out = git(root, "ls-remote", "--symref", "origin", "HEAD", check=False)
    for line in out.splitlines():
        if line.startswith("ref: refs/heads/") and line.endswith("HEAD"):
            return line[len("ref: refs/heads/"):].split("\t")[0].strip()
    return ""


def protected_branches(root: Path, config: dict[str, Any]) -> set[str]:
    out = set(ALWAYS_PROTECTED)
    for b in (default_branch(root), str(config.get("base_branch") or "")):
        if b:
            out.add(b)
    return out


def phase_branch(name: str, piece: str) -> str:
    return f"nightshift/{name}/{piece}"


def _short(branch: str) -> str:
    return branch[len("refs/heads/"):] if branch.startswith("refs/heads/") else branch


def guard_branch(ctx: Ctx, branch: str) -> str:
    """Refuse any write target that is not this run's feature or phase branch (mechanical, D15)."""
    b = _short(branch)
    if not b or b in protected_branches(ctx.root, ctx.config):
        raise core.NightshiftError(f"refusing to push or merge into {b or '(empty)'}: "
                                   "Nightshift never writes to main or the default branch (D-MERGE)")
    if b != ctx.feature_branch and not b.startswith(f"nightshift/{ctx.name}/"):
        raise core.NightshiftError(f"refusing to write to {b}: not this run's feature or phase branch")
    return b


def push_branch(ctx: Ctx, src: str, dst: str) -> None:
    """The only push in Nightshift: fast-forward only, never forced (D-PUSH)."""
    target = guard_branch(ctx, dst)
    if src.startswith("+") or ":" in src:
        raise core.NightshiftError(f"refusing push source {src!r}")
    git(ctx.root, "push", "-q", "origin", f"{src}:refs/heads/{target}")


def fetch_branch(root: Path, branch: str) -> str:
    """Fetch ``branch`` from origin (no ``+``: a rewritten remote fails loudly) and return its SHA."""
    git(root, "fetch", "-q", "origin", f"refs/heads/{branch}:refs/remotes/origin/{branch}")
    return git(root, "rev-parse", f"refs/remotes/origin/{branch}")


def remote_head(root: Path, branch: str) -> str:
    out = git(root, "ls-remote", "origin", f"refs/heads/{branch}")
    if not out:
        raise core.NightshiftError(f"origin has no branch {branch}")
    return out.split()[0]


def round_of(ctx: Ctx, piece: str) -> int:
    return int(nsstate.piece(ctx.state, piece).get("round") or 0)


def find_issue(gh: github.Gh, ctx: Ctx, key: str) -> int | None:
    """The issue of ``key`` (a piece, or ``parent``) by its marker; the cached number in
    the delivery record is only a hint. None when no issue carries the marker; a failed
    lookup is an error, never "absent"."""
    record = core.load_record(core.record_path(ctx.root, ctx.name))
    issues = record.get("issues") or {}
    cached = issues.get("parent") if key == "parent" else (issues.get("pieces") or {}).get(key)
    fields = f"feature={ctx.feature} " + ("kind=parent" if key == "parent" else f"phase={key}")
    want = github.marker_key(f"<!-- {core.MARKER_PREFIX} {fields} -->")
    if cached:
        issue = gh.api("GET", f"repos/{gh.repo}/issues/{cached}")
        if github.marker_key(issue.get("body") or "") == want:
            return int(cached)
    found = github.index_issues(gh).by_marker.get(want)
    return int(found["number"]) if found else None


def upsert_comment(gh: github.Gh, number: int, marker: str, body: str) -> tuple[str, dict[str, Any]]:
    """Post ``body`` on issue/PR ``number`` once: a comment carrying ``marker`` is reused."""
    for c in gh.list_all(f"repos/{gh.repo}/issues/{number}/comments"):
        if marker in (c.get("body") or ""):
            return "unchanged", c
    return "posted", gh.api("POST", f"repos/{gh.repo}/issues/{number}/comments", {"body": f"{marker}\n{body}"}) or {}


def cli_parser(doc: str) -> tuple[argparse.ArgumentParser, Any, argparse.ArgumentParser]:
    """(parser, subparsers, common): ``--feature/--repo/--json`` work before or after the subcommand."""
    ap = argparse.ArgumentParser(description=doc, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--feature")
    ap.add_argument("--bug", metavar="SLUG", help="a bug run (bug-<slug>) instead of a feature")
    ap.add_argument("--repo", metavar="OWNER/NAME")
    ap.add_argument("--json", action="store_true")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--feature", default=argparse.SUPPRESS)
    common.add_argument("--bug", metavar="SLUG", default=argparse.SUPPRESS)
    common.add_argument("--repo", metavar="OWNER/NAME", default=argparse.SUPPRESS)
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
    return ap, ap.add_subparsers(dest="cmd", required=True), common


def emit(args: argparse.Namespace, data: dict[str, Any], text: str) -> None:
    if getattr(args, "json", False):
        core.emit_json(data)
    else:
        print(text)


# ---------------------------------------------------------------------------
# next-ready
# ---------------------------------------------------------------------------


def next_ready(ctx: Ctx, not_ready: dict[str, list[str]] | None = None) -> list[str]:
    """Pending pieces whose own readiness is clean and whose prerequisites passed.

    Pending pieces held back by their own readiness (an open clarification or
    decision, drift) are reported in ``not_ready`` so the orchestrator can block them
    and ask, instead of silently waiting on them forever.
    """
    if is_bug(ctx):  # one fix piece (and corrections), no tasks.md and no dependencies
        return [k for k, p in (ctx.state.get("pieces") or {}).items() if p["status"] == "pending"]
    rep = model.validate_feature(ctx.root, ctx.fdir)
    if rep.remap_required:
        return []
    entries = rep.record.get("pieces") or {}
    pieces = ctx.state.get("pieces") or {}
    out = []
    for p in rep.derivation.pieces:
        st = pieces.get(p.key)
        if not st or st["status"] != "pending":
            continue
        reasons = rep.readiness[p.key]["reasons"]
        if reasons:
            if not_ready is not None:
                not_ready[p.key] = reasons
            continue
        if all((entries.get(d) or {}).get("satisfied") or (pieces.get(d) or {}).get("status") == "passed"
               for d in p.depends_on):
            out.append(p.key)
    return out


# ---------------------------------------------------------------------------
# open-pr
# ---------------------------------------------------------------------------


def is_bug(ctx: Ctx) -> bool:
    return ctx.state.get("kind") == "bug"


def _derived_piece(ctx: Ctx, key: str) -> model.Piece | None:
    if is_bug(ctx):
        return None
    d = model.derive(ctx.root, ctx.fdir, core.load_record(core.record_path(ctx.root, ctx.name)))
    return next((p for p in d.pieces if p.key == key), None)


def find_open_pr(gh: github.Gh, head: str, base: str | None = None) -> dict[str, Any] | None:
    owner = gh.repo.split("/")[0]
    q = f"repos/{gh.repo}/pulls?state=open&head={owner}:{head}"
    if base:
        q += f"&base={base}"
    prs = gh.list_all(q)
    return prs[0] if prs else None


def find_merged_pr(gh: github.Gh, head: str, base: str, sha: str) -> dict[str, Any] | None:
    """A PR from ``head`` into ``base`` already merged at exactly ``sha`` (resume)."""
    owner = gh.repo.split("/")[0]
    for pr in gh.list_all(f"repos/{gh.repo}/pulls?state=closed&head={owner}:{head}&base={base}"):
        if pr.get("merged") and (pr.get("head") or {}).get("sha") == sha:
            return pr
    return None


def ci_text(ci: dict[str, Any] | None) -> str:
    """One line for a PR body: the repository CI result at a SHA (D-CIWAIT)."""
    if not ci:
        return "not checked yet (checked before the merge)"
    st = ci.get("state")
    if st == "skipped":
        return "not required (`ci.require: false`)"
    if st == "none":
        return "none: the repository reported no checks for this commit"
    names = ", ".join(f"`{n}`" for n in ci.get("failing") or ci.get("pending") or ci.get("missing") or [])
    count = len(ci.get("checks") or [])
    return {"success": f"passed ({count} check(s))",
            "failure": f"**failed**: {names}",
            "timeout": f"**timed out** waiting for {names or 'checks'}",
            "pending": f"pending: {names}"}.get(st, str(st)) + (f" at {ci['at']}" if ci.get("at") else "")


def phase_pr_body(ctx: Ctx, key: str, sha: str) -> tuple[str, str]:
    p = nsstate.piece(ctx.state, key)
    dp = _derived_piece(ctx, key)
    title = f"[{ctx.name}] {dp.title if dp else key}"
    if is_bug(ctx):
        title = f"[{ctx.name}] {key}: reproduction and fix"
    issue = ((core.load_record(core.record_path(ctx.root, ctx.name)).get("issues") or {}).get("pieces") or {}).get(key)
    ci = p.get("ci") if (p.get("ci") or {}).get("sha") == sha else None
    body = core.render_template(ctx.root, "pr-phase.md", {
        "feature": ctx.feature, "piece": key, "title": title, "base": ctx.feature_branch,
        "sha": sha, "round": p.get("round") or 0, "issue": f"#{issue}" if issue else "not published",
        **{f: p.get(f) or "not_run" for f in REVIEW_FIELDS},
        "ci": ci_text(ci),
        "tasks": "\n".join(f"- `{r}`" for r in (dp.refs(ctx.feature) if dp else [])) or "_None._",
        "version": VERSION,
    })
    return title, body


def open_pr(ctx: Ctx, key: str, repo: str) -> dict[str, Any]:
    """Open or update the phase PR. Resume-safe: an open PR with this head is reused,
    and a PR already merged at this SHA (a crash after ``merge``) is adopted instead
    of opening a second one."""
    p = nsstate.piece(ctx.state, key)
    branch = phase_branch(ctx.name, key)
    guard_branch(ctx, ctx.feature_branch)
    sha = git(ctx.root, "rev-parse", f"refs/heads/{branch}")
    step = f"{key}:{round_of(ctx, key)}:pr"
    inputs = {"sha": sha, "base": ctx.feature_branch}
    done = nsstate.step_done(ctx.state, step, inputs)
    if done and p.get("pr") == done["result"].get("pr"):
        return {**done["result"], "skipped": True}
    gh = github.Gh(repo, ctx.root)
    merged = find_merged_pr(gh, branch, ctx.feature_branch, sha)
    if merged is not None:
        p["pr"] = merged["number"]
        result = {"piece": key, "pr": merged["number"], "action": "adopted-merged", "head": branch,
                  "sha": sha, "base": ctx.feature_branch}
        nsstate.step_complete(ctx.state, step, inputs, result)
        ctx.save()
        ctx.log(key, "pr", "adopted-merged", sha, f"PR #{merged['number']} {branch} -> {ctx.feature_branch}")
        return result
    rec = ctx.state["steps"].get(step) or {}
    if rec.get("intent") and not rec.get("done") and find_open_pr(gh, branch, ctx.feature_branch) is None:
        owner = gh.repo.split("/")[0]
        closed = [x for x in gh.list_all(f"repos/{repo}/pulls?state=closed&head={owner}:{branch}"
                                         f"&base={ctx.feature_branch}") if not x.get("merged")]
        if closed:
            # The interrupted open-pr created a PR that is now closed unmerged: a human
            # closed it. Opening a second PR would hide that decision; a human looks.
            raise core.NightshiftError(
                f"{key}: PR #{closed[0]['number']} from an interrupted open-pr was closed without merging; "
                "inspect and adopt it (reopen it, or record a decision) before resuming; nothing opened")
    nsstate.step_intent(ctx.state, step, inputs)
    ctx.save()
    push_branch(ctx, f"refs/heads/{branch}", branch)
    title, body = phase_pr_body(ctx, key, sha)
    pr = find_open_pr(gh, branch, ctx.feature_branch)
    if pr is None:
        pr = gh.api("POST", f"repos/{repo}/pulls",
                    {"title": title, "body": body, "head": branch, "base": ctx.feature_branch})
        action = "created"
    else:
        if (pr.get("body") or "").strip() != body.strip() or pr.get("title") != title:
            pr = gh.api("PATCH", f"repos/{repo}/pulls/{pr['number']}", {"title": title, "body": body}) or pr
            action = "updated"
        else:
            action = "unchanged"
    p["pr"] = pr["number"]
    result = {"piece": key, "pr": pr["number"], "action": action, "head": branch, "sha": sha,
              "base": ctx.feature_branch}
    nsstate.step_complete(ctx.state, step, inputs, result)
    ctx.save()
    ctx.log(key, "pr", action, sha, f"PR #{pr['number']} {branch} -> {ctx.feature_branch}")
    return result


# ---------------------------------------------------------------------------
# merge
# ---------------------------------------------------------------------------


def merge_refusal(p: dict[str, Any], sha: str) -> str:
    if p["status"] not in ("reviewing", "merging"):
        return f"piece is {p['status']}, not approved for merging"
    if p.get("candidate_sha") != sha:
        return f"--sha {sha} is not the candidate SHA ({p.get('candidate_sha')})"
    bad = [f"{f}={p.get(f)}" for f in REVIEW_FIELDS if p.get(f) != "passed"]
    if bad:
        return "evidence at this SHA is not all passed: " + ", ".join(bad)
    if not p.get("pr"):
        return "no phase PR recorded; run open-pr first"
    r = p.get("repro") or {}
    if p["loop"] == "fix" and not (r.get("ok") and r.get("ran") and r.get("fix_sha") == sha):
        return f"the reproduction is not verified at {sha[:12]}"
    return ""


def ci_config(config: dict[str, Any]) -> dict[str, Any]:
    cfg = {**nsconfig.DEFAULTS["ci"], **(config.get("ci") or {})}
    req = cfg.get("require", True)
    return {"require": req not in (False, "false", "no", "off", 0),
            "wait_timeout": core.parse_duration(cfg.get("wait_timeout"), 1800),
            "poll_interval": core.parse_duration(cfg.get("poll_interval"), 30),
            "required": [str(x) for x in (cfg.get("required") or [])]}


NO_CHECKS = "(no check registered)"


def wait_for_ci(ctx: Ctx, gh: github.Gh, key: str, sha: str) -> dict[str, Any]:
    """Poll the repository's checks on ``sha`` until none is pending or the timeout.
    ``state``: ``success``, ``failure``, ``timeout`` or ``skipped``. With ``ci.require``
    true, "no checks registered yet" is pending: it times out, never merges."""
    cfg = ci_config(ctx.config)
    if not cfg["require"]:
        return {"sha": sha, "state": "skipped", "checks": [], "at": nsstate.now()}
    deadline = time.monotonic() + cfg["wait_timeout"]
    polls = 0
    while True:
        res = github.ci_status(gh, sha, cfg["required"])
        polls += 1
        # 1.1.3 (L1 phase D): no check run and no status *yet* is not terminal. A fresh
        # PR's workflow registers seconds later; with ci.require true it is waited for,
        # and if nothing ever registers the piece parks ci_timeout (never merges).
        if res["state"] == "none":
            res["state"] = "pending"
            res["missing"] = sorted(set(res["missing"]) | {NO_CHECKS})
        if res["state"] != "pending":
            break
        if time.monotonic() >= deadline:
            res["state"] = "timeout"
            break
        if polls == 1:
            ctx.log(key, "ci", "waiting", sha, "pending: " + ", ".join(res["pending"] + res["missing"]))
        time.sleep(max(0, min(cfg["poll_interval"], deadline - time.monotonic())))
    res.update(polls=polls, at=nsstate.now())
    return res


def ci_gate(ctx: Ctx, gh: github.Gh, key: str, sha: str) -> dict[str, Any]:
    """D-CIWAIT: wait for the repository's own checks; park the piece on red or timeout."""
    ci = wait_for_ci(ctx, gh, key, sha)
    if ci.get("polls", 0) > 1:
        nsstate.refresh(ctx.root, ctx.name, ctx.state)  # a long wait: start from fresh state
    p = nsstate.piece(ctx.state, key)
    p["ci"] = {k: ci.get(k) for k in ("sha", "state", "failing", "pending", "missing", "combined_status", "at")}
    p["ci"]["checks"] = [{"name": c["name"], "conclusion": c["conclusion"]} for c in ci.get("checks") or []]
    ev = ctx.run_dir / "evidence" / key / sha
    ev.mkdir(parents=True, exist_ok=True)
    (ev / "ci.json").write_text(json.dumps(ci, indent=2) + "\n", encoding="utf-8")
    state = ci["state"]
    detail = {"success": f"{len(ci['checks'])} check(s) passed", "none": "ci: none (no checks reported)",
              "skipped": "ci: skipped (ci.require is false)",
              "failure": "failing: " + ", ".join(ci.get("failing") or []),
              "timeout": "still pending: " + ", ".join((ci.get("pending") or []) + (ci.get("missing") or []))}[state]
    if state in ("failure", "timeout"):
        reason = "ci_failed" if state == "failure" else "ci_timeout"
        nsstate.transition(ctx.state, key, "parked", by="phase_merge", reason=reason)
        p["question"] = f"repository CI {'failed' if state == 'failure' else 'timed out'} at {sha[:12]}: {detail}"
    ctx.save()
    ctx.log(key, "ci", {"success": "passed", "failure": "failed"}.get(state, state), sha, detail)
    title, body = phase_pr_body(ctx, key, sha)
    try:
        gh.api("PATCH", f"repos/{gh.repo}/pulls/{p['pr']}", {"title": title, "body": body})
    except core.NightshiftError as exc:
        ctx.log(key, "ci", "pr_body_not_updated", sha, str(exc)[:300])
    return ci


def merge(ctx: Ctx, key: str, sha: str, repo: str) -> dict[str, Any]:
    p = nsstate.piece(ctx.state, key)
    done = nsstate.step_done(ctx.state, f"{key}:{round_of(ctx, key)}:merge", {"sha": sha, "pr": p.get("pr")})
    if done and p.get("merged_sha"):
        return {**done["result"], "skipped": True}
    why = merge_refusal(p, sha)
    if why:
        ctx.log(key, "merge", "refused", sha, why)
        raise core.NightshiftError(f"{key}: merge refused: {why}")
    gh = github.Gh(repo, ctx.root)
    pr = gh.api("GET", f"repos/{repo}/pulls/{p['pr']}")
    base = guard_branch(ctx, pr["base"]["ref"])
    if base != ctx.feature_branch:
        raise core.NightshiftError(f"{key}: PR #{p['pr']} targets {base}, not the feature branch")
    if pr["head"]["ref"] != phase_branch(ctx.name, key):
        raise core.NightshiftError(f"{key}: PR #{p['pr']} head is {pr['head']['ref']}, not this phase")
    step = f"{key}:{round_of(ctx, key)}:merge"
    inputs = {"sha": sha, "pr": p["pr"]}
    if pr.get("merged") and pr.get("merge_commit_sha"):
        merged = pr["merge_commit_sha"]  # adopt a merge made before a crash
        action = "adopted"
    else:
        if pr["state"] != "open":
            raise core.NightshiftError(f"{key}: PR #{p['pr']} is {pr['state']} and not merged")
        if pr["head"]["sha"] != sha:
            ctx.log(key, "merge", "refused", sha, f"PR head moved to {pr['head']['sha']}")
            raise core.NightshiftError(f"{key}: PR head is {pr['head']['sha']}, not the evidence SHA {sha}")
        ci = ci_gate(ctx, gh, key, sha)
        if ci["state"] in ("failure", "timeout"):
            return {"piece": key, "pr": p["pr"], "action": "parked", "reason": p["reason"], "sha": sha,
                    "merged_sha": None, "base": base, "ci": p["ci"]}
        if p["status"] == "reviewing":
            nsstate.transition(ctx.state, key, "merging", by="phase_merge")
        nsstate.step_intent(ctx.state, step, inputs)
        ctx.save()
        res = gh.api("PUT", f"repos/{repo}/pulls/{p['pr']}/merge",
                     {"sha": sha, "merge_method": "merge",
                      "commit_title": f"Merge {phase_branch(ctx.name, key)} into {base} (nightshift)"})
        merged = res["sha"]
        action = "merged"
    if p["status"] == "reviewing":
        nsstate.transition(ctx.state, key, "merging", by="phase_merge")
    p["merged_sha"] = merged
    result = {"piece": key, "pr": p["pr"], "action": action, "merged_sha": merged, "base": base, "sha": sha,
              "ci": p.get("ci") if (p.get("ci") or {}).get("sha") == sha else None}
    nsstate.step_complete(ctx.state, step, inputs, result)
    ctx.save()
    ctx.log(key, "merge", action, merged, f"PR #{p['pr']} at {sha} into {base}")
    return result


# ---------------------------------------------------------------------------
# combined
# ---------------------------------------------------------------------------


def _combined_command(ctx: Ctx, override: str | None, head: str) -> tuple[list[str], str]:
    """(argv, where): ``where`` is ``worktree`` (run at ``head``) or ``root`` (checks.py at ``--sha head``)."""
    if override:
        return shlex.split(override), "worktree"
    checks_py = Path(__file__).resolve().parent / "checks.py"
    if checks_py.is_file():
        scope = ["--bug", ctx.state["bug"]] if is_bug(ctx) else ["--feature", ctx.feature]
        return [sys.executable, str(checks_py), *scope, "--combined", "--sha", head, "--json"], "root"
    checks = ctx.config.get("checks") or []
    if not checks:
        raise core.NightshiftError("no combined checks: no checks.py, no --checks-cmd and no configured checks")
    return [], "config"


def _run(argv: list[str], cwd: Path, timeout: int) -> int:
    try:
        return subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                              env=core.tool_env()).returncode
    except subprocess.TimeoutExpired:
        return 124
    except OSError:
        return 127


def _pushed_revert(ctx: Ctx, merged: str, head: str) -> str:
    """A commit after ``merged`` on the feature branch that reverts it, or ""."""
    out = git(ctx.root, "log", "--format=%H", f"--grep=This reverts commit {merged}", f"{merged}..{head}",
              check=False)
    return out.splitlines()[0] if out else ""


TASK_LINE_RE = re.compile(r"^- \[[ xX]\] (?P<id>T\d+)\b.*$", re.M)


def task_line(t: core.Task) -> str:
    """A task as ``publish.py`` writes it into a sub-issue body."""
    return (f"- [{'x' if t.done else ' '}] {t.id}{' [P]' if t.parallel else ''}"
            f"{' [' + t.story + ']' if t.story else ''} {t.description}")


def tick_tasks(body: str, tasks: dict[str, core.Task]) -> str:
    """Regenerate every task line of an issue body from ``tasks`` (Spec Kit's ``[X]``)."""
    return TASK_LINE_RE.sub(lambda m: task_line(tasks[m.group("id")]) if m.group("id") in tasks else m.group(0),
                            body)


def record_pass_on_issue(ctx: Ctx, key: str, head: str, repo: str) -> dict[str, Any]:
    """After a green combined check: comment once on the piece's sub-issue and tick its
    task checklist from ``tasks.md`` at ``head``. Never closes the sub-issue: it closes
    when the feature PR merges (``handover.py close-issues``)."""
    gh = github.Gh(repo, ctx.root)
    number = find_issue(gh, ctx, key)
    if number is None:
        return {"issue": None, "action": "no-sub-issue"}
    p = nsstate.piece(ctx.state, key)
    mk = f"<!-- {core.MARKER_PREFIX} merged piece={key} sha={p['merged_sha']} -->"
    text = (f"`{key}` merged into `{ctx.feature_branch}` at `{p['merged_sha']}` (PR #{p.get('pr')}); "
            f"combined checks green at `{head}`. This issue stays open until the feature PR merges.")
    comment, _ = upsert_comment(gh, number, mk, text)
    ticked = "unchanged"
    try:
        tasks_text = git(ctx.root, "show", f"{head}:{ctx.feature}/tasks.md")
    except core.NightshiftError:
        tasks_text = ""
    if tasks_text:
        tasks = {t.id: t for t in core.parse_tasks_text(tasks_text, Path("tasks.md")).tasks}
        issue = gh.api("GET", f"repos/{gh.repo}/issues/{number}")
        body = issue.get("body") or ""
        new = tick_tasks(body, tasks)
        if new != body:
            gh.api("PATCH", f"repos/{gh.repo}/issues/{number}", {"body": new})
            ticked = "ticked"
    return {"issue": number, "comment": comment, "checklist": ticked}


def combined(ctx: Ctx, key: str, checks_cmd: str | None, timeout: int, repo: str | None = None) -> dict[str, Any]:
    p = nsstate.piece(ctx.state, key)
    prev = ((ctx.state["steps"].get(f"{key}:{round_of(ctx, key)}:combined") or {}).get("done") or {})
    if p["status"] in ("passed", "parked") and prev.get("result", {}).get("merged_sha") == p.get("merged_sha"):
        return {**prev["result"], "skipped": True}  # resume: already decided for this merge
    if p["status"] != "merging" or not p.get("merged_sha"):
        raise core.NightshiftError(f"{key}: combined checks need a merged piece (status {p['status']})")
    branch = guard_branch(ctx, ctx.feature_branch)
    # Origin's head, fetched: the local feature branch can lag what GitHub just merged (D23b).
    head = fetch_branch(ctx.root, branch)
    merged = p["merged_sha"]
    if subprocess.run(["git", "merge-base", "--is-ancestor", merged, head], cwd=ctx.root,
                      capture_output=True).returncode != 0:
        ctx.log(key, "combined", "refused", head, f"origin/{branch} head {head} does not contain merge {merged}")
        raise core.NightshiftError(f"{key}: combined checks refused: merge {merged} is not on "
                                   f"origin/{branch} ({head}); nothing checked")
    step = f"{key}:{round_of(ctx, key)}:combined"
    rec = ctx.state["steps"].get(step) or {}
    revert = _pushed_revert(ctx, merged, head) if rec.get("intent") and not rec.get("done") else ""
    if revert:
        # Resume: an interrupted run already reverted this merge and pushed it.
        # Adopt that outcome; never re-run the checks on the reverted head and
        # call the piece passed.
        inputs = {"merged_sha": merged, "head": head}
        result = {"piece": key, "sha": head, "combined_sha": head, "merged_sha": merged, "outcome": "failed",
                  "exit": None, "revert_sha": revert, "adopted": True}
        p["combined_sha"] = head
        nsstate.transition(ctx.state, key, "parked", by="phase_merge", reason="combined_checks_failed")
        nsstate.step_complete(ctx.state, step, inputs, result)
        ctx.save()
        ctx.log(key, "combined", "failed", head, f"red; reverted by {revert} (adopted after an interruption)")
        return result
    inputs = {"merged_sha": merged, "head": head}
    nsstate.step_intent(ctx.state, step, inputs)
    ctx.save()
    wt = ctx.run_dir / "worktrees" / f"_combined-{key}"
    if wt.exists():
        git(ctx.root, "worktree", "remove", "--force", str(wt), check=False)
    git(ctx.root, "worktree", "add", "-q", "--detach", str(wt), head)
    try:
        argv, where = _combined_command(ctx, checks_cmd, head)
        if where == "config":
            codes = [_run([str(a) for a in c], wt, timeout) for c in ctx.config["checks"]]
            code = 0 if all(c == 0 for c in codes) else 1
        else:
            code = _run(argv, wt if where == "worktree" else ctx.root, timeout)
        if where == "root" and code == 3:
            # checks.py: environment_error (all checks failed with empty logs). Not a
            # verdict on the merge, so never revert on it; the step stays open.
            ctx.log(key, "combined", "environment_error", head, "combined checks could not run")
            raise core.NightshiftError(f"{key}: combined checks hit an environment error at {head}; "
                                       "retry once, then stop with environment_failure")
        green = code == 0
        result: dict[str, Any] = {"piece": key, "sha": head, "combined_sha": head, "merged_sha": merged,
                                  "outcome": "passed" if green else "failed", "exit": code}
        p["combined_sha"] = head
        if green:
            nsstate.transition(ctx.state, key, "passed", by="phase_merge")
            if not p.get("outcome"):  # a build piece completes here; a fix piece is verified
                nsstate.set_outcome(p, "verified" if p["loop"] == "fix" else "completed", by="phase_merge")
            # Dependents blocked on this piece that now wait only on passed pieces go
            # back to pending (D23: the orchestrator had to free them by hand).
            result["released"] = nsstate.release_waiting(ctx.state, key, by="phase_merge", settled=("passed",))
        else:
            git(wt, "revert", "-m", "1", "--no-edit", merged)
            revert = git(wt, "rev-parse", "HEAD")
            push_branch(ctx, revert, branch)
            result["revert_sha"] = revert
            nsstate.transition(ctx.state, key, "parked", by="phase_merge", reason="combined_checks_failed")
    finally:
        git(ctx.root, "worktree", "remove", "--force", str(wt), check=False)
    nsstate.step_complete(ctx.state, step, inputs, result)
    ctx.save()
    detail = (f"combined checks green at origin/{branch} {head} (contains merge {merged})" if green
              else f"red (exit {code}) at origin/{branch} {head}; reverted by {result['revert_sha']}")
    ctx.log(key, "combined", result["outcome"], head, detail)
    for dep in result.get("released") or []:
        ctx.log(dep, "blocker", "unblocked", head, f"{key} passed")
    if green and not is_bug(ctx):  # a bug run has one issue and no sub-issues
        # GitHub bookkeeping is a projection: a failure here never undoes the pass.
        try:
            result["issue"] = record_pass_on_issue(ctx, key, head, repo or resolve_repo(ctx.root))
            iss = result["issue"]
            ctx.log(key, "issue", iss.get("action") or "updated", head,
                    f"#{iss.get('issue')}: comment {iss.get('comment')}, checklist {iss.get('checklist')}")
        except core.NightshiftError as exc:
            result["issue"] = {"error": str(exc)[:300]}
            ctx.log(key, "issue", "not_updated", head, str(exc)[:300])
    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    ap, sub, common = cli_parser(__doc__)
    sub.add_parser("next-ready", parents=[common])
    o = sub.add_parser("open-pr", parents=[common])
    o.add_argument("--piece", required=True)
    m = sub.add_parser("merge", parents=[common])
    m.add_argument("--piece", required=True)
    m.add_argument("--sha", required=True)
    c = sub.add_parser("combined", parents=[common])
    c.add_argument("--piece", required=True)
    c.add_argument("--checks-cmd", help="override: a shell-quoted command run at origin's feature head")
    c.add_argument("--timeout", type=int, default=1800)
    args = ap.parse_args(argv)
    ctx = load_ctx(args.feature, bug=getattr(args, "bug", None))
    if args.cmd == "next-ready":
        held: dict[str, list[str]] = {}
        ready = next_ready(ctx, held)
        text = "\n".join(ready) or "(nothing ready)"
        if held:
            text += "\n" + "\n".join(f"not ready: {k} ({', '.join(v)})" for k, v in held.items())
        emit(args, {"ready": ready, "not_ready": held}, text)
        return 0
    if args.cmd == "open-pr":
        out = open_pr(ctx, args.piece, resolve_repo(ctx.root, args.repo))
        emit(args, out, f"{out['action']} PR #{out['pr']} for {args.piece} at {out['sha']}")
        return 0
    if args.cmd == "merge":
        out = merge(ctx, args.piece, args.sha, resolve_repo(ctx.root, args.repo))
        if out["action"] == "parked":
            emit(args, out, f"not merged: PR #{out['pr']} parked {out['reason']} ({ci_text(out['ci'])})")
            return 1
        emit(args, out, f"{out['action']} PR #{out['pr']} as {out['merged_sha']}; CI: {ci_text(out.get('ci'))}")
        return 0
    out = combined(ctx, args.piece, args.checks_cmd, args.timeout, args.repo)
    emit(args, out, f"combined checks {out['outcome']} at {out['sha']}")
    return 0 if out["outcome"] == "passed" else 1


if __name__ == "__main__":
    core.run_main(main)
