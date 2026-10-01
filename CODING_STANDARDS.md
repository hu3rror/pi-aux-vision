# Coding Standards

Rules for code written in this repository. Agent behavior rules live in `AGENTS.md`; trade-off rationale and rejected alternatives live in ADRs. Extend this file as the repo's conventions crystallize.

## Comments

- Default to no comments. Let names and structure make the code self-explanatory.
- Write comments only for reasons the code itself cannot express: hidden constraints, counterintuitive behavior, historical pitfalls, and special compatibility requirements.
- Put trade-off rationale and rejected alternatives in ADRs, not in code comments.

## Repository conventions

- Rationale comments reference the governing ADR by number (e.g. `转录底座契约(ADR-0002)`) and stay one-liners. ADRs live in `docs/adr/` as `NNNN-slug.md`: a one-paragraph context, then `**Considered Options**` and `**Consequences**`.
- Domain terms are captured in the root `GLOSSARY.md` as `**term / 中文术语**: definition` entries with an `_Avoid_: ...` usage line; single-context layout (no `GLOSSARY-MAP.md`).
- Commit subjects use Conventional Commits prefixes (`feat:` / `fix:` / `refactor:` / `chore:` / `docs:`).
- Changes are verified with `npm run typecheck` and `npm test` before hand-off.

## Out of scope

- Updating or merging an existing standards file: the human decides what changes.
- Writing ADRs: rationale belongs in ADRs, and the doc points there.
