#!/usr/bin/env python3
"""File pre-existing breakage found while building a piece (design §6.2, D-FOUND).

``file --piece P --title T --body B`` opens a new issue titled
``Found while building <piece title>: <T>``. It is not linked to the parent, the
sub-issue or the phase PR, and nothing in the phase fixes it. The issue carries
``<!-- speckit-nightshift: found piece=P key=<hash of T> -->``; an issue with that
marker is reused, so a resumed run never files it twice. The issue number is
recorded in the piece's ``found`` list in run state and in the logbook.

Pre-existing *blockers* are not filed here: the builder fixes them inside the phase
and names their regression check in ``.nightshift/found.json``; ``postconditions``
records them under the piece's ``prefixed`` list and ``handover pr`` lists them as
separate findings.

Safeguards: the marker lookup is **mechanical** (a failed lookup is an error, never
"absent"). Whether a breakage is pre-existing and non-blocking is the builder's
judgement (**behavioural**); this script only routes it.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_core as core  # noqa: E402
import nightshift_github as github  # noqa: E402
import nightshift_state as nsstate  # noqa: E402
import phase_merge as pm  # noqa: E402

VERSION = core.VERSION


def found_key(title: str) -> str:
    return core.sha256_text(" ".join(title.lower().split()))[:12]


def found_marker(piece: str, title: str) -> str:
    return f"<!-- {core.MARKER_PREFIX} found piece={piece} key={found_key(title)} -->"


def file_issue(ctx: pm.Ctx, piece: str, title: str, body: str, repo: str) -> dict[str, Any]:
    p = nsstate.piece(ctx.state, piece)
    if not title.strip():
        raise core.NightshiftError("--title must not be empty")
    dp = pm._derived_piece(ctx, piece)
    full_title = f"Found while building {dp.title if dp else piece}: {title.strip()}"
    mk = found_marker(piece, title)
    gh = github.Gh(repo, ctx.root)
    existing = github.index_issues(gh).by_marker.get(github.marker_key(mk))
    if existing:
        number, action = int(existing["number"]), "unchanged"
    else:
        text = (f"{mk}\n{body.strip()}\n\n"
                f"Found while building `{piece}` of `{ctx.feature}` at "
                f"`{p.get('candidate_sha') or p.get('base_sha') or 'unknown'}`. It existed before this phase "
                f"and does not block it, so the phase did not fix it (D-FOUND).\n\n"
                f"_Filed by Spec Kit Nightshift {VERSION}._")
        number = int(gh.api("POST", f"repos/{repo}/issues", {"title": full_title, "body": text})["number"])
        action = "filed"
    found = p.setdefault("found", [])
    if not any(f.get("issue") == number for f in found):
        found.append({"issue": number, "title": full_title, "summary": title.strip()})
    p["found_pending"] = [s for s in p.get("found_pending") or [] if s != title.strip()]
    ctx.save()
    ctx.log(piece, "found", action, p.get("candidate_sha"), f"#{number}: {full_title}")
    return {"piece": piece, "issue": number, "title": full_title, "action": action, "writes": gh.writes}


def main(argv: list[str]) -> int:
    ap, sub, common = pm.cli_parser(__doc__)
    f = sub.add_parser("file", parents=[common])
    f.add_argument("--piece", required=True)
    f.add_argument("--title", required=True)
    f.add_argument("--body", default="")
    args = ap.parse_args(argv)
    ctx = pm.load_ctx(args.feature)
    out = file_issue(ctx, args.piece, args.title, args.body, pm.resolve_repo(ctx.root, args.repo))
    pm.emit(args, out, f"{out['action']} #{out['issue']}: {out['title']}")
    return 0


if __name__ == "__main__":
    core.run_main(main)
