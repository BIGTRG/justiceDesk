/**
 * Migration runner.
 *
 * Applies every `NNNN_*.sql` in db/migrations in filename order, once, inside a
 * transaction, recording each in `schema_migrations`. A file that has already run is
 * skipped; a file whose checksum changed after it ran is a hard error, because silently
 * re-running an edited migration is how environments drift apart.
 *
 *   pnpm --filter @justicedesk/db migrate
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { closePool, getPool } from './pool.js'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

interface Migration {
  name: string
  sql: string
  checksum: string
}

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8')
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') }
    })
}

export async function migrate(): Promise<void> {
  const pool = getPool()

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  const { rows } = await pool.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations'
  )
  const applied = new Map(rows.map((r) => [r.name, r.checksum]))
  const migrations = loadMigrations()

  for (const m of migrations) {
    const previous = applied.get(m.name)

    if (previous) {
      if (previous !== m.checksum) {
        throw new Error(
          `Migration ${m.name} has already been applied but its contents have changed.\n` +
            `Editing an applied migration silently diverges environments. Add a new migration instead.`
        )
      }
      console.log(`  = ${m.name} (already applied)`)
      continue
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(m.sql)
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        m.name,
        m.checksum,
      ])
      await client.query('COMMIT')
      console.log(`  + ${m.name}`)
    } catch (err) {
      await client.query('ROLLBACK')
      throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`, { cause: err })
    } finally {
      client.release()
    }
  }

  console.log(`Migrations up to date (${migrations.length} total).`)
}

// Run when invoked directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error(err)
      await closePool()
      process.exit(1)
    })
}
