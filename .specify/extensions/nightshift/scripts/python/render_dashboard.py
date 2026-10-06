#!/usr/bin/env python3
"""Render ``.nightshift/<name>/dashboard.html`` from run state, logbook and ``tasks.md`` (D-DASH).

The dashboard is a view: it reads ``state.json``, ``log.jsonl``, live ``[X]`` counts
from ``tasks.md`` and the stories and acceptance scenarios of ``spec.md``, and writes
one HTML file (inline CSS, web fonts with system fallbacks, light and dark via
``prefers-color-scheme``).

Every value is rendered here, so the page is complete without JavaScript. One small
inline script only moves the clock: while the run is ``running`` it counts "on shift"
and each question's wait up from their recorded times, re-places the timeline as now
moves on, and shows how long ago the page was rendered. A run that crashed is never
re-rendered, so that "updated N min ago" is what tells a stale page from a live one.
The script reads only ``data-*`` times from this page; it fetches nothing and changes
no state.

It is written for the product owner, in this order: what needs them (open questions
verbatim, parked work, the preview to test), progress by user story with the acceptance
scenarios verbatim, a timeline of the shift, recent activity in plain words. The
engineering view (pieces table and full logbook) folds away at the bottom. A scenario
is ticked only when the owner confirmed it in a live acceptance (D-ACC); a merged story
shows its scenarios as "built, not yet confirmed", never as passed.

``--bug SLUG`` renders a bug run (``.nightshift/bug-<slug>/``, D24): there is no
``tasks.md``; each fix piece shows its reproduction result (before/after exit at the
repro and fix commits), the verdict, its phase PR and the preview in its row, and the
story card links the one PR into the base branch.

Safeguards:

- *mechanical*: never on the critical path. Every failure is caught, logged as a
  ``dashboard`` entry in the logbook, and the script still exits 0.
- *mechanical*: every value is HTML-escaped; nothing from state or the logbook is
  rendered as markup. The clock script is part of the template, never generated from
  state; it sets only ``textContent`` and ``style.left``.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import subprocess
import sys
import traceback
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_config as nsconfig  # noqa: E402
import nightshift_core as core  # noqa: E402
import nightshift_model as model  # noqa: E402
import nightshift_state as nsstate  # noqa: E402

LOG_LIMIT = 200


def esc(value: Any) -> str:
    return html.escape("" if value is None else str(value))


def current_piece(state: dict[str, Any]) -> str:
    for key, p in state["pieces"].items():
        if p["status"] in nsstate.ACTIVE:
            return key
    return ""


def last_finding(p: dict[str, Any]) -> str:
    seen = p.get("seen_findings") or []
    if seen:
        f = seen[-1]
        return f.get("rationale") or f.get("summary") or json.dumps(f) if isinstance(f, dict) else str(f)
    return p.get("question") or ""


def rounds_to_approve(state: dict[str, Any], key: str, p: dict[str, Any]) -> str:
    if p["status"] == "passed" or p.get("merged_sha"):
        return str(p.get("round") or 0)
    return "-"


def fix_summary(state: dict[str, Any], p: dict[str, Any]) -> str:
    """A fix run's evidence in one cell: reproduction, verdict, PR, preview (D24)."""
    r = p.get("repro") or {}
    if r.get("ran"):
        repro = (f"repro {'verified' if r.get('ok') else 'refused'}: exit {r.get('before_exit')} at "
                 f"{(r.get('repro_sha') or '-')[:7]} (before), exit {r.get('after_exit')} at "
                 f"{(r.get('fix_sha') or '-')[:7]} (after)")
    else:
        repro = f"repro not run{': ' + r['reason'] if r.get('reason') else ''}"
    ho = state.get("handover") or {}
    pv = ho.get("preview") or {}
    acc = ho.get("acceptance") or {}
    parts = [repro, f"checks {p.get('checks')}", f"verdict {p.get('verdict')}",
             f"phase PR #{p['pr']}" if p.get("pr") else "no phase PR",
             f"PR #{ho['pr']}" if ho.get("pr") else "no PR",
             (f"preview {pv.get('url')} at {(pv.get('sha') or '-')[:7]}"
              f"{'' if pv.get('pid') else ' (stopped)'}") if pv else "no preview"]
    if acc:
        parts.append(f"acceptance at {(acc.get('sha') or '-')[:7]}{' (void)' if acc.get('void') else ''}")
    return "; ".join(parts)


# ---------------------------------------------------------------------------
# Owner view
# ---------------------------------------------------------------------------

STATUS_WORDS = {"pending": "Not started", "checking": "Running checks", "reviewing": "In review",
                "merging": "Merging", "passed": "Merged", "parked": "Parked"}
TONE = {"passed": "t-ok", "parked": "t-warn", "blocked": "t-bad",
        **{s: "t-live" for s in nsstate.ACTIVE}}
STOP_WORDS = {
    "awaiting_acceptance": ("Ready for you to test", "t-ok",
                            "Everything planned is built and merged. The preview is waiting for you."),
    "partial_awaiting_acceptance": ("Partly ready", "t-warn",
                                    "Part of the feature is built and ready to test; some work is parked or "
                                    "waiting on a decision."),
    "no_ready_work": ("Nothing could start", "t-warn", "No work was ready to start. See what needs you below."),
    "budget_exhausted": ("Out of budget", "t-warn",
                         "The run used its time, rounds or usage limit. It can resume where it stopped."),
    "interrupted": ("Interrupted", "t-warn", "The run was stopped. It can resume where it stopped."),
    "environment_failure": ("Environment failure", "t-bad",
                            "The run stopped because a tool or the machine failed, not because of the product."),
    "safety_stop": ("Safety stop", "t-bad", "The run stopped itself to protect the repository."),
}
REASON_WORDS = {
    "max_rounds": "it used all its review rounds without approval",
    "stagnation": "the same problem came back round after round",
    "no_progress": "rounds stopped making progress",
    "builder_blocked": "the builder could not continue",
    "gate_tampered": "the builder changed checks or config it may not touch",
    "combined_checks_failed": "it broke the checks once merged with the rest, so it was reverted",
    "timeout": "it ran out of time",
    "repro_invalid": "the bug reproduction did not hold",
    "checks_failed": "the automated checks kept failing",
    "ci_failed": "CI failed on the pull request",
    "ci_timeout": "CI did not finish in time",
    "tasks_stale": "the spec changed and tasks.md has not been regenerated yet",
    "reapproval_needed": "your answer changed the approved batch beyond what the run may absorb",
}


def parse_ts(value: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def hhmm(value: Any) -> str:
    t = parse_ts(value)
    return t.strftime("%H:%M") if t else "--:--"


def duration(seconds: float) -> str:
    m = max(0, int(seconds // 60))
    if m < 60:
        return f"{m} min"
    return f"{m // 60} h" if not m % 60 else f"{m // 60} h {m % 60:02d} min"


def md(text: Any) -> str:
    """Escape, then render inline ``**bold**`` and `` `code` `` from spec.md; the words stay verbatim."""
    out = esc(text)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    return re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", out)


def pill(text: str, tone: str = "") -> str:
    return f'<span class="pill {tone}">{esc(text)}</span>'


SHORT: dict[str, str] = {}  # piece -> "US3", "Polish", "Setup"; filled by build_values


def short_name(key: str, labels: dict[str, str]) -> str:
    return SHORT.get(key) or labels.get(key, key)


def piece_words(state: dict[str, Any], key: str, labels: dict[str, str]) -> tuple[str, str]:
    """A piece's status in the owner's words, with its tone class."""
    p = state["pieces"][key]
    st = p["status"]
    if st == "blocked":
        if p.get("reason") == "dependency_blocked":
            waits = ", ".join(short_name(w, labels) for w in p.get("waits_on") or []) or "earlier work"
            return f"Waiting on {waits}", "t-warn"
        if p.get("reason") == "tasks_stale":
            return "Waiting for tasks.md", "t-warn"
        if p.get("reason") == "reapproval_needed":
            return "Waiting on your re-approval", "t-bad"
        return "Waiting on your decision", "t-bad"
    if st == "building":
        return f"Building · round {p.get('round') or 1}", "t-live"
    return STATUS_WORDS.get(st, st), TONE.get(st, "")


def issue_link(repo: str, number: Any) -> str:
    if not number:
        return ""
    if repo:
        return f'<a href="https://github.com/{esc(repo)}/issues/{esc(number)}">issue #{esc(number)}</a>'
    return f"issue #{esc(number)}"


def pr_link(repo: str, number: Any) -> str:
    if not number:
        return ""
    if repo:
        return f'<a href="https://github.com/{esc(repo)}/pull/{esc(number)}">PR #{esc(number)}</a>'
    return f"PR #{esc(number)}"


def asked_ages(state: dict[str, Any], entries: list[dict[str, Any]]) -> dict[str, tuple[str, str]]:
    """How long each open question has waited, from its ``blocker posted`` entry:
    keyed by the blocked piece. Each value is the
    text at render time and the ISO time it was asked (the page counts on from it)."""
    now = parse_ts(nsstate.now())
    out: dict[str, tuple[str, str]] = {}
    for e in entries:
        if e.get("step") != "blocker" or e.get("outcome") != "posted":
            continue
        t = parse_ts(e.get("ts"))
        if not t or not now:
            continue
        out[str(e.get("piece"))] = (duration((now - t).total_seconds()), str(e.get("ts")))  # the latest ask wins
    return out


def since(text: str, iso: str, live: bool) -> str:
    """A duration the page's clock keeps counting from ``iso`` while the run is live."""
    attr = f' data-since="{esc(iso)}"' if live and iso else ""
    return f"<span{attr}>{esc(text)}</span>"


def needs_cards(state: dict[str, Any], record: dict[str, Any], labels: dict[str, str], repo: str,
                bug: str | None, asked: dict[str, str]) -> str:
    """What waits on the owner, as tiles: kind, story, how long it has waited and what it
    holds up. A tile opens to show the question verbatim and where to answer it."""
    issues = ((record.get("issues") or {}).get("pieces") or {})
    live = state.get("status") == "running"
    if bug:
        issues = {"fix": (record.get("issues") or {}).get("bug")}
    tiles = []

    def tile(kind: str, tone: str, mark: str, who: str, facts: list[str], body: str) -> str:
        lines = "".join(f"<span>{f}</span>" for f in facts if f)
        return (f'<details class="need {tone}"><summary><span class="need-kind">{mark} {esc(kind)}</span>'
                f'<span class="need-who">{esc(who)}</span><span class="need-facts">{lines}</span></summary>'
                f'<div class="need-body">{body}</div></details>')

    for key, p in state["pieces"].items():
        name = labels.get(key, key)
        held = [short_name(k, labels) for k, q in state["pieces"].items()
                if key in (q.get("waits_on") or []) and q["status"] == "blocked"]
        if p["status"] == "blocked" and p.get("reason") not in ("dependency_blocked", "tasks_stale",
                                                                 "reapproval_needed"):
            link = issue_link(repo, issues.get(key))
            tiles.append(tile("Decision", "bad", "◆", name, [
                f"<strong>{since(*asked[key], live)} waiting</strong>" if asked.get(key) else "",
                "holds: " + esc(", ".join(held) or "nothing else")],
                f'<blockquote>{md(p.get("question") or p.get("reason"))}</blockquote>'
                f'<p>{"Answer on " + link + "." if link else "Answer on the sub-issue."}</p>'))
        elif p["status"] == "blocked" and p.get("reason") == "tasks_stale":
            tiles.append(tile("Spec changed", "warn", "▲", name, ["holds: " + esc(", ".join(held) or "nothing else")],
                              f"<p>{esc(name)} waits until the run regenerates tasks.md for your answer "
                              f"and absorbs it.</p>"))
        elif p["status"] == "blocked" and p.get("reason") == "reapproval_needed":
            tiles.append(tile("Re-approve", "bad", "◆", name, ["holds: " + esc(", ".join(held) or "nothing else")],
                              f'<blockquote>{md(p.get("question") or "")}</blockquote>'))
        if p["status"] == "parked":
            why = REASON_WORDS.get(p.get("reason") or "", p.get("reason") or "no reason recorded")
            finding = last_finding(p)
            tiles.append(tile("Parked", "warn", "▲", name, [esc(why), "holds: " + esc(", ".join(held) or "nothing else")],
                              f'<p>{esc(name)} was set aside: {esc(why)}. It resumes only after you decide '
                              f'what to do with it.</p>' + (f"<p>Last finding: {md(finding)}</p>" if finding else "")))
    ho = state.get("handover") or {}
    pv, acc = ho.get("preview") or {}, ho.get("acceptance") or {}
    pr = pr_link(repo, ho.get("pr"))
    if acc and not acc.get("void"):
        when = parse_ts(acc.get("at"))
        tiles.append(tile("Accepted", "ok", "✓", f"by you{' · ' + when.strftime('%d %b %H:%M') if when else ''}",
                          [f"at <code>{esc((acc.get('sha') or '')[:7])}</code>", pr],
                          f'<blockquote>{esc(acc.get("text"))}</blockquote>'
                          f'<p>{esc(acc.get("at"))}. Merging to main is yours, on GitHub.</p>'))
    elif pv:
        live = bool(pv.get("pid"))
        url = str(pv.get("url") or "")
        tiles.append(tile("Ready to test", "go", "▶", re.sub(r"^https?://", "", url) or "preview",
                          [f"at <code>{esc((pv.get('sha') or '')[:7])}</code>",
                           "" if live else "stopped", "earlier acceptance void" if acc.get("void") else ""],
                          f'<p>Open <a href="{esc(url)}">{esc(url)}</a>{"" if live else " (stopped; restart it first)"}'
                          f'{" · " + pr if pr else ""}.</p><p>Then tell the session "accepted" or "accepted except …".</p>'))
    if tiles:
        return f'<div class="needs-grid">{"".join(tiles)}</div>'
    return ('<p class="calm">Nothing needs you right now. A question is posted on the GitHub issue with an '
            '@mention, and shows here.</p>')


def open_questions(state: dict[str, Any]) -> int:
    """Items that wait on the owner: questions, parked parts, a stale tasks.md, and a
    preview not yet accepted. Matches the tiles under "Needs you"."""
    pieces = state["pieces"].values()
    n = sum(1 for p in pieces if p["status"] == "blocked" and p.get("reason") != "dependency_blocked")
    n += sum(1 for p in pieces if p["status"] == "parked")
    ho = state.get("handover") or {}
    acc = ho.get("acceptance") or {}
    if ho.get("preview") and not (acc and not acc.get("void")):
        n += 1
    return n


def tally(state: dict[str, Any], entries: list[dict[str, Any]], done: int, total: int,
          bug: str | None) -> str:
    """The header figures: time on shift, parts merged, tasks ticked, questions waiting."""
    def fig(value: str, of: str, label: str, tone: str = "", since_iso: str = "") -> str:
        attr = f' data-since="{esc(since_iso)}"' if since_iso else ""
        return (f'<div class="fig {tone}"><span class="v"><span{attr}>{esc(value)}</span><small>{esc(of)}</small></span>'
                f'<span class="l">{esc(label)}</span></div>')

    start, end = run_window(state, entries)
    live = state.get("status") == "running" and start is not None
    pieces = state["pieces"]
    merged = sum(1 for p in pieces.values() if p["status"] == "passed")
    asks = open_questions(state)
    out = [fig(duration((end - start).total_seconds()) if start and end else "-", "", "on shift", "",
               start.isoformat() if live else ""),
           fig(str(merged), f"/{len(pieces)}", "merged")]
    if not bug:
        out.append(fig(str(done), f"/{total}", "tasks"))
    out.append(fig(str(asks), "", "waiting on you", "hot" if asks else ""))
    return "".join(out)


def rounds_of(state: dict[str, Any], key: str) -> list[dict[str, Any]]:
    """Per builder round of a piece, from its step records: commit, turns, duration,
    checks and verdict. Turns are per round (one builder call works the whole
    piece); nothing here is per task."""
    steps = state.get("steps") or {}
    out = []
    for n in range(1, int((state["pieces"].get(key) or {}).get("round") or 0) + 1):
        def done(kind: str) -> dict[str, Any]:
            return ((steps.get(f"{key}:{n}:{kind}") or {}).get("done") or {}).get("result") or {}
        build, checks, verdict = done("build"), done("checks"), done("verdict")
        call = build.get("call") or build.get("cost") or {}  # "cost": runs recorded before 2026-10-05
        out.append({"n": n, "sha": build.get("head"), "turns": call.get("num_turns"),
                    "duration_s": build.get("duration_s"),
                    "checks": ("passed" if checks.get("ok") else "failed") if checks else None,
                    "verdict": verdict.get("result"), "gap": verdict.get("biggest_gap")})
    return out


def ticked_in(root: Path, tasks_rel: str, rounds: list[dict[str, Any]]) -> dict[str, int]:
    """Task id -> the first round whose commit has it ticked in tasks.md (read with git)."""
    first: dict[str, int] = {}
    for r in rounds:
        if not r["sha"]:
            continue
        try:
            text = subprocess.run(["git", "show", f"{r['sha']}:{tasks_rel}"], cwd=root, capture_output=True,
                                  text=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            continue
        if text.returncode != 0:
            continue
        for t in core.parse_tasks_text(text.stdout, Path(tasks_rel)).tasks:
            if t.done:
                first.setdefault(t.id, r["n"])
    return first


def round_table(rounds: list[dict[str, Any]]) -> str:
    if not rounds:
        return '<p class="calm">No builder round has run yet.</p>'
    rows = []
    for r in rounds:
        verdict = {"approve": ("Approved", "t-ok"), "changes": ("Changes asked", "t-warn"),
                   "decision_needed": ("Question for you", "t-bad")}.get(r["verdict"] or "", (r["verdict"] or "not yet", ""))
        checks = {"passed": ("Passed", "t-ok"), "failed": ("Failed", "t-bad")}.get(r["checks"] or "", ("not yet", ""))
        mins = f"{r['duration_s'] / 60:.0f} min" if isinstance(r["duration_s"], (int, float)) else "-"
        gap = f'<tr class="gap"><td></td><td colspan="4">Biggest gap: {md(r["gap"])}</td></tr>' \
            if r["gap"] and r["verdict"] != "approve" else ""
        rows.append(f'<tr><td>Round {r["n"]}</td><td>{esc(r["turns"] if r["turns"] is not None else "-")}</td>'
                    f'<td>{esc(mins)}</td><td>{pill(*checks)}</td><td>{pill(*verdict)}</td></tr>{gap}')
    return ('<div class="wrap"><table class="rounds"><thead><tr><th>Round</th><th>Builder turns</th>'
            '<th>Time</th><th>Checks</th><th>Review</th></tr></thead><tbody>'
            + "".join(rows) + "</tbody></table></div>")


def task_list(dp: Any, first: dict[str, int]) -> str:
    items = []
    for t in dp.tasks:
        when = f"round {first[t.id]}" if t.done and t.id in first else ("done" if t.done else "open")
        desc = re.sub(r"^\s*(\[[^\]]*\]\s*)+", "", t.description)
        items.append(f'<li class="{"yes" if t.done else ""}"><span aria-label="{"done" if t.done else "open"}">'
                     f'{"✓" if t.done else ""}</span><span><span class="ac-ref">{esc(t.id)}</span>{md(desc)}</span>'
                     f'<span class="when">{esc(when)}</span></li>')
    return f'<ul class="acs tasks">{"".join(items)}</ul>'


def story_cards(root: Path, state: dict[str, Any], d: Any, spec: core.SpecDoc | None, labels: dict[str, str],
                confirmed: set[str], repo: str, max_rounds: int) -> str:
    """One collapsed row per story (status, tasks, criteria, rounds); opening it shows
    the acceptance criteria, every task with the round that ticked it, and the rounds."""
    tasks_rel = str((d.feature_dir / "tasks.md").relative_to(root)) if d else "tasks.md"
    cards, ground = [], []
    seen = set()
    for dp in d.pieces:
        seen.add(dp.key)
        p = state["pieces"].get(dp.key)
        if p is None:
            continue
        words, tone = piece_words(state, dp.key, labels)
        tasks = f"{sum(1 for t in dp.tasks if t.done)} of {len(dp.tasks)} tasks"
        story = (spec.stories.get(dp.story) if spec and dp.story else None)
        if not story:
            ground.append(f'<div><span>{esc(dp.title)} <span class="muted">· {esc(tasks)}</span></span>'
                          f'{pill(words, tone)}</div>')
            continue
        built = p["status"] == "passed"
        items = []
        for s in (spec.scenarios if spec else []):
            if s.story != dp.story:
                continue
            cls, mark, tip = ("yes", "✓", "confirmed by you") if s.ref in confirmed else \
                (("ready", "", "built, not yet confirmed by you") if built else ("", "", "not built yet"))
            items.append(f'<li class="{cls}" title="{tip}"><span aria-label="{tip}">{mark}</span>'
                         f'<span><span class="ac-ref">{esc(s.ref.split("/")[-1])}</span>{md(s.text)}</span></li>')
        rounds = rounds_of(state, dp.key)
        first = ticked_in(root, tasks_rel, rounds)
        ok = sum(1 for s in spec.scenarios if s.story == dp.story and s.ref in confirmed) if spec else 0
        n_ac = sum(1 for s in spec.scenarios if s.story == dp.story) if spec else 0
        done_n = sum(1 for t in dp.tasks if t.done)
        frac = done_n / len(dp.tasks) if dp.tasks else 0
        glance = [f"{done_n}/{len(dp.tasks)} tasks", f"{ok}/{n_ac} criteria confirmed"]
        used = int(p.get("round") or 0)
        near = "near" if used >= max_rounds and p["status"] != "passed" else ""
        foot = []
        if p.get("pr"):
            foot.append(pr_link(repo, p["pr"]))
        if p.get("merged_sha"):
            foot.append(f"merged at <code>{esc(p['merged_sha'][:7])}</code>")
        prio = f'<span class="prio">{esc(story["priority"])}</span>' if story.get("priority") else ""
        test = (f'<p class="try"><strong>How to try it:</strong> {md(story["independent_test"])}</p>'
                if story.get("independent_test") else "")
        opened = " open" if p["status"] in nsstate.ACTIVE or p["status"] == "blocked" else ""
        cards.append(
            f'<details class="story" id="story-{esc(dp.story.lower())}"{opened}><summary>'
            f'<span class="ref">{esc(dp.story)}</span><span class="st-title">{esc(story["title"])}{prio}</span>'
            f'<span class="glance"><span class="mini"><i style="width:{frac * 100:.0f}%"></i></span>'
            f'{" · ".join(esc(g) for g in glance)}{round_dots(used, max_rounds, near)}</span>{pill(words, tone)}</summary>'
            f'<div class="story-body">{test}'
            f'<h4>Acceptance criteria</h4><div class="ac-key"><span><i></i>not built yet</span>'
            f'<span><i class="ready"></i>built, waiting for you to confirm</span><span><i class="yes"></i>confirmed by you</span>'
            f'</div><ul class="acs">{"".join(items)}</ul>'
            f'<h4>Tasks</h4>{task_list(dp, first)}'
            f'<h4>Rounds</h4>{round_table(rounds)}'
            + (f'<div class="story-foot">{" · ".join(f"<span>{x}</span>" for x in foot)}</div>' if foot else "")
            + '</div></details>')
    for key in state["pieces"]:
        if key not in seen:
            words, tone = piece_words(state, key, labels)
            ground.append(f'<div><span>{esc(labels.get(key, key))} <span class="muted">· added during the run</span>'
                          f'</span>{pill(words, tone)}</div>')
    if ground:
        cards.append(f'<div class="ground" aria-label="Groundwork and follow-up">{"".join(ground)}</div>')
    return "\n".join(cards) or '<p class="calm">No stories found in spec.md.</p>'


def bug_card(state: dict[str, Any], root: Path, slug: str, repo: str) -> str:
    p = state["pieces"].get("fix") or {}
    try:
        doc = core.parse_bug(model.bug_dir(root, slug))
        title, symptom = doc.title, doc.sections.get("Symptom", "")
    except core.NightshiftError:
        title, symptom = slug, ""
    words, tone = piece_words(state, "fix", {}) if p else ("Not started", "")
    r = p.get("repro") or {}
    proof = ("Reproduced before the fix and passing after it" if r.get("ran") and r.get("ok") else
             "Reproduction refused" if r.get("ran") else "Not reproduced yet")
    foot = [f"<span>{esc(proof)}</span>"]
    pr = (state.get("handover") or {}).get("pr")
    if pr:
        foot.append(f"<span>{pr_link(repo, pr)}</span>")
    return (f'<article class="story"><div class="story-head"><h3>{esc(title)}</h3>{pill(words, tone)}</div>'
            f'<p class="try"><strong>Symptom:</strong> {md(symptom)}</p>'
            f'<div class="story-foot">{" · ".join(foot)}</div></article>')


def run_window(state: dict[str, Any], entries: list[dict[str, Any]]) -> tuple[datetime | None, datetime | None]:
    stamps = [t for t in (parse_ts(e.get("ts")) for e in entries) if t]
    start = parse_ts(state.get("started_at")) or (min(stamps) if stamps else None)
    if state.get("status") == "running":
        end = parse_ts(nsstate.now())
    else:
        end = max(stamps) if stamps else parse_ts(state.get("updated_at"))
    return start, end


def shift_strip(state: dict[str, Any], entries: list[dict[str, Any]]) -> str:
    """The shift so far on one line: start to now (or to the last entry once stopped),
    with merges, questions and parks where they happened. No budget and no projection."""
    start, end = run_window(state, entries)
    if not start or not end:
        return '<p class="strip-empty">The shift has not started yet.</p>'
    span = max((end - start).total_seconds(), 60.0)

    def x(t: datetime) -> float:
        return max(0.0, min(100.0, (t - start).total_seconds() / span * 100))

    marks = []
    for e in entries:
        t = parse_ts(e.get("ts"))
        step, out = e.get("step"), e.get("outcome")
        kind = ("merge" if step == "merge" and out in ("merged", "adopted") else
                "ask" if step == "blocker" and out == "posted" else
                "park" if out == "parked" else "")
        if t and kind:
            tip = f"{hhmm(e.get('ts'))} · {e.get('piece')}: {say(e, {}) or f'{step} {out}'}"
            marks.append(f'<span class="m {kind}" style="left:{x(t):.1f}%" data-t="{esc(t.isoformat())}" '
                         f'title="{esc(tip)}"></span>')
    step_h = 1 if span <= 8 * 3600 else 2 if span <= 16 * 3600 else 4
    ticks, h = [], (start.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1))
    while h < end:
        if h.hour % step_h == 0 and 6 < x(h) < 94:
            ticks.append(f'<span class="tick" style="left:{x(h):.1f}%" data-t="{esc(h.isoformat())}">'
                         f'{h.strftime("%H")}</span>')
        h += timedelta(hours=1)
    running = state.get("status") == "running"
    offset = int((start.utcoffset() or timedelta(0)).total_seconds() // 60)
    live = f' data-start="{esc(start.isoformat())}" data-tz="{offset}"' if running else ""
    return (f'<div class="strip"{live} role="img" aria-label="Shift from {esc(start.strftime("%H:%M"))} to '
            f'{"now" if running else esc(end.strftime("%H:%M"))}">'
            f'<span class="end l">{esc(start.strftime("%H:%M"))}</span>'
            f'<span class="rail"><span class="fill{" live" if running else ""}"></span><span class="ticks">{"".join(ticks)}</span>'
            f'{"".join(marks)}</span>'
            f'<span class="end r">{"now" if running else esc(end.strftime("%H:%M"))}</span></div>'
            '<div class="strip-key"><span><i class="m merge"></i>merged</span><span><i class="m ask"></i>asked you</span>'
            '<span><i class="m park"></i>parked</span></div>')


def round_dots(used: int, limit: int, tone: str = "") -> str:
    """Review rounds used out of ``max_rounds``: the closer to full, the closer to parking."""
    limit = max(limit, used, 1)
    dots = "".join(f'<i class="{"on" if i < used else ""}"></i>' for i in range(limit))
    return (f'<span class="dots {tone}" title="{used} of {limit} review rounds used" '
            f'aria-label="{used} of {limit} review rounds used">{dots}</span>')


def route_map(state: dict[str, Any], d: Any, spec: core.SpecDoc | None, labels: dict[str, str],
              max_rounds: int) -> str:
    """The pieces as stations on their real dependencies (``tasks.md``), coloured by
    status, with review rounds used out of ``max_rounds`` (inline SVG, no script)."""
    deps = {dp.key: [k for k in dp.depends_on if k in state["pieces"]] for dp in (d.pieces if d else [])}
    by_piece = {dp.key: dp for dp in (d.pieces if d else [])}
    depth: dict[str, int] = {}

    def dep_of(k: str, seen: tuple[str, ...] = ()) -> int:
        if k in depth:
            return depth[k]
        if k in seen:
            return 0
        depth[k] = 1 + max((dep_of(x, seen + (k,)) for x in deps.get(k, [])), default=-1)
        return depth[k]

    for k in deps:
        dep_of(k)

    def reach(k: str, seen: set[str]) -> set[str]:
        for x in deps.get(k, []):
            if x not in seen:
                seen.add(x)
                reach(x, seen)
        return seen

    # Draw only direct waits: drop an edge already implied through another dependency.
    deps = {k: [x for x in ds if not any(x in reach(y, set()) for y in ds if y != x)] for k, ds in deps.items()}
    # Parts added during the run (corrections from feedback) follow
    # the whole planned batch: draw them after its last parts, in the order they were added.
    planned_ends = [k for k in deps if not any(k in ds for ds in deps.values())]
    for k in state["pieces"]:
        if k not in depth:
            depth[k] = max(depth.values(), default=-1) + 1
            deps[k] = planned_ends
            planned_ends = [k]
    # Lanes like a train line: a part rides the lane of its first dependency that has not
    # handed its lane on yet, and branches to a new lane otherwise. A chain stays on one
    # straight row, and a branch's line runs along its own row to the join.
    lane: dict[str, int] = {}
    taken: set[str] = set()
    lanes = 0
    for k in sorted(state["pieces"], key=lambda k: (depth[k], list(state["pieces"]).index(k))):
        src = next((x for x in deps.get(k, []) if x in lane and x not in taken), None)
        if src is None:
            lane[k], lanes = lanes, lanes + 1
        else:
            lane[k] = lane[src]
            taken.add(src)
    W, H, CW, RH = 200, 80, 240, 100
    rows = max(lanes, 1)
    width = (max(depth.values(), default=0) + 1) * CW - (CW - W) + 8
    height = rows * RH - (RH - H) + 8
    pos = {k: (4 + depth[k] * CW, 4 + lane[k] * RH) for k in state["pieces"]}
    edges, nodes = [], []
    for k, ds in deps.items():
        for src in ds:
            if src not in pos or k not in pos:
                continue
            (x0, y0), (x1, y1) = pos[src], pos[k]
            sx, sy, ex, ey = x0 + W, y0 + H / 2, x1, y1 + H / 2
            sp = state["pieces"][src]
            cls = "done" if sp["status"] == "passed" else \
                "held" if sp["status"] in ("blocked", "parked") else "open"
            # Run along the source's own row, and bend in the last gap before the target.
            gap = CW - W
            turn = ex - gap
            bend = (f"L{turn:.0f} {sy:.0f} C{turn + gap / 2:.0f} {sy:.0f} {turn + gap / 2:.0f} {ey:.0f} "
                    f"{ex - 6:.0f} {ey:.0f} " if sy != ey else "")
            edges.append(f'<path class="edge {cls}" d="M{sx:.0f} {sy:.0f} {bend}L{ex - 6:.0f} {ey:.0f}"/>'
                         f'<circle class="edge-end {cls}" cx="{ex - 4:.0f}" cy="{ey:.0f}" r="3"/>')
    for k, (x, y) in pos.items():
        p = state["pieces"][k]
        words, tone = piece_words(state, k, labels)
        dp = by_piece.get(k)
        story = spec.stories.get(dp.story) if spec and dp and dp.story else None
        ref = dp.story if story else ""
        title = story["title"] if story else (dp.title if dp else labels.get(k, k))
        if not story and len(title) > 22:
            title = short_name(k, labels)  # "Polish & Cross-Cutting Concerns" -> "Polish"
        def clip(text: str, room: int) -> str:
            return text if len(text) <= room else text[:room - 1].rstrip() + "…"

        title = clip(title, 21 if ref else 23)
        decision = tone == "t-bad"
        words = clip(("◆ " if decision else "") + words, 28)
        live = " live" if p["status"] in nsstate.ACTIVE else ""
        used = int(p.get("round") or 0)
        n = max(max_rounds, used, 1)
        dots = "".join(f'<circle class="rd {"on" if i < used else ""}" cx="{x + 18 + i * 11}" cy="{y + 61}" r="3.6"/>'
                       for i in range(n))
        tasks = dp.tasks if dp else []
        tdone = sum(1 for t in tasks if t.done)
        bx = x + 18 + n * 11 + 8
        bw = W - (bx - x) - 46
        bar = (f'<rect class="tb" x="{bx}" y="{y + 58}" width="{bw}" height="6" rx="3"/>'
               f'<rect class="tb-on" x="{bx}" y="{y + 58}" width="{bw * tdone / len(tasks):.1f}" height="6" rx="3"/>'
               f'<text class="n-tasks" x="{x + W - 14}" y="{y + 65}">{tdone}/{len(tasks)}</text>') if tasks else ""
        href = f"#story-{ref.lower()}" if ref else "#stories-h"
        nodes.append(
            f'<a href="{href}"><g class="node {tone}{live}"><title>{esc(labels.get(k, k))}: {esc(words)} · '
            f'{used} of {n} review rounds · {tdone} of {len(tasks)} tasks</title>'
            f'<rect class="card" x="{x}" y="{y}" width="{W}" height="{H}" rx="12"/>'
            + (f'<text class="n-ref" x="{x + 16}" y="{y + 24}">{esc(ref)}</text>' if ref else "")
            + f'<text class="n-title" x="{x + (48 if ref else 16)}" y="{y + 24}">{esc(title)}</text>'
            f'<text class="n-status" x="{x + 16}" y="{y + 43}">{esc(words)}</text>{dots}{bar}</g></a>')
    return (f'<svg class="route" viewBox="0 0 {width:.0f} {height:.0f}" style="min-width:{width * .62:.0f}px" role="img" '
            f'aria-label="How the parts depend on each other">{"".join(edges)}{"".join(nodes)}</svg>')


def say(e: dict[str, Any], labels: dict[str, str]) -> str:
    """A logbook entry in the owner's words; "" for steps they do not need to see."""
    who = labels.get(e.get("piece") or "", e.get("piece") or "")
    step, out, rnd = e.get("step"), e.get("outcome"), e.get("round")
    table = {
        ("build", "finished"): f"{who}: built round {rnd}",
        ("checks", "passed"): f"{who}: automated checks passed",
        ("checks", "failed"): f"{who}: automated checks failed, going back to the builder",
        ("verdict", "approve"): f"{who}: reviewers approved",
        ("verdict", "changes"): f"{who}: reviewers asked for changes",
        ("verdict", "decision_needed"): f"{who}: reviewers found a product question",
        ("merge", "merged"): f"{who}: merged into the feature branch",
        ("combined", "passed"): f"Everything merged so far passes together (after {who})",
        ("combined", "failed"): f"{who} broke the combined checks and was reverted",
        ("blocker", "posted"): f"{who}: asked you a question",
        ("blocker", "resolved"): f"{who}: your answer was committed",
        ("blocker", "unblocked"): f"{who}: can continue",
        ("blocker", "answer_absorbed"): "Your answer was absorbed into the run",
        ("blocker", "answer_needs_owner"): "Your answer changed the approved batch: re-approve it",
        ("next", "parked"): f"{who}: parked",
        ("pr", "opened"): f"{who}: pull request opened",
        ("ci", "passed"): f"{who}: CI passed",
        ("ci", "failed"): f"{who}: CI failed",
        ("handover", "awaiting_acceptance"): "Handed over: ready for you to test",
        ("handover", "partial_awaiting_acceptance"): "Handed over: partly ready for you to test",
        ("preview", "started"): "Preview started",
        ("acceptance", "recorded"): "Your acceptance was recorded",
        ("acceptance", "void"): "A new commit voided your acceptance",
        ("repro", "verified"): "Bug reproduced; the fix makes it pass",
        ("found", "filed"): f"{who}: found a pre-existing problem and filed it",
    }
    if (step, out) in table:
        return table[(step, out)]
    if step == "handover":
        return f"Run stopped: {STOP_WORDS.get(out, (out,))[0]}"
    return ""


TELLING = ("changes", "decision_needed", "failed", "posted", "parked", "filed", "void", "recorded",
           "answer_needs_owner")


def activity(entries: list[dict[str, Any]], labels: dict[str, str], limit: int = 12) -> str:
    out = []
    for e in reversed(entries):
        text = say(e, labels)
        if not text:
            continue
        # Detail only where it tells the owner something (a question, a finding, a failure).
        detail = str(e.get("detail") or "") if e.get("outcome") in TELLING else ""
        detail = detail if len(detail) <= 160 else detail[:157] + "…"
        out.append(f'<li><time datetime="{esc(e.get("ts"))}" title="{esc(e.get("ts"))}">{esc(hhmm(e.get("ts")))}</time>'
                   f'<span>{esc(text)}{"<br><span class=d>" + esc(detail) + "</span>" if detail else ""}</span></li>')
        if len(out) >= limit:
            break
    return "\n".join(out) or '<li><span></span><span class="muted">Nothing yet.</span></li>'


def build_values(root: Path, fdir: Path, name: str, bug: str | None = None) -> dict[str, Any]:
    state = nsstate.load(root, name)
    entries = nsstate.read_jsonl(nsstate.run_dir(root, name) / "log.jsonl")
    record = core.load_record(core.record_path(root, name))
    spec, d = None, None
    if bug:
        all_tasks, by_piece = [], {}
    else:
        d = model.derive(root, fdir, record)
        all_tasks = d.doc.tasks
        by_piece = {p.key: p for p in d.pieces}
        if (fdir / "spec.md").is_file():
            spec = core.parse_spec(fdir / "spec.md")
    done = sum(1 for t in all_tasks if t.done)

    cur = current_piece(state)
    now = f"{cur}: {state['pieces'][cur]['status']} (round {state['pieces'][cur].get('round') or 0})" if cur \
        else (f"stopped: {state.get('stop_reason')}" if state.get("status") == "stopped" else "idle")
    last = entries[-1] if entries else None
    last_txt = f"{last['ts']} {last['piece']} {last['step']} {last['outcome']}" if last else "none"
    blocked = [(k, p) for k, p in state["pieces"].items() if p["status"] == "blocked"
               and p.get("reason") != "dependency_blocked"]
    blocked_txt = "; ".join(f"yes: {k}: {p.get('question') or p.get('reason')}" for k, p in blocked) or "no"
    passed = sum(1 for p in state["pieces"].values() if p["status"] == "passed")

    rows = []
    for key, p in state["pieces"].items():
        dp = by_piece.get(key)
        tasks = f"{sum(1 for t in dp.tasks if t.done)}/{len(dp.tasks)} " \
                f"({dp.tasks[0].id}–{dp.tasks[-1].id})" if dp and dp.tasks else "-"
        reason = f" ({p['reason']})" if p.get("reason") else ""
        rows.append(
            f"<tr><td><code>{esc(key)}</code></td><td>{esc(tasks)}</td>"
            f"<td class=\"s-{esc(p['status'])}\">{esc(p['status'] + reason)}</td>"
            f"<td>{esc(rounds_to_approve(state, key, p))}</td><td>{esc(p.get('round') or 0)}</td>"
            f"<td>{esc(fix_summary(state, p) if bug else last_finding(p))}</td></tr>")
    logs = []
    for e in reversed(entries[-LOG_LIMIT:]):
        logs.append(f"<tr><td><code>{esc(e.get('ts'))}</code></td><td>{esc(e.get('piece'))}</td>"
                    f"<td>{esc(e.get('step'))}</td><td>{esc(e.get('outcome'))}</td>"
                    f"<td>{esc(e.get('detail'))}</td></tr>")
    status = state.get("status", "")
    if state.get("stop_reason"):
        status += f" ({state['stop_reason']})"
    repo = str((record.get("issues") or {}).get("repo") or "")
    labels = {"feature": "Feature", "_run": "Run"}
    short: dict[str, str] = {}
    for dp in by_piece.values():
        story = spec.stories.get(dp.story) if spec and dp.story else None
        labels[dp.key] = f"{dp.story} {story['title']}" if story else dp.title
        short[dp.key] = dp.story if story else re.split(r"\s*[&+(/:,-]\s*| and ", dp.title)[0]
    for key in state["pieces"]:
        m = re.match(r"(convergence|correction)-(\d+)$", key)
        if key not in labels and m:
            labels[key] = short[key] = ("Convergence" if m.group(1) == "convergence" else f"Correction {m.group(2)}")
    SHORT.clear()
    SHORT.update(short)
    if bug:
        labels["fix"] = "The fix"
    acc = (state.get("handover") or {}).get("acceptance") or {}
    confirmed = set(acc.get("confirmed") or []) if acc and not acc.get("void") else set()
    if state.get("status") == "stopped":
        word, tone, _ = STOP_WORDS.get(state.get("stop_reason") or "", ("Stopped", "t-warn", ""))
    else:
        word, tone = "On shift", "t-live"
    try:
        cfg = nsconfig.load(root)
    except core.NightshiftError:
        cfg = dict(nsconfig.DEFAULTS)
    max_rounds = int(cfg.get("max_rounds") or 3)
    title = (core.parse_bug(fdir).title if bug else (spec.title if spec else name))
    return {
        "title": esc(title), "feature": esc(state.get("feature") or name),
        "status_pill": pill(word, tone),
        "needs": needs_cards(state, record, labels, repo, bug, asked_ages(state, entries)),
        "strip": shift_strip(state, entries),
        "tally": tally(state, entries, done, len(all_tasks), bug),
        "route": (f'<section aria-labelledby="route-h"><h2 id="route-h">How the work fits together</h2>'
                  f'<div class="route-wrap">{route_map(state, d, spec, labels, max_rounds)}</div>'
                  f'<p class="calm small">Each part waits for the parts with a line into it. Dots are review rounds '
                  f'used before a part is parked.<span class="swipe"> Swipe the map sideways to see it all.</span></p>'
                  f'</section>') if d and len(state["pieces"]) > 1 else "",
        "stories_heading": "The fix" if bug else "What you are getting",
        "stories": bug_card(state, root, bug, repo) if bug else story_cards(root, state, d, spec, labels, confirmed, repo, max_rounds),
        "activity": activity(entries, labels),
        "name": esc(name), "run_id": esc(state.get("run_id")), "run_status": esc(status),
        "rendered_at": esc(nsstate.now()),
        "updated": f'<span class="updated" data-asof="{esc(nsstate.now())}">updated just now</span>'
                   if state.get("status") == "running" else "", "current": esc(cur or "none"), "now": esc(now),
        "grounding": esc(grounding_text(state)),
        "last": esc(last_txt), "blocked": esc(blocked_txt), "blocked_class": "blocked" if blocked else "",
        "tasks_done": "- (bug run)" if bug else f"{done}/{len(all_tasks)}", "pieces_done": f"{passed}/{len(state['pieces'])}",
        "piece_rows": "\n".join(rows) or "<tr><td colspan=\"6\">No pieces.</td></tr>",
        "log_rows": "\n".join(logs) or "<tr><td colspan=\"5\">No entries yet.</td></tr>",
    }


def grounding_text(state: dict[str, Any]) -> str:
    """One line on the run-start re-grounding (core review stage 7)."""
    g = state.get("grounding")
    if not g:
        return "not checked yet"
    if g.get("status") != "drifted":
        return str(g.get("status")).replace("_", " ")
    counts: dict[str, int] = {}
    for p in (g.get("pieces") or {}).values():
        counts[p["status"]] = counts.get(p["status"], 0) + 1
    return "drifted: " + ", ".join(f"{n} {s.replace('_', ' ')}" for s, n in sorted(counts.items()))


def render(root: Path, fdir: Path, name: str, out: Path | None = None, bug: str | None = None) -> Path:
    values = build_values(root, fdir, name, bug)
    text = core.render_template(root, "dashboard.html", values)
    path = out or nsstate.run_dir(root, name) / "dashboard.html"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".html.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
    return path


def _log_failure(root: Path | None, name: str | None, detail: str) -> None:
    if root is None or not name:
        return
    try:
        try:
            state = nsstate.load(root, name)
        except core.NightshiftError:
            state = {"run_id": None}
        nsstate.log(root, name, state, piece="feature", step="dashboard", outcome="failed", detail=detail[:500])
    except Exception:  # noqa: BLE001 (best effort; never fail the run)
        pass


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--feature")
    ap.add_argument("--bug", metavar="SLUG", help="a fix run (bug-<slug>); no tasks.md")
    ap.add_argument("--out", help="write here instead of .nightshift/<name>/dashboard.html")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    root = name = None
    try:
        root = core.find_project_root()
        if args.bug:
            name = f"bug-{args.bug}"
            fdir = model.bug_dir(root, args.bug)
        else:
            fdir = core.resolve_feature_dir(root, args.feature)
            name = fdir.name
        path = render(root, fdir, name, Path(args.out) if args.out else None, args.bug)
        result = {"ok": True, "path": str(path)}
    except Exception as exc:  # noqa: BLE001 (never on the critical path)
        detail = f"{type(exc).__name__}: {exc}"
        _log_failure(root, name, detail)
        print(f"WARNING dashboard not rendered: {detail}", file=sys.stderr)
        if not isinstance(exc, core.NightshiftError):
            traceback.print_exc(file=sys.stderr)
        result = {"ok": False, "error": detail}
    if args.json:
        core.emit_json(result)
    elif result["ok"]:
        print(result["path"])
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001
        raise SystemExit(0)
