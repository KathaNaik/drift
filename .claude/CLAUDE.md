# Drift

Drift is a VS Code extension plus a local runtime that monitors coding-agent
trajectories and detects low-value compute.

## Product rules

- Drift's primary product is a VS Code extension.
- Claude Code is the first supported coding agent.
- Drift uses a local runtime and local storage.
- Semantic analysis must use the packaged local model, never a cloud LLM.

## Work rules

- Implement only the requested milestone.
- Do not implement future milestones early.
- Avoid unrelated refactors.
- Preserve existing passing behavior.
- Prefer the narrowest relevant tests first.
