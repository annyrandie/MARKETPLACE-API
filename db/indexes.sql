-- Minimal set: exactly one index per query, nothing "just in case".
-- Verify after running the four EXPLAINs: no index here should ever show
-- idx_scan = 0 in pg_stat_user_indexes.

-- q1 — owner + period. Equality column left, range column right (same rule
-- as the lecture): user_id narrows to ~15 rows out of 150k, created_at then
-- serves both the range filter and ORDER BY ... DESC LIMIT 20 pre-sorted.
CREATE INDEX idx_orders_user_created ON orders (user_id, created_at);

-- q2 — status filter on a skewed column. 'pending' is ~6% of orders; a
-- partial index over just that slice serves "latest pending" directly off
-- the index in sorted order, without touching the other 94% at all.
CREATE INDEX idx_orders_pending ON orders (created_at) WHERE status = 'pending';

-- q3 — case-insensitive lookup. A plain index on email can't serve
-- lower(email) = ... — B-tree stores raw values, not their lower() form.
-- The expression has to live in the index itself.
CREATE INDEX idx_users_email_lower ON users (lower(email));

-- q4 — full-text search over the generated tsvector column. GIN, not
-- B-tree: a tsvector is a set of lexemes, and GIN is the inverted-index
-- structure built for "does this set contain these terms", not ordering.
CREATE INDEX idx_products_search_vector ON products USING GIN (search_vector);
