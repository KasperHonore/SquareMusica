# Local changes to this preset

**Modified 2026-09-12. Not upstream. Do not `specify preset upgrade` without re-reading this.**

## What was wrong

The upstream preset v1.0.0 advertises itself as a "pure presentation-layer change"
(Markdown tables → `AskUserQuestion`). It is not. Applied to this repo it also deleted a
body of hardening that had been committed in `9818679`:

| Removed upstream | Why it matters here |
|---|---|
| Clarify step 9 — re-validation of `checklists/requirements.md` | `speckit-implement` uses checkbox state as a **hard gate**; without re-validation a stale all-`[x]` checklist waves implement straight through |
| Constitution load (both skills) | `.specify/memory/constitution.md` is declared **binding** by CLAUDE.md |
| Question-writing quality rules (clarify) | The anti-pattern guard against bare topic labels as questions |
| Mandatory-hook enforcement — "you MUST actually invoke the hook" | Mandatory hooks could be *printed* rather than *run* |
| Loud `extensions.yml` parse failure → silent skip | A malformed file would silently disable mandatory hooks |
| Checklist checkbox-ownership contract | The skill could mark its own generated items `[x]` |
| `--template checklist-template` / `TEMPLATE_CONTENT` | Bypassed the template override stack |

The preset also emitted five `/speckit.foo` dot-form command references into a repo whose
`.specify/integration.json` sets `"invoke_separator": "-"`.

## What was done

`commands/speckit.clarify.md` and `commands/speckit.checklist.md` were **rebuilt** as:

> the repo's hardened command body at git `9818679`, with only the preset's
> `AskUserQuestion` presentation blocks spliced in.

The generated skills (`.claude/skills/speckit-{clarify,checklist}/SKILL.md`) were rebuilt
the same way. Net diff against `9818679` is now **+20/−18** — the presentation swap alone,
down from the preset's original +75/−123. Dot-form references are gone.

Result: the `AskUserQuestion` UX is kept, and every item in the table above is restored.

## Outstanding — this change is NOT durable

`.specify/integrations/claude.manifest.json` still records the **pre-preset** SHA-256 for
both skills (verified: the recorded hashes hash exactly to the `9818679` versions). The
`specify` CLI is **not installed in this environment**, so the manifest could not be
updated legitimately — hand-editing it would defeat its purpose as a drift detector.

Consequences, in order of likelihood:

1. A future `specify` refresh/upgrade will see both skills as drifted and may silently
   restore the `9818679` versions — losing the `AskUserQuestion` UX (but *not* the
   hardening, which those versions already have). This is the safe direction to fail.
2. `.specify/presets/` is untracked and **not** gitignored. It is lost on a fresh clone.
   Commit it if this work should survive.
3. `.registry`'s `manifest_hash` for this preset is now stale. That is arguably useful —
   it surfaces the divergence rather than hiding it — but a preset upgrade will conflict.

**To make it durable**: install the Specify CLI, re-apply the preset from this directory,
and let the CLI rewrite `claude.manifest.json` itself.
