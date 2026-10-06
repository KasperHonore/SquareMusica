"""GitHub projection for Spec Kit Nightshift (design §3.1, §4; spike S-5).

GitHub is a one-way projection of the repository. Every issue is identified by
the hidden ``speckit-nightshift`` marker in its body; the issue numbers cached
in the delivery record are only a hint, and the marker wins. Each run looks
issues up before creating any, so a re-run never duplicates. A lookup that
fails is an error, never "absent": nothing is created after a failed read.

All calls go through the ``gh`` CLI (``gh api``), so authentication stays with
``gh``. The sub-issue and issue-dependency endpoints are shim-tested only until
spike S-4 / H19 runs against the real API.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import nightshift_core as core

MARKER_RE = re.compile(r"<!--\s*" + re.escape(core.MARKER_PREFIX) + r"\s+(?P<fields>[^>]*?)\s*-->")
API_HEADERS = ["-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"]


class GitHubError(core.NightshiftError):
    pass


def marker_key(body: str) -> str:
    """The first Nightshift marker in an issue body, normalised, or ""."""
    m = MARKER_RE.search(body or "")
    return " ".join(sorted(m.group("fields").split())) if m else ""


def remote_repo(root: Path) -> str:
    """``owner/name`` of the ``origin`` remote, or an error if it is not GitHub.

    ``NIGHTSHIFT_GH_REPO`` replaces the lookup when ``origin`` is not a GitHub URL
    (a local mirror, or the shim tests' bare repository). It is the one place the
    repository identity can be overridden, and every script resolves it here.
    """
    override = os.environ.get("NIGHTSHIFT_GH_REPO", "")
    if override:
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", override):
            raise GitHubError(f"NIGHTSHIFT_GH_REPO is not owner/name: {override}")
        return override
    try:
        url = subprocess.run(["git", "config", "--get", "remote.origin.url"], cwd=root,
                             capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GitHubError(f"cannot read the git remote: {exc}") from exc
    m = re.match(r"^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)"
                 r"(?P<repo>[\w.-]+/[\w.-]+?)(?:\.git)?/?$", url)
    if not m:
        raise GitHubError(f"origin is not a GitHub repository: {url or '(no origin remote)'}")
    return m.group("repo")


@dataclass
class Gh:
    repo: str
    root: Path
    writes: int = 0
    log: list[str] = field(default_factory=list)

    def api(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        argv = ["gh", "api", "-X", method, *API_HEADERS, path]
        if payload is not None:
            argv += ["--input", "-"]
        if method != "GET":
            self.writes += 1
        try:
            proc = subprocess.run(argv, cwd=self.root, capture_output=True, text=True, timeout=120,
                                  input=json.dumps(payload) if payload is not None else None,
                                  env=core.tool_env())
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise GitHubError(f"gh {method} {path} failed: {exc}") from exc
        if proc.returncode != 0:
            raise GitHubError(f"gh {method} {path} failed ({proc.returncode}): "
                              f"{(proc.stderr or proc.stdout).strip()[:500]}")
        if method != "GET":
            core.test_crash("after-gh-write")
        out = proc.stdout.strip()
        try:
            return json.loads(out) if out else None
        except json.JSONDecodeError as exc:
            raise GitHubError(f"gh {method} {path} returned invalid JSON") from exc

    def list_all(self, path: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        sep = "&" if "?" in path else "?"
        for page in range(1, 1000):
            batch = self.api("GET", f"{path}{sep}per_page=100&page={page}")
            if not isinstance(batch, list):
                raise GitHubError(f"unexpected response listing {path}")
            items += batch
            if len(batch) < 100:
                return items
        raise GitHubError(f"too many pages listing {path}")


# ---------------------------------------------------------------------------
# Reading the current projection
# ---------------------------------------------------------------------------


@dataclass
class Remote:
    by_marker: dict[str, dict[str, Any]]
    duplicates: dict[str, list[int]]


def index_issues(gh: Gh) -> Remote:
    """All marked issues in the repo (open and closed). Unmarked issues are ignored."""
    by_marker: dict[str, dict[str, Any]] = {}
    dups: dict[str, list[int]] = {}
    for issue in gh.list_all(f"repos/{gh.repo}/issues?state=all"):
        if issue.get("pull_request"):
            continue
        key = marker_key(issue.get("body") or "")
        if not key:
            continue
        if key in by_marker:
            # Keep the oldest; report the rest so a human can close them.
            keep, other = sorted([by_marker[key], issue], key=lambda i: i["number"])
            by_marker[key] = keep
            dups.setdefault(key, [keep["number"]]).append(other["number"])
        else:
            by_marker[key] = issue
    return Remote(by_marker, dups)


# ---------------------------------------------------------------------------
# Applying a plan
# ---------------------------------------------------------------------------


@dataclass
class Outcome:
    actions: list[dict[str, Any]] = field(default_factory=list)
    numbers: dict[str, int] = field(default_factory=dict)  # plan key -> issue number
    published: dict[str, str] = field(default_factory=dict)  # plan key -> content hash written
    warnings: list[str] = field(default_factory=list)

    def add(self, action: str, key: str, number: int | None, detail: str = "") -> None:
        self.actions.append({"action": action, "key": key, "number": number, "detail": detail})


def content_hash(title: str, body: str) -> str:
    """Hash of an issue's title and body as Nightshift published them."""
    norm = (body or "").replace("\r\n", "\n").strip()
    return core.sha256_text((title or "") + "\n\0\n" + norm)[:16]


def _origin(issue: dict[str, Any], published: dict[str, str], key: str) -> str:
    """Why GitHub differs from the plan: ``hand`` if GitHub no longer holds what
    Nightshift last published (someone edited it), else ``repo`` (the repository
    changed since). Without a published hash, assume ``hand`` (the safe reading)."""
    last = published.get(key)
    if last and content_hash(issue.get("title") or "", issue.get("body") or "") == last:
        return "repo"
    return "hand"


def _differences(issue: dict[str, Any], title: str, body: str) -> list[str]:
    diffs = []
    if (issue.get("title") or "") != title:
        diffs.append("title")
    if (issue.get("body") or "").replace("\r\n", "\n").strip() != body.strip():
        diffs.append("body")
    return diffs


def plan_items(plan: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """(key, item) pairs in publish order: parent or bug issue first."""
    if plan["kind"] == "bug":
        return [("bug", plan["issue"])]
    return [("parent", plan["parent"])] + [(i["piece"], i) for i in plan["sub_issues"]]


def reconcile(gh: Gh, plan: dict[str, Any], cached: dict[str, Any],
              published: dict[str, str] | None = None) -> Outcome:
    """Compare the plan with GitHub without writing anything (H17)."""
    remote = index_issues(gh)
    out = Outcome()
    for key, item in plan_items(plan):
        mk = marker_key(item["marker"])
        issue = remote.by_marker.get(mk)
        cnum = cached.get(key)
        if issue is None:
            out.add("missing", key, None, "no issue carries this marker")
            if cnum:
                out.warnings.append(f"{key}: cached issue #{cnum} does not carry the marker; the marker wins")
            continue
        out.numbers[key] = issue["number"]
        if cnum and cnum != issue["number"]:
            out.warnings.append(f"{key}: cached #{cnum} differs from marked #{issue['number']}; the marker wins")
        if issue.get("state") == "closed":
            out.add("closed-on-github", key, issue["number"], "closed by hand on GitHub")
        diffs = _differences(issue, item["title"], item["body"])
        if diffs and _origin(issue, published or {}, key) == "repo":
            out.add("outdated", key, issue["number"],
                    "the repository changed since the last publish; --apply updates " + " and ".join(diffs))
        elif diffs:
            out.add("edited-on-github" if "body" in diffs else "title-differs", key, issue["number"],
                    "generated " + " and ".join(diffs) + " edited on GitHub since the last publish")
        if not diffs and issue.get("state") != "closed":
            out.add("in-sync", key, issue["number"])
    for mk, nums in remote.duplicates.items():
        out.warnings.append(f"duplicate issues carry marker [{mk}]: {', '.join('#' + str(n) for n in nums)}")
    return out


def apply(gh: Gh, plan: dict[str, Any], published: dict[str, str] | None = None) -> Outcome:
    """Create or update every planned issue, then the links. Idempotent by marker.

    ``published`` maps plan keys to the content hash Nightshift last wrote; it tells
    a hand edit (``restored``) from a repository change (``updated``). The new hashes
    are returned in ``Outcome.published``."""
    remote = index_issues(gh)
    out = Outcome()
    issues: dict[str, dict[str, Any]] = {}
    for key, item in plan_items(plan):
        mk = marker_key(item["marker"])
        existing = remote.by_marker.get(mk)
        if existing is None:
            created = gh.api("POST", f"repos/{gh.repo}/issues", {"title": item["title"], "body": item["body"]})
            issues[key] = created
            out.add("created", key, created["number"])
        else:
            issues[key] = existing
            diffs = _differences(existing, item["title"], item["body"])
            if diffs:
                updated = gh.api("PATCH", f"repos/{gh.repo}/issues/{existing['number']}",
                                 {"title": item["title"], "body": item["body"]})
                issues[key] = updated or existing
                hand = _origin(existing, published or {}, key) == "hand"
                out.add("restored" if hand else "updated", key, existing["number"],
                        ("rewrote the hand-edited " if hand else "updated the generated ") + " and ".join(diffs))
            else:
                out.add("unchanged", key, existing["number"])
            if existing.get("state") == "closed":
                out.warnings.append(f"{key}: #{existing['number']} was closed on GitHub; left closed "
                                    "(the repository decides, not the tracker)")
        out.numbers[key] = issues[key]["number"]
        out.published[key] = content_hash(item["title"], item["body"])
    for mk, nums in remote.duplicates.items():
        out.warnings.append(f"duplicate issues carry marker [{mk}]: {', '.join('#' + str(n) for n in nums)}")
    if plan["kind"] == "feature":
        _link_sub_issues(gh, plan, issues, out)
        _link_blocked_by(gh, plan, issues, out)
    return out


def _link_sub_issues(gh: Gh, plan: dict[str, Any], issues: dict[str, dict[str, Any]], out: Outcome) -> None:
    parent = issues["parent"]["number"]
    current = {i["id"] for i in gh.list_all(f"repos/{gh.repo}/issues/{parent}/sub_issues")}
    for link in plan["links"]:
        if link["type"] != "sub-issue":
            continue
        child = issues[link["child"]]
        if child["id"] in current:
            continue
        gh.api("POST", f"repos/{gh.repo}/issues/{parent}/sub_issues",
               {"sub_issue_id": child["id"], "replace_parent": True})
        out.add("linked-sub-issue", link["child"], child["number"], f"under #{parent}")


def _link_blocked_by(gh: Gh, plan: dict[str, Any], issues: dict[str, dict[str, Any]], out: Outcome) -> None:
    wanted: dict[str, set[str]] = {}
    for link in plan["links"]:
        if link["type"] == "blocked-by":
            wanted.setdefault(link["issue"], set()).add(link["blocked_by"])
    for key, deps in wanted.items():
        num = issues[key]["number"]
        current = {i["id"] for i in gh.list_all(f"repos/{gh.repo}/issues/{num}/dependencies/blocked_by")}
        for dep in sorted(deps):
            blocker = issues[dep]
            if blocker["id"] in current:
                continue
            gh.api("POST", f"repos/{gh.repo}/issues/{num}/dependencies/blocked_by", {"issue_id": blocker["id"]})
            out.add("linked-blocked-by", key, num, f"blocked by #{blocker['number']} ({dep})")


# ---------------------------------------------------------------------------
# Repository CI on a commit (D-CIWAIT)
# ---------------------------------------------------------------------------

CI_GOOD = ("success", "neutral", "skipped")


def ci_status(gh: Gh, sha: str, required: list[str] | None = None) -> dict[str, Any]:
    """The repository's own GitHub checks on ``sha``: check runs and the combined status.

    ``state``: ``none`` (no check run and no status at all), ``pending`` (any check run
    not completed, any status pending, or a ``required`` name not reported yet),
    ``failure`` (a completed check run whose conclusion is not success, neutral or
    skipped, or a status that is failure/error) or ``success``. Read-only."""
    runs: list[dict[str, Any]] = []
    for page in range(1, 100):
        data = gh.api("GET", f"repos/{gh.repo}/commits/{sha}/check-runs?per_page=100&page={page}") or {}
        batch = data.get("check_runs") or []
        runs += batch
        if len(batch) < 100 or len(runs) >= int(data.get("total_count") or 0):
            break
    combined = gh.api("GET", f"repos/{gh.repo}/commits/{sha}/status?per_page=100") or {}
    statuses = combined.get("statuses") or []
    checks = [{"name": r.get("name") or "?", "kind": "check-run", "status": r.get("status"),
               "conclusion": r.get("conclusion")} for r in runs]
    checks += [{"name": s.get("context") or "?", "kind": "status",
                "status": "completed" if s.get("state") != "pending" else "pending",
                "conclusion": s.get("state")} for s in statuses]
    failing = sorted({c["name"] for c in checks if c["status"] == "completed" and c["conclusion"] not in CI_GOOD})
    pending = sorted({c["name"] for c in checks if c["status"] != "completed"})
    missing = sorted(set(required or []) - {c["name"] for c in checks})
    if failing:
        state = "failure"
    elif pending or missing:
        state = "pending"
    elif not checks:
        state = "none"
    else:
        state = "success"
    return {"sha": sha, "state": state, "checks": checks, "failing": failing, "pending": pending,
            "missing": missing, "combined_status": combined.get("state") if statuses else None}
