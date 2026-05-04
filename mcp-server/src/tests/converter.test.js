import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSQL } from "../sql-parser.js";
import { convertSchema, getSupportedDialects } from "../converter.js";
import { transpilePlpgsql } from "../plpgsql-transpiler.js";

const PG_SCHEMA = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;

  CREATE TYPE mood AS ENUM ('happy', 'sad', 'neutral');

  CREATE SEQUENCE user_id_seq START 1;

  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email TEXT UNIQUE,
    mood mood DEFAULT 'happy',
    metadata JSONB,
    ip_address INET,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    score NUMERIC(10,2)
  );

  CREATE TABLE posts (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    body TEXT,
    tags TEXT[],
    published_at TIMESTAMP WITH TIME ZONE
  );

  CREATE INDEX idx_posts_user ON posts (user_id);
  CREATE INDEX idx_posts_tags ON posts USING gin (tags);

  CREATE TRIGGER update_timestamp
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_modified();

  CREATE OR REPLACE FUNCTION update_modified()
  RETURNS TRIGGER AS $$
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE MATERIALIZED VIEW active_users AS
    SELECT * FROM users WHERE created_at > now() - interval '30 days';

  CREATE VIEW recent_posts AS
    SELECT * FROM posts WHERE published_at > now() - interval '7 days';

  CREATE TEMPORARY TABLE temp_import (data TEXT);
`;

// -----------------------------------------------------------------------
// Parser
// -----------------------------------------------------------------------

describe("SQL Parser", () => {
  it("should parse all object types", () => {
    const p = parseSQL(PG_SCHEMA);
    assert.ok(p.tables.some(t => t.name === "users"));
    assert.ok(p.tables.some(t => t.name === "posts"));
    assert.equal(p.sequences[0].name, "user_id_seq");
    assert.equal(p.triggers[0].name, "update_timestamp");
    assert.equal(p.triggers[0].table, "users");
    assert.equal(p.functions[0].language, "plpgsql");
    assert.deepEqual(p.enumTypes[0].values, ["happy", "sad", "neutral"]);
    assert.equal(p.extensions[0].name, "pgcrypto");
    assert.ok(p.views.find(v => v.name === "active_users").materialized);
  });
});

// -----------------------------------------------------------------------
// PL/pgSQL Transpiler
// -----------------------------------------------------------------------

describe("PL/pgSQL Transpiler", () => {
  it("should transpile SET_COLUMN pattern (updated_at)", () => {
    const func = {
      name: "update_modified",
      language: "plpgsql",
      raw: `CREATE FUNCTION update_modified() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql`,
    };
    const trigger = { name: "trg", table: "users", timing: "BEFORE UPDATE" };
    const result = transpilePlpgsql(func, trigger);
    assert.ok(result.converted, "should convert");
    assert.equal(result.pattern, "SET_COLUMN");
    assert.ok(result.sql.includes("UPDATE users SET"), "should generate UPDATE");
    assert.ok(result.sql.includes("LANGUAGE sql"), "should be SQL function");
  });

  it("should transpile VALIDATION pattern to CHECK constraints", () => {
    const func = {
      name: "validate_price",
      language: "plpgsql",
      raw: `CREATE FUNCTION validate_price() RETURNS TRIGGER AS $$ BEGIN IF NEW.price < 0 THEN RAISE EXCEPTION 'price must be positive'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`,
    };
    const trigger = { name: "trg", table: "products", timing: "BEFORE INSERT" };
    const result = transpilePlpgsql(func, trigger);
    assert.ok(result.converted, "should convert");
    assert.equal(result.pattern, "VALIDATION");
    assert.ok(result.checkConstraints.length > 0, "should produce CHECK constraints");
    assert.ok(result.checkConstraints[0].includes("price >= 0"), "should negate the condition");
  });

  it("should transpile AUDIT_INSERT pattern", () => {
    const func = {
      name: "log_change",
      language: "plpgsql",
      raw: `CREATE FUNCTION log_change() RETURNS TRIGGER AS $$ BEGIN INSERT INTO audit_log(table_name, action, old_id, new_id) VALUES ('orders', TG_OP, OLD.id, NEW.id); RETURN NEW; END; $$ LANGUAGE plpgsql`,
    };
    const result = transpilePlpgsql(func, null);
    assert.ok(result.converted, "should convert");
    assert.equal(result.pattern, "AUDIT_INSERT");
    assert.ok(result.sql.includes("CREATE FUNCTION"), "should generate function");
    assert.ok(result.sql.includes("INSERT INTO audit_log"), "should preserve INSERT");
    assert.ok(result.sql.includes("p_operation"), "should parameterize TG_OP");
  });

  it("should transpile CASCADE_DML pattern", () => {
    const func = {
      name: "cascade_cancel",
      language: "plpgsql",
      raw: `CREATE FUNCTION cascade_cancel() RETURNS TRIGGER AS $$ BEGIN UPDATE orders SET status = 'cancelled' WHERE user_id = OLD.id; RETURN OLD; END; $$ LANGUAGE plpgsql`,
    };
    const trigger = { name: "trg", table: "users", timing: "AFTER DELETE" };
    const result = transpilePlpgsql(func, trigger);
    assert.ok(result.converted, "should convert");
    assert.equal(result.pattern, "CASCADE_DML");
    assert.ok(result.sql.includes("UPDATE orders"), "should preserve UPDATE");
    assert.ok(result.sql.includes("p_id"), "should parameterize OLD.id");
  });

  it("should reject LOOP-based functions", () => {
    const func = {
      name: "batch_process",
      language: "plpgsql",
      raw: `CREATE FUNCTION batch_process() RETURNS void AS $$ DECLARE r RECORD; BEGIN FOR r IN SELECT id FROM items WHERE processed = false LOOP UPDATE items SET processed = true WHERE id = r.id; END LOOP; END; $$ LANGUAGE plpgsql`,
    };
    const result = transpilePlpgsql(func, null);
    // Should now convert FOR..IN LOOP to set-based SQL
    assert.ok(result.converted, "should convert FOR loop to set-based SQL");
    assert.equal(result.pattern, "FOR_LOOP_TO_SET");
    assert.ok(result.sql.includes("UPDATE"), "should produce UPDATE");
    assert.ok(result.sql.includes("FROM"), "should use UPDATE...FROM pattern");
  });

  it("should reject EXCEPTION WHEN blocks", () => {
    const func = {
      name: "safe_insert",
      language: "plpgsql",
      raw: `CREATE FUNCTION safe_insert() RETURNS void AS $$ BEGIN INSERT INTO t(id, name) VALUES(1, 'test'); EXCEPTION WHEN unique_violation THEN NULL; END; $$ LANGUAGE plpgsql`,
    };
    const result = transpilePlpgsql(func, null);
    // Should now convert to ON CONFLICT
    assert.ok(result.converted, "should convert EXCEPTION WHEN unique_violation to ON CONFLICT");
    assert.equal(result.pattern, "EXCEPTION_TO_ON_CONFLICT");
    assert.ok(result.sql.includes("ON CONFLICT DO NOTHING"), "should use ON CONFLICT");
  });

  it("should convert simple IF/ELSE to CASE WHEN", () => {
    const func = {
      name: "get_status",
      language: "plpgsql",
      raw: `CREATE FUNCTION get_status(val integer) RETURNS text AS $$ BEGIN IF val > 0 THEN RETURN 'positive'; ELSE RETURN 'non-positive'; END IF; END; $$ LANGUAGE plpgsql`,
    };
    const result = transpilePlpgsql(func, null);
    assert.ok(result.converted, "should convert IF/ELSE to CASE WHEN");
    assert.equal(result.pattern, "IF_ELSE_TO_CASE");
    assert.ok(result.sql.includes("CASE WHEN"), "should use CASE WHEN");
  });

  it("should reject dynamic SQL (EXECUTE)", () => {
    const func = {
      name: "dynamic_query",
      language: "plpgsql",
      raw: `CREATE FUNCTION dynamic_query(tbl text) RETURNS void AS $$ BEGIN EXECUTE format('DELETE FROM %I WHERE created_at < %L', tbl, now() - interval '30 days'); END; $$ LANGUAGE plpgsql`,
    };
    const result = transpilePlpgsql(func, null);
    // Should now expand dynamic SQL to concrete per-table functions
    assert.ok(result.converted, "should convert dynamic SQL to expanded functions");
    assert.equal(result.pattern, "DYNAMIC_SQL_EXPANDED");
    assert.ok(result.sql.includes("DELETE FROM"), "should contain concrete DML");
    assert.ok(result.sql.includes("my_table"), "should show example table expansion");
  });

  it("should convert CURSOR to set-based SQL", () => {
    const func = {
      name: "process_old",
      language: "plpgsql",
      raw: `CREATE FUNCTION process_old() RETURNS void AS $$ DECLARE cur CURSOR FOR SELECT id FROM orders WHERE status = 'pending'; rec RECORD; BEGIN FOR rec IN cur LOOP UPDATE orders SET status = 'expired' WHERE orders.id = rec.id; END LOOP; END; $$ LANGUAGE plpgsql`,
    };
    const result = transpilePlpgsql(func, null);
    assert.ok(result.converted, "should convert cursor to set-based SQL");
    assert.equal(result.pattern, "CURSOR_TO_SET");
    assert.ok(result.sql.includes("UPDATE orders"), "should produce UPDATE");
    assert.ok(result.sql.includes("FROM"), "should use set-based FROM");
  });

  it("should convert EXCEPTION WHEN no_data_found to COALESCE", () => {
    const func = {
      name: "safe_lookup",
      language: "plpgsql",
      raw: `CREATE FUNCTION safe_lookup(p_id integer) RETURNS text AS $$ DECLARE result text; BEGIN SELECT name INTO result FROM users WHERE id = p_id; RETURN result; EXCEPTION WHEN no_data_found THEN RETURN NULL; END; $$ LANGUAGE plpgsql`,
    };
    const result = transpilePlpgsql(func, null);
    assert.ok(result.converted, "should convert no_data_found to COALESCE");
    assert.equal(result.pattern, "EXCEPTION_TO_DEFENSIVE_SQL");
    assert.ok(result.sql.includes("COALESCE"), "should use COALESCE");
  });
});

// -----------------------------------------------------------------------
// Full converter
// -----------------------------------------------------------------------

describe("Converter: Tables", () => {
  it("should produce CREATE TABLE with correct types", () => {
    const { ddl } = convertSchema(parseSQL(PG_SCHEMA), "postgresql");
    assert.ok(ddl.includes("CREATE TABLE users"));
    assert.ok(ddl.includes("CREATE TABLE _tmp_temp_import"));
    assert.ok(!ddl.match(/\bSERIAL\b/));
    assert.ok(ddl.includes('COLLATE "C"'));
    assert.ok(ddl.includes("numeric(10,2)"));
    assert.ok(ddl.includes("varchar(100)"));
  });

  it("should convert ENUM to CHECK constraint", () => {
    const { ddl } = convertSchema(parseSQL(PG_SCHEMA), "postgresql");
    assert.ok(ddl.includes("CHECK (mood IN ('happy', 'sad', 'neutral'))"));
  });
});

describe("Converter: FK validation functions", () => {
  it("should generate SQL validation functions", () => {
    const { ddl } = convertSchema(parseSQL(PG_SCHEMA), "postgresql");
    assert.ok(ddl.includes("CREATE FUNCTION validate_fk_posts_user_id"));
    assert.ok(ddl.includes("SELECT EXISTS"));
    assert.ok(ddl.includes("LANGUAGE sql"));
  });
});

describe("Converter: Sequences (native DSQL support)", () => {
  it("should preserve sequences with CACHE clause", () => {
    const { ddl, notes } = convertSchema(parseSQL(PG_SCHEMA), "postgresql");
    assert.ok(ddl.includes("CREATE SEQUENCE user_id_seq CACHE 1"), "should preserve sequence with CACHE");
    assert.ok(!ddl.includes("_dsql_sequences"), "should NOT create counter table");
    assert.ok(notes.some(n => n.object === "user_id_seq" && n.action.includes("preserved")));
  });
});

describe("Converter: Triggers → SQL functions", () => {
  it("should generate SQL function for update triggers", () => {
    const { ddl } = convertSchema(parseSQL(PG_SCHEMA), "postgresql");
    assert.ok(ddl.includes("CREATE FUNCTION set_updated_at_users"));
    assert.ok(ddl.includes("UPDATE users SET updated_at = now()"));
  });
});

describe("Converter: PL/pgSQL transpilation in full pipeline", () => {
  it("should transpile update_modified to SQL function", () => {
    const { ddl, notes } = convertSchema(parseSQL(PG_SCHEMA), "postgresql");
    // The transpiler should convert update_modified (SET_COLUMN pattern)
    assert.ok(
      ddl.includes("apply_update_modified_users") || ddl.includes("SET_COLUMN"),
      "should transpile the PL/pgSQL function"
    );
    assert.ok(notes.some(n => n.object === "update_modified" && n.action.includes("SQL function")));
  });

  it("should transpile validation functions to CHECK constraints", () => {
    const sql = `
      CREATE TABLE products (id INTEGER PRIMARY KEY, price NUMERIC(10,2));
      CREATE FUNCTION check_price() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.price < 0 THEN RAISE EXCEPTION 'price must be positive'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_check_price BEFORE INSERT ON products FOR EACH ROW EXECUTE FUNCTION check_price();
    `;
    const { ddl, notes } = convertSchema(parseSQL(sql), "postgresql");
    assert.ok(ddl.includes("CHECK (price >= 0)"), "should generate CHECK constraint");
    assert.ok(notes.some(n => n.action.includes("CHECK")));
  });

  it("should generate stub only for genuinely unconvertible functions", () => {
    const sql = `
      CREATE FUNCTION dynamic_fn(tbl text) RETURNS void AS $$
      BEGIN
        EXECUTE 'DELETE FROM ' || tbl;
      END;
      $$ LANGUAGE plpgsql;
    `;
    const { ddl, notes } = convertSchema(parseSQL(sql), "postgresql");
    assert.ok(ddl.includes("CREATE FUNCTION dynamic_fn()"), "should generate stub");
    assert.ok(ddl.includes("TODO"), "stub should have TODO");
    assert.ok(notes.some(n => n.object === "dynamic_fn" && n.action.includes("stub")));
  });
});

describe("Converter: Views", () => {
  it("should demote materialized views and preserve regular views", () => {
    const { ddl } = convertSchema(parseSQL(PG_SCHEMA), "postgresql");
    assert.ok(ddl.includes("CREATE VIEW active_users AS"));
    assert.ok(ddl.includes("CREATE VIEW recent_posts AS"));
  });
});

describe("Converter: Indexes", () => {
  it("should convert to ASYNC and GIN to btree", () => {
    const { ddl, notes } = convertSchema(parseSQL(PG_SCHEMA), "postgresql");
    assert.ok(ddl.includes("CREATE INDEX ASYNC idx_posts_user"));
    assert.ok(ddl.includes("CREATE INDEX ASYNC idx_posts_tags"));
    assert.ok(notes.some(n => n.object === "idx_posts_tags" && n.action.includes("btree")));
  });
});

describe("Edge Cases", () => {
  it("should handle empty schema", () => {
    const { summary } = convertSchema(parseSQL(""), "postgresql");
    assert.equal(summary.tables_converted, 0);
  });

  it("should reject unsupported dialect", () => {
    const empty = { tables: [], indexes: [], sequences: [], triggers: [], views: [], functions: [], enumTypes: [], customTypes: [], extensions: [], unparsed: [] };
    assert.throws(() => convertSchema(empty, "oracle"), /Unsupported dialect/);
  });

  it("should handle partitioned and inherited tables", () => {
    const sql = `
      CREATE TABLE events (id INTEGER, ts TIMESTAMPTZ) PARTITION BY RANGE (ts);
      CREATE TABLE child (extra TEXT) INHERITS (parent);
    `;
    const { ddl, notes } = convertSchema(parseSQL(sql), "postgresql");
    assert.ok(ddl.includes("CREATE TABLE events"));
    assert.ok(ddl.includes("CREATE TABLE child"));
    assert.ok(notes.some(n => n.action.includes("Partitioned")));
    assert.ok(notes.some(n => n.action.includes("Inherited")));
  });

  it("should preserve SQL functions", () => {
    const sql = `CREATE FUNCTION add_nums(a INTEGER, b INTEGER) RETURNS INTEGER LANGUAGE sql AS $$ SELECT a + b; $$;`;
    const { ddl, notes } = convertSchema(parseSQL(sql), "postgresql");
    assert.ok(ddl.includes("add_nums"));
    assert.ok(notes.some(n => n.object === "add_nums" && n.action.includes("preserved")));
  });
});
