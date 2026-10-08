"""Pieces, validation and readiness for Spec Kit Nightshift (design §3–§6.1).

Pieces are derived from ``tasks.md`` every time and never stored. The delivery
record holds only what ``tasks.md`` lacks: the approved loop and optional quality bar
per piece, protected paths, cached issue numbers and the approval baseline.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import nightshift_core as core

# ---------------------------------------------------------------------------
# Derivation
# ---------------------------------------------------------------------------


@dataclass
class Piece:
    key: str
    title: str
    kind: str
    phases: list[int]
    story: str
    tasks: list[core.Task]
    labels: dict[str, str]
    depends_on: list[str] = field(default_factory=list)

    def refs(self, feature: str) -> list[str]:
        return [core.task_ref(feature, t.id) for t in self.tasks]


@dataclass
class Derivation:
    feature: str  # "specs/001-notes-search"
    feature_dir: Path
    name: str  # "001-notes-search"
    doc: core.TasksDoc
    pieces: list[Piece]  # dependency order
    problems: list[dict[str, str]]  # derivation-level errors (cycles, unknown deps)


def piece_key(phase: core.Phase) -> str:
    if phase.kind in ("setup", "foundational"):
        return "foundation"
    if phase.kind == "story":
        return phase.story.lower()
    if phase.kind == "polish":
        return "polish"
    if phase.kind == "convergence":
        return f"convergence-{phase.number}"
    return f"phase-{phase.number}"


def _group_phases(doc: core.TasksDoc) -> list[Piece]:
    pieces: dict[str, Piece] = {}
    order: list[str] = []
    for ph in doc.phases:
        key = piece_key(ph)
        if key in pieces:
            p = pieces[key]
            if key != "foundation":
                # Two phases claiming the same story or a second Polish phase:
                # keep them apart so nothing is silently merged.
                key = f"{key}-phase-{ph.number}"
            else:
                p.phases.append(ph.number)
                p.tasks.extend(ph.tasks)
                p.title = "Setup + Foundational"
                for k, v in ph.labels.items():
                    p.labels.setdefault(k, v)
                continue
        title = re.sub(r"\s*\((?:Priority:[^)]*|[^)]*)\).*$", "", ph.title).strip() or ph.title
        pieces[key] = Piece(key, title, ph.kind, [ph.number], ph.story, list(ph.tasks), dict(ph.labels))
        order.append(key)
    return [pieces[k] for k in order]


def group_pieces(doc: core.TasksDoc) -> list[Piece]:
    """Pieces of a parsed tasks.md in document order, without dependencies.

    Used on tasks.md content read from a commit (postconditions), where the
    working tree is not the source.
    """
    return _group_phases(doc)


_PHASE_NUM_RE = re.compile(r"\bPhase\s+(\d+)\b(?!\+)", re.IGNORECASE)
_STORY_REF_RE = re.compile(r"\b(?:User Story\s+(\d+)|US(\d+))\b", re.IGNORECASE)
_NAME_REFS = {
    "setup": ("setup",),
    "foundational": ("foundational",),
}


def _dep_targets(text: str, by_phase: dict[int, str], by_story: dict[str, str],
                 by_kind: dict[str, list[str]]) -> list[str]:
    """Pieces named as prerequisites in one dependency bullet.

    Clauses are split at " - ", ";" and sentence ends. Only clauses that state a
    prerequisite count ("after …", "depends on …", "requires …", "needs …",
    "follow …"); "may integrate with US1" is not a dependency, and neither is a
    preference such as "best after US2" or a story the piece works without or uses
    "if present" (live 2026-10-08: "Works without US3" made US4 wait for US3).
    """
    targets: list[str] = []
    for clause in re.split(r"\s+-\s+|;\s*|(?<!\be\.g\.)(?<!\bi\.e\.)(?<=[.!?])\s+(?=[A-Z(*])", text):
        # "Works without US3", "US3's set if present", "optionally US3": drop that part only.
        clause = ",".join(part for part in clause.split(",")
                          if not re.search(r"\bwithout\b|\bif present\b|\boptional(ly)?\b", part, re.IGNORECASE))
        low = clause.lower()
        if "no dependencies" in low or "may integrate" in low or "independent" in low and "after" not in low:
            continue
        # A preference ("best after US2") is not a prerequisite; drop that part only.
        low = re.sub(r"\b(best|ideally|preferably|optionally)\s+(after|with)\b[^,;]*", "", low)
        clause = re.sub(r"\b(best|ideally|preferably|optionally)\s+(after|with)\b[^,;]*", "", clause,
                        flags=re.IGNORECASE)
        if not re.search(r"\b(after|depends on|depend on|requires|blocked by|needs?|follows?)\b", low):
            continue
        for m in _PHASE_NUM_RE.finditer(clause):
            k = by_phase.get(int(m.group(1)))
            if k:
                targets.append(k)
        for m in _STORY_REF_RE.finditer(clause):
            k = by_story.get(f"US{m.group(1) or m.group(2)}")
            if k:
                targets.append(k)
        for kind, words in _NAME_REFS.items():
            if any(re.search(rf"\b{w}\b", low) for w in words):
                targets.extend(by_kind.get(kind, []))
    return targets


def derive(root: Path, feature_dir: Path) -> Derivation:
    tasks_md = feature_dir / "tasks.md"
    if not tasks_md.is_file():
        raise core.NightshiftError(f"tasks.md not found in {feature_dir}; run the Spec Kit tasks command")
    doc = core.parse_tasks(tasks_md)
    feature = core.feature_id(root, feature_dir)
    pieces = _group_phases(doc)
    problems: list[dict[str, str]] = []
    if not doc.phases:
        problems.append({"code": "no-phases", "message": f"{feature}/tasks.md has no '## Phase N:' headings"})

    by_key = {p.key: p for p in pieces}
    by_phase = {n: p.key for p in pieces for n in p.phases}
    by_story = {p.story: p.key for p in pieces if p.story}
    by_kind: dict[str, list[str]] = {}
    for p in pieces:
        by_kind.setdefault(p.kind, []).append(p.key)
    if "foundation" in by_key:
        by_kind["setup"] = by_kind["foundational"] = ["foundation"]

    # Default rules from Spec Kit's tasks template: Setup/Foundational block
    # everything; Polish follows all story and module work; Convergence
    # follows everything before it; module phases run in sequence.
    deps: dict[str, list[str]] = {p.key: [] for p in pieces}
    seen: list[Piece] = []
    for p in pieces:
        base = [q.key for q in seen if q.key == "foundation"]
        if p.key == "foundation":
            pass
        elif p.kind in ("story",):
            deps[p.key] += base
        elif p.kind == "module":
            prev = [q.key for q in seen if q.kind in ("module", "story")]
            deps[p.key] += (prev[-1:] or base) if prev else base
        elif p.kind == "polish":
            deps[p.key] += [q.key for q in seen if q.kind != "convergence"] or base
        elif p.kind == "convergence":
            deps[p.key] += [q.key for q in seen]
        seen.append(p)

    # Declared dependencies ("Dependencies & Execution Order") add to the defaults.
    for _line, subject, text in doc.deps_bullets:
        subj_keys: list[str] = []
        sm = _STORY_REF_RE.search(subject)
        pm = re.search(r"\(Phase\s+(\d+)\)", subject)
        if sm and by_story.get(f"US{sm.group(1) or sm.group(2)}"):
            subj_keys = [by_story[f"US{sm.group(1) or sm.group(2)}"]]
        elif pm and int(pm.group(1)) in by_phase:
            subj_keys = [by_phase[int(pm.group(1))]]
        for sk in subj_keys:
            for t in _dep_targets(text, by_phase, by_story, by_kind):
                if t != sk and t not in deps[sk]:
                    deps[sk].append(t)

    for p in pieces:
        p.depends_on = list(dict.fromkeys(deps[p.key]))

    ordered, cycle = _toposort(pieces)
    if cycle:
        problems.append({"code": "dependency-cycle", "message": "dependency cycle between pieces: " + " -> ".join(cycle)})
        ordered = pieces
    return Derivation(feature, feature_dir, feature_dir.name, doc, ordered, problems)


def _toposort(pieces: list[Piece]) -> tuple[list[Piece], list[str]]:
    index = {p.key: i for i, p in enumerate(pieces)}
    by_key = {p.key: p for p in pieces}
    state: dict[str, int] = {}
    out: list[Piece] = []
    stack: list[str] = []

    def visit(k: str) -> list[str]:
        if state.get(k) == 2:
            return []
        if state.get(k) == 1:
            return stack[stack.index(k):] + [k]
        state[k] = 1
        stack.append(k)
        for d in sorted(by_key[k].depends_on, key=lambda x: index[x]):
            cyc = visit(d)
            if cyc:
                return cyc
        stack.pop()
        state[k] = 2
        out.append(by_key[k])
        return []

    # Visit in phase order so ties keep tasks.md order.
    for p in pieces:
        cyc = visit(p.key)
        if cyc:
            return pieces, cyc
    return out, []


# ---------------------------------------------------------------------------
# Baseline (the approved snapshot stored in the delivery record)
# ---------------------------------------------------------------------------


def baseline(d: Derivation, spec: core.SpecDoc | None) -> dict[str, Any]:
    piece_of = {t.id: p.key for p in d.pieces for t in p.tasks}
    return {
        "tasks": {
            t.id: {
                "fingerprint": t.fp,
                "description": t.description,
                "piece": piece_of.get(t.id, ""),
                "parallel": t.parallel,
                "story": t.story,
            }
            for t in d.doc.tasks
        },
        "acceptance": {
            s.ref: {"hash": s.hash, "quote": s.text} for s in (spec.scenarios if spec else [])
        },
    }


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@dataclass
class Finding:
    severity: str  # error | warning
    code: str
    message: str
    piece: str = ""
    ref: str = ""

    def as_dict(self) -> dict[str, str]:
        out = {"severity": self.severity, "code": self.code, "message": self.message}
        if self.piece:
            out["piece"] = self.piece
        if self.ref:
            out["ref"] = self.ref
        return out


def check_structure(d: Derivation) -> list[Finding]:
    out = [Finding("error", p["code"], p["message"]) for p in d.problems]
    for t in d.doc.stray:
        out.append(Finding("error", "task-outside-phase",
                           f"{core.task_ref(d.feature, t.id)} (line {t.line}) is not under any '## Phase N:' heading",
                           ref=core.task_ref(d.feature, t.id)))
    seen: dict[str, core.Task] = {}
    for t in d.doc.tasks:
        if t.id in seen:
            ref = core.task_ref(d.feature, t.id)
            out.append(Finding("error", "duplicate-task-id",
                               f"{ref} appears twice (lines {seen[t.id].line} and {t.line})", ref=ref))
        else:
            seen[t.id] = t
    for p in d.pieces:
        if not p.tasks:
            out.append(Finding("warning", "empty-piece", f"piece {p.key} has no tasks", piece=p.key))
        for t in p.tasks:
            if p.kind == "story" and t.story and t.story != p.story:
                out.append(Finding("warning", "story-label-mismatch",
                                   f"{core.task_ref(d.feature, t.id)} is labelled [{t.story}] inside the {p.story} phase",
                                   piece=p.key, ref=core.task_ref(d.feature, t.id)))
    return out


def check_drift(d: Derivation, spec: core.SpecDoc | None, base: dict[str, Any]) -> tuple[list[Finding], set[str]]:
    """Compare the current files with the approved baseline (design §4).

    Returns findings and the set of pieces whose tasks drifted.
    """
    out: list[Finding] = []
    drifted: set[str] = set()
    if not base:
        return out, drifted
    old_tasks: dict[str, dict[str, Any]] = base.get("tasks") or {}
    cur = {t.id: t for t in d.doc.tasks}
    piece_of = {t.id: p.key for p in d.pieces for t in p.tasks}
    cur_by_fp: dict[str, list[str]] = {}
    for t in d.doc.tasks:
        cur_by_fp.setdefault(t.fp, []).append(t.id)

    # Renumbering: an approved description now lives under a different ID, or
    # an approved ID disappeared. Never re-attribute; require a remap.
    moved = []
    for tid, old in old_tasks.items():
        fp = old.get("fingerprint")
        here = cur.get(tid)
        if here is not None and here.fp == fp:
            continue
        elsewhere = [i for i in cur_by_fp.get(fp, []) if i != tid]
        if elsewhere:
            moved.append(f"{tid}->{elsewhere[0]}")
        elif here is None:
            moved.append(f"{tid}->(missing)")
    if moved:
        out.append(Finding("error", "remap-required",
                           f"{d.feature}: task IDs no longer match the approved baseline "
                           f"({', '.join(moved[:6])}{', …' if len(moved) > 6 else ''}). "
                           "The run refuses until ready go re-approves the renumbered tasks."))
        drifted.update(v.get("piece", "") for v in old_tasks.values())
        return out, drifted

    for tid, old in old_tasks.items():
        t = cur[tid]
        ref = core.task_ref(d.feature, tid)
        if t.fp != old.get("fingerprint"):
            out.append(Finding("error", "description-changed", f"{ref} description changed since approval",
                               piece=piece_of.get(tid, ""), ref=ref))
            drifted.add(piece_of.get(tid, ""))
        changes = []
        if piece_of.get(tid, "") != old.get("piece", ""):
            changes.append(f"piece {old.get('piece')} -> {piece_of.get(tid, '')}")
        if t.parallel != bool(old.get("parallel")):
            changes.append(f"[P] {'added' if t.parallel else 'removed'}")
        if t.story != (old.get("story") or ""):
            changes.append(f"story {old.get('story') or '-'} -> {t.story or '-'}")
        if changes:
            out.append(Finding("error", "scheduling-changed",
                               f"{ref} scheduling or membership changed: {'; '.join(changes)}",
                               piece=piece_of.get(tid, ""), ref=ref))
            drifted.add(piece_of.get(tid, ""))
            drifted.add(old.get("piece", ""))

    new_ids = [t for t in d.doc.tasks if t.id not in old_tasks]
    for t in new_ids:
        p = piece_of.get(t.id, "")
        ref = core.task_ref(d.feature, t.id)
        old_pieces = {v.get("piece") for v in old_tasks.values()}
        if p.startswith("convergence-") and p not in old_pieces:
            continue  # converge is append-only; a new Convergence phase is a new piece
        out.append(Finding("error", "task-added", f"{ref} was added to approved piece {p}", piece=p, ref=ref))
        drifted.add(p)

    old_acc: dict[str, Any] = base.get("acceptance") or {}
    cur_acc = {s.ref: s for s in (spec.scenarios if spec else [])}
    for ref, old in old_acc.items():
        s = cur_acc.get(ref)
        if s is None:
            out.append(Finding("error", "acceptance-removed",
                               f"acceptance scenario {ref} no longer exists in spec.md; approved quote: \"{old.get('quote', '')}\"",
                               piece=ref.split("/")[0].lower()))
        elif s.hash != old.get("hash"):
            out.append(Finding("error", "acceptance-changed",
                               f"acceptance scenario {ref} changed in spec.md (line {s.line}); the approved quote is kept as is: \"{old.get('quote', '')}\"",
                               piece=ref.split("/")[0].lower(), ref=ref))
    for ref in cur_acc:
        if ref not in old_acc:
            out.append(Finding("warning", "acceptance-added", f"acceptance scenario {ref} is new since approval",
                               piece=ref.split("/")[0].lower()))
    drifted.discard("")
    return out, drifted


# Readiness (design §5) -------------------------------------------------------


def acceptance_ok(piece: Piece, spec: core.SpecDoc | None) -> bool:
    if piece.labels.get("Independent Test"):
        return True
    if spec is None:
        return False
    if piece.story:
        st = spec.stories.get(piece.story, {})
        return bool(st.get("independent_test")) or any(s.story == piece.story for s in spec.scenarios)
    return bool(spec.scenarios)


def compute_readiness(d: Derivation, spec: core.SpecDoc | None, record: dict[str, Any],
                      drifted: set[str], remap: bool, assume_approved: bool = False,
                      grounding: dict[str, Any] | None = None) -> dict[str, dict[str, Any]]:
    """``grounding``: a ``grounding.detect`` result; a piece with a drift note shows
    ``code_assumptions: drifted`` (it stays ready: the note reaches its builder, P2)."""
    ground = (grounding or {}).get("pieces") or {}
    entries = (record.get("pieces") or {}) if record else {}
    own: dict[str, list[str]] = {}
    for p in d.pieces:
        reasons: list[str] = []
        if remap or p.key in drifted:
            reasons.append("drift")
        if spec is not None:
            for c in core.open_questions(spec.clarifications):
                if c.story in ("", p.story):
                    reasons.append("clarification")
                    break
        if not acceptance_ok(p, spec):
            reasons.append("no acceptance check")
        entry = entries.get(p.key) or {}
        if not entry.get("loop") and p.kind != "convergence":  # converge's pieces run build (D-3')
            reasons.append("not in the approved batch")
        if not (record or {}).get("approval") and not assume_approved:
            reasons.append("not approved")
        own[p.key] = reasons

    out: dict[str, dict[str, Any]] = {}
    for p in d.pieces:  # dependency order, so prerequisites are computed first
        blocked_by = [dep for dep in p.depends_on if out[dep]["status"] in ("not ready", "blocked")]
        waiting = list(p.depends_on)
        if own[p.key]:
            status = "not ready"
        elif blocked_by:
            status = "blocked"
        elif waiting:
            status = "waiting"
        else:
            status = "ready"
        out[p.key] = {
            "status": status,
            "reasons": own[p.key],
            "blocked_by": blocked_by,
            "waiting_on": waiting,
            "code_assumptions": "drifted" if p.key in ground
            else ("unchanged" if (grounding or {}).get("status") == "drifted" else (grounding or {}).get("status", "not_checked")),
        }
    return out


def readiness_label(r: dict[str, Any]) -> str:
    if r["status"] == "not ready":
        return "not ready: " + ", ".join(r["reasons"])
    if r["status"] == "blocked":
        return "blocked by " + ", ".join(r["blocked_by"])
    if r["status"] == "waiting":
        return "waiting on " + ", ".join(r["waiting_on"])
    return r["status"]


# ---------------------------------------------------------------------------
# Whole-feature validation
# ---------------------------------------------------------------------------


@dataclass
class Report:
    derivation: Derivation
    spec: core.SpecDoc | None
    record_path: Path
    record: dict[str, Any]
    findings: list[Finding]
    readiness: dict[str, dict[str, Any]]

    @property
    def ok(self) -> bool:
        return not any(f.severity == "error" for f in self.findings)

    @property
    def remap_required(self) -> bool:
        return any(f.code == "remap-required" for f in self.findings)

    def as_dict(self) -> dict[str, Any]:
        d = self.derivation
        return {
            "feature": d.feature,
            "ok": self.ok,
            "record": str(self.record_path),
            "pieces": [
                {
                    "key": p.key, "title": p.title, "kind": p.kind, "story": p.story,
                    "depends_on": p.depends_on,
                    "tasks": [{"ref": core.task_ref(d.feature, t.id), "done": t.done,
                               **({"source_refs": t.source_refs, "gap_type": t.gap_type} if t.gap_type else {})}
                              for t in p.tasks],
                    "loop": ((self.record.get("pieces") or {}).get(p.key) or {}).get("loop", ""),
                    "readiness": self.readiness[p.key],
                }
                for p in d.pieces
            ],
            "findings": [f.as_dict() for f in self.findings],
        }


def task_line(t: core.Task) -> str:
    """A task as a sub-issue body lists it (``ready go``; ticked by ``phase_merge``)."""
    return (f"- [{'x' if t.done else ' '}] {t.id}{' [P]' if t.parallel else ''}"
            f"{' [' + t.story + ']' if t.story else ''} {t.description}")


def contract_path(root: Path, name: str) -> Path:
    return core.assets_dir(root, name) / "run-contract.md"


def validate_feature(root: Path, feature_dir: Path, record: dict[str, Any] | None = None,
                     assume_approved: bool = False, grounding: dict[str, Any] | None = None) -> Report:
    """Validate a feature. ``record`` replaces the stored delivery record and
    ``assume_approved`` drops the "not approved" reason: ``ready check`` shows the
    readiness the batch will have once approved, before anything is written."""
    rpath = core.record_path(root, feature_dir.name)
    if record is None:
        record = core.load_record(rpath)
    d = derive(root, feature_dir)
    spec_path = feature_dir / "spec.md"
    spec = core.parse_spec(spec_path) if spec_path.is_file() else None
    findings = check_structure(d)
    if spec is None:
        findings.append(Finding("warning", "spec-missing", f"{d.feature}/spec.md not found"))

    rec_feature = record.get("feature")
    if rec_feature and rec_feature != d.feature:
        findings.append(Finding("error", "record-feature-mismatch",
                                f"{rpath} belongs to {rec_feature}, not {d.feature}"))

    drift, drifted = check_drift(d, spec, (record.get("approval") or {}).get("baseline") or {})
    findings += drift

    entries = record.get("pieces") or {}
    keys = {p.key for p in d.pieces}
    for k in entries:
        if k not in keys:
            findings.append(Finding("error", "unknown-piece",
                                    f"delivery record has piece {k!r}, which tasks.md no longer derives", piece=k))
    for p in d.pieces:
        entry = entries.get(p.key) or {}
        if entry.get("quality_bar"):
            try:
                quality_bar(root, entry)
            except core.NightshiftError as exc:
                findings.append(Finding("error", "quality-bar", str(exc), piece=p.key))
    remap = any(f.code == "remap-required" for f in findings)
    readiness = compute_readiness(d, spec, record, drifted, remap, assume_approved, grounding)
    return Report(d, spec, rpath, record, findings, readiness)


# ---------------------------------------------------------------------------
# The frozen bar (design §6.2 step 1, P7): what the critic judges, quoted verbatim
# ---------------------------------------------------------------------------


GOAL_LABELS = ("Purpose", "Checkpoint")


QUALITY_REF = "quality-bar"


def quality_bar(root: Path, entry: dict[str, Any]) -> str | None:
    """A piece's optional explicit quality bar (P4 gauntlet style): the delivery record's
    ``quality_bar``, either the rubric text itself or a file under ``.specify/delivery/``
    holding it. The run contract lists it, so Kasper's approval covers it, and
    ``.specify/delivery/**`` is a default gate path, so a builder edit fails
    postconditions (mechanical). None when the piece has none (goal style)."""
    raw = entry.get("quality_bar")
    if not raw:
        return None
    if not isinstance(raw, str):
        raise core.NightshiftError("quality_bar must be text or a path under .specify/delivery/")
    raw = raw.strip()
    if raw.startswith(".specify/delivery/") and "\n" not in raw:
        path = (root / raw).resolve()
        if not path.is_relative_to((root / ".specify" / "delivery").resolve()) or not path.is_file():
            raise core.NightshiftError(f"quality_bar file {raw} not found under .specify/delivery/")
        return path.read_text(encoding="utf-8").strip()
    return raw


def freeze_bar(root: Path, fdir: Path, key: str, loop: str) -> dict[str, Any]:
    """The bar a piece's critic judges: its acceptance criteria verbatim, plus its
    approved quality bar as one more criterion (``quality-bar``) where it has one."""
    bar = _criteria_bar(root, fdir, key, loop)
    entry = ((core.load_record(core.record_path(root, fdir.name)).get("pieces") or {}).get(key) or {})
    text = quality_bar(root, entry)
    if text:
        bar["scenarios"].append({"ref": QUALITY_REF, "text": text, "source": entry["quality_bar"].strip()})
    return bar


def traced(task: core.Task, spec: core.SpecDoc | None) -> bool:
    """A converge task the run may build (D-3'): tagged ``missing``, ``partial`` or
    ``contradicts`` with every ref an acceptance scenario or requirement of ``spec.md``.
    Everything else, every ``unrequested`` task included, is a product decision."""
    if task.gap_type not in ("missing", "partial", "contradicts") or not task.source_refs or spec is None:
        return False
    known = {s.ref for s in spec.scenarios} | set(spec.requirements)
    return all(r in known for r in task.source_refs)


def converge_split(piece: Piece, spec: core.SpecDoc | None) -> tuple[list[core.Task], list[core.Task]]:
    """(traced, untraced) open tasks of a Convergence piece."""
    open_tasks = [t for t in piece.tasks if not t.done]
    return [t for t in open_tasks if traced(t, spec)], [t for t in open_tasks if not traced(t, spec)]


def excluded_tasks(root: Path, fdir: Path, key: str) -> set[str]:
    """Task ids of ``key`` its builder may not tick: a Convergence piece's untraced tasks."""
    piece = next((p for p in derive(root, fdir).pieces if p.key == key), None)
    if piece is None or piece.kind != "convergence":
        return set()
    spec = core.parse_spec(fdir / "spec.md") if (fdir / "spec.md").is_file() else None
    return {t.id for t in piece.tasks if not traced(t, spec)}


def _criteria_bar(root: Path, fdir: Path, key: str, loop: str) -> dict[str, Any]:
    d = derive(root, fdir)
    piece = next((p for p in d.pieces if p.key == key), None)
    spec_path = fdir / "spec.md"
    spec = core.parse_spec(spec_path) if spec_path.is_file() else None
    if piece is None:
        raise core.NightshiftError(f"piece {key!r} not found in {d.feature}/tasks.md")
    if piece.kind == "convergence":
        # The cited criteria and requirements of its traced tasks, verbatim (D-3').
        refs = list(dict.fromkeys(r for t in converge_split(piece, spec)[0] for r in t.source_refs))
        by_ref = {s.ref: s.text for s in (spec.scenarios if spec else [])}
        return {"feature": d.feature, "piece": key, "story": "", "loop": loop, "independent_test": "",
                "scenarios": [{"ref": r, "text": by_ref.get(r) or core.requirement_text(spec_path, r)} for r in refs]}
    scenarios: list[dict[str, str]] = []
    independent = piece.labels.get("Independent Test", "")
    if spec is not None and piece.story:
        independent = spec.stories.get(piece.story, {}).get("independent_test", "") or independent
        scenarios = [{"ref": s.ref, "text": s.text} for s in spec.scenarios if s.story == piece.story]
    if not scenarios and not independent:
        # A Setup/Foundational piece has no story scenarios: its bar is the phase's own
        # goal labels from tasks.md, quoted verbatim, so the critic judges something
        # real instead of inventing a ref (D23).
        scenarios = [{"ref": f"{key}/{label}", "text": piece.labels[label]}
                     for label in GOAL_LABELS if piece.labels.get(label)]
    return {"feature": d.feature, "piece": key, "story": piece.story, "loop": loop,
            "independent_test": independent, "scenarios": scenarios}


def bar_markdown(bar: dict[str, Any]) -> str:
    lines = []
    if str(bar.get("piece", "")).startswith("convergence-"):
        lines.append("Convergence gaps found by /speckit-converge: each change must trace to one of these "
                     "lines of spec.md; a change the lines below do not ask for fails its criterion.")
    if bar.get("independent_test"):
        lines.append(f"Independent Test: {bar['independent_test']}")
    lines += [f"- {s['ref']}: {s['text']}" for s in bar.get("scenarios", []) if s["ref"] != QUALITY_REF]
    lines += [f"\nQuality bar (`{QUALITY_REF}`, approved for this piece; it passes only if the work meets "
              f"this standard, judged strictly):\n\n{s['text']}" for s in bar.get("scenarios", []) if s["ref"] == QUALITY_REF]
    return "\n".join(lines) or "(no criteria listed; `criteria` must be `[]`; judge against the tasks and checks)"
