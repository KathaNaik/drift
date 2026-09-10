# Changelog

All notable changes to Drift are documented here.

## 0.1.0 — Initial Marketplace release

macOS Apple Silicon (darwin-arm64) only.

### Added
- Local capture of Claude Code hook events into a per-workspace SQLite
  database, with a background local HTTP runtime and OTLP trace export
  (off by default).
- Deterministic detection of repeated commands, repeated failures,
  retries without state change, and duplicate subagent work.
- On-demand semantic classification of detected patterns using a packaged
  local model (never a cloud LLM), with post-hoc consistency validation
  against the objective evidence.
- A Findings view, Trajectory Inspector, and end-of-session report in the
  VS Code sidebar.
- Human-approved redirect packets: Drift can prepare a suggested course
  correction for a clearly stalled session, but only delivers it to Claude
  Code after explicit approval, and never edits a session automatically.
- Managed local model and runtime setup (`Drift: Setup Local Model`):
  the model and its local inference runtime are downloaded into VS Code's
  own extension storage on first use, verified by checksum, and never
  bundled inside the extension package or silently re-downloaded.
- A repeatable benchmark harness (not exposed as a user-facing feature
  yet) for measuring, under controlled matched trials, whether an approved
  redirect preserves task success while reducing target-model usage.
- A sidebar setup checklist (Runtime / Local Model / Claude Hooks) with
  clickable rows for anything not yet configured, so first-run setup
  requires no terminal or Command Palette knowledge.
