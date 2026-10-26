import type pg from 'pg';

/** A pool or a single client inside a transaction: repositories accept either. */
export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;
