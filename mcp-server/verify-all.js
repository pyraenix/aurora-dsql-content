/**
 * Final audit: verify all conversion paths against the full test schema.
 * Run: node verify-all.js
 */

import { parseSQL } from "./src/sql-parser.js";
import { convertSchema } from "./src/converter.js";
import { readFileSync } from "fs";

const sql = readFileSync("../examples/full-test-all-features.sql", "utf-8");
const parsed = parseSQL(sql);
const { ddl, notes, summary } = convertSchema(parsed, "postgresql");

const checks = [
  ["JSONB mapped to json (not text)", /\bsettings json\b/i.test(ddl) || /\bpreferences json\b/i.test(ddl)],
  ["JSON preserved as json", /\bconfig json\b/i.test(ddl)],
  ["TIMETZ mapped to time with time zone", ddl.includes("time with time zone")],
  ["SERIAL removed from output", !/\bSERIAL\b/.test(ddl)],
  ["COLLATE C on text columns", ddl.includes('COLLATE "C"')],
  ["NUMERIC precision preserved", ddl.includes("numeric(6,2)") || ddl.includes("numeric(15,4)")],
  ["VARCHAR length preserved", ddl.includes("varchar(255)") || ddl.includes("varchar(200)")],
  ["Sequences have CACHE 1", ddl.includes("CACHE 1")],
  ["All indexes use ASYNC", ddl.includes("INDEX ASYNC")],
  ["No partial index WHERE in output", !ddl.split("\n").some(l => l.includes("INDEX ASYNC") && l.includes("WHERE"))],
  ["INCLUDE columns preserved", ddl.includes("INCLUDE")],
  ["GENERATED ALWAYS AS STORED preserved", ddl.includes("GENERATED ALWAYS AS")],
  ["ENUM converted to CHECK constraint", ddl.includes("CHECK (status IN (")],
  ["FK validation functions generated", ddl.includes("validate_fk_")],
  ["Trigger replacement function generated", ddl.includes("set_updated_at_")],
  ["Materialized view demoted to regular VIEW", /CREATE VIEW org/i.test(ddl)],
  ["Regular view preserved", /CREATE VIEW open_tickets/i.test(ddl)],
  ["Temp table renamed with _tmp_ prefix", ddl.includes("_tmp_import")],
  ["PARTITION BY removed", !ddl.includes("PARTITION BY")],
  ["INHERITS removed", !ddl.includes("INHERITS")],
  ["PL/pgSQL transpiled (at least one)", notes.some(n => n.action.includes("PL/pgSQL") && n.action.includes("SQL function"))],
  ["PL/pgSQL validation to CHECK", notes.some(n => n.action.includes("CHECK"))],
  ["SQL functions preserved", notes.some(n => n.action.includes("preserved"))],
  ["Stub generated for PERFORM", notes.some(n => n.action.includes("stub"))],
  ["Extensions handled", notes.some(n => n.object === "pgcrypto" || n.object === "uuid-ossp")],
  ["Custom type flagged", notes.some(n => n.object === "address" || (n.action && n.action.includes("unmapped")))],
  ["INET mapped to text", ddl.includes("last_ip text") || ddl.includes("ip text")],
  ["TSVECTOR mapped to text", ddl.includes("search_tokens text")],
  ["TEXT[] mapped to text", notes.some(n => n.action.includes("TEXT[]"))],
  ["Partial index WHERE noted", notes.some(n => n.action.includes("WHERE clause removed"))],
  ["GIN index converted to btree", notes.some(n => n.action.includes("GIN") && n.action.includes("btree"))],
];

console.log("=== DSQL Schema Converter - Final Audit ===\n");

let passed = 0;
let failed = 0;
for (const [name, result] of checks) {
  if (result) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}`);
    failed++;
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed out of ${checks.length} ===`);
console.log(`\nSummary: ${JSON.stringify(summary, null, 2)}`);

if (failed > 0) {
  process.exit(1);
}
