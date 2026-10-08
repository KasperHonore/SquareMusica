#!/usr/bin/env python3
"""Pin the review inputs, judge the critic's answer and decide a piece's next step
(design §6.2 steps 5–6, D-REV, D-GAUNTLET; thinned in core review stage 3, 2026-10-05).

``inputs --piece P --sha S [--base B] [--checkout DIR]``
    Freeze the bar, write the diff and the tree record, render the critic prompt.
``review --piece P --sha S --file F``
    Check the critic's answer and record the verdict.
``next --piece P``
    ``{action: build|review|merge|block|park, reason, unseen_findings}`` and the transition.

One fresh, read-only critic per round judges the candidate against the frozen bar (the
acceptance criteria verbatim, plus the piece's quality bar where one was approved).
What this script enforces, all **mechanical**:

- **Scripts first**: ``inputs`` and ``review`` refuse unless the piece's checks passed
  at the candidate, so a critic never runs on, and never overrides, red checks.
- **Bound to the SHA**: the review checkout's HEAD, the candidate and the answer's
  ``sha`` must be the same commit. The verdict records the bar hash; a changed bar
  (``spec.md`` changed by clarify) voids it and the piece is reviewed again.
- **Read-only**: HEAD, ``git write-tree`` and ``git status`` of the review checkout must
  match the record taken before the critic ran (``mutates-tree``). The critic's lack of
  write tools is behavioural (its flags in ``phase.py``).
- **Shape**: one JSON object with exactly the known fields and one criterion per bar
  ref. A prose preamble without ``{`` and one ``json`` fence are tolerated and logged
  (D23). A rejected answer is a failed review, never approval.
- **Decision**: ``decision_needed`` blocks the piece (P6); a failing criterion or a
  blocker/major finding asks for changes; otherwise approve. Only findings the builder
  has not seen go back to it; ``max_rounds`` or the same blockers twice park the piece.
- **No loop switching**: no code path writes a piece's ``loop``; ``next`` refuses when the
  state's loop differs from the approved record.

Whether the critic's judgement is right is behavioural (P3).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import checks as chk  # noqa: E402
import nightshift_config as config  # noqa: E402
import nightshift_core as core  # noqa: E402
import nightshift_model as model  # noqa: E402
import nightshift_state as st  # noqa: E402

SEVERITIES = ("blocker", "major", "minor", "nit")
BLOCKING = ("blocker", "major")
ANSWER = {"sha": str, "criteria": list, "findings": list, "biggest_gap": str, "decision_needed": (str, type(None))}


class Rejected(Exception):
    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(f"{reason}: {detail}")
        self.reason, self.detail = reason, detail


def git(cwd: Path, *args: str) -> str:
    res = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if res.returncode != 0:
        raise core.NightshiftError(f"git {' '.join(args)} failed in {cwd}: {res.stderr.strip()}")
    return res.stdout


def resolve_sha(cwd: Path, rev: str) -> str:
    if rev.startswith("-"):
        raise core.NightshiftError(f"refusing revision that looks like an option: {rev!r}")
    return git(cwd, "rev-parse", "--verify", f"{rev}^{{commit}}").strip()


def tree_token(cwd: Path) -> dict[str, str]:
    """HEAD, index tree and working-tree status: any critic write changes one of them."""
    status = git(cwd, "status", "--porcelain=v1", "--untracked-files=all")
    return {"head": git(cwd, "rev-parse", "HEAD").strip(), "write_tree": git(cwd, "write-tree").strip(),
            "status_sha256": hashlib.sha256(status.encode()).hexdigest()}


def sha256_json(data: Any) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


# ---------------------------------------------------------------------------
# The critic's answer
# ---------------------------------------------------------------------------

_FENCE_OPEN = re.compile(r"```(?:json)?[ \t]*$", re.I)


def _no_dupes(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    if len({k for k, _ in pairs}) != len(pairs):
        raise ValueError("duplicate key")
    return dict(pairs)


def parse_output(text: str) -> tuple[Any, str]:
    """The single JSON object in an answer, and a note on what was ignored. Tolerated:
    prose before it without ``{`` and one ``json`` fence around it. Anything else
    (no object, invalid JSON, duplicate keys, trailing text) is ``bad-json``."""
    s = text.strip()
    start = s.find("{")
    if start < 0:
        raise Rejected("bad-json", "output contains no JSON object")
    prefix = s[:start].rstrip()
    fenced = bool(_FENCE_OPEN.search(prefix))
    if fenced:
        prefix = _FENCE_OPEN.sub("", prefix).rstrip()
    try:
        obj, end = json.JSONDecoder(object_pairs_hook=_no_dupes).raw_decode(s, start)
    except ValueError as exc:
        raise Rejected("bad-json", str(exc)) from exc
    rest = s[end:].strip()
    if fenced and not rest.startswith("```"):
        raise Rejected("bad-json", "code fence opened before the JSON object is not closed after it")
    rest = rest[3:].strip() if fenced else rest
    if rest:
        raise Rejected("bad-json", "more than one JSON object" if rest.startswith("{") else "trailing text after the JSON object")
    notes = [f"ignored preamble ({len(prefix)} chars): {' '.join(prefix.split())[:120]!r}"] if prefix else []
    return obj, "; ".join(notes + (["stripped code fence"] if fenced else []))


def check_answer(data: Any, sha: str, bar: dict[str, Any]) -> None:
    if not isinstance(data, dict) or set(data) != set(ANSWER):
        got = sorted(data) if isinstance(data, dict) else type(data).__name__
        raise Rejected("schema", f"expected exactly the fields {sorted(ANSWER)}, got {got}")
    bad = [k for k, t in ANSWER.items() if not isinstance(data[k], t)]
    for c in data["criteria"] if not bad else []:
        if not (isinstance(c, dict) and set(c) == {"ref", "result", "evidence"} and c["result"] in ("pass", "fail")
                and isinstance(c["ref"], str) and isinstance(c["evidence"], str) and c["evidence"].strip()):
            bad.append(f"criterion {c!r}")
    for f in data["findings"] if not bad else []:
        if not (isinstance(f, dict) and {"severity", "path", "rationale"} <= set(f) <= {"severity", "path", "lines", "rationale"}
                and all(isinstance(v, str) for v in f.values()) and f["severity"] in SEVERITIES and f["rationale"].strip()):
            bad.append(f"finding {f!r}")
    if not bad and data["decision_needed"] is not None and not data["decision_needed"].strip():
        bad.append("decision_needed must be a question or null")
    if bad:
        raise Rejected("schema", "; ".join(str(b)[:160] for b in bad[:3]))
    if data["sha"] != sha:
        raise Rejected("wrong-sha", f"{data['sha']} != {sha}")
    refs, want = [c["ref"] for c in data["criteria"]], [s["ref"] for s in bar.get("scenarios") or []]
    if len(refs) != len(set(refs)) or set(refs) != set(want):
        raise Rejected("skips-criterion", f"criteria {sorted(refs)} do not match the frozen bar {sorted(want)}")


def fingerprint(f: dict[str, Any]) -> str:
    """Stable identity across rounds: critics renumber and reword, so not an id."""
    if f.get("fingerprint"):
        return f["fingerprint"]
    rationale = " ".join(str(f.get("rationale", "")).lower().split())
    raw = f"{f.get('path', '')}|{str(f.get('category', '')).lower()}|{hashlib.sha256(rationale.encode()).hexdigest()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Context
# ---------------------------------------------------------------------------


class Ctx:
    def __init__(self, feature: str | None, piece: str) -> None:
        self.root = core.find_project_root()
        self.fdir = core.resolve_feature_dir(self.root, feature)
        self.name = self.fdir.name
        self.state = st.load(self.root, self.name)
        self.key, self.p = piece, st.piece(self.state, piece)
        self.record = core.load_record(core.record_path(self.root, self.name))
        self.cfg = config.load(self.root)
        self._guard = self.p["loop"]

    def ev(self, sha: str) -> Path:
        return st.run_dir(self.root, self.name) / "evidence" / self.key / sha

    def save(self) -> None:
        if self.p["loop"] != self._guard:
            raise core.NightshiftError(f"{self.key}: loop changed in-process; refusing to save")
        st.save(self.root, self.name, self.state)

    def log(self, step: str, outcome: str, sha: str | None, detail: str = "") -> None:
        st.log(self.root, self.name, self.state, piece=self.key, step=step, outcome=outcome, sha=sha, detail=detail)

    def green(self) -> None:
        if self.p["checks"] != "passed":
            raise core.NightshiftError(f"{self.key}: checks are {self.p['checks']}; the critic runs only on green "
                                       "checks and never overrides red ones")

    def read_json(self, path: Path) -> Any:
        if not path.is_file():
            raise core.NightshiftError(f"missing review input {path}; run `verdict.py inputs` first")
        return json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# inputs, review
# ---------------------------------------------------------------------------


def inputs(c: Ctx, sha_rev: str, base_rev: str | None, checkout: Path) -> dict[str, Any]:
    p = c.p
    if p["status"] not in ("checking", "reviewing"):
        raise core.NightshiftError(f"{c.key}: cannot review in status {p['status']} (needs checking or reviewing)")
    c.green()
    sha, head = resolve_sha(checkout, sha_rev), resolve_sha(checkout, "HEAD")
    if p.get("candidate_sha") and p["candidate_sha"] != sha:
        raise core.NightshiftError(f"{c.key}: {sha} is not the candidate SHA {p['candidate_sha']}")
    if head != sha:
        raise core.NightshiftError(f"{c.key}: review checkout {checkout} is at {head}, not {sha}")
    if not (base_rev or p.get("base_sha")):
        raise core.NightshiftError(f"{c.key}: no --base given and no base_sha in the run state")
    base = resolve_sha(checkout, base_rev or p["base_sha"])
    ev = c.ev(sha)
    ev.mkdir(parents=True, exist_ok=True)
    bar = model.freeze_bar(c.root, c.fdir, c.key, p["loop"])
    bar_hash = sha256_json(bar)
    (ev / "bar.json").write_text(json.dumps(bar, indent=2) + "\n", encoding="utf-8")
    (ev / "diff.patch").write_text(git(checkout, "diff", base, sha), encoding="utf-8")
    files = git(checkout, "diff", "--name-status", "--no-renames", base, sha).split("\n")
    (ev / "tree-before.json").write_text(json.dumps({**tree_token(checkout), "checkout": str(checkout)}), encoding="utf-8")
    prompt = core.render_template(c.root, "prompt-critic.md", {
        "sha": sha, "base": base, "piece": c.key, "feature": core.feature_id(c.root, c.fdir), "evidence_dir": str(ev),
        "bar": model.bar_markdown(bar), "diff": str(ev / "diff.patch"),
        "files": "\n".join(f"- `{ln.split(chr(9))[-1]}` ({ln[0]})" for ln in files if ln.strip()) or "(no files changed)",
        "criteria": json.dumps([{"ref": s["ref"], "result": "pass|fail", "evidence": "..."} for s in bar["scenarios"]])})
    (ev / "prompt-critic.md").write_text(prompt, encoding="utf-8")
    bar_changed = bool(p.get("bar_hash")) and p["bar_hash"] != bar_hash
    if bar_changed:
        st.set_sub(c.state, c.key, "verdict", "not_run")
    p.update(bar_hash=bar_hash, base_sha=p.get("base_sha") or base, candidate_sha=sha)
    if p["status"] == "checking":
        st.transition(c.state, c.key, "reviewing")
    st.step_complete(c.state, f"{c.key}:{p['round']}:review", {"sha": sha, "base": base},
                     {"evidence": str(ev), "bar_hash": bar_hash})
    c.save()
    if bar_changed:
        c.log("review", "bar_changed", sha, "the frozen bar changed; earlier verdicts are void")
    c.log("review", "inputs_pinned", sha, f"bar {bar_hash[:12]}")
    return {"piece": c.key, "sha": sha, "base": base, "bar_hash": bar_hash, "bar_changed": bar_changed,
            "evidence_dir": str(ev), "prompt": str(ev / "prompt-critic.md")}


def review(c: Ctx, sha_rev: str, path: Path) -> dict[str, Any]:
    p, sha = c.p, c.p.get("candidate_sha")
    if not sha:
        raise core.NightshiftError(f"{c.key}: no candidate SHA in the run state; run `verdict.py inputs` first")
    ev = c.ev(sha)
    before, bar = c.read_json(ev / "tree-before.json"), c.read_json(ev / "bar.json")
    if resolve_sha(Path(before["checkout"]), sha_rev) != sha:
        raise core.NightshiftError(f"{c.key}: --sha {sha_rev} is not the candidate {sha}")
    bar_hash = sha256_json(bar)
    if bar_hash != p.get("bar_hash"):
        raise core.NightshiftError(f"{c.key}: review inputs are stale; run `verdict.py inputs` again")
    step = f"{c.key}:{p['round']}:verdict"
    step_inputs = {"sha": sha, "bar_hash": bar_hash,
                   "answer": hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None}
    done = st.step_done(c.state, step, step_inputs)
    if done:
        return done["result"]
    if p["status"] != "reviewing":
        raise core.NightshiftError(f"{c.key}: cannot record a verdict in status {p['status']}")
    c.green()
    data, note = None, ""
    try:
        now = tree_token(Path(before["checkout"]))
        moved = [k for k in ("head", "write_tree", "status_sha256") if now[k] != before.get(k)]
        if moved:
            raise Rejected("mutates-tree", f"changed: {', '.join(moved)}")
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise Rejected("bad-json", f"cannot read {path}: {exc}") from exc
        data, note = parse_output(text)
        check_answer(data, sha, bar)
        critic = {"status": "accepted"}
    except Rejected as r:
        data, critic = None, {"status": "rejected", "reason": r.reason, "detail": r.detail}
    if note:
        critic["parse_note"] = note
    findings: list[dict[str, Any]] = []
    blockers: list[str] = []
    question = None
    if data is None:
        result, reason, blockers = "changes", "review_rejected", [f"review_rejected:{critic['reason']}"]
    elif data["decision_needed"]:
        result, reason, question = "decision_needed", "decision_needed", data["decision_needed"].strip()
    else:
        failing = [x for x in data["criteria"] if x["result"] == "fail"]
        findings = [{**f, "fingerprint": fingerprint(f)} for f in data["findings"]] + [
            {"severity": "blocker", "category": "acceptance", "path": "-", "lines": "*",
             "rationale": f"{x['ref']} fails: {x['evidence']}", "fingerprint": "criterion:" + x["ref"]} for x in failing]
        blockers = sorted({f["fingerprint"] for f in findings if f["severity"] in BLOCKING})
        result, reason = ("changes", "criteria_fail" if failing else "blocking_findings") if blockers \
            else ("approve", "approved")
    record = {"piece": c.key, "sha": sha, "bar_hash": bar_hash, "round": p["round"], "result": result,
              "reason": reason, "critic": critic, "findings": findings, "blockers": blockers,
              "biggest_gap": data["biggest_gap"] if data else None, "question": question}
    (ev / "verdict.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    st.set_sub(c.state, c.key, "verdict", "passed" if result == "approve" else "rejected" if data is None else "failed")
    if result == "changes":
        p["blocker_history"].append({"round": p["round"], "sha": sha, "source": "review", "blockers": blockers})
    elif result == "approve":
        st.transition(c.state, c.key, "merging")
    else:
        st.transition(c.state, c.key, "blocked", reason="decision_needed")
        p["question"] = question
    st.step_complete(c.state, step, step_inputs, record)
    c.save()
    if data is None:
        c.log("review", "review_rejected", sha, f"critic: {critic['reason']}: {critic['detail']}")
    if note:
        c.log("review", "output_tolerated", sha, f"critic: {note}")
    c.log("verdict", result, sha, reason)
    return record


# ---------------------------------------------------------------------------
# next (D6, D7)
# ---------------------------------------------------------------------------


def _park(c: Ctx, reason: str, sha: str | None) -> dict[str, Any]:
    st.transition(c.state, c.key, "parked", reason=reason)
    c.save()
    c.log("next", "parked", sha, reason)
    return {"action": "park", "reason": reason, "unseen_findings": []}


def _build(c: Ctx, reason: str, findings: list[dict[str, Any]], sha: str | None) -> dict[str, Any]:
    p = c.p
    unseen = [f for f in findings if fingerprint(f) not in set(p["seen_findings"])]
    p["seen_findings"] += [fingerprint(f) for f in unseen]
    st.transition(c.state, c.key, "building")
    p["round"] += 1
    for field in st.SUB_FIELDS:
        st.set_sub(c.state, c.key, field, "not_run")
    c.save()
    c.log("next", "build", sha, f"round {p['round']}: {reason}; {len(unseen)} unseen of {len(findings)} findings")
    return {"action": "build", "reason": reason, "unseen_findings": unseen}


def stagnated(history: list[Any]) -> bool:
    """The same non-empty blocker set two rounds running (a run started before 2026-10-03
    may hold question strings in the history; they are skipped)."""
    recs = [h for h in history if isinstance(h, dict)]
    return len(recs) >= 2 and bool(recs[-1]["blockers"]) and sorted(recs[-2]["blockers"]) == sorted(recs[-1]["blockers"])


def _repair(c: Ctx, source: str, blockers: list[str], findings: list[dict[str, Any]],
            sha: str | None) -> dict[str, Any]:
    """Record a failed round and hand it back to the builder, or park it (round cap, stagnation)."""
    c.p["blocker_history"].append({"round": c.p["round"], "sha": sha, "source": source, "blockers": blockers})
    if stagnated(c.p["blocker_history"]):
        return _park(c, "stagnation", sha)
    if st.rounds_used(c.p) >= int(c.cfg.get("max_rounds") or 3):
        return _park(c, "max_rounds", sha)
    return _build(c, f"{source}_failed", findings, sha)


def next_step(c: Ctx) -> dict[str, Any]:
    approved = ((c.record.get("pieces") or {}).get(c.key) or {}).get("loop")
    if approved and approved != c.p["loop"]:
        raise core.NightshiftError(f"{c.key}: run state loop {c.p['loop']!r} differs from the approved loop "
                                   f"{approved!r}; a loop change needs a human decision, never the run")
    p, sha, status = c.p, c.p.get("candidate_sha"), c.p["status"]
    simple = {"merging": ("merge", "approved"), "parked": ("park", p.get("reason")),
              "building": ("build", "in_progress")}
    if status in simple:
        return {"action": simple[status][0], "reason": simple[status][1], "unseen_findings": []}
    if status == "blocked":
        return {"action": "block", "reason": p.get("reason"), "question": p.get("question"), "unseen_findings": []}
    if status == "pending":
        return _build(c, "start", [], sha)
    if status == "checking" and p["builder"] == "failed":
        # Postconditions failed the attempt; red checks of the same round go to the builder too (D23b).
        blockers = p.get("postcondition_violations") or ["postconditions"]
        red = chk.findings(c.ev(sha)) if sha and p["checks"] == "failed" else []
        return _repair(c, "postconditions", blockers, [{"severity": "blocker", "category": "postconditions", "path": "-",
                                                        "lines": "-", "rationale": b} for b in blockers] + red, sha)
    if status == "checking" and p["checks"] == "failed":
        recs = [h for h in p["blocker_history"] if isinstance(h, dict)]
        if not sha or sha == p.get("base_sha") or (recs and recs[-1].get("sha") == sha):
            return _park(c, "no_progress", sha)
        return _repair(c, "checks", chk.failing_ids(c.ev(sha)), chk.findings(c.ev(sha)), sha)
    if status == "reviewing":
        vpath = c.ev(sha or "-") / "verdict.json"
        verdict = json.loads(vpath.read_text(encoding="utf-8")) if sha and vpath.is_file() else None
        if not verdict or verdict.get("bar_hash") != p.get("bar_hash") or p["verdict"] == "not_run":
            return {"action": "review", "reason": "verdict_missing_or_invalid", "unseen_findings": []}
        if stagnated(p["blocker_history"]):
            return _park(c, "stagnation", sha)
        if st.rounds_used(p) >= int(c.cfg.get("max_rounds") or 3):
            return _park(c, "max_rounds", sha)
        return _build(c, verdict["reason"], verdict["findings"], sha)
    return {"action": "review" if p["checks"] == "passed" else "build", "reason": f"status_{status}",
            "unseen_findings": []}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    takes_value = {"--feature", "--piece", "--sha", "--file", "--base", "--checkout"}
    idx = next((i for i, a in enumerate(argv) if a in ("inputs", "review", "next")
                and (i == 0 or argv[i - 1] not in takes_value)), None)
    if idx is None:
        raise core.NightshiftError("usage: verdict.py inputs|review|next --piece P ...")
    argv = [argv[idx], *argv[:idx], *argv[idx + 1:]]
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("inputs", "review", "next"):
        sp = sub.add_parser(name)
        sp.add_argument("--feature")
        sp.add_argument("--piece", required=True)
        sp.add_argument("--json", action="store_true")
        if name != "next":
            sp.add_argument("--sha", required=True)
        if name == "inputs":
            sp.add_argument("--base", help="piece base commit (default: base_sha in the run state)")
            sp.add_argument("--checkout", help="review checkout (default: the piece worktree, else the repo root)")
        if name == "review":
            sp.add_argument("--file", required=True, help="the critic's answer (phase.py review prints it)")
    args = ap.parse_args(argv)
    c = Ctx(args.feature, args.piece)
    if args.cmd == "inputs":
        wt = st.run_dir(c.root, c.name) / "worktrees" / c.key
        checkout = Path(args.checkout).resolve() if args.checkout else (wt if wt.is_dir() else c.root)
        out = inputs(c, args.sha, args.base, checkout)
        line = f"Review inputs for {c.key} at {out['sha'][:12]}: bar {out['bar_hash'][:12]}; prompt {out['prompt']}"
    elif args.cmd == "review":
        out = review(c, args.sha, Path(args.file).resolve())
        line = f"{c.key}: {out['result']} ({out['reason']})"
    else:
        out = next_step(c)
        line = f"{c.key}: {out['action']} ({out['reason']}), {len(out['unseen_findings'])} unseen finding(s)"
    if args.json:
        core.emit_json(out)
    else:
        print(line)
    return 0


if __name__ == "__main__":
    core.run_main(main)
