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
  jurisdictionIds: Map<string, string>
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
         (case_type_id, jurisdiction_id, version, status, definition, verification)
       VALUES ($1, $2, $3, $4::workflow_status, $5::jsonb, $6::jsonb)
       ON CONFLICT (case_type_id, jurisdiction_id, version) DO UPDATE
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
  jurisdictionIds: Map<string, string>
): Promise<void> {
  for (const t of TEMPLATES) {
    const caseTypeId = caseTypeIds.get(t.caseTypeKey)
    const jurisdictionId = jurisdictionIds.get(t.jurisdictionKey)
    if (!caseTypeId || !jurisdictionId) {
      throw new Error(`Template "${t.key}" references an unknown case type or jurisdiction.`)
    }

    await client.query(
      `INSERT INTO document_templates
         (case_type_id, jurisdiction_id, key, name, source, form_pdf_minio_key,
          field_map, interview_schema, disclosure_text, verification)
       VALUES ($1, $2, $3, $4, $5::template_source, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb)
       ON CONFLICT (case_type_id, jurisdiction_id, key) DO UPDATE
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
      ]
    )
  }
  console.log(`  templates: ${TEMPLATES.length}`)
}

async function seedPlans(client: pg.PoolClient, caseTypeIds: Map<string, string>): Promise<void> {
  for (const p of PLANS) {
    const caseTypeId = caseTypeIds.get(p.caseTypeKey)
    if (!caseTypeId) throw new Error(`Plan references unknown case type "${p.caseTypeKey}".`)

    // Never touch a live plan: 0003 freezes its price, and re-seeding must not attempt it.
    await client.query(
      `INSERT INTO plans (case_type_id, kind, price_cents, name, status)
       SELECT $1, $2::plan_kind, $3, $4, $5::plan_status
       WHERE NOT EXISTS (
         SELECT 1 FROM plans
         WHERE case_type_id = $1 AND kind = $2::plan_kind AND price_cents = $3
       )`,
      [caseTypeId, p.kind, p.priceCents, p.name, p.status]
    )
  }
  console.log(`  plans: ${PLANS.length} (seeded as draft — publish from the admin pricing board)`)
}

export async function seed(): Promise<void> {
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const jurisdictionIds = await seedJurisdictions(client)
    const caseTypeIds = await seedCaseTypes(client)
    await seedWorkflows(client, caseTypeIds, jurisdictionIds)
    await seedTemplates(client, caseTypeIds, jurisdictionIds)
    await seedPlans(client, caseTypeIds)
    await client.query('COMMIT')
    console.log('\nSeed complete.')
    console.log('All legal content is seeded as UNVERIFIED and every plan as DRAFT.')
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
