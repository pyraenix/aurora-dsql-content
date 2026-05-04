/**
 * PL/pgSQL → SQL Function Transpiler.
 *
 * Recognizes common PL/pgSQL patterns and converts them to pure SQL
 * functions that work in Aurora DSQL.
 *
 * Supported patterns:
 *   1. SET_COLUMN    — NEW.col = expr; RETURN NEW;
 *   2. AUDIT_INSERT  — INSERT INTO audit_table(...) VALUES(...); RETURN NEW/OLD;
 *   3. VALIDATION    — IF condition THEN RAISE EXCEPTION; END IF; RETURN NEW;
 *   4. CASCADE_DML   — UPDATE/DELETE on related table using OLD/NEW; RETURN OLD/NEW;
 *   5. COMPUTED_COL  — NEW.col = f(NEW.other_col, ...); RETURN NEW;
 *   6. SIMPLE_RETURN — Just returns a value or expression
 *
 * Anything with LOOP, WHILE, CURSOR, EXECUTE, nested IF/ELSIF, or
 * EXCEPTION WHEN blocks is marked as unconvertible.
 */

/**
 * @typedef {Object} TranspileResult
 * @property {boolean} converted    — true if we produced real SQL
 * @property {string} pattern       — which pattern was matched
 * @property {string} sql           — the generated SQL function DDL
 * @property {string[]} checkConstraints — any CHECK constraints extracted
 * @property {string|null} reason   — why it couldn't be converted (if converted=false)
 */

/**
 * Extract the PL/pgSQL body from a raw function definition.
 * Returns the text between $$ ... $$ or $tag$ ... $tag$.
 */
function extractBody(raw) {
  // Match $$ or $tag$ delimited body
  const m = raw.match(/\$([a-zA-Z_]*)\$\s*([\s\S]*?)\s*\$\1\$/);
  if (m) return m[2].trim();
  return null;
}

/**
 * Extract function signature parts from raw definition.
 */
function extractSignature(raw) {
  const nameMatch = raw.match(/(?:FUNCTION|PROCEDURE)\s+(?:[""`]?\w+[""`]?\.)?[""`]?(\w+)[""`]?\s*\(([^)]*)\)/i);
  const returnsMatch = raw.match(/RETURNS\s+(\w+(?:\s+\w+)*)/i);
  return {
    name: nameMatch ? nameMatch[1] : "unknown",
    params: nameMatch ? nameMatch[2].trim() : "",
    returns: returnsMatch ? returnsMatch[1].trim() : "void",
  };
}

/**
 * Check if the body contains genuinely unconvertible PL/pgSQL features.
 * Very narrow list — most patterns can be converted if we understand the intent.
 */
function hasUnconvertibleFeatures(body) {
  // We no longer reject upfront. Instead, we let all patterns attempt matching.
  // Only truly impossible constructs get rejected:
  // - PERFORM (calls a function for side effects, discards result — no SQL equivalent)
  // - Complex multi-branch ELSIF chains (>2 branches)
  const upper = body.toUpperCase();
  const reasons = [];

  if (/\bPERFORM\b/.test(upper)) reasons.push("PERFORM");

  const elsifCount = (upper.match(/\bELSIF\b/g) || []).length;
  if (elsifCount > 2) reasons.push("complex multi-branch IF/ELSIF");

  return reasons.length > 0 ? reasons : null;
}

/**
 * Normalize PL/pgSQL body: strip BEGIN/END, DECLARE, trim.
 */
function normalizeBody(body) {
  let s = body;
  // Remove DECLARE ... BEGIN
  s = s.replace(/^\s*DECLARE\s[\s\S]*?BEGIN\b/i, "");
  // Remove standalone BEGIN
  s = s.replace(/^\s*BEGIN\b/i, "");
  // Remove trailing END
  s = s.replace(/\bEND\s*;?\s*$/i, "");
  return s.trim();
}

/**
 * Split normalized body into individual statements (on semicolons).
 */
function splitStatements(body) {
  return body.split(";")
    .map(s => s.trim())
    .filter(s => s.length > 0 && !/^RETURN\b/i.test(s.trim()));
}

/**
 * Extract RETURN value from body.
 */
function extractReturn(body) {
  const m = body.match(/RETURN\s+(NEW|OLD|\w+)\s*;/i);
  return m ? m[1].toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// Pattern matchers
// ---------------------------------------------------------------------------

/**
 * Pattern 1: SET_COLUMN — NEW.col = expr; RETURN NEW;
 * Generates: UPDATE table SET col = expr WHERE id = p_id RETURNING col;
 */
function matchSetColumn(body, triggerTable) {
  const normalized = normalizeBody(body);
  const assignments = [];

  // Match NEW.column = expression patterns
  const assignRegex = /NEW\.(\w+)\s*[:=]+\s*(.+?)(?=\s*;|\s*$)/gi;
  let match;
  while ((match = assignRegex.exec(normalized)) !== null) {
    assignments.push({ column: match[1], expression: match[2].trim() });
  }

  if (assignments.length === 0) return null;

  // Check there's nothing else besides assignments and RETURN
  const stmts = splitStatements(normalized);
  const nonAssign = stmts.filter(s => !/^NEW\.\w+\s*[:=]/i.test(s));
  if (nonAssign.length > 0) return null;

  return { pattern: "SET_COLUMN", assignments };
}

/**
 * Pattern 2: AUDIT_INSERT — INSERT INTO table(...) VALUES(...); RETURN NEW/OLD;
 */
function matchAuditInsert(body) {
  const normalized = normalizeBody(body);
  const stmts = splitStatements(normalized);

  if (stmts.length !== 1) return null;
  if (!/^INSERT\s+INTO\b/i.test(stmts[0])) return null;

  return { pattern: "AUDIT_INSERT", insertStmt: stmts[0] };
}

/**
 * Pattern 3: VALIDATION — IF condition THEN RAISE EXCEPTION 'msg'; END IF; RETURN NEW;
 * Generates: CHECK constraint
 */
function matchValidation(body) {
  const normalized = normalizeBody(body);
  const checks = [];

  // Match: IF condition THEN RAISE EXCEPTION 'message'; END IF;
  const ifRaiseRegex = /IF\s+(.+?)\s+THEN\s+RAISE\s+EXCEPTION\s+'([^']+)'\s*;\s*END\s+IF/gi;
  let match;
  while ((match = ifRaiseRegex.exec(normalized)) !== null) {
    let condition = match[1].trim();
    // The IF fires when the condition is BAD, so the CHECK is the negation
    // Replace NEW. references with just the column name
    condition = condition.replace(/NEW\./gi, "");
    checks.push({ condition, message: match[2] });
  }

  if (checks.length === 0) return null;

  // Verify there's nothing else besides IF/RAISE and RETURN
  let remaining = normalized;
  remaining = remaining.replace(/IF\s+.+?\s+THEN\s+RAISE\s+EXCEPTION\s+'[^']+'\s*;\s*END\s+IF\s*;?/gi, "");
  remaining = remaining.replace(/RETURN\s+\w+\s*;?/gi, "").trim();
  if (remaining.length > 0) return null;

  return { pattern: "VALIDATION", checks };
}

/**
 * Pattern 4: CASCADE_DML — UPDATE/DELETE on related table; RETURN OLD/NEW;
 */
function matchCascadeDML(body) {
  const normalized = normalizeBody(body);
  const stmts = splitStatements(normalized);

  if (stmts.length === 0) return null;

  const dmlStmts = [];
  for (const s of stmts) {
    if (/^(UPDATE|DELETE)\b/i.test(s)) {
      // Replace OLD./NEW. with parameter references
      dmlStmts.push(s);
    } else {
      return null; // has non-DML statements
    }
  }

  if (dmlStmts.length === 0) return null;
  return { pattern: "CASCADE_DML", statements: dmlStmts };
}

/**
 * Pattern 5: FOR r IN SELECT ... LOOP UPDATE/INSERT ... END LOOP → set-based SQL
 * Converts row-by-row processing to a single UPDATE...FROM or INSERT...SELECT.
 */
function matchForLoop(body, table) {
  const normalized = normalizeBody(body);

  // Match: FOR r IN (SELECT ...) LOOP (UPDATE/INSERT ...) END LOOP
  const forMatch = normalized.match(
    /FOR\s+\w+\s+IN\s+(SELECT\s+.+?)\s+LOOP\s+((?:UPDATE|INSERT|DELETE)\s+.+?)\s+END\s+LOOP/is
  );
  if (!forMatch) return null;

  const selectQuery = forMatch[1].trim();
  const dmlStmt = forMatch[2].trim().replace(/;\s*$/, "");

  // Common pattern: FOR r IN SELECT id FROM table WHERE condition LOOP UPDATE table SET col = val WHERE id = r.id END LOOP
  // → UPDATE table SET col = val FROM (SELECT id FROM table WHERE condition) AS _src WHERE table.id = _src.id
  const updateMatch = dmlStmt.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)/is);
  if (updateMatch) {
    const targetTable = updateMatch[1];
    const setClauses = updateMatch[2].trim();
    let whereClause = updateMatch[3].trim().replace(/;\s*$/, "");

    // Replace r.column references with _src.column
    const cleanedWhere = whereClause.replace(/\b\w+\.(\w+)\s*=\s*\w+\.(\w+)/i, `${targetTable}.$1 = _src.$2`);
    const cleanedSet = setClauses.replace(/\br\.(\w+)/gi, "_src.$1");

    return {
      sql: `UPDATE ${targetTable} SET ${cleanedSet} FROM (${selectQuery}) AS _src WHERE ${cleanedWhere}`,
    };
  }

  // INSERT pattern: FOR r IN SELECT ... LOOP INSERT INTO table VALUES(r.col1, r.col2) END LOOP
  // → INSERT INTO table SELECT col1, col2 FROM (original select)
  const insertMatch = dmlStmt.match(/INSERT\s+INTO\s+(\w+)/i);
  if (insertMatch) {
    return {
      sql: `INSERT INTO ${insertMatch[1]} ${selectQuery}`,
    };
  }

  return null;
}

/**
 * Pattern 6: Simple IF/ELSE → CASE WHEN
 * Handles: IF condition THEN expr1 ELSE expr2 END IF; RETURN result;
 */
function matchSimpleIfElse(body, table) {
  const normalized = normalizeBody(body);

  // Match: IF condition THEN assignment/return ELSE assignment/return END IF
  const ifMatch = normalized.match(
    /IF\s+(.+?)\s+THEN\s+(?:RETURN\s+)?(.+?);\s+ELSE\s+(?:RETURN\s+)?(.+?);\s+END\s+IF/is
  );
  if (!ifMatch) return null;

  const condition = ifMatch[1].trim().replace(/NEW\./gi, "").replace(/OLD\./gi, "");
  const thenExpr = ifMatch[2].trim().replace(/NEW\./gi, "").replace(/OLD\./gi, "");
  const elseExpr = ifMatch[3].trim().replace(/NEW\./gi, "").replace(/OLD\./gi, "");

  // Check if it's a RETURN-based function
  const hasReturn = /RETURN\b/i.test(normalized);

  if (hasReturn) {
    return {
      sql: `SELECT CASE WHEN ${condition} THEN ${thenExpr} ELSE ${elseExpr} END`,
      returnType: "text",
      params: "",
    };
  }

  // Assignment-based: NEW.col = IF ... → UPDATE with CASE
  if (table) {
    return {
      sql: `UPDATE ${table} SET result = CASE WHEN ${condition} THEN ${thenExpr} ELSE ${elseExpr} END WHERE id = p_id`,
      returnType: "void",
      params: "p_id bigint",
    };
  }

  return null;
}

/**
 * Pattern 7: EXCEPTION WHEN unique_violation → INSERT ... ON CONFLICT
 * Handles: BEGIN INSERT INTO t VALUES(...); EXCEPTION WHEN unique_violation THEN UPDATE/NULL; END
 */
function matchExceptionUniqueViolation(body) {
  const normalized = normalizeBody(body);

  // Match: INSERT ... EXCEPTION WHEN unique_violation THEN (UPDATE or nothing)
  const exMatch = normalized.match(
    /(INSERT\s+INTO\s+\w+\s*\([^)]+\)\s*VALUES\s*\([^)]+\))\s*;\s*EXCEPTION\s+WHEN\s+unique_violation\s+THEN\s+(.*?)(?:END|$)/is
  );
  if (!exMatch) return null;

  const insertStmt = exMatch[1].trim();
  const handler = exMatch[2].trim().replace(/;\s*$/, "");

  // Extract table and columns from INSERT
  const tableMatch = insertStmt.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)/i);
  if (!tableMatch) return null;

  const tableName = tableMatch[1];
  const columns = tableMatch[2].split(",").map(c => c.trim());

  // Extract VALUES
  const valuesMatch = insertStmt.match(/VALUES\s*\(([^)]+)\)/i);
  if (!valuesMatch) return null;

  // Build ON CONFLICT clause
  let onConflict;
  if (/NULL/i.test(handler) || handler.length === 0) {
    // EXCEPTION → do nothing
    onConflict = "ON CONFLICT DO NOTHING";
  } else if (/UPDATE/i.test(handler)) {
    // EXCEPTION → do update
    const updateMatch = handler.match(/UPDATE\s+\w+\s+SET\s+(.+?)(?:WHERE|$)/is);
    if (updateMatch) {
      const setClauses = updateMatch[1].trim().replace(/;\s*$/, "");
      onConflict = `ON CONFLICT DO UPDATE SET ${setClauses}`;
    } else {
      onConflict = "ON CONFLICT DO NOTHING";
    }
  } else {
    onConflict = "ON CONFLICT DO NOTHING";
  }

  // Parameterize the values
  const params = columns.map(c => `p_${c} text`).join(", ");
  const paramValues = columns.map(c => `p_${c}`).join(", ");

  return {
    sql: `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${paramValues}) ${onConflict}`,
    params,
  };
}

/**
 * Pattern 8: Dynamic SQL → expand to concrete SQL per table.
 *
 * Common pattern: EXECUTE format('DELETE FROM %I WHERE created_at < %L', tbl, cutoff)
 * Intent: Run the same DML on a table passed as parameter.
 * Solution: Generate one concrete SQL function per table the caller might pass.
 *
 * Also handles: EXECUTE 'INSERT INTO ' || tbl || ' SELECT ...'
 */
function matchDynamicSQL(body, sig) {
  const normalized = normalizeBody(body);

  // Pattern A: EXECUTE format('DML %I ...', table_param, ...)
  const formatMatch = normalized.match(
    /EXECUTE\s+format\s*\(\s*'((?:DELETE|UPDATE|INSERT|SELECT)\s+.+?)'\s*,\s*(\w+)/is
  );
  if (formatMatch) {
    const template = formatMatch[1].trim();
    const tableParam = formatMatch[2].trim();

    // Replace %I (identifier) with a placeholder, %L (literal) with parameter
    // We generate a function that takes the actual values as params
    const cleanedSql = template
      .replace(/%I/i, "p_target_table")  // Can't be dynamic in SQL — see note below
      .replace(/%L/gi, (_, idx) => `p_value`)
      .replace(/%s/gi, "p_value");

    // Since we can't have dynamic table names in SQL functions,
    // generate a comment explaining the pattern and a concrete example
    const sql = [
      `-- Dynamic SQL expanded from ${sig.name}()`,
      `-- Original: EXECUTE format('${template}', ${tableParam}, ...)`,
      `-- Generate one function per target table:`,
      `--`,
      `-- Example for table 'my_table':`,
      `CREATE FUNCTION ${sig.name}_my_table(p_value text) RETURNS void`,
      `LANGUAGE sql AS $$`,
      `  ${template.replace(/%I/i, "my_table").replace(/%L/gi, "p_value").replace(/%s/gi, "p_value")};`,
      `$$;`,
      ``,
      `-- Repeat for each table that calls this function.`,
      `-- In application code: call ${sig.name}_<table>(value) instead of ${sig.name}(table, value)`,
    ].join("\n");

    return { sql };
  }

  // Pattern B: EXECUTE 'DML ' || table_var || ' WHERE ...'
  const concatMatch = normalized.match(
    /EXECUTE\s+'((?:DELETE|UPDATE|INSERT|SELECT)\s+(?:FROM\s+|INTO\s+)?)\s*'\s*\|\|\s*(\w+)\s*\|\|\s*'(.+?)'/is
  );
  if (concatMatch) {
    const prefix = concatMatch[1].trim();
    const tableVar = concatMatch[2].trim();
    const suffix = concatMatch[3].trim();

    const sql = [
      `-- Dynamic SQL expanded from ${sig.name}()`,
      `-- Original: EXECUTE '${prefix}' || ${tableVar} || '${suffix}'`,
      `-- Generate one function per target table:`,
      `--`,
      `CREATE FUNCTION ${sig.name}_my_table() RETURNS void`,
      `LANGUAGE sql AS $$`,
      `  ${prefix}my_table${suffix};`,
      `$$;`,
      ``,
      `-- Repeat for each table. Call ${sig.name}_<table>() from application code.`,
    ].join("\n");

    return { sql };
  }

  return null;
}

/**
 * Pattern 9: CURSOR-based processing → set-based SQL.
 *
 * Common patterns:
 *   DECLARE cur CURSOR FOR SELECT ... ; OPEN cur; FETCH cur INTO ...; LOOP ... END LOOP; CLOSE cur;
 *   FOR rec IN cur LOOP ... END LOOP;
 *
 * Intent: Process rows one at a time with DML per row.
 * Solution: Same as FOR loop — convert to UPDATE...FROM or INSERT...SELECT.
 */
function matchCursorPattern(body, table) {
  // Work with the raw body (before DECLARE stripping) to find cursor definitions
  const raw = body.trim();

  // Match: DECLARE cursor_name CURSOR FOR (SELECT ...);
  const cursorDeclMatch = raw.match(
    /(\w+)\s+CURSOR\s+FOR\s+(SELECT\s+.+?)(?=\s*;)/is
  );
  if (!cursorDeclMatch) return null;

  const cursorName = cursorDeclMatch[1];
  const selectQuery = cursorDeclMatch[2].trim();

  // Find the LOOP body — could be FOR rec IN cursor_name LOOP or FETCH-based
  const loopMatch = raw.match(
    /(?:FOR\s+\w+\s+IN\s+\w+\s+)?LOOP\s+([\s\S]+?)\s+END\s+LOOP/is
  );
  if (!loopMatch) return null;

  const loopBody = loopMatch[1].trim();

  // Extract DML statements from loop body (skip FETCH, EXIT, etc.)
  const dmlMatch = loopBody.match(/(UPDATE|INSERT|DELETE)\s+.+/is);
  if (!dmlMatch) return null;

  const dmlStmt = dmlMatch[0].replace(/;\s*(?:END\s+LOOP)?.*$/is, "").trim();

  // Convert UPDATE...WHERE cursor_var.col = ... to UPDATE...FROM (SELECT) AS _src
  const updateMatch = dmlStmt.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)/is);
  if (updateMatch) {
    const targetTable = updateMatch[1];
    const setClauses = updateMatch[2].trim();
    const whereClause = updateMatch[3].trim().replace(/;\s*$/, "");

    // Replace rec.col / cursor_var.col with _src.col
    const cleanedWhere = whereClause.replace(/(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/i,
      (_, t1, c1, t2, c2) => `${t1}.${c1} = _src.${c2}`);
    const cleanedSet = setClauses.replace(/\b\w+\.(\w+)/gi, "_src.$1");

    return {
      sql: `UPDATE ${targetTable} SET ${cleanedSet} FROM (${selectQuery}) AS _src WHERE ${cleanedWhere}`,
      params: "",
    };
  }

  // DELETE pattern
  const deleteMatch = dmlStmt.match(/DELETE\s+FROM\s+(\w+)\s+WHERE\s+(.+)/is);
  if (deleteMatch) {
    return {
      sql: `DELETE FROM ${deleteMatch[1]} USING (${selectQuery}) AS _src WHERE ${deleteMatch[2].replace(/\b\w+\.(\w+)/gi, "_src.$1")}`,
      params: "",
    };
  }

  // INSERT pattern
  const insertMatch = dmlStmt.match(/INSERT\s+INTO\s+(\w+)/i);
  if (insertMatch) {
    return {
      sql: `INSERT INTO ${insertMatch[1]} ${selectQuery}`,
      params: "",
    };
  }

  return null;
}

/**
 * Pattern 10: EXCEPTION WHEN (non-unique_violation) → defensive SQL.
 *
 * Common: EXCEPTION WHEN no_data_found THEN RETURN NULL;
 * Solution: Use COALESCE, LEFT JOIN, or EXISTS checks instead.
 *
 * Common: EXCEPTION WHEN foreign_key_violation THEN ...
 * Solution: Check existence first with EXISTS subquery.
 */
function matchExceptionOther(body) {
  const normalized = normalizeBody(body);

  // Match: (some DML); EXCEPTION WHEN exception_type THEN (handler)
  const exMatch = normalized.match(
    /(.+?)\s*;\s*EXCEPTION\s+WHEN\s+(\w+)\s+THEN\s+(.*?)(?:END|$)/is
  );
  if (!exMatch) return null;

  const mainStmt = exMatch[1].trim();
  const exceptionType = exMatch[2].trim().toLowerCase();
  const handler = exMatch[3].trim().replace(/;\s*$/, "");

  // no_data_found → wrap SELECT in COALESCE or use LEFT JOIN
  if (exceptionType === "no_data_found") {
    const selectMatch = mainStmt.match(/SELECT\s+(.+?)\s+INTO\s+\w+\s+FROM\s+(.+)/is);
    if (selectMatch) {
      const columns = selectMatch[1].trim();
      const fromClause = selectMatch[2].trim();
      // Return NULL if no rows found
      const returnVal = /RETURN\s+NULL/i.test(handler) ? "NULL" : handler;
      return {
        sql: `SELECT COALESCE((SELECT ${columns} FROM ${fromClause}), ${returnVal})`,
        params: "",
        exceptionType: "no_data_found → COALESCE",
      };
    }
  }

  // foreign_key_violation → check existence first
  if (exceptionType === "foreign_key_violation") {
    const insertMatch = mainStmt.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (insertMatch) {
      const tableName = insertMatch[1];
      const columns = insertMatch[2];
      const values = insertMatch[3];
      return {
        sql: `INSERT INTO ${tableName} (${columns}) SELECT ${values} WHERE EXISTS (SELECT 1 FROM referenced_table WHERE id = p_ref_id)`,
        params: "p_ref_id bigint",
        exceptionType: "foreign_key_violation → EXISTS check",
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempt to transpile a PL/pgSQL function to SQL.
 *
 * @param {Object} func — parsed function object { name, language, raw, isProcedure }
 * @param {Object|null} trigger — trigger that calls this function { name, table, timing }
 * @returns {TranspileResult}
 */
export function transpilePlpgsql(func, trigger) {
  const body = extractBody(func.raw);
  if (!body) {
    return { converted: false, pattern: "UNPARSEABLE", sql: "", checkConstraints: [], reason: "Could not extract function body." };
  }

  // Check for unconvertible features first
  const blockers = hasUnconvertibleFeatures(body);
  if (blockers) {
    return { converted: false, pattern: "UNCONVERTIBLE", sql: "", checkConstraints: [], reason: `Contains: ${blockers.join(", ")}` };
  }

  const sig = extractSignature(func.raw);
  const table = trigger ? trigger.table : null;

  // Try each pattern in order of specificity

  // Pattern 3: Validation → CHECK constraints (most valuable, no function needed)
  const validation = matchValidation(body);
  if (validation && table) {
    const checks = validation.checks.map(c => {
      // Negate the condition: IF bad THEN RAISE → CHECK (NOT bad)
      const negated = negateCondition(c.condition);
      return `ALTER TABLE ${table} ADD CONSTRAINT chk_${table}_${sanitize(c.condition)} CHECK (${negated});`;
    });
    return {
      converted: true,
      pattern: "VALIDATION",
      sql: checks.join("\n"),
      checkConstraints: checks,
      reason: null,
    };
  }

  // Pattern 1: Set column → SQL function
  const setCol = matchSetColumn(body, table);
  if (setCol && table) {
    const setClauses = setCol.assignments.map(a => {
      const expr = a.expression.replace(/NEW\./gi, "").replace(/OLD\./gi, "");
      return `${a.column} = ${expr}`;
    });
    const funcName = `apply_${sig.name}_${table}`;
    const sql = [
      `CREATE FUNCTION ${funcName}(p_id bigint) RETURNS void`,
      `LANGUAGE sql AS $$`,
      `  UPDATE ${table} SET ${setClauses.join(", ")} WHERE id = p_id;`,
      `$$;`,
    ].join("\n");
    return { converted: true, pattern: "SET_COLUMN", sql, checkConstraints: [], reason: null };
  }

  // Pattern 2: Audit insert → SQL function
  const audit = matchAuditInsert(body);
  if (audit) {
    // Replace OLD/NEW references with parameters
    let insertStmt = audit.insertStmt;
    // Extract referenced columns from OLD/NEW
    const oldCols = [...new Set([...insertStmt.matchAll(/OLD\.(\w+)/gi)].map(m => m[1]))];
    const newCols = [...new Set([...insertStmt.matchAll(/NEW\.(\w+)/gi)].map(m => m[1]))];
    const allCols = [...new Set([...oldCols, ...newCols])];

    const params = allCols.map(c => `p_${c} text`).join(", ");
    let sqlBody = insertStmt;
    for (const c of oldCols) sqlBody = sqlBody.replace(new RegExp(`OLD\\.${c}`, "gi"), `p_${c}`);
    for (const c of newCols) sqlBody = sqlBody.replace(new RegExp(`NEW\\.${c}`, "gi"), `p_${c}`);
    // Also handle TG_OP
    sqlBody = sqlBody.replace(/TG_OP/gi, "p_operation");

    const hasTgOp = /TG_OP/i.test(insertStmt);
    const fullParams = hasTgOp ? `p_operation text, ${params}` : params;

    const funcName = `audit_${sig.name}`;
    const sql = [
      `CREATE FUNCTION ${funcName}(${fullParams}) RETURNS void`,
      `LANGUAGE sql AS $$`,
      `  ${sqlBody};`,
      `$$;`,
    ].join("\n");
    return { converted: true, pattern: "AUDIT_INSERT", sql, checkConstraints: [], reason: null };
  }

  // Pattern 4: Cascade DML → SQL function
  const cascade = matchCascadeDML(body);
  if (cascade && table) {
    const params = [];
    const stmts = [];
    for (const s of cascade.statements) {
      // Collect OLD/NEW column references
      const refs = [...new Set([...s.matchAll(/(OLD|NEW)\.(\w+)/gi)].map(m => `p_${m[2].toLowerCase()}`))];
      for (const r of refs) {
        if (!params.includes(r)) params.push(r);
      }
      let sqlStmt = s;
      sqlStmt = sqlStmt.replace(/(OLD|NEW)\.(\w+)/gi, (_, prefix, col) => `p_${col.toLowerCase()}`);
      stmts.push(sqlStmt);
    }

    const paramDefs = params.map(p => `${p} bigint`).join(", ");
    const funcName = `cascade_${sig.name}_${table}`;
    const bodyLines = stmts.map(s => `  ${s};`);
    const sql = [
      `CREATE FUNCTION ${funcName}(${paramDefs}) RETURNS void`,
      `LANGUAGE sql AS $$`,
      ...bodyLines,
      `$$;`,
    ].join("\n");
    return { converted: true, pattern: "CASCADE_DML", sql, checkConstraints: [], reason: null };
  }

  // No pattern matched — but try the new patterns before giving up

  // Pattern 5: FOR..IN LOOP with UPDATE/INSERT → set-based SQL
  const forLoop = matchForLoop(body, table);
  if (forLoop) {
    const funcName = `batch_${sig.name}${table ? '_' + table : ''}`;
    const sql = [
      `CREATE FUNCTION ${funcName}() RETURNS void`,
      `LANGUAGE sql AS $$`,
      `  ${forLoop.sql};`,
      `$$;`,
    ].join("\n");
    return { converted: true, pattern: "FOR_LOOP_TO_SET", sql, checkConstraints: [], reason: null };
  }

  // Pattern 6: Simple IF/ELSE → CASE WHEN in SQL function
  const ifElse = matchSimpleIfElse(body, table);
  if (ifElse) {
    const funcName = `conditional_${sig.name}${table ? '_' + table : ''}`;
    const params = ifElse.params || "p_id bigint";
    const sql = [
      `CREATE FUNCTION ${funcName}(${params}) RETURNS ${ifElse.returnType || 'void'}`,
      `LANGUAGE sql AS $$`,
      `  ${ifElse.sql};`,
      `$$;`,
    ].join("\n");
    return { converted: true, pattern: "IF_ELSE_TO_CASE", sql, checkConstraints: [], reason: null };
  }

  // Pattern 7: EXCEPTION WHEN unique_violation → ON CONFLICT
  const exceptionHandler = matchExceptionUniqueViolation(body);
  if (exceptionHandler) {
    const funcName = `upsert_${sig.name}`;
    const sql = [
      `CREATE FUNCTION ${funcName}(${exceptionHandler.params}) RETURNS void`,
      `LANGUAGE sql AS $$`,
      `  ${exceptionHandler.sql};`,
      `$$;`,
    ].join("\n");
    return { converted: true, pattern: "EXCEPTION_TO_ON_CONFLICT", sql, checkConstraints: [], reason: null };
  }

  // Pattern 8: Dynamic SQL on known tables → concrete SQL functions per table
  const dynamicSql = matchDynamicSQL(body, sig);
  if (dynamicSql) {
    return { converted: true, pattern: "DYNAMIC_SQL_EXPANDED", sql: dynamicSql.sql, checkConstraints: [], reason: null };
  }

  // Pattern 9: CURSOR-based row processing → set-based SQL
  const cursorPattern = matchCursorPattern(body, table);
  if (cursorPattern) {
    const funcName = `cursor_replacement_${sig.name}${table ? '_' + table : ''}`;
    const sql = [
      `CREATE FUNCTION ${funcName}(${cursorPattern.params || ''}) RETURNS void`,
      `LANGUAGE sql AS $$`,
      `  ${cursorPattern.sql};`,
      `$$;`,
    ].join("\n");
    return { converted: true, pattern: "CURSOR_TO_SET", sql, checkConstraints: [], reason: null };
  }

  // Pattern 10: EXCEPTION WHEN other (not unique_violation) → SQL with fallback
  const otherException = matchExceptionOther(body);
  if (otherException) {
    const funcName = `safe_${sig.name}`;
    const sql = [
      `-- Exception handler converted: ${otherException.exceptionType} → defensive SQL`,
      `CREATE FUNCTION ${funcName}(${otherException.params || ''}) RETURNS void`,
      `LANGUAGE sql AS $$`,
      `  ${otherException.sql};`,
      `$$;`,
    ].join("\n");
    return { converted: true, pattern: "EXCEPTION_TO_DEFENSIVE_SQL", sql, checkConstraints: [], reason: null };
  }

  // No pattern matched
  return {
    converted: false,
    pattern: "UNRECOGNIZED",
    sql: "",
    checkConstraints: [],
    reason: "PL/pgSQL body does not match any known convertible pattern.",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function negateCondition(condition) {
  // Simple negation: wrap in NOT(...)
  // But handle common patterns more cleanly
  const trimmed = condition.trim();

  // "x < 0" → "x >= 0"
  if (/<\s*/.test(trimmed) && !/<[>=]/.test(trimmed)) return trimmed.replace(/</, ">=");
  if (/>\s*/.test(trimmed) && !/>[>=]/.test(trimmed)) return trimmed.replace(/>/, "<=");
  if (/<=/.test(trimmed)) return trimmed.replace(/<=/, ">");
  if (/>=/.test(trimmed)) return trimmed.replace(/>=/, "<");
  if (/\bIS\s+NULL\b/i.test(trimmed)) return trimmed.replace(/IS\s+NULL/i, "IS NOT NULL");
  if (/\bIS\s+NOT\s+NULL\b/i.test(trimmed)) return trimmed.replace(/IS\s+NOT\s+NULL/i, "IS NULL");
  if (/\b=\b/.test(trimmed) && !/!=|<>/.test(trimmed)) return trimmed.replace(/=/, "!=");
  if (/!=|<>/.test(trimmed)) return trimmed.replace(/!=|<>/, "=");

  // Fallback: wrap in NOT(...)
  return `NOT (${trimmed})`;
}

function sanitize(str) {
  return str.replace(/[^a-zA-Z0-9_]/g, "_").substring(0, 30).toLowerCase();
}
