/**
 * Lightweight SQL DDL parser.
 *
 * Extracts CREATE TABLE, CREATE INDEX, CREATE SEQUENCE, CREATE TRIGGER,
 * CREATE VIEW, CREATE FUNCTION, and ALTER TABLE ... ADD FOREIGN KEY
 * from raw SQL text.
 *
 * This is a regex/state-machine parser — not a full SQL grammar — because
 * we only need structural information for schema conversion.
 */

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function stripComments(sql) {
  let result = sql.replace(/\/\*[\s\S]*?\*\//g, "");
  result = result.replace(/--[^\n]*/g, "");
  return result;
}

function splitStatements(sql) {
  const statements = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let parenDepth = 0;
  let inDollarQuote = false;
  let dollarTag = "";

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    // Dollar-quoted strings (PostgreSQL)
    if (!inSingleQuote && !inDoubleQuote) {
      if (ch === "$" && !inDollarQuote) {
        const tagMatch = sql.slice(i).match(/^\$([a-zA-Z_]*)\$/);
        if (tagMatch) {
          dollarTag = tagMatch[0];
          inDollarQuote = true;
          current += dollarTag;
          i += dollarTag.length - 1;
          continue;
        }
      } else if (inDollarQuote && ch === "$") {
        const endTag = sql.slice(i, i + dollarTag.length);
        if (endTag === dollarTag) {
          inDollarQuote = false;
          current += dollarTag;
          i += dollarTag.length - 1;
          continue;
        }
      }
    }

    if (inDollarQuote) { current += ch; continue; }

    if (ch === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    else if (ch === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;

    if (!inSingleQuote && !inDoubleQuote) {
      if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth--;
      if (ch === ";" && parenDepth <= 0) {
        const trimmed = current.trim();
        if (trimmed) statements.push(trimmed);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);
  return statements;
}

function unquote(name) {
  if (!name) return name;
  const t = name.trim();
  if ((t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("`") && t.endsWith("`"))) {
    return t.slice(1, -1);
  }
  return t;
}

function splitTopLevelCommas(text) {
  const parts = [];
  let current = "";
  let depth = 0;
  let inSQ = false;
  let inDQ = false;
  for (const ch of text) {
    if (ch === "'" && !inDQ) inSQ = !inSQ;
    else if (ch === '"' && !inSQ) inDQ = !inDQ;
    if (!inSQ && !inDQ) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function extractParenColumns(text) {
  const m = text.match(/\(([^)]+)\)/);
  if (!m) return [];
  return m[1].split(",").map(c => unquote(c.trim()));
}

// -----------------------------------------------------------------------
// Type extraction
// -----------------------------------------------------------------------

const MULTI_WORD_TYPES = [
  "DOUBLE PRECISION", "CHARACTER VARYING",
  "TIMESTAMP WITH TIME ZONE", "TIMESTAMP WITHOUT TIME ZONE",
  "TIME WITH TIME ZONE", "TIME WITHOUT TIME ZONE",
  "BIT VARYING",
];

function extractType(text) {
  const upperText = text.toUpperCase().replace(/\s+/g, " ");

  for (const mwt of MULTI_WORD_TYPES) {
    if (upperText.startsWith(mwt)) {
      const afterType = text.slice(mwt.length).trim();
      const pm = afterType.match(/^\(([^)]*)\)/);
      const params = pm ? pm[1] : null;
      const rest = pm ? afterType.slice(pm[0].length).trim() : afterType;
      const rawType = params ? `${mwt}(${params})` : mwt;
      return { rawType, baseType: mwt, params, rest };
    }
  }

  const m = text.match(/^(\w+)(\([^)]*\))?(\[\])?/i);
  if (!m) return { rawType: text, baseType: text.toUpperCase(), params: null, rest: "" };

  const word = m[1];
  const paramsStr = m[2] || "";
  const arrayBrackets = m[3] || "";
  const params = paramsStr ? paramsStr.slice(1, -1) : null;
  const rawType = word + paramsStr + arrayBrackets;
  const baseType = (word + arrayBrackets).toUpperCase();
  const rest = text.slice(m[0].length).trim();
  return { rawType, baseType, params, rest };
}

// -----------------------------------------------------------------------
// Column & constraint parsing
// -----------------------------------------------------------------------

function parseColumnDef(text) {
  const identMatch = text.match(/^[""`]?(\w+)[""`]?\s+(.+)$/is);
  if (!identMatch) return null;

  const name = unquote(identMatch[1]);
  const remainder = identMatch[2].trim();

  const reserved = ["PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT", "INDEX", "KEY"];
  if (reserved.includes(name.toUpperCase())) return null;

  const { rawType, baseType, params, rest } = extractType(remainder);

  const upperRest = rest.toUpperCase();
  const nullable = !upperRest.includes("NOT NULL");
  // GENERATED AS IDENTITY (auto-increment) — but NOT GENERATED ALWAYS AS (expr) STORED (computed column)
  const autoIncrement = upperRest.includes("AUTO_INCREMENT") ||
    (/\bGENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/i.test(rest));
  const primaryKey = /\bPRIMARY\s+KEY\b/i.test(rest);

  // GENERATED ALWAYS AS (expression) STORED — computed column
  let generatedExpr = null;
  const genMatch = rest.match(/GENERATED\s+ALWAYS\s+AS\s*\((.+?)\)\s*STORED/i);
  if (genMatch) {
    generatedExpr = genMatch[1].trim();
  }

  // Inline REFERENCES (foreign key)
  let refTable = null;
  let refColumns = null;
  const refMatch = rest.match(/REFERENCES\s+[""`]?(\w+)[""`]?\s*\(([^)]+)\)/i);
  if (refMatch) {
    refTable = unquote(refMatch[1]);
    refColumns = refMatch[2].split(",").map(c => unquote(c.trim()));
  }

  let defaultExpr = null;
  const defMatch = rest.match(
    /DEFAULT\s+(.+?)(?:\s+(?:NOT\s+NULL|NULL|PRIMARY|UNIQUE|CHECK|REFERENCES|AUTO_INCREMENT|COLLATE|COMMENT|GENERATED|ON\s+UPDATE)|\s*$)/i
  );
  if (defMatch) {
    defaultExpr = defMatch[1].trim().replace(/,$/, "").trim();
  }

  return { name, rawType, baseType, params, nullable, defaultExpr, autoIncrement, primaryKey, refTable, refColumns, generatedExpr, metadata: { original_type: rawType } };
}

function tryParseConstraint(text) {
  let constraintName = null;
  let rest = text;
  const cnMatch = text.match(/^CONSTRAINT\s+[""`]?(\w+)[""`]?\s+/i);
  if (cnMatch) { constraintName = unquote(cnMatch[1]); rest = text.slice(cnMatch[0].length); }

  const ru = rest.toUpperCase().replace(/\s+/g, " ").trim();

  if (ru.startsWith("PRIMARY KEY")) {
    return { type: "PRIMARY KEY", name: constraintName, columns: extractParenColumns(rest), refTable: null, refColumns: null, expression: null };
  }
  if (ru.startsWith("UNIQUE")) {
    return { type: "UNIQUE", name: constraintName, columns: extractParenColumns(rest), refTable: null, refColumns: null, expression: null };
  }
  if (ru.startsWith("FOREIGN KEY")) {
    const fkCols = extractParenColumns(rest);
    const refMatch = rest.match(/REFERENCES\s+[""`]?(\w+)[""`]?\s*\(([^)]+)\)/i);
    return { type: "FOREIGN KEY", name: constraintName, columns: fkCols, refTable: refMatch ? unquote(refMatch[1]) : null, refColumns: refMatch ? refMatch[2].split(",").map(c => unquote(c.trim())) : null, expression: null };
  }
  if (ru.startsWith("CHECK")) {
    const exprMatch = rest.match(/CHECK\s*\((.+)\)/is);
    return { type: "CHECK", name: constraintName, columns: [], refTable: null, refColumns: null, expression: exprMatch ? exprMatch[1].trim() : rest };
  }
  if (cnMatch) {
    return { type: "UNKNOWN", name: constraintName, columns: [], refTable: null, refColumns: null, expression: rest };
  }
  return null;
}

function parseTableBody(body) {
  const columns = [];
  const constraints = [];
  for (const part of splitTopLevelCommas(body)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const c = tryParseConstraint(trimmed);
    if (c) { constraints.push(c); continue; }
    const col = parseColumnDef(trimmed);
    if (col) {
      columns.push(col);
      if (col.primaryKey) {
        constraints.push({ type: "PRIMARY KEY", name: null, columns: [col.name], refTable: null, refColumns: null, expression: null });
      }
      if (col.refTable) {
        constraints.push({ type: "FOREIGN KEY", name: null, columns: [col.name], refTable: col.refTable, refColumns: col.refColumns, expression: null });
      }
    }
  }
  return { columns, constraints };
}

// -----------------------------------------------------------------------
// Public: parseSQL
// -----------------------------------------------------------------------

export function parseSQL(sql) {
  const cleaned = stripComments(sql);
  const stmts = splitStatements(cleaned);

  const schema = {
    tables: [], indexes: [], sequences: [], triggers: [],
    views: [], functions: [], enumTypes: [], customTypes: [],
    extensions: [], unparsed: [],
  };

  for (const stmt of stmts) {
    const upper = stmt.toUpperCase().replace(/\s+/g, " ").trim();

    // CREATE TABLE
    if (/^CREATE\s+(TEMPORARY\s+)?TABLE\b/i.test(upper)) {
      const nameMatch = stmt.match(/CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:[""`]?\w+[""`]?)\.)?[""`]?(\w+)[""`]?/i);
      const tableName = nameMatch ? unquote(nameMatch[1]) : null;
      if (!tableName) { schema.unparsed.push(stmt); continue; }

      const bodyStart = stmt.indexOf("(");
      if (bodyStart === -1) { schema.unparsed.push(stmt); continue; }
      // Find the matching closing paren (not just the last one)
      let bodyEnd = -1;
      let depth = 0;
      for (let i = bodyStart; i < stmt.length; i++) {
        if (stmt[i] === "(") depth++;
        else if (stmt[i] === ")") { depth--; if (depth === 0) { bodyEnd = i; break; } }
      }
      if (bodyEnd === -1) { schema.unparsed.push(stmt); continue; }

      const { columns, constraints } = parseTableBody(stmt.slice(bodyStart + 1, bodyEnd));
      const after = stmt.slice(bodyEnd + 1).trim();
      const metadata = {};

      if (/^CREATE\s+TEMPORARY\s+TABLE\b/i.test(upper)) metadata.temporary = "true";
      const inheritsMatch = after.match(/INHERITS\s*\(([^)]+)\)/i);
      if (inheritsMatch) metadata.inherits = inheritsMatch[1].trim();
      const partMatch = after.match(/PARTITION\s+BY\s+(\w+)\s*\(([^)]+)\)/i);
      if (partMatch) metadata.partition_by = `${partMatch[1]}(${partMatch[2]})`;

      schema.tables.push({ name: tableName, columns, constraints, metadata });
      continue;
    }

    // CREATE INDEX
    if (/^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(upper)) {
      const m = stmt.match(/CREATE\s+(?:(UNIQUE)\s+)?INDEX\s+(?:(?:CONCURRENTLY|ASYNC)\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[""`]?(\w+)[""`]?\s+ON\s+(?:[""`]?\w+[""`]?\.)?[""`]?(\w+)[""`]?\s*(?:USING\s+(\w+)\s*)?\(([^)]+)\)(?:\s+INCLUDE\s*\(([^)]+)\))?(?:\s+WHERE\s+(.+))?/i);
      if (m) {
        schema.indexes.push({
          name: unquote(m[2]), table: unquote(m[3]),
          columns: m[5].split(",").map(c => unquote(c.trim().split(/\s+/)[0])),
          unique: !!m[1], using: m[4] || null,
          include: m[6] ? m[6].split(",").map(c => unquote(c.trim())) : null,
          where: m[7] || null,
        });
      } else { schema.unparsed.push(stmt); }
      continue;
    }

    // CREATE SEQUENCE
    if (/^CREATE\s+SEQUENCE\b/i.test(upper)) {
      const m = stmt.match(/CREATE\s+SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[""`]?\w+[""`]?\.)?[""`]?(\w+)[""`]?/i);
      schema.sequences.push({ name: m ? unquote(m[1]) : "unknown", raw: stmt });
      continue;
    }

    // CREATE TRIGGER
    if (/^CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b/i.test(upper)) {
      const m = stmt.match(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+[""`]?(\w+)[""`]?/i);
      // Extract table and timing info
      const tableMatch = stmt.match(/ON\s+[""`]?(\w+)[""`]?/i);
      const timingMatch = stmt.match(/(BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|UPDATE|DELETE|TRUNCATE)/i);
      const funcMatch = stmt.match(/EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+[""`]?(\w+)[""`]?/i);
      schema.triggers.push({
        name: m ? unquote(m[1]) : "unknown",
        table: tableMatch ? unquote(tableMatch[1]) : null,
        timing: timingMatch ? `${timingMatch[1]} ${timingMatch[2]}` : null,
        function: funcMatch ? unquote(funcMatch[1]) : null,
        raw: stmt,
      });
      continue;
    }

    // CREATE VIEW / MATERIALIZED VIEW
    if (/^CREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\b/i.test(upper)) {
      const m = stmt.match(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[""`]?\w+[""`]?\.)?[""`]?(\w+)[""`]?/i);
      const isMaterialized = /MATERIALIZED/i.test(stmt);
      // Extract the AS SELECT ... part
      const asMatch = stmt.match(/\bAS\s+(SELECT\b.+)/is);
      schema.views.push({
        name: m ? unquote(m[1]) : "unknown",
        materialized: isMaterialized,
        query: asMatch ? asMatch[1].trim() : null,
        raw: stmt,
      });
      continue;
    }

    // CREATE FUNCTION / PROCEDURE
    if (/^CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b/i.test(upper)) {
      const m = stmt.match(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?:[""`]?\w+[""`]?\.)?[""`]?(\w+)[""`]?/i);
      const isProcedure = /PROCEDURE/i.test(stmt);
      const langMatch = stmt.match(/LANGUAGE\s+(\w+)/i);
      schema.functions.push({
        name: m ? unquote(m[1]) : "unknown",
        isProcedure,
        language: langMatch ? langMatch[1].toLowerCase() : null,
        raw: stmt,
      });
      continue;
    }

    // CREATE TYPE ... AS ENUM
    if (/^CREATE\s+TYPE\b.*\bAS\s+ENUM\b/i.test(upper)) {
      const m = stmt.match(/CREATE\s+TYPE\s+(?:[""`]?\w+[""`]?\.)?[""`]?(\w+)[""`]?/i);
      // Extract enum values
      const valuesMatch = stmt.match(/ENUM\s*\(([^)]+)\)/i);
      let values = [];
      if (valuesMatch) {
        values = valuesMatch[1].split(",").map(v => v.trim().replace(/^'|'$/g, ""));
      }
      schema.enumTypes.push({
        name: m ? unquote(m[1]) : "unknown",
        values,
        raw: stmt,
      });
      continue;
    }

    // CREATE TYPE (non-enum)
    if (/^CREATE\s+TYPE\b/i.test(upper)) {
      const m = stmt.match(/CREATE\s+TYPE\s+(?:[""`]?\w+[""`]?\.)?[""`]?(\w+)[""`]?/i);
      schema.customTypes.push({ name: m ? unquote(m[1]) : "unknown", raw: stmt });
      continue;
    }

    // CREATE EXTENSION
    if (/^CREATE\s+EXTENSION\b/i.test(upper)) {
      const m = stmt.match(/CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?[""`]?([\w-]+)[""`]?/i);
      schema.extensions.push({ name: m ? unquote(m[1]) : "unknown", raw: stmt });
      continue;
    }

    // ALTER TABLE ... ADD FOREIGN KEY
    if (/^ALTER\s+TABLE\b/i.test(upper) && /ADD\s+(?:CONSTRAINT\s+)?\w*\s*FOREIGN\s+KEY/i.test(upper)) {
      const tableMatch = stmt.match(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:[""`]?\w+[""`]?\.)?[""`]?(\w+)[""`]?/i);
      const tableName = tableMatch ? unquote(tableMatch[1]) : null;
      if (tableName) {
        const fkCols = extractParenColumns(stmt.replace(/^.*FOREIGN\s+KEY/i, "FOREIGN KEY"));
        const refMatch = stmt.match(/REFERENCES\s+(?:[""`]?\w+[""`]?\.)?[""`]?(\w+)[""`]?\s*\(([^)]+)\)/i);
        const cnMatch = stmt.match(/ADD\s+CONSTRAINT\s+[""`]?(\w+)[""`]?/i);
        let table = schema.tables.find(t => t.name === tableName);
        if (!table) { table = { name: tableName, columns: [], constraints: [], metadata: {} }; schema.tables.push(table); }
        table.constraints.push({
          type: "FOREIGN KEY", name: cnMatch ? unquote(cnMatch[1]) : null,
          columns: fkCols,
          refTable: refMatch ? unquote(refMatch[1]) : null,
          refColumns: refMatch ? refMatch[2].split(",").map(c => unquote(c.trim())) : null,
          expression: null,
        });
      }
      continue;
    }

    // Skip DML, GRANT, SET, etc. silently. Flag unhandled CREATE/ALTER.
    if (upper.startsWith("CREATE") || upper.startsWith("ALTER")) {
      schema.unparsed.push(stmt);
    }
  }

  return schema;
}
