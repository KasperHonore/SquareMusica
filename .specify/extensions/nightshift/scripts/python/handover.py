#!/usr/bin/env python3
"""Final handover: feature PR, preview, acceptance and clean-up (design §6.4, §8).

Subcommands:

- ``pr [--stop-reason R] [--notes F]``: render ``templates/pr-feature.md`` and open or
  update the feature PR into the base branch. The body (adapted from Matt Pocock's ``pr``
  and HumanLayer's ``visual-pr``/``show-me`` skills, MIT; ``THIRD_PARTY.md``):
  *Needs your decision* first (parked and blocked pieces with their questions verbatim,
  untraced converge gaps), *Summary*, *Evidence at <head>* (per piece: checks, critic
  verdict, CI, combined; the preview), *Merge danger* (door and blast radius) with the
  *detected one-way signals* (migrations, deleted files, lockfiles and dependency
  manifests, CI and gate paths: path globs over ``<base>...<head>``, mechanical),
  *Acceptance criteria* verbatim from ``spec.md``, *Changed during the run* (answers
  absorbed old → new, breakage found while building) and *Known gaps*. ``--notes F`` is
  the dispatcher's ``handover-notes.md`` (``## Summary`` and ``## Merge danger``,
  agent-written from a fresh read of the diff); its two sections are inserted verbatim
  and kept for later re-renders. Sets the run's stop reason (default
  ``awaiting_acceptance``, or ``partial_awaiting_acceptance`` when anything is parked,
  blocked or unfinished) and stops the run.
- ``preview [--stop]``: start ``preview.command`` at the exact PR head SHA in an isolated
  worktree ``.nightshift/<name>/preview``, health-check it, record url + SHA and
  comment them on the PR. ``--stop`` stops it.
- ``accept --text T [--confirmed REF ...] [--untested REF ...] [--feedback F]``: post
  the SHA-bound acceptance comment (D-ACC) and regenerate the feature PR body, where the
  acceptance criteria listed as ``--confirmed`` are ticked (untick when it is void).
- ``check-acceptance``: if a commit landed after the acceptance, mark it void, say so
  in the PR body and restart the preview at the new head (D17).
- ``close-issues``: only after GitHub reports the feature PR merged, close the parent
  issue and every sub-issue with a comment (marker-deduplicated); refused otherwise.
  Nightshift never closes a sub-issue earlier: a passed piece's sub-issue gets a
  "merged into the feature branch" comment and a ticked checklist instead.
- ``cleanup``: once the feature PR is merged or closed, delete the local evidence
  folder; keep the logbook and the PR summary (D-EV, D22).

Safeguards:

- *mechanical*: there is no merge call in this script. The feature PR is opened or
  updated only; merging to ``main`` is the human's (D-MERGE). A static test checks it.
- *mechanical*: acceptance is bound to the SHA it was given at; ``check-acceptance``
  compares it with the live head and voids it on any difference.
- *mechanical*: ``cleanup`` refuses while the PR is open and never deletes the logbook.
- *behavioural*: the session must call ``accept`` only on the human's own words, and
  must run ``check-acceptance`` after every push.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_config as nsconfig  # noqa: E402
import nightshift_core as core  # noqa: E402
import nightshift_github as github  # noqa: E402
import nightshift_model as model  # noqa: E402
import nightshift_state as nsstate  # noqa: E402
import phase_merge as pm  # noqa: E402

VERSION = core.VERSION
FIELDS = ("checks", "verdict")


def handover_state(ctx: pm.Ctx) -> dict[str, Any]:
    return ctx.state.setdefault("handover", {})


def base_branch(ctx: pm.Ctx) -> str:
    return str(ctx.config.get("base_branch") or pm.default_branch(ctx.root) or "main")


# ---------------------------------------------------------------------------
# PR body
# ---------------------------------------------------------------------------


def _spec(ctx: pm.Ctx) -> core.SpecDoc | None:
    path = ctx.fdir / "spec.md"
    return core.parse_spec(path) if path.is_file() else None


def _story_piece(ctx: pm.Ctx) -> dict[str, str]:
    d = model.derive(ctx.root, ctx.fdir)
    return {p.story: p.key for p in d.pieces if p.story}


def converge_tasks(ctx: pm.Ctx) -> tuple[list[core.Task], list[core.Task]]:
    """(untraced, open traced not built) tasks of the Convergence phases on disk (D-3')."""
    spec = _spec(ctx)
    untraced, open_traced = [], []
    for p in model.derive(ctx.root, ctx.fdir).pieces:
        if p.kind != "convergence":
            continue
        tr, un = model.converge_split(p, spec)
        untraced += un
        if (ctx.state["pieces"].get(p.key) or {}).get("status") != "passed":
            open_traced += tr
    return untraced, open_traced


def task_text(ctx: pm.Ctx, t: core.Task) -> str:
    tag = f" ({t.gap_type})" if t.gap_type else ""
    return f"`{t.id}`{tag}: {t.description} (`{ctx.feature}/tasks.md` line {t.line})"


def attention_section(ctx: pm.Ctx) -> str:
    lines = []
    for key, p in ctx.state["pieces"].items():
        if p["status"] in ("blocked", "parked"):
            q = p.get("question")
            lines.append(f"- **`{key}` {p['status']} ({p.get('reason')})**" + (f"\n  > {q}" if q else ""))
    untraced, _ = converge_tasks(ctx)
    lines += [f"- Converge gap that no approved line asks for (a product decision): {task_text(ctx, t)}"
              for t in untraced]
    return "\n".join(lines) or "Nothing is parked or blocked."


NOTE_RE = re.compile(r"^##\s+(Summary|Merge danger)\s*$", re.M | re.I)
NO_NOTES = "_No agent notes: the dispatcher did not pass `handover.py pr --notes`._"


def note_sections(text: str) -> dict[str, str]:
    """The ``## Summary`` and ``## Merge danger`` sections of ``handover-notes.md``, verbatim."""
    parts = NOTE_RE.split(text)
    return {parts[i].strip().lower(): parts[i + 1].strip() for i in range(1, len(parts) - 1, 2)}


# One-way signals: changes that are hard to walk back (mechanical path globs).
ONE_WAY = {
    "migration": ["**/migrations/**", "**/migrate/**", "**/alembic/**", "**/*.sql", "**/schema.prisma"],
    "dependencies": ["**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/poetry.lock",
                     "**/Pipfile.lock", "**/uv.lock", "**/go.sum", "**/Cargo.lock", "**/Gemfile.lock",
                     "**/package.json", "**/pyproject.toml", "**/requirements*.txt", "**/go.mod", "**/Cargo.toml"],
    "CI or gate": [".github/**"],
}


def one_way_signals(ctx: pm.Ctx, base: str, head: str) -> list[str]:
    """``kind: path`` per changed path that matches a one-way glob, and every deleted file."""
    try:
        rows = pm.git(ctx.root, "diff", "--name-status", "--no-renames", f"origin/{base}...{head}").splitlines()
    except core.NightshiftError:
        return ["(could not diff against the base branch)"]
    globs = {**ONE_WAY, "CI or gate": ONE_WAY["CI or gate"] + list(nsconfig.load(ctx.root)["gate_paths"])}
    out = []
    for row in rows:
        status, _, path = row.partition("\t")
        kinds = [k for k, g in globs.items() if nsconfig.matches_any(path, g)] + (["deleted"] if status == "D" else [])
        out += [f"- {k}: `{path}`" for k in kinds]
    return out


def changes_section(ctx: pm.Ctx) -> str:
    lines = []
    for n in ctx.state.get("changes") or []:  # absorbed with an answer (blocker.py resolve)
        note = f" ({n['note']})" if n.get("note") else ""
        lines.append(f"- `{n['ref']}` changed with the answer {n.get('answer') or '-'}{note}:\n"
                     f"  - was: {n.get('old') or '(new)'}\n  - now: {n['new']}")
    found = found_section(ctx)
    return "\n".join(lines + ([found] if found else [])) or "Nothing changed during the run."


def acceptance_section(ctx: pm.Ctx) -> str:
    spec = _spec(ctx)
    if spec is None or not spec.scenarios:
        return "_No acceptance scenarios in spec.md._"
    pieces = _story_piece(ctx)
    acc = handover_state(ctx).get("acceptance") or {}
    # Ticked only for refs the owner confirmed in a live (not void) acceptance (D-ACC).
    confirmed = set(acc.get("confirmed") or []) if acc and not acc.get("void") else set()
    out, story = [], ""
    for s in spec.scenarios:
        if s.story != story:
            story = s.story
            key = pieces.get(story, "")
            st = (ctx.state["pieces"].get(key) or {}).get("status", "not in run")
            title = spec.stories.get(story, {}).get("title", "")
            out.append(f"\n**{story}: {title}** (`{key or '-'}`: {st})\n")
        out.append(f"- [{'x' if s.ref in confirmed else ' '}] **{s.ref}**: {s.text}")
    return "\n".join(out).strip()


def _combined_results(ctx: pm.Ctx) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for step, rec in (ctx.state.get("steps") or {}).items():
        piece, _, kind = step.rpartition(":")
        piece = piece.rsplit(":", 1)[0]
        if kind == "combined" and rec.get("done"):
            out[piece] = rec["done"]["result"]
    return out


def evidence_section(ctx: pm.Ctx, head: str) -> str:
    combined = _combined_results(ctx)
    rows = ["| Piece | Status | Candidate | Checks | Critic | CI | Merged | Combined |",
            "|---|---|---|---|---|---|---|---|"]
    for key, p in ctx.state["pieces"].items():
        c = combined.get(key)
        cs = f"{c['outcome']} at `{c['sha'][:12]}`" if c else "not run"
        ci = (p.get("ci") or {}).get("state") or "-"
        rows.append(f"| `{key}` | {p['status']} | `{(p.get('candidate_sha') or '-')[:12]}` | "
                    + " | ".join(p.get(f) or "not_run" for f in FIELDS)
                    + f" | {ci} | `{(p.get('merged_sha') or '-')[:12]}` | {cs} |")
    at_head = [k for k, c in combined.items() if c.get("sha") == head]
    if at_head:
        tail = f"Combined checks ran at the head `{head}` (after `{', '.join(at_head)}`)."
    else:
        tail = f"No combined checks ran at the head `{head}`; treat its evidence as not checked."
    return "\n".join(rows) + "\n\n" + tail


def found_section(ctx: pm.Ctx) -> str:
    """D-FOUND: pre-existing blockers fixed in a phase, each a separate finding with
    its own check; non-blockers filed as new issues and not fixed."""
    fixed, filed = [], []
    for key, p in ctx.state["pieces"].items():
        for f in p.get("prefixed") or []:
            fixed.append(f"- `{key}`: pre-existing blocker fixed in the phase: {f['summary']} "
                         f"(own check `{f['check_id']}`, at `{(f.get('sha') or '-')[:12]}`)")
        for f in p.get("found") or []:
            filed.append(f"- `{key}`: #{f['issue']} {f['title']} (filed, not fixed)")
    return "\n".join(fixed + filed)


def gaps_section(ctx: pm.Ctx) -> str:
    gaps = [f"- `{k}` is {p['status']}" + (f" ({p.get('reason')})" if p.get("reason") else "")
            for k, p in ctx.state["pieces"].items() if p["status"] != "passed"]
    _, open_traced = converge_tasks(ctx)
    gaps += [f"- Converge gap still open after {ctx.state.get('converge_rounds') or 0} round(s): {task_text(ctx, t)}"
             for t in open_traced]
    if not ctx.state.get("converge_rounds"):
        gaps.append("- `/speckit-converge` did not run (it runs only once every piece passed; a parked or blocked piece skips it).")
    return "\n".join(gaps) or "None known."


def preview_section(ctx: pm.Ctx, head: str) -> str:
    pv = handover_state(ctx).get("preview")
    if not pv:
        return "No preview started yet."
    stale = "" if pv.get("sha") == head else f" (stale: the head is now `{head}`)"
    return f"{pv.get('url')} at `{pv.get('sha')}`{stale}"


def acceptance_notice(ctx: pm.Ctx, head: str) -> str:
    acc = handover_state(ctx).get("acceptance")
    if not acc:
        return "Not accepted yet."
    if acc.get("void") or acc.get("sha") != head:
        return (f"> **Acceptance is void.** It was given at `{acc.get('sha')}` ({acc.get('at')}); "
                f"commit `{head}` landed after it. Re-test and accept again.")
    return f"**Accepted at `{acc['sha']}`** ({acc.get('at')}): {acc.get('text')}"


def default_stop_reason(ctx: pm.Ctx) -> str:
    statuses = {p["status"] for p in ctx.state["pieces"].values()}
    return "awaiting_acceptance" if statuses <= {"passed"} else "partial_awaiting_acceptance"


def pr_title(ctx: pm.Ctx) -> str:
    spec = _spec(ctx)
    return f"[{ctx.name}] {spec.title if spec else ctx.name}"


def render_body(ctx: pm.Ctx, head: str) -> str:
    notes = note_sections(handover_state(ctx).get("notes") or "")
    signals = one_way_signals(ctx, base_branch(ctx), head)
    return core.render_template(ctx.root, "pr-feature.md", {
        "feature": ctx.feature, "title": pr_title(ctx), "base": base_branch(ctx),
        "stop_reason": ctx.state.get("stop_reason") or "running", "head_sha": head, "time": nsstate.now(),
        "acceptance_notice": acceptance_notice(ctx, head), "attention": attention_section(ctx),
        "summary": notes.get("summary") or NO_NOTES, "danger": notes.get("merge danger") or NO_NOTES,
        "signals": "\n".join(signals) or "None.", "acceptance": acceptance_section(ctx),
        "changes": changes_section(ctx), "evidence": evidence_section(ctx, head),
        "preview": preview_section(ctx, head), "gaps": gaps_section(ctx), "version": VERSION,
    })


def upsert_feature_pr(ctx: pm.Ctx, gh: github.Gh, head: str) -> dict[str, Any]:
    branch = ctx.feature_branch
    base = base_branch(ctx)
    if branch in pm.protected_branches(ctx.root, ctx.config):
        raise core.NightshiftError(f"the feature branch {branch} is a protected branch")
    title = pr_title(ctx)
    body = render_body(ctx, head)
    pr = pm.find_open_pr(gh, branch, base)
    if pr is None:
        pr = gh.api("POST", f"repos/{gh.repo}/pulls", {"title": title, "body": body, "head": branch, "base": base})
        action = "created"
    else:
        pr = gh.api("PATCH", f"repos/{gh.repo}/pulls/{pr['number']}", {"title": title, "body": body}) or pr
        action = "updated"
    handover_state(ctx)["pr"] = pr["number"]
    return {"pr": pr["number"], "action": action, "head_sha": head, "base": base, "body": body}


def cmd_pr(ctx: pm.Ctx, gh: github.Gh, reason: str | None, notes: str | None = None) -> dict[str, Any]:
    """Open or update the feature PR. Resume-safe: the PR is found by head and base,
    so a crash after it was created updates that PR instead of opening another."""
    head = pm.remote_head(ctx.root, ctx.feature_branch)
    reason = reason or default_stop_reason(ctx)
    if notes is not None:
        handover_state(ctx)["notes"] = Path(notes).read_text(encoding="utf-8")
    step = "feature:0:handover"
    done = nsstate.step_done(ctx.state, step, {"head": head, "reason": reason, "notes": notes is not None})
    if done and ctx.state.get("stop_reason") == reason and handover_state(ctx).get("pr") == done["result"]["pr"]:
        return {"pr": done["result"]["pr"], "action": "unchanged", "head_sha": head, "base": base_branch(ctx),
                "stop_reason": reason, "skipped": True}
    nsstate.stop(ctx.state, reason)
    inputs = {"head": head, "reason": reason, "notes": notes is not None}
    nsstate.step_intent(ctx.state, step, inputs)
    ctx.save()
    out = upsert_feature_pr(ctx, gh, head)
    nsstate.step_complete(ctx.state, step, inputs, {"pr": out["pr"]})
    ctx.save()
    ctx.log("feature", "handover", reason, head, f"feature PR #{out['pr']}; stop: {reason}")
    released = release_own_lease(ctx)
    return {**out, "stop_reason": reason, "lease_released": released}


def release_own_lease(ctx: pm.Ctx) -> str:
    """The run stopped: release the caller's orchestrator lease (live L1 1.1.0: still held
    after handover). The attended steps that follow (preview, accept) need none."""
    owner = os.environ.get("NIGHTSHIFT_LEASE", "")
    lease = nsstate.read_lease(ctx.root, ctx.name)
    if not owner or not lease or lease.get("owner") != owner:
        return ""
    nsstate.release_lease(ctx.root, ctx.name, owner)
    ctx.log("_run", "lease", "released", None, f"{owner} at handover")
    return owner


# ---------------------------------------------------------------------------
# Preview
# ---------------------------------------------------------------------------


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _argv(cmd: Any, port: int) -> list[str]:
    parts = shlex.split(cmd) if isinstance(cmd, str) else [str(x) for x in cmd]
    return [x.replace("{port}", str(port)) for x in parts]


def stop_preview(ctx: pm.Ctx) -> bool:
    pv = handover_state(ctx).get("preview") or {}
    pid = pv.get("pid")
    stopped = False
    if pid:
        try:
            os.killpg(int(pid), signal.SIGTERM)
            stopped = True
        except (ProcessLookupError, PermissionError):
            pass
        pv["pid"] = None
    return stopped


def _healthy(url: str, cmd: Any, wt: Path, port: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if url:
            try:
                with urllib.request.urlopen(url, timeout=2) as resp:  # noqa: S310 (local preview)
                    if 200 <= resp.status < 400:
                        return True
            except (urllib.error.URLError, OSError):
                pass
        elif cmd:
            if subprocess.run(_argv(cmd, port), cwd=wt, capture_output=True,
                              env=core.tool_env()).returncode == 0:
                return True
        time.sleep(0.2)
    return False


def start_preview(ctx: pm.Ctx, gh: github.Gh | None, timeout: float | None) -> dict[str, Any]:
    cfg = ctx.config.get("preview") or {}
    if timeout is None:  # a cold start (install, build) can take longer than 30 s (D24b)
        ht = cfg.get("health_timeout", 30)
        if not isinstance(ht, (int, float)) or isinstance(ht, bool) or ht <= 0:
            raise core.NightshiftError("preview.health_timeout must be a positive number of seconds")
        timeout = float(ht)
    cmd = cfg.get("command")
    if not cmd:
        raise core.NightshiftError("no preview.command configured")
    head = pm.fetch_branch(ctx.root, ctx.feature_branch)
    step = "feature:0:preview"
    old = handover_state(ctx).get("preview") or {}
    if old.get("sha") == head and old.get("healthy") and old.get("pid") and _running(int(old["pid"])):
        # Resume: the preview at this exact SHA is up; only make sure it is announced.
        _announce_preview(ctx, gh, old, head)
        nsstate.step_complete(ctx.state, step, {"head": head}, {"url": old["url"], "sha": head})
        ctx.save()
        ctx.log("feature", "preview", "started", head, old["url"])
        return old
    stop_preview(ctx)  # a stale or half-started preview from an interrupted run
    nsstate.step_intent(ctx.state, step, {"head": head})
    ctx.save()
    wt = ctx.run_dir / "preview"
    if wt.exists():
        pm.git(ctx.root, "worktree", "remove", "--force", str(wt), check=False)
        shutil.rmtree(wt, ignore_errors=True)
    pm.git(ctx.root, "worktree", "prune", check=False)
    pm.git(ctx.root, "worktree", "add", "-q", "--detach", str(wt), head)
    port = int(cfg.get("port") or _free_port())
    url = str(cfg.get("url") or cfg.get("health_url") or f"http://127.0.0.1:{port}/").replace("{port}", str(port))
    health_url = str(cfg.get("health_url") or "").replace("{port}", str(port))
    logf = (ctx.run_dir / "preview.log").open("ab")
    proc = subprocess.Popen(_argv(cmd, port), cwd=wt, stdout=logf, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, start_new_session=True,
                            env=core.tool_env({"PORT": str(port)}))
    pv = {"url": url, "sha": head, "pid": proc.pid, "port": port, "worktree": str(wt),
          "started_at": nsstate.now(), "healthy": False}
    handover_state(ctx)["preview"] = pv
    ctx.save()  # the pid is on disk before anything else can crash
    core.test_crash("after-spawn:preview")
    ok = _healthy(health_url, cfg.get("health_command"), wt, port, timeout) if (health_url or cfg.get("health_command")) \
        else proc.poll() is None
    pv["healthy"] = ok
    if not ok:
        stop_preview(ctx)
        ctx.save()
        ctx.log("feature", "preview", "failed", head, f"health check failed for {url}")
        raise core.NightshiftError(f"preview did not become healthy at {url}")
    ctx.save()
    _announce_preview(ctx, gh, pv, head)
    nsstate.step_complete(ctx.state, step, {"head": head}, {"url": url, "sha": head})
    ctx.save()
    ctx.log("feature", "preview", "started", head, url)
    return pv


def _running(pid: int) -> bool:
    try:
        os.killpg(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[-1].split()[0] != "Z"
    except (OSError, IndexError):
        return True


def _announce_preview(ctx: pm.Ctx, gh: github.Gh | None, pv: dict[str, Any], head: str) -> None:
    """Make the feature PR name the live preview URL for ``head`` (marker dedup per SHA).

    A restarted preview at the same SHA gets a new port; the existing comment for that
    SHA is then edited to the live URL instead of being left on the dead one (D23b).
    """
    num = handover_state(ctx).get("pr")
    if gh is None or not num:
        return
    mk = f"<!-- {core.MARKER_PREFIX} preview sha={head} -->"
    body = f"{mk}\nPreview running at {pv['url']} for commit `{head}` ({pv['started_at']})."
    comments = gh.list_all(f"repos/{gh.repo}/issues/{num}/comments")
    mine = [c for c in comments if mk in (c.get("body") or "")]
    live = next((c for c in mine if f"Preview running at {pv['url']} " in (c.get("body") or "")), None)
    if live:
        c = live
    elif mine:
        c = gh.api("PATCH", f"repos/{gh.repo}/issues/comments/{mine[-1]['id']}", {"body": body}) or mine[-1]
        pv["comment_updated"] = True
    else:
        c = gh.api("POST", f"repos/{gh.repo}/issues/{num}/comments", {"body": body}) or {}
    pv["commented"] = True
    pv["comment"] = c.get("id")
    # The PR body's Preview section names the same URL and SHA (live L1 1.1.0, #70).
    title = pr_title(ctx)
    gh.api("PATCH", f"repos/{gh.repo}/pulls/{num}", {"title": title, "body": render_body(ctx, head)})


# ---------------------------------------------------------------------------
# Acceptance
# ---------------------------------------------------------------------------


def _refs_lines(spec: core.SpecDoc | None, refs: list[str]) -> str:
    by_ref = {s.ref: s.text for s in (spec.scenarios if spec else [])}
    return "\n".join(f"- **{r}**: {by_ref[r]}" if r in by_ref else f"- {r}" for r in refs) or "_None._"


def _split(values: list[str] | None) -> list[str]:
    out: list[str] = []
    for v in values or []:
        out += [x.strip() for x in v.split(",") if x.strip()]
    return out


def accept(ctx: pm.Ctx, gh: github.Gh, text: str, confirmed: list[str], untested: list[str] | None,
           feedback: str) -> dict[str, Any]:
    num = handover_state(ctx).get("pr")
    if not num:
        raise core.NightshiftError("no feature PR; run handover pr first")
    head = pm.remote_head(ctx.root, ctx.feature_branch)
    spec = _spec(ctx)
    if untested is None:
        untested = [s.ref for s in (spec.scenarios if spec else []) if s.ref not in confirmed]
    pv = handover_state(ctx).get("preview")
    preview = f"{pv['url']} at `{pv['sha']}`" if pv else "no preview was running"
    if pv and pv.get("sha") != head:
        preview += f" (not the accepted commit `{head}`)"
    at = nsstate.now()
    mk = f"<!-- {core.MARKER_PREFIX} acceptance sha={head} t={core.sha256_text(text)[:12]} -->"
    body = core.render_template(ctx.root, "acceptance-comment.md", {
        "marker": mk, "sha": head, "text": text,
        "preview": preview, "time": at, "confirmed": _refs_lines(spec, confirmed),
        "untested": _refs_lines(spec, untested), "feedback": feedback or "_None._", "version": VERSION,
    })
    # Resume-safe: the same words at the same SHA are posted once (marker dedup).
    c = next((x for x in gh.list_all(f"repos/{gh.repo}/issues/{num}/comments") if mk in (x.get("body") or "")),
             None) or gh.api("POST", f"repos/{gh.repo}/issues/{num}/comments", {"body": body})
    handover_state(ctx)["acceptance"] = {"sha": head, "at": at, "text": text, "confirmed": confirmed,
                                         "untested": untested, "comment": (c or {}).get("id"), "void": False}
    upsert_feature_pr(ctx, gh, head)
    ctx.save()
    ctx.log("feature", "acceptance", "recorded", head, text)
    return {"sha": head, "pr": num, "confirmed": confirmed, "untested": untested, "body": body}


def check_acceptance(ctx: pm.Ctx, gh: github.Gh, restart: bool, timeout: float | None) -> dict[str, Any]:
    acc = handover_state(ctx).get("acceptance")
    head = pm.remote_head(ctx.root, ctx.feature_branch)
    if not acc:
        return {"accepted": False, "void": False, "head": head}
    if acc.get("sha") == head and not acc.get("void"):
        return {"accepted": True, "void": False, "head": head, "sha": acc["sha"]}
    newly = not acc.get("void")
    acc.update({"void": True, "voided_by": head, "voided_at": acc.get("voided_at") or nsstate.now()})
    out = upsert_feature_pr(ctx, gh, head)
    ctx.save()
    if newly:
        ctx.log("feature", "acceptance", "void", head, f"commit after acceptance at {acc['sha']}")
    result = {"accepted": True, "void": True, "head": head, "sha": acc["sha"], "pr": out["pr"]}
    pv = handover_state(ctx).get("preview")
    if restart and pv and pv.get("sha") != head and (ctx.config.get("preview") or {}).get("command"):
        result["preview"] = start_preview(ctx, gh, timeout)
    return result


# ---------------------------------------------------------------------------
# Clean-up
# ---------------------------------------------------------------------------


def cleanup(ctx: pm.Ctx, gh: github.Gh) -> dict[str, Any]:
    num = handover_state(ctx).get("pr")
    if not num:
        raise core.NightshiftError("no feature PR recorded; nothing to clean up")
    pr = gh.api("GET", f"repos/{gh.repo}/pulls/{num}")
    if pr.get("state") == "open":
        raise core.NightshiftError(f"PR #{num} is still open; evidence is kept until it is merged or closed")
    outcome = "merged" if pr.get("merged") else "closed"
    stop_preview(ctx)
    wt = ctx.run_dir / "preview"
    if wt.exists():
        pm.git(ctx.root, "worktree", "remove", "--force", str(wt), check=False)
        shutil.rmtree(wt, ignore_errors=True)
    summary = ctx.run_dir / "pr-summary.md"
    summary.write_text(f"PR #{num} ({outcome}) at {nsstate.now()}\n\n{pr.get('body') or ''}\n", encoding="utf-8")
    ev = ctx.run_dir / "evidence"
    removed = ev.exists()
    shutil.rmtree(ev, ignore_errors=True)
    handover_state(ctx)["cleaned"] = {"at": nsstate.now(), "pr_state": outcome}
    ctx.save()
    ctx.log("feature", "cleanup", outcome, pr.get("merge_commit_sha"), "evidence folder deleted")
    return {"pr": num, "pr_state": outcome, "evidence_removed": removed, "kept": [
        str(p.relative_to(ctx.root)) for p in (ctx.run_dir / "log.jsonl", summary) if p.exists()]}


# ---------------------------------------------------------------------------
# Closing the issues after the feature PR merged
# ---------------------------------------------------------------------------


def close_issues(ctx: pm.Ctx, gh: github.Gh) -> dict[str, Any]:
    """Close the parent issue and every sub-issue, each with a comment, once GitHub says
    the feature PR is merged. Refuses otherwise; idempotent (marker-deduplicated
    comments, closed issues left as they are)."""
    num = handover_state(ctx).get("pr")
    if not num:
        raise core.NightshiftError("no feature PR recorded; run handover pr first")
    pr = gh.api("GET", f"repos/{gh.repo}/pulls/{num}")
    if not pr.get("merged"):
        raise core.NightshiftError(f"feature PR #{num} is {pr.get('state')} and not merged; "
                                   "issues close only after it merges")
    merge_sha = pr.get("merge_commit_sha") or ""
    keys = ["parent", *ctx.state["pieces"].keys()]
    out: list[dict[str, Any]] = []
    for key in keys:
        number = pm.find_issue(gh, ctx, key)
        if number is None:
            out.append({"key": key, "issue": None, "action": "no-issue"})
            continue
        mk = f"<!-- {core.MARKER_PREFIX} closed key={key} pr={num} -->"
        p = ctx.state["pieces"].get(key) or {}
        status = "" if key == "parent" else f" `{key}` ended `{p.get('status')}`."
        comment, _ = pm.upsert_comment(gh, number, mk, f"Closed: feature PR #{num} was merged at "
                                       f"`{merge_sha}`.{status}")
        issue = gh.api("GET", f"repos/{gh.repo}/issues/{number}")
        if issue.get("state") == "closed":
            action = "already-closed"
        else:
            gh.api("PATCH", f"repos/{gh.repo}/issues/{number}", {"state": "closed"})
            action = "closed"
        out.append({"key": key, "issue": number, "action": action, "comment": comment})
    handover_state(ctx)["issues_closed"] = {"at": nsstate.now(), "pr": num, "merge_sha": merge_sha}
    ctx.save()
    ctx.log("feature", "close-issues", "closed", merge_sha,
            ", ".join(f"#{x['issue']} {x['action']}" for x in out if x["issue"]))
    return {"pr": num, "merge_sha": merge_sha, "issues": out}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    ap, sub, common = pm.cli_parser(__doc__)
    p = sub.add_parser("pr", parents=[common])
    p.add_argument("--stop-reason", choices=nsstate.STOP_REASONS)
    p.add_argument("--notes", metavar="FILE", help="handover-notes.md: ## Summary and ## Merge danger, inserted verbatim")
    v = sub.add_parser("preview", parents=[common])
    v.add_argument("--stop", action="store_true")
    v.add_argument("--timeout", type=float, help="health-check seconds (default preview.health_timeout, 30)")
    a = sub.add_parser("accept", parents=[common])
    a.add_argument("--text", required=True)
    a.add_argument("--confirmed", action="append")
    a.add_argument("--untested", action="append")
    a.add_argument("--feedback", default="")
    c = sub.add_parser("check-acceptance", parents=[common])
    c.add_argument("--no-restart", action="store_true")
    c.add_argument("--timeout", type=float, help="health-check seconds (default preview.health_timeout, 30)")
    sub.add_parser("cleanup", parents=[common])
    sub.add_parser("close-issues", parents=[common])
    args = ap.parse_args(argv)
    ctx = pm.load_ctx(args.feature)
    gh = github.Gh(pm.resolve_repo(ctx.root, args.repo), ctx.root)
    if args.cmd == "pr":
        out = cmd_pr(ctx, gh, args.stop_reason, args.notes)
        text = f"{out['action']} feature PR #{out['pr']} at {out['head_sha']}; stop: {out['stop_reason']}"
    elif args.cmd == "preview":
        if args.stop:
            out = {"stopped": stop_preview(ctx)}
            ctx.save()
            text = "preview stopped" if out["stopped"] else "no preview running"
        else:
            out = start_preview(ctx, gh, args.timeout)
            text = f"preview at {out['url']} for {out['sha']}"
    elif args.cmd == "accept":
        out = accept(ctx, gh, args.text, _split(args.confirmed),
                     None if args.untested is None else _split(args.untested), args.feedback)
        text = f"acceptance recorded at {out['sha']} on PR #{out['pr']}"
    elif args.cmd == "check-acceptance":
        out = check_acceptance(ctx, gh, not args.no_restart, args.timeout)
        text = json.dumps(out)
    elif args.cmd == "close-issues":
        out = close_issues(ctx, gh)
        text = "\n".join(f"{x['key']}: #{x['issue']} {x['action']}" for x in out["issues"])
    else:
        out = cleanup(ctx, gh)
        text = f"PR #{out['pr']} {out['pr_state']}; evidence removed"
    pm.emit(args, out, text)
    return 0


if __name__ == "__main__":
    core.run_main(main)
