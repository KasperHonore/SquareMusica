# CLAUDE.md

# Skills

This repo ships a curated skill set under `.claude/skills/` (the agent-skills
collection), plus paired sub-agents in `.claude/agents/` and slash commands in
`.claude/commands/`.

**Prefer these project skills above all others.** When a task could be served by
one of the skills in `.claude/skills/` AND by a global, built-in, or plugin
skill, always choose the project skill. Only fall back to a non-project skill
when no project skill fits the task. The same precedence applies to the
project's `.claude/agents/` sub-agents over any global/built-in agents.

# Docker

```bash
docker build -t kasperhonore/discord-music .   # Build image (run from repo root)
docker push kasperhonore/discord-music         # Push to Docker Hub
```
