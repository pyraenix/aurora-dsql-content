-- Sample PostgreSQL schema for testing the DSQL Schema Converter
-- This schema exercises all the features the converter handles.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE user_role AS ENUM ('admin', 'editor', 'viewer');
CREATE TYPE address AS (street TEXT, city TEXT, zip TEXT);

CREATE SEQUENCE order_id_seq START 1 INCREMENT 1;

-- Users table with various PG-specific types
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    email TEXT NOT NULL,
    role user_role DEFAULT 'viewer',
    profile JSONB DEFAULT '{}',
    ip_address INET,
    search_vector TSVECTOR,
    balance NUMERIC(12,2) DEFAULT 0.00,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Posts with full-text search and array columns
CREATE TABLE posts (
    id BIGSERIAL PRIMARY KEY,
    author_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,
    body TEXT,
    tags TEXT[] DEFAULT '{}',
    metadata JSONB,
    published BOOLEAN DEFAULT FALSE,
    published_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Comments with self-referencing FK
CREATE TABLE comments (
    id BIGSERIAL PRIMARY KEY,
    post_id BIGINT NOT NULL,
    author_id BIGINT NOT NULL,
    parent_id BIGINT,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES users(id),
    FOREIGN KEY (parent_id) REFERENCES comments(id)
);

-- Audit log with partitioning
CREATE TABLE audit_log (
    id BIGSERIAL,
    table_name TEXT NOT NULL,
    action TEXT NOT NULL,
    old_data JSONB,
    new_data JSONB,
    performed_by BIGINT,
    performed_at TIMESTAMPTZ DEFAULT now()
) PARTITION BY RANGE (performed_at);

-- Temporary staging table
CREATE TEMPORARY TABLE import_staging (
    raw_data TEXT,
    processed BOOLEAN DEFAULT FALSE
);

-- Indexes
CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_search ON users USING gin (search_vector);
CREATE INDEX idx_posts_author ON posts (author_id);
CREATE INDEX idx_posts_slug ON posts (slug);
CREATE INDEX idx_posts_published ON posts (published_at) WHERE published = TRUE;
CREATE UNIQUE INDEX idx_posts_title_author ON posts (author_id, title);
CREATE INDEX idx_comments_post ON comments (post_id);

-- Trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Materialized view
CREATE MATERIALIZED VIEW popular_posts AS
    SELECT p.id, p.title, COUNT(c.id) AS comment_count
    FROM posts p
    LEFT JOIN comments c ON c.post_id = p.id
    WHERE p.published = TRUE
    GROUP BY p.id, p.title
    HAVING COUNT(c.id) > 5;

-- Regular view
CREATE VIEW recent_posts AS
    SELECT * FROM posts WHERE created_at > now() - interval '7 days';
