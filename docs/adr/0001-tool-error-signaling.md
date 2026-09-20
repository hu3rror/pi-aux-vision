# Tool error signaling: details contract over throw

pi 0.86.0 restricts tool result `details` to JSON-compatible values and derives the transcript `isError` flag from whether `execute` throws, making throw the official error convention. We deliberately keep returning results for expected failures (error text in `content`, `{ error: string }` in `details`), so expected failures like a missing image file keep `isError: false` in the transcript and model-visible behavior stays identical to pre-0.86.0. Moving to throw remains possible but would flip transcript failure semantics, so it needs a real reason.

**Considered Options**:

- Throw on expected failures (official pi convention): transcript `isError` becomes true, changing model-visible behavior for every failed `describe_image` call.
- Return-style with a details contract (chosen): behavior identical to before; the footer controller and tests discriminate success from failure via `details.error`.

**Consequences**: `details` must stay JSON-compatible (`{ model, usage }` on success, `{ error: string }` on failure); the tool's returned `isError` field is not read by the pi harness and must not be relied on.
