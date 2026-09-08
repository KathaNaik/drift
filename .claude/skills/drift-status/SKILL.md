---
name: drift-status
description: Report where Drift stands — completed and current milestones, what is next, blockers, and test status. Read-only and lightweight.
allowed-tools: Read, Grep, Glob, Bash(git *), Bash(ls *), Bash(rg *)
disable-model-invocation: true
---

# Drift Status

Inspect the repository and report current state. Keep it cheap: read the
milestone/roadmap docs, the source tree layout, and recent git history. Do not
read the whole codebase, and do not modify anything.

For `test_status`, report what the repository shows. Run the test suite only if
it is fast and the result is not already evident; otherwise say `not run`
rather than guessing.

## Required output

Return only this block. One short line per field — a phrase, not a paragraph.

```text
completed:
current:
next:
blockers:
test_status:
```
