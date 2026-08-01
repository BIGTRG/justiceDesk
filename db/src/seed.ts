/**
 * Seed script. Idempotent — safe to re-run.
 *
 * Every workflow definition is validated before it is written. A definition that fails
 * validation aborts the whole seed rather than landing a broken state machine that would
 * strand a litigant mid-case.
 *
 *   pnpm --filter @justicedesk/db seed
 */

import { assertValidWorkflowDefinition, validateWorkflowDefinition } from '@justicedesk/shared'
import { pathToFileURL } from 'node:url'
import type pg from 'pg'
import { closePool, getPool } from './pool.js'
import { CASE_TYPES, JURISDICTIONS, PLANS, TEMPLATES, WORKFLOW_DEFINITIONS } from './seeds/index.js'

/**
 * The tenant every seeded row belongs to.
 *
 * Migration 0004 made workflow definitions, templates and fees tenant-scoped, which also
 * moved their unique constraints. The seed has to resolve the tenant and use the new
 * conflict targets, or every ON CONFLICT here fails to match an index.
 */
async function defaultTenantId(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM tenants WHERE key = $1`,
    [process.env.SEED_TENANT_KEY ?? 'justice_desk']
  )
  const tenant = rows[0]
  if (!tenant) {
    throw new Error(
      'No tenant to seed into. Run migrations first — 0004_multi_tenancy.sql creates the justice_desk tenant.'
    )
  }
  return tenant.id
}

async function seedJurisdictions(client: pg.PoolClient): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  for (const j of JURISDICTIONS) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO jurisdictions (key, state, county, court_level, efile_supported, filing_addresses, time_zone)
       VALUES ($1, $2, $3, $4::court_level, $5, $6::jsonb, $7)
       ON CONFLICT (key) DO UPDATE
         SET filing_addresses = EXCLUDED.filing_addresses,
             efile_supported  = EXCLUDED.efile_supported,
             time_zone        = EXCLUDED.time_zone
       RETURNING id`,
      [j.key, j.state, j.county, j.courtLevel, j.efileSupported, JSON.stringify(j.filingAddresses), j.timeZone]
    )
    ids.set(j.key, rows[0]!.id)
  }
  console.log(`  jurisdictions: ${ids.size}`)
  return ids
}

async function seedCaseTypes(client: pg.PoolClient): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  for (const c of CASE_TYPES) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO case_types (key, name, description, active)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE
         SET name = EXCLUDED.name, description = EXCLUDED.description, active = EXCLUDED.active
       RETURNING id`,
      [c.key, c.name, c.description, c.active]
    )
    ids.set(c.key, rows[0]!.id)
  }
  console.log(`  case types: ${ids.size}`)
  return ids
}

async function seedWorkflows(
  client: pg.PoolClient,
  caseTypeIds: Map<string, string>,
  jurisdictionIds: Map<string, string>,
  tenantId: string
): Promise<void> {
  for (const def of WORKFLOW_DEFINITIONS) {
    // Fail the seed rather than write a broken state machine.
    assertValidWorkflowDefinition(def)

    const caseTypeId = caseTypeIds.get(def.caseTypeKey)
    const jurisdictionId = jurisdictionIds.get(def.jurisdictionKey)
    if (!caseTypeId) throw new Error(`Workflow references unknown case type "${def.caseTypeKey}".`)
    if (!jurisdictionId) {
      throw new Error(`Workflow references unknown jurisdiction "${def.jurisdictionKey}".`)
    }

    await client.query(
      `INSERT INTO workflow_definitions
         (tenant_id, case_type_id, jurisdiction_id, version, status, definition, verification)
       VALUES ($7, $1, $2, $3, $4::workflow_status, $5::jsonb, $6::jsonb)
       ON CONFLICT (tenant_id, case_type_id, jurisdiction_id, version) DO UPDATE
         SET definition   = EXCLUDED.definition,
             verification = EXCLUDED.verification
         -- Only draft rows are updatable; 0003 blocks edits to published definitions.
         WHERE workflow_definitions.status = 'draft'`,
      [
        caseTypeId,
        jurisdictionId,
        def.version,
        def.status,
        JSON.stringify(def),
        JSON.stringify(def.verification),
        tenantId,
      ]
    )

    const result = validateWorkflowDefinition(def)
    console.log(
      `  workflow: ${def.caseTypeKey}/${def.jurisdictionKey} v${def.version} ` +
        `(${def.stages.length} stages, ${result.warnings.length} warnings)`
    )
  }
}

async function seedTemplates(
  client: pg.PoolClient,
  caseTypeIds: Map<string, string>,
  jurisdictionIds: Map<string, string>,
  tenantId: string
): Promise<void> {
  for (const t of TEMPLATES) {
    const caseTypeId = caseTypeIds.get(t.caseTypeKey)
    const jurisdictionId = jurisdictionIds.get(t.jurisdictionKey)
    if (!caseTypeId || !jurisdictionId) {
      throw new Error(`Template "${t.key}" references an unknown case type or jurisdiction.`)
    }

    await client.query(
      `INSERT INTO document_templates
         (tenant_id, case_type_id, jurisdiction_id, key, name, source, form_pdf_minio_key,
          field_map, interview_schema, disclosure_text, verification)
       VALUES ($11, $1, $2, $3, $4, $5::template_source, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb)
       ON CONFLICT (tenant_id, case_type_id, jurisdiction_id, key) DO UPDATE
         SET name             = EXCLUDED.name,
             source           = EXCLUDED.source,
             form_pdf_minio_key = EXCLUDED.form_pdf_minio_key,
             field_map        = EXCLUDED.field_map,
             interview_schema = EXCLUDED.interview_schema,
             disclosure_text  = EXCLUDED.disclosure_text,
             verification     = EXCLUDED.verification`,
      [
        caseTypeId,
        jurisdictionId,
        t.key,
        t.name,
        t.source,
        t.formPdfMinioKey,
        JSON.stringify(t.fieldMap),
        JSON.stringify(t.interviewSchema),
        t.disclosureText,
        JSON.stringify(t.verification),
        tenantId,
      ]
    )
  }
  console.log(`  templates: ${TEMPLATES.length}`)
}

/**
 * Fee lines for the three case types.
 *
 * `plans` no longer exists — 0005 migrated it into `fee_schedule`, keyed by
 * `<case_type>.<kind>`. Everything seeds as draft: publishing is an explicit admin act
 * after the compliance gate clears.
 */
async function seedFees(
  client: pg.PoolClient,
  caseTypeIds: Map<string, string>,
  tenantId: string
): Promise<void> {
  for (const p of PLANS) {
    const caseTypeId = caseTypeIds.get(p.caseTypeKey)
    if (!caseTypeId) throw new Error(`Fee references unknown case type "${p.caseTypeKey}".`)

    const key = `${p.caseTypeKey}.${p.kind}`
    await client.query(
      `INSERT INTO fee_schedule
         (tenant_id, key, name, category, amount_cents, unit, case_type_id, status, is_placeholder)
       SELECT $1, $2, $3, $4::fee_category, $5, $6::fee_unit, $7, $8::plan_status, TRUE
        WHERE NOT EXISTS (
          SELECT 1 FROM fee_schedule WHERE tenant_id = $1 AND key = $2
        )`,
      [
        tenantId,
        key,
        p.name,
        p.kind === 'monthly' ? 'subscription' : 'one_shot_document',
        p.priceCents,
        p.kind === 'monthly' ? 'month' : 'document',
        caseTypeId,
        p.status,
      ]
    )
  }
  console.log(`  fees: ${PLANS.length} (draft placeholders — publish from the admin pricing board)`)
}

export async function seed(): Promise<void> {
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const tenantId = await defaultTenantId(client)
    const jurisdictionIds = await seedJurisdictions(client)
    const caseTypeIds = await seedCaseTypes(client)
    await seedWorkflows(client, caseTypeIds, jurisdictionIds, tenantId)
    await seedTemplates(client, caseTypeIds, jurisdictionIds, tenantId)
    await seedFees(client, caseTypeIds, tenantId)
    await client.query('COMMIT')
    console.log('\nSeed complete.')
    console.log('All legal content is seeded as UNVERIFIED and every fee as DRAFT.')
    console.log('Run `pnpm --filter @justicedesk/db verify-content` for the outstanding review list.')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error(err)
      await closePool()
      process.exit(1)
    })
}
