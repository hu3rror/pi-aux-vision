<div align="center">

# pi-aux-vision

Adds a `describe_image` tool so text-only Pi models can see.

[![npm version](https://img.shields.io/npm/v/pi-aux-vision)](https://www.npmjs.com/package/pi-aux-vision)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

[中文](README_zh-CN.md)

</div>

A Pi extension that registers a `describe_image` native tool. The main model — text-only models like `deepseek-v4-flash` — decides when to call it, passes an image path and a specific question, and the extension routes the call through pi's official pipeline to a configured vision model. The result returns as a `tool_result` in the conversation context.

Models with native vision read images themselves and never see the tool.

## Features

- **Vision gating** — `describe_image` is declared only to models that lack image input; visibility follows model switches and session restore, shown in `/vision status`.
- **Auto-discovery** — no config on first run: the extension finds the first authenticated image-capable model and writes it to disk.
- **Routes through pi's SDK** — auth, protocol serialization, and retries all go through `ctx.modelRegistry.complete`, supporting `google-generative-ai`, `openai-completions`, and `anthropic-messages`.
- **Transcription base** — every result starts with an exhaustive image-type + verbatim text transcription, then answers the question, then a completeness attestation.
- **10 MB ceiling** — pi's `resizeImage` compresses oversized images before rejection.
- **TUI footer** — after the first `describe_image` call or `/vision test` of a session, the footer shows `vision: provider/model` until the session ends; a failed call appends a `!` in error color.

## Install

```bash
pi install npm:pi-aux-vision
```

Try without installing:

```bash
pi -e npm:pi-aux-vision
```

Manual: drop the `pi-aux-vision/` directory under `~/.pi/agent/extensions/`, then run `/reload` in Pi.

## Commands

| Command | Description |
|---|---|
| `/vision status` | Current provider/model, protocol, enabled state, footer switch, and gating state |
| `/vision set <provider> <model>` | Set a vision model explicitly and enable it; writes to config |
| `/vision list` | List available (authenticated) image models, marking the current one |
| `/vision enable` / `/vision disable` | Toggle; while disabled — or when the current model has native vision — `describe_image` is hidden |
| `/vision test [path]` | Verify the full pipeline with an auto-generated test image; optional custom path |

## Configuration

`<agent-dir>/extensions/aux-vision.json`, derived from pi's official `getAgentDir()` (so `PI_AGENT_DIR` is honored):

```json
{
  "enabled": true,
  "provider": "google",
  "model": "gemini-2.5-flash",
  "maxOutputTokens": 8192,
  "maxRetries": 2,
  "maxRetryDelayMs": 5000,
  "showInFooter": true
}
```

- `enabled` — when `false`, `describe_image` is hidden from the main model
- `provider` / `model` — the vision model used for `describe_image` calls
- `maxOutputTokens` — output token cap. Every result begins with an exhaustive transcription base, so dense screenshots need a larger budget; when the cap is hit the tool prepends an explicit truncation notice instead of silently returning a partial base
- `maxRetries` — retry count (initial + N attempts; 4xx is not retried, handled by the official pipeline)
- `maxRetryDelayMs` — backoff ceiling, in milliseconds
- `showInFooter` — show `vision: provider/model` in the TUI footer after the first `describe_image` call or `/vision test` of a session (default `true`)

> [!NOTE]
> The legacy path `~/.pi/agent/aux-vision.json` (pre-0.4.0) is honored only while the new file does not exist. Once the new file exists it takes precedence, and every write targets it. The legacy file is left untouched.

## Tool

`describe_image(image_path, question)` — read from disk → encode → single vision-model call → text result.

- `image_path` — absolute path or path relative to the working directory; supports png / jpeg / gif / webp / bmp
- `question` — a specific question, e.g. "extract the stack trace shown in line 4 of the error message" or "why is the button shifted 10px to the right?"

The vision model answers in the language of the question. Errors (file not found, unsupported format, call failure) return as structured text for the main model to handle — no confirmation dialogs.

### Codemode scripts

The tool declares an `outputSchema`, so [codemode](https://github.com/earendil-works/pi-coding-agent) scripts receive a machine-readable `structuredContent` instead of the text: `{ ok, model, usage, transcription, truncated, resize_note? }` on success, `{ ok: false, error }` on expected failure. That lets a script batch-call `describe_image` in parallel, filter by `ok` / `truncated` / `error`, and keep the transcription base entirely inside the script, returning only a summary to the main model:

```js
// @options: {"timeout_ms": 300000}
const files = ["/tmp/shot-a.png", "/tmp/shot-b.png", "/tmp/shot-c.png"];
const results = await Promise.allSettled(
  files.map((f) =>
    tools.describe_image({
      image_path: f,
      question: "Extract every error message verbatim. If there is none, say OK.",
    }),
  ),
);
const summary = results.map((r, i) => {
  if (r.status === "rejected") return { image: files[i], error: String(r.reason) };
  if (!r.value.ok) return { image: files[i], error: r.value.error };
  return { image: files[i], truncated: r.value.truncated, transcription_chars: r.value.transcription.length };
});
return { failed: summary.filter((s) => s.error).length, items: summary };
```

The example deliberately does not parse the transcription text — the tool's contract keeps it a plain string (ADR-0005), so scripts rely on the programmatic fields (`ok`, `error`, `truncated`, `usage`) and drop the text. When you need the actual answer for one image, call `describe_image` on it directly; the transcription then enters the main model's context as the model's deliberate choice.

This capability is **dormant until codemode is enabled** — add `"codemode"` to `defaultTools` in your pi settings (`~/.pi/agent/settings.json`), e.g. `"defaultTools": ["+codemode"]`. Without it, the tool, its gating, and its error contract behave exactly as before; the structured fields simply have no consumer.

## Compatibility

Verified against pi `1.0.0`. The peer dependency range stays `"*"`; the source type-checks against the current SDK via `npm run typecheck`. Structured results (`outputSchema`) and codemode require pi `1.0.0+`; on older pi versions the tool falls back to its text-only contract.

## Development

```bash
npm test          # bundle modules + mocked pi deps via esbuild, then run the suite
npm run typecheck # type-check source against the current pi SDK
```

`.test/` covers config read/write (canonical + legacy paths), model discovery, `describe_image` success/failure paths, test-image generation, the footer state machine and wiring, and vision gating.
