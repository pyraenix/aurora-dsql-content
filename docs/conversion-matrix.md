# Conversion Matrix: PostgreSQL → Aurora DSQL

Complete reference of every PostgreSQL feature and how the dsql-schema-converter handles it.

## Data Types

| PostgreSQL Type | DSQL Output | Notes |
|----------------|-------------|-------|
| SMALLINT / INT2 | smallint | Direct mapping |
| INTEGER / INT / INT4 | integer | Direct mapping |
| BIGINT / INT8 | bigint | Direct mapping |
| REAL / FLOAT4 | real | Direct mapping |
| DOUBLE PRECISION / FLOAT8 | double precision | Direct mapping |
| NUMERIC(p,s) / DECIMAL(p,s) | numeric(p,s) | Precision preserved |
| SERIAL | integer | Auto-increment removed. dsql-lint converts to IDENTITY. |
| BIGSERIAL | bigint | Auto-increment removed. dsql-lint converts to IDENTITY. |
| SMALLSERIAL | smallint | Auto-increment removed. dsql-lint converts to IDENTITY. |
| CHAR(n) / CHARACTER(n) | char(n) | Length preserved. COLLATE "C" added. |
| VARCHAR(n) / CHARACTER VARYING(n) | varchar(n) | Length preserved. COLLATE "C" added. |
| TEXT | text | COLLATE "C" added. |
| BPCHAR(n) | bpchar(n) | COLLATE "C" added. |
| DATE | date | Direct mapping |
| TIME / TIME WITHOUT TIME ZONE | time | Direct mapping |
| TIMETZ / TIME WITH TIME ZONE | time with time zone | Direct mapping |
| TIMESTAMP / TIMESTAMP WITHOUT TIME ZONE | timestamp | Direct mapping |
| TIMESTAMPTZ / TIMESTAMP WITH TIME ZONE | timestamptz | Direct mapping |
| INTERVAL | interval | Direct mapping (not indexable in DSQL) |
| BOOLEAN / BOOL | boolean | Direct mapping |
| BYTEA | bytea | Direct mapping (not indexable in DSQL) |
| UUID | uuid | Direct mapping |
| JSON | json | Direct mapping — DSQL supports json natively |
| JSONB | json | Downgraded to json. All JSON operators still work. Use ::jsonb in queries. **Note:** dsql-lint converts JSONB→TEXT. This converter uses JSONB→json per [DSQL docs](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-data-types.html) which list json as a supported stored type. |
| TEXT[] / INT[] / etc. | text | Arrays are runtime-only in DSQL. Store as text, cast in queries. |
| INET | text | Runtime-only in DSQL. Store as text, cast with ::inet in queries. |
| CIDR | text | No DSQL equivalent |
| MACADDR / MACADDR8 | text | No DSQL equivalent |
| TSVECTOR | text | No DSQL equivalent. Use LIKE/ILIKE for text search. |
| TSQUERY | text | No DSQL equivalent |
| XML | text | No DSQL equivalent |
| MONEY | text | Use NUMERIC instead |
| POINT / LINE / LSEG / BOX / PATH / POLYGON / CIRCLE | text | No DSQL equivalent. Store as text or use NUMERIC columns for coordinates. |
| BIT / VARBIT / BIT VARYING | text | No DSQL equivalent |
| OID / REGCLASS / REGTYPE | text | System types — no DSQL equivalent |
| PG_LSN | text | No DSQL equivalent |
| LTREE | text | Extension type — not available in DSQL |

## Schema Objects

| PostgreSQL Feature | DSQL Output | Automatic? | Notes |
|-------------------|-------------|------------|-------|
| CREATE TABLE | CREATE TABLE | ✅ Yes | Types mapped, COLLATE "C" added to text columns |
| PRIMARY KEY | PRIMARY KEY | ✅ Yes | Preserved identically |
| UNIQUE constraint | UNIQUE | ✅ Yes | Preserved identically |
| CHECK constraint | CHECK | ✅ Yes | Preserved identically |
| NOT NULL | NOT NULL | ✅ Yes | Preserved identically |
| DEFAULT expression | DEFAULT | ✅ Yes | Preserved (except nextval — see Sequences) |
| GENERATED ALWAYS AS (expr) STORED | Preserved | ✅ Yes | DSQL supports computed/generated columns natively |
| FOREIGN KEY | validate_fk_*() SQL function | ⚠️ App must call | DSQL does not enforce FKs. Function generated for app-layer validation. |
| CREATE SEQUENCE | CREATE SEQUENCE ... CACHE 1 | ✅ Yes | DSQL supports sequences natively. CACHE clause added. |
| nextval() default | Preserved | ✅ Yes | Works with DSQL sequences |
| CREATE INDEX | CREATE INDEX ASYNC | ✅ Yes | DSQL requires ASYNC. Built asynchronously. |
| GIN index | CREATE INDEX ASYNC (btree) | ✅ Yes | USING clause removed. Btree used. |
| GiST index | CREATE INDEX ASYNC (btree) | ✅ Yes | USING clause removed. Btree used. |
| BRIN index | CREATE INDEX ASYNC (btree) | ✅ Yes | USING clause removed. Btree used. |
| Partial index (WHERE) | WHERE clause removed | ✅ Yes | DSQL does not support partial indexes (WHERE clause not in CREATE INDEX ASYNC syntax). Full index created instead — indexes all rows, uses more storage but provides same query performance for lookups. |
| INCLUDE columns | Preserved | ✅ Yes | DSQL supports INCLUDE (non-key columns) in CREATE INDEX ASYNC. |
| Expression indexes | Not detected | — | Not supported in DSQL. Caught by dsql-lint in production pipeline. |
| CREATE VIEW | CREATE VIEW | ✅ Yes | Regular views work in DSQL |
| CREATE MATERIALIZED VIEW | CREATE VIEW | ✅ Yes | Demoted to regular view. Cache in app layer if needed. |
| ENUM type | CHECK constraint | ✅ Yes | Column becomes TEXT + CHECK (col IN ('val1', 'val2', ...)) |
| Custom TYPE | Flagged | ❌ Manual | DSQL does not support CREATE TYPE (non-enum) |
| TEMPORARY TABLE | Regular table with _tmp_ prefix | ✅ Yes | DSQL does not support temp tables |
| PARTITION BY | Flat table (clause removed) | ✅ Yes | DSQL handles distribution automatically |
| INHERITS | Flat table (clause removed) | ✅ Yes | Table created standalone |
| CREATE EXTENSION (pgcrypto, uuid-ossp) | Not needed | ✅ Yes | gen_random_uuid() is built into DSQL |
| CREATE EXTENSION (pg_trgm, postgis, etc.) | Removed | ✅ Yes | Not available in DSQL |

## PL/pgSQL Functions

| PL/pgSQL Pattern | DSQL Output | Automatic? | Notes |
|-----------------|-------------|------------|-------|
| NEW.col = expr; RETURN NEW (SET_COLUMN) | SQL function with UPDATE | ⚠️ App must call | e.g., set_updated_at_users(p_id) |
| IF cond THEN RAISE EXCEPTION (VALIDATION) | CHECK constraint | ✅ Yes | Enforced automatically by database |
| INSERT INTO audit_table (AUDIT_INSERT) | SQL function with parameterized INSERT | ⚠️ App must call | e.g., audit_log_change(p_op, p_id, ...) |
| UPDATE/DELETE WHERE OLD.id (CASCADE_DML) | SQL function with parameterized DML | ⚠️ App must call | e.g., cascade_close_tickets(p_id) |
| FOR r IN SELECT... LOOP UPDATE... (FOR_LOOP) | UPDATE...FROM (SELECT...) AS _src | ✅ Yes | Set-based, no row-by-row |
| IF cond THEN x ELSE y (IF_ELSE) | CASE WHEN in SQL function | ✅ Yes | Pure SQL |
| INSERT... EXCEPTION WHEN unique_violation (UPSERT) | INSERT... ON CONFLICT DO NOTHING/UPDATE | ✅ Yes | Native PostgreSQL upsert syntax |
| EXECUTE format('DML %I', tbl) (DYNAMIC_SQL) | One concrete SQL function per table | ⚠️ Template | Generate one function per target table |
| DECLARE cur CURSOR FOR... LOOP (CURSOR) | Set-based UPDATE...FROM or INSERT...SELECT | ✅ Yes | Eliminates row-by-row processing |
| EXCEPTION WHEN no_data_found (DEFENSIVE) | SELECT COALESCE((SELECT...), NULL) | ✅ Yes | Defensive query pattern |
| PERFORM (side effects) | Stub with TODO | ❌ Manual | No SQL equivalent for fire-and-forget calls |
| Complex ELSIF (3+ branches) | Stub with TODO | ❌ Manual | Too complex for automated conversion |

## Triggers

| Trigger Pattern | DSQL Output | Automatic? | Notes |
|----------------|-------------|------------|-------|
| BEFORE UPDATE (updated_at) | set_updated_at_table(p_id) SQL function | ⚠️ App must call | Call after every UPDATE |
| BEFORE INSERT (validation) | CHECK constraint (if pattern matches) | ✅ Yes | Enforced by database |
| AFTER INSERT/UPDATE (audit) | audit_*() SQL function | ⚠️ App must call | Call after INSERT/UPDATE |
| BEFORE DELETE (cascade) | cascade_*() SQL function | ⚠️ App must call | Call before DELETE |
| Other triggers | trigger_replacement_*() stub | ⚠️ App must implement | Stub generated with original logic as comments |

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ Yes | Fully automatic — runs in DSQL without application changes |
| ⚠️ App must call | Logic preserved as SQL function — application must call it explicitly |
| ⚠️ Template | Pattern generated — developer fills in per-table specifics |
| ❌ Manual | Cannot be auto-converted — requires manual rewrite |
