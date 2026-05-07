---
name: "dsql-schema-converter"
displayName: "Convert database schemas to Aurora DSQL"
description: "Convert PostgreSQL schemas to Aurora DSQL-compatible DDL. Transpiles PL/pgSQL functions to pure SQL, converts ENUMs to CHECK constraints, generates FK validation functions, preserves sequences natively, and produces runnable SQL."
keywords: ["dsql", "aurora", "postgresql", "postgres", "schema", "migration", "convert", "ddl", "database", "sql", "migrate", "plpgsql"]
author: "Prem Aiyar"
---

# DSQL Schema Converter Power

## Overview

Convert PostgreSQL database schemas to Aurora DSQL-compatible DDL. This power parses SQL DDL, applies DSQL type mappings and constraint rules, transpiles PL/pgSQL functions to pure SQL, and produces a complete, runnable schema — not just a compatibility report.

**Key capabilities:**

- **Full Schema Conversion**: Tables, columns, types, constraints, indexes, views, sequences
- **PL/pgSQL Transpiler**: 10 recognized patterns converted to pure SQL functions
- **ENUM → CHECK Constraints**: Enforces the same allowed values without custom types
- **FK Validation Functions**: Real SQL functions that check referential integrity
- **Native Sequence Support**: Preserves CREATE SEQUENCE with DSQL-required CACHE clause
- **Index Conversion**: All indexes converted to CREATE INDEX ASYNC, GIN/GiST → btree
- **View Handling**: Regular views preserved, materialized views demoted to regular views
- **Trigger Replacement**: Generates SQL helper functions for common trigger patterns

**Perfect for:**
- Migrating PostgreSQL databases to Aurora DSQL
- Assessing DSQL compatibility before committing to migration
- CI/CD schema validation (catch DSQL-incompatible changes before production)
- Learning DSQL constraints through the conversion report

## Available Steering Files

This power has the following steering files:

- **postgresql-conversion** - Complete PostgreSQL type mapping rules and conversion details
- **dsql-constraints** - Aurora DSQL platform constraints reference
- **extending-dialects** - Guide for adding MySQL, CockroachDB, or Spanner support

## Available MCP Servers

### dsql-schema-converter

**Package:** Local Node.js MCP server
**Connection:** stdio

**Tools:**

1. **convert_schema** - Convert source SQL DDL to Aurora DSQL-compatible DDL
   - Optional: `sql` (string) - Raw SQL DDL text to convert
   - Optional: `file_path` (string) - Path to a .sql file to convert
   - Required: `source_dialect` (string) - Source dialect ("postgresql")
   - Returns: Converted DDL + compatibility report + summary

2. **analyze_compatibility** - Analyze schema for DSQL compatibility without generating DDL
   - Optional: `sql` (string) - Raw SQL DDL text
   - Optional: `file_path` (string) - Path to a .sql file
   - Required: `source_dialect` (string) - Source dialect ("postgresql")
   - Returns: Conversion report showing what would change

3. **list_type_mappings** - Show complete type mapping table for a source dialect
   - Required: `source_dialect` (string) - Source dialect ("postgresql")
   - Returns: Source type → Normalized type → DSQL type mapping table

4. **list_supported_dialects** - List all supported source database dialects
   - No parameters required
   - Returns: Table of supported dialects with status and key conversions

## Tool Usage Examples

### Converting a Schema

**From raw SQL:**
```
convert_schema({
  sql: "CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(100), metadata JSONB);",
  source_dialect: "postgresql"
})
```

**From a file:**
```
convert_schema({
  file_path: "/path/to/schema.sql",
  source_dialect: "postgresql"
})
```

### Quick Compatibility Check

```
analyze_compatibility({
  sql: "CREATE TABLE t (id SERIAL, data JSONB, tags TEXT[], ip INET);",
  source_dialect: "postgresql"
})
```

### Viewing Type Mappings

```
list_type_mappings({ source_dialect: "postgresql" })
```

## What Gets Converted

### Tables & Types

| Source | Output |
|--------|--------|
| CREATE TABLE | DSQL-compatible with proper types, COLLATE "C" on text columns |
| SERIAL / BIGSERIAL | → integer / bigint (sequences preserved natively) |
| ENUM types | → TEXT + CHECK constraint enforcing allowed values |
| JSON | → json (DSQL supports json as a stored type natively) |
| JSONB | → json (stored as json; use ::jsonb in queries for binary operators) |
| Arrays (TEXT[], INT[]) | → TEXT (arrays are runtime-only in DSQL) |
| VARCHAR(N), NUMERIC(P,S) | Precision preserved |
| GENERATED AS IDENTITY | Auto-increment removed |
| Temporary tables | → Regular tables with _tmp_ prefix |
| Partitioned tables | → Flat tables (PARTITION BY removed) |
| Inherited tables | → Flat tables (INHERITS removed) |

### Sequences

| Source | Output |
|--------|--------|
| CREATE SEQUENCE | CREATE SEQUENCE name CACHE 1 (DSQL supports natively) |
| nextval() defaults | Preserved as-is |

### Indexes

| Source | Output |
|--------|--------|
| CREATE INDEX | CREATE INDEX ASYNC (DSQL requirement) |
| GIN / GiST / BRIN | → btree (converted, not just flagged) |
| Partial indexes (WHERE) | WHERE clause removed (not supported in DSQL) |
| INCLUDE columns | Preserved (DSQL supports INCLUDE) |

### Foreign Keys

| Source | Output |
|--------|--------|
| REFERENCES / FOREIGN KEY | SQL validation function: validate_fk_table_col(p_value) |

### Views

| Source | Output |
|--------|--------|
| CREATE VIEW | Preserved (works in DSQL) |
| CREATE MATERIALIZED VIEW | → CREATE VIEW (demoted) |

### PL/pgSQL Functions — 10 Transpilation Patterns

| PL/pgSQL Pattern | DSQL Output |
|---|---|
| NEW.col = expr; RETURN NEW | SQL function with UPDATE |
| IF cond THEN RAISE EXCEPTION | CHECK constraint |
| INSERT INTO audit_table(...) | SQL function with parameterized INSERT |
| UPDATE/DELETE WHERE OLD.id | SQL function with parameterized DML |
| FOR r IN SELECT... LOOP UPDATE... | Set-based UPDATE...FROM (SELECT...) |
| IF cond THEN x ELSE y | CASE WHEN in SQL function |
| INSERT... EXCEPTION WHEN unique_violation | INSERT... ON CONFLICT DO NOTHING |
| EXECUTE format('DELETE FROM %I', tbl) | Expanded concrete functions per table |
| DECLARE cur CURSOR FOR... LOOP UPDATE... | Set-based UPDATE...FROM |
| EXCEPTION WHEN no_data_found | SELECT COALESCE(...) |

Only PERFORM and deeply nested ELSIF (3+ branches) produce stubs.

### Triggers

| Source | Output |
|--------|--------|
| BEFORE UPDATE (updated_at) | SQL function: set_updated_at_table(p_id) |
| Other triggers | SQL function stub with original logic as comments |

### Extensions

| Source | Output |
|--------|--------|
| pgcrypto | gen_random_uuid() is built into DSQL |
| uuid-ossp | gen_random_uuid() is built into DSQL |
| pg_stat_statements | Available by default |
| Others | Noted as unavailable |

## Common Workflows

### Workflow 1: Convert a PostgreSQL Schema File

1. Call `convert_schema` with `file_path` pointing to your .sql file and `source_dialect: "postgresql"`
2. Review the conversion report for any stubbed functions
3. Run the output DDL against your DSQL cluster (each statement in its own transaction)

### Workflow 2: Quick Compatibility Assessment

1. Call `analyze_compatibility` with your SQL
2. Review what would change — no DDL generated
3. Use this to estimate migration effort before committing

### Workflow 3: CI/CD Schema Validation

1. In your pipeline, call `convert_schema` on your schema files
2. Check the summary for any stubbed functions (functions_stubbed > 0)
3. Fail the build if unconvertible patterns are introduced

### Workflow 4: Understand Type Mappings

1. Call `list_type_mappings` with `source_dialect: "postgresql"`
2. Review the two-stage pipeline: PG type → NormalizedType → DSQL type

## Best Practices

### ✅ Do:

- **Use gen_random_uuid() for primary keys** — DSQL distributes data better with random UUIDs
- **Run each DDL statement in its own transaction** — DSQL allows only 1 DDL per transaction
- **Call FK validation functions before INSERT/UPDATE** — DSQL does not enforce foreign keys
- **Use CACHE 65536 for high-throughput sequences** — reduces coordination overhead
- **Test converted schema on a DSQL cluster** — some edge cases may need manual adjustment
- **Review the conversion report** — understand every change before applying

### ❌ Don't:

- **Run all DDL in one transaction** — DSQL will reject it
- **Expect foreign key enforcement** — use the generated validation functions
- **Use TRUNCATE** — use DELETE FROM or DROP + CREATE instead
- **Create temporary tables** — use CTEs or regular tables with cleanup
- **Assume PL/pgSQL works** — only SQL functions are supported
- **Skip the conversion report** — it explains every change and why

## Troubleshooting

### Error: "Unsupported dialect"
**Cause:** Dialect not yet supported
**Solution:** Currently only "postgresql" is supported. MySQL, CockroachDB, and Spanner are planned.

### Converted DDL fails on DSQL
**Cause:** Edge case not handled by the converter
**Solution:**
1. Check the specific error message from DSQL
2. Review the conversion report for that table/function
3. Common issues: column type not in DSQL's supported list, CHECK constraint referencing unsupported function
4. File an issue on the GitHub repo

### PL/pgSQL function shows as "stub"
**Cause:** Function uses PERFORM or complex ELSIF chains
**Solution:**
1. Review the original function logic
2. Rewrite using SQL-compatible patterns (CASE WHEN, CTEs, UPDATE...FROM)
3. Or move the logic to application code

### Sequence CACHE value warning
**Cause:** DSQL requires explicit CACHE on sequences
**Solution:** The converter adds CACHE 1 by default. For high-throughput workloads, change to CACHE 65536.

## Configuration

**Prerequisites:** Node.js 18+

**Setup Steps:**
1. Install the power via Kiro Powers panel (local path or GitHub URL)
2. The MCP server installs automatically
3. Run `npm install` in the mcp-server directory if prompted
4. Power is ready — mention "dsql", "schema", "convert", or "migrate" to activate

**MCP Configuration:**
```json
{
  "mcpServers": {
    "dsql-schema-converter": {
      "command": "node",
      "args": ["mcp-server/src/index.js"]
    }
  }
}
```

## Architecture

The converter uses a two-stage type pipeline:
- **Stage 1** (adapter-provided): PostgreSQL type → NormalizedType (18 intermediate types)
- **Stage 2** (fixed): NormalizedType → DSQL SQL type string

This adapter pattern means adding MySQL, CockroachDB, or Spanner requires only a Stage 1 mapping file. The converter, DDL generator, transpiler, and report engine are shared.

## License and Support

This power is licensed under Apache-2.0.

- [Source Code](https://github.com/premaiy/dsql-schema-converter)
- [Issues & Support](https://github.com/premaiy/dsql-schema-converter/issues)
- [Privacy Policy](https://aws.amazon.com/privacy/)
