# PostgreSQL to Aurora DSQL Conversion Rules

## Type Mapping Pipeline

The converter uses a two-stage type mapping:

**Stage 1** (PostgreSQL → Normalized): Maps PG-specific types to source-agnostic intermediate types.
**Stage 2** (Normalized → DSQL): Fixed 1:1 mapping from normalized types to DSQL SQL type strings.

### Direct Mappings (no data loss)

| PostgreSQL Type | DSQL Type |
|----------------|-----------|
| SMALLINT, INT2 | smallint |
| INTEGER, INT, INT4 | integer |
| BIGINT, INT8 | bigint |
| REAL, FLOAT4 | real |
| DOUBLE PRECISION, FLOAT8 | double precision |
| NUMERIC, DECIMAL | numeric |
| CHAR, CHARACTER | char |
| VARCHAR, CHARACTER VARYING | varchar |
| TEXT | text |
| DATE | date |
| TIME, TIME WITHOUT TIME ZONE | time |
| TIMESTAMP, TIMESTAMP WITHOUT TIME ZONE | timestamp |
| TIMESTAMPTZ, TIMESTAMP WITH TIME ZONE | timestamptz |
| INTERVAL | interval |
| BOOLEAN, BOOL | boolean |
| BYTEA | bytea |
| UUID | uuid |

### Auto-Translated Mappings (stored as TEXT)

These types have no DSQL equivalent. They are mapped to TEXT and flagged in the compatibility report.

| PostgreSQL Type | DSQL Type | Notes |
|----------------|-----------|-------|
| JSON, JSONB | json | DSQL supports `json` as a stored type. JSONB is runtime-only; store as `json`. All JSON operators work. Use `::jsonb` in queries for binary operators. |
| Arrays (e.g., TEXT[], INT[]) | text | Use runtime casts: `column::text[]` |
| CIDR, INET, MACADDR | text | Network address types |
| TSVECTOR, TSQUERY | text | Full-text search types |
| XML | text | |
| MONEY | text | Use NUMERIC instead |
| Geometric types (POINT, LINE, etc.) | text | |
| OID, REGCLASS, REGTYPE | text | System types |

### Serial Types

SERIAL, BIGSERIAL, SMALLSERIAL are converted to their integer equivalents. The implicit sequence is dropped. Use `gen_random_uuid()` for auto-generated primary keys in DSQL.

| PostgreSQL Type | DSQL Type | Action |
|----------------|-----------|--------|
| SERIAL, SERIAL4 | integer | Sequence dropped |
| BIGSERIAL, SERIAL8 | bigint | Sequence dropped |
| SMALLSERIAL, SERIAL2 | smallint | Sequence dropped |

## Features Dropped or Flagged

### Dropped with Warning (omitted from output DDL)

- **Sequences**: `CREATE SEQUENCE` statements are dropped entirely
- **Triggers**: `CREATE TRIGGER` statements are dropped
- **Materialized Views**: Dropped (recreate as regular queries or application logic)
- **Temporary Tables**: Dropped (DSQL does not support them)
- **Foreign Keys**: Omitted from CREATE TABLE (DSQL does not enforce them). Documented in the compatibility report for application-layer enforcement.
- **Table Inheritance**: `INHERITS(...)` clause dropped
- **Partitioning**: `PARTITION BY` clause dropped

### Requires Manual Review

- **PL/pgSQL Functions**: DSQL supports only SQL functions. PL/pgSQL must be rewritten.
- **Extensions**: Each extension must be checked for DSQL compatibility individually.
- **Custom Types**: `CREATE TYPE` (non-enum) requires manual handling.
- **GIN/GiST/BRIN Indexes**: Only btree indexes are guaranteed in DSQL. Other types are flagged.

### Auto-Translated

- **ENUM Types**: Columns using custom ENUMs are converted to TEXT.
- **Fallback Types**: Network, geometric, full-text types → TEXT.
- **Serial Columns**: Converted to integer types, sequence defaults removed.

## DDL Output Rules

1. Each `CREATE TABLE` must run in its own transaction
2. Each `CREATE INDEX ASYNC` must run in its own transaction
3. All text columns include `COLLATE "C"`
4. VARCHAR/CHAR preserve their length parameters: `varchar(255)`
5. NUMERIC preserves precision/scale: `numeric(10,2)`
6. No `REFERENCES` clauses in CREATE TABLE
7. No `TRUNCATE` — use DROP + CREATE instead
8. Default expressions referencing `nextval()` are removed
