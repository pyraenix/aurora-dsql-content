/**
 * Aurora DSQL constraints and the fixed Stage 2 type mapping.
 *
 * These are the ground-truth rules every source adapter must respect.
 * Based on: https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-data-types.html
 */

export const NormalizedType = Object.freeze({
  // Numeric
  SMALLINT: "SMALLINT",
  INTEGER: "INTEGER",
  BIGINT: "BIGINT",
  REAL: "REAL",
  DOUBLE_PRECISION: "DOUBLE_PRECISION",
  NUMERIC: "NUMERIC",
  // Character
  CHAR: "CHAR",
  VARCHAR: "VARCHAR",
  BPCHAR: "BPCHAR",
  TEXT: "TEXT",
  // Date/time
  DATE: "DATE",
  TIME: "TIME",
  TIMETZ: "TIMETZ",
  TIMESTAMP: "TIMESTAMP",
  TIMESTAMPTZ: "TIMESTAMPTZ",
  INTERVAL: "INTERVAL",
  // Misc
  BOOLEAN: "BOOLEAN",
  BYTEA: "BYTEA",
  UUID: "UUID",
  JSON: "JSON",
});

/** Stage 2: NormalizedType → DSQL SQL type string (fixed, never changes). */
export const NORMALIZED_TO_DSQL = Object.freeze({
  [NormalizedType.SMALLINT]: "smallint",
  [NormalizedType.INTEGER]: "integer",
  [NormalizedType.BIGINT]: "bigint",
  [NormalizedType.REAL]: "real",
  [NormalizedType.DOUBLE_PRECISION]: "double precision",
  [NormalizedType.NUMERIC]: "numeric",
  [NormalizedType.CHAR]: "char",
  [NormalizedType.VARCHAR]: "varchar",
  [NormalizedType.BPCHAR]: "bpchar",
  [NormalizedType.TEXT]: "text",
  [NormalizedType.DATE]: "date",
  [NormalizedType.TIME]: "time",
  [NormalizedType.TIMETZ]: "time with time zone",
  [NormalizedType.TIMESTAMP]: "timestamp",
  [NormalizedType.TIMESTAMPTZ]: "timestamptz",
  [NormalizedType.INTERVAL]: "interval",
  [NormalizedType.BOOLEAN]: "boolean",
  [NormalizedType.BYTEA]: "bytea",
  [NormalizedType.UUID]: "uuid",
  [NormalizedType.JSON]: "json",
});

/** Text-family types that require COLLATE "C" in DDL. */
export const DSQL_TEXT_TYPES = new Set([
  NormalizedType.TEXT,
  NormalizedType.VARCHAR,
  NormalizedType.CHAR,
  NormalizedType.BPCHAR,
]);
