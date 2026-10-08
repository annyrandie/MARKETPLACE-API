// The minimal "something with query()" contract — both `pg.Pool` and
// `pg.PoolClient` satisfy it structurally, with no adapter needed. In
// production code a repository gets a `Pool`; in a ROLLBACK-isolated
// integration test (test/integration/testkit/container.js) it gets a single
// `PoolClient` with an open `BEGIN` instead — the repository itself never
// knows or cares which one it was handed.
export interface QueryResult<T> {
  rows: T[];
}

export interface Queryable {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}
