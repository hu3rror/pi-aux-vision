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
