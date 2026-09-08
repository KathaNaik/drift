---
name: drift-milestone
description: Implement exactly one Drift milestone, end to end, with tests and a fixed completion report. Manually invoked only.
argument-hint: <milestone id or specification>
disable-model-invocation: true
---

# Drift Milestone

Implement exactly one milestone of Drift. The milestone specification is:

$ARGUMENTS

## Scope

One milestone. Nothing before it, nothing after it.

## Procedure

1. Read only the files needed to understand the requested milestone. Do not
   survey the whole repository.
2. Implement only that milestone.
3. Do not add future functionality, hooks for later milestones, or
   speculative extension points.
4. Add or update tests for the new behavior.
5. Run the narrowest relevant tests — the single file or suite covering the
   change, not the full suite, unless the change is genuinely global.
6. Verify every stated acceptance criterion before stopping. Check them one by
   one against actual observed behavior, not against your intent.
7. Do not perform unrelated cleanup or refactoring. If you notice unrelated
   problems, report them as blockers instead of fixing them.

## Constraints

- Respect the project rules in `.claude/CLAUDE.md`.
- Semantic analysis uses the packaged local model, never a cloud LLM.
- Preserve existing passing behavior. If a previously passing test fails,
  that is a blocker, not something to update away.

## Required report

End your response with exactly this block and nothing after it:

```text
DONE
files: <changed files>
tests: <commands + pass/fail>
acceptance: <pass/fail>
blockers: <none or short description>
```
