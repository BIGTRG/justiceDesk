/**
 * Shared Postgres pool. Password comes from the credential vault, never from a literal.
 */

import { readSecret } from '@justicedesk/shared'
import pg from 'pg'

const { Pool } = pg

let pool: pg.Pool | null = null

export function getPool(): pg.Pool {
  if (pool) return pool

  const passwordKey = process.env.PGPASSWORD_VAULT_KEY ?? 'postgres_password'
  const password = readSecret(passwordKey, { allowEnvFallback: true })

  pool = new Pool({
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? 'justicedesk',
    user: process.env.PGUSER ?? 'justicedesk',
    password,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: true } : undefined,
    max: Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
  })

  return pool
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
