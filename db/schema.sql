-- Marketplace API — data layer (HW #12).
-- Four tables, three FKs, types that don't lie: timestamptz for time,
-- numeric for money (never float — see README/OPTIMIZATIONS.md), CHECK
-- where bad data would otherwise be silently representable.

CREATE TABLE users (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text        NOT NULL UNIQUE,
  full_name  text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text          NOT NULL,
  description text          NOT NULL,
  price       numeric(10,2) NOT NULL CHECK (price >= 0),
  created_at  timestamptz   NOT NULL DEFAULT now(),

  -- Generated, not maintained by hand: Postgres recomputes it on every
  -- INSERT/UPDATE of name/description, so it can never drift out of sync
  -- the way a trigger-maintained or application-maintained copy could.
  -- 'simple' config on purpose here — see OPTIMIZATIONS.md § Морфологія
  -- for why that choice has a real, named cost.
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', name || ' ' || description)) STORED
);

CREATE TABLE orders (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint        NOT NULL REFERENCES users (id),
  status       text          NOT NULL CHECK (status IN ('pending', 'completed', 'cancelled')),
  total_amount numeric(10,2) NOT NULL CHECK (total_amount >= 0),
  created_at   timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   bigint        NOT NULL REFERENCES orders (id),
  product_id bigint        NOT NULL REFERENCES products (id),
  quantity   integer       NOT NULL CHECK (quantity > 0),
  unit_price numeric(10,2) NOT NULL CHECK (unit_price >= 0)
);
