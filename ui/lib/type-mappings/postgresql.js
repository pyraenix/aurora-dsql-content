/**
 * PostgreSQL → NormalizedType mapping (Stage 1).
 *
 * Ported from dsql_migrate/adapters/postgresql_copy/type_mapping.py
 * in the DSQL Migration Toolkit.
 */

import { NormalizedType } from "../dsql-constraints.js";

export const PG_TYPE_MAPPING = Object.freeze({
  // Numeric
  "SMALLINT": NormalizedType.SMALLINT,
  "INT2": NormalizedType.SMALLINT,
  "INTEGER": NormalizedType.INTEGER,
  "INT": NormalizedType.INTEGER,
  "INT4": NormalizedType.INTEGER,
  "BIGINT": NormalizedType.BIGINT,
  "INT8": NormalizedType.BIGINT,
  "REAL": NormalizedType.REAL,
  "FLOAT4": NormalizedType.REAL,
  "DOUBLE PRECISION": NormalizedType.DOUBLE_PRECISION,
  "FLOAT8": NormalizedType.DOUBLE_PRECISION,
  "NUMERIC": NormalizedType.NUMERIC,
  "DECIMAL": NormalizedType.NUMERIC,

  // Serial (auto-increment → integer, sequence dropped)
  "SERIAL": NormalizedType.INTEGER,
  "SERIAL4": NormalizedType.INTEGER,
  "SMALLSERIAL": NormalizedType.SMALLINT,
  "SERIAL2": NormalizedType.SMALLINT,
  "BIGSERIAL": NormalizedType.BIGINT,
  "SERIAL8": NormalizedType.BIGINT,

  // Character
  "CHARACTER": NormalizedType.CHAR,
  "CHAR": NormalizedType.CHAR,
  "CHARACTER VARYING": NormalizedType.VARCHAR,
  "VARCHAR": NormalizedType.VARCHAR,
  "BPCHAR": NormalizedType.BPCHAR,
  "TEXT": NormalizedType.TEXT,

  // Date/time
  "DATE": NormalizedType.DATE,
  "TIME": NormalizedType.TIME,
  "TIME WITHOUT TIME ZONE": NormalizedType.TIME,
  "TIMETZ": NormalizedType.TIMETZ,
  "TIME WITH TIME ZONE": NormalizedType.TIMETZ,
  "TIMESTAMP": NormalizedType.TIMESTAMP,
  "TIMESTAMP WITHOUT TIME ZONE": NormalizedType.TIMESTAMP,
  "TIMESTAMPTZ": NormalizedType.TIMESTAMPTZ,
  "TIMESTAMP WITH TIME ZONE": NormalizedType.TIMESTAMPTZ,
  "INTERVAL": NormalizedType.INTERVAL,

  // Boolean
  "BOOLEAN": NormalizedType.BOOLEAN,
  "BOOL": NormalizedType.BOOLEAN,

  // Binary
  "BYTEA": NormalizedType.BYTEA,

  // UUID
  "UUID": NormalizedType.UUID,

  // JSON — DSQL supports json as a stored type (not TEXT!)
  // JSONB is runtime-only in DSQL, so store as json
  "JSON": NormalizedType.JSON,
  "JSONB": NormalizedType.JSON,

  // Fallback types (PG-specific → TEXT, no DSQL stored equivalent)
  "CIDR": NormalizedType.TEXT,
  "INET": NormalizedType.TEXT,
  "MACADDR": NormalizedType.TEXT,
  "MACADDR8": NormalizedType.TEXT,
  "TSVECTOR": NormalizedType.TEXT,
  "TSQUERY": NormalizedType.TEXT,
  "XML": NormalizedType.TEXT,
  "MONEY": NormalizedType.TEXT,
  "BIT": NormalizedType.TEXT,
  "VARBIT": NormalizedType.TEXT,
  "BIT VARYING": NormalizedType.TEXT,
  "OID": NormalizedType.TEXT,
  "REGCLASS": NormalizedType.TEXT,
  "REGTYPE": NormalizedType.TEXT,
  "PG_LSN": NormalizedType.TEXT,
  "POINT": NormalizedType.TEXT,
  "LINE": NormalizedType.TEXT,
  "LSEG": NormalizedType.TEXT,
  "BOX": NormalizedType.TEXT,
  "PATH": NormalizedType.TEXT,
  "POLYGON": NormalizedType.TEXT,
  "CIRCLE": NormalizedType.TEXT,
});

/** Types that trigger a compatibility note when mapped (not errors, just informational). */
export const PG_FALLBACK_TEXT_TYPES = new Set([
  "CIDR", "INET", "MACADDR", "MACADDR8",
  "TSVECTOR", "TSQUERY", "XML", "MONEY",
  "BIT", "VARBIT", "BIT VARYING",
  "OID", "REGCLASS", "REGTYPE", "PG_LSN",
  "POINT", "LINE", "LSEG", "BOX", "PATH", "POLYGON", "CIRCLE",
]);

/** Types that map to json (JSONB → json is a downgrade but preserves JSON functionality). */
export const PG_JSON_TYPES = new Set(["JSON", "JSONB"]);

/** Serial type names. */
export const PG_SERIAL_TYPES = new Set([
  "SERIAL", "SERIAL2", "SERIAL4", "SERIAL8",
  "SMALLSERIAL", "BIGSERIAL",
]);
