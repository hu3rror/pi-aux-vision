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
The provider/model pair configured for vision analysis. The extension owns it, it can change mid-session via /vision set / enable / disable, and the footer always reflects the current selection, re-read from disk on every event. Distinct from the **session model**, which drives the conversation.
_Avoid_: 视觉模型

**session model / 当前会话模型**:
The model driving the current session (pi's `ExtensionContext.model`), judged by its declared `input` capabilities — distinct from the **model selection**, which is the auxiliary pair configured for vision analysis. Whether it can read images natively decides whether `describe_image` intervenes (see **vision gating**).
_Avoid_: 主模型(易与 model selection 混淆)

**vision gating / 读图介入**:
The rule that `describe_image` is declared to the session model only when the plugin is enabled, an auxiliary vision model is configured and available, and the **session model** lacks image input. Visibility re-evaluates on session start and model switches; vision-capable sessions read images natively without the tool.
_Avoid_: 抢工作,门控开关(它不是配置字段)

**canonical config / 规范配置**:
The configuration file the extension owns at the user level, located per pi's convention for user extensions. It takes precedence over older configuration once present, and every write targets it.
_Avoid_: 配置文件路径

**legacy config / 旧版配置**:
Configuration produced by releases ≤0.3.0, honored only while no canonical config exists; the next configuration change migrates it automatically to the canonical location, and the legacy file itself is left untouched.
_Avoid_: 迁移命令(不存在这样的命令)

**tool result contract / 工具结果契约**:
The shape of the `details` field every `describe_image` result carries: `{ model, usage }` on success, `{ error: string }` on expected failure. Expected failures are returned with the error text in `content`, never signaled by throwing (see ADR-0001). Since the tool declares an `outputSchema`, codemode scripts receive the machine-readable `structuredContent` instead of the text: `{ ok, model, usage, transcription, truncated, resize_note? }` on success, `{ ok: false, error }` on failure (see ADR-0005). The `transcription` string duplicates the `content` text so a script can drop it before returning a summary; direct calls still read `content` and never see the structured fields.
_Avoid_: throw-based error signaling, script-side text parsing

**transcription base / 转录底座**:
The exhaustive dump every `describe_image` result must begin with, regardless of the question: image-type classification, verbatim transcription of all visible text (untranslated), and layout/reading order. A non-visual main model reasons from this base, so its completeness must not depend on how precisely the question was asked (see ADR-0002).
_Avoid_: 简述,图片摘要,image summary

**completeness attestation / 完整性自证**:
The mandatory closing line of a `describe_image` result stating that all visible text was transcribed exhaustively, or that no readable text was found. It tells the non-visual main model the base is complete, so it stops suspecting the vision model "didn't really look".
_Avoid_: 保证句

**truncation surfacing / 截断显式化**:
Detecting `stopReason: "length"` (output hit the token cap) and prepending an explicit notice — phrased in the question's language — that the transcription base may be incomplete, instead of silently returning a partial base and leaving the non-visual main model to guess.
_Avoid_: 静默截断

**seam / 接缝**:
Any point where the extension relies on pi beyond a stable public contract: the SDK types and APIs it imports, the behavior semantics it depends on (`stopReason` values, retry policy, the tool-result contract), and the npm dependency posture. A pi upgrade can change a seam silently (deep `dist/` imports, prototype patches, mirror tables), so every pi follow re-verifies each seam against the new dist before touching code (ADR-0006).
_Avoid_: 内部接口(只指 API 面,漏掉行为语义与依赖姿态),依赖面(只指 npm 侧)
