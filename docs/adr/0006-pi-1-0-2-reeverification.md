# Re-verification against pi 1.0.2

pi 1.0.2 is the current release (2026-10-04); the host runs it via mise and npm's `latest` tag points at it. The extension's devDeps pinned pi at `^1.0.0` and type-checked against 1.0.0, so this ADR records the 1.0.0 → 1.0.2 follow: devDeps bumped to `^1.0.2`, and every internal seam re-verified against the new dist — byte-by-byte where the seam is a table, constant, or implementation, by type-check against the public types otherwise. The result: **no source changes were needed**; every 1.0.0 → 1.0.2 diff is additive.

**Seams re-verified** (1.0.0 lockfile dist vs 1.0.2 installed dist):

- Extension API — `registerTool` / `registerCommand` / `on` / `getActiveTools` / `setActiveTools`, `ExtensionContext`, tool result `content` / `details` / `structuredContent`: only additive (`ToolRendererResolver` / `ToolRenderers` and `registerToolRenderer()` added in 1.0.1); no removals or signature changes.
- `outputSchema: TSchema` / `structuredContent: JsonValue` contract: unchanged, so the ADR-0005 codemode structured result and its consistency test hold.
- `details` JSON-compatibility constraint (ADR-0001): unchanged; expected failures still return instead of throw and never set `isError`.
- `modelRegistry.complete` implementation (`core/model-registry.js`): byte-identical. `utils/retry.js` gains `"model is at capacity"` as a retryable error (1.0.1 fix); the official pipeline only retries more, never less — exhausted retries still surface as `stopReason: "error"`.
- `StopReason` union (`"pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`): unchanged, so ADR-0002's `stopReason: "length"` truncation surfacing holds.
- `detectSupportedImageMimeTypeFromFile` / `formatSize` / `resizeImage`: signatures unchanged; `image-convert.js` was refactored internally (PNG transcoder helpers for pi-tui's new `setImageTranscoder`) without changing any export this extension imports.
- pi-tui components this extension renders (`Container` / `SelectList` / `Text` / `DynamicBorder`, `SelectItem`, `AutocompleteItem`): untouched; only `components/image.ts` changed (Kitty/WezTerm JPEG/GIF/WebP rendering, not used here).
- Anthropic `tool_addition` / `tool_removal` blocks now carry inline tool definitions instead of `tool_reference` (1.0.1): affects only tools added or redefined mid-conversation; `describe_image` is registered once at load and never redefined, so the extension is unaffected.
- npm/dependency posture: 1.0.1 removed the published `npm-shrinkwrap.json` and pinned `brace-expansion` 5.0.12 (GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p). After the bump the tree holds a single `brace-expansion@5.0.12`; the vulnerable 5.0.9 nested copy is gone.

**Considered Options**:

- Stay on `^1.0.0` (status quo): no churn, but the verified-against baseline lags two releases and the lockfile keeps the vulnerable nested `brace-expansion` copy.
- Follow to `^1.0.2` with seam re-verification (chosen): devDeps and lockfile bump only; no source, mock, or test changes; behavior unchanged across every release path.
- Adopt new 1.0.1/1.0.2 APIs (`registerToolRenderer`, `samplingParamsByThinkingLevel`): rejected — nothing user-facing in this extension needs them; adopting would be scope creep.

**Consequences**: devDeps and lockfile pin `^1.0.2`; `npm run typecheck` and `npm test` (83 tests) stay green against 1.0.2; minimum supported pi stays 1.0.0 (nothing the extension uses was removed); future pi follows should re-run this checklist against the new dist before touching code. Known remaining audit item: the direct devDependency `esbuild@0.21.5` (GHSA-67mh-4wv8-2f99, dev-server only, not a transitive residue of the pi pin) — fixing requires a breaking major bump and is deliberately out of scope.
