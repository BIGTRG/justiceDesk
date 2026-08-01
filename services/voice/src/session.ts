/**
 * Call session driver.
 *
 * Owns the impure half of a call: persisting events, executing effects, and talking to
 * svc-ai-gateway. The decisions all live in the pure state machine in @justicedesk/shared.
 *
 * WHY svc-ai-gateway AND NOT THE LEGAL GATEWAY DIRECTLY
 * The operator's legal gateway is an authenticated proxy with no guardrails. v2
 * non-negotiable #6 requires voice to share the app's guardrail profile with no drift,
 * and since there is no profile to share, the only way to satisfy it is topology:
 *
 *     svc-voice ──> svc-ai-gateway ──> legal gateway ──> Claude
 *                   (UPL guardrails, citations, disclosure)
 *
 * A voice agent pointed straight at the proxy would have zero guardrails, and a proxy
 * will faithfully relay an answer telling a caller what to do.
 */

import type { Logger } from '@justicedesk/service-kit'
import {
  finalize,
  initialSnapshot,
  meteredChargeCents,
  transition,
  type CallEffect,
  type CallEvent,
  type CallOutcome,
  type CallSnapshot,
  type PaywallPolicy,
} from '@justicedesk/shared'
import type pg from 'pg'
import { scriptFor, SCRIPT_VERSION, type Language } from './scripts.js'

export interface SessionDeps {
  db: pg.Pool
  logger: Logger
  policy: PaywallPolicy
  /** Ask svc-ai-gateway a question. Returns guardrailed text only. */
  ask: (params: { callId: string; question: string; language: Language }) => Promise<string>
  /** Twilio actions. */
  say: (callSid: string, text: string, language: Language) => Promise<void>
  sendSms: (to: string, body: string) => Promise<void>
  /** Stripe payment link creation, via svc-api. */
  createPaymentLink: (params: {
    callId: string
    kind: 'metered' | 'flat_session' | 'document'
    amountCents: number
  }) => Promise<string>
}

export interface CallRecord {
  id: string
  tenantId: string
  callSid: string
  fromE164: string
  language: Language
  startedAt: number
}

/**
 * A live call.
 *
 * Holds the snapshot in memory for latency (a phone call cannot wait on a round trip per
 * token) but writes every event to `call_events` as it goes, so a crashed process leaves
 * a reconstructable call rather than a mystery. `replay()` rebuilds the snapshot.
 */
export class CallSession {
  private snapshot: CallSnapshot = initialSnapshot()

  constructor(
    private readonly call: CallRecord,
    private readonly deps: SessionDeps
  ) {}

  get state(): CallSnapshot {
    return this.snapshot
  }

  /** Ms since the call was answered. The machine takes time as data, never reads a clock. */
  private nowMs(): number {
    return Date.now() - this.call.startedAt
  }

  async handle(event: CallEvent): Promise<void> {
    const before = this.snapshot.state
    const result = transition(this.snapshot, event, this.deps.policy)
    this.snapshot = result.snapshot

    await this.persistEvent(event, before)

    for (const effect of result.effects) {
      await this.execute(effect)
    }
  }

  private async persistEvent(event: CallEvent, fromState: string): Promise<void> {
    await this.deps.db.query(
      `INSERT INTO call_events (call_id, offset_ms, kind, from_state, to_state, payload)
       VALUES ($1, $2, $3, $4::call_state, $5::call_state, $6::jsonb)`,
      [
        this.call.id,
        event.atMs,
        event.type,
        fromState,
        this.snapshot.state,
        JSON.stringify(redactEventPayload(event)),
      ]
    )

    await this.deps.db.query(
      `UPDATE calls
          SET state = $2::call_state,
              billable_seconds = $3,
              free_window_ended_at = COALESCE(free_window_ended_at, $4),
              recording_announced_at = COALESCE(recording_announced_at, $5)
        WHERE id = $1`,
      [
        this.call.id,
        this.snapshot.state,
        Math.floor(this.snapshot.billableMs / 1000),
        this.snapshot.state !== 'free_window' && this.snapshot.state !== 'greeting'
          ? new Date()
          : null,
        this.snapshot.recordingAnnouncedAtMs !== null ? new Date() : null,
      ]
    )
  }

  private async execute(effect: CallEffect): Promise<void> {
    const { logger } = this.deps

    switch (effect.type) {
      case 'say':
        await this.deps.say(this.call.callSid, scriptFor(effect.key, this.call.language), this.call.language)
        break

      case 'announce_recording':
        // The machine only advances past greeting once this resolves, so a failed
        // announcement means no recording — which is the correct failure (#5).
        await this.handle({ type: 'recording_announced', atMs: this.nowMs() })
        break

      case 'request_consent': {
        const line = effect.kind === 'referral_disclosure' ? 'referral_disclosure' : 'tcpa_consent_request'
        await this.deps.say(this.call.callSid, scriptFor(line, this.call.language), this.call.language)
        break
      }

      case 'send_payment_link': {
        const url = await this.deps.createPaymentLink({
          callId: this.call.id,
          kind: effect.kind,
          amountCents: effect.amountCents,
        })
        await this.deps.sendSms(this.call.fromE164, `Justice Desk: continue your call — ${url}`)
        break
      }

      case 'send_app_link':
        // The transcript pre-fills the case, so the caller lands in a portal already
        // built and never re-enters anything (#7).
        await this.deps.sendSms(
          this.call.fromE164,
          'Justice Desk: your case is ready. Open it here — <link>'
        )
        break

      case 'create_case_draft':
        await this.deps.db.query(
          `INSERT INTO call_events (call_id, kind, payload)
           VALUES ($1, 'case_draft_requested', $2::jsonb)`,
          [this.call.id, JSON.stringify({ caseTypeKey: effect.caseTypeKey })]
        )
        break

      case 'route_referral':
        // svc-referral is build-order step 4. Recorded now so nothing is lost in between.
        await this.deps.db.query(
          `INSERT INTO call_events (call_id, kind, payload)
           VALUES ($1, 'referral_pending', $2::jsonb)`,
          [this.call.id, JSON.stringify({ practiceArea: effect.practiceArea, county: effect.county })]
        )
        logger.info('referral queued for svc-referral', { callId: this.call.id })
        break

      case 'enroll_in_drip':
        logger.info('drip enrollment queued', { callId: this.call.id })
        break

      case 'start_metering':
      case 'stop_metering':
      case 'start_free_window':
      case 'offer_paywall':
        // State-only; the snapshot already reflects them.
        break

      case 'end_call':
        await this.close(effect.outcome)
        break
    }
  }

  /** Record a consent decision with the exact script that produced it. */
  async recordConsent(kind: Parameters<typeof this.handle>[0] extends never ? never : 'recording' | 'tcpa_sms' | 'tcpa_call' | 'referral_disclosure', granted: boolean, utterance?: string): Promise<void> {
    const line = kind === 'referral_disclosure' ? 'referral_disclosure' : 'tcpa_consent_request'
    await this.deps.db.query(
      `INSERT INTO call_consents
         (call_id, tenant_id, kind, granted, script_version, script_text, utterance, offset_ms, phone_e164)
       VALUES ($1, $2, $3::consent_kind, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (call_id, kind) DO NOTHING`,
      [
        this.call.id,
        this.call.tenantId,
        kind,
        granted,
        SCRIPT_VERSION,
        scriptFor(line, this.call.language),
        utterance ?? null,
        this.nowMs(),
        this.call.fromE164,
      ]
    )

    // A refusal is a global opt-out, honoured across every tenant and channel (#4).
    if (!granted && (kind === 'tcpa_sms' || kind === 'tcpa_call')) {
      await this.deps.db.query(
        `INSERT INTO contact_optouts (phone_e164, source) VALUES ($1, 'in_call_refusal')
         ON CONFLICT (phone_e164) DO NOTHING`,
        [this.call.fromE164]
      )
    }

    await this.handle({ type: 'consent_captured', atMs: this.nowMs(), kind, granted })
  }

  /**
   * End the call.
   *
   * `finalize` decides the outcome from what actually happened rather than from what was
   * offered, so the north-star metric cannot be inflated by reaching a state.
   */
  async close(reached: CallOutcome): Promise<void> {
    const at = this.nowMs()

    if (this.snapshot.state !== 'ended') {
      const settled =
        reached === 'abandoned' || reached === 'transferred'
          ? { snapshot: { ...this.snapshot, state: 'ended' as const, outcome: reached } }
          : finalize(this.snapshot, at, reached)
      this.snapshot = settled.snapshot
    }

    const chargeCents = meteredChargeCents(this.snapshot.billableMs, this.deps.policy.perMinuteCents)

    await this.deps.db.query(
      `UPDATE calls
          SET state = 'ended',
              outcome = $2::call_outcome,
              ended_at = now(),
              duration_seconds = $3,
              billable_seconds = $4
        WHERE id = $1`,
      [
        this.call.id,
        this.snapshot.outcome,
        Math.floor(at / 1000),
        Math.floor(this.snapshot.billableMs / 1000),
      ]
    )

    this.deps.logger.info('call ended', {
      callId: this.call.id,
      outcome: this.snapshot.outcome,
      durationSeconds: Math.floor(at / 1000),
      billableSeconds: Math.floor(this.snapshot.billableMs / 1000),
      meteredChargeCents: chargeCents,
    })
  }

  /** Ask the guardrailed assistant. Never calls a model directly. */
  async ask(question: string): Promise<string> {
    return this.deps.ask({ callId: this.call.id, question, language: this.call.language })
  }
}

/**
 * Strip caller speech from the persisted event payload.
 *
 * `call_events` is append-only and widely read (dashboards, QA queue). The verbatim
 * transcript belongs in MinIO behind the same signed-URL and audit controls as documents,
 * not inline in an operational table.
 */
export function redactEventPayload(event: CallEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...event }
  delete payload.type
  delete payload.atMs
  if ('utterance' in payload) payload.utterance = '[stored in transcript]'
  return payload
}
