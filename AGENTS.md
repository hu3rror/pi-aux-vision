# Agent instructions

## Agent skills

### Issue tracker

Issues and specs live in the repo's GitHub Issues, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (one `CONTEXT.md` + `docs/adr/` at the repo root). See `docs/agents/domain.md`.

### Releases

发布流:`push refs/tags/vX.Y.Z` 触发 `.github/workflows/publish.yml` 自动把当前版本 staging 到 npm 暂存区(不直接发布)。Agent 负责 bump 版本、commit、打 annotated tag、push(`git push origin main` + `git push origin refs/tags/vX.Y.Z`),然后停下交还;最终发布由维护者本地执行 `npm stage approve <stage-id>`(2FA 证明在场),Agent 不代跑。错误暂存可 `npm stage reject <stage-id>`(2FA)。
