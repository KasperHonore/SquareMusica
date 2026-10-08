#!/usr/bin/env python3
"""Re-grounding: have the code facts a plan relied on moved since it was checked? (P2)

Intent (spec, acceptance) stays fixed; implementation facts are re-checked. The
grounding docs are the feature's ``plan.md``, ``research.md``, ``data-model.md``,
``contracts/**`` and ``quickstart.md`` (and ``tasks.md`` beside them). The idea of
marking the commit a plan was checked against is borrowed from AI Build Kit's "Trued
against <commit>" line (an idea, no code; ``THIRD_PARTY.md``).

1. **Record** (mechanical): ``ready go`` stores ``approval.grounded_at`` (the commit the
   docs were checked against) and ``approval.grounding_docs``.
2. **Detect** (mechanical): repo paths the docs reference (backticked or plain tokens
   that resolve to a file or directory at either commit) are diffed between
   ``grounded_at`` and the comparison commit (``since...until``): ``unchanged`` |
   ``drifted`` with the changed paths per doc; ``not_checked`` when there are no grounding
   docs or no resolvable paths. No agent is called.
3. **Note** (mechanical): on drift, each piece whose tasks name a changed path (every
   piece when only the plan names it) gets a drift note. ``ready check`` shows it by day;
   ``grounding.py run`` (run start) records it in state, where the piece orchestrator and
   the builder prompt read it. Judging whether the plan still holds is the piece
   orchestrator's (behavioural): a contradiction it cannot resolve is a product question.
   Nothing here writes a Spec Kit artifact (P1).
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

import nightshift_config as config  # noqa: E402
import nightshift_core as core  # noqa: E402
import nightshift_model as model  # noqa: E402

DOC_NAMES = ("plan.md", "research.md", "data-model.md", "quickstart.md")
TASKS_DOC = "tasks.md"  # names paths too (live L1 1.1.0 finding 3); counted beside a plan doc
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
    approval, unless the day check (``checked``) found drift: then it stays at the commit
    that check compared from, so the run start still sees it."""
    at = rev(root, "HEAD")
    if checked and checked.get("status") == "drifted":
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


def resolve_paths(text: str, trees: list[tuple[set[str], set[str]]], own: str) -> list[str]:
    """Repo paths ``text`` references that exist in one of ``trees``. The feature's own
    folder and ``.specify/`` are intent, not code: excluded. A reference without its
    leading directories (``routes/queue.js``; live L1 1.1.0 finding 3) resolves to the one
    tracked file it is a path suffix of; ambiguous ones are ignored (conservative)."""
    every = set().union(*(files for files, _ in trees))
    found = []
    for c in candidates(text):
        if not any(c in files or ("/" in c and c in dirs) for files, dirs in trees):
            hits = [f for f in every if f.endswith("/" + c)]
            c = hits[0] if len(hits) == 1 else ""
        if c and not (c + "/").startswith((own, ".specify/", ".nightshift/")):
            found.append(c)
    return list(dict.fromkeys(found))


def _under(path: str, ref: str) -> bool:
    return path == ref or path.startswith(ref + "/")


def detect(root: Path, fdir: Path, since: str, until: str) -> dict[str, Any]:
    names = doc_names(fdir)
    out: dict[str, Any] = {"status": "not_checked", "grounded_at": since, "compared_to": until,
                           "docs": names, "paths": 0, "changed": {}, "commits": 0, "pieces": {}}
    if not names:
        out["note"] = "no grounding docs (plan.md, research.md, data-model.md, contracts/, quickstart.md)"
        return out
    if not since or not until:
        out["note"] = "no commit to compare"
        return out
    trees = [_tree(root, since), _tree(root, until)]
    own = core.feature_id(root, fdir).rstrip("/") + "/"
    refs = {p.relative_to(fdir).as_posix(): resolve_paths(p.read_text(encoding="utf-8", errors="replace"), trees, own)
            for p in docs(fdir)}
    refs = {d: v for d, v in refs.items() if v}
    out["paths"] = len({p for v in refs.values() for p in v})
    out["commits"] = int(git(root, "rev-list", "--count", f"{since}..{until}", check=False) or 0)
    if not refs:
        out["note"] = "the grounding docs name no repository path; nothing to compare"
        return out
    every = sorted({p for v in refs.values() for p in v})
    changed = git(root, "diff", "--no-renames", "--name-only", f"{since}...{until}", "--", *every).splitlines()
    out["changed"] = {d: v for d, v in ((d, sorted(c for c in changed if any(_under(c, r) for r in ps)))
                                        for d, ps in refs.items()) if v}
    out["status"] = "drifted" if out["changed"] else "unchanged"
    if out["changed"]:
        out["pieces"] = notes(root, fdir, out, trees, own)
    return out


# ---------------------------------------------------------------------------
# 3. Note per piece
# ---------------------------------------------------------------------------


def notes(root: Path, fdir: Path, det: dict[str, Any], trees: list[tuple[set[str], set[str]]],
          own: str) -> dict[str, str]:
    """A drift note per affected piece: one whose task text names a changed path, or
    every piece when no task names one (the plan does; the owner cannot be told which)."""
    changed = sorted({c for v in det["changed"].values() for c in v})
    pieces = model.derive(root, fdir).pieces
    named = {p.key: sorted({c for t in p.tasks for r in resolve_paths(t.description, trees, own)
                            for c in changed if _under(c, r)}) for p in pieces}
    hit = {k: v for k, v in named.items() if v} or {p.key: changed for p in pieces}
    since, until = det["grounded_at"][:12], det["compared_to"][:12]
    return {k: (f"Code the plan names changed since planning ({since}..{until}): {', '.join(v)}. The plan's "
                "intent still stands; re-check its claims about these paths against the code before "
                "relying on them.") for k, v in hit.items()}


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
    out = detect(root, fdir, since_for(root, fdir, record), until)
    out["base_branch"] = branch
    return out


def summary(g: dict[str, Any]) -> list[str]:
    since, until = (g.get("grounded_at") or "")[:12], (g.get("compared_to") or "")[:12]
    head = {"not_checked": f"not checked: {g.get('note', '')}",
            "unchanged": f"unchanged: {g['paths']} path(s) the plan names did not change {since}..{until}",
            "drifted": f"drifted: code the plan names changed {since}..{until}"}[g["status"]]
    lines = [head + (f" ({g['commits']} commit(s) on {g['base_branch']})" if g.get("base_branch") else
                     f" ({g['commits']} commit(s))")]
    lines += [f"  {d}: {', '.join(paths)}" for d, paths in (g.get("changed") or {}).items()]
    lines += [f"  note for {k}" for k in g.get("pieces") or {}]
    return lines


def run_start(feature: str | None) -> dict[str, Any]:
    """At run start (and on resume): compare against origin's feature head and record the
    result, with the per-piece notes, in run state. Idempotent per comparison."""
    import phase_merge as pm
    import nightshift_state as nsstate
    ctx = pm.load_ctx(feature)
    record = core.load_record(core.record_path(ctx.root, ctx.name))
    since = since_for(ctx.root, ctx.fdir, record)
    until = pm.fetch_branch(ctx.root, ctx.state["feature_branch"])
    old = ctx.state.get("grounding") or {}
    if old.get("grounded_at") == since and old.get("compared_to") == until:
        return old  # resume: the same comparison, already recorded
    g = detect(ctx.root, ctx.fdir, since, until)
    nsstate.refresh(ctx.root, ctx.name, ctx.state)
    ctx.state["grounding"] = g
    ctx.save()
    ctx.log("_run", "grounding", g["status"], until, summary(g)[0])
    return g


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("action", choices=("run",))
    ap.add_argument("--feature")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    out = run_start(args.feature)
    if args.json:
        core.emit_json(out)
    else:
        print("Grounding " + "\n".join(summary(out)))
    return 0


if __name__ == "__main__":
    core.run_main(main)
