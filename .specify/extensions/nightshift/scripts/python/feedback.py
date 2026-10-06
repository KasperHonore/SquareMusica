#!/usr/bin/env python3
"""Route the human's feedback after handover: defects to a correction, wishes to Spec Kit (D-FB).

``classify --file items.json`` takes ``[{"text": ..., "kind": "defect"|"wish",
"criterion": "USn/ACm" | "FR-###"}]``. The agent decides each item's kind
(**behavioural**); this script enforces where it may go (**mechanical**):

- A **defect** must cite something approved: an acceptance ref ``USn/ACm`` in the
  approved baseline (``approval.baseline.acceptance``), or a requirement id
  ``FR-###`` / ``SC-###`` (letter suffix allowed) defined in the approved ``spec.md``,
  so its line can be quoted (a broken approved requirement is a defect, not
  new intent; D23). Then it becomes a new piece ``correction-<n>`` in run state (loop
  ``build``) whose bar is exactly that criterion or requirement line, quoted verbatim.
  The orchestrator runs it through the main loop; ``handover preview`` then restarts at the new head, and ``check-acceptance`` voids the earlier
  acceptance. A defect without such a criterion is **refused** and must be re-filed
  as a wish: if the spec never promised it, it is new intent, not a defect.
- A **wish** (new or changed intent) is appended to
  ``.nightshift/<name>/route-to-speckit.md`` for ``/speckit-clarify`` or a spec edit.
  No piece is created and no code is written. ``tasks.md``, ``spec.md`` and
  ``plan.md`` are never written here.

``--bug SLUG`` (a bug run, D24): a **defect** must cite a ref of the fix's frozen bar
(``bug/Symptom``, ``bug/Reproduction`` or a promise the assessment cites, as
``verdict.py inputs`` freezes it). It becomes a ``correction-<n>`` piece in the fix loop
(a new reproduction first, then the fix), run through the main loop like a feature
correction; the defect text reaches its builder. A defect citing anything else is
refused. A wish is routed as above.

Each item is recorded once (keyed by a hash of its text), so a re-run neither adds a
second correction nor appends a wish twice.

Exit codes: 0 every item routed, 1 a defect was refused (the others are still routed).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True  # no __pycache__ inside the installed extension (D23)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import nightshift_core as core  # noqa: E402
import nightshift_model as model  # noqa: E402
import nightshift_state as nstate  # noqa: E402


def item_key(text: str) -> str:
    return core.sha256_text(" ".join(text.split()))[:12]


def load_items(path: Path) -> list[dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise core.NightshiftError(f"cannot read {path}: {exc}") from exc
    if not isinstance(data, list):
        raise core.NightshiftError(f"{path} must be a JSON list of feedback items")
    for i, it in enumerate(data, 1):
        if not isinstance(it, dict) or it.get("kind") not in ("defect", "wish") or not str(it.get("text") or "").strip():
            raise core.NightshiftError(f"item {i}: needs text and kind defect|wish")
    return data


REQ_RE = re.compile(rf"^{core.REQ_ID}$")


def approved_requirement(ref: str, baseline: dict[str, Any], spec_path: Path) -> tuple[str | None, str]:
    """(verbatim spec.md line, why): an FR/SC id the approval covered, or (None, reason)."""
    spec = core.parse_spec(spec_path) if spec_path.is_file() else None
    if spec is None or ref not in spec.requirements:
        return None, f"{ref} is not a requirement in spec.md"
    quote = core.requirement_text(spec_path, ref)
    if quote == ref:
        return None, f"{ref} has no defining line in spec.md to quote"
    return quote, ""


def classify(root: Path, fdir: Path, items: list[dict[str, Any]], bug: str | None = None) -> dict[str, Any]:
    name = f"bug-{bug}" if bug else fdir.name
    if bug:
        # A bug run's approved refs are the fix's frozen bar (D24).
        bar = {s["ref"]: s["text"] for s in model.freeze_bug_bar(root, model.bug_dir(root, bug))["scenarios"]}
        approved = {ref: {"quote": text} for ref, text in bar.items()}
    else:
        record = core.load_record(core.record_path(root, name))
        baseline = (record.get("approval") or {}).get("baseline") or {}
        if not baseline:
            raise core.NightshiftError("no approved baseline; feedback cannot be classified as defects")
        approved = baseline.get("acceptance") or {}
    st = nstate.load(root, name)
    fb = st.setdefault("feedback", {})
    corrections, wishes, refused = [], [], []
    for it in items:
        text, kind = str(it["text"]).strip(), it["kind"]
        key = item_key(text)
        if key in fb:
            (corrections if fb[key]["route"] == "correction" else wishes).append({**fb[key], "unchanged": True})
            continue
        if kind == "defect":
            ref = str(it.get("criterion") or "").strip()
            if ref in approved:
                quote = approved[ref].get("quote", "")
            elif bug:
                quote, why = None, (f"{ref or 'no criterion'} is not in the fix's bar ({', '.join(approved)})")
            elif REQ_RE.match(ref):
                quote, why = approved_requirement(ref, baseline, fdir / "spec.md")
            else:
                quote, why = None, (f"{ref} is not an approved acceptance criterion" if ref else
                                    "a defect must cite an approved acceptance criterion or requirement")
            if quote is None:
                refused.append({"text": text, "criterion": ref or None,
                                "reason": why + "; re-file it as a wish (new intent goes to Spec Kit)"})
                continue
            n = 1 + sum(1 for k in st["pieces"] if k.startswith("correction-"))
            pkey = f"correction-{n}"
            nstate.add_piece(st, pkey, "fix" if bug else "build", "correction", bar_refs=[ref], source=text)
            entry = {"route": "correction", "piece": pkey, "criterion": ref,
                     "quote": quote, "text": text, "at": nstate.now()}
        else:
            entry = route_wish(root, name, text, key)
        fb[key] = entry
        (corrections if entry["route"] == "correction" else wishes).append(entry)
    nstate.save(root, name, st)
    for c in corrections:
        if not c.get("unchanged"):
            nstate.log(root, name, st, piece=c["piece"], step="feedback", outcome="correction",
                       detail=f"defect against {c['criterion']}: {c['text']}")
    for w in wishes:
        if not w.get("unchanged"):
            nstate.log(root, name, st, piece="feature", step="feedback", outcome="route-to-speckit",
                       detail=w["text"])
    for r in refused:
        nstate.log(root, name, st, piece="feature", step="feedback", outcome="defect-refused",
                   detail=f"{r['text']}: {r['reason']}")
    return {"corrections": corrections, "wishes": wishes, "refused": refused}


def route_wish(root: Path, name: str, text: str, key: str) -> dict[str, Any]:
    route = nstate.run_dir(root, name) / "route-to-speckit.md"
    if not route.exists():
        route.write_text("# Route to Spec Kit\n\nNew or changed intent from feedback (D-FB). "
                         "Run `/speckit-clarify` or edit the spec; Nightshift writes no code for these.\n",
                         encoding="utf-8")
    with route.open("a", encoding="utf-8") as fh:
        fh.write(f"\n- [ ] {text} <!-- {core.MARKER_PREFIX} wish key={key} at={nstate.now()} -->\n")
    return {"route": "speckit", "file": str(route.relative_to(root)), "text": text, "at": nstate.now()}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--feature", help="feature directory")
    ap.add_argument("--json", action="store_true", help="print JSON")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("classify")
    c.add_argument("--file", required=True, help="JSON list of {text, kind: defect|wish, criterion?: USn/ACm|FR-###|SC-###}")
    c.add_argument("--feature", default=argparse.SUPPRESS)
    c.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
    for parser in (ap, c):
        parser.add_argument("--bug", metavar="SLUG", default=argparse.SUPPRESS,
                            help="a fix run (bug-<slug>) instead of a feature")
    args = ap.parse_args(argv)
    root = core.find_project_root()
    bug = getattr(args, "bug", None)
    fdir, _ = model.run_target(root, args.feature, bug)
    out = classify(root, fdir, load_items(Path(args.file)), bug)
    if args.json:
        core.emit_json(out)
    else:
        for x in out["corrections"]:
            print(f"correction  {x['piece']} against {x['criterion']}: {x['text']}")
        for x in out["wishes"]:
            print(f"to spec kit {x['file']}: {x['text']}")
        for x in out["refused"]:
            print(f"REFUSED     {x['text']}: {x['reason']}")
    return 1 if out["refused"] else 0


if __name__ == "__main__":
    core.run_main(main)
