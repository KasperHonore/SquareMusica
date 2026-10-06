#!/usr/bin/env python3
"""Re-grounding: have the code facts a plan relied on moved since it was checked? (P2)

Intent (spec, acceptance) stays fixed; implementation facts are re-checked. The
grounding docs are the feature's ``plan.md``, ``research.md``, ``data-model.md``,
``contracts/**`` and ``quickstart.md``. The idea of marking the commit a plan was
checked against is borrowed from AI Build Kit's "Trued against <commit>" line (an idea,
no code; ``THIRD_PARTY.md``).

1. **Record** (mechanical): ``ready go`` stores ``approval.grounded_at`` (the commit the
   docs were checked against) and ``approval.grounding_docs``.
2. **Detect** (mechanical): repo paths the docs reference (backticked or plain tokens
   that resolve to a file or directory at either commit) are diffed between
   ``grounded_at`` and the comparison commit (``since...until``). ``unchanged`` |
   ``drifted`` with the changed paths per doc; ``not_checked`` only when there are no
   grounding docs or no resolvable paths.
3. **Analyse** (agent, read-only, only on drift): a fresh session (role ``grounding``,
   started like the critic) gets the docs, the changed paths, their diff and the
   piece→task mapping, and answers per claim ``still_true`` | ``moved`` |
   ``contradicted``. The script validates the shape, the evaluated SHA and that the tree
   did not change; anything else is ``rejected`` (mechanical).
4. **Act**: ``ready check`` shows it (a contradicted piece is not ready: ``plan stale``).
   ``grounding.py run`` (run start, before the first build) records the result in run
   state, so a moved claim reaches that piece's builder prompt, and parks a
   contradicted piece through the blocker path (reason ``plan_stale``); independent
   pieces continue (P6). Nothing here writes a Spec Kit artifact (P1).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_config as config  # noqa: E402
import nightshift_core as core  # noqa: E402
import nightshift_model as model  # noqa: E402

DOC_NAMES = ("plan.md", "research.md", "data-model.md", "quickstart.md")
TASKS_DOC = "tasks.md"  # names paths too (live L1 1.1.0 finding 3); counted beside a plan doc
CLAIM_STATUSES = ("still_true", "moved", "contradicted")
DIFF_LIMIT = 60_000  # characters of diff in the prompt; the rest is named, not shown
_SPLIT = re.compile(r"[\s()\[\]<>\"',;|`*]+")


def git(root: Path, *args: str, check: bool = True) -> str:
    res = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True)
    if check and res.returncode != 0:
        raise core.NightshiftError(f"git {' '.join(args)} failed: {res.stderr.strip()}")
    return res.stdout.strip() if res.returncode == 0 else ""


def rev(root: Path, ref: str) -> str:
    return git(root, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}", check=False)


# ---------------------------------------------------------------------------
# 1. Record
# ---------------------------------------------------------------------------


def docs(fdir: Path) -> list[Path]:
    out = [fdir / n for n in DOC_NAMES if (fdir / n).is_file()]
    contracts = fdir / "contracts"
    if contracts.is_dir():
        out += sorted(p for p in contracts.rglob("*") if p.is_file())
    if out and (fdir / TASKS_DOC).is_file():
        out.append(fdir / TASKS_DOC)
    return out


def doc_names(fdir: Path) -> list[str]:
    return [p.relative_to(fdir).as_posix() for p in docs(fdir)]


def planned_at(root: Path, fdir: Path) -> str:
    """The last commit that touched a grounding doc: what the plan was written against."""
    paths = [p.relative_to(root).as_posix() for p in docs(fdir)]
    return (git(root, "log", "-1", "--format=%H", "--", *paths, check=False) if paths else "") \
        or rev(root, "HEAD")


def record_fields(root: Path, fdir: Path, checked: dict[str, Any] | None = None) -> dict[str, Any]:
    """``approval.grounded_at`` and ``approval.grounding_docs``. ``grounded_at`` is HEAD at
    approval, unless the day check (``checked``) found a moved or contradicted claim: then
    it stays at the commit that check compared from, so the run start still sees it."""
    at = rev(root, "HEAD")
    if checked and any(p["status"] not in ("unchanged", "still_true", "not_checked")
                       for p in (checked.get("pieces") or {}).values()):
        at = checked.get("grounded_at") or at
    return {"grounded_at": at, "grounding_docs": doc_names(fdir)}


# ---------------------------------------------------------------------------
# 2. Detect
# ---------------------------------------------------------------------------


def _tree(root: Path, sha: str) -> tuple[set[str], set[str]]:
    files = set(git(root, "ls-tree", "-r", "--name-only", sha).splitlines()) if sha else set()
    dirs = {f.rsplit("/", i)[0] for f in files for i in range(1, f.count("/") + 1)}
    return files, dirs


def candidates(text: str) -> list[str]:
    """Path-like tokens: a slash, or a dot in the last segment. Routes (``/notes``),
    URLs and globs are skipped; resolution against the tree decides the rest."""
    out = []
    for tok in _SPLIT.split(text):
        tok = tok.strip(".:)!?").removeprefix("./")
        if not tok or tok.startswith(("/", "-", "~")) or "://" in tok or "{" in tok:
            continue
        bare = tok.rstrip("/")
        if bare and ("/" in tok or "." in bare.rsplit("/", 1)[-1].lstrip(".")):
            out.append(bare)
    return list(dict.fromkeys(out))


def referenced(root: Path, fdir: Path, since: str, until: str) -> dict[str, list[str]]:
    """Repo paths each grounding doc references that exist at ``since`` or ``until``.
    The feature's own folder and ``.specify/`` are intent, not code: excluded. A
    top-level directory (``app/``) is too broad to be a claim: only files and nested
    directories count (conservative)."""
    trees = [_tree(root, since), _tree(root, until)]
    own = core.feature_id(root, fdir).rstrip("/") + "/"
    every = set().union(*(files for files, _ in trees))
    out: dict[str, list[str]] = {}
    for p in docs(fdir):
        found = []
        for c in candidates(p.read_text(encoding="utf-8", errors="replace")):
            if not any(c in files or ("/" in c and c in dirs) for files, dirs in trees):
                c = resolve_suffix(c, every)
            if c and not (c + "/").startswith((own, ".specify/", ".nightshift/")):
                found.append(c)
        if found:
            out[p.relative_to(fdir).as_posix()] = list(dict.fromkeys(found))
    return out


def resolve_suffix(ref: str, files: set[str]) -> str:
    """A reference without its leading directories (``routes/queue.js`` for
    ``src/routes/queue.js``, live L1 1.1.0 finding 3): the one tracked file it is a
    path suffix of; "" when none or several match (ambiguous: ignored, conservative)."""
    hits = [f for f in files if f.endswith("/" + ref)]
    return hits[0] if len(hits) == 1 else ""


def _under(path: str, ref: str) -> bool:
    return path == ref or path.startswith(ref + "/")


def detect(root: Path, fdir: Path, since: str, until: str) -> dict[str, Any]:
    names = doc_names(fdir)
    out: dict[str, Any] = {"status": "not_checked", "grounded_at": since, "compared_to": until,
                           "docs": names, "paths": 0, "changed": {}, "commits": 0}
    if not names:
        out["note"] = "no grounding docs (plan.md, research.md, data-model.md, contracts/, quickstart.md)"
        return out
    if not since or not until:
        out["note"] = "no commit to compare"
        return out
    refs = referenced(root, fdir, since, until)
    out["paths"] = len({p for v in refs.values() for p in v})
    out["commits"] = int(git(root, "rev-list", "--count", f"{since}..{until}", check=False) or 0)
    if not refs:
        out["note"] = "the grounding docs name no repository path; nothing to compare"
        return out
    every = sorted({p for v in refs.values() for p in v})
    changed = git(root, "diff", "--no-renames", "--name-only", f"{since}...{until}", "--", *every).splitlines()
    per_doc = {d: sorted(c for c in changed if any(_under(c, r) for r in ps)) for d, ps in refs.items()}
    out["changed"] = {d: v for d, v in per_doc.items() if v}
    out["status"] = "drifted" if out["changed"] else "unchanged"
    return out


# ---------------------------------------------------------------------------
# 3. Analyse
# ---------------------------------------------------------------------------


def piece_tasks(root: Path, fdir: Path, record: dict[str, Any]) -> dict[str, list[str]]:
    """Task ids per piece key, in piece order."""
    return {p.key: [t.id for t in p.tasks] for p in model.derive(root, fdir, record).pieces}


def piece_map(root: Path, fdir: Path, record: dict[str, Any]) -> tuple[list[str], str]:
    d = model.derive(root, fdir, record)
    lines = []
    for p in d.pieces:
        lines.append(f"- `{p.key}`: {p.title}")
        lines += [f"  - {t.id}: {t.description}" for t in p.tasks]
    return [p.key for p in d.pieces], "\n".join(lines) or "_no pieces_"


TASK_ID = re.compile(r"\b(T\d{3,})\b")
# A task id in ``what`` counts as a citation only beside words that say it covers the change.
COVER_WORDS = re.compile(r"\balready\b|\bcover|\baddress|\basks? for\b|\bhandles?\b", re.I)


def render_prompt(root: Path, fdir: Path, det: dict[str, Any], keys_text: str) -> str:
    files = sorted({c for v in det["changed"].values() for c in v})
    diff = git(root, "diff", "--no-renames", f"{det['grounded_at']}...{det['compared_to']}", "--", *files)
    if len(diff) > DIFF_LIMIT:
        diff = diff[:DIFF_LIMIT] + "\n[... diff truncated; read the files at the evaluated SHA ...]"
    body = []
    for p in docs(fdir):
        body.append(f"### `{p.relative_to(fdir).as_posix()}`\n\n````text\n"
                    f"{p.read_text(encoding='utf-8', errors='replace').strip()}\n````")
    changed = "\n".join(f"- `{d}`: " + ", ".join(f"`{c}`" for c in v) for d, v in det["changed"].items())
    return core.render_template(root, "prompt-grounding.md", {
        "feature": core.feature_id(root, fdir), "since": det["grounded_at"], "sha": det["compared_to"],
        "docs": "\n\n".join(body), "changed": changed, "diff": diff or "(empty)",
        "pieces": keys_text, "doc_list": json.dumps(det["docs"])})


def tree_token(root: Path) -> dict[str, str]:
    """HEAD, index tree and working-tree status outside ``.nightshift/`` (where the
    answer is written): any write by the analyst changes one of them."""
    status = "\n".join(ln for ln in git(root, "status", "--porcelain=v1", "--untracked-files=all").splitlines()
                       if not ln[3:].startswith(".nightshift/"))
    return {"head": git(root, "rev-parse", "HEAD"), "write_tree": git(root, "write-tree"),
            "status_sha256": hashlib.sha256(status.encode()).hexdigest()}


class Rejected(Exception):
    pass


def check_answer(data: Any, sha: str, doc_list: list[str], keys: list[str],
                 tasks: dict[str, list[str]] | None = None) -> list[dict[str, Any]]:
    """Validate the analyst's answer. ``tasks`` (piece key -> task ids) enables the
    covered-task rule (1.1.3, L1 phase D): a ``contradicted`` claim must not name, in
    ``covered_by`` or in its ``what``, a task of an affected piece. A task that already
    addresses the change makes it ``moved`` with a briefing, never a park. Refusing the
    whole answer is the conservative side: nothing parks, builders are told to re-check."""
    if not isinstance(data, dict) or set(data) != {"sha", "claims"}:
        raise Rejected("schema: expected exactly the fields ['claims', 'sha']")
    if data["sha"] != sha:
        raise Rejected(f"wrong-sha: evaluated {data['sha']!r}, expected {sha}")
    if not isinstance(data["claims"], list):
        raise Rejected("schema: claims must be a list")
    allowed = {"doc", "claim", "status", "old", "new", "briefing", "what", "pieces", "covered_by"}
    for i, c in enumerate(data["claims"]):
        where = f"claims[{i}]"
        if not isinstance(c, dict) or not set(c) <= allowed or not {"doc", "claim", "status"} <= set(c):
            raise Rejected(f"schema: {where} needs doc, claim, status (and only {sorted(allowed)})")
        if c["doc"] not in doc_list:
            raise Rejected(f"schema: {where}.doc {c['doc']!r} is not a grounding doc")
        if c["status"] not in CLAIM_STATUSES:
            raise Rejected(f"schema: {where}.status {c['status']!r} not in {CLAIM_STATUSES}")
        if not all(isinstance(c.get(k, ""), str) for k in allowed - {"pieces", "covered_by"}):
            raise Rejected(f"schema: {where} text fields must be strings")
        need = {"moved": ("old", "new", "briefing"), "contradicted": ("what",)}.get(c["status"], ())
        if any(not str(c.get(k, "")).strip() for k in need):
            raise Rejected(f"schema: {where} ({c['status']}) needs {', '.join(need)}")
        if c["status"] != "still_true":
            ps = c.get("pieces")
            if not isinstance(ps, list) or not ps or any(p not in keys for p in ps):
                raise Rejected(f"schema: {where}.pieces must name affected pieces from {keys}")
        cov = c.get("covered_by", [])
        if not isinstance(cov, list) or not all(isinstance(t, str) for t in cov):
            raise Rejected(f"schema: {where}.covered_by must be a list of task ids")
        if c["status"] == "contradicted" and tasks is not None:
            own = {t for k in c["pieces"] for t in tasks.get(k, [])}
            what = c.get("what", "")
            said = set(TASK_ID.findall(what)) if COVER_WORDS.search(what) else set()
            cited = sorted((set(cov) | said) & own)
            if cited:
                raise Rejected(f"contradicted-but-covered: {where} is contradicted although task(s) "
                               f"{', '.join(cited)} of {', '.join(c['pieces'])} already address it; "
                               "a covered change is `moved` with a briefing")
    return data["claims"]


def analyse(root: Path, fdir: Path, name: str, det: dict[str, Any], record: dict[str, Any],
            log=None) -> dict[str, Any]:
    """Run the read-only grounding session once per (since, until, docs); the answer is
    cached under ``.nightshift/<name>/grounding/``. Returns ``{status, reason, claims}``."""
    import phase
    import verdict
    keys, keys_text = piece_map(root, fdir, record)
    prompt = render_prompt(root, fdir, det, keys_text)
    tag = hashlib.sha256(prompt.encode()).hexdigest()[:12]
    ev = root / ".nightshift" / name / "grounding" / f"{det['grounded_at'][:12]}-{det['compared_to'][:12]}-{tag}"
    cached = ev / "result.json"
    if cached.is_file():
        return json.loads(cached.read_text(encoding="utf-8"))
    ev.mkdir(parents=True, exist_ok=True)
    pfile = ev / "prompt-grounding.md"
    pfile.write_text(prompt, encoding="utf-8")
    log = log or (lambda *a: None)
    cfg = config.load(root)
    argv = phase.role_argv(SimpleNamespace(cfg=cfg), "grounding", pfile, [ev])
    before = tree_token(root)
    answer = ev / "answer.json"
    with answer.open("w", encoding="utf-8") as fh, (ev / "stderr.log").open("w", encoding="utf-8") as eh:
        code, timed_out = phase.run_cli(argv, pfile, root, phase.role_env(argv), fh,
                                        core.parse_duration(cfg.get("review_budget"), 3600), eh)
    phase.finish_critic_call({}, None, answer, log, "grounding", det["compared_to"], code, None, "grounding")
    try:
        if timed_out:
            raise Rejected("timeout")
        moved = [k for k, v in tree_token(root).items() if v != before.get(k)]
        if moved:
            raise Rejected(f"mutates-tree: {', '.join(moved)} changed during the analysis")
        try:
            data, _ = verdict.parse_output(answer.read_text(encoding="utf-8"))
        except verdict.Rejected as exc:
            raise Rejected(f"bad-json: {exc.detail}") from exc
        out = {"status": "ok", "reason": "",
               "claims": check_answer(data, det["compared_to"], det["docs"], keys,
                                      piece_tasks(root, fdir, record))}
    except Rejected as exc:
        out = {"status": "rejected", "reason": str(exc), "claims": []}
    cached.write_text(json.dumps(out, indent=2), encoding="utf-8")
    return out


# ---------------------------------------------------------------------------
# The whole check
# ---------------------------------------------------------------------------


def per_piece(keys: list[str], det: dict[str, Any], analysis: dict[str, Any] | None) -> dict[str, Any]:
    if det["status"] != "drifted":
        base = det["status"]
    else:
        base = "still_true" if analysis and analysis["status"] == "ok" else "drifted"
    out = {k: {"status": base, "briefing": [], "contradicted": []} for k in keys}
    for c in (analysis or {}).get("claims") or []:
        for k in c.get("pieces") or []:
            p = out[k]
            if c["status"] == "moved":
                p["briefing"].append(f"{c['old']} → {c['new']}: {c['briefing']} ({c['doc']})")
                if p["status"] != "contradicted":
                    p["status"] = "moved"
            elif c["status"] == "contradicted":
                p["contradicted"].append(f"{c['doc']}: {c['what']}")
                p["status"] = "contradicted"
    if det["status"] == "drifted" and (analysis or {}).get("status") != "ok":
        paths = ", ".join(sorted({c for v in det["changed"].values() for c in v}))
        for p in out.values():  # P2: the builder re-checks what changed; nothing is guessed
            p["briefing"].append(f"Code the plan names changed since planning ({paths}); "
                                 "re-check the plan's claims about it against the code before relying on them.")
    return out


def check(root: Path, fdir: Path, name: str, record: dict[str, Any], since: str, until: str,
          log=None) -> dict[str, Any]:
    det = detect(root, fdir, since, until)
    analysis = analyse(root, fdir, name, det, record, log) if det["status"] == "drifted" else None
    keys = [p.key for p in model.derive(root, fdir, record).pieces]
    det["analysis"] = analysis
    det["pieces"] = per_piece(keys, det, analysis)
    return det


def base_branch(root: Path) -> str:
    try:
        cfg = config.load(root)
    except core.NightshiftError:
        cfg = {}
    import phase_merge as pm
    return str(cfg.get("base_branch") or pm.default_branch(root) or "main")


def since_for(root: Path, fdir: Path, record: dict[str, Any]) -> str:
    return (record.get("approval") or {}).get("grounded_at") or planned_at(root, fdir)


def for_ready(root: Path, fdir: Path, record: dict[str, Any]) -> dict[str, Any]:
    """Day check: the grounded (or planned-at) commit against the base branch's head,
    as this clone knows it (no fetch: ``ready check`` makes no network calls)."""
    branch = base_branch(root)
    until = rev(root, f"refs/remotes/origin/{branch}") or rev(root, f"refs/heads/{branch}") or rev(root, "HEAD")
    out = check(root, fdir, fdir.name, record, since_for(root, fdir, record), until)
    out["base_branch"] = branch
    return out


def unresolved(g: dict[str, Any]) -> bool:
    """True when the plan was not shown to hold at the comparison commit."""
    return g["status"] == "drifted" and any(p["status"] != "still_true" for p in g["pieces"].values())


def summary(g: dict[str, Any]) -> list[str]:
    since, until = (g.get("grounded_at") or "")[:12], (g.get("compared_to") or "")[:12]
    head = {"not_checked": f"not checked: {g.get('note', '')}",
            "unchanged": f"unchanged: {g['paths']} path(s) the plan names did not change {since}..{until}",
            "drifted": f"drifted: code the plan names changed {since}..{until}"}[g["status"]]
    lines = [head + (f" ({g['commits']} commit(s) on {g['base_branch']})" if g.get("base_branch") else
                     f" ({g['commits']} commit(s))")]
    for d, paths in (g.get("changed") or {}).items():
        lines.append(f"  {d}: {', '.join(paths)}")
    a = g.get("analysis")
    if a and a["status"] != "ok":
        lines.append(f"  analysis rejected ({a['reason']}); builders get a re-check note")
    for k, p in (g.get("pieces") or {}).items():
        for b in p["briefing"] if a and a["status"] == "ok" else []:
            lines.append(f"  {k}: moved: {b}")
        for c in p["contradicted"]:
            lines.append(f"  {k}: contradicted: {c}")
    return lines


# ---------------------------------------------------------------------------
# Run start
# ---------------------------------------------------------------------------


def question(key: str, p: dict[str, Any]) -> str:
    """No SHA in the text: the same contradiction is never asked twice across resumes."""
    return (f"The plan for `{key}` no longer matches the code: "
            + "; ".join(p["contradicted"])
            + f". Re-plan by day (/speckit-plan, then /speckit-tasks) for {key}, or say the plan still stands.")


def run_start(feature: str | None, repo: str | None) -> dict[str, Any]:
    import blocker
    import phase_merge as pm
    import nightshift_state as nsstate
    ctx = pm.load_ctx(feature)
    if pm.is_bug(ctx):
        g = {"status": "not_checked", "note": "a bug run has no plan docs", "pieces": {}}
        ctx.state["grounding"] = g
        ctx.save()
        return g
    record = core.load_record(core.record_path(ctx.root, ctx.name))
    since = since_for(ctx.root, ctx.fdir, record)
    until = pm.fetch_branch(ctx.root, ctx.state["feature_branch"])
    old = ctx.state.get("grounding") or {}
    if old.get("grounded_at") == since and old.get("compared_to") == until:
        g = old  # resume: the same comparison, already recorded
    else:
        log = lambda step, outcome, sha, detail="": ctx.log("_run", step, outcome, sha, detail)  # noqa: E731
        g = check(ctx.root, ctx.fdir, ctx.name, record, since, until, log)
        branch = base_branch(ctx.root)
        try:
            base = pm.fetch_branch(ctx.root, branch)
            g["base_branch"] = branch
            g["base_moved"] = int(git(ctx.root, "rev-list", "--count", f"{since}..{base}", check=False) or 0)
        except core.NightshiftError:
            pass
        nsstate.refresh(ctx.root, ctx.name, ctx.state)
        ctx.state["grounding"] = g
        ctx.save()
        ctx.log("_run", "grounding", g["status"], until, summary(g)[0])
    parked = []
    for key, p in g["pieces"].items():
        if p["status"] != "contradicted":
            continue
        sp = ctx.state["pieces"].get(key) or {}
        q = question(key, p)
        if sp.get("status") != "pending" or q in (sp.get("questions_asked") or []):
            continue  # already running, parked or answered (resolve freed it): never ask twice
        ctx = pm.load_ctx(feature)
        blocker.post(ctx, key, q, "plan_stale", pm.resolve_repo(ctx.root, repo))
        parked.append(key)
    return {**g, "parked": parked}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("action", choices=("run",))
    ap.add_argument("--feature")
    ap.add_argument("--repo", metavar="OWNER/NAME")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    out = run_start(args.feature, args.repo)
    if args.json:
        core.emit_json(out)
    else:
        print("Grounding " + "\n".join(summary(out)) if "grounded_at" in out else f"Grounding not checked: {out.get('note')}")
        for k in out.get("parked") or []:
            print(f"parked {k}: plan_stale")
    return 0


if __name__ == "__main__":
    core.run_main(main)
