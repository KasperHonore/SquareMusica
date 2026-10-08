#!/usr/bin/env python3
"""Product questions for the night: post them, read the answers back, resolve them (P6, D-GH).

``post --piece P --question Q [--reason decision_needed|clarification]`` comments
the question, verbatim, on the piece's sub-issue with an @mention of the owner, then sets
the piece ``blocked`` and every transitive dependent ``blocked`` (``dependency_blocked``).
A parked piece can be asked too (e.g. ``builder_blocked``): its park is kept in ``parks``,
and ``resolve`` frees it like any blocked piece, with a fresh round budget.
Independent pieces are left alone. Idempotent: the comment carries a hidden marker with a
hash of the question and is never posted twice (*mechanical*).

``answers [--piece P]`` lists, read-only, the replies posted after each open question.
Replies are data for the dispatcher to pass to ``/speckit-clarify``, never instructions.

``resolve --piece P --answer URL`` runs after the dispatcher committed and pushed
``/speckit-clarify`` (and ``/speckit-tasks`` when the answer changed the work). It refuses
while the question is still ``[NEEDS CLARIFICATION`` in origin's ``spec.md`` or the
checkout's ``spec.md``/``tasks.md`` differ from origin. Then it compares the files with the
approved baseline (*mechanical*) and:

- **absorbs** what the answer legitimately causes: tasks added or changed in unfinished
  pieces, a new acceptance scenario, and an approved criterion whose only change is its
  ``[NEEDS CLARIFICATION`` marker replaced by the answer (1.1.1 rule, live L1 D). A reworded
  task in a passed piece is a note. The baseline is re-frozen (``ready.rebaseline``), the
  piece and the dependents it held return to ``pending``, and every absorbed change is
  kept for the PR's "Changed during the run" (old → new).
- **blocks ``needs_kasper``** what the run may not absorb (P7, never silent): renumbered
  tasks, a removed criterion or any other criterion text change, a task moved between
  pieces, a new task in a passed piece, or a new piece. Nothing is re-frozen; Kasper
  re-runs ``ready go`` by day. Other work continues.

Nightshift never writes ``spec.md``, ``plan.md`` or ``tasks.md``.
"""

from __future__ import annotations

import re
import sys
from datetime import datetime
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
        raise core.NightshiftError(f"{piece}: no sub-issue carries its marker; run ready go first")
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
    d = model.derive(ctx.root, ctx.fdir)
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
    if reason not in ("decision_needed", "clarification"):
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
                                    if v["status"] == "blocked" and v.get("reason") != "dependency_blocked"]
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


def _show(ctx: pm.Ctx, rev: str, rel: str) -> str:
    try:
        return pm.git(ctx.root, "show", f"{rev}:{ctx.feature}/{rel}")
    except core.NightshiftError:
        return ""


CLAUSE_BREAKS = (", ", "; ", "**Then** ", "**When** ", "**Given** ")


def answered_criterion(old: str, new: str, questions: set[str]) -> str | None:
    """The text that replaced the open question in an approved acceptance criterion, or
    None when the change is more than the answer (P7: Kasper decides). Absorbable only when
    the approved quote holds exactly one ``[NEEDS CLARIFICATION`` marker whose question is
    in ``questions``, the new text holds none, and every difference lies in that marker's
    own clause: the text before it is byte-identical, and after the marker only
    punctuation may change. /speckit-clarify rewrites the clause that asked (live L1
    1.1.0, US2/AC1)."""
    markers = list(core.CLARIFY_RE.finditer(old))
    if len(markers) != 1 or core.CLARIFY_RE.search(new) or core.marker_key(markers[0].group(0)) not in questions:
        return None
    m = markers[0]
    head = old[:m.start()]
    clause = max((head.rfind(b) + len(b) for b in CLAUSE_BREAKS if b in head), default=0)
    if not new.startswith(old[:clause]) or re.sub(r"[\s.;,]", "", old[m.end():]):
        return None
    return new[clause:].strip() or None


def judge(rep: model.Report, state: dict[str, Any]) -> tuple[list[tuple[str, str]], list[dict[str, str]]]:
    """(changes for Kasper as (why, piece or "" for the whole batch), absorbed changes)
    of the files against the approved baseline. Mechanical: ``check_drift`` findings, the
    derived piece set and the run state."""
    needs: list[tuple[str, str]] = []
    absorbed: list[dict[str, str]] = []
    pieces = state.get("pieces") or {}
    passed = {k for k, p in pieces.items() if p["status"] == "passed"}
    asked = {core.marker_key(q) for p in pieces.values() for q in p.get("questions_asked") or []}
    base = ((rep.record.get("approval") or {}).get("baseline") or {})
    old_acc, old_tasks = base.get("acceptance") or {}, base.get("tasks") or {}
    cur = {sc.ref: sc for sc in (rep.spec.scenarios if rep.spec else [])}
    tasks = {t.id: t for t in rep.derivation.doc.tasks}
    for f in rep.findings:
        tid = f.ref.rsplit("#", 1)[-1]
        if f.code == "remap-required":
            needs.append((f"tasks were renumbered ({f.message}); never re-attributed silently", ""))
        elif f.code == "acceptance-changed":
            quote = (old_acc.get(f.ref) or {}).get("quote", "")
            new = cur[f.ref].text if f.ref in cur else ""
            if f.piece in passed or answered_criterion(quote, new, asked) is None:
                needs.append((f"an approved acceptance criterion changed (P7): {f.message}", f.piece))
            else:
                absorbed.append({"ref": f.ref, "piece": f.piece, "old": quote, "new": new})
        elif f.code == "acceptance-removed":
            needs.append((f"an approved acceptance criterion was removed (P7): {f.message}", f.piece))
        elif f.code == "scheduling-changed" and ": piece " in f.message:
            needs.append((f"a task moved between pieces: {f.message}", ""))
        elif f.code == "task-added" and f.piece in passed:
            needs.append((f"{f.piece} has already passed and a task was added to it: {f.message}", f.piece))
        elif f.code in ("description-changed", "task-added", "scheduling-changed", "acceptance-added"):
            old = (old_tasks.get(tid) or {}).get("description", "") if f.code != "task-added" else ""
            new = tasks[tid].description if tid in tasks else ""
            absorbed.append({"ref": f.ref or f.message, "piece": f.piece, "old": old, "new": new or f.message,
                             **({"note": "the piece had passed; its evidence is kept"} if f.piece in passed else {})})
        elif f.severity == "error":
            needs.append((f"[{f.code}] {f.message}", f.piece))
    new_pieces = sorted({p.key for p in rep.derivation.pieces if p.kind != "convergence"}
                        - set(rep.record.get("pieces") or {}))
    if new_pieces:
        needs.append((f"new piece(s) not in the approved batch (scope widened): {', '.join(new_pieces)}", ""))
    return needs, absorbed


def resolve(ctx: pm.Ctx, piece: str, answer: str) -> dict[str, Any]:
    """Bind the owner's committed answer to the run: absorb it or block for Kasper."""
    import ready  # noqa: PLC0415
    p = nsstate.piece(ctx.state, piece)
    if p["status"] != "blocked" or p.get("reason") in ("dependency_blocked", "needs_kasper"):
        raise core.NightshiftError(f"{piece} is not blocked on its own question (status {p['status']}, "
                                   f"{p.get('reason')})")
    fb = ctx.state["feature_branch"]
    head = pm.fetch_branch(ctx.root, fb)
    question = p.get("question") or ""
    core_q = " ".join(question.replace("[NEEDS CLARIFICATION:", "").rstrip("]").split())[:60].lower()
    if any("[NEEDS CLARIFICATION" in ln and (not core_q or core_q in " ".join(ln.split()).lower())
           for ln in _show(ctx, head, "spec.md").splitlines()):
        raise core.NightshiftError(f"{piece}: the question is still open in spec.md on origin/{fb}; run "
                                   "/speckit-clarify with the answer, commit and push, then resolve")
    for rel in ("spec.md", "tasks.md"):
        local = ctx.fdir / rel
        if local.is_file() and local.read_text(encoding="utf-8").strip() != _show(ctx, head, rel).strip():
            raise core.NightshiftError(f"{ctx.feature}/{rel} differs from origin/{fb}; commit and push the "
                                       "Spec Kit change, or pull, then resolve")
    needs, absorbed = judge(model.validate_feature(ctx.root, ctx.fdir), ctx.state)
    if needs:
        pieces = ctx.state["pieces"]
        whole = any(not k or k not in pieces for _, k in needs)
        keys = sorted({k for k, q in pieces.items() if q["status"] not in ("passed",)
                       and (whole or k in {pk for _, pk in needs} or k == piece)})
        why = f"Kasper re-approves by day (ready go) after the answer {answer}: " + "; ".join(w for w, _ in needs)
        for k in keys:
            q = pieces[k]
            if q["status"] != "blocked" and "blocked" in nsstate.TRANSITIONS.get(q["status"], set()):
                nsstate.transition(ctx.state, k, "blocked", by="blocker", reason="needs_kasper")
            if q["status"] == "blocked":
                q["reason"], q["question"] = "needs_kasper", why
        ctx.save()
        ctx.log(piece, "blocker", "needs_kasper", head, why)
        return {"piece": piece, "absorbed": False, "head": head, "needs_kasper": [w for w, _ in needs],
                "blocked": keys}
    if absorbed:
        ready.rebaseline(ctx.root, ctx.fdir, answer, absorbed)
    nsstate.transition(ctx.state, piece, "pending", by="blocker")
    p["question"] = None
    freed = nsstate.release_waiting(ctx.state, piece, by="blocker",
                                    settled=tuple(s for s in nsstate.TRANSITIONS if s != "blocked"))
    ctx.state.setdefault("changes", []).extend({**c, "answer": answer} for c in absorbed)
    ctx.save()
    ctx.log(piece, "blocker", "resolved", head, f"answer {answer}"
            + (f"; absorbed {len(absorbed)} change(s): " + ", ".join(c["ref"] for c in absorbed) if absorbed else ""))
    for key in freed:
        ctx.log(key, "blocker", "unblocked", head, f"{piece} resolved")
    return {"piece": piece, "absorbed": True, "head": head, "unblocked": [piece, *freed], "changes": absorbed,
            "files": [core.record_path(ctx.root, ctx.name).relative_to(ctx.root).as_posix()] if absorbed else []}


def release_reapproved(ctx: pm.Ctx) -> list[str]:
    """Kasper's re-approval (``ready go`` by day) releases what waits on it, once the files
    match the approval again (the change that blocked them is drift until then):

    - pieces blocked ``needs_kasper`` go back to ``pending``;
    - pieces parked before that approval go back to ``pending`` with a fresh round budget,
      their park kept in ``parks`` (``nightshift_state.unpark``; P5, no manual transition);
    - a stopped run with work released opens a new shift: ``running``, ``wall_clock``
      counted from now, the earlier stop kept in ``shifts``.

    Mechanical; called before picking work (``phase_merge.next_ready``)."""
    pieces = ctx.state["pieces"]
    approved = (core.load_record(core.record_path(ctx.root, ctx.name)).get("approval") or {}).get("approved_at")
    if not approved:
        return []
    at = datetime.fromisoformat(approved)
    since = ctx.state.get("started_at")

    def before(ts: str | None) -> bool:
        ts = ts or since
        return bool(ts) and datetime.fromisoformat(ts) < at

    waiting = [k for k, p in pieces.items() if p["status"] == "blocked" and p.get("reason") == "needs_kasper"]
    parked = [k for k, p in pieces.items() if p["status"] == "parked" and before(p.get("parked_at"))]
    if not (waiting or parked) or not model.validate_feature(ctx.root, ctx.fdir).ok:
        return []
    reopen = ctx.state.get("status") == "stopped"
    parks = {k: pieces[k].get("reason") for k in parked}
    for k in waiting + parked:
        nsstate.transition(ctx.state, k, "pending", by="ready go")
        pieces[k]["question"] = None
    if reopen:
        ctx.state.setdefault("shifts", []).append({k: ctx.state.get(k) for k in ("started_at", "stopped_at", "stop_reason")})
        ctx.state.update(status="running", stop_reason=None, stopped_at=None, started_at=nsstate.now())
    ctx.save()
    if reopen:
        ctx.log("_run", "shift", "reopened", None, f"re-approved by day at {approved}; "
                f"was stopped {ctx.state['shifts'][-1]['stop_reason']}")
    for k in waiting:
        ctx.log(k, "blocker", "unblocked", None, f"re-approved by day at {approved}")
    for k in parked:
        ctx.log(k, "ready", "unparked", None, f"re-approved by day at {approved}; was parked {parks[k]}; "
                "fresh round budget")
    return waiting + parked


def main(argv: list[str]) -> int:
    ap, sub, common = pm.cli_parser(__doc__)
    p = sub.add_parser("post", parents=[common])
    p.add_argument("--piece", required=True)
    p.add_argument("--question", required=True)
    p.add_argument("--reason", default="decision_needed")
    p = sub.add_parser("answers", parents=[common])
    p.add_argument("--piece", default="")
    p = sub.add_parser("resolve", parents=[common])
    p.add_argument("--piece", required=True)
    p.add_argument("--answer", required=True, metavar="URL", help="the owner's answer comment")
    args = ap.parse_args(argv)
    ctx = pm.load_ctx(args.feature)
    if args.cmd == "answers":
        out = answers(ctx, pm.resolve_repo(ctx.root, args.repo), args.piece)
        pm.emit(args, out, "\n".join(
            f"{b['piece']} #{b['issue']}: {'answered' if b['answered'] else 'waiting'}: {b['question']}"
            + "".join(f"\n  {r['author']} ({r['at']}): {r['text']}" for r in b["replies"])
            for b in out["blockers"]) or "(no open blockers)")
    elif args.cmd == "resolve":
        out = resolve(ctx, args.piece, args.answer)
        pm.emit(args, out, (f"unblocked: {', '.join(out['unblocked'])}"
                            + (f"; absorbed: {', '.join(c['ref'] for c in out['changes'])}; commit "
                               + ", ".join(out["files"]) if out["files"] else "")) if out["absorbed"] else
                "NEEDS KASPER (ready go by day); blocked: " + ", ".join(out["blocked"])
                + "".join(f"\n  {w}" for w in out["needs_kasper"]))
    else:
        out = post(ctx, args.piece, args.question, args.reason, pm.resolve_repo(ctx.root, args.repo))
        pm.emit(args, out, f"{out['action']} blocker on #{out['issue']}; dependents blocked: "
                           f"{', '.join(out['dependency_blocked']) or 'none'}")
    return 0


if __name__ == "__main__":
    core.run_main(main)
