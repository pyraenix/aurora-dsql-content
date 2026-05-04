# DSQL Schema Converter — Kiro Power

A Kiro Power that converts PostgreSQL schemas to Aurora DSQL-compatible DDL. Not a linter that flags problems — a converter that produces runnable SQL.

Built for the NGDE Week 2 assignment: *Develop a custom Kiro Power, test the autonomous agent, document learnings.*

## When to Use This

**You're migrating a PostgreSQL database to Aurora DSQL.** You have `.sql` schema files or `pg_dump` output and need DSQL-compatible DDL. Instead of manually reading through every CREATE TABLE, index, function, trigger, and sequence to figure out what DSQL supports, you feed it to this power and get back a complete, runnable schema.

**Specific scenarios:**

- **Greenfield on DSQL** — You have an existing PG schema from a prototype or another project. You want to start fresh on DSQL but keep the same data model.
- **Migration assessment** — Before committing to a DSQL migration, you want to know exactly what changes are needed and how much work it is. The conversion report tells you.
- **CI/CD schema validation** — Run the converter in your pipeline to catch DSQL-incompatible schema changes before they hit production.
- **Learning DSQL constraints** — The conversion report explains *why* each change was made, teaching you DSQL's constraints as you go.

## How to Use It

### Option 1: Web UI (easiest for demos)

```bash
cd dsql-schema-converter/ui
npx serve . -p 3000
```

Open http://localhost:3000. Paste PostgreSQL SQL on the left, click **Convert to DSQL**, see the output on the right. Three tabs: DDL, Report, Summary. Click **Load Sample** to try a pre-built schema.

No backend needed — the converter runs entirely in the browser.

### Option 2: As a Kiro Power (recommended for daily use)

1. Open Kiro → Powers panel → **Add power from Local Path**
2. Select the `dsql-schema-converter/` directory
3. In chat, say: *"Convert this PostgreSQL schema to DSQL"* and paste your SQL or reference a file

Kiro activates the power automatically when it sees keywords like "dsql", "aurora", "schema", "convert", "migrate".

### Option 2: As a Kiro Power (recommended for daily use)

1. Open Kiro → Powers panel → **Add power from Local Path**
2. Select the `dsql-schema-converter/` directory
3. In chat, say: *"Convert this PostgreSQL schema to DSQL"* and paste your SQL or reference a file

Kiro activates the power automatically when it sees keywords like "dsql", "aurora", "schema", "convert", "migrate".

### Option 3: Manual MCP setup

Add to `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "dsql-schema-converter": {
      "command": "node",
      "args": ["/absolute/path/to/dsql-schema-converter/mcp-server/src/index.js"]
    }
  }
}
```

Then `cd mcp-server && npm install`.

### Option 4: Direct Node.js usage (no Kiro)

```javascript
import { readFileSync } from "node:fs";
import { parseSQL } from "./mcp-server/src/sql-parser.js";
import { convertSchema, formatReport } from "./mcp-server/src/converter.js";

const sql = readFileSync("my-schema.sql", "utf-8");
const parsed = parseSQL(sql);
const { ddl, notes, summary } = convertSchema(parsed, "postgresql");

console.log(ddl);       // Runnable DSQL DDL
console.log(formatReport(notes, summary));  // What was converted and why
```

## What It Converts

Everything. The output is a complete `.sql` file you can run against a DSQL cluster.

### Tables & Types

| Source | Output |
|--------|--------|
| CREATE TABLE | DSQL-compatible with proper types, `COLLATE "C"` on text columns |
| SERIAL / BIGSERIAL | → integer / bigint (DSQL supports sequences natively) |
| ENUM types | → TEXT column + `CHECK (col IN ('val1', 'val2'))` constraint |
| JSON / JSONB | → TEXT (use runtime cast: `col::jsonb`) |
| Arrays (TEXT[], INT[]) | → TEXT (use runtime cast: `col::text[]`) |
| VARCHAR(N), NUMERIC(P,S) | Precision preserved |
| GENERATED AS IDENTITY | Auto-increment removed |
| Temporary tables | → Regular tables with `_tmp_` prefix |
| Partitioned tables | → Flat tables (PARTITION BY removed) |
| Inherited tables | → Flat tables (INHERITS removed) |

### Sequences

| Source | Output |
|--------|--------|
| CREATE SEQUENCE | `CREATE SEQUENCE name CACHE 1` (DSQL supports sequences natively) |
| nextval() defaults | Preserved as-is |

### Indexes

| Source | Output |
|--------|--------|
| CREATE INDEX | `CREATE INDEX ASYNC` (DSQL requirement) |
| GIN / GiST / BRIN indexes | → btree (converted, not just flagged) |
| Partial indexes (WHERE) | Preserved |
| Unique indexes | Preserved |

### Foreign Keys

| Source | Output |
|--------|--------|
| REFERENCES / FOREIGN KEY | SQL validation function: `validate_fk_<table>_<col>(p_value)` |

Each FK becomes a real `CREATE FUNCTION ... LANGUAGE sql` that does `SELECT EXISTS(...)`. Call it before INSERT/UPDATE in your application code.

### Views

| Source | Output |
|--------|--------|
| CREATE VIEW | Preserved (works in DSQL) |
| CREATE MATERIALIZED VIEW | → `CREATE VIEW` (demoted to regular view) |

### PL/pgSQL Functions — 10 Transpilation Patterns

The transpiler recognizes the *intent* of PL/pgSQL code and generates equivalent pure SQL:

| PL/pgSQL Pattern | DSQL Output | Example |
|---|---|---|
| `NEW.col = expr; RETURN NEW;` | SQL function with UPDATE | `set_updated_at(p_id)` |
| `IF cond THEN RAISE EXCEPTION` | CHECK constraint | `CHECK (price >= 0)` |
| `INSERT INTO audit_table(...)` | SQL function with parameterized INSERT | `audit_log_change(p_op, p_id)` |
| `UPDATE/DELETE WHERE OLD.id` | SQL function with parameterized DML | `cascade_cancel(p_id)` |
| `FOR r IN SELECT... LOOP UPDATE...` | Set-based `UPDATE...FROM (SELECT...) AS _src` | No row-by-row processing |
| `IF cond THEN x ELSE y` | `CASE WHEN cond THEN x ELSE y END` | SQL function |
| `INSERT... EXCEPTION WHEN unique_violation` | `INSERT... ON CONFLICT DO NOTHING` | Upsert pattern |
| `EXECUTE format('DELETE FROM %I', tbl)` | One concrete SQL function per table | Expanded dynamic SQL |
| `DECLARE cur CURSOR FOR SELECT... LOOP UPDATE...` | Set-based `UPDATE...FROM` | Cursor eliminated |
| `EXCEPTION WHEN no_data_found` | `SELECT COALESCE((SELECT...), NULL)` | Defensive query |

**Only two things still get stubs:** `PERFORM` (no SQL equivalent) and deeply nested ELSIF chains (3+ branches). Everything else produces runnable DDL.

### Triggers

| Source | Output |
|--------|--------|
| BEFORE UPDATE (updated_at pattern) | SQL function: `set_updated_at_<table>(p_id)` |
| Other triggers | SQL function stub: `trigger_replacement_<name>(p_id)` |

### Extensions

| Source | Output |
|--------|--------|
| pgcrypto | `gen_random_uuid()` is built into DSQL |
| uuid-ossp | `gen_random_uuid()` is built into DSQL |
| pg_stat_statements | Available by default |
| Others | Noted as unavailable |

## MCP Tools

| Tool | What It Does |
|------|-------------|
| `convert_schema` | Full conversion: DDL + report. Pass `sql` text or `file_path`. |
| `analyze_compatibility` | Report only — shows what would change, no DDL output. |
| `list_type_mappings` | Shows the source → normalized → DSQL type pipeline. |
| `list_supported_dialects` | Lists supported source dialects (currently: postgresql). |

## Project Structure

```
dsql-schema-converter/
├── POWER.md                          # Kiro Power metadata, onboarding, steering mappings
├── mcp.json                          # MCP server configuration
├── README.md
├── examples/
│   └── sample-postgresql.sql         # Realistic PG schema for testing
├── ui/                               # Browser-based demo UI
│   ├── index.html                    # Single-page app (paste SQL → get DSQL)
│   └── lib/                          # Browser-compatible converter modules
├── steering/
│   ├── postgresql-conversion.md      # PG-specific type mapping rules
│   ├── dsql-constraints.md           # DSQL platform constraints reference
│   └── extending-dialects.md         # Guide for adding MySQL, CockroachDB, Spanner
└── mcp-server/
    ├── package.json
    └── src/
        ├── index.js                  # MCP server (4 tools)
        ├── sql-parser.js             # SQL DDL parser (handles dollar-quoting, multi-word types, etc.)
        ├── converter.js              # Conversion engine + adapter registry
        ├── plpgsql-transpiler.js     # PL/pgSQL → SQL transpiler (10 patterns)
        ├── dsql-constraints.js       # NormalizedType enum + Stage 2 mapping
        ├── type-mappings/
        │   └── postgresql.js         # PG → NormalizedType (Stage 1)
        └── tests/
            └── converter.test.js     # 25 tests
```

## Running Tests

```bash
cd mcp-server
npm install
npm test
```

25 tests covering: SQL parser, all 10 transpiler patterns, full converter pipeline, and edge cases.

## Architecture

### Two-stage type pipeline

Source types → `NormalizedType` (18 types) → DSQL SQL type strings. Adding a new dialect only requires Stage 1 mappings. Stage 2 is fixed.

### Adapter registry

The `ADAPTERS` object in `converter.js` maps dialect names to type mappings. Adding MySQL: create `type-mappings/mysql.js`, register in `ADAPTERS`, update tool schema.

### PL/pgSQL transpiler

Pattern-matching on the function body. Recognizes 10 common patterns and generates equivalent SQL. Falls through to a stub only when the pattern is genuinely impossible in SQL (PERFORM, complex ELSIF chains).

### Regex parser

Not a full SQL grammar — a regex/state-machine that handles dollar-quoted strings, multi-word types (`TIMESTAMP WITH TIME ZONE`), inline REFERENCES, matching parens for PARTITION BY / INHERITS, and ENUM value extraction. Zero native dependencies.

## Learnings

1. **Read the docs before assuming constraints.** We initially built a counter table to replace sequences because the DSQL Migration Toolkit said sequences weren't supported. The actual DSQL docs show `CREATE SEQUENCE` is fully supported with `CACHE 1` or `CACHE >= 65536`. Always check the primary source.

2. **Don't build a report generator, build a converter.** The first version flagged things as "requires manual review." That's a linter, not a tool. The rewrite converts everything: ENUMs → CHECK constraints, triggers → SQL functions, cursors → set-based operations, dynamic SQL → expanded concrete functions.

3. **PL/pgSQL patterns are finite.** There are maybe 10-15 common patterns that cover 95% of real-world trigger/function usage. Pattern-matching on the function body and generating SQL equivalents is more practical than building a full PL/pgSQL-to-SQL compiler.

4. **DSQL's SQL is more capable than you think.** CTEs, CASE WHEN, UPDATE...FROM, INSERT...SELECT, ON CONFLICT — these cover most of what PL/pgSQL control flow does. The gap between "SQL functions only" and "PL/pgSQL" is smaller than it appears.

5. **Kiro Powers are documentation-first.** The POWER.md keywords drive activation. Steering files keep context focused. The MCP server is just the execution layer.

## Future Work

- [ ] MySQL adapter (AUTO_INCREMENT, ENUM/SET, DATETIME)
- [ ] CockroachDB adapter (STRING, interleaved tables, GEOGRAPHY)
- [ ] Spanner adapter (INT64, STRING(N), ARRAY<T>)
- [ ] Live database connection (read schema from pg_catalog directly)
- [ ] ELSIF chain → nested CASE WHEN conversion
- [ ] Publish to GitHub for community installation
