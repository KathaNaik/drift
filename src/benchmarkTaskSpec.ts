/**
 * A declarative, reproducible task format for Drift's control/treatment
 * benchmark (see benchmarkRunner.ts for the M13C runner these definitions
 * are meant to feed). This module only defines, validates, and fingerprints
 * task definitions -- it never spawns Claude, never runs a trial, and never
 * computes or compares any measurement. One task definition is used
 * verbatim for BOTH the control and treatment run: there is no separate
 * "treatment prompt" or "treatment config" anywhere in this shape, so the
 * two runs are guaranteed identical except for Drift's own intervention by
 * construction, not by a validation rule bolted on afterward.
 *
 * Benchmark tasks describe normal coding work. Nothing here may encode an
 * instruction engineered to manufacture a redirect_candidate -- Drift must
 * earn an intervention from a task's own natural evidence, exactly as it
 * would for a real user, never from a task author telling Claude to loop.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawnSync } from "child_process";

export interface ClaudeTaskConfig {
  model: string;
  allowedTools: string[];
  permissionMode: string;
}

export interface TaskEvaluatorSpec {
  /** An external, objective command (e.g. "npm test", "pytest", "node test.js") -- exit status is the entire verdict. Never Claude's own response, SessionEnd, or Drift's own findings. */
  command: string;
  timeoutMs: number;
}

export interface TaskExpectedProperties {
  /** Descriptive metadata only (e.g. "bug_fix", "test_failure") -- never consulted by Drift's decision policy. */
  category?: string;
  difficulty?: string;
}

export interface BenchmarkTaskDefinition {
  id: string;
  description: string;
  workspaceTemplate: string;
  /** The exact prompt used for both control and treatment -- one field, one value, used verbatim by both runs. */
  prompt: string;
  claude: ClaudeTaskConfig;
  evaluator: TaskEvaluatorSpec;
  expectedProperties?: TaskExpectedProperties;
  /** Paths (relative to workspaceTemplate) explicitly declared as volatile -- the only files computeWorkspaceFingerprint may ignore. */
  volatileFiles?: string[];
}

export type BenchmarkTaskValidationError = string;

export interface BenchmarkTaskValidationResult {
  success: boolean;
  task: BenchmarkTaskDefinition | undefined;
  errors: BenchmarkTaskValidationError[];
}

export interface BenchmarkTaskSetValidationResult {
  success: boolean;
  tasks: BenchmarkTaskDefinition[] | undefined;
  errors: BenchmarkTaskValidationError[];
}

const VALID_PERMISSION_MODES = new Set(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);

// Matches the milestone's own forbidden examples ("repeat this failure
// three times", "keep retrying", "trigger Drift", "cause a
// redirect_candidate") plus closely related phrasing that equally encodes
// an instruction to manufacture an intervention, without flagging ordinary
// task text that merely happens to mention retries or redirects in passing
// (e.g. a task about fixing retry-loop logic is not itself an instruction
// to loop).
const FORBIDDEN_PROMPT_PATTERNS: RegExp[] = [
  /repeat\s+(this|the|it)\b.{0,30}\b(times|again)\b/i,
  /keep\s+retrying/i,
  /trigger\s+drift/i,
  /redirect_candidate/i,
  /cause\s+a\s+redirect/i,
];

// Field names a task definition must never carry, at the top level or
// inside expectedProperties -- see requirement 8. Matched by substring
// against a lowercased key so "expectedTokenReduction", "sustainabilityTarget",
// "expectedWaste", etc. are all caught without maintaining an exhaustive list.
const FORBIDDEN_FIELD_NAME_PATTERNS: RegExp[] = [/saving/i, /reduction/i, /sustainab/i, /energy/i, /emission/i, /expectedredirect/i, /expectedwaste/i, /avoidedwaste/i, /avoidedcompute/i];

// A task defines exactly one prompt and one Claude config, used verbatim by
// both control and treatment (see BenchmarkTaskDefinition's own doc
// comment) -- there is deliberately no field for a run-specific variant of
// either. Rejecting any key that names one directly (rather than merely
// omitting such fields from the type) keeps a malformed/malicious task file
// from silently carrying treatment-only wording that a future integration
// might accidentally read.
const FORBIDDEN_VARIANT_FIELD_PATTERNS: RegExp[] = [/^treatment/i, /^control/i, /treatmentprompt/i, /controlprompt/i, /treatmentconfig/i, /controlconfig/i];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function checkForbiddenFieldNames(obj: Record<string, unknown>, errors: string[], context: string): void {
  for (const key of Object.keys(obj)) {
    for (const pattern of FORBIDDEN_FIELD_NAME_PATTERNS) {
      if (pattern.test(key)) {
        errors.push(`${context}.${key} is not permitted: task definitions must not encode expected savings/redirect/energy/sustainability semantics`);
      }
    }
    for (const pattern of FORBIDDEN_VARIANT_FIELD_PATTERNS) {
      if (pattern.test(key)) {
        errors.push(`${context}.${key} is not permitted: a task has exactly one prompt/config, used verbatim by both control and treatment -- no treatment-specific or control-specific field is allowed`);
      }
    }
  }
}

function checkForbiddenPromptPhrasing(text: string, field: string, errors: string[]): void {
  for (const pattern of FORBIDDEN_PROMPT_PATTERNS) {
    if (pattern.test(text)) {
      errors.push(`${field} must not encode an instruction to manufacture a Drift intervention (matched forbidden pattern: ${pattern})`);
    }
  }
}

/**
 * Validates one candidate task definition. Pure and deterministic: the same
 * candidate always produces the same result, and nothing is mutated or
 * touches the filesystem. Rejects with a clear, complete list of every
 * problem found (never stops at the first) rather than a single opaque error.
 */
export function validateBenchmarkTask(candidate: unknown): BenchmarkTaskValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(candidate)) {
    return { success: false, task: undefined, errors: ["task definition must be a JSON object"] };
  }

  checkForbiddenFieldNames(candidate, errors, "task");

  if (!isNonEmptyString(candidate.id)) errors.push("task.id is required and must be a non-empty string");
  if (!isNonEmptyString(candidate.description)) errors.push("task.description is required and must be a non-empty string");
  if (!isNonEmptyString(candidate.workspaceTemplate)) errors.push("task.workspaceTemplate is required and must be a non-empty string");

  if (!isNonEmptyString(candidate.prompt)) {
    errors.push("task.prompt is required and must be a non-empty string");
  } else {
    checkForbiddenPromptPhrasing(candidate.prompt, "task.prompt", errors);
  }
  if (isNonEmptyString(candidate.description)) {
    checkForbiddenPromptPhrasing(candidate.description, "task.description", errors);
  }

  const claude = candidate.claude;
  if (!isPlainObject(claude)) {
    errors.push("task.claude is required and must be an object with model, allowedTools, permissionMode");
  } else {
    if (!isNonEmptyString(claude.model)) errors.push("task.claude.model is required and must be a non-empty string");
    if (!Array.isArray(claude.allowedTools) || !claude.allowedTools.every((t) => isNonEmptyString(t))) {
      errors.push("task.claude.allowedTools is required and must be an array of non-empty strings");
    }
    if (!isNonEmptyString(claude.permissionMode)) {
      errors.push("task.claude.permissionMode is required and must be a non-empty string");
    } else if (!VALID_PERMISSION_MODES.has(claude.permissionMode)) {
      errors.push(`task.claude.permissionMode "${claude.permissionMode}" is not a supported Claude Code permission mode (expected one of: ${[...VALID_PERMISSION_MODES].join(", ")})`);
    }
  }

  const evaluator = candidate.evaluator;
  if (!isPlainObject(evaluator)) {
    errors.push("task.evaluator is required and must be an object with command, timeoutMs");
  } else {
    if (!isNonEmptyString(evaluator.command)) errors.push("task.evaluator.command is required and must be a non-empty, non-whitespace string");
    if (typeof evaluator.timeoutMs !== "number" || !Number.isFinite(evaluator.timeoutMs) || evaluator.timeoutMs <= 0) {
      errors.push("task.evaluator.timeoutMs is required and must be a positive finite number");
    }
  }

  if (candidate.expectedProperties !== undefined) {
    if (!isPlainObject(candidate.expectedProperties)) {
      errors.push("task.expectedProperties, when present, must be an object");
    } else {
      checkForbiddenFieldNames(candidate.expectedProperties, errors, "task.expectedProperties");
      const { category, difficulty } = candidate.expectedProperties;
      if (category !== undefined && typeof category !== "string") errors.push("task.expectedProperties.category, when present, must be a string");
      if (difficulty !== undefined && typeof difficulty !== "string") errors.push("task.expectedProperties.difficulty, when present, must be a string");
    }
  }

  if (candidate.volatileFiles !== undefined) {
    if (!Array.isArray(candidate.volatileFiles) || !candidate.volatileFiles.every((f) => isNonEmptyString(f))) {
      errors.push("task.volatileFiles, when present, must be an array of non-empty strings");
    }
  }

  if (errors.length > 0) {
    return { success: false, task: undefined, errors };
  }

  return { success: true, task: candidate as unknown as BenchmarkTaskDefinition, errors: [] };
}

/**
 * Validates a set of candidate task definitions together, so duplicate task
 * ids (a property only meaningful across a set) can be rejected. Every
 * candidate is validated independently first; a duplicate id is reported
 * even when both underlying definitions are otherwise individually valid.
 */
export function validateBenchmarkTaskSet(candidates: unknown[]): BenchmarkTaskSetValidationResult {
  const errors: string[] = [];
  const tasks: BenchmarkTaskDefinition[] = [];
  const seenIds = new Set<string>();

  candidates.forEach((candidate, index) => {
    const result = validateBenchmarkTask(candidate);
    if (!result.success || !result.task) {
      errors.push(...result.errors.map((e) => `task[${index}]: ${e}`));
      return;
    }
    if (seenIds.has(result.task.id)) {
      errors.push(`task[${index}]: duplicate task id "${result.task.id}"`);
      return;
    }
    seenIds.add(result.task.id);
    tasks.push(result.task);
  });

  if (errors.length > 0) {
    return { success: false, tasks: undefined, errors };
  }
  return { success: true, tasks, errors: [] };
}

/**
 * Loads and validates one task definition from a JSON file containing a
 * single task object. Deterministic: the same file contents always produce
 * the same result. A malformed/unreadable file is reported as a validation
 * error, never thrown.
 */
export function loadBenchmarkTaskFile(filePath: string): BenchmarkTaskValidationResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return { success: false, task: undefined, errors: [`could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { success: false, task: undefined, errors: [`${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }

  return validateBenchmarkTask(parsed);
}

/**
 * Loads and validates a set of task definitions from a JSON file containing
 * an array of task objects, checking for duplicate ids across the whole set.
 */
export function loadBenchmarkTaskSetFile(filePath: string): BenchmarkTaskSetValidationResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return { success: false, tasks: undefined, errors: [`could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { success: false, tasks: undefined, errors: [`${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }

  if (!Array.isArray(parsed)) {
    return { success: false, tasks: undefined, errors: [`${filePath} must contain a JSON array of task definitions`] };
  }

  return validateBenchmarkTaskSet(parsed);
}

function listFilesRecursively(rootDir: string, currentDir: string, volatileFiles: Set<string>): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(currentDir).sort()) {
    const absolutePath = path.join(currentDir, entry);
    const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join("/");
    if (volatileFiles.has(relativePath)) continue;

    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) {
      results.push(...listFilesRecursively(rootDir, absolutePath, volatileFiles));
    } else {
      results.push(relativePath);
    }
  }
  return results;
}

/**
 * Computes a deterministic fingerprint of a workspace template's starting
 * state: a SHA-256 over every file's relative path and content, in sorted
 * path order, excluding only the explicitly declared `volatileFiles` (paths
 * relative to `workspaceTemplateDir`). Two template directories with the
 * same non-volatile file paths and contents always produce the same
 * fingerprint, regardless of mtimes, inode numbers, or read order.
 */
export function computeWorkspaceFingerprint(workspaceTemplateDir: string, volatileFiles: string[] = []): string {
  const volatileSet = new Set(volatileFiles);
  const relativePaths = listFilesRecursively(workspaceTemplateDir, workspaceTemplateDir, volatileSet).sort();

  const hash = crypto.createHash("sha256");
  for (const relativePath of relativePaths) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(workspaceTemplateDir, relativePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export interface TaskEvaluatorRunResult {
  /** Exactly (exitCode === 0) -- never inferred from Claude's response, SessionEnd, a tool call's own outcome, or any Drift finding. */
  passed: boolean;
  /** null when the process never produced a normal exit (killed by timeout/signal). */
  exitCode: number | null;
  /** A bare command exit status carries no objective sub-check breakdown -- never parsed or guessed from stdout/stderr text, so this stays undefined for the initial "command exit status" evaluator kind. */
  checksPassed: number | undefined;
  checksTotal: number | undefined;
  /** The evaluator's own command string -- the only objective identifier this task format's evaluator spec provides (see TaskEvaluatorSpec, which has no separate name field). */
  evaluatorName: string;
  timedOut: boolean;
}

/**
 * Runs a task's external, objective evaluator command against a workspace
 * and reports its exit status. Always runs as a separate child process,
 * strictly after whatever Claude session already finished with that
 * workspace -- it never touches Drift's storage, runtime, or hook traffic
 * in any way, so it can never alter the usage already attributed to that
 * session. Never throws: a spawn failure or timeout is reported as a
 * failing, non-zero-equivalent result, not an exception.
 */
export function runTaskEvaluator(task: BenchmarkTaskDefinition, workspaceDir: string): TaskEvaluatorRunResult {
  const result = spawnSync(task.evaluator.command, {
    cwd: workspaceDir,
    shell: true,
    timeout: task.evaluator.timeoutMs,
  });

  const timedOut = result.status === null && result.signal !== null;
  const exitCode = result.status;

  return {
    passed: exitCode === 0,
    exitCode,
    checksPassed: undefined,
    checksTotal: undefined,
    evaluatorName: task.evaluator.command,
    timedOut,
  };
}
