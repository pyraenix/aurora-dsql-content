# Aurora DSQL Platform Constraints

This document lists all Aurora DSQL constraints that the schema converter enforces automatically. Source: [Aurora DSQL Documentation](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/).

## Transaction Constraints

| Constraint | Value | How the Converter Handles It |
|-----------|-------|------------------------------|
| Max rows per transaction | 3,000 | Not applicable to DDL conversion (relevant for data migration) |
| DDL per transaction | 1 statement | Each CREATE TABLE / CREATE INDEX output as separate statement |
| DDL + DML separation | Required | Converter outputs only DDL |
| TRUNCATE | Not supported | Never generated |

## Schema Constraints

| Constraint | How the Converter Handles It |
|-----------|------------------------------|
| Temporary tables | Dropped with warning |
| Triggers | Dropped with warning |
| PL/pgSQL functions | Flagged for manual review |
| Foreign key enforcement | Omitted from DDL, documented in report |
| Sequences | Dropped with warning |
| Table inheritance | Dropped with warning |
| Partitioning | Dropped with warning |
| Materialized views | Dropped with warning |
| Custom ENUM types | Columns converted to TEXT |

## Index Constraints

| Constraint | How the Converter Handles It |
|-----------|------------------------------|
| Index creation | Always `CREATE INDEX ASYNC` |
| GIN/GiST/BRIN indexes | Flagged for manual review |
| Partial indexes | Preserved (WHERE clause kept) |

## Data Type Constraints

| Constraint | How the Converter Handles It |
|-----------|------------------------------|
| Stored JSON/JSONB | Mapped to TEXT |
| Stored arrays | Mapped to TEXT |
| Collation | All text columns get `COLLATE "C"` |
| Encoding | UTF-8 (no conversion needed) |

## Connection Constraints

| Constraint | Value |
|-----------|-------|
| Database per cluster | 1 (`postgres`) |
| Connection timeout | 1 hour |
| OCC conflicts | SQLSTATE 40001 — retry with backoff |

## Supported Stored Data Types

These are the only types DSQL supports as stored column types:

smallint, integer, bigint, real, double precision, numeric, char, varchar, bpchar, text, date, time, timestamp, timestamptz, interval, boolean, bytea, uuid
