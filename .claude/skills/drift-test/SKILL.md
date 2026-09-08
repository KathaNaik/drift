---
name: drift-test
description: Validate that a Drift milestone actually works — run the narrowest proving tests, check regressions and stale mocks, and report PASS/FAIL. Validation only; does not implement.
argument-hint: <milestone id or specification>
disable-model-invocation: true
---

# Drift Test

Validate the following milestone. Do not implement it.

$ARGUMENTS

## Rules

- Inspect the requested milestone and its acceptance criteria first.
- Do not modify production code unless the user explicitly asked for a fix in
  this invocation. Test files may be read; only add or adjust tests if asked.
- Run the narrowest tests that prove the milestone works. Prefer a single file
  or suite over the full test run.
- Check relevant regression risk: the code paths this milestone touched and
  their immediate callers.
- Verify that mocked behavior has not replaced functionality that should now be
  real. A milestone that was supposed to make something real, but is still
  satisfied by a stub, fixture, or hardcoded return, is a FAIL.
- Semantic analysis must be exercised through the packaged local model, not a
  cloud LLM. A test that passes only because a cloud call was mocked in is a
  FAIL.

## Verdict

- `PASS` only when every acceptance criterion is demonstrated by an actually
  executed test or observed behavior.
- `FAIL` if any criterion is unproven, any relevant test fails, or a mock is
  standing in for functionality the milestone required to be real.

## Required output

Return only this block, with nothing before or after it:

```text
TEST_RESULT: PASS | FAIL
failed: <none or concise list>
regressions: <none or concise list>
```
