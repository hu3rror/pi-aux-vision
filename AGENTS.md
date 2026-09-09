# Agent instructions

## Agent skills

### Issue tracker

Issues and specs live in the repo's GitHub Issues, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (one `CONTEXT.md` + `docs/adr/` at the repo root). See `docs/agents/domain.md`.

### Releases

`npm publish` 由维护者亲自执行(涉及 npm 安全验证)。Agent 负责 bump 版本、commit、打 annotated tag、push(`git push origin main` + `git push origin refs/tags/vX.Y.Z`),然后停下交还;不要代跑 `npm publish`。
