# Agent instructions

## Agent skills

### Issue tracker

Issues and specs live in the repo's GitHub Issues, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (one `GLOSSARY.md` + `docs/adr/` at the repo root). See `docs/agents/domain.md`.

### Releases

发布流:`push refs/tags/vX.Y.Z` 触发 `.github/workflows/publish.yml` 经 Trusted Publisher(OIDC)直接把当前版本发布到 npmjs——**tag push 即发布,全自动,无人工 2FA 闸门**。Agent 负责 bump 版本、commit、打 annotated tag、push(`git push origin main` + `git push origin refs/tags/vX.Y.Z`),workflow 发布成功后撰写分类发布说明,用 `gh release edit` 覆盖 workflow 建的占位 Release(见 npm-release skill)。错误回滚:`npm unpublish <version>`(72 小时内,需本地登录态;超期用 `npm deprecate`)。前置:维护者在 npmjs.com 确认 Trusted Publisher 的 Allowed actions 允许 `npm publish`(直接发布),只允许 stage 时 CI 会 403。
