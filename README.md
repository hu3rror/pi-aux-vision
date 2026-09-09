# pi-aux-vision

[中文](README_zh-CN.md)

Registers a `describe_image` native tool for Pi: the main model (e.g. `deepseek-v4-flash`, which has no image input) decides when to call it, passes an image path and a specific question, and the extension routes the request through pi's official pipeline to a configured vision model. The result comes back as a `tool_result` in the conversation context.

## Install

```bash
pi install npm:pi-aux-vision
```

Or to try it without installing:

```bash
pi -e npm:pi-aux-vision
```

Manual install: drop the `pi-aux-vision/` directory under `~/.pi/agent/extensions/`, then run `/reload` in Pi.

## How it works

- On startup, reads `~/.pi/agent/aux-vision.json`; with no config, auto-discovers the first available (authenticated, image-capable) vision model and writes it to the config. Falls back automatically when the configured model becomes unavailable.
- Auth, protocol serialization, and retries all go through pi's official pipeline (`ctx.modelRegistry.complete`), supporting `google-generative-ai`, `openai-completions`, and `anthropic-messages` protocols.
- Image limit is 10 MB (the intersection of the three providers' limits); oversized images are compressed with pi's official `resizeImage` before failing.
- After the first `describe_image` call of a session (success or failure), the TUI footer shows `vision: provider/model` until the session ends — dim `vision:` prefix, accent model name, and a `!` in error color after a failed call. New sessions start hidden; toggle with `showInFooter`.

## Configuration

`~/.pi/agent/aux-vision.json`:

```json
{
  "enabled": true,
  "provider": "google",
  "model": "gemini-2.5-flash",
  "maxOutputTokens": 4096,
  "maxRetries": 2,
  "maxRetryDelayMs": 5000,
  "showInFooter": true
}
```

- `maxRetries`: retry count (initial + N attempts; 4xx is not retried, handled by the official pipeline)
- `maxRetryDelayMs`: backoff ceiling, in milliseconds
- `showInFooter`: show the `vision: provider/model` status in the TUI footer after the first `describe_image` call of a session (default `true`)

## Commands

| Command | Description |
|---|---|
| `/vision status` | Current provider/model, protocol, enabled state, footer switch |
| `/vision set <provider> <model>` | Set a vision model explicitly and enable it, writes to config |
| `/vision list` | List available (authenticated) image models, mark the current one |
| `/vision enable` / `/vision disable` | Toggle; when disabled, `describe_image` is hidden from the main model |
| `/vision test [path]` | Verify the full pipeline with an auto-generated test image; optional custom path |

## Tool

`describe_image(image_path, question)` — read from disk → encode → single vision-model call → text result.

- `image_path`: absolute path or path relative to the working directory; supports png / jpeg / gif / webp / bmp
- `question`: a specific question, e.g. "extract the stack trace shown in line 4 of the error message" or "why is the button shifted 10px to the right?"

The vision model answers in the language of the question. Errors (file not found, unsupported format, call failure) return as structured text for the main model to handle; no confirmation dialogs.

## Test

```bash
npm test
```

or directly:

```bash
node .test/build.js && node .test/test-run.mjs
```

`.test/` bundles the extension modules with mocked pi dependencies via esbuild and covers config read/write, model discovery, `describe_image` success/failure paths, test-image generation, and the footer state machine + wiring.

## License

MIT
