/**
 * Call economics dashboard and voice QA queue (v2 §5D). Admin only.
 *
 * Revenue-per-call is the north-star metric (non-negotiable #1), so these queries are
 * written to be honest about it rather than flattering:
 *
 *   * Un-outcomed calls are surfaced, not filtered out. A dashboard that silently drops
 *     rows it cannot classify overstates conversion, and the schema already refuses an
 *     ended call with no outcome — so a non-zero count here means calls are still live
 *     or a process died mid-call, both of which someone should see.
 *   * Revenue per call divides by ALL calls, including abandoned ones. Dividing only by
 *     "engaged" calls is the number that makes a bad week look fine.
 *   * Free-window abandonment is reported as its own rate, because it is the metric the
 *     UPL guardrails will move: a guardrail correctly withholding advice shows up here,
 *     and someone must be able to tell that apart from a broken paywall.
 */

import { asyncHandler, HttpError } from '@justicedesk/service-kit'
import { Router } from 'express'
import type pg from 'pg'
import { auditFromRequest } from '../audit.js'

export function createAnalyticsRoutes(db: pg.Pool): Router {
  const router = Router()

  /** Headline call economics over a window. */
  router.get(
    '/call-economics',
    asyncHandler(async (req, res) => {
      const days = Math.min(90, Math.max(1, Number(req.query.days ?? 14)))

      const { rows: totals } = await db.query(
        `SELECT
           count(*)                                          AS "totalCalls",
           count(*) FILTER (WHERE state = 'ended')            AS "endedCalls",
           count(*) FILTER (WHERE state <> 'ended')           AS "inFlightOrStranded",
           COALESCE(sum(revenue_cents), 0)                    AS "revenueCents",
           COALESCE(avg(duration_seconds), 0)::int            AS "avgDurationSeconds",
           COALESCE(sum(billable_seconds), 0)                 AS "billableSeconds"
         FROM calls
         WHERE started_at >= now() - ($1 || ' days')::interval`,
        [days]
      )
      const t = totals[0]!

      // Divided by ALL calls, deliberately. See the file header.
      const revenuePerCall =
        Number(t.totalCalls) > 0 ? Number(t.revenueCents) / Number(t.totalCalls) : 0

      const { rows: mix } = await db.query(
        `SELECT COALESCE(outcome::text, 'unresolved') AS outcome, count(*)::int AS calls,
                COALESCE(sum(revenue_cents), 0)::int AS "revenueCents"
           FROM calls
          WHERE started_at >= now() - ($1 || ' days')::interval
          GROUP BY 1 ORDER BY calls DESC`,
        [days]
      )

      const { rows: abandonment } = await db.query(
        `SELECT
           count(*) FILTER (WHERE outcome = 'abandoned')::int AS "abandonedInFreeWindow",
           count(*) FILTER (WHERE free_window_ended_at IS NOT NULL)::int AS "reachedPaywall",
           count(*)::int AS "total"
         FROM calls
         WHERE started_at >= now() - ($1 || ' days')::interval AND state = 'ended'`,
        [days]
      )
      const a = abandonment[0]!

      const { rows: byCaseType } = await db.query(
        `SELECT COALESCE(detected_case_type, 'unknown') AS "caseType",
                count(*)::int AS calls,
                count(*) FILTER (WHERE outcome IN ('document','subscription','referral','paid_session'))::int
                  AS converted,
                COALESCE(sum(revenue_cents), 0)::int AS "revenueCents"
           FROM calls
          WHERE started_at >= now() - ($1 || ' days')::interval
          GROUP BY 1 ORDER BY calls DESC`,
        [days]
      )

      res.json({
        windowDays: days,
        totals: {
          ...t,
          revenuePerCallCents: Math.round(revenuePerCall),
        },
        outcomeMix: mix,
        freeWindow: {
          ...a,
          abandonmentRate:
            Number(a.total) > 0 ? Number(a.abandonedInFreeWindow) / Number(a.total) : 0,
          // Reported next to abandonment so a guardrail-driven rise is legible rather
          // than looking like a broken paywall.
          note:
            'A rise here can mean the UPL guardrails correctly withheld an answer. Check the voice QA queue before treating it as a funnel problem.',
        },
        byCaseType,
      })
    })
  )

  /** Referral economics — kept separate; it bills a different party. */
  router.get(
    '/referral-economics',
    asyncHandler(async (req, res) => {
      const days = Math.min(90, Math.max(1, Number(req.query.days ?? 30)))

      const { rows } = await db.query(
        `SELECT
           count(*)::int                                             AS "leads",
           count(*) FILTER (WHERE status = 'qualified')::int          AS "qualified",
           count(*) FILTER (WHERE status IN ('delivered','accepted'))::int AS "delivered",
           count(*) FILTER (WHERE status = 'accepted')::int           AS "accepted",
           count(*) FILTER (WHERE status = 'disputed')::int           AS "disputed"
         FROM leads
        WHERE created_at >= now() - ($1 || ' days')::interval`,
        [days]
      )

      const { rows: charged } = await db.query(
        `SELECT count(*)::int AS charges, COALESCE(sum(amount_cents),0)::int AS "revenueCents",
                count(*) FILTER (WHERE credited_at IS NOT NULL)::int AS credited
           FROM lead_charges
          WHERE created_at >= now() - ($1 || ' days')::interval`,
        [days]
      )

      const { rows: speed } = await db.query(
        `SELECT
           count(*)::int AS "measured",
           count(*) FILTER (
             WHERE d.delivered_at - l.qualified_at <= interval '60 seconds'
           )::int AS "withinTarget"
         FROM lead_deliveries d
         JOIN leads l ON l.id = d.lead_id
        WHERE d.delivered_at IS NOT NULL AND l.qualified_at IS NOT NULL
          AND d.routed_at >= now() - ($1 || ' days')::interval`,
        [days]
      )

      res.json({
        windowDays: days,
        funnel: rows[0],
        billing: charged[0],
        speedToLead: {
          ...speed[0],
          targetSeconds: 60,
          rate:
            Number(speed[0]!.measured) > 0
              ? Number(speed[0]!.withinTarget) / Number(speed[0]!.measured)
              : null,
        },
      })
    })
  )

  // ---------------------------------------------------------------- voice QA queue

  router.get(
    '/voice-qa',
    asyncHandler(async (req, res) => {
      const onlyUnreviewed = req.query.reviewed !== 'true'
      const { rows } = await db.query(
        `SELECT q.id, q.call_id AS "callId", q.reason, q.flag_codes AS "flagCodes",
                q.reviewed, q.verdict, q.created_at AS "createdAt",
                c.outcome, c.duration_seconds AS "durationSeconds", c.language
           FROM voice_qa_samples q
           JOIN calls c ON c.id = q.call_id
          WHERE ($1 = FALSE OR q.reviewed = FALSE)
          ORDER BY (q.reason = 'flagged') DESC, q.created_at DESC
          LIMIT 200`,
        [onlyUnreviewed]
      )
      res.json({ samples: rows })
    })
  )

  router.post(
    '/voice-qa/:id/review',
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>
      const verdict = String(body.verdict ?? '')
      if (!['ok', 'minor', 'crossed_line', 'unclear'].includes(verdict)) {
        throw HttpError.badRequest('verdict must be ok, minor, crossed_line or unclear.')
      }

      const { rows } = await db.query(
        `UPDATE voice_qa_samples
            SET reviewed = TRUE, reviewer_id = $2, reviewed_at = now(), verdict = $3, notes = $4
          WHERE id = $1
          RETURNING id, call_id`,
        [req.params.id, req.auth!.userId, verdict, String(body.notes ?? '').slice(0, 4000)]
      )
      if (!rows[0]) throw HttpError.notFound('No such QA sample.')

      await auditFromRequest(db, req, {
        action: 'admin.voice_qa_review',
        entity: 'voice_qa_samples',
        entityId: req.params.id!,
        metadata: { verdict },
      })

      res.json({ reviewed: true })
    })
  )

  /** Drip campaign oversight, with TCPA consent status visible per contact (v2 §5D). */
  router.get(
    '/drip',
    asyncHandler(async (_req, res) => {
      const { rows: campaigns } = await db.query(
        `SELECT c.id, c.key, c.name, c.status, c.copy_approved AS "copyApproved",
                jsonb_array_length(c.steps) AS steps,
                (SELECT count(*) FROM drip_enrollments e WHERE e.campaign_id = c.id AND e.status='active')::int
                  AS "activeEnrollments"
           FROM drip_campaigns c ORDER BY c.created_at DESC`
      )
      const { rows: suppression } = await db.query(
        `SELECT COALESCE(suppressed_reason, status) AS reason, count(*)::int AS count
           FROM drip_sends GROUP BY 1 ORDER BY count DESC`
      )
      const { rows: optouts } = await db.query(`SELECT count(*)::int AS total FROM contact_optouts`)

      res.json({ campaigns, suppression, optOuts: optouts[0] })
    })
  )

  return router
}
