#!/usr/bin/env node

/**
 * DSQL Schema Converter — MCP Server
 *
 * Tools:
 *   convert_schema         — Parse SQL DDL → DSQL-compatible DDL + report
 *   analyze_compatibility  — Compatibility report only (no DDL output)
 *   list_type_mappings     — Show source → normalized → DSQL type table
 *   list_supported_dialects — List supported source dialects
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";

import { parseSQL } from "./sql-parser.js";
import { convertSchema, formatReport, getSupportedDialects } from "./converter.js";
import { NORMALIZED_TO_DSQL } from "./dsql-constraints.js";
import { PG_TYPE_MAPPING } from "./type-mappings/postgresql.js";

const TYPE_MAPPINGS = {
  postgresql: PG_TYPE_MAPPING,
};

const server = new McpServer({
  name: "dsql-schema-converter",
  version: "1.0.0",
});

// -----------------------------------------------------------------------
// convert_schema
// -----------------------------------------------------------------------
server.tool(
  "convert_schema",
  "Convert a source database schema (SQL DDL) to Aurora DSQL-compatible DDL. " +
    "Provide either raw SQL text or a file path. " +
    "Returns converted DDL, compatibility report, and summary.",
  {
    sql: z.string().optional().describe("Raw SQL DDL text to convert."),
    file_path: z.string().optional().describe("Path to a .sql file to convert."),
    source_dialect: z.enum(["postgresql"]).describe("Source database dialect."),
  },
  async ({ sql, file_path, source_dialect }) => {
    try {
      const ddlText = file_path ? readFileSync(file_path, "utf-8") : sql;
      if (!ddlText) return { content: [{ type: "text", text: "Error: Provide either 'sql' or 'file_path'." }], isError: true };

      const parsed = parseSQL(ddlText);
      const { ddl, notes, summary } = convertSchema(parsed, source_dialect);
      const report = formatReport(notes, summary);

      return { content: [{ type: "text", text: `# Converted DSQL Schema\n\n\`\`\`sql\n${ddl}\n\`\`\`\n\n${report}` }] };
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
  "Analyze a source schema for DSQL compatibility and show what the converter would do, without generating DDL.",
  {
    sql: z.string().optional().describe("Raw SQL DDL text to analyze."),
    file_path: z.string().optional().describe("Path to a .sql file to analyze."),
    source_dialect: z.enum(["postgresql"]).describe("Source database dialect."),
  },
  async ({ sql, file_path, source_dialect }) => {
    try {
      const ddlText = file_path ? readFileSync(file_path, "utf-8") : sql;
      if (!ddlText) return { content: [{ type: "text", text: "Error: Provide either 'sql' or 'file_path'." }], isError: true };

      const parsed = parseSQL(ddlText);
      const { notes, summary } = convertSchema(parsed, source_dialect);
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
  "Show the complete type mapping table for a source dialect: source type → normalized type → DSQL type.",
  {
    source_dialect: z.enum(["postgresql"]).describe("Source dialect."),
  },
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
      "| postgresql | Available | SERIAL→integer, JSON/JSONB→TEXT, sequences dropped, triggers dropped |",
      "| mysql | Planned | AUTO_INCREMENT, ENUM/SET→TEXT, DATETIME→timestamp |",
      "| cockroachdb | Planned | STRING→text, interleaved tables, GEOGRAPHY→TEXT |",
      "| spanner | Planned | INT64→bigint, STRING(N)→varchar, ARRAY→TEXT |",
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
