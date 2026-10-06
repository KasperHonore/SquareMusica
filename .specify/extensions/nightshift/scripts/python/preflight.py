#!/usr/bin/env python3
"""Preflight: refuse a run before any tokens are spent (design §7, D-AGENTPY, D7c).

Checks, all of them every time, so the refusal names everything missing at once:

- ``git`` on PATH, inside a work tree, on a branch (not detached), clean tree
  (untracked ``__pycache__/`` and ``*.pyc`` anywhere, and any under the installed
  extension, are ignored: Spec Kit's ``.specify/scripts/python/`` writes them);
- ``.nightshift/`` is gitignored (``git check-ignore``);
- ``gh`` on PATH and ``gh auth status`` succeeds;
- the builder CLI (config ``cli.builder``, default ``claude``) on PATH;
- at least one check is configured and each check's executable resolves;
- a preview command is configured and its executable resolves; a path in it (``argv[0]``
  with a slash, or the script of an interpreter such as ``sh <path>``) must exist where the
  preview will run: absolute paths on disk, repo-relative paths in the committed tree of
  the base branch for ``--bug`` (the fix branch is cut from it, D24) or of ``HEAD`` for a
  batch (``git cat-file -e <ref>:<path>``);
- the batch is approved and ``validate`` passes (with ``--resume`` and an answer waiting for
  absorb, the drift ``absorb`` judges is reported as ``pending_absorb``); or, with
  ``--bug <slug>`` (a fix run),
  ``.specify/bugs/<slug>/assessment.md`` exists, ``validate --bug <slug> --loop fix``
  passes and the bug's delivery record ``.specify/delivery/bug-<slug>.yml`` has
  ``loop: fix`` (``ready go --bug <slug>`` was run and committed);
- free disk space in the temp dir ``checks.py`` uses (``tempfile.gettempdir()``) and on
  the repository's filesystem: a warning below ``min_free_mb.warn`` (default 1536 MB),
  a refusal below ``min_free_mb.refuse`` (default 500 MB). A check checkout plus an
  ``npm install`` fails in seconds with empty logs on a full /tmp (D23). Because a user
  quota is invisible to statvfs, each place also gets a write probe of
  ``min_free_mb.probe`` MB (default 32; 0 turns it off): a failed write is a refusal
  ``disk-quota`` (1.1.3, L1 phase D: EDQUOT with 891 MB "free").

Branch protection on ``main`` is a **warning** only. v1 does not call the API for
it unless ``origin`` is a GitHub remote and ``gh`` is available; otherwise it is
reported as ``not_checked``.

Every check here is **mechanical** but point-in-time: a tool can disappear or a
tree can change after preflight; the later scripts re-check what they depend on.

A refusal releases the run lease when ``NIGHTSHIFT_LEASE`` holds it (mechanical), so a
refused resume never leaves the run locked (live L1 1.1.1, phase C).

Exit codes: 0 ready (warnings allowed), 1 refused.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_config as config  # noqa: E402
import nightshift_core as core  # noqa: E402
import nightshift_model as model  # noqa: E402


def run(argv: list[str], cwd: Path, timeout: int = 60) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                              stdin=subprocess.DEVNULL, env=core.tool_env())
    except (OSError, subprocess.TimeoutExpired):
        return None


EXTENSION_DIR = ".specify/extensions/nightshift/"


def bytecode_noise(line: str) -> bool:
    """A Python bytecode cache is not a dirty tree: untracked anywhere (Spec Kit's own
    ``.specify/scripts/python/`` writes them; live L1 1.1.1, phase C), or in any state inside
    the installed extension (D23). ``line`` is a ``git status --porcelain`` line."""
    path = line[3:].strip().strip('"').split(" -> ")[-1]
    cache = "/__pycache__/" in f"/{path}" or path.endswith((".pyc", ".pyo"))
    return cache and (line.startswith("??") or path.startswith(EXTENSION_DIR))


# Findings an owner's committed answer causes, which ``blocker.py absorb`` judges (absorb or
# park). On resume with an answer waiting for absorb they do not refuse (live L1 1.1.1,
# phase C). Renumbering, structure and every other error still refuse.
ABSORB_CODES = (*model.DRIFT_CODES, "acceptance-changed", "acceptance-removed")


def pending_absorb(root: Path, name: str) -> list[str]:
    """Why an answer waits for ``blocker.py absorb`` in this run, or [] (no run, no answer):
    a piece blocked ``tasks_stale``/``reapproval_needed``, or a ``resolved`` blocker logged
    after the last absorb outcome."""
    import nightshift_state as nsstate  # noqa: PLC0415
    try:
        st = nsstate.load(root, name)
    except core.NightshiftError:
        return []
    why = [f"{k} is blocked {p['reason']}" for k, p in sorted((st.get("pieces") or {}).items())
           if p.get("status") == "blocked" and p.get("reason") in ("tasks_stale", "reapproval_needed")]
    last_resolved = last_absorb = -1
    for i, e in enumerate(nsstate.read_jsonl(nsstate.run_dir(root, name) / "log.jsonl")):
        if e.get("step") == "blocker" and e.get("outcome") == "resolved":
            last_resolved = i
        elif e.get("step") == "blocker" and e.get("outcome") in ("answer_absorbed", "answer_needs_owner"):
            last_absorb = i
    if last_resolved > last_absorb:
        why.append("an answer was resolved and not yet absorbed")
    return why


SCRIPT_SUFFIXES = {".sh", ".bash", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl"}
INTERPRETERS = {"sh", "bash", "dash", "zsh", "python", "python3", "node", "bun", "deno", "ruby", "perl"}


def preview_paths(cmd: list[str]) -> list[str]:
    """Paths the preview command needs: argv[0] with a slash, or an interpreter's script."""
    argv = [str(x) for x in cmd]
    paths = [argv[0]] if "/" in argv[0] else []
    if Path(argv[0]).name in INTERPRETERS:
        for a in argv[1:]:
            if a in ("-m", "-c", "-e", "--eval", "eval", "run", "x"):
                break  # a module, inline code or a package script: no file argument
            if a.startswith("-"):
                continue
            if "{port}" not in a and ("/" in a or Path(a).suffix in SCRIPT_SUFFIXES):
                paths.append(a)
            break
    return paths


def base_ref(root: Path, cfg: dict[str, Any]) -> tuple[str, str]:
    """(branch, ref) of the base branch a fix run cuts from; ref prefers origin's copy."""
    import phase_merge as pm
    branch = str(cfg.get("base_branch") or pm.default_branch(root) or "main")
    for ref in (f"refs/remotes/origin/{branch}", f"refs/heads/{branch}"):
        res = run(["git", "rev-parse", "--verify", "--quiet", ref], root)
        if res is not None and res.returncode == 0:
            return branch, ref
    return branch, ""


def check_preview_paths(root: Path, cmd: list[str], ref: str, label: str, miss) -> None:
    """Each path the preview command needs must exist where the preview runs (D24)."""
    for path in preview_paths(cmd):
        if Path(path).is_absolute():
            if not Path(path).is_file():
                miss("preview-path-missing", f"preview.command needs {path!r}, which does not exist")
            continue
        if not ref:
            miss("preview-path-missing", f"preview.command needs {path!r}, but {label} cannot be resolved")
            continue
        rel = path[2:] if path.startswith("./") else path
        res = run(["git", "cat-file", "-e", f"{ref}:{rel}"], root)
        if res is None or res.returncode != 0:
            miss("preview-path-missing",
                 f"preview.command needs {path!r}, which is not committed on {label}; the preview runs "
                 f"in a checkout of the PR head, so commit it there first or use an absolute path "
                 f"outside the repository")


def check_bug(root: Path, slug: str, miss) -> dict[str, Any]:
    """Fix-run readiness for one reported bug (design §6.1); returns info fields."""
    info: dict[str, Any] = {"bug": slug}
    if not (root / ".specify" / "bugs" / slug / "assessment.md").is_file():
        miss("no-bug", f"bug assessment not found: .specify/bugs/{slug}/assessment.md")
        return info
    try:
        _, findings = model.validate_bug(root, slug, "fix")
    except core.NightshiftError as exc:
        miss("validate-failed", str(exc))
    else:
        for f in findings:
            if f.severity == "error":
                miss("validate-failed", f"[{f.code}] {f.message}")
    try:
        record = core.load_record(core.record_path(root, f"bug-{slug}"))
    except core.NightshiftError as exc:
        miss("bug-not-shaped", str(exc))
    else:
        info["loop"] = record.get("loop")
        if record.get("loop") != "fix":
            miss("bug-not-shaped", f"delivery record .specify/delivery/bug-{slug}.yml has no 'loop: fix'; "
                 f"run ready go --bug {slug} and commit it")
    return info


def write_probe(path: Path, mb: int) -> str:
    """Write ``mb`` MB to a temp file in ``path``, fsync, delete. '' when it worked.

    statvfs (``shutil.disk_usage``) is per filesystem; a user quota (EDQUOT) or a
    permission limit is only seen by writing (1.1.3, L1 phase D)."""
    if mb <= 0:
        return ""
    chunk = b"\0" * (1024 * 1024)
    fd, name = -1, ""
    try:
        fd, name = tempfile.mkstemp(prefix=".nightshift-probe-", dir=path)
        for _ in range(mb):
            os.write(fd, chunk)
        os.fsync(fd)
        return ""
    except OSError as exc:
        return f"{type(exc).__name__}: {exc.strerror or exc}"
    finally:
        if fd >= 0:
            os.close(fd)
        if name:
            try:
                os.unlink(name)
            except OSError:
                pass


def preflight(root: Path, fdir: Path | None, feature_arg: str | None, cfg: dict[str, Any],
              bug: str | None = None, resume: bool = False) -> dict[str, Any]:
    problems: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    info: dict[str, Any] = {"config": cfg["source"]}

    def miss(code: str, detail: str) -> None:
        problems.append({"code": code, "detail": detail})

    # git
    if not shutil.which("git"):
        miss("git-missing", "git is not on PATH")
    else:
        res = run(["git", "rev-parse", "--is-inside-work-tree"], root)
        if res is None or res.returncode != 0 or res.stdout.strip() != "true":
            miss("not-a-git-repo", f"{root} is not a git work tree")
        else:
            res = run(["git", "symbolic-ref", "-q", "--short", "HEAD"], root)
            branch = res.stdout.strip() if res and res.returncode == 0 else ""
            info["branch"] = branch or None
            if not branch:
                miss("detached-head", "HEAD is detached; check out the feature branch")
            res = run(["git", "status", "--porcelain", "--untracked-files=all"], root)
            dirty = [ln[3:] for ln in (res.stdout.splitlines() if res else [])
                     if ln.strip() and not bytecode_noise(ln)]
            if res is None or res.returncode != 0:
                miss("git-status-failed", "git status failed")
            elif dirty:
                miss("dirty-tree", "uncommitted changes: " + ", ".join(dirty[:10]))
            res = run(["git", "check-ignore", "-q", ".nightshift/state.json"], root)
            if res is None or res.returncode != 0:
                miss("nightshift-not-ignored", ".nightshift/ is not gitignored; add '.nightshift/' to .gitignore")

    # gh
    if not shutil.which("gh"):
        miss("gh-missing", "gh is not on PATH")
    else:
        res = run(["gh", "auth", "status"], root)
        if res is None or res.returncode != 0:
            detail = (res.stderr or res.stdout).strip().splitlines()[:1] if res else ["timed out"]
            miss("gh-auth", "gh auth status failed" + (f": {detail[0]}" if detail else ""))

    # agent CLI
    builder = config.cli_executable(cfg["cli"].get("builder")) or "claude"
    info["builder_cli"] = builder
    if not config.resolve_executable(builder, root):
        miss("builder-cli-missing", f"builder CLI {builder!r} (cli.builder) is not on PATH")

    # checks and preview
    if not cfg["checks"]:
        miss("no-checks", f"no checks configured in {cfg['source']}")
    for c in cfg["checks"]:
        if not config.resolve_executable(c["argv"][0], root):
            miss("check-tool-missing", f"check {c['id']}: {c['argv'][0]!r} is not on PATH")
    cmd = cfg["preview"]["command"]
    if not cmd:
        miss("no-preview-command", f"preview.command is not configured in {cfg['source']}")
    else:
        if bug:
            branch, ref = base_ref(root, cfg)
            label = f"the base branch {branch!r}"
        else:
            ref, label = "HEAD", "HEAD"
        if "/" not in str(cmd[0]) and not config.resolve_executable(str(cmd[0]), root):
            miss("preview-tool-missing", f"preview command {cmd[0]!r} is not on PATH")
        elif Path(str(cmd[0])).is_absolute() and not config.resolve_executable(str(cmd[0]), root):
            miss("preview-tool-missing", f"preview command {cmd[0]!r} is not an executable file")
        check_preview_paths(root, cmd, ref, label, miss)

    # disk space
    limits = cfg["min_free_mb"]
    info["free_mb"] = {}
    seen: set[int] = set()
    for label, path in (("temp", Path(tempfile.gettempdir())), ("repo", root)):
        try:
            dev = path.stat().st_dev
            free = shutil.disk_usage(path).free / (1024 * 1024)
        except OSError as exc:
            warnings.append({"code": "disk-space-unknown", "detail": f"cannot read free space of {path}: {exc}"})
            continue
        info["free_mb"][label] = round(free)
        if dev in seen:
            continue  # same filesystem as the one already judged
        seen.add(dev)
        where = f"{path} ({label}): {free:.0f} MB free"
        probe_err = write_probe(path, int(limits.get("probe") or 0))
        if probe_err:
            miss("disk-quota", f"{path} ({label}): cannot write a {int(limits['probe'])} MB probe file "
                               f"although statvfs reports {free:.0f} MB free ({probe_err}); a user quota or "
                               "permission limit applies (min_free_mb.probe)")
        elif free < limits["refuse"]:
            miss("disk-space", f"{where}, below the {limits['refuse']:.0f} MB minimum (min_free_mb.refuse)")
        elif free < limits["warn"]:
            warnings.append({"code": "disk-space-low",
                             "detail": f"{where}, below {limits['warn']:.0f} MB (min_free_mb.warn)"})

    # batch, or one reported bug
    if bug:
        info.update(check_bug(root, bug, miss))
    elif fdir is None:
        miss("no-feature", f"feature not found: {feature_arg or '(none selected)'}")
    else:
        try:
            rep = model.validate_feature(root, fdir)
        except core.NightshiftError as exc:
            miss("validate-failed", str(exc))
        else:
            info["feature"] = rep.derivation.feature
            if not (rep.record.get("approval") or {}).get("contract_hash"):
                miss("not-approved", "the batch is not approved; run shape --approve")
            waiting = pending_absorb(root, fdir.name) if resume else []
            pending: list[dict[str, str]] = []
            for f in rep.findings:
                if f.severity != "error":
                    continue
                if waiting and f.code in ABSORB_CODES:
                    pending.append({"code": f.code, "detail": f"[{f.code}] {f.message}"})
                else:
                    miss("validate-failed", f"[{f.code}] {f.message}")
            if pending:
                info["pending_absorb"] = {"why": waiting, "findings": pending,
                                          "next": "run blocker.py absorb --answer <comment-url> first; "
                                                  "it absorbs the answer or parks the pieces for Kasper"}

    # branch protection (warning only)
    protection = "not_checked"
    try:
        import nightshift_github as github
        repo = github.remote_repo(root)
    except core.NightshiftError:
        repo = None
    if repo and shutil.which("gh"):
        res = run(["gh", "api", f"repos/{repo}/branches/main/protection"], root)
        protection = "present" if res is not None and res.returncode == 0 else "absent_or_unreadable"
    info["branch_protection"] = protection
    if protection != "present":
        warnings.append({"code": "branch-protection",
                         "detail": f"branch protection on main: {protection} (warning only)"})

    return {"ok": not problems, "missing": problems, "warnings": warnings, **info}


def release_own_lease(root: Path, fdir: Path | None, bug: str | None) -> str | None:
    """On refusal, release the lease this session (``NIGHTSHIFT_LEASE``) holds, if any."""
    import os  # noqa: PLC0415
    import nightshift_state as nsstate  # noqa: PLC0415
    owner = os.environ.get("NIGHTSHIFT_LEASE", "")
    name = f"bug-{bug}" if bug else (fdir.name if fdir else "")
    if not owner or not name:
        return None
    lease = nsstate.read_lease(root, name)
    if not lease or lease.get("owner") != owner:
        return None
    nsstate.release_lease(root, name, owner)
    return owner


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    target = ap.add_mutually_exclusive_group()
    target.add_argument("--feature", help="feature directory")
    target.add_argument("--bug", metavar="SLUG", help="a fix run for one reported bug instead of a batch")
    ap.add_argument("--config", help="nightshift-config.yml to use")
    ap.add_argument("--resume", action="store_true",
                    help="resuming a run: drift a committed answer explains is pending absorb, not refused")
    ap.add_argument("--json", action="store_true", help="print JSON")
    args = ap.parse_args(argv)
    root = core.find_project_root()
    cfg = config.load(root, args.config)
    fdir: Path | None = None
    if not args.bug:
        try:
            fdir = core.resolve_feature_dir(root, args.feature)
        except core.NightshiftError:
            fdir = None
    out = preflight(root, fdir, args.feature, cfg, args.bug, resume=args.resume)
    if not out["ok"]:
        out["lease_released"] = release_own_lease(root, fdir, args.bug)
    if args.json:
        core.emit_json(out)
    else:
        for m in out["missing"]:
            print(f"MISSING [{m['code']}] {m['detail']}")
        for w in out["warnings"]:
            print(f"WARNING [{w['code']}] {w['detail']}")
        for f in (out.get("pending_absorb") or {}).get("findings", []):
            print(f"PENDING ABSORB {f['detail']}")
        if out.get("pending_absorb"):
            print("NEXT " + out["pending_absorb"]["next"])
        if out.get("lease_released"):
            print(f"Released the run lease {out['lease_released']}")
        print("Preflight " + ("passed" if out["ok"] else f"REFUSED ({len(out['missing'])} problem(s))"))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    core.run_main(main)
