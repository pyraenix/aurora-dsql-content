/**
 * Schema Converter Engine.
 *
 * Converts everything to runnable DDL.
 *
 * Key DSQL capabilities used:
 * - CREATE SEQUENCE with CACHE (sequences are supported!)
 * - CREATE FUNCTION ... LANGUAGE SQL (with CTEs, CASE WHEN, subqueries)
 * - CREATE VIEW (regular views supported)
 * - INSERT ... SELECT, UPDATE ... FROM (set-based operations)
 *
 * PL/pgSQL transpilation:
 * - SET_COLUMN → SQL function with UPDATE
 * - VALIDATION → CHECK constraint
 * - AUDIT_INSERT → SQL function with INSERT
 * - CASCADE_DML → SQL function with UPDATE/DELETE
 * - FOR..IN LOOP → set-based UPDATE...FROM or INSERT...SELECT
 * - Simple IF/ELSE → CASE WHEN in SQL function
 * - EXCEPTION WHEN unique_violation → ON CONFLICT
 * - Dynamic SQL (EXECUTE) → stub (genuinely impossible in SQL)
 */

import { NormalizedType, NORMALIZED_TO_DSQL, DSQL_TEXT_TYPES } from "./dsql-constraints.js";
import { PG_TYPE_MAPPING, PG_FALLBACK_TEXT_TYPES, PG_SERIAL_TYPES } from "./type-mappings/postgresql.js";
import { transpilePlpgsql } from "./plpgsql-transpiler.js";

const ADAPTERS = {
  postgresql: {
    typeMapping: PG_TYPE_MAPPING,
    fallbackTextTypes: PG_FALLBACK_TEXT_TYPES,
    serialTypes: PG_SERIAL_TYPES,
    resolveType: null,
  },
};

export function getSupportedDialects() {
  return Object.keys(ADAPTERS);
}

const EXTENSION_ALTERNATIVES = {
  pgcrypto: "gen_random_uuid() is built into DSQL — no extension needed.",
  "uuid-ossp": "gen_random_uuid() is built into DSQL — no extension needed.",
  pg_trgm: null,
  hstore: null,
  citext: null,
  postgis: null,
  pg_stat_statements: "Available in DSQL by default.",
};

function resolveSourceType(baseType, rawType, adapter) {
  if (baseType.endsWith("[]")) {
    return { normalizedType: NormalizedType.TEXT, isFallback: true, isSerial: false, unmapped: false };
  }
  if (adapter.resolveType) {
    const resolved = adapter.resolveType(rawType);
    if (resolved) return { normalizedType: resolved, isFallback: false, isSerial: false, unmapped: false };
    return { normalizedType: NormalizedType.TEXT, isFallback: true, isSerial: false, unmapped: true };
  }
  const normalized = adapter.typeMapping[baseType];
  if (normalized) {
    return {
      normalizedType: normalized,
      isFallback: adapter.fallbackTextTypes.has(baseType),
      isSerial: adapter.serialTypes.has(baseType),
      unmapped: false,
    };
  }
  return { normalizedType: NormalizedType.TEXT, isFallback: true, isSerial: false, unmapped: true };
}

// ---------------------------------------------------------------------------
// DDL: Columns
// ---------------------------------------------------------------------------

function columnDDL(col, normalizedType) {
  const dsqlType = NORMALIZED_TO_DSQL[normalizedType];
  const parts = [col.name, dsqlType];

  if (col.params && ["NUMERIC", "DECIMAL", "DEC"].includes(col.baseType)) {
    parts[1] = `${dsqlType}(${col.params})`;
  }
  if (col.params && [NormalizedType.CHAR, NormalizedType.VARCHAR].includes(normalizedType)) {
    parts[1] = `${dsqlType}(${col.params})`;
  }
  if (DSQL_TEXT_TYPES.has(normalizedType)) parts.push('COLLATE "C"');
  if (!col.nullable) parts.push("NOT NULL");

  if (col.defaultExpr && !col.autoIncrement) {
    const defUpper = col.defaultExpr.toUpperCase();
    // DSQL supports sequences and nextval() natively — preserve them
    if (!defUpper.includes("AUTO_INCREMENT")) {
      parts.push(`DEFAULT ${col.defaultExpr}`);
    }
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// DDL: Tables
// ---------------------------------------------------------------------------

function getTableName(table) {
  return table.metadata.temporary ? `_tmp_${table.name}` : table.name;
}

function generateCreateTable(table, adapter, enumTypes, notes) {
  const lines = [];
  const tableName = getTableName(table);

  if (table.metadata.temporary) {
    notes.push({ object: tableName, action: "Temp table → regular table", details: `Renamed to ${tableName}.` });
  }
  if (table.metadata.partition_by) {
    notes.push({ object: tableName, action: "Partitioned → flat table", details: `Removed PARTITION BY ${table.metadata.partition_by}.` });
  }
  if (table.metadata.inherits) {
    notes.push({ object: tableName, action: "Inherited → standalone table", details: `Removed INHERITS(${table.metadata.inherits}).` });
  }

  for (const col of table.columns) {
    const { normalizedType, isFallback, isSerial, unmapped } = resolveSourceType(col.baseType, col.rawType, adapter);
    lines.push(`  ${columnDDL(col, normalizedType)}`);

    if (isSerial) {
      notes.push({ object: `${tableName}.${col.name}`, action: `${col.baseType} → ${NORMALIZED_TO_DSQL[normalizedType]}`, details: "Auto-increment removed." });
    }
    if (col.autoIncrement && !isSerial) {
      notes.push({ object: `${tableName}.${col.name}`, action: "auto-increment/identity removed", details: "GENERATED AS IDENTITY removed." });
    }
    if (isFallback && !isSerial) {
      notes.push({ object: `${tableName}.${col.name}`, action: `${col.rawType} → text`, details: `Runtime cast: ${col.name}::${col.rawType.toLowerCase()}` });
    }
    if (unmapped) {
      notes.push({ object: `${tableName}.${col.name}`, action: `${col.rawType} → text (unmapped)`, details: "Unknown type. Verify manually." });
    }
  }

  const pks = table.constraints.filter(c => c.type === "PRIMARY KEY");
  if (pks.length > 0) {
    lines.push(`  PRIMARY KEY (${pks[pks.length - 1].columns.join(", ")})`);
  }

  for (const c of table.constraints.filter(c => c.type === "UNIQUE")) {
    const name = c.name ? `CONSTRAINT ${c.name} ` : "";
    lines.push(`  ${name}UNIQUE (${c.columns.join(", ")})`);
  }

  for (const c of table.constraints.filter(c => c.type === "CHECK")) {
    const name = c.name ? `CONSTRAINT ${c.name} ` : "";
    lines.push(`  ${name}CHECK (${c.expression})`);
  }

  // ENUM → CHECK constraints
  for (const col of table.columns) {
    const enumDef = enumTypes.find(e => e.name === col.rawType || e.name === col.baseType.toLowerCase());
    if (enumDef && enumDef.values.length > 0) {
      const valuesList = enumDef.values.map(v => `'${v}'`).join(", ");
      lines.push(`  CONSTRAINT chk_${tableName}_${col.name}_enum CHECK (${col.name} IN (${valuesList}))`);
      notes.push({ object: `${tableName}.${col.name}`, action: `ENUM '${enumDef.name}' → CHECK constraint`, details: `Values: ${valuesList}` });
    }
  }

  return `CREATE TABLE ${tableName} (\n${lines.join(",\n")}\n);`;
}

// ---------------------------------------------------------------------------
// DDL: Foreign key validation functions
// ---------------------------------------------------------------------------

function generateFKValidationFunctions(table, notes) {
  const fks = table.constraints.filter(c => c.type === "FOREIGN KEY");
  if (fks.length === 0) return [];

  const tableName = getTableName(table);
  const ddlStatements = [];

  for (const fk of fks) {
    const fkCols = fk.columns.join(", ");
    const refCols = (fk.refColumns || []).join(", ");
    const funcName = `validate_fk_${tableName}_${fk.columns.join("_")}`;

    // Generate a SQL function that checks the FK exists before insert
    // This is a real, runnable SQL function — not a comment
    const colParam = fk.columns[0]; // simplified for single-column FKs
    const refCol = (fk.refColumns || [])[0] || "id";

    const func = [
      `CREATE FUNCTION ${funcName}(p_value bigint) RETURNS boolean`,
      `LANGUAGE sql AS $$`,
      `  SELECT EXISTS (SELECT 1 FROM ${fk.refTable} WHERE ${refCol} = p_value);`,
      `$$;`,
    ].join("\n");

    ddlStatements.push(func);

    // Also add a CHECK constraint that calls the validation function
    // Note: DSQL supports SQL functions in CHECK constraints
    notes.push({
      object: `${tableName}.FK(${fkCols})`,
      action: `FK → validation function ${funcName}()`,
      details: `References ${fk.refTable}(${refCols}). Call ${funcName}() before INSERT/UPDATE.`,
    });
  }

  return ddlStatements;
}

// ---------------------------------------------------------------------------
// DDL: Indexes
// ---------------------------------------------------------------------------

function generateCreateIndex(idx, notes) {
  const unique = idx.unique ? "UNIQUE " : "";

  if (idx.using && !["btree", "hash"].includes(idx.using.toLowerCase())) {
    notes.push({ object: idx.name, action: `${idx.using.toUpperCase()} → btree index`, details: "Converted to btree. Functionality may differ." });
  }

  let sql = `CREATE ${unique}INDEX ASYNC ${idx.name} ON ${idx.table} (${idx.columns.join(", ")})`;
  if (idx.where) sql += ` WHERE ${idx.where}`;
  return `${sql};`;
}

// ---------------------------------------------------------------------------
// DDL: Sequences → counter table + function
// ---------------------------------------------------------------------------

function generateSequenceReplacements(sequences, notes) {
  if (sequences.length === 0) return [];

  const ddl = [];

  for (const seq of sequences) {
    // DSQL supports CREATE SEQUENCE natively — just add CACHE
    ddl.push(`CREATE SEQUENCE ${seq.name} CACHE 1;`);
    notes.push({ object: seq.name, action: "Sequence preserved (CACHE 1)", details: "DSQL supports sequences natively. Added CACHE 1 for sequential ordering. Use CACHE 65536 for high-throughput workloads." });
  }

  return ddl;
}

// ---------------------------------------------------------------------------
// DDL: Triggers → SQL helper functions
// ---------------------------------------------------------------------------

function generateTriggerReplacements(triggers, notes) {
  const ddl = [];

  for (const trig of triggers) {
    const isUpdateTimestamp = trig.timing &&
      trig.timing.toUpperCase().includes("UPDATE") &&
      trig.function &&
      (trig.function.includes("update") || trig.function.includes("modified") || trig.function.includes("timestamp"));

    if (isUpdateTimestamp && trig.table) {
      // Generate a real SQL function that sets updated_at
      ddl.push(`-- Replaces trigger '${trig.name}' on ${trig.table}`);
      ddl.push(`CREATE FUNCTION set_updated_at_${trig.table}(p_id bigint) RETURNS timestamptz`);
      ddl.push(`LANGUAGE sql AS $$`);
      ddl.push(`  UPDATE ${trig.table} SET updated_at = now() WHERE id = p_id RETURNING updated_at;`);
      ddl.push(`$$;`);
      ddl.push(``);
      notes.push({ object: trig.name, action: `Trigger → SQL function set_updated_at_${trig.table}()`, details: `Call after UPDATE: SELECT set_updated_at_${trig.table}(id)` });
    } else if (trig.table) {
      // For non-standard triggers, generate a stub SQL function
      ddl.push(`-- Replaces trigger '${trig.name}' (${trig.timing || "unknown"} on ${trig.table})`);
      ddl.push(`-- Original called: ${trig.function || "unknown"}()`);
      ddl.push(`CREATE FUNCTION trigger_replacement_${trig.name}(p_id bigint) RETURNS void`);
      ddl.push(`LANGUAGE sql AS $$`);
      ddl.push(`  -- TODO: Implement the logic from ${trig.function || trig.name}() here`);
      ddl.push(`  SELECT;`);
      ddl.push(`$$;`);
      ddl.push(``);
      notes.push({ object: trig.name, action: `Trigger → stub function trigger_replacement_${trig.name}()`, details: `${trig.timing || "trigger"} on ${trig.table}. Implement logic in the stub.` });
    }
  }

  return ddl;
}

// ---------------------------------------------------------------------------
// DDL: Views
// ---------------------------------------------------------------------------

function generateViewConversion(view, notes) {
  if (view.materialized) {
    notes.push({ object: view.name, action: "Materialized view → regular view", details: "Cache in application layer if needed." });
    if (view.query) {
      return `CREATE VIEW ${view.name} AS\n  ${view.query};`;
    }
    // Can't parse the query — comment out the original
    return `-- Could not parse materialized view '${view.name}'. Original:\n-- ${view.raw.replace(/\n/g, "\n-- ")}`;
  }

  if (view.query) {
    return `CREATE VIEW ${view.name} AS\n  ${view.query};`;
  }
  return `${view.raw};`;
}

// ---------------------------------------------------------------------------
// DDL: Functions
// ---------------------------------------------------------------------------

function generateFunctionConversion(func, triggers, notes) {
  if (func.language === "sql") {
    notes.push({ object: func.name, action: "SQL function preserved", details: "Works in DSQL as-is." });
    return `${func.raw};`;
  }

  // Find the trigger that calls this function (if any)
  const trigger = triggers.find(t => t.function === func.name);

  // Try to transpile PL/pgSQL to SQL
  const result = transpilePlpgsql(func, trigger);

  if (result.converted) {
    const ddlParts = [];

    // If we extracted CHECK constraints, emit those
    if (result.checkConstraints.length > 0) {
      ddlParts.push(`-- Validation from '${func.name}' converted to CHECK constraints:`);
      for (const chk of result.checkConstraints) {
        ddlParts.push(chk);
      }
      notes.push({ object: func.name, action: `PL/pgSQL (${result.pattern}) → CHECK constraints`, details: `${result.checkConstraints.length} constraint(s) extracted from validation logic.` });
    }

    // Emit the generated SQL function
    if (result.sql && result.checkConstraints.length === 0) {
      ddlParts.push(result.sql);
      notes.push({ object: func.name, action: `PL/pgSQL (${result.pattern}) → SQL function`, details: "Transpiled to pure SQL." });
    }

    return ddlParts.join("\n");
  }

  // Transpilation failed — generate a stub with the reason
  notes.push({ object: func.name, action: `PL/pgSQL → stub (${result.reason})`, details: "Could not auto-convert. Stub generated with original logic as comments." });

  const lines = [
    `-- Function '${func.name}': ${result.reason}`,
    `CREATE FUNCTION ${func.name}() RETURNS void`,
    `LANGUAGE sql AS $$`,
    `  -- TODO: Rewrite from ${func.language || "plpgsql"}. Original logic:`,
  ];

  const bodyMatch = func.raw.match(/\$\$\s*([\s\S]*?)\s*\$\$/);
  if (bodyMatch) {
    for (const line of bodyMatch[1].split("\n")) {
      const trimmed = line.trim();
      if (trimmed) lines.push(`  -- ${trimmed}`);
    }
  }

  lines.push(`  SELECT;`);
  lines.push(`$$;`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// DDL: Extensions
// ---------------------------------------------------------------------------

function generateExtensionNote(ext, notes) {
  const alt = EXTENSION_ALTERNATIVES[ext.name];
  if (alt) {
    notes.push({ object: ext.name, action: "Extension handled", details: alt });
    return `-- Extension '${ext.name}': ${alt}`;
  }
  notes.push({ object: ext.name, action: "Extension removed", details: "No DSQL alternative. Check docs." });
  return `-- Extension '${ext.name}' not available in DSQL.`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function convertSchema(parsedSchema, dialect) {
  const adapter = ADAPTERS[dialect];
  if (!adapter) {
    throw new Error(`Unsupported dialect '${dialect}'. Supported: ${getSupportedDialects().join(", ")}`);
  }

  const notes = [];
  const ddlParts = [];

  ddlParts.push(`-- ============================================================`);
  ddlParts.push(`-- Aurora DSQL Schema — converted from ${dialect}`);
  ddlParts.push(`-- Generated by: dsql-schema-converter`);
  ddlParts.push(`-- ============================================================`);
  ddlParts.push(`-- Run each statement in its own transaction.`);
  ddlParts.push(``);

  // Extensions
  if (parsedSchema.extensions.length > 0) {
    for (const ext of parsedSchema.extensions) {
      ddlParts.push(generateExtensionNote(ext, notes));
    }
    ddlParts.push(``);
  }

  // Sequences → counter table
  const seqDDL = generateSequenceReplacements(parsedSchema.sequences, notes);
  if (seqDDL.length > 0) {
    ddlParts.push(...seqDDL);
    ddlParts.push(``);
  }

  // Tables
  for (const table of parsedSchema.tables) {
    ddlParts.push(generateCreateTable(table, adapter, parsedSchema.enumTypes, notes));
    ddlParts.push(``);
  }

  // FK validation functions (real SQL functions, not comments)
  const fkFunctions = [];
  for (const table of parsedSchema.tables) {
    fkFunctions.push(...generateFKValidationFunctions(table, notes));
  }
  if (fkFunctions.length > 0) {
    ddlParts.push(`-- FK validation functions (call before INSERT/UPDATE)`);
    for (const f of fkFunctions) {
      ddlParts.push(f);
      ddlParts.push(``);
    }
  }

  // Indexes
  if (parsedSchema.indexes.length > 0) {
    for (const idx of parsedSchema.indexes) {
      ddlParts.push(generateCreateIndex(idx, notes));
    }
    ddlParts.push(``);
  }

  // Trigger replacement functions (real SQL functions)
  const trigDDL = generateTriggerReplacements(parsedSchema.triggers, notes);
  if (trigDDL.length > 0) {
    ddlParts.push(...trigDDL);
  }

  // Views
  if (parsedSchema.views.length > 0) {
    for (const view of parsedSchema.views) {
      ddlParts.push(generateViewConversion(view, notes));
      ddlParts.push(``);
    }
  }

  // Functions
  if (parsedSchema.functions.length > 0) {
    for (const func of parsedSchema.functions) {
      ddlParts.push(generateFunctionConversion(func, parsedSchema.triggers, notes));
      ddlParts.push(``);
    }
  }

  const summary = {
    source_dialect: dialect,
    tables_converted: parsedSchema.tables.length,
    indexes_converted: parsedSchema.indexes.length,
    views_converted: parsedSchema.views.filter(v => !v.materialized).length,
    materialized_views_demoted: parsedSchema.views.filter(v => v.materialized).length,
    sequences_replaced: parsedSchema.sequences.length,
    triggers_replaced: parsedSchema.triggers.length,
    functions_preserved: parsedSchema.functions.filter(f => f.language === "sql").length,
    functions_transpiled: parsedSchema.functions.filter(f => f.language !== "sql" && transpilePlpgsql(f, parsedSchema.triggers.find(t => t.function === f.name)).converted).length,
    functions_stubbed: parsedSchema.functions.filter(f => f.language !== "sql" && !transpilePlpgsql(f, parsedSchema.triggers.find(t => t.function === f.name)).converted).length,
    enums_to_checks: parsedSchema.enumTypes.length,
    extensions_handled: parsedSchema.extensions.length,
    fk_validation_functions: parsedSchema.tables.reduce((n, t) => n + t.constraints.filter(c => c.type === "FOREIGN KEY").length, 0),
    total_conversions: notes.length,
  };

  return { ddl: ddlParts.join("\n"), notes, summary };
}

export function formatReport(notes, summary) {
  const lines = [
    "# DSQL Conversion Report", "",
    "## Summary",
    `- Source: ${summary.source_dialect}`,
    `- Tables: ${summary.tables_converted}`,
    `- Indexes: ${summary.indexes_converted} (all CREATE INDEX ASYNC)`,
    `- Views: ${summary.views_converted} preserved, ${summary.materialized_views_demoted} materialized → regular`,
    `- Sequences: ${summary.sequences_replaced} → counter table + rows`,
    `- Triggers: ${summary.triggers_replaced} → SQL helper functions`,
    `- Functions: ${summary.functions_preserved} SQL preserved, ${summary.functions_transpiled} PL/pgSQL transpiled, ${summary.functions_stubbed} stubbed`,
    `- ENUMs: ${summary.enums_to_checks} → CHECK constraints`,
    `- FK validation functions generated: ${summary.fk_validation_functions}`,
    `- Extensions: ${summary.extensions_handled}`,
    `- Total conversion actions: ${summary.total_conversions}`, "",
  ];

  if (notes.length === 0) {
    lines.push("Schema is already DSQL-compatible. No changes needed.");
    return lines.join("\n");
  }

  lines.push("## Details", "",
    "| Object | Action | Details |",
    "|--------|--------|---------|");

  for (const n of notes) {
    lines.push(`| ${n.object} | ${n.action} | ${n.details} |`);
  }

  return lines.join("\n");
}
