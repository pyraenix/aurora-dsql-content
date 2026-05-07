export const SAMPLE_SCHEMA = `-- Complete test: every conversion path
-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS postgis;

-- ENUM types
CREATE TYPE account_status AS ENUM ('active', 'suspended', 'closed');
CREATE TYPE priority AS ENUM ('low', 'medium', 'high', 'critical');

-- Custom type
CREATE TYPE address AS (street TEXT, city TEXT, zip VARCHAR(10));

-- Sequences
CREATE SEQUENCE ticket_seq START 5000 INCREMENT 1;
CREATE SEQUENCE invoice_seq START 1;

-- Table: every data type
CREATE TABLE all_types (
  col_smallint SMALLINT,
  col_integer INTEGER,
  col_bigint BIGINT,
  col_real REAL,
  col_double DOUBLE PRECISION,
  col_numeric NUMERIC(15,4),
  col_decimal DECIMAL(10,2),
  col_serial SERIAL,
  col_bigserial BIGSERIAL,
  col_char CHAR(10),
  col_varchar VARCHAR(255),
  col_text TEXT,
  col_date DATE,
  col_time TIME,
  col_timetz TIMETZ,
  col_timestamp TIMESTAMP,
  col_timestamptz TIMESTAMPTZ,
  col_interval INTERVAL,
  col_boolean BOOLEAN,
  col_bytea BYTEA,
  col_uuid UUID,
  col_json JSON,
  col_jsonb JSONB,
  col_text_array TEXT[],
  col_int_array INTEGER[],
  col_inet INET,
  col_cidr CIDR,
  col_macaddr MACADDR,
  col_tsvector TSVECTOR,
  col_point POINT,
  col_xml XML,
  col_money MONEY,
  col_computed NUMERIC(10,2) GENERATED ALWAYS AS (col_numeric * 1.1) STORED,
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

-- Table: ENUMs, FKs, constraints
CREATE TABLE organizations (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL UNIQUE,
  settings JSONB DEFAULT '{}',
  config JSON DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id BIGINT NOT NULL REFERENCES organizations(id),
  email VARCHAR(255) NOT NULL,
  status account_status DEFAULT 'active',
  preferences JSONB DEFAULT '{"theme":"dark"}',
  last_ip INET,
  search_tokens TSVECTOR,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (org_id, email)
);

CREATE TABLE tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number BIGINT DEFAULT nextval('ticket_seq'),
  org_id BIGINT NOT NULL REFERENCES organizations(id),
  reporter_id UUID NOT NULL REFERENCES users(id),
  assignee_id UUID REFERENCES users(id),
  title VARCHAR(500) NOT NULL,
  priority priority DEFAULT 'medium',
  tags TEXT[] DEFAULT '{}',
  metadata JSONB,
  estimated_hours NUMERIC(6,2),
  is_resolved BOOLEAN DEFAULT FALSE,
  due_date DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Self-referencing FK
CREATE TABLE comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id),
  parent_id UUID REFERENCES comments(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Partitioned table
CREATE TABLE audit_log (
  id BIGSERIAL,
  action VARCHAR(100) NOT NULL,
  details JSONB,
  ip INET,
  occurred_at TIMESTAMPTZ DEFAULT now()
) PARTITION BY RANGE (occurred_at);

-- Temporary table
CREATE TEMPORARY TABLE import_buffer (
  raw_data TEXT,
  is_valid BOOLEAN DEFAULT FALSE
);

-- Table inheritance
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE email_notifications (
  subject VARCHAR(200),
  sent_at TIMESTAMPTZ
) INHERITS (notifications);

-- Indexes: all types
CREATE INDEX idx_users_org ON users (org_id);
CREATE INDEX idx_users_search ON users USING gin (search_tokens);
CREATE INDEX idx_types_gist ON all_types USING gist (col_point);
CREATE INDEX idx_tickets_open ON tickets (org_id, created_at DESC) WHERE is_resolved = FALSE;
CREATE INDEX idx_tickets_cover ON tickets (org_id) INCLUDE (title, priority, is_resolved);
CREATE UNIQUE INDEX idx_tickets_number ON tickets (org_id, ticket_number);
CREATE INDEX idx_tickets_tags ON tickets USING gin (tags);

-- ALTER TABLE ADD FK
ALTER TABLE audit_log ADD CONSTRAINT fk_audit FOREIGN KEY (id) REFERENCES users(id);

-- PL/pgSQL: SET_COLUMN
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS ` + "$$" + `
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
` + "$$" + ` LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- PL/pgSQL: VALIDATION
CREATE OR REPLACE FUNCTION validate_hours()
RETURNS TRIGGER AS ` + "$$" + `
BEGIN
  IF NEW.estimated_hours < 0 THEN
    RAISE EXCEPTION 'hours cannot be negative';
  END IF;
  RETURN NEW;
END;
` + "$$" + ` LANGUAGE plpgsql;

CREATE TRIGGER trg_validate
  BEFORE INSERT ON tickets
  FOR EACH ROW EXECUTE FUNCTION validate_hours();

-- PL/pgSQL: AUDIT_INSERT
CREATE OR REPLACE FUNCTION log_change()
RETURNS TRIGGER AS ` + "$$" + `
BEGIN
  INSERT INTO audit_log (action, details, occurred_at)
  VALUES (TG_OP, row_to_json(NEW)::jsonb, now());
  RETURN NEW;
END;
` + "$$" + ` LANGUAGE plpgsql;

CREATE TRIGGER trg_audit
  AFTER INSERT ON tickets
  FOR EACH ROW EXECUTE FUNCTION log_change();

-- PL/pgSQL: CASCADE_DML
CREATE OR REPLACE FUNCTION cascade_resolve()
RETURNS TRIGGER AS ` + "$$" + `
BEGIN
  UPDATE tickets SET is_resolved = TRUE WHERE org_id = OLD.id AND is_resolved = FALSE;
  RETURN OLD;
END;
` + "$$" + ` LANGUAGE plpgsql;

CREATE TRIGGER trg_cascade
  BEFORE DELETE ON organizations
  FOR EACH ROW EXECUTE FUNCTION cascade_resolve();

-- PL/pgSQL: FOR LOOP
CREATE OR REPLACE FUNCTION expire_tickets()
RETURNS void AS ` + "$$" + `
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM tickets WHERE due_date < CURRENT_DATE AND is_resolved = FALSE
  LOOP
    UPDATE tickets SET is_resolved = TRUE WHERE id = r.id;
  END LOOP;
END;
` + "$$" + ` LANGUAGE plpgsql;

-- PL/pgSQL: IF/ELSE
CREATE OR REPLACE FUNCTION get_label(p text)
RETURNS text AS ` + "$$" + `
BEGIN
  IF p = 'critical' THEN RETURN 'P0'; ELSE RETURN 'Normal'; END IF;
END;
` + "$$" + ` LANGUAGE plpgsql;

-- PL/pgSQL: EXCEPTION unique_violation
CREATE OR REPLACE FUNCTION upsert_setting(p_user UUID, p_key TEXT, p_val TEXT)
RETURNS void AS ` + "$$" + `
BEGIN
  INSERT INTO user_settings (user_id, key, value) VALUES (p_user, p_key, p_val);
  EXCEPTION WHEN unique_violation THEN
    UPDATE user_settings SET value = p_val WHERE user_id = p_user AND key = p_key;
END;
` + "$$" + ` LANGUAGE plpgsql;

-- PL/pgSQL: Dynamic SQL
CREATE OR REPLACE FUNCTION cleanup(tbl text, days integer)
RETURNS void AS ` + "$$" + `
BEGIN
  EXECUTE format('DELETE FROM %I WHERE created_at < now() - interval ''%s days''', tbl, days);
END;
` + "$$" + ` LANGUAGE plpgsql;

-- PL/pgSQL: CURSOR
CREATE OR REPLACE FUNCTION notify_inactive()
RETURNS void AS ` + "$$" + `
DECLARE
  cur CURSOR FOR SELECT id FROM users WHERE status = 'active' AND last_ip IS NULL;
  rec RECORD;
BEGIN
  FOR rec IN cur LOOP
    INSERT INTO notifications (user_id, message) VALUES (rec.id, 'Update profile');
  END LOOP;
END;
` + "$$" + ` LANGUAGE plpgsql;

-- PL/pgSQL: EXCEPTION no_data_found
CREATE OR REPLACE FUNCTION safe_org_name(p_id BIGINT)
RETURNS text AS ` + "$$" + `
DECLARE result text;
BEGIN
  SELECT name INTO result FROM organizations WHERE id = p_id;
  RETURN result;
  EXCEPTION WHEN no_data_found THEN RETURN NULL;
END;
` + "$$" + ` LANGUAGE plpgsql;

-- PL/pgSQL: PERFORM (unconvertible)
CREATE OR REPLACE FUNCTION fire_event(p_id UUID)
RETURNS void AS ` + "$$" + `
BEGIN
  PERFORM pg_notify('events', p_id::text);
END;
` + "$$" + ` LANGUAGE plpgsql;

-- SQL functions (preserved)
CREATE FUNCTION days_left(due DATE) RETURNS INTEGER
LANGUAGE sql AS ` + "$$" + `
  SELECT (due - CURRENT_DATE)::integer;
` + "$$" + `;

CREATE FUNCTION full_name(first TEXT, last TEXT) RETURNS TEXT
LANGUAGE sql AS ` + "$$" + `
  SELECT first || ' ' || last;
` + "$$" + `;

-- Materialized view (demoted)
CREATE MATERIALIZED VIEW org_stats AS
  SELECT o.id, o.name, COUNT(DISTINCT u.id) AS users
  FROM organizations o
  LEFT JOIN users u ON u.org_id = o.id
  GROUP BY o.id, o.name;

-- Regular view (preserved)
CREATE VIEW open_tickets AS
  SELECT t.*, u.email AS reporter
  FROM tickets t JOIN users u ON u.id = t.reporter_id
  WHERE t.is_resolved = FALSE;`;
