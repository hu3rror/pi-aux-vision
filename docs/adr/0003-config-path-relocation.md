# Config path relocation to <agent-dir>/extensions/

The extension used to store its configuration at `~/.pi/agent/aux-vision.json`, directly in pi's agent root. That diverges from pi's convention that per-extension user configuration lives under `<agent-dir>/extensions/`, pollutes the agent dir, and resolves the path by hardcoding a subdirectory of pi's own files instead of following the official layout. The config path is now `<agent-dir>/extensions/aux-vision.json`, derived from pi's official `getAgentDir()` (honoring `PI_AGENT_DIR`); the old location is kept only as a read fallback for existing installs.

**Considered Options**:

- Keep the single path at the agent root (status quo): no migration burden, but the extension's private config keeps mixing with pi's own files and the location stays off-convention.
- Canonical at `extensions/` + legacy read-only fallback (chosen): reads try the canonical file first and fall back to the legacy file only when the canonical one is absent; writes always target the canonical path, so migration is lazy and automatic on the next save. The two files are selected whole, never field-merged; if the canonical file exists but is corrupt, the read returns `null` rather than silently falling back to a possibly stale legacy file.
- Eager copy on startup (legacy → canonical at every load): an extra side effect on every session start that lazily-on-save migration already makes unnecessary.
- A dedicated migration command: rejected — migration happens automatically on the next save, so a command would exist only for a step users never need to run.

**Consequences**: new installs write `<agent-dir>/extensions/aux-vision.json`; existing installs keep their legacy file working until the next save migrates it (the legacy file itself is left untouched and remains a compatibility anchor). When a session reads the legacy file, a one-time per-session notification states that legacy config is in effect and that the next save migrates it — without directing any command. README (EN + zh-CN mirror) documents the new location.
