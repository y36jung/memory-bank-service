## Approach

- Read existing files before writing. Don't re-read unless changed.
- Thorough in reasoning, concise in output.
- Skip files over 100KB unless required.
- No sycophantic openers or closing fluff.
- No emojis or em-dashes.
- Do not guess APIs, versions, flags, commit SHAs, or package names. Verify by reading code or docs before asserting.

## Context

Read these before making any changes:

- `docs/AGENT_CONTEXT.md` — architecture, invariants, schema, and code patterns
- `docs/PROJECT.md` — design rationale and implementation roadmap
- `docs/TICKETS.md` — ticket specs; read the relevant ticket before implementing anything
