# Extending the Schema Converter to New Dialects

The converter is designed with an adapter pattern so new source dialects can be added without modifying the core conversion logic.

## Architecture

```
Source SQL → dsql-lint --fix (production) → Parser → ParsedSchema → Converter (adapter) → DSQL DDL + Report
                                              ↓
                                    plpgsql-transpiler (10 patterns)
```

### Key modules

- **dsql-lint.js**: Integration with AWS's official dsql-lint tool (Rust-based SQL parser). Used in MCP server for proper parsing and validation.
- **sql-parser.js**: Parses raw SQL DDL into a `ParsedSchema` object (tables, columns, constraints, indexes, sequences, triggers, functions, enums, views)
- **dsql-constraints.js**: Defines `NormalizedType` enum (20 types), the fixed Stage 2 mapping (`NormalizedType → DSQL SQL type`), and text-family type set
- **type-mappings/<dialect>.js**: Stage 1 mapping (`source type → NormalizedType`) for each dialect
- **plpgsql-transpiler.js**: Recognizes 10 PL/pgSQL patterns and generates equivalent SQL functions
- **converter.js**: The `ADAPTERS` registry + `convertSchema()` function that ties parsing, type resolution, DDL generation, and PL/pgSQL transpilation together
- **index.js**: MCP server exposing 4 tools + dsql-lint pipeline

## Adding a New Dialect

### Step 1: Create the type mapping file

Create `mcp-server/src/type-mappings/<dialect>.js`:

```javascript
import { NormalizedType } from "../dsql-constraints.js";

export const MY_TYPE_MAPPING = Object.freeze({
  // Direct mappings (type exists in DSQL)
  "INT": NormalizedType.INTEGER,
  "BIGINT": NormalizedType.BIGINT,
  "VARCHAR": NormalizedType.VARCHAR,
  "TIMESTAMP": NormalizedType.TIMESTAMPTZ,

  // JSON types — DSQL supports json as a stored type
  "JSON": NormalizedType.JSON,

  // Fallback types (no DSQL stored equivalent → TEXT)
  "GEOMETRY": NormalizedType.TEXT,
  "ENUM": NormalizedType.TEXT,
});

// Types that trigger a conversion note when mapped to TEXT
export const MY_FALLBACK_TEXT_TYPES = new Set([
  "GEOMETRY", "ENUM",
]);

// Types that map to JSON (informational note, not an error)
export const MY_JSON_TYPES = new Set(["JSON"]);

// Auto-increment type names
export const MY_SERIAL_TYPES = new Set([
  "AUTO_INCREMENT",
]);
```

### Step 2: Register the adapter in converter.js

Add an entry to the `ADAPTERS` object:

```javascript
import { MY_TYPE_MAPPING, MY_FALLBACK_TEXT_TYPES, MY_SERIAL_TYPES } from "./type-mappings/mydialect.js";

// In the ADAPTERS object:
mydialect: {
  typeMapping: MY_TYPE_MAPPING,
  fallbackTextTypes: MY_FALLBACK_TEXT_TYPES,
  serialTypes: MY_SERIAL_TYPES,
  resolveType: null, // or a custom resolver function for parameterized types
},
```

### Step 3: Update the MCP server tool schemas

In `index.js`, add the new dialect to the `source_dialect` enum in each tool.

### Step 4: Add a steering file

Create `steering/<dialect>-conversion.md` with the type mapping table and dialect-specific rules.

### Step 5: Update POWER.md

Add the new dialect to the description, keywords, tool docs, and steering file mappings.

### Step 6: Update the UI sample-schema.js (optional)

Add dialect-specific sample SQL for the Load Sample button.

## Available NormalizedTypes

The `NormalizedType` enum defines 20 source-agnostic intermediate types that map 1:1 to DSQL stored types:

| NormalizedType | DSQL SQL Type | Notes |
|---|---|---|
| SMALLINT | smallint | |
| INTEGER | integer | |
| BIGINT | bigint | |
| REAL | real | |
| DOUBLE_PRECISION | double precision | |
| NUMERIC | numeric | Preserves (p,s) |
| CHAR | char | COLLATE "C" added |
| VARCHAR | varchar | COLLATE "C" added |
| BPCHAR | bpchar | COLLATE "C" added |
| TEXT | text | COLLATE "C" added |
| DATE | date | |
| TIME | time | |
| TIMETZ | time with time zone | |
| TIMESTAMP | timestamp | |
| TIMESTAMPTZ | timestamptz | |
| INTERVAL | interval | Not indexable |
| BOOLEAN | boolean | |
| BYTEA | bytea | Not indexable |
| UUID | uuid | |
| JSON | json | Supports all JSON operators. Not indexable. |

## Planned Dialects

| Dialect | Status | Key Challenges |
|---------|--------|----------------|
| PostgreSQL | Done | Baseline dialect |
| MySQL | Planned | AUTO_INCREMENT, ENUM/SET types, DATETIME vs TIMESTAMP, no TIMETZ |
| CockroachDB | Planned | STRING type, interleaved tables, GEOGRAPHY/GEOMETRY |
| Spanner | Planned | GoogleSQL vs PG dialect, STRING(N)/STRING(MAX), ARRAY<T>, interleaving |

## Custom Type Resolvers

For dialects with parameterized types (like Spanner's `STRING(255)` or `ARRAY<INT64>`), implement a `resolveType(rawType, dialect)` function instead of relying on the static mapping dictionary. The resolver receives the raw type string and returns a `NormalizedType` or `null` (unmapped).

```javascript
export function resolveMyType(rawType) {
  // STRING(N) where N is a number → VARCHAR
  const match = rawType.match(/^STRING\((\d+)\)$/i);
  if (match) return NormalizedType.VARCHAR;

  // STRING(MAX) → TEXT
  if (/^STRING\(MAX\)$/i.test(rawType)) return NormalizedType.TEXT;

  // ARRAY<...> → TEXT (runtime only in DSQL)
  if (/^ARRAY<.+>$/i.test(rawType)) return NormalizedType.TEXT;

  return null; // unmapped — will default to TEXT with a warning
}
```

## Key Design Decisions

1. **JSONB → json (not TEXT)**: DSQL supports `json` as a stored type with all JSON operators. dsql-lint maps JSONB→TEXT which is more conservative. We follow the [official DSQL docs](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-data-types.html).

2. **Partial indexes removed**: DSQL's CREATE INDEX ASYNC syntax does not include a WHERE clause. Full indexes are created instead.

3. **INCLUDE columns preserved**: DSQL supports `INCLUDE (col1, col2)` in CREATE INDEX ASYNC.

4. **GENERATED ALWAYS AS (expr) STORED preserved**: DSQL supports computed columns natively.

5. **Sequences preserved**: DSQL supports CREATE SEQUENCE with CACHE 1 or CACHE >= 65536.
