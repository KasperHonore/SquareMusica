"""Shared logic for the Spec Kit Nightshift scripts.

Standard library only (D-LANG). Nothing in this module writes ``spec.md``,
``plan.md`` or ``tasks.md``; the only files it writes are the delivery record
and the files under ``.specify/delivery/<feature>/`` (design §4).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# The extension version; keep equal to ``extension.version`` in extension.yml
# (tests/test_version.py). Bump both on every change a consumer should pick up.
VERSION = "2.0.3"
SCHEMA_VERSION = 1
MARKER_PREFIX = "speckit-nightshift:"


class NightshiftError(Exception):
    """A fatal problem the user must fix; scripts exit 1 with this message."""


class UsageLimit(NightshiftError):
    """A role call hit the Claude plan's usage limit (spike S-7). Not a verdict on the
    work: scripts exit 4 and leave the piece's sub-statuses as they were; the
    orchestrator stops the run with ``budget_exhausted`` and resumes after the reset."""

    exit_code = 4


# ---------------------------------------------------------------------------
# Credentials (spike S-7 token audit)
#
# Only a Claude Code role process may see Claude credentials. ``run_main`` moves them
# out of ``os.environ`` before a script does anything, so every child it starts (git,
# gh, checks, preview, capture commands) inherits an environment without them;
# ``claude_env`` hands them back to a ``claude`` role call only. Mechanical for the
# environment; not a boundary against a child reading credential files on disk.
# ---------------------------------------------------------------------------

CREDENTIAL_NAMES = frozenset({"CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"})
_CREDENTIAL_RE = re.compile(r"^(?:CLAUDE|ANTHROPIC)_\w*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|HEADERS)\w*$")
_quarantined: dict[str, str] = {}


def is_credential_var(name: str) -> bool:
    return name in CREDENTIAL_NAMES or bool(_CREDENTIAL_RE.match(name))


def quarantine_credentials() -> list[str]:
    """Move Claude credential variables out of ``os.environ`` (kept for ``claude_env``)."""
    names = [k for k in os.environ if is_credential_var(k)]
    for k in names:
        _quarantined[k] = os.environ.pop(k)
    return names


def tool_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """The environment for any child that is not a Claude Code role call."""
    env = {k: v for k, v in os.environ.items() if not is_credential_var(k)}
    env.update(extra or {})
    return env


def claude_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """The environment for a Claude Code role call: ``tool_env`` plus the credentials."""
    env = tool_env()
    env.update(_quarantined)
    env.update({k: v for k, v in os.environ.items() if is_credential_var(k)})
    env.update(extra or {})
    return env


# ---------------------------------------------------------------------------
# YAML subset
#
# Spec Kit scripts may not rely on PyYAML being importable, so Nightshift reads
# and writes a documented subset: block mappings, block sequences (of scalars
# or mappings), plain/double-quoted/single-quoted scalars, flow sequences of
# scalars (``[a, b]``), ``{}``/``[]`` and ``#`` comments. No anchors, tags or
# multi-line block scalars. Anything outside the subset is an error, never a
# silent misread.
# ---------------------------------------------------------------------------

_PLAIN_SAFE = re.compile(r"^[A-Za-z0-9_./@+~-][A-Za-z0-9 _./@+~()=,'-]*$")
_RESERVED = {"true", "false", "yes", "no", "on", "off", "null", "~", ""}


def _strip_comment(line: str) -> str:
    out = []
    quote = None
    prev = " "
    for ch in line:
        if quote:
            out.append(ch)
            if ch == quote and prev != "\\":
                quote = None
        elif ch in "\"'" and (not out or out[-1] in " [:,-" or prev in " [,"):
            quote = ch
            out.append(ch)
        elif ch == "#" and prev in " \t":
            break
        else:
            out.append(ch)
        prev = ch
    return "".join(out).rstrip()


def _split_flow(inner: str) -> list[str]:
    parts, buf, quote = [], [], None
    for ch in inner:
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
            buf.append(ch)
        elif ch == ",":
            parts.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    if "".join(buf).strip():
        parts.append("".join(buf).strip())
    return parts


def _scalar(text: str, where: str) -> Any:
    text = text.strip()
    if text.startswith('"'):
        if not text.endswith('"') or len(text) < 2:
            raise NightshiftError(f"{where}: unterminated double-quoted string")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise NightshiftError(f"{where}: bad double-quoted string ({exc})") from exc
    if text.startswith("'"):
        if not text.endswith("'") or len(text) < 2:
            raise NightshiftError(f"{where}: unterminated single-quoted string")
        return text[1:-1].replace("''", "'")
    if text.startswith("["):
        if not text.endswith("]"):
            raise NightshiftError(f"{where}: unterminated flow sequence")
        return [_scalar(p, where) for p in _split_flow(text[1:-1])]
    if text == "{}":
        return {}
    if text.startswith("{"):
        raise NightshiftError(f"{where}: flow mappings ({{...}}) are not supported; "
                              "write the mapping in block style, one key per line")
    if text.startswith(("&", "*", "!", "|", ">")):
        raise NightshiftError(f"{where}: unsupported YAML construct {text[:1]!r}")
    low = text.lower()
    if low in ("null", "~", ""):
        return None
    if low == "true":
        return True
    if low == "false":
        return False
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    if re.fullmatch(r"-?\d+\.\d+", text):
        return float(text)
    return text


_KEY_RE = re.compile(r'^(?P<key>"(?:[^"\\]|\\.)*"|[^\s"\'#:][^:#]*?)\s*:(?:\s+(?P<val>.*)|$)')


def yaml_load(text: str, source: str = "<yaml>") -> Any:
    lines: list[tuple[int, int, str]] = []
    for no, raw in enumerate(text.splitlines(), 1):
        if "\t" in raw[: len(raw) - len(raw.lstrip())]:
            raise NightshiftError(f"{source}:{no}: tabs are not allowed for indentation")
        stripped = _strip_comment(raw)
        if not stripped.strip() or stripped.strip() in ("---", "..."):
            continue
        lines.append((no, len(stripped) - len(stripped.lstrip()), stripped.strip()))
    if not lines:
        return {}
    value, pos = _parse_block(lines, 0, lines[0][1], source)
    if pos != len(lines):
        no = lines[pos][0]
        raise NightshiftError(f"{source}:{no}: unexpected indentation")
    return value


def _parse_block(lines, pos, indent, source):
    if lines[pos][2] == "-" or lines[pos][2].startswith("- "):
        return _parse_seq(lines, pos, indent, source)
    return _parse_map(lines, pos, indent, source)


def _parse_map(lines, pos, indent, source):
    result: dict[str, Any] = {}
    while pos < len(lines):
        no, ind, content = lines[pos]
        if ind < indent:
            break
        if ind > indent:
            raise NightshiftError(f"{source}:{no}: unexpected indentation")
        if content == "-" or content.startswith("- "):
            break
        m = _KEY_RE.match(content)
        if not m or m.group("key").startswith("{"):
            raise NightshiftError(f"{source}:{no}: expected 'key: value' (flow mappings are not supported)")
        key = m.group("key")
        key = json.loads(key) if key.startswith('"') else key.strip()
        if key in result:
            raise NightshiftError(f"{source}:{no}: duplicate key {key!r}")
        val = m.group("val")
        pos += 1
        if val is None or val == "":
            if pos < len(lines) and lines[pos][1] > indent:
                result[key], pos = _parse_block(lines, pos, lines[pos][1], source)
            elif pos < len(lines) and lines[pos][1] == indent and (
                lines[pos][2] == "-" or lines[pos][2].startswith("- ")
            ):
                result[key], pos = _parse_seq(lines, pos, indent, source)
            else:
                result[key] = None
        else:
            result[key] = _scalar(val, f"{source}:{no}")
    return result, pos


def _parse_seq(lines, pos, indent, source):
    result: list[Any] = []
    while pos < len(lines):
        no, ind, content = lines[pos]
        if ind < indent or not (content == "-" or content.startswith("- ")):
            if ind > indent:
                raise NightshiftError(f"{source}:{no}: unexpected indentation")
            break
        if ind > indent:
            raise NightshiftError(f"{source}:{no}: unexpected indentation")
        rest = content[1:].strip()
        if not rest:
            pos += 1
            if pos < len(lines) and lines[pos][1] > indent:
                item, pos = _parse_block(lines, pos, lines[pos][1], source)
            else:
                item = None
            result.append(item)
            continue
        if rest.startswith("{") and rest != "{}":
            raise NightshiftError(f"{source}:{no}: flow mappings ({{...}}) are not supported; "
                                  "write the mapping in block style, one key per line")
        if _KEY_RE.match(rest) and not rest.startswith(("[", '"', "'")):
            # "- key: value" starts a mapping whose keys sit at the column of "key".
            col = ind + (len(content) - len(rest))
            sub = [(no, col, rest)]
            j = pos + 1
            while j < len(lines) and lines[j][1] > ind:
                sub.append(lines[j])
                j += 1
            item, used = _parse_map(sub, 0, col, source)
            if used != len(sub):
                raise NightshiftError(f"{source}:{sub[used][0]}: unexpected indentation")
            result.append(item)
            pos = j
            continue
        result.append(_scalar(rest, f"{source}:{no}"))
        pos += 1
    return result, pos


def _fmt_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return repr(value)
    text = str(value)
    if (
        _PLAIN_SAFE.match(text)
        and text.lower() not in _RESERVED
        and not re.fullmatch(r"-?\d+(\.\d+)?", text)
        and text == text.strip()
    ):
        return text
    return json.dumps(text, ensure_ascii=False)


def yaml_dump(value: Any, indent: int = 0) -> str:
    pad = " " * indent
    out: list[str] = []
    if isinstance(value, dict):
        for key, val in value.items():
            k = _fmt_scalar(key)
            if isinstance(val, dict) and val:
                out.append(f"{pad}{k}:")
                out.append(yaml_dump(val, indent + 2))
            elif isinstance(val, list) and val:
                out.append(f"{pad}{k}:")
                out.append(yaml_dump(val, indent + 2))
            elif isinstance(val, dict):
                out.append(f"{pad}{k}: {{}}")
            elif isinstance(val, list):
                out.append(f"{pad}{k}: []")
            else:
                out.append(f"{pad}{k}: {_fmt_scalar(val)}")
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, dict) and item:
                body = yaml_dump(item, indent + 2).splitlines()
                out.append(f"{pad}- {body[0].lstrip()}")
                out.extend(body[1:])
            elif isinstance(item, (dict, list)) and not item:
                out.append(f"{pad}- {'{}' if isinstance(item, dict) else '[]'}")
            elif isinstance(item, list):
                out.append(f"{pad}-")
                out.append(yaml_dump(item, indent + 2))
            else:
                out.append(f"{pad}- {_fmt_scalar(item)}")
    else:
        out.append(f"{pad}{_fmt_scalar(value)}")
    return "\n".join(line for line in out if line != "")


# ---------------------------------------------------------------------------
# Hashing and identity
# ---------------------------------------------------------------------------


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def fingerprint(description: str) -> str:
    """Hash of a task description, whitespace-normalised (design §4).

    The caller passes the description with the checkbox, task ID and the
    ``[P]``/``[US#]`` markers already removed, so ticking a box or changing a
    scheduling marker never changes the fingerprint.
    """
    return sha256_text(" ".join(description.split()))[:16]


def task_ref(feature: str, task_id: str) -> str:
    return f"{feature}#{task_id}"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# tasks.md
# ---------------------------------------------------------------------------

PHASE_RE = re.compile(r"^##\s+Phase\s+(?P<num>\d+)\s*:\s*(?P<title>.+?)\s*$")
H2_RE = re.compile(r"^##\s+(?!#)")
TASK_RE = re.compile(
    r"^\s*[-*]\s+\[(?P<check>[ xX])\]\s+(?P<id>T\d{3,}[a-z]?)(?=\s|$)(?P<rest>.*)$"
)
MARKER_RE = re.compile(r"^\s*\[(?P<m>P|US\d+)\]")
# Converge's tag: `per <ref list> (<gap-type>)`. Converge's template puts it at end of
# line, but real /speckit-converge output (Spec Kit 838f1184, live D23/D23b) also places
# it mid-line, capitalised, with several refs separated by `,` or `/`, and with
# non-requirement refs: "... per FR-027d (partial): add ...", "Per FR-027b, SC-006b
# (partial)", "per FR-027, Constitution IV (missing)", "per FR-027d/FR-024a: add ...
# (partial)". parse_converge_tag() takes the LAST gap type and the last `per ` before it.
CONVERGE_GAP_RE = re.compile(r"\((?P<gap>missing|partial|contradicts|unrequested)\)")
CONVERGE_PER_RE = re.compile(r"\b[Pp]er\s+")
ACC_REF = r"US\d+/AC\d+"
_ID_RE = re.compile(rf"^(?:{ACC_REF}|(?:FR|SC)-\d{{3,}}[a-z]?)$")
_ID_START_RE = re.compile(rf"^(?:US\d+/AC\d+|US\d+\b|(?:FR|SC)-\d)")
_OTHER_REF_RE = re.compile(r"^[A-Za-z][\w .:'-]{0,60}$")
_STRICT_LIST_RE = re.compile(
    rf"\b[Pp]er\s+(?P<ref>(?:{ACC_REF}|(?:FR|SC)-\d{{3,}}[a-z]?)"
    rf"(?:\s*[,/]\s*(?:{ACC_REF}|(?:FR|SC)-\d{{3,}}[a-z]?))*)(?![\w/-])"
)


def split_refs(text: str) -> list[str] | None:
    """The refs of a tag's ref list, split on `,` and `/` (never inside ``USn/ACm``).

    None when the text is not a ref list: an empty part, a part that starts like a
    requirement id but is not exactly one ("FR-027d: add ..."), or free prose.
    """
    out: list[str] = []
    for part in text.split(","):
        for ref in re.split(r"\s*/\s*(?!AC\d)", part.strip()):
            ref = ref.strip()
            if not ref:
                return None
            if _ID_START_RE.match(ref):
                if not _ID_RE.match(ref):
                    return None
            elif not _OTHER_REF_RE.match(ref) or len(ref.split()) > 6:
                return None
            out.append(ref)
    return out


def parse_converge_tag(desc: str) -> tuple[list[str], str]:
    """(refs, gap type) of a task description's converge tag; ([], "") without one.

    The gap type is the last ``(missing|partial|contradicts|unrequested)``. The ref list
    is everything between the last ``per `` before it and `` (``, split on `,` and `/`.
    If that span is not a clean ref list (converge wrote prose between the refs and the
    gap type: "per FR-027d/FR-024a: add ... (partial)"), the refs are the last run of
    requirement/acceptance ids directly after a ``per `` before the gap type.
    """
    gm = None
    for gm in CONVERGE_GAP_RE.finditer(desc):
        pass
    if gm is None:
        return [], ""
    prefix = desc[:gm.start()]
    pm = None
    for pm in CONVERGE_PER_RE.finditer(prefix):
        pass
    if pm is not None:
        refs = split_refs(prefix[pm.end():].rstrip())
        if refs:
            return refs, gm.group("gap")
    sm = None
    for sm in _STRICT_LIST_RE.finditer(prefix):
        pass
    if sm is not None:
        return split_refs(sm.group("ref")) or [], gm.group("gap")
    return [], ""


LABEL_RE = re.compile(r"^\*\*(?P<label>[^*]+)\*\*:\s*(?P<text>.*)$")
STORY_TITLE_RE = re.compile(r"User Story\s+(?P<n>\d+)\b", re.IGNORECASE)


@dataclass
class Task:
    id: str
    line: int
    done: bool
    parallel: bool
    story: str  # "US1" or ""
    description: str
    fp: str
    phase: int | None
    source_ref: str = ""  # the tag's refs, comma-joined ("FR-027b, SC-006b", "FR-027, Constitution IV")
    gap_type: str = ""
    source_refs: list[str] = field(default_factory=list)  # each ref of the tag


@dataclass
class Phase:
    number: int
    title: str
    line: int
    kind: str  # setup | foundational | story | polish | convergence | module
    story: str = ""
    labels: dict[str, str] = field(default_factory=dict)
    tasks: list[Task] = field(default_factory=list)


@dataclass
class TasksDoc:
    path: Path
    phases: list[Phase]
    tasks: list[Task]
    stray: list[Task]  # task lines outside any phase
    deps_bullets: list[tuple[int, str, str]]  # (line, subject, text)


def phase_kind(title: str) -> tuple[str, str]:
    low = title.lower()
    m = STORY_TITLE_RE.search(title)
    if m:
        return "story", f"US{int(m.group('n'))}"
    if low.startswith("setup"):
        return "setup", ""
    if low.startswith("foundational") or low.startswith("foundation"):
        return "foundational", ""
    if low.startswith("polish"):
        return "polish", ""
    if low.startswith("convergence"):
        return "convergence", ""
    return "module", ""


def parse_task_rest(rest: str) -> tuple[bool, str, str]:
    parallel = False
    story = ""
    while True:
        m = MARKER_RE.match(rest)
        if not m:
            break
        if m.group("m") == "P":
            parallel = True
        else:
            story = m.group("m")
        rest = rest[m.end():]
    return parallel, story, rest.strip()


def parse_tasks(path: Path) -> TasksDoc:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise NightshiftError(f"cannot read {path}: {exc}") from exc
    return parse_tasks_text(text, path)


def parse_tasks_text(text: str, path: Path) -> TasksDoc:
    """Parse tasks.md content (e.g. from ``git show <sha>:path``); ``path`` is for reference only."""
    phases: list[Phase] = []
    tasks: list[Task] = []
    stray: list[Task] = []
    deps: list[tuple[int, str, str]] = []
    current: Phase | None = None
    in_deps = False
    in_comment = False
    for no, line in enumerate(text.splitlines(), 1):
        if in_comment:
            if "-->" in line:
                in_comment = False
            continue
        if line.lstrip().startswith("<!--") and "-->" not in line:
            in_comment = True
            continue
        pm = PHASE_RE.match(line)
        if pm:
            kind, story = phase_kind(pm.group("title"))
            current = Phase(int(pm.group("num")), pm.group("title"), no, kind, story)
            phases.append(current)
            in_deps = False
            continue
        if H2_RE.match(line):
            current = None
            in_deps = "dependencies" in line.lower()
            continue
        tm = TASK_RE.match(line)
        if tm:
            parallel, story, desc = parse_task_rest(tm.group("rest"))
            refs, gap = parse_converge_tag(desc)
            task = Task(
                id=tm.group("id"),
                line=no,
                done=tm.group("check") in "xX",
                parallel=parallel,
                story=story,
                description=desc,
                fp=fingerprint(desc),
                phase=current.number if current else None,
                source_ref=", ".join(refs),
                gap_type=gap,
                source_refs=refs,
            )
            if current is None:
                stray.append(task)
            else:
                current.tasks.append(task)
            tasks.append(task)
            continue
        if current is not None:
            lm = LABEL_RE.match(line.strip())
            if lm:
                current.labels.setdefault(lm.group("label").strip(), lm.group("text").strip())
        elif in_deps:
            bm = re.match(r"^\s*[-*]\s+\*\*(?P<subj>[^*]+)\*\*\s*:\s*(?P<text>.*)$", line)
            if bm:
                deps.append((no, bm.group("subj").strip(), bm.group("text").strip()))
    return TasksDoc(path, phases, tasks, stray, deps)


# ---------------------------------------------------------------------------
# spec.md
# ---------------------------------------------------------------------------

SPEC_TITLE_RE = re.compile(r"^#\s+Feature Specification:\s*(?P<t>.+?)\s*$")
# A requirement id: FR-004, SC-012, and the letter-suffixed ids clarify inserts
# between existing ones (FR-027d, SC-006b; live D23).
REQ_ID = r"(?:FR|SC)-\d{3,}[a-z]?"
SPEC_STORY_RE = re.compile(
    r"^###\s+User Story\s+(?P<n>\d+)\s*[-–—:]\s*(?P<title>.+?)(?:\s*\(Priority:\s*(?P<prio>P\d+)\))?\s*(?:🎯.*)?$"
)
CLARIFY_RE = re.compile(r"\[NEEDS CLARIFICATION[^\]]*\]")


@dataclass
class Scenario:
    ref: str  # "US1/AC2"
    story: str
    text: str
    hash: str
    line: int


@dataclass
class Clarification:
    line: int
    story: str  # "" when outside any user story section
    text: str
    in_log: bool = False  # inside the "## Clarifications" log that /speckit-clarify keeps


# The session log /speckit-clarify writes (spec-kit 838f1184,
# templates/commands/clarify.md:185-187: "## Clarifications", "### Session YYYY-MM-DD",
# "- Q: <question> → A: <answer>"; source-inspected).
CLARIFY_LOG_RE = re.compile(r"^##\s+Clarifications\s*$")


def marker_key(marker: str) -> str:
    """A ``[NEEDS CLARIFICATION: …]`` marker's question, whitespace- and case-normalised."""
    body = re.sub(r"^\[NEEDS CLARIFICATION:?", "", marker.strip()).rstrip("]")
    return " ".join(body.split()).lower()


def open_questions(clar: list[Clarification]) -> list[Clarification]:
    """Open questions that count for readiness. A marker in the Clarifications log whose
    question also sits inside a user story belongs to that story (live L1 1.1.0, phase A
    finding 1); a log-only marker stays feature-wide (the safe default)."""
    in_story = {marker_key(c.text) for c in clar if c.story}
    return [c for c in clar if not (c.in_log and not c.story and marker_key(c.text) in in_story)]


@dataclass
class SpecDoc:
    path: Path
    title: str
    stories: dict[str, dict[str, str]]  # "US1" -> {title, priority, independent_test}
    scenarios: list[Scenario]
    clarifications: list[Clarification]
    requirements: list[str]


def requirement_text(spec_path: Path, ref: str) -> str:
    """The line of spec.md that defines ``FR-###`` / ``SC-###``, verbatim (``ref`` if none)."""
    for line in spec_path.read_text(encoding="utf-8").splitlines():
        m = re.match(rf"^\s*[-*]\s+\*\*{re.escape(ref)}\*\*:\s*(.+?)\s*$", line)
        if m:
            return m.group(1)
    return ref


def _strip_html_comments(text: str) -> str:
    # Keep line numbers stable by replacing comment bodies with newlines only.
    return re.sub(r"<!--.*?-->", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)


def parse_spec(path: Path) -> SpecDoc:
    try:
        text = _strip_html_comments(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise NightshiftError(f"cannot read {path}: {exc}") from exc
    title = path.parent.name
    stories: dict[str, dict[str, str]] = {}
    scenarios: list[Scenario] = []
    clar: list[Clarification] = []
    reqs: list[str] = []
    story = ""
    in_scen = False
    in_log = False
    # Text that wraps onto the next lines belongs to the item before it (P7, verbatim):
    # an Independent Test runs to the end of its paragraph, a scenario takes its
    # indented continuation lines. Joined with single spaces; a blank line ends both.
    wrap = ""  # "test", "scenario" or ""
    for no, line in enumerate(text.splitlines(), 1):
        if wrap and line.strip():
            plain = not (re.match(r"^\s*(#|\d+\.\s|[-*]\s)", line) or LABEL_RE.match(line.strip()))
            if wrap == "test" and plain:
                stories[story]["independent_test"] += " " + line.strip()
                continue
            if wrap == "scenario" and plain and line.startswith(" "):
                last = scenarios[-1]
                joined = f"{last.text} {line.strip()}"
                scenarios[-1] = Scenario(last.ref, last.story, joined, sha256_text(joined), last.line)
                continue
        wrap = ""
        if re.match(r"^##\s", line):
            in_log = bool(CLARIFY_LOG_RE.match(line))
        tm = SPEC_TITLE_RE.match(line)
        if tm:
            title = tm.group("t")
            continue
        sm = SPEC_STORY_RE.match(line)
        if sm:
            story = f"US{int(sm.group('n'))}"
            stories[story] = {
                "title": sm.group("title").strip(),
                "priority": sm.group("prio") or "",
                "independent_test": "",
            }
            in_scen = False
            continue
        if re.match(r"^#{1,3}\s", line):
            story = ""
            in_scen = False
        for cm in CLARIFY_RE.finditer(line):
            clar.append(Clarification(no, story, cm.group(0), in_log and not story))
        for rm in re.finditer(rf"\b({REQ_ID})\b", line):
            if rm.group(1) not in reqs:
                reqs.append(rm.group(1))
        if not story:
            continue
        lm = LABEL_RE.match(line.strip())
        if lm:
            label = lm.group("label").strip().lower()
            in_scen = label == "acceptance scenarios"
            if label == "independent test":
                stories[story]["independent_test"] = lm.group("text").strip()
                wrap = "test"
            continue
        if in_scen:
            am = re.match(r"^\s*(\d+)\.\s+(?P<t>.+?)\s*$", line)
            if am:
                n = len([s for s in scenarios if s.story == story]) + 1
                scen_text = am.group("t")
                scenarios.append(
                    Scenario(f"{story}/AC{n}", story, scen_text, sha256_text(scen_text), no)
                )
                wrap = "scenario"
            elif line.strip() and not line.startswith(" "):
                in_scen = False
    return SpecDoc(path, title, stories, scenarios, clar, reqs)


# ---------------------------------------------------------------------------
# Project and feature resolution
# ---------------------------------------------------------------------------


def find_project_root(start: Path | None = None) -> Path:
    raw = os.environ.get("SPECIFY_INIT_DIR", "")
    if raw:
        root = Path(raw).resolve()
        if not (root / ".specify").is_dir():
            raise NightshiftError(f"SPECIFY_INIT_DIR is not a Spec Kit project: {root}")
        return root
    current = (start or Path.cwd()).resolve()
    while True:
        if (current / ".specify").is_dir():
            return _main_checkout(current)
        if current.parent == current:
            raise NightshiftError("not inside a Spec Kit project (no .specify/ directory found)")
        current = current.parent


def _main_checkout(root: Path) -> Path:
    """A Nightshift worktree has its own ``.specify/``; its run state lives in the main
    checkout. Prefer that (D25 finding 4): first by path
    (``<outer>/.nightshift/<run>/worktrees/<piece>``), then, for a linked worktree
    (``.git`` is a file), by ``git rev-parse --git-common-dir`` when that checkout has a
    run whose worktree is this one. ``SPECIFY_INIT_DIR`` overrides both (callers)."""
    parts = root.parts
    if len(parts) >= 4 and parts[-2] == "worktrees" and parts[-4] == ".nightshift":
        outer = root.parents[3]
        if (outer / ".specify").is_dir():
            return outer
    if not (root / ".git").is_file():
        return root
    try:
        out = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=root,
                             capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return root
    common = Path(out.stdout.strip()) if out.returncode == 0 and out.stdout.strip() else None
    if common is None or common.name != ".git":
        return root
    main = common.parent.resolve()
    if main == root or not (main / ".specify").is_dir():
        return root
    for wt in (main / ".nightshift").glob("*/worktrees/*"):
        try:
            if wt.resolve() == root:
                return main
        except OSError:
            continue
    return root


def resolve_feature_dir(root: Path, explicit: str | None = None) -> Path:
    """CLI argument, then SPECIFY_FEATURE_DIRECTORY, then .specify/feature.json.

    Nightshift reads ``feature.json`` but never writes it (design §10).
    """
    raw = explicit or os.environ.get("SPECIFY_FEATURE_DIRECTORY", "")
    if not raw:
        fj = root / ".specify" / "feature.json"
        if fj.is_file():
            try:
                data = json.loads(fj.read_text(encoding="utf-8"))
                raw = data.get("feature_directory", "") if isinstance(data, dict) else ""
            except (OSError, json.JSONDecodeError):
                raw = ""
    if not raw:
        raise NightshiftError(
            "no feature selected: pass --feature, set SPECIFY_FEATURE_DIRECTORY, "
            "or run the Spec Kit specify command"
        )
    path = Path(raw)
    if not path.is_absolute():
        path = root / path
    if not path.is_dir():
        raise NightshiftError(f"feature directory not found: {path}")
    return path.resolve()


def feature_id(root: Path, feature_dir: Path) -> str:
    try:
        return feature_dir.relative_to(root).as_posix()
    except ValueError:
        return feature_dir.as_posix()


def delivery_dir(root: Path) -> Path:
    return root / ".specify" / "delivery"


def record_path(root: Path, name: str) -> Path:
    return delivery_dir(root) / f"{name}.yml"


def assets_dir(root: Path, name: str) -> Path:
    return delivery_dir(root) / name


def load_record(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    data = yaml_load(path.read_text(encoding="utf-8"), str(path))
    if not isinstance(data, dict):
        raise NightshiftError(f"{path}: delivery record must be a mapping")
    return data


def save_record(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "# Spec Kit Nightshift delivery record. Owned by agents working in this repo;\n"
        "# never edited from GitHub. See the nightshift design, section 4.\n"
    )
    tmp = path.with_suffix(".yml.tmp")
    tmp.write_text(header + yaml_dump(data) + "\n", encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------


def extension_root() -> Path:
    # scripts/python/nightshift_core.py -> extension root, both in this repo and
    # when installed at .specify/extensions/nightshift/.
    return Path(__file__).resolve().parents[2]


def template_path(root: Path | None, name: str) -> Path:
    if root is not None:
        override = root / ".specify" / "templates" / "overrides" / name
        if override.is_file():
            return override
    path = extension_root() / "templates" / name
    if not path.is_file():
        raise NightshiftError(f"template not found: {name}")
    return path


def render(template: str, values: dict[str, Any]) -> str:
    def sub(m: re.Match) -> str:
        key = m.group(1)
        if key not in values:
            raise NightshiftError(f"template variable not provided: {key}")
        return str(values[key])

    text = re.sub(r"\{\{\s*([a-z_]+)\s*\}\}", sub, template)
    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"


def parse_duration(value: Any, default: int) -> int:
    """'90s', '45m', '8h' or a number of seconds."""
    if value in (None, ""):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip().lower()
    units = {"s": 1, "m": 60, "h": 3600}
    if text[-1:] in units and text[:-1].replace(".", "", 1).isdigit():
        return int(float(text[:-1]) * units[text[-1]])
    if text.isdigit():
        return int(text)
    raise NightshiftError(f"bad duration {value!r} (use 90s, 45m or 8h)")


def render_template(root: Path | None, name: str, values: dict[str, Any]) -> str:
    return render(template_path(root, name).read_text(encoding="utf-8"), values)


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------


def emit_json(data: Any) -> None:
    sys.stdout.write(json.dumps(data, indent=2, ensure_ascii=True) + "\n")


def test_crash(point: str) -> None:
    """Resume-test hook (D10): SIGKILL this process when ``NIGHTSHIFT_TEST_CRASH``
    equals ``point``. Inert unless that variable is set; never set it in a real run.

    Points: ``after-intent:<kind>`` (the state with a pending ``<kind>`` intent was
    just saved, before the side effect), ``after-spawn:<role>`` (a builder or preview
    process was started and recorded), ``before-done:<kind>`` (the side effect
    happened, its done record is not written yet) and ``after-gh-write`` (a GitHub
    write succeeded, nothing after it ran). ``<point>#<n>`` crashes at the n-th
    occurrence in this process instead of the first.
    """
    want = os.environ.get("NIGHTSHIFT_TEST_CRASH", "")
    name, _, nth = want.partition("#")
    if name != point:
        return
    _crash_seen[point] = _crash_seen.get(point, 0) + 1
    if _crash_seen[point] == int(nth or 1):
        import signal

        sys.stdout.flush()
        os.kill(os.getpid(), signal.SIGKILL)


_crash_seen: dict[str, int] = {}


def run_main(fn) -> None:
    quarantine_credentials()
    try:
        code = fn(sys.argv[1:])
    except UsageLimit as exc:
        print(f"USAGE LIMIT: {exc}", file=sys.stderr)
        code = UsageLimit.exit_code
    except NightshiftError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        code = 1
    raise SystemExit(code)
