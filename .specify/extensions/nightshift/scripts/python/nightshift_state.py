"""Run state and logbook (design §4, §7).

The orchestrating session rereads state before every step and writes it after,
always through this module, so a crash or compaction loses at most one step.
Writes are atomic (temp file + rename). Only the transitions listed in
``TRANSITIONS`` are allowed; ``passed`` is reserved for ``phase_merge``.

Concurrent writers (D23 lost update): pieces may run in parallel, so several scripts
hold a copy of the state at once. Every write goes through an exclusive ``flock`` on
``state.lock``. ``update`` reloads, applies a change and writes under the lock.
``save`` merges: for each top-level key, piece and step it keeps the version on disk
unless the caller changed that entry since its ``load`` (hash recorded in the
in-memory-only ``state["_loaded"]``). Two writers that change the same piece: the last
writer wins for that piece only. Mechanical for every script that writes through here.

Resume-test hook: ``save`` and ``step_complete`` call ``core.test_crash`` so the D10
tests can SIGKILL a script between a step's intent and its done record. It is inert
unless ``NIGHTSHIFT_TEST_CRASH`` is set.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import socket
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import nightshift_core as core

SCHEMA = 1
SUB_STATUSES = ("not_run", "passed", "failed", "rejected", "not_checked")
# One critic per review round (core review stage 3): its outcome is ``verdict``.
SUB_FIELDS = ("builder", "checks", "verdict")
STOP_REASONS = ("awaiting_acceptance", "partial_awaiting_acceptance", "no_ready_work",
                "budget_exhausted", "interrupted", "environment_failure", "safety_stop")
PARK_REASONS = ("max_rounds", "stagnation", "no_progress", "builder_blocked", "gate_tampered",
                "combined_checks_failed", "timeout",
                "checks_failed", "ci_failed", "ci_timeout")
BLOCK_REASONS = ("decision_needed", "clarification", "dependency_blocked", "needs_kasper")
# The unit outcome (D-HONEST), recorded per piece in ``outcome``, separate from ``status``.
# A pass is set only by the script that observed it.
PASS_OUTCOMES = {"completed": "phase_merge"}
ACTIVE = ("building", "checking", "reviewing", "merging")
TRANSITIONS = {
    "pending": {"building", "blocked", "parked"},
    "building": {"checking", "parked", "blocked"},
    "checking": {"building", "reviewing", "parked", "blocked"},
    "reviewing": {"building", "merging", "parked", "blocked"},
    "merging": {"passed", "parked"},
    # Leaving ``parked`` follows Kasper's day actions, never a manual transition (P5):
    # his re-approval (``ready go``) returns it to ``pending`` (``blocker.release_reapproved``,
    # before every pick), and a product question it raised is posted (``blocked``) and
    # answered through ``blocker.py resolve``. ``unpark`` keeps the record (D-HONEST).
    "parked": {"pending", "blocked"},
    "blocked": {"pending"},   # only after the answer is committed (D-GH)
    "passed": set(),
}
# Statuses only one script may set (mechanical for callers of ``transition``).
RESERVED = {"passed": "phase_merge"}


def run_dir(root: Path, name: str) -> Path:
    return root / ".nightshift" / name


def round_findings(p: dict[str, Any]) -> list[dict[str, Any]] | None:
    """The unseen findings ``verdict._build`` handed the current round, or None when the
    state has no record for this round (a run started before 2.0.4)."""
    rec = p.get("round_findings") or {}
    return list(rec.get("findings") or []) if rec.get("round") == p.get("round") else None


def state_path(root: Path, name: str) -> Path:
    return run_dir(root, name) / "state.json"


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def inputs_hash(inputs: Any) -> str:
    return hashlib.sha256(json.dumps(inputs, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def new_piece(loop: str) -> dict[str, Any]:
    return {
        "loop": loop, "status": "pending", "round": 0,
        "base_sha": None, "candidate_sha": None, "bar_hash": None,
        **{f: "not_run" for f in SUB_FIELDS},
        "seen_findings": [], "blocker_history": [],
        "reason": None, "question": None, "pr": None, "merged_sha": None, "combined_sha": None,
        "outcome": None,
    }


def _read(root: Path, name: str) -> dict[str, Any]:
    path = state_path(root, name)
    if not path.is_file():
        raise core.NightshiftError(f"no run state at {path}; start a run first")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise core.NightshiftError(f"{path} is not valid JSON: {exc}") from exc
    if data.get("schema") != SCHEMA:
        raise core.NightshiftError(f"{path}: unsupported schema {data.get('schema')!r}")
    return data


def load(root: Path, name: str) -> dict[str, Any]:
    """The run state, with the hashes ``save`` needs to merge (``_loaded``, never written)."""
    data = _read(root, name)
    _snapshot(data)
    return data


# ---------------------------------------------------------------------------
# Locking and merge (see module docstring)
# ---------------------------------------------------------------------------

MERGED_MAPS = ("pieces", "steps")  # merged per entry; every other top-level key as a whole
UNMERGED = ("_loaded", "updated_at")


def _hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _snapshot(state: dict[str, Any]) -> None:
    state["_loaded"] = {
        "top": {k: _hash(v) for k, v in state.items() if k not in UNMERGED + MERGED_MAPS},
        **{m: {k: _hash(v) for k, v in (state.get(m) or {}).items()} for m in MERGED_MAPS},
    }


def _merge_into(mine: dict[str, Any], disk: dict[str, Any], loaded: dict[str, str],
                skip: tuple[str, ...] = ()) -> None:
    """Mutate ``mine`` in place: an entry the caller changed, added or deleted since its
    load keeps the caller's version; every other entry takes the disk version. Dicts the
    caller holds references to (``c.p``) stay the same objects."""
    for key in set(mine) | set(disk):
        if key in skip:
            continue
        if key in mine:
            if _hash(mine[key]) != loaded.get(key):
                continue  # changed or added by the caller
        elif key in loaded:
            continue  # deleted by the caller
        if key not in disk:
            mine.pop(key, None)
        elif isinstance(mine.get(key), dict) and isinstance(disk[key], dict):
            mine[key].clear()
            mine[key].update(disk[key])
        else:
            mine[key] = disk[key]


def merge_from_disk(root: Path, name: str, state: dict[str, Any]) -> None:
    """Bring the entries this caller did not change up to date with the disk (call under the lock)."""
    loaded = state.get("_loaded")
    if loaded is None or not state_path(root, name).is_file():
        return
    disk = _read(root, name)
    _merge_into(state, disk, loaded["top"], skip=UNMERGED + MERGED_MAPS)
    for m in MERGED_MAPS:
        if m in state or m in disk:
            state.setdefault(m, {})
            _merge_into(state[m], disk.get(m) or {}, loaded.get(m) or {})


def refresh(root: Path, name: str, state: dict[str, Any]) -> None:
    """Reload in place after a long wait: entries the caller has not changed take the
    latest version on disk, so the caller's next change starts from fresh data."""
    with locked(root, name):
        merge_from_disk(root, name, state)
        _snapshot(state)


@contextmanager
def locked(root: Path, name: str):
    """Exclusive lock for every state and lease write (``flock`` on ``state.lock``)."""
    d = run_dir(root, name)
    d.mkdir(parents=True, exist_ok=True)
    with (d / "state.lock").open("a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _write(root: Path, name: str, state: dict[str, Any]) -> None:
    path = state_path(root, name)
    state["updated_at"] = now()
    body = {k: v for k, v in state.items() if k != "_loaded"}
    tmp = path.with_suffix(f".json.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(body, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    _snapshot(state)


def update(root: Path, name: str, fn) -> dict[str, Any]:
    """Read-modify-write under the lock: reload, apply ``fn(state)``, save; return the state."""
    with locked(root, name):
        check_lease(root, name)
        state = load(root, name)
        fn(state)
        _write(root, name, state)
    for step in pending_intents(state):
        core.test_crash(f"after-intent:{step_kind(step)}")
    return state


# ---------------------------------------------------------------------------
# Orchestrator lease
#
# One dispatcher session owns a run. ``state.py lease acquire`` writes
# ``lease.json`` with an owner id and a heartbeat; the session exports the id as
# NIGHTSHIFT_LEASE and every state save checks it. ``piece.py start`` passes it on to
# the piece process it launches, so both layers write under the one lease (D-LAYER). A second session is refused
# while the lease is fresh; a stale lease (no heartbeat for LEASE_TTL seconds) is
# taken over only with ``--take-over`` on resume. Mechanical for every script that
# saves state; no script can stop someone editing state.json by hand.
#
# ``--holder-pid`` records the orchestrating session's long-lived process (with its
# host and /proc start time); ``--take-over`` then succeeds at once when that process
# is provably gone on this host (no such pid, a zombie, or a different start time, i.e.
# a reused pid). Otherwise, or without a holder pid, the TTL rule applies (D25).
# ---------------------------------------------------------------------------

LEASE_TTL = int(os.environ.get("NIGHTSHIFT_LEASE_TTL", "900"))


def lease_path(root: Path, name: str) -> Path:
    return run_dir(root, name) / "lease.json"


def read_lease(root: Path, name: str) -> dict[str, Any] | None:
    path = lease_path(root, name)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _lease_age(lease: dict[str, Any]) -> float:
    try:
        seen = datetime.fromisoformat(lease["heartbeat"])
    except (KeyError, ValueError):
        return float("inf")
    return (datetime.now(timezone.utc) - seen).total_seconds()


def proc_start_time(pid: int) -> str | None:
    """Field 22 of ``/proc/<pid>/stat`` (start time in clock ticks), or None without /proc."""
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def holder_gone(lease: dict[str, Any]) -> str | None:
    """Why the lease's holder process is provably gone, or None when it may still run
    (no holder recorded, another host, alive, or not provable)."""
    pid = lease.get("holder_pid")
    if not pid or lease.get("holder_host") != socket.gethostname():
        return None
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return f"holder pid {pid} is not running"
    except PermissionError:
        pass  # exists, owned by someone else: fall through to the start time
    try:
        if Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] == "Z":
            return f"holder pid {pid} is a zombie"
    except (OSError, IndexError):
        pass
    started = proc_start_time(int(pid))
    recorded = lease.get("holder_start")
    if started and recorded and started != recorded:
        return f"holder pid {pid} was reused by another process"
    return None


def acquire_lease(root: Path, name: str, owner: str, take_over: bool = False,
                  holder_pid: int | None = None) -> dict[str, Any]:
    """Claim the run for ``owner``; refuse a fresh lease held by someone else."""
    with locked(root, name):
        return _acquire_lease(root, name, owner, take_over, holder_pid)


def _acquire_lease(root: Path, name: str, owner: str, take_over: bool,
                   holder_pid: int | None = None) -> dict[str, Any]:
    path = lease_path(root, name)
    current = read_lease(root, name)
    gone = None
    if current and current.get("owner") != owner:
        age = _lease_age(current)
        gone = holder_gone(current) if take_over else None
        if age < LEASE_TTL and not gone:
            raise core.NightshiftError(
                f"run is owned by orchestrator {current['owner']} (heartbeat {int(age)}s ago); "
                "two orchestrators must not run one feature"
                + ("" if current.get("holder_pid") else
                   "; it recorded no --holder-pid, so --take-over waits for the TTL"))
        if not take_over:
            raise core.NightshiftError(
                f"stale lease from {current['owner']} ({int(age)}s without a heartbeat); "
                "resume with --take-over after checking that session is gone")
    mine = current if current and current.get("owner") == owner else {}
    if holder_pid is not None:
        try:
            os.kill(int(holder_pid), 0)
        except ProcessLookupError:
            raise core.NightshiftError(f"--holder-pid {holder_pid} is not a running process") from None
        except PermissionError:
            pass
        holder = {"holder_pid": int(holder_pid), "holder_host": socket.gethostname(),
                  "holder_start": proc_start_time(int(holder_pid))}
    else:
        holder = {k: mine.get(k) for k in ("holder_pid", "holder_host", "holder_start")}
    lease = {"owner": owner, "acquired_at": mine.get("acquired_at") or now(), "heartbeat": now(),
             "pid": os.getpid(), **holder,
             "previous": current.get("owner") if current and current.get("owner") != owner else None}
    if gone:
        lease["taken_over"] = gone
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(lease, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return lease


def release_lease(root: Path, name: str, owner: str) -> None:
    with locked(root, name):
        current = read_lease(root, name)
        if current and current.get("owner") == owner:
            lease_path(root, name).unlink(missing_ok=True)


def check_lease(root: Path, name: str) -> None:
    """Refuse a state write from a process that does not hold a live lease.

    Without NIGHTSHIFT_LEASE in the environment, a write is allowed only when no
    fresh lease exists (single-session use and the unit tests). Callers hold ``locked``,
    so the heartbeat write never races another writer."""
    lease = read_lease(root, name)
    mine = os.environ.get("NIGHTSHIFT_LEASE", "")
    if lease is None:
        return
    if mine and lease.get("owner") == mine:
        lease["heartbeat"] = now()
        path = lease_path(root, name)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(lease, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        return
    if _lease_age(lease) < LEASE_TTL:
        raise core.NightshiftError(
            f"run is owned by orchestrator {lease.get('owner')}; this process "
            f"({'lease ' + mine if mine else 'no NIGHTSHIFT_LEASE'}) may not write its state")


def save(root: Path, name: str, state: dict[str, Any]) -> None:
    """Write the caller's changes, merged into the latest state on disk (never a stale
    whole document). A state that was not ``load``ed (``init``) is written as is."""
    with locked(root, name):
        check_lease(root, name)
        merge_from_disk(root, name, state)
        _write(root, name, state)
    for step in pending_intents(state):
        core.test_crash(f"after-intent:{step_kind(step)}")


def step_kind(step: str) -> str:
    return step.rsplit(":", 1)[-1]


def init(root: Path, name: str, feature: str, feature_branch: str, loops: dict[str, str]) -> dict[str, Any]:
    path = state_path(root, name)
    if path.exists():
        raise core.NightshiftError(f"a run already exists at {path}; use --resume")
    ts = now()
    state = {
        "schema": SCHEMA,
        "run_id": datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + name,
        "feature": feature, "feature_branch": feature_branch,
        "status": "running", "stop_reason": None, "started_at": ts, "updated_at": ts,
        "pieces": {k: new_piece(v) for k, v in loops.items()},
        "steps": {},
    }
    save(root, name, state)
    return state


def piece(state: dict[str, Any], key: str) -> dict[str, Any]:
    try:
        return state["pieces"][key]
    except KeyError as exc:
        raise core.NightshiftError(f"unknown piece {key!r} in run state") from exc


def transition(state: dict[str, Any], key: str, to: str, *, by: str = "", reason: str | None = None) -> None:
    p = piece(state, key)
    frm = p["status"]
    if to in RESERVED and by != RESERVED[to]:
        raise core.NightshiftError(f"{key}: only {RESERVED[to]} may set a piece to {to}")
    if to not in TRANSITIONS.get(frm, set()):
        raise core.NightshiftError(f"{key}: illegal transition {frm} -> {to}")
    if to == "parked" and reason not in PARK_REASONS:
        raise core.NightshiftError(f"{key}: unknown park reason {reason!r}")
    if to == "blocked" and reason not in BLOCK_REASONS:
        raise core.NightshiftError(f"{key}: unknown block reason {reason!r}")
    if frm == "parked":
        unpark(p, to, by)
    p["status"] = to
    if to == "parked":
        p["parked_at"] = now()
    if to in ("parked", "blocked"):
        p["reason"] = reason
    elif to in ("building", "pending"):
        p["reason"] = None


def unpark(p: dict[str, Any], to: str, by: str) -> None:
    """A parked piece leaves ``parked``: archive the park in ``parks`` (reason, question,
    rounds, its stagnation records and SHAs; D-HONEST) and give it a fresh round budget.
    ``round`` keeps counting, so step ids ``<piece>:<round>:<kind>`` never repeat; the cap
    counts from ``round_base`` (``rounds_used``). The candidate and its sub-statuses stay:
    they are bound to their SHA, and the next builder round resets them (``verdict._build``).
    A merge that was reverted (``combined_checks_failed``) moves to ``parks``."""
    p.setdefault("parks", []).append({
        "reason": p.get("reason"), "question": p.get("question"), "parked_at": p.get("parked_at"),
        "released_at": now(), "released_by": by, "to": to, "round": p.get("round") or 0,
        "rounds_used": rounds_used(p), "candidate_sha": p.get("candidate_sha"),
        "merged_sha": p.get("merged_sha"), "combined_sha": p.get("combined_sha"),
        "blocker_history": p.get("blocker_history") or [], "seen_findings": p.get("seen_findings") or []})
    p["blocker_history"], p["seen_findings"] = [], []  # the fresh builder sees every finding again
    p.pop("round_findings", None)
    if p.get("merged_sha"):
        # Its merge was reverted on the feature branch: re-merging the same branch would
        # not bring the work back, so the next ``phase.py start`` branches afresh.
        p["fresh_branch"] = True
    p["merged_sha"] = p["combined_sha"] = None
    p["round_base"] = int(p.get("round") or 0)
    p.pop("parked_at", None)


def rounds_used(p: dict[str, Any]) -> int:
    """Rounds used against ``max_rounds`` since the piece last left ``parked``."""
    return int(p.get("round") or 0) - int(p.get("round_base") or 0)


def release_waiting(state: dict[str, Any], piece: str, *, by: str, settled: tuple[str, ...]) -> list[str]:
    """Free the pieces blocked ``dependency_blocked`` on ``piece``.

    ``piece`` leaves each dependent's ``waits_on``; a dependent whose remaining waits
    all have a status in ``settled`` returns to ``pending``, otherwise it keeps waiting
    on the first unsettled one. Returns the keys freed. Shared by ``blocker.py
    resolve`` (any non-blocked prerequisite is settled) and ``phase_merge.py
    combined`` (only ``passed`` is). Mechanical.
    """
    freed = []
    for key, dp in (state.get("pieces") or {}).items():
        if dp["status"] != "blocked" or dp.get("reason") != "dependency_blocked":
            continue
        waits = dp.get("waits_on") or ([piece] if dp.get("question") == f"waits on {piece}" else [])
        if piece not in waits:
            continue
        waits = [w for w in waits if w != piece]
        dp["waits_on"] = waits
        still = [w for w in waits if (state["pieces"].get(w) or {}).get("status") not in settled]
        if still:
            dp["question"] = f"waits on {still[0]}"
            continue
        transition(state, key, "pending", by=by)
        dp["question"] = None
        freed.append(key)
    return freed


def set_outcome(unit: dict[str, Any], outcome: str, *, by: str) -> None:
    """Record a unit outcome on a piece (set with ``passed``, which is terminal)."""
    if outcome not in PASS_OUTCOMES:
        raise core.NightshiftError(f"unknown unit outcome {outcome!r}")
    if PASS_OUTCOMES[outcome] != by:
        raise core.NightshiftError(f"outcome {outcome} is recorded only by {PASS_OUTCOMES[outcome]} (D-HONEST)")
    unit["outcome"] = outcome


def set_sub(state: dict[str, Any], key: str, field: str, value: str) -> None:
    if field not in SUB_FIELDS or value not in SUB_STATUSES:
        raise core.NightshiftError(f"invalid sub-status {field}={value}")
    piece(state, key)[field] = value


def step_done(state: dict[str, Any], step: str, inputs: Any) -> dict[str, Any] | None:
    """The success record of ``step`` if its inputs match the current ones (resume rule)."""
    rec = state["steps"].get(step) or {}
    done = rec.get("done")
    if done and done.get("inputs") == inputs_hash(inputs):
        return done
    return None


def step_intent(state: dict[str, Any], step: str, inputs: Any) -> None:
    state["steps"][step] = {"intent": {"at": now(), "inputs": inputs_hash(inputs)}}


def step_complete(state: dict[str, Any], step: str, inputs: Any, result: Any) -> None:
    core.test_crash(f"before-done:{step_kind(step)}")
    rec = state["steps"].setdefault(step, {})
    rec["done"] = {"at": now(), "inputs": inputs_hash(inputs), "result": result}


def pending_intents(state: dict[str, Any]) -> list[str]:
    return [k for k, v in state["steps"].items() if v.get("intent") and not v.get("done")]


def stop(state: dict[str, Any], reason: str) -> None:
    if reason not in STOP_REASONS:
        raise core.NightshiftError(f"unknown stop reason {reason!r}")
    state["status"] = "stopped"
    state["stop_reason"] = reason
    state["stopped_at"] = now()


LOG_KEY = ("run_id", "piece", "round", "step", "outcome", "sha", "detail")


def _append(path: Path, entry: dict[str, Any], key: tuple[str, ...]) -> dict[str, Any]:
    """Append ``entry`` unless an entry with the same ``key`` fields exists.

    A resumed step that re-observes the same fact (same run, piece, round, step,
    outcome, SHA and detail) is not a new event, so it is not written twice (D10).
    Mechanical for every writer that goes through this module."""
    path.parent.mkdir(parents=True, exist_ok=True)
    want = tuple(entry.get(k) for k in key)
    for old in read_jsonl(path):
        if tuple(old.get(k) for k in key) == want:
            return {**old, "deduplicated": True}
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, sort_keys=False) + "\n")
    return entry


def log(root: Path, name: str, state: dict[str, Any], *, piece: str, step: str, outcome: str,
        sha: str | None = None, detail: str = "") -> dict[str, Any]:
    rnd = ((state.get("pieces") or {}).get(piece) or {}).get("round")
    entry = {"ts": now(), "run_id": state["run_id"], "piece": piece, "round": rnd, "sha": sha,
             "step": step, "outcome": outcome, "detail": detail}
    return _append(run_dir(root, name) / "log.jsonl", entry, LOG_KEY)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
