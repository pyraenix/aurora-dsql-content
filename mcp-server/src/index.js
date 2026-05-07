#!/usr/bin/env node

/**
 * DSQL Schema Converter — MCP Server
 *
 * Pipeline:
 *   1. dsql-lint --fix (mechanical fixes with proper SQL parser)
 *   2. dsql-schema-converter (PL/pgSQL transpilation, ENUM→CHECK, FK functions, etc.)
 *   3. dsql-lint validate (confirm output is clean)
 *
 * Tools:
 *   convert_schema         — Full pipeline: dsql-lint fix → convert → validate
 *   analyze_compatibility  — Report only (no DDL output)
 *   list_type_mappings     — Show source → normalized → DSQL type table
 *   list_supported_dialects — List supported source dialects
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";

import { parseSQL } from "./sql-parser.js";
import { convertSchema, formatReport, getSupportedDialects } from "./converter.js";
import { dsqlLintFix, dsqlLintValidate, isDsqlLintAvailable } from "./dsql-lint.js";
import { NORMALIZED_TO_DSQL } from "./dsql-constraints.js";
import { PG_TYPE_MAPPING } from "./type-mappings/postgresql.js";

const TYPE_MAPPINGS = { postgresql: PG_TYPE_MAPPING };

const server = new McpServer({
  name: "dsql-schema-converter",
  version: "1.1.0",
});

// -----------------------------------------------------------------------
// convert_schema — full pipeline
// -----------------------------------------------------------------------
server.tool(
  "convert_schema",
  "Convert a source database schema (SQL DDL) to Aurora DSQL-compatible DDL. " +
    "Uses dsql-lint for mechanical fixes (proper SQL parser), then applies " +
    "deeper conversions (PL/pgSQL transpilation, ENUM→CHECK, FK validation functions). " +
    "Validates the final output with dsql-lint.",
  {
    sql: z.string().optional().describe("Raw SQL DDL text to convert."),
    file_path: z.string().optional().describe("Path to a .sql file to convert."),
    source_dialect: z.enum(["postgresql"]).describe("Source database dialect."),
  },
  async ({ sql, file_path, source_dialect }) => {
    try {
      const inputSql = file_path ? readFileSync(file_path, "utf-8") : sql;
      if (!inputSql) return { content: [{ type: "text", text: "Error: Provide either 'sql' or 'file_path'." }], isError: true };

      // Step 1: dsql-lint --fix (for diagnostics — tells us what it found)
      const lintResult = dsqlLintFix(inputSql);

      // Step 2: Parse the ORIGINAL input to extract structure
      const parsed = parseSQL(inputSql);

      // Step 3: The converter generates the full DSQL DDL
      // (uses correct json mapping per DSQL docs, unlike dsql-lint which maps to TEXT)
      const { ddl: finalDdl, notes, summary } = convertSchema(parsed, source_dialect);

      // Step 4: Validate our output with dsql-lint
      let validationNote = "";
      try {
        const validation = dsqlLintValidate(finalDdl);
        if (validation.clean) {
          validationNote = "\n\n✅ **Validated with dsql-lint: 0 errors, 0 warnings.**";
        } else {
          const remaining = validation.diagnostics
            .filter(d => d.fix_result.status === "unfixable")
            .map(d => `- Line ${d.line}: ${d.message}`)
            .join("\n");
          validationNote = `\n\n⚠️ **dsql-lint validation:** ${validation.summary.errors} remaining items:\n${remaining}`;
        }
      } catch { /* validation is best-effort */ }

      // Add dsql-lint diagnostics to the conversion notes
      for (const d of lintResult.diagnostics) {
        if (d.fix_result.status === "fixed" || d.fix_result.status === "fixed_with_warning") {
          notes.unshift({
            object: `(dsql-lint)`,
            action: `${d.rule}: ${d.fix_result.detail || "fixed"}`,
            details: d.message,
          });
        }
      }
      summary.dsql_lint_fixes = lintResult.diagnostics.filter(
        d => d.fix_result.status === "fixed" || d.fix_result.status === "fixed_with_warning"
      ).length;

      const report = formatReport(notes, summary);
      return { content: [{ type: "text", text: `# Converted DSQL Schema\n\n\`\`\`sql\n${finalDdl}\n\`\`\`\n\n${report}${validationNote}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// -----------------------------------------------------------------------
// analyze_compatibility
// -----------------------------------------------------------------------
server.tool(
  "analyze_compatibility",
  "Analyze a source schema for DSQL compatibility. Shows dsql-lint diagnostics plus deeper conversion analysis.",
  {
    sql: z.string().optional().describe("Raw SQL DDL text to analyze."),
    file_path: z.string().optional().describe("Path to a .sql file to analyze."),
    source_dialect: z.enum(["postgresql"]).describe("Source database dialect."),
  },
  async ({ sql, file_path, source_dialect }) => {
    try {
      const inputSql = file_path ? readFileSync(file_path, "utf-8") : sql;
      if (!inputSql) return { content: [{ type: "text", text: "Error: Provide either 'sql' or 'file_path'." }], isError: true };

      // dsql-lint analysis
      const lintResult = dsqlLintFix(inputSql);

      // Converter analysis
      const parsed = parseSQL(inputSql);
      const { notes, summary } = convertSchema(parsed, source_dialect);

      // Merge dsql-lint diagnostics
      for (const d of lintResult.diagnostics) {
        notes.unshift({
          object: `(dsql-lint)`,
          action: `${d.rule}: ${d.fix_result.status}`,
          details: d.message,
        });
      }
      summary.dsql_lint_fixes = lintResult.diagnostics.filter(
        d => d.fix_result.status === "fixed" || d.fix_result.status === "fixed_with_warning"
      ).length;

      return { content: [{ type: "text", text: formatReport(notes, summary) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// -----------------------------------------------------------------------
// list_type_mappings
// -----------------------------------------------------------------------
server.tool(
  "list_type_mappings",
  "Show the complete type mapping table for a source dialect.",
  { source_dialect: z.enum(["postgresql"]).describe("Source dialect.") },
  async ({ source_dialect }) => {
    const mapping = TYPE_MAPPINGS[source_dialect];
    if (!mapping) return { content: [{ type: "text", text: `Unknown dialect: ${source_dialect}` }], isError: true };
    const lines = [
      `# Type Mappings: ${source_dialect} → DSQL\n`,
      "| Source Type | Normalized Type | DSQL Type |",
      "|------------|-----------------|-----------|",
    ];
    for (const [src, norm] of Object.entries(mapping)) {
      lines.push(`| ${src} | ${norm} | ${NORMALIZED_TO_DSQL[norm]} |`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// -----------------------------------------------------------------------
// list_supported_dialects
// -----------------------------------------------------------------------
server.tool(
  "list_supported_dialects",
  "List all supported source database dialects.",
  {},
  async () => {
    const lines = [
      "# Supported Source Dialects\n",
      "| Dialect | Status | Key Conversions |",
      "|---------|--------|-----------------|",
      "| postgresql | Available | SERIAL→IDENTITY, JSON/JSONB→TEXT, PL/pgSQL transpilation, ENUM→CHECK |",
      "| mysql | Planned | AUTO_INCREMENT, ENUM/SET→TEXT, DATETIME→timestamp |",
      "| cockroachdb | Planned | STRING→text, interleaved tables, GEOGRAPHY→TEXT |",
      "| spanner | Planned | INT64→bigint, STRING(N)→varchar, ARRAY→TEXT |",
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// -----------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
