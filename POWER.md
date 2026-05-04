---
name: "dsql-schema-converter"
displayName: "Convert database schemas to Aurora DSQL"
description: "Convert PostgreSQL schemas to Aurora DSQL-compatible DDL. Transpiles PL/pgSQL functions, converts ENUMs to CHECK constraints, generates FK validation functions, preserves sequences, and produces runnable SQL — not just a compatibility report."
keywords: ["dsql", "aurora", "postgresql", "postgres", "schema", "migration", "convert", "ddl", "database", "sql", "migrate", "plpgsql"]
author: "Prem Aiyar"
---

# DSQL Schema Converter Power

## Overview

Converts PostgreSQL schemas to Aurora DSQL-compatible DDL. Not a linter — a converter that produces runnable SQL for everything including PL/pgSQL functions, triggers, sequences, ENUMs, foreign keys, and indexes.

Key capabilities:

- Parse PostgreSQL DDL (tables, indexes, sequences, triggers, functions, views, enums, extensions)
- Map types via two-stage pipeline (source → normalized → DSQL)
- Transpile PL/pgSQL to pure SQL functions (10 recognized patterns)
- Convert ENUMs to CHECK constraints
- Generate FK validation functions (real SQL, not comments)
- Preserve sequences natively (DSQL supports CREATE SEQUENCE)
- Convert GIN/GiST indexes to btree
- Demote materialized views to regular views
- Produce a conversion report explaining every change

## Onboarding

### Step 1: Verify Node.js

```bash
node --version
```

Requires Node.js 18+.

### Step 2: Install dependencies

```bash
cd <power-directory>/mcp-server
npm install
```

### Step 3: Verify

```bash
npm test
```

All 25 tests should pass.

## Available MCP Tools

### convert_schema

Convert SQL DDL to DSQL DDL + conversion report.

- **sql** (string, optional): Raw SQL DDL text
- **file_path** (string, optional): Path to a `.sql` file
- **source_dialect** (string, required): `"postgresql"`

### analyze_compatibility

Show what the converter would do, without DDL output.

- Same parameters as convert_schema.

### list_type_mappings

Show source → normalized → DSQL type table.

- **source_dialect** (string, required): `"postgresql"`

### list_supported_dialects

List supported source dialects with key conversion notes.

## When to Load Steering Files

- Converting PostgreSQL schemas → `postgresql-conversion.md`
- Understanding DSQL constraints → `dsql-constraints.md`
- Adding MySQL, CockroachDB, or Spanner support → `extending-dialects.md`

## Common Workflows

### Workflow 1: Convert a schema file

1. Call `convert_schema` with `file_path` and `source_dialect: "postgresql"`
2. Review the conversion report
3. Run the output DDL against your DSQL cluster (each statement in its own transaction)

### Workflow 2: Quick assessment

1. Call `analyze_compatibility` with your SQL
2. Review what would change — no DDL generated

### Workflow 3: Understand type mappings

1. Call `list_type_mappings` with `source_dialect: "postgresql"`

## PL/pgSQL Transpilation

The converter recognizes 10 PL/pgSQL patterns and generates equivalent SQL:

1. SET_COLUMN → SQL function with UPDATE
2. VALIDATION → CHECK constraint (no function needed)
3. AUDIT_INSERT → SQL function with parameterized INSERT
4. CASCADE_DML → SQL function with parameterized UPDATE/DELETE
5. FOR_LOOP → set-based UPDATE...FROM
6. IF/ELSE → CASE WHEN
7. EXCEPTION unique_violation → ON CONFLICT
8. Dynamic SQL (EXECUTE format) → expanded concrete functions per table
9. CURSOR → set-based UPDATE...FROM
10. EXCEPTION no_data_found → COALESCE

Only PERFORM and deeply nested ELSIF (3+ branches) produce stubs.


## License and Support

This power is licensed under Apache-2.0.

- [Source Code](https://github.com/premaiy/dsql-schema-converter)
- [Issues & Support](https://github.com/premaiy/dsql-schema-converter/issues)
- [Privacy Policy](https://aws.amazon.com/privacy/)
