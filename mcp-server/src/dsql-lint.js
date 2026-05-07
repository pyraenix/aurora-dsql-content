/**
 * dsql-lint integration.
 *
 * Shells out to `dsql-lint` (installed via pip/uvx) for:
 *   1. --fix mode: mechanical fixes (SERIAL→IDENTITY, JSONB→TEXT, FK removal,
 *      index ASYNC, sequence CACHE) using a proper SQL parser
 *   2. lint mode: validate final output has zero errors
 *
 * Uses `uvx dsql-lint` which downloads and runs without prior install.
 */

import { execSync } from "node:child_process";

/**
 * Run dsql-lint --fix on SQL text. Returns the fixed SQL and diagnostics.
 *
 * @param {string} sql - Input SQL text
 * @returns {{ fixedSql: string, diagnostics: Array, summary: Object }}
 */
export function dsqlLintFix(sql) {
  const result = runDsqlLint(sql, ["--fix", "--format", "json"]);
  const parsed = JSON.parse(result.stdout);
  const file = parsed.files[0];

  return {
    fixedSql: file.fixed_sql || sql, // fall back to original if no fixes
    diagnostics: file.diagnostics || [],
    summary: parsed.summary,
  };
}

/**
 * Run dsql-lint in lint mode to validate SQL. Returns diagnostics.
 *
 * @param {string} sql - SQL text to validate
 * @returns {{ diagnostics: Array, summary: Object, clean: boolean }}
 */
export function dsqlLintValidate(sql) {
  const result = runDsqlLint(sql, ["--format", "json"]);
  const parsed = JSON.parse(result.stdout);
  const file = parsed.files[0];

  return {
    diagnostics: file.diagnostics || [],
    summary: parsed.summary,
    clean: parsed.summary.errors === 0 && parsed.summary.warnings === 0,
  };
}

/**
 * Check if dsql-lint is available.
 */
export function isDsqlLintAvailable() {
  try {
    execSync("dsql-lint --version", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    try {
      execSync("uvx dsql-lint --version", { stdio: "pipe", timeout: 15000 });
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function runDsqlLint(sql, args) {
  // Use stdin mode (-) which populates fixed_sql in JSON output
  let stdout;
  try {
    stdout = execSync(`dsql-lint ${args.join(" ")} -`, {
      input: sql,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
  } catch (directErr) {
    // dsql-lint returns exit code 1/3 for errors/warnings found (normal behavior)
    if (directErr.stdout && directErr.stdout.includes('"schema_version"')) {
      stdout = directErr.stdout;
    } else {
      // Try uvx
      try {
        stdout = execSync(`uvx dsql-lint ${args.join(" ")} -`, {
          input: sql,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 30000,
        });
      } catch (uvxErr) {
        if (uvxErr.stdout && uvxErr.stdout.includes('"schema_version"')) {
          stdout = uvxErr.stdout;
        } else {
          throw new Error(
            "dsql-lint not available. Install with: pip install dsql-lint"
          );
        }
      }
    }
  }

  return { stdout };
}
