# Exhaustive transcription base for describe_image

Main models without image input depend entirely on `describe_image`'s text result, so a narrow answer to the caller's question leaves them unable to reason about the image — and they fall back to writing their own brute-force OCR scripts. We make every `describe_image` result begin with an exhaustive transcription base (image-type classification, verbatim transcription of all visible text, layout/order), followed by the answer to the question and a completeness attestation, and we surface `stopReason: "length"` truncation explicitly instead of silently returning a partial base.

**Considered Options**:

- Caller-gated detail (an `exhaustive: true` parameter): the blind main model is the least able to judge when it needs more detail, reintroducing the original failure mode.
- Auto-retry with a raised token cap on truncation: a cost/latency spiral; surfacing the truncation and letting the caller re-ask a focused question keeps control where it belongs.
- Always-on exhaustive base (chosen): calling the tool is already the "image content matters" signal, so the always-on token cost is accepted in exchange for a complete base.

**Consequences**: results are larger (default `maxOutputTokens` raised from 4096 to 8192); the attestation line either guarantees the base is complete or explicitly says it is not; existing installs keep their saved `maxOutputTokens` and can raise it manually in `~/.pi/agent/aux-vision.json`.
