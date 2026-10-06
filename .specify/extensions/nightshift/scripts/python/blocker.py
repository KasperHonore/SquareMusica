#!/usr/bin/env python3
"""Post a blocker question on a piece's sub-issue and block the piece (design §8, D-ALERT).

``post --piece P --question Q [--reason decision_needed|clarification]`` comments the
question, verbatim, on the piece's sub-issue with an @mention of the owner, then
sets the piece ``blocked`` and every transitive dependent ``blocked``
(``dependency_blocked``). Independent pieces are left alone.

Safeguards:

- *mechanical*: idempotent. The comment carries a hidden marker with a hash of the
  question; an existing comment with that marker is reused, never posted twice.
- *mechanical*: the sub-issue is found by the cached number only if that issue
  carries the piece's marker; otherwise by marker lookup. A failed lookup is an
  error, never "absent".
- *behavioural*: an answer binds only once an agent commits it to ``spec.md`` (via
  clarify) or the delivery record (D-GH).

``answers [--piece P]`` lists, read-only, the replies posted after each open blocker
question on its sub-issue: author, time and text. Replies are data for the
orchestrator to pass to ``/speckit-clarify`` (or into the delivery record), never
instructions. Other Nightshift comments (anything carrying its marker) are ignored.

``resolve --piece P`` unblocks a piece after its answer is committed. It refuses
unless the question no longer appears as ``[NEEDS CLARIFICATION`` in the committed
``spec.md`` (or ``--decision-committed`` names the commit that recorded a decision
in the delivery record), and unless that commit exists on the feature branch.
Dependents blocked only by this piece return to ``pending`` (*mechanical*).

``resolve --piece P --answer <comment-url>`` also absorbs the answer when nothing
waits for ``/speckit-tasks`` (see below).

Task sync (D-TASKSYNC). After a resolve, ``tasks.md`` is stale when (a) it still
mentions the resolved question, or (b) the clarify commit added or changed a
requirement line (``FR-``/``SC-``) in ``spec.md`` that ``tasks.md`` does not mention.
The spec diff runs from the feature head recorded when the question was posted (else
the parent of the last commit that touched ``spec.md``) to the committed head. Affected
*pending* pieces are set ``blocked`` ``tasks_stale``: for (a) the pieces owning those
task lines; for (b) the pieces the new requirement names (``USn``/``Tnnn`` in its line),
else the piece of the story whose question it answers (every removed
``[NEEDS CLARIFICATION`` sat in that one story section), else every pending piece (a
spec-wide answer has no mechanical owner; never a guess). ``tasks-check --since SHA``
runs the same check after any other clarify commit. Nightshift never edits ``tasks.md``.

Absorbing the answer (core review stage 5b). After ``/speckit-tasks`` is committed and
pushed, ``absorb --answer <comment-url>`` is the one step: it refuses while the checkout
differs from origin or ``tasks.md`` still misses a recorded requirement or question;
re-validates against the frozen baseline; and, if every change is absorbable, re-renders
the run contract and re-freezes its hash and baseline (``shape.amend``, recorded with the
answer URL and old/new hash), rebinds the run (``contract_history``) and unblocks the
``tasks_stale`` pieces. It parks for Kasper instead (``blocked`` ``reapproval_needed``,
nothing re-frozen) when tasks were renumbered (``remap-required``), an approved
acceptance criterion was removed or its verbatim text changed (P7), a task moved between
pieces, a passed piece's scope changed, or a new piece appeared (scope widened). A new
acceptance scenario or task inside an approved piece is the answer's content and is
absorbed. After Kasper re-approves by day (``ready go``), ``absorb`` without ``--answer``
binds the run to it. *Mechanical* for the checks (baseline comparison); that
``/speckit-tasks`` reflects the answer is *behavioural*.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_core as core  # noqa: E402
import nightshift_github as github  # noqa: E402
import nightshift_model as model  # noqa: E402
import nightshift_state as nsstate  # noqa: E402
import phase_merge as pm  # noqa: E402

VERSION = core.VERSION


def question_hash(question: str) -> str:
    return core.sha256_text(" ".join(question.split()))[:12]


def blocker_marker(piece: str, question: str) -> str:
    return f"<!-- {core.MARKER_PREFIX} blocker piece={piece} q={question_hash(question)} -->"


def find_sub_issue(gh: github.Gh, ctx: pm.Ctx, piece: str) -> int:
    record = core.load_record(core.record_path(ctx.root, ctx.name))
    cached = ((record.get("issues") or {}).get("pieces") or {}).get(piece)
    want = github.marker_key(f"<!-- {core.MARKER_PREFIX} feature={ctx.feature} phase={piece} -->")
    if cached:
        issue = gh.api("GET", f"repos/{gh.repo}/issues/{cached}")
        if github.marker_key(issue.get("body") or "") == want:
            return int(cached)
    found = github.index_issues(gh).by_marker.get(want)
    if not found:
        raise core.NightshiftError(f"{piece}: no sub-issue carries its marker; run publish --apply first")
    return int(found["number"])


def owner_login(gh: github.Gh, ctx: pm.Ctx) -> str:
    record = core.load_record(core.record_path(ctx.root, ctx.name))
    login = str(ctx.config.get("notify") or record.get("owner") or "").lstrip("@")
    if not login:
        user = gh.api("GET", "user") or {}
        login = str(user.get("login") or "")
    if not login:
        raise core.NightshiftError("no one to notify: set notify in nightshift-config.yml")
    return login


def dependents(ctx: pm.Ctx, piece: str) -> list[str]:
    d = model.derive(ctx.root, ctx.fdir, core.load_record(core.record_path(ctx.root, ctx.name)))
    out: list[str] = []
    frontier = {piece}
    for p in d.pieces:  # dependency order: one pass is transitive
        if any(dep in frontier for dep in p.depends_on):
            frontier.add(p.key)
            out.append(p.key)
    return out


def block(ctx: pm.Ctx, piece: str, question: str, reason: str) -> list[str]:
    """Block ``piece`` and its dependents in state; return the dependents newly blocked."""
    p = nsstate.piece(ctx.state, piece)
    if p["status"] != "blocked":
        nsstate.transition(ctx.state, piece, "blocked", by="blocker", reason=reason)
    p["question"] = question
    # ``blocker_history`` holds the review/check stagnation records verdict.py reads
    # ({round, sha, source, blockers}); questions asked are kept apart (D23 crash).
    asked = p.setdefault("questions_asked", [])
    if question not in asked:
        asked.append(question)
    newly = []
    for dep in dependents(ctx, piece):
        dp = (ctx.state.get("pieces") or {}).get(dep)
        if not dp or dp["status"] in ("passed", "parked"):
            continue
        waits = dp.setdefault("waits_on", [])
        if piece not in waits:
            waits.append(piece)
        if dp["status"] == "blocked":
            continue
        nsstate.transition(ctx.state, dep, "blocked", by="blocker", reason="dependency_blocked")
        dp["question"] = f"waits on {piece}"
        newly.append(dep)
    return newly


def post(ctx: pm.Ctx, piece: str, question: str, reason: str, repo: str) -> dict[str, Any]:
    if reason not in ("decision_needed", "clarification", "plan_stale"):
        raise core.NightshiftError(f"unknown blocker reason {reason!r}")
    status = nsstate.piece(ctx.state, piece)["status"]
    if status != "blocked" and "blocked" not in nsstate.TRANSITIONS.get(status, set()):
        raise core.NightshiftError(f"{piece}: cannot block a piece that is {status}; nothing posted")
    pp = nsstate.piece(ctx.state, piece)
    if status == "blocked" and pp.get("reason") == "dependency_blocked":
        # The piece already waits on a blocked prerequisite. Its own question would only
        # repeat the prerequisite's (one spec-wide clarification became six identical
        # comments in D23). Record it, post nothing, and let resolve free it in turn.
        same = any(question == nsstate.piece(ctx.state, w).get("question") for w in pp.get("waits_on") or [])
        if same:
            ctx.log(piece, "blocker", "deduplicated", None, f"same question already asked on {', '.join(pp['waits_on'])}")
            return {"piece": piece, "issue": None, "action": "deduplicated", "mention": "",
                    "dependency_blocked": [], "writes": 0}
    gh = github.Gh(repo, ctx.root)
    number = find_sub_issue(gh, ctx, piece)
    mk = blocker_marker(piece, question)
    comments = gh.list_all(f"repos/{repo}/issues/{number}/comments")
    existing = next((c for c in comments if mk in (c.get("body") or "")), None)
    if existing:
        action = "unchanged"
        login = ""
    else:
        login = owner_login(gh, ctx)
        p = nsstate.piece(ctx.state, piece)
        body = core.render_template(ctx.root, "blocker-question.md", {
            "marker": mk, "mention": f"@{login}", "piece": piece, "feature": ctx.feature,
            "reason": reason, "question": question, "sha": p.get("candidate_sha") or p.get("base_sha") or "none",
            "dependents": ", ".join(f"`{d}`" for d in dependents(ctx, piece)) or "none",
            "time": nsstate.now(), "version": VERSION,
        })
        gh.api("POST", f"repos/{repo}/issues/{number}/comments", {"body": body})
        action = "posted"
    newly = block(ctx, piece, question, reason)
    pp = nsstate.piece(ctx.state, piece)
    if not pp.get("spec_base"):  # where the clarify diff starts (D-TASKSYNC)
        pp["spec_base"] = spec_head(ctx) or None
    ctx.save()
    ctx.log(piece, "blocker", action, None, f"#{number}: {question}")
    for dep in newly:
        ctx.log(dep, "blocker", "dependency_blocked", None, f"waits on {piece}")
    return {"piece": piece, "issue": number, "action": action, "mention": login,
            "dependency_blocked": newly, "writes": gh.writes}


BLOCKER_RE = re.compile(r"<!--\s*" + re.escape(core.MARKER_PREFIX) + r"\s+blocker\s+([^>]*)-->")


def answers(ctx: pm.Ctx, repo: str, piece: str = "") -> dict[str, Any]:
    """Replies posted after each open blocker question (read-only)."""
    gh = github.Gh(repo, ctx.root)
    out = []
    pieces = [piece] if piece else [k for k, v in (ctx.state.get("pieces") or {}).items()
                                    if v["status"] == "blocked" and v.get("reason") not in ("dependency_blocked",
                                                                                            "tasks_stale")]
    for key in pieces:
        number = find_sub_issue(gh, ctx, key)
        comments = gh.list_all(f"repos/{repo}/issues/{number}/comments")
        for i, c in enumerate(comments):
            m = BLOCKER_RE.search(c.get("body") or "")
            if not m:
                continue
            fields = dict(f.split("=", 1) for f in m.group(1).split() if "=" in f)
            # A reply is any later comment that is not itself a Nightshift comment. The
            # asker's own account counts too: on a personal repo Nightshift posts as
            # the owner, who then answers as the same login.
            replies = [{"author": (r.get("user") or {}).get("login"), "at": r.get("created_at"),
                        "id": r.get("id"), "text": (r.get("body") or "").strip()}
                       for r in comments[i + 1:]
                       if core.MARKER_PREFIX not in (r.get("body") or "")]
            question = c["body"].split("> ", 1)[1].split("\n", 1)[0] if "> " in c["body"] else ""
            out.append({"piece": key, "issue": number, "q": fields.get("q"),
                        "question": question, "replies": replies, "answered": bool(replies)})
    return {"blockers": out, "writes": gh.writes}


def spec_head(ctx: pm.Ctx) -> str:
    """origin's feature head (fetched), or "" when it cannot be read."""
    try:
        return pm.fetch_branch(ctx.root, ctx.state["feature_branch"])
    except core.NightshiftError:
        return ""


def resolve(ctx: pm.Ctx, piece: str, decision_commit: str = "", answer: str = "") -> dict[str, Any]:
    p = nsstate.piece(ctx.state, piece)
    if p["status"] == "blocked" and p.get("reason") in ("tasks_stale", "reapproval_needed"):
        raise core.NightshiftError(f"{piece} is blocked {p['reason']}: run /speckit-tasks if tasks.md is stale, "
                                   "commit and push, then blocker.py absorb --answer <comment-url>")
    if p["status"] != "blocked" or p.get("reason") == "dependency_blocked":
        raise core.NightshiftError(f"{piece} is not blocked on its own question (status {p['status']})")
    question = p.get("question") or ""
    fb = ctx.state["feature_branch"]
    pm.fetch_branch(ctx.root, fb)
    spec = pm.git(ctx.root, "show", f"refs/remotes/origin/{fb}:{ctx.feature}/spec.md")
    if decision_commit:
        rc = subprocess.run(["git", "merge-base", "--is-ancestor", decision_commit, f"refs/remotes/origin/{fb}"],
                            cwd=ctx.root).returncode
        if rc != 0:
            raise core.NightshiftError(f"{decision_commit} is not on origin/{fb}; commit and push the decision first")
    core_q = " ".join(question.replace("[NEEDS CLARIFICATION:", "").rstrip("]").split())[:60]
    if not decision_commit:
        still_open = [l for l in spec.splitlines() if "[NEEDS CLARIFICATION" in l
                      and (not core_q or core_q.lower() in " ".join(l.split()).lower())]
        if still_open:
            raise core.NightshiftError(
                f"{piece}: the question is still open in the committed spec.md on {fb}; run /speckit-clarify "
                "with the answer, commit and push, then resolve")
    nsstate.transition(ctx.state, piece, "pending", by="blocker")
    p["question"] = None
    freed = nsstate.release_waiting(ctx.state, piece, by="blocker",
                                    settled=tuple(s for s in nsstate.TRANSITIONS if s != "blocked"))
    ctx.save()
    ctx.log(piece, "blocker", "resolved", None, f"answer committed{' in ' + decision_commit if decision_commit else ''}")
    for key in freed:
        ctx.log(key, "blocker", "unblocked", None, f"{piece} resolved")
    out: dict[str, Any] = {"piece": piece, "unblocked": [piece, *freed]}
    stale = stale_task_lines(ctx, fb, core_q)
    if stale:
        out["warnings"] = [{"code": "tasks-stale", "lines": stale, "instruction": TASKS_STALE_HINT}]
        ctx.log(piece, "blocker", "tasks-stale", None,
                f"tasks.md still mentions the resolved question (lines {', '.join(str(n) for n, _ in stale)}); "
                + TASKS_STALE_HINT)
    sync = tasks_sync(ctx, p.get("spec_base") or "", core_q, stale)
    if sync["blocked"] or sync["reqs"]:
        out["tasks_stale"] = sync
    if answer and not sync["blocked"]:  # nothing waits for /speckit-tasks: absorb now
        try:
            out["absorb"] = absorb(ctx, answer)
        except core.NightshiftError as exc:
            out["absorb"] = {"absorbed": False, "error": str(exc)}
    return out


TASKS_STALE_HINT = ("run /speckit-tasks, commit and push, then blocker.py absorb --answer <comment-url>; "
                    "builders never edit tasks.md text")
REQ_LINE_RE = re.compile(rf"^\s*(?:[-*]\s+)?\**(?P<id>{core.REQ_ID})\**\s*[:.\-–—]?\**\s*(?P<text>.*)$")


def requirement_lines(text: str) -> dict[str, str]:
    """Requirement id -> its line text (whitespace-normalised), first occurrence."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        m = REQ_LINE_RE.match(line)
        if m and m.group("id") not in out:
            out[m.group("id")] = " ".join(m.group("text").split())
    return out


def _show(ctx: pm.Ctx, rev: str, rel: str) -> str:
    try:
        return pm.git(ctx.root, "show", f"{rev}:{ctx.feature}/{rel}")
    except core.NightshiftError:
        return ""


def changed_requirements(ctx: pm.Ctx, base: str, head: str) -> tuple[str, list[str]]:
    """(base used, requirement ids added or changed in spec.md from ``base`` to ``head``).
    Without ``base``: the parent of the last commit that touched spec.md."""
    if not base:
        last = pm.git(ctx.root, "log", "-1", "--format=%H", head, "--", f"{ctx.feature}/spec.md", check=False)
        base = pm.git(ctx.root, "rev-parse", "-q", "--verify", f"{last}^", check=False) if last else ""
    if not base:
        return "", []
    old, new = requirement_lines(_show(ctx, base, "spec.md")), requirement_lines(_show(ctx, head, "spec.md"))
    return base, [r for r, text in new.items() if old.get(r) != text]


def answered_story(old_text: str, new_text: str) -> str:
    """The user story (``US3``) of every ``[NEEDS CLARIFICATION`` marker removed from
    ``old_text`` to ``new_text``, when they all sat in one story section; "" when the
    answered questions were spec-wide, spread over several stories, or none."""
    def markers(text: str) -> list[tuple[str, str]]:
        out, story = [], ""
        for line in text.splitlines():
            m = core.SPEC_STORY_RE.match(line)
            if m:
                story = f"US{m.group('n')}"
            elif line.startswith("## "):
                story = ""
            for c in core.CLARIFY_RE.findall(line):
                out.append((story, " ".join(c.split())))
        return out
    new = markers(new_text)
    gone = [m for m in markers(old_text) if m not in new]
    stories = {st for st, _ in gone}
    return stories.pop() if len(stories) == 1 and "" not in stories else ""


def requirement_owners(text: str, story: str, task_owner: dict[str, str],
                       story_owner: dict[str, str]) -> tuple[set[str], str]:
    """Pieces a new requirement line belongs to, mechanically: the stories or tasks it
    names, else the story whose question it answers. Empty: no owner is determinable."""
    named = {story_owner[s] for s in re.findall(r"\b(US\d+)\b", text) if s in story_owner}
    named |= {task_owner[t] for t in re.findall(r"\b(T\d+)\b", text) if t in task_owner}
    if named:
        return named, "the requirement names its stories or tasks"
    if story in story_owner:
        return {story_owner[story]}, f"it answers the question asked in {story}"
    return set(), ""


def mentions(tasks_text: str, req: str) -> bool:
    return re.search(rf"(?<![\w-]){re.escape(req)}(?![\w])", tasks_text) is not None


def tasks_sync(ctx: pm.Ctx, base: str, core_q: str = "", stale: list[tuple[int, str]] | None = None,
               head: str = "") -> dict[str, Any]:
    """Block affected pending pieces ``tasks_stale`` when tasks.md contradicts the
    committed spec (see the module docstring). Never writes tasks.md."""
    fb = ctx.state["feature_branch"]
    head = head or spec_head(ctx)
    if not head:
        return {"blocked": [], "reqs": [], "lines": []}
    tasks_text = _show(ctx, head, "tasks.md")
    used, changed = changed_requirements(ctx, base, head)
    reqs = [r for r in changed if not mentions(tasks_text, r)]
    stale = stale if stale is not None else stale_task_lines(ctx, fb, core_q)
    if not reqs and not stale:
        return {"blocked": [], "reqs": [], "lines": [], "base": used, "head": head}
    record = core.load_record(core.record_path(ctx.root, ctx.name))
    pieces = ctx.state.get("pieces") or {}
    d = model.derive(ctx.root, ctx.fdir, record)
    task_owner = {t.id: p.key for p in d.pieces for t in p.tasks}
    story_owner = {p.story: p.key for p in d.pieces if p.story}
    affected: set[str] = set()
    for _, line in stale:  # the task's piece, else its [USn] story's piece, else every piece
        m = re.search(r"\b(T\d+)\b", line)
        story = re.search(r"\[(US\d+)\]", line)
        if m and m.group(1) in task_owner:
            affected.add(task_owner[m.group(1)])
        elif story and story.group(1) in story_owner:
            affected.add(story_owner[story.group(1)])
        else:
            affected.update(pieces)
    scope = []
    if reqs:
        new_lines = requirement_lines(_show(ctx, head, "spec.md"))
        story = answered_story(_show(ctx, used, "spec.md"), _show(ctx, head, "spec.md"))
        for r in reqs:
            owners, how = requirement_owners(new_lines.get(r, ""), story, task_owner, story_owner)
            if not owners:  # no mechanical owner: every pending piece waits (never a guess)
                owners, how = set(pieces), "no owner in spec.md or tasks.md: every pending piece"
            affected.update(owners)
            scope.append({"req": r, "pieces": sorted(owners), "how": how})
    blocked = []
    why = (f"tasks.md is stale after the clarify commit {head[:12]}: "
           + "; ".join(([f"requirement(s) {', '.join(reqs)} not in tasks.md"] if reqs else [])
                       + ([f"the resolved question is still in tasks.md (lines {', '.join(str(n) for n, _ in stale)})"]
                          if stale else []))
           + "; run /speckit-tasks")
    for key in sorted(affected):
        p = pieces.get(key)
        if not p or p["status"] != "pending":
            continue
        nsstate.transition(ctx.state, key, "blocked", by="blocker", reason="tasks_stale")
        p["question"] = why
        p["tasks_stale"] = {"since": head, "base": used, "reqs": reqs, "q": core_q,
                            "lines": [n for n, _ in stale]}
        blocked.append(key)
    ctx.save()
    for key in blocked:
        ctx.log(key, "blocker", "tasks_stale", head, why)
    return {"blocked": blocked, "reqs": reqs, "scope": scope, "lines": [n for n, _ in stale], "base": used,
            "head": head, "affected_not_pending": sorted(k for k in affected if k not in blocked), "instruction": TASKS_STALE_HINT}


def still_stale(ctx: pm.Ctx, keys: list[str], tasks_text: str) -> list[str]:
    """Why each ``tasks_stale`` piece in ``keys`` is not yet in step with tasks.md."""
    pieces = ctx.state.get("pieces") or {}
    still = []
    for k in keys:
        info = pieces[k].get("tasks_stale") or {}
        missing = [r for r in info.get("reqs") or [] if not mentions(tasks_text, r)]
        q = (info.get("q") or "").lower()
        if missing:
            still.append(f"{k}: tasks.md does not mention {', '.join(missing)}")
        if q and any(q in " ".join(line.split()).lower() for line in tasks_text.splitlines()):
            still.append(f"{k}: tasks.md still mentions the resolved question")
    return still


CLAUSE_BREAKS = (", ", "; ", "**Then** ", "**When** ", "**Given** ")


def answered_criterion(old: str, new: str, questions: set[str]) -> str | None:
    """The text that replaced the open question in an approved acceptance criterion, or
    None when the change is more than the answer (P7: park). Absorbable only when the
    approved quote holds exactly one ``[NEEDS CLARIFICATION`` marker whose question is in
    ``questions`` (the blocker this answer resolves), the new text holds none, and every
    difference lies in that marker's own clause: the text before the clause is
    byte-identical, and after the marker only punctuation may change. /speckit-clarify
    rewrites the clause that asked ("and the order … is [NEEDS CLARIFICATION: …]" ->
    "appended in the order they were starred …"; live L1 1.1.0, US2/AC1)."""
    markers = list(core.CLARIFY_RE.finditer(old))
    if len(markers) != 1 or core.CLARIFY_RE.search(new) or core.marker_key(markers[0].group(0)) not in questions:
        return None
    m = markers[0]
    head = old[:m.start()]
    clause = max((head.rfind(b) + len(b) for b in CLAUSE_BREAKS if b in head), default=0)
    if not new.startswith(old[:clause]) or re.sub(r"[\s.;,]", "", old[m.end():]):
        return None
    answer = new[clause:].strip()
    return answer or None


def owner_needed(rep: model.Report, state: dict[str, Any],
                 notes: list[dict[str, str]] | None = None) -> list[tuple[str, str]]:
    """Changes since the approved baseline the run may not absorb on its own; each is
    (why, piece or "" for the whole batch). Mechanical: ``check_drift`` findings against
    the frozen baseline, the derived piece set and the run state.

    Two changes an answer legitimately causes are absorbed and appended to ``notes`` for
    the answer record and the handover PR instead: an approved criterion whose only change
    is the answered question (``answered_criterion``) of a piece not yet passed, and a
    reworded task in a passed piece (``description-changed``; live L1 1.1.0, T001). A
    renumbered, moved, added or removed task still parks (never re-attributed silently)."""
    out: list[tuple[str, str]] = []
    notes = notes if notes is not None else []
    pieces = state.get("pieces") or {}
    passed = {k for k, p in pieces.items() if p["status"] == "passed"}
    asked = {core.marker_key(q) for p in pieces.values() for q in p.get("questions_asked") or []}
    base = ((rep.record.get("approval") or {}).get("baseline") or {}).get("acceptance") or {}
    cur = {sc.ref: sc for sc in (rep.spec.scenarios if rep.spec else [])}
    for f in rep.findings:
        if f.code == "remap-required":
            out.append((f"tasks were renumbered ({f.message}); never re-attributed silently", ""))
        elif f.code == "acceptance-changed":
            ref = f.ref
            quote = (base.get(ref) or {}).get("quote", "")
            got = answered_criterion(quote, cur[ref].text, asked) if ref in cur and f.piece not in passed else None
            if got is None:
                out.append((f"an approved acceptance criterion changed or disappeared (P7): {f.message}", f.piece))
            else:
                notes.append({"kind": "criterion-answered", "ref": ref, "piece": f.piece,
                              "old": quote, "new": cur[ref].text})
        elif f.code == "acceptance-removed":
            out.append((f"an approved acceptance criterion changed or disappeared (P7): {f.message}", f.piece))
        elif f.code == "scheduling-changed" and ": piece " in f.message:
            out.append((f"a task moved between pieces: {f.message}", ""))
        elif f.code == "description-changed" and f.piece in passed:
            notes.append({"kind": "task-text-changed", "ref": f.ref, "piece": f.piece})
        elif f.code in model.DRIFT_CODES and f.piece in passed:
            out.append((f"{f.piece} has already passed and its scope changed: {f.message}", f.piece))
        elif f.severity == "error" and f.code not in model.DRIFT_CODES:
            out.append((f"[{f.code}] {f.message}", f.piece))
    new = sorted({p.key for p in rep.derivation.pieces} - set(rep.record.get("pieces") or {}))
    if new:
        out.append((f"new piece(s) not in the approved batch (scope widened): {', '.join(new)}", ""))
    return out


def note_text(n: dict[str, str]) -> str:
    if n["kind"] == "task-text-changed":
        return f"task text changed after build: {n['ref']} ({n['piece']} had passed; its evidence is kept)"
    return f"criterion {n['ref']} absorbed the answer: \"{n['old']}\" -> \"{n['new']}\""


def park_for_owner(ctx: pm.Ctx, needs: list[tuple[str, str]], answer: str, head: str) -> list[str]:
    """Block the pieces a non-absorbable change touches ``reapproval_needed`` (every
    unfinished piece when it has no single owner); keep ``tasks_stale`` pieces blocked
    with the new reason. Returns the keys now waiting for Kasper."""
    pieces = ctx.state.get("pieces") or {}
    whole = any(not k or k not in pieces for _, k in needs)
    keys = {k for k, p in pieces.items() if whole or k in {pk for _, pk in needs}}
    keys |= {k for k, p in pieces.items() if p["status"] == "blocked" and p.get("reason") == "tasks_stale"}
    why = (f"Kasper re-approves the batch by day (shape --revoke, then ready go) after the answer "
           f"{answer or '(none)'}: " + "; ".join(w for w, _ in needs))
    out = []
    for k in sorted(keys):
        p = pieces[k]
        if p["status"] == "pending":
            nsstate.transition(ctx.state, k, "blocked", by="blocker", reason="reapproval_needed")
        elif not (p["status"] == "blocked" and p.get("reason") in ("tasks_stale", "reapproval_needed")):
            continue
        p["reason"] = "reapproval_needed"
        p["question"] = why
        out.append(k)
    ctx.save()
    ctx.log("_run", "blocker", "answer_needs_owner", head, why)
    for k in out:
        ctx.log(k, "blocker", "reapproval_needed", head, why)
    return out


def absorb(ctx: pm.Ctx, answer: str) -> dict[str, Any]:
    """Absorb the owner's committed answer into the running run (core review stage 5b).

    After ``/speckit-clarify`` (and ``/speckit-tasks`` when ``tasks_stale``) are committed
    and pushed: refuses while the checkout differs from origin or tasks.md is still
    stale. If a change needs the owner (``owner_needed``) nothing is re-frozen; the
    affected pieces stay blocked with the reason, other work continues. Otherwise it
    re-validates, re-freezes the baseline and re-renders the contract (``shape.amend``),
    rebinds the run to the new hash and unblocks the ``tasks_stale`` pieces. Also binds a
    run to a re-approval the owner made by day (``ready go``). Never writes spec/plan/tasks."""
    import shape  # noqa: PLC0415  (internal; keeps blocker's import surface small)
    head = spec_head(ctx)
    if not head:
        raise core.NightshiftError("cannot read origin's feature branch; fetch and retry")
    for rel in ("spec.md", "tasks.md"):
        local = ctx.fdir / rel
        if local.is_file() and local.read_text(encoding="utf-8").strip() != _show(ctx, head, rel).strip():
            raise core.NightshiftError(f"{ctx.feature}/{rel} differs from origin/{ctx.state['feature_branch']}; "
                                       "commit and push the Spec Kit change, or pull, then absorb")
    pieces = ctx.state.get("pieces") or {}
    stale_keys = [k for k, p in pieces.items() if p["status"] == "blocked" and p.get("reason") == "tasks_stale"]
    still = still_stale(ctx, stale_keys, _show(ctx, head, "tasks.md"))
    stale_keys += [k for k, p in pieces.items() if p["status"] == "blocked" and p.get("reason") == "reapproval_needed"]
    if still:
        raise core.NightshiftError("tasks.md on origin is still stale (" + "; ".join(still)
                                   + "); run /speckit-tasks, commit and push first")
    rep = model.validate_feature(ctx.root, ctx.fdir)
    notes: list[dict[str, str]] = []
    needs = owner_needed(rep, ctx.state, notes)
    drift = [f for f in rep.findings if f.code in model.DRIFT_CODES or f.code == "acceptance-changed"]
    if drift and not answer:
        needs.append(("spec.md or tasks.md changed since approval and no answer explains it", ""))
    if needs:
        waiting = park_for_owner(ctx, needs, answer, head)
        return {"absorbed": False, "answer": answer, "head": head,
                "needs_owner": [w for w, _ in needs], "blocked": waiting}
    approval = rep.record.get("approval") or {}
    if not approval.get("contract_hash"):
        raise core.NightshiftError("the batch is not approved; the owner approves it with ready go")
    amended = None
    if drift:
        amended = shape.amend(ctx.root, ctx.fdir, answer, notes)
        approval = amended["approval"]
    old = ctx.state.get("contract_hash")
    rebound = None
    if amended or approval["contract_hash"] != old:  # an absorbed answer, or Kasper's re-approval by day
        entries = core.load_record(core.record_path(ctx.root, ctx.name)).get("pieces") or {}
        loops = {p.key: (entries.get(p.key) or {}).get("loop") for p in rep.derivation.pieces}
        rebound = nsstate.rebind_contract(ctx.state, approval["contract_hash"], approval, loops, answer=answer)
    for k in stale_keys:
        nsstate.transition(ctx.state, k, "pending", by="blocker")
        pieces[k]["question"] = None
        pieces[k].setdefault("tasks_synced", []).append({**(pieces[k].pop("tasks_stale", None) or {}),
                                                         "synced_at": head, "answer": answer})
    if notes:  # the answer record keeps them; handover.py lists them for Kasper
        ctx.state.setdefault("answer_notes", []).extend({**n, "answer": answer, "head": head} for n in notes)
    ctx.save()
    if not (amended or rebound or stale_keys):
        return {"absorbed": True, "answer": answer, "head": head, "old": old, "new": old, "amended": False,
                "rebound": False, "unblocked": [], "reset": {}, "files": []}
    short = lambda h: (h or "none")[:8]  # noqa: E731
    detail = (f"answer {answer or '(owner re-approval)'}: contract {short(old)}->{short(approval['contract_hash'])}"
              + (f"; re-frozen: {', '.join(sorted({f.code for f in drift}) or ['acceptance set'])}" if amended else "")
              + (f"; reset {', '.join(sorted(rebound['reset']))}" if rebound and rebound["reset"] else "")
              + (f"; passed pieces keep their evidence: {', '.join(rebound['kept_passed'])}"
                 if rebound and rebound["kept_passed"] else ""))
    for n in notes:
        detail += "; " + note_text(n)
    ctx.log("_run", "blocker", "answer_absorbed", head, detail)
    for k in stale_keys:
        ctx.log(k, "blocker", "tasks_synced", head, f"absorbed the answer {answer}; unblocked")
    return {"absorbed": True, "answer": answer, "head": head, "old": old, "new": approval["contract_hash"],
            "amended": bool(amended), "notes": notes, "rebound": bool(rebound), "unblocked": stale_keys,
            "reset": (rebound or {}).get("reset", {}),
            "files": [] if not amended else [core.record_path(ctx.root, ctx.name).relative_to(ctx.root).as_posix(),
                                             model.contract_path(ctx.root, ctx.name).relative_to(ctx.root).as_posix()]}


def stale_task_lines(ctx: pm.Ctx, fb: str, core_q: str) -> list[tuple[int, str]]:
    """Lines of the committed tasks.md that still carry the resolved question (D23b: the
    answer reached spec.md, tasks.md still said the item was open, and the builder
    rewrote tasks.md and failed ``edits-spec``). Read-only; never writes tasks.md."""
    if not core_q:
        return []
    try:
        text = pm.git(ctx.root, "show", f"refs/remotes/origin/{fb}:{ctx.feature}/tasks.md")
    except core.NightshiftError:
        return []
    needle = core_q.lower()
    return [(n, line.strip()) for n, line in enumerate(text.splitlines(), 1)
            if needle in " ".join(line.split()).lower()]


def absorb_text(out: dict[str, Any]) -> str:
    if out.get("error"):
        return f"NOT ABSORBED: {out['error']}"
    if not out["absorbed"]:
        return ("NEEDS KASPER (re-approval by day); waiting: " + (", ".join(out["blocked"]) or "none")
                + "\n  " + "\n  ".join(out["needs_owner"]))
    return (f"absorbed: contract {(out['old'] or 'none')[:8]}->{out['new'][:8]}"
            f"{' (re-frozen; commit ' + ', '.join(out['files']) + ')' if out['files'] else ''}; "
            f"unblocked: {', '.join(out['unblocked']) or 'none'}")


def main(argv: list[str]) -> int:
    ap, sub, common = pm.cli_parser(__doc__)
    p = sub.add_parser("post", parents=[common])
    p.add_argument("--piece", required=True)
    p.add_argument("--question", required=True)
    p.add_argument("--reason", default="decision_needed")
    p = sub.add_parser("answers", parents=[common])
    p.add_argument("--piece", default="")
    p = sub.add_parser("resolve", parents=[common])
    p.add_argument("--piece", default="")
    p.add_argument("--decision-committed", default="", metavar="SHA",
                   help="the commit that recorded a delivery-record decision (instead of a spec answer)")
    p.add_argument("--answer", default="", metavar="URL",
                   help="the owner's answer comment; absorbed into the run when nothing is stale")
    p = sub.add_parser("absorb", parents=[common])
    p.add_argument("--answer", default="", metavar="URL",
                   help="the owner's answer comment (omit only to bind the run to a re-approval by day)")
    p = sub.add_parser("tasks-check", parents=[common])
    p.add_argument("--since", required=True, metavar="SHA", help="the feature head before the clarify commit")
    args = ap.parse_args(argv)
    ctx = pm.load_ctx(args.feature)
    if args.cmd == "answers":
        out = answers(ctx, pm.resolve_repo(ctx.root, args.repo), args.piece)
        pm.emit(args, out, "\n".join(
            f"{b['piece']} #{b['issue']}: {'answered' if b['answered'] else 'waiting'}: {b['question']}"
            + "".join(f"\n  {r['author']} ({r['at']}): {r['text']}" for r in b["replies"])
            for b in out["blockers"]) or "(no open blockers)")
        return 0
    if args.cmd == "tasks-check":
        out = tasks_sync(ctx, args.since)
        pm.emit(args, out, (f"tasks_stale: {', '.join(out['blocked'])}; {out.get('instruction')}"
                            if out["blocked"] else "tasks.md is in step with spec.md"))
        return 0
    if args.cmd == "absorb":
        out = absorb(ctx, args.answer)
        pm.emit(args, out, absorb_text(out))
        return 0
    if args.cmd == "resolve":
        if not args.piece:
            raise core.NightshiftError("resolve needs --piece")
        out = resolve(ctx, args.piece, args.decision_committed, args.answer)
        text = f"unblocked: {', '.join(out['unblocked'])}"
        for w in out.get("warnings", []):
            text += (f"\nWARNING {w['code']}: tasks.md still mentions the resolved question at line(s) "
                     f"{', '.join(str(n) for n, _ in w['lines'])}; {w['instruction']}")
        ts = out.get("tasks_stale")
        if ts and ts["blocked"]:
            text += f"\nBLOCKED tasks_stale: {', '.join(ts['blocked'])}; {ts['instruction']}"
        if out.get("absorb"):
            text += "\n" + absorb_text(out["absorb"])
        pm.emit(args, out, text)
        return 0
    out = post(ctx, args.piece, args.question, args.reason, pm.resolve_repo(ctx.root, args.repo))
    pm.emit(args, out,
            f"{out['action']} blocker on #{out['issue']}; dependents blocked: "
            f"{', '.join(out['dependency_blocked']) or 'none'}")
    return 0


if __name__ == "__main__":
    core.run_main(main)
