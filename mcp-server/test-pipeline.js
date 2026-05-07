/**
 * End-to-end test of the dsql-lint + converter pipeline.
 * Run: node test-pipeline.js
 */

import { parseSQL } from "./src/sql-parser.js";
import { convertSchema, formatReport } from "./src/converter.js";
import { dsqlLintFix, dsqlLintValidate, isDsqlLintAvailable } from "./src/dsql-lint.js";

const sql = `
CREATE TYPE user_role AS ENUM ('admin', 'editor', 'viewer');

CREATE SEQUENCE order_id_seq START 1;

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  email TEXT NOT NULL,
  role user_role DEFAULT 'viewer',
  profile JSONB DEFAULT '{}',
  ip_address INET,
  balance NUMERIC(12,2) DEFAULT 0.00,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE posts (
  id BIGSERIAL PRIMARY KEY,
  author_id BIGINT NOT NULL REFERENCES users(id),
  title VARCHAR(255) NOT NULL,
  body TEXT,
  tags TEXT[] DEFAULT '{}',
  published BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_posts_author ON posts (author_id);
CREATE INDEX idx_posts_tags ON posts USING gin (tags);

CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE OR REPLACE FUNCTION validate_balance()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.balance < 0 THEN
    RAISE EXCEPTION 'balance cannot be negative';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_balance
  BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION validate_balance();

CREATE MATERIALIZED VIEW active_users AS
  SELECT * FROM users WHERE is_active = TRUE;

CREATE VIEW recent_posts AS
  SELECT * FROM posts WHERE created_at > now() - interval '7 days';
`;

console.log("=== dsql-lint available:", isDsqlLintAvailable(), "===\n");

// Step 1: dsql-lint --fix
console.log("--- STEP 1: dsql-lint --fix ---");
const lintResult = dsqlLintFix(sql);
console.log("Fixes applied:", lintResult.summary);
console.log("\nDiagnostics:");
for (const d of lintResult.diagnostics) {
  console.log(`  [${d.fix_result.status}] ${d.rule}: ${d.message.substring(0, 80)}`);
}
console.log("\nFixed SQL (first 500 chars):");
console.log(lintResult.fixedSql.substring(0, 500));
console.log("...\n");

// Step 2: Our parser + converter (on original input)
console.log("--- STEP 2: Our converter ---");
const parsed = parseSQL(sql);
const { ddl, notes, summary } = convertSchema(parsed, "postgresql");
console.log("Summary:", JSON.stringify(summary, null, 2));
console.log("\nConversion notes:");
for (const n of notes) {
  console.log(`  ${n.object}: ${n.action}`);
}

// Step 3: Validate dsql-lint's output
console.log("\n--- STEP 3: Validate dsql-lint output ---");
try {
  const validation = dsqlLintValidate(lintResult.fixedSql);
  console.log("Validation:", validation.summary);
  if (!validation.clean) {
    console.log("Remaining issues:");
    for (const d of validation.diagnostics) {
      console.log(`  [${d.fix_result.status}] ${d.rule}: ${d.message.substring(0, 80)}`);
    }
  }
} catch (e) {
  console.log("Validation error:", e.message);
}

console.log("\n--- DONE ---");
