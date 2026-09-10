# Drift

Drift watches Claude Code sessions running in VS Code, captures what
actually happened during each one, and — with your explicit approval — can
suggest a course correction when it detects the agent stuck in a low-value
loop: repeating a failing command, re-exploring the same dead end,
duplicating work across subagents.

Everything runs locally. Session capture, trajectory analysis, and the
semantic classifier that looks for stalled patterns all run on your own
machine using a small local model — never a cloud LLM, and nothing about
your session is sent anywhere.

## What it does

- **Captures** Claude Code's own hook events (tool calls, prompts, subagent
  activity) into a local SQLite database as they happen.
- **Analyzes**, only when you explicitly ask for it, using deterministic
  pattern detection plus a local model classifier to identify repeated
  failures, redundant exploration, and duplicate subagent work.
- **Reports** findings in a dedicated view, with a Trajectory Inspector and
  an end-of-session report — always showing the objective evidence behind a
  finding, never a fabricated confidence score.
- **Suggests a redirect**, only for the clearest cases, and only after you
  review and approve the exact wording. Drift never edits a session or
  sends anything to Claude automatically.

## Architecture

```
 Claude Code CLI
       │  hook events (SessionStart, PostToolUse, UserPromptSubmit, ...)
       ▼
 hookBridge.js  ──────────────►  Drift local HTTP runtime (127.0.0.1, random port)
 (per-workspace .claude/settings)          │
                                           ▼
                                   local SQLite database
                                   (VS Code extension storage)
                                           │
                          ┌────────────────┼─────────────────┐
                          ▼                ▼                 ▼
                 Trajectory build   Local model classifier   VS Code views
                 (deterministic)    (llama.cpp + Gemma,      (Findings,
                                     on-demand only)          Inspector,
                                                               Session Report)
                                           │
                                           ▼
                          Redirect packet → your review → Approve/Cancel
                                           │
                                  (only if approved)
                                           ▼
                      Injected as context on the session's next prompt
```

No step in this pipeline calls out to a cloud service. The local model
process is started on demand for an analysis and closed afterward — it is
never kept running in the background.

## Installation

1. Install **Drift** from the VS Code Extensions view (or `.vsix` if you
   were given one directly).
2. Open the Drift icon in the Activity Bar. The sidebar shows three setup
   rows — Runtime, Local Model, Claude Hooks — each one tells you what's
   missing and is clickable when it needs your attention. No terminal
   required.

## Claude Code setup

Open a workspace where you run [Claude Code](https://claude.com/claude-code)
and either click **Claude Hooks: Not Configured** in the sidebar, or run
**Drift: Configure Claude Code Hooks** from the Command Palette. This writes
a `.claude/settings.local.json` entry that points Claude Code's own hooks at
Drift's local runtime, so Drift can capture your sessions. It only ever adds
hooks — it does not touch anything else in your Claude Code configuration.

## Local model setup

Click **Local Model: Not Installed** in the sidebar, or run **Drift: Setup
Local Model**. This downloads two things into VS Code's own per-extension
storage — never into your workspace, and never bundled in the extension
itself:

- a quantized local Gemma model (~2GB, GGUF format)
- a self-contained `llama.cpp` inference runtime (~11MB, no Homebrew or
  other system dependency required)

Both are verified by SHA-256 checksum after download. This is a one-time
step — Drift detects the existing, verified install on every later launch
and never re-downloads or re-analyzes anything automatically.

## Privacy

- Session data lives in a local SQLite database under VS Code's own
  per-extension storage on your machine.
- Semantic analysis runs against a local model process on your machine —
  Drift never calls a cloud LLM for this.
- Nothing is uploaded anywhere unless you explicitly enable OpenTelemetry
  trace export (`drift.otlp.enabled`, off by default) and point it at a
  collector you control.
- A suggested redirect is never sent to Claude Code without your explicit,
  per-instance approval.

## Supported platforms

**macOS on Apple Silicon (darwin-arm64) only**, for both the extension host
and the packaged local inference runtime. This build declares that target
platform explicitly and will not install on Windows, Linux, or Intel Macs.
Support for other platforms may follow but is not implied by this release.

## Screenshots

Not included in this release — we'd rather ship without one than publish a
screenshot that doesn't reflect real, current UI. This will follow in a
later update.

## Limitations

- Claude Code is the only supported coding agent today.
- The local model and runtime are a genuine one-time download (~2GB
  combined); there is no lightweight mode.
- Redirects require your explicit approval every time — Drift does not
  learn preferences or auto-approve over time.
- Detection is pattern-based plus a local classifier; it is not a general
  correctness checker and will not catch every low-value pattern, nor is it
  guaranteed to never surface a borderline case.
- The benchmark harness described below is a developer/research tool used
  to validate Drift's own effect — it is not exposed as an end-user
  feature in this release.

## Benchmark methodology summary

Drift includes an internal benchmark harness used to check its own central
claim: that an approved redirect can reduce target-model compute use
*without* costing task success. It works by running the **same task twice**
from byte-identical starting workspace state — once as an unmodified
control session, once as a treatment session where Drift's normal
detect → approve → inject pipeline is live — under the same prompt, model,
and tool/permission settings, then evaluating both with an explicit,
non-LLM pass/fail check (never Claude's own self-report).

A trial only counts toward an "avoided compute" figure when **all** of the
following hold:
- both control and treatment actually passed their task's evaluator,
- a real, delivered-and-consumed redirect occurred on the treatment side,
- and a valid, matched comparison exists between the two runs.

Every trial that doesn't meet this bar is excluded from that accounting
and the exclusion reason is recorded explicitly — never silently dropped
and never averaged in as a zero. The result is reported as an **observed
paired reduction** / **benchmark-estimated avoided compute**, scoped
strictly to the eligible pairs it came from — never as a general "Drift
saves X%" product claim. Energy and carbon impact are always reported as
`not_measured`; Drift does not convert token counts into an energy or
carbon estimate.

## Status

Drift is an early, actively developed extension (v0.1.0). Interventions
require your explicit approval at every step — nothing is applied to a
session automatically. See [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

[MIT](LICENSE)
