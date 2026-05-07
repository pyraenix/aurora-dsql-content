-- =============================================================
-- Full test schema: exercises ALL conversion paths (43 features)
-- Use this to verify the converter handles every PostgreSQL
-- feature it claims to support.
-- =============================================================

-- Extensions (handled vs removed)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS postgis;

-- ENUM types (→ CHECK constraints)
CREATE TYPE account_status AS ENUM ('active', 'suspended', 'closed');
CREATE TYPE severity AS ENUM ('low', 'medium', 'high', 'critical');

-- Custom type (flagged)
CREATE TYPE address AS (street TEXT, city TEXT, zip VARCHAR(10));

-- Sequences (preserved natively with CACHE)
CREATE SEQUENCE ticket_number_seq START 5000 INCREMENT 1;
CREATE SEQUENCE invoice_seq START 1;

-- Table with SERIAL, JSONB, JSON, INET, arrays, TIMETZ, FK
CREATE TABLE organizations (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    settings JSONB DEFAULT '{}',
    config JSON DEFAULT '{}',
    billing_email TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Table with ENUM, TSVECTOR, MONEY, geometric types, TIMETZ, GENERATED STORED
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    status account_status DEFAULT 'active',
    balance MONEY,
    search_tokens TSVECTOR,
    home_location POINT,
    login_times TIMETZ[],
    preferred_contact_time TIMETZ,
    last_login_ip INET,
    preferences JSONB DEFAULT '{"theme": "dark"}',
    score NUMERIC(10,2) DEFAULT 0,
    score_weighted NUMERIC(10,2) GENERATED ALWAYS AS (score * 1.5) STORED,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (org_id, email)
);

-- Table with multiple FKs, arrays, NUMERIC precision
CREATE TABLE tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_number BIGINT DEFAULT nextval('ticket_number_seq'),
    org_id BIGINT NOT NULL REFERENCES organizations(id),
    reporter_id UUID NOT NULL REFERENCES users(id),
    assignee_id UUID REFERENCES users(id),
    title VARCHAR(500) NOT NULL,
    description TEXT,
    severity severity DEFAULT 'medium',
    tags TEXT[] DEFAULT '{}',
    metadata JSONB,
    time_spent INTERVAL,
    estimated_hours NUMERIC(6,2),
    is_resolved BOOLEAN DEFAULT FALSE,
    due_date DATE,
    created_at TIMESTAMPTZ DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

-- Table with self-referencing FK
CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id),
    parent_id UUID REFERENCES comments(id),
    body TEXT NOT NULL,
    attachments JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Partitioned table (→ flat)
CREATE TABLE audit_events (
    id BIGSERIAL,
    org_id BIGINT NOT NULL,
    actor_id UUID,
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(50),
    target_id TEXT,
    details JSONB,
    ip_address INET,
    occurred_at TIMESTAMPTZ DEFAULT now()
) PARTITION BY RANGE (occurred_at);

-- Temporary table (→ regular with _tmp_ prefix)
CREATE TEMPORARY TABLE import_buffer (
    raw_data TEXT,
    row_number INTEGER,
    is_valid BOOLEAN DEFAULT FALSE,
    error_message TEXT
);

-- Table with inheritance (→ flat)
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    message TEXT NOT NULL,
    read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE email_notifications (
    subject VARCHAR(200),
    sent_at TIMESTAMPTZ
) INHERITS (notifications);

-- Indexes: btree, gin, gist, partial, unique, expression
CREATE INDEX idx_users_org ON users (org_id);
CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_search ON users USING gin (search_tokens);
CREATE INDEX idx_users_location ON users USING gist (home_location);
CREATE INDEX idx_tickets_org ON tickets (org_id);
CREATE INDEX idx_tickets_assignee ON tickets (assignee_id) WHERE assignee_id IS NOT NULL;
CREATE INDEX idx_tickets_tags ON tickets USING gin (tags);
CREATE INDEX idx_tickets_open ON tickets (org_id, created_at DESC) WHERE is_resolved = FALSE;
CREATE UNIQUE INDEX idx_tickets_number ON tickets (org_id, ticket_number);
CREATE INDEX idx_tickets_cover ON tickets (org_id) INCLUDE (title, is_resolved);
CREATE INDEX idx_comments_ticket ON comments (ticket_id);
CREATE INDEX idx_audit_org_time ON audit_events (org_id, occurred_at DESC);

-- PL/pgSQL: SET_COLUMN pattern (updated_at trigger)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- PL/pgSQL: VALIDATION pattern (→ CHECK constraint)
CREATE OR REPLACE FUNCTION validate_ticket()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.estimated_hours < 0 THEN
        RAISE EXCEPTION 'estimated_hours cannot be negative';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_ticket
    BEFORE INSERT ON tickets
    FOR EACH ROW EXECUTE FUNCTION validate_ticket();

-- PL/pgSQL: AUDIT_INSERT pattern
CREATE OR REPLACE FUNCTION log_ticket_change()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO audit_events (org_id, actor_id, action, target_type, target_id, details, occurred_at)
    VALUES (NEW.org_id, NEW.reporter_id, TG_OP, 'ticket', NEW.id::text, row_to_json(NEW)::jsonb, now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_tickets
    AFTER INSERT OR UPDATE ON tickets
    FOR EACH ROW EXECUTE FUNCTION log_ticket_change();

-- PL/pgSQL: CASCADE_DML pattern
CREATE OR REPLACE FUNCTION cascade_close_tickets()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE tickets SET is_resolved = TRUE, resolved_at = now()
    WHERE org_id = OLD.id AND is_resolved = FALSE;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cascade_close
    BEFORE DELETE ON organizations
    FOR EACH ROW EXECUTE FUNCTION cascade_close_tickets();

-- PL/pgSQL: FOR LOOP pattern (→ set-based)
CREATE OR REPLACE FUNCTION expire_old_tickets()
RETURNS void AS $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT id FROM tickets WHERE due_date < CURRENT_DATE AND is_resolved = FALSE
    LOOP
        UPDATE tickets SET is_resolved = TRUE, resolved_at = now() WHERE id = r.id;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- PL/pgSQL: IF/ELSE pattern (→ CASE WHEN)
CREATE OR REPLACE FUNCTION get_priority_label(sev severity)
RETURNS text AS $$
BEGIN
    IF sev = 'critical' THEN
        RETURN 'P0 - Immediate';
    ELSE
        RETURN 'Normal';
    END IF;
END;
$$ LANGUAGE plpgsql;

-- PL/pgSQL: EXCEPTION WHEN unique_violation (→ ON CONFLICT)
CREATE OR REPLACE FUNCTION upsert_user_preference(p_user_id UUID, p_key TEXT, p_value TEXT)
RETURNS void AS $$
BEGIN
    INSERT INTO user_preferences (user_id, key, value) VALUES (p_user_id, p_key, p_value);
    EXCEPTION WHEN unique_violation THEN
        UPDATE user_preferences SET value = p_value WHERE user_id = p_user_id AND key = p_key;
END;
$$ LANGUAGE plpgsql;

-- PL/pgSQL: Dynamic SQL (→ expanded per-table)
CREATE OR REPLACE FUNCTION cleanup_old_data(table_name text, days integer)
RETURNS void AS $$
BEGIN
    EXECUTE format('DELETE FROM %I WHERE created_at < now() - interval ''%s days''', table_name, days);
END;
$$ LANGUAGE plpgsql;

-- PL/pgSQL: CURSOR pattern (→ set-based)
CREATE OR REPLACE FUNCTION batch_notify_users()
RETURNS void AS $$
DECLARE
    cur CURSOR FOR SELECT id FROM users WHERE status = 'active' AND last_login_ip IS NULL;
    rec RECORD;
BEGIN
    FOR rec IN cur
    LOOP
        INSERT INTO notifications (user_id, message) VALUES (rec.id, 'Please update your profile');
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- PL/pgSQL: EXCEPTION WHEN no_data_found (→ COALESCE)
CREATE OR REPLACE FUNCTION safe_get_org_name(p_id BIGINT)
RETURNS text AS $$
DECLARE
    result text;
BEGIN
    SELECT name INTO result FROM organizations WHERE id = p_id;
    RETURN result;
    EXCEPTION WHEN no_data_found THEN
        RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- PL/pgSQL: Genuinely unconvertible (PERFORM — will be stubbed)
CREATE OR REPLACE FUNCTION do_side_effects(p_id UUID)
RETURNS void AS $$
BEGIN
    PERFORM pg_notify('ticket_channel', p_id::text);
    PERFORM some_external_function(p_id);
END;
$$ LANGUAGE plpgsql;

-- SQL function (preserved as-is)
CREATE FUNCTION days_until_due(due DATE) RETURNS INTEGER
LANGUAGE sql AS $$
    SELECT (due - CURRENT_DATE)::integer;
$$;

-- Materialized view (→ regular view)
CREATE MATERIALIZED VIEW org_dashboard AS
    SELECT
        o.id,
        o.name,
        COUNT(DISTINCT u.id) AS user_count,
        COUNT(DISTINCT t.id) AS ticket_count,
        COUNT(DISTINCT t.id) FILTER (WHERE t.is_resolved = FALSE) AS open_tickets,
        AVG(t.estimated_hours)::NUMERIC(6,2) AS avg_estimate
    FROM organizations o
    LEFT JOIN users u ON u.org_id = o.id
    LEFT JOIN tickets t ON t.org_id = o.id
    GROUP BY o.id, o.name;

-- Regular view (preserved)
CREATE VIEW open_tickets_view AS
    SELECT t.*, u.email AS reporter_email, o.name AS org_name
    FROM tickets t
    JOIN users u ON u.id = t.reporter_id
    JOIN organizations o ON o.id = t.org_id
    WHERE t.is_resolved = FALSE;
