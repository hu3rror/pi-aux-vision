# pi-aux-vision

A pi extension that gives the main model a `describe_image` tool: image analysis is routed through pi's official pipeline to a configured vision model. The extension owns model selection (provider/model), and a session-scoped footer indicator that shows the current model selection once a session has used the tool.

## Language

**footer status / footer 状态**:
The model indicator the TUI footer shows once a session has seen its first describe_image call — success or failure, even one that never reached a model: `vision: provider/model`, with a `!` while the most recent call failed. It reflects the current model selection, re-read on every event (so not necessarily the model that served the session's calls); new sessions start hidden, and the `showInFooter` switch controls whether it can appear at all.
_Avoid_: footer 显示,状态栏

**footer controller / footer 控制器**:
The session-scoped, event-driven module that owns the footer: it holds the session's call history, re-reads the current model selection on every event, and renders footer status into the TUI. One instance lives for the extension's lifetime and resets its state at each new session.
_Avoid_: footer 接线,footer 状态机

**footer event / footer 事件**:
The vocabulary the extension uses to tell the footer controller what happened: `reset` (new session), `call` (a describe_image invocation completed — success or failure, even one that never reached the model), `set`/`enable` (model selection changed), `disable` (extension disabled). `reset` and `call` change the controller's state; `set`/`enable`/`disable` only trigger a re-read of the selection.

**model selection / 模型选择**:
The provider/model pair configured for vision analysis. The extension owns it, it can change mid-session via /vision set / enable / disable, and the footer always reflects the current selection, re-read from disk on every event.

**tool result contract / 工具结果契约**:
The shape of the `details` field every `describe_image` result carries: `{ model, usage }` on success, `{ error: string }` on expected failure. Expected failures are returned with the error text in `content`, never signaled by throwing (see ADR-0001).
_Avoid_: throw-based error signaling

**transcription base / 转录底座**:
The exhaustive dump every `describe_image` result must begin with, regardless of the question: image-type classification, verbatim transcription of all visible text (untranslated), and layout/reading order. A non-visual main model reasons from this base, so its completeness must not depend on how precisely the question was asked (see ADR-0002).
_Avoid_: 简述,图片摘要,image summary

**completeness attestation / 完整性自证**:
The mandatory closing line of a `describe_image` result stating that all visible text was transcribed exhaustively, or that no readable text was found. It tells the non-visual main model the base is complete, so it stops suspecting the vision model "didn't really look".
_Avoid_: 保证句

**truncation surfacing / 截断显式化**:
Detecting `stopReason: "length"` (output hit the token cap) and prepending an explicit notice — phrased in the question's language — that the transcription base may be incomplete, instead of silently returning a partial base and leaving the non-visual main model to guess.
_Avoid_: 静默截断
