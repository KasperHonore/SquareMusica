"""Project configuration for the delivery scripts (``nightshift-config.yml``).

Lookup order: ``--config PATH``, then
``.specify/extensions/nightshift/nightshift-config.yml``, then
``nightshift-config.yml`` at the repository root, then built-in defaults.

The configuration is always read from the controlling checkout, never from a
builder's worktree, so a builder cannot change the checks that judge it. Gate
integrity (postconditions) additionally fails any edit to the config itself.
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path
from typing import Any

import nightshift_core as core

DEFAULT_TIMEOUT = 600  # seconds per check
DEFAULT_GATE_PATHS = [
    "Makefile",
    ".github/workflows/**",
    "nightshift-config.yml",
    ".specify/extensions/nightshift/**",
    ".specify/delivery/**",
]
DEFAULTS: dict[str, Any] = {
    "max_rounds": 3,
    "wall_clock": "8h",
    "phase_budget": "2h",
    "review_budget": "1h",
    "checks": [],
    "preview": {"command": [], "health_url": "", "health_timeout": 30},
    "cli": {"builder": "claude", "critic": "claude"},
    "gate_paths": DEFAULT_GATE_PATHS,
    # Free space (MB) preflight wants in the checks' temp dir and the repo's filesystem:
    # below ``warn`` a warning, below ``refuse`` a refusal (D23: a full /tmp).
    # ``probe``: MB actually written (then deleted) in each place, because a user quota
    # (tmpfs ``usrquota``, EDQUOT) is invisible to statvfs (1.1.3, L1 phase D). 0: off.
    "min_free_mb": {"warn": 1536, "refuse": 500, "probe": 32},
    # D-CIWAIT: before merging a phase PR, wait for the repository's own GitHub checks.
    "ci": {"require": True, "wait_timeout": "30m", "poll_interval": "30s"},
}


def config_path(root: Path, explicit: str | None = None) -> Path | None:
    if explicit:
        path = Path(explicit)
        path = path if path.is_absolute() else root / path
        if not path.is_file():
            raise core.NightshiftError(f"config file not found: {path}")
        return path
    for cand in (root / ".specify" / "extensions" / "nightshift" / "nightshift-config.yml",
                 root / "nightshift-config.yml"):
        if cand.is_file():
            return cand
    return None


def _checks(raw: Any, source: str) -> list[dict[str, Any]]:
    if raw in (None, ""):
        return []
    if not isinstance(raw, list):
        raise core.NightshiftError(f"{source}: checks must be a list")
    out: list[dict[str, Any]] = []
    for i, item in enumerate(raw, 1):
        if isinstance(item, list):
            argv, cid, timeout = item, f"check-{i}", DEFAULT_TIMEOUT
        elif isinstance(item, dict):
            argv = item.get("argv")
            cid = str(item.get("id") or f"check-{i}")
            timeout = item.get("timeout", DEFAULT_TIMEOUT)
        else:
            raise core.NightshiftError(f"{source}: checks[{i}] must be an argv list or a mapping with argv")
        if not isinstance(argv, list) or not argv or not all(isinstance(a, (str, int, float)) for a in argv):
            raise core.NightshiftError(f"{source}: checks[{i}] needs a non-empty argv list")
        if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or timeout <= 0:
            raise core.NightshiftError(f"{source}: checks[{i}] timeout must be a positive number of seconds")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", cid):
            raise core.NightshiftError(f"{source}: check id {cid!r} may only use letters, digits, _ . -")
        if any(c["id"] == cid for c in out):
            raise core.NightshiftError(f"{source}: duplicate check id {cid!r}")
        out.append({"id": cid, "argv": [str(a) for a in argv], "timeout": timeout})
    return out


def load(root: Path, explicit: str | None = None) -> dict[str, Any]:
    """The effective configuration, normalised; ``source`` names the file or ``defaults``."""
    path = config_path(root, explicit)
    data: dict[str, Any] = {}
    if path is not None:
        loaded = core.yaml_load(path.read_text(encoding="utf-8"), str(path))
        if loaded is None:
            loaded = {}
        if not isinstance(loaded, dict):
            raise core.NightshiftError(f"{path}: configuration must be a mapping")
        data = loaded
    source = str(path) if path else "defaults"
    preview = {**DEFAULTS["preview"], **(data.get("preview") or {})}
    cmd = preview.get("command") or []
    if isinstance(cmd, str):
        cmd = cmd.split()
    preview["command"] = [str(a) for a in cmd]
    ht = preview.get("health_timeout", 30)
    if not isinstance(ht, (int, float)) or isinstance(ht, bool) or ht <= 0:
        raise core.NightshiftError(f"{source}: preview.health_timeout must be a positive number of seconds")
    preview["health_timeout"] = ht
    cli = {**DEFAULTS["cli"], **(data.get("cli") or {})}
    gates = data.get("gate_paths")
    if gates is None:
        gates = list(DEFAULT_GATE_PATHS)
    if not isinstance(gates, list) or not all(isinstance(g, str) for g in gates):
        raise core.NightshiftError(f"{source}: gate_paths must be a list of globs")
    free = data.get("min_free_mb")
    if free is None:
        free = dict(DEFAULTS["min_free_mb"])
    elif isinstance(free, (int, float)) and not isinstance(free, bool):
        free = {**DEFAULTS["min_free_mb"], "warn": max(float(free), DEFAULTS["min_free_mb"]["warn"]),
                "refuse": float(free)}
    elif isinstance(free, dict):
        free = {**DEFAULTS["min_free_mb"], **free}
    else:
        raise core.NightshiftError(f"{source}: min_free_mb must be a number or {{warn, refuse}}")
    if not all(isinstance(free[k], (int, float)) and not isinstance(free[k], bool) and free[k] >= 0
               for k in ("warn", "refuse", "probe")):
        raise core.NightshiftError(f"{source}: min_free_mb warn, refuse and probe must be numbers of MB")
    return {
        "source": source,
        "min_free_mb": {"warn": free["warn"], "refuse": free["refuse"], "probe": free["probe"]},
        "max_rounds": data.get("max_rounds", DEFAULTS["max_rounds"]),
        "wall_clock": data.get("wall_clock", DEFAULTS["wall_clock"]),
        "phase_budget": data.get("phase_budget", DEFAULTS["phase_budget"]),
        "review_budget": data.get("review_budget", DEFAULTS["review_budget"]),
        "checks": _checks(data.get("checks"), source),
        "preview": preview,
        "cli": cli,
        "gate_paths": gates,
        "base_branch": data.get("base_branch"),
        "ci": {**DEFAULTS["ci"], **(data.get("ci") or {})},
    }


def cli_executable(value: Any) -> str:
    """First word of a configured agent CLI (a string or an argv list)."""
    if isinstance(value, list):
        return str(value[0]) if value else ""
    return str(value or "").split()[0] if str(value or "").strip() else ""


def resolve_executable(argv0: str, cwd: Path) -> str | None:
    """Absolute path of ``argv0`` (PATH lookup, or relative to ``cwd`` when it has a slash)."""
    if not argv0:
        return None
    if "/" in argv0:
        p = Path(argv0)
        p = p if p.is_absolute() else cwd / p
        return str(p) if p.is_file() and os.access(p, os.X_OK) else None
    return shutil.which(argv0)


# ---------------------------------------------------------------------------
# Globs with ** (gate paths, protected paths)
# ---------------------------------------------------------------------------

_GLOB_CACHE: dict[str, re.Pattern] = {}


def glob_regex(pattern: str) -> re.Pattern:
    """``**`` spans directories, ``*`` and ``?`` stay inside one path segment."""
    if pattern in _GLOB_CACHE:
        return _GLOB_CACHE[pattern]
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    rx = re.compile("".join(out) + r"\Z")
    _GLOB_CACHE[pattern] = rx
    return rx


def matches_any(path: str, patterns: list[str]) -> bool:
    return any(glob_regex(p.rstrip("/") + ("/**" if p.endswith("/") else "")).match(path) for p in patterns)
