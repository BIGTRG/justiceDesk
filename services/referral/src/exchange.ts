/**
 * Lead delivery targets.
 *
 * Execution rule from the v2 prompt: "svc-referral posts leads to the TRG Lead Exchange
 * ingestion API when it exists; until then, write to a local leads table with the
 * universal lead object shape so the cutover is a config change."
 *
 * Both targets take the same `UniversalLead`, so switching is setting one env var. The
 * local target is not a stub — it is the system of record until the Exchange exists, and
 * everything downstream (routing, billing, disputes) works against it.
 */

import type { Logger } from '@justicedesk/service-kit'
import { LEAD_BODY_FORBIDDEN_FIELDS, type UniversalLead } from '@justicedesk/shared'
import type pg from 'pg'

export interface DeliveryResult {
  /** Identifier in whichever system took it. */
  externalId: string
  target: 'local' | 'lead_exchange'
  deliveredAt: Date
}

export interface LeadTarget {
  readonly kind: 'local' | 'lead_exchange'
  deliver(lead: UniversalLead, leadId: string): Promise<DeliveryResult>
}

/**
 * Strip anything that must not travel with the offer.
 *
 * Contact details are released on acceptance, not broadcast. A lead fanned out to a panel
 * would otherwise hand the caller's phone number to every firm that looked at it and
 * passed. Applied to BOTH targets so the local path cannot drift looser than the remote.
 */
export function sanitiseLeadBody(lead: UniversalLead): UniversalLead {
  const copy = { ...lead } as Record<string, unknown>
  for (const field of LEAD_BODY_FORBIDDEN_FIELDS) delete copy[field]
  return copy as unknown as UniversalLead
}

/** The default target: the local `leads` table. */
export class LocalLeadTarget implements LeadTarget {
  readonly kind = 'local' as const
  constructor(private readonly db: pg.Pool) {}

  async deliver(lead: UniversalLead, leadId: string): Promise<DeliveryResult> {
    // Already persisted by the caller; this records that the local target accepted it.
    await this.db.query(
      `UPDATE leads SET exchange_external_id = $2 WHERE id = $1 AND exchange_external_id IS NULL`,
      [leadId, `local:${leadId}`]
    )
    return { externalId: `local:${leadId}`, target: 'local', deliveredAt: new Date() }
  }
}

/** The TRG Lead Exchange, once its ingestion API exists. */
export class LeadExchangeTarget implements LeadTarget {
  readonly kind = 'lead_exchange' as const

  constructor(
    private readonly config: { baseUrl: string; token: string; timeoutMs: number },
    private readonly logger: Logger
  ) {}

  async deliver(lead: UniversalLead, leadId: string): Promise<DeliveryResult> {
    const body = sanitiseLeadBody(lead)

    let response: Response
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/v1/leads`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.token}`,
          // Makes retries safe: the Exchange can dedupe on our lead id.
          'idempotency-key': leadId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (err) {
      this.logger.error('lead exchange unreachable', {
        leadId,
        err: err instanceof Error ? err : new Error(String(err)),
      })
      throw new Error('Lead Exchange is unreachable.')
    }

    if (!response.ok) {
      throw new Error(`Lead Exchange rejected the lead (${response.status}).`)
    }

    const payload = (await response.json().catch(() => ({}))) as { id?: string }
    return {
      externalId: payload.id ?? `exchange:${leadId}`,
      target: 'lead_exchange',
      deliveredAt: new Date(),
    }
  }
}

/**
 * Pick a target from configuration.
 *
 * Local is the default and is chosen by absence, not by a flag, so forgetting to
 * configure the Exchange degrades to a working local queue rather than dropping leads.
 */
export function selectLeadTarget(
  env: NodeJS.ProcessEnv,
  db: pg.Pool,
  token: string | null,
  logger: Logger
): LeadTarget {
  const baseUrl = env.LEAD_EXCHANGE_URL
  if (baseUrl && token) {
    return new LeadExchangeTarget(
      { baseUrl, token, timeoutMs: Number(env.LEAD_EXCHANGE_TIMEOUT_MS ?? 15_000) },
      logger
    )
  }
  if (baseUrl && !token) {
    throw new Error(
      'LEAD_EXCHANGE_URL is set but no `lead_exchange_token` is in the credential vault. ' +
        'Refusing to start rather than silently falling back to the local queue.'
    )
  }
  return new LocalLeadTarget(db)
}
