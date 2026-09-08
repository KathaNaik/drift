---
name: drift-review
description: Read-only architecture review of a Drift milestone range (e.g. M1-M4) against the locked architecture. Returns at most 5 findings by severity. Manually invoked only.
argument-hint: <milestone range, e.g. M1-M4>
allowed-tools: Read, Grep, Glob, Bash(git *), Bash(ls *), Bash(rg *)
disable-model-invocation: true
---

# Drift Review

Review this milestone range:

$ARGUMENTS

Do not modify code. This is a read-only review.

## Check only these

1. **Architecture alignment** — does the code match the locked Drift
   architecture: VS Code extension as the product, local runtime, local
   storage, packaged local model for semantic analysis (never a cloud LLM),
   Claude Code as the first supported agent.
2. **Future scope** — functionality from later milestones implemented early.
3. **Unnecessary abstractions** — interfaces, layers, registries, or plugin
   seams with one implementation and no current need.
4. **Mocks that should be real** — stubs, fixtures, or hardcoded returns
   standing in for behavior these milestones were supposed to make real.
5. **Weak or missing tests** — acceptance criteria with no test, tests that
   assert on the mock rather than the behavior, tests that cannot fail.
6. **Technical debt that blocks the next milestone** — specifically blocking,
   not merely untidy.

Anything outside this list is out of scope. Do not comment on style, naming,
formatting, or preferences.

## Output

At most 5 findings, ordered most severe first. Fewer is better; report only
what you actually found. For each finding give:

- the file and line,
- what is wrong, in one or two sentences,
- which of the six categories it falls under,
- the concrete consequence.

If nothing qualifies, say so in one line.
