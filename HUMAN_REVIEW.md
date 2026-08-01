# HUMAN_REVIEW.md

Things the v2 build could not resolve without a human decision. Per the execution rules:
*"Anything ambiguous in a statute, deadline rule, court fee, or disclosure text: flag it
here, do not guess."*

Legal-content items from Phase 1 live in `COMPLIANCE.md` §4 and in the machine-readable
report (`pnpm --filter @justicedesk/db verify-content`, currently 78 findings / 27
blocking). This file holds what v2 added.

Status key: **BLOCKING** stops the build step that needs it · **DECISION** needs an owner
call · **COUNSEL** needs Bannon.

---

## G — Gateway / infrastructure

### G-1 · BLOCKING · Shared legal gateway wire contract
The transport seam is built and the gateway is the default path
(`services/ai-gateway/src/transport.ts`). Its contract is **assumed, not verified** —
`10.2.0.2` is unreachable from the build machine (ping times out; ports 80/443/8080/4100
refused), so nothing could be confirmed against the real service.

Every assumption is marked `CONTRACT:` in that one file. Needed:

| # | Question | Currently assumed |
|---|---|---|
| 1 | Base URL reachable from the app hosts | `LEGAL_GATEWAY_URL`, no default |
| 2 | Route for a completion | `POST {base}/v1/messages` |
| 3 | Auth scheme for the RBAC credential | `Authorization: Bearer <token>` |
| 4 | How app identity is conveyed | `x-app-id` header + `app_id` in body |
| 5 | How the policy profile is selected | `x-policy-profile` header + `policy_profile` in body |
| 6 | Request body shape | Anthropic Messages-compatible |
| 7 | Response body shape | Anthropic-compatible `content[]` + `usage` |
| 8 | How a profile is *registered* (for `justice_desk_voice`) | unknown — no code written |
| 9 | RBAC role/scope this app needs | unknown |

Until this lands, running requires `ALLOW_DIRECT_ANTHROPIC=true`, which is a logged
deviation from v2 pre-flight rule 3 and must not ship.

### G-2 · DECISION · Does the gateway replace or precede the local guardrails?
The build assumes **precede**: the gateway is an upstream policy layer and
`applyGuardrails` still runs on everything returned. Two independent layers, deliberately.
Confirm that is intended and that the local pipeline should not be removed as redundant.

### G-3 · DECISION · `justice_desk_voice` profile contents
Non-negotiable #6 requires voice to share the app's guardrail profile with no prompt
drift. A separate profile name implies *some* difference (barge-in, spoken register,
call-flow tools). Which parts may differ, and which must be byte-identical to
`prose_platform`?

---

## F — Fees

### F-1 · DECISION · Every seeded amount is a placeholder
`fee_schedule` is seeded from the v2 spec's illustrative numbers ($1.99/min, $9 session,
$39 document, $20/$50 packs) as **draft, `is_placeholder = true`**. None are purchasable.
The owner sets real amounts in the admin pricing board. No fee is hardcoded anywhere.

### F-2 · BLOCKING (COUNSEL) · Referral lead fees deliberately not seeded
The spec cites market ranges ($25–85 intake, $40–180 family, $150+ injury). **No
`referral_lead` rows were created.** Seeding a number would imply the structure is settled
when `COMPLIANCE.md` §3 is still open. Needs the fee structure approved first, then
per-practice-area and per-county amounts.

### F-3 · DECISION · Contested-tier fees left at zero
`document.responsive`, `pack.discovery`, `pack.motion` are seeded at `0` — the spec
describes the tier ("N responsive documents, overage per document") without naming
amounts. Needs: the included-count N, the overage amount, and pack pricing.

### F-4 · DECISION · Call-fee credit toward first month (rung 4)
"Call fees already paid are CREDITED to the first month." Undefined: whether credit is
capped at the first month's price, whether it expires, whether it survives cancellation,
and whether a $50 pack fully offsets a $49 month. Not implemented pending the rule.

---

## L — Legal / compliance (all COUNSEL)

### L-1 · BLOCKING · Referral offers already live in the UI
See `COMPLIANCE.md` §3. Two attorney-review offers ship in the Phase 1 UI today. Once
referral revenue exists, the same unchanged words may become advertising. Decide what
disclosure they need *at the point of display*.

### L-2 · BLOCKING · In-call disclosure and TCPA consent script
Not written. Needs exact wording for: recording announcement, referral disclosure, TCPA
express written consent, and the paywall notice. All four are read to a person in distress
at speed — wording matters and I will not draft it.

### L-3 · BLOCKING · Court-records direct mail
v2 §5B already routes letter copy to counsel. Additionally: several states regulate
solicitation of newly-served defendants specifically (waiting periods, required labelling,
sometimes a filing requirement). The trigger feed must not be built send-capable before
this clears.

### L-4 · DECISION + COUNSEL · Conversion pressure vs. the guardrails
Non-negotiable #1 ("no call ends without a revenue event or a captured lead") and the UPL
guardrails pull opposite ways. Guardrail withholding will show up as free-window
abandonment, which someone may later "fix" by loosening layer 1. Recommend an explicit
written decision that the guardrail wins, encoded as a test.

### L-5 · DECISION · Document Assurance guarantee
"If a clerk rejects a Justice Desk document for a preparation defect, we correct and
regenerate it free." Undefined: what counts as a preparation defect versus a content
error the litigant supplied, who adjudicates, and whether it implies any warranty. Copy
pending counsel per the spec.

---

## T — Tenancy

### T-1 · DECISION · Cross-tenant identity is deliberately separate
The same phone number now creates **separate user rows per tenant** — a person with a case
under the debt brand and one under the eviction brand has two accounts and cannot see one
from the other. This enforces §5C's "never cross-steer" rule, at the cost of a person
having to sign in twice. Verified working. Confirm that is the intent.

### T-2 · DECISION · Vertical brands are tenants, not deployments
Modelled as `tenants.kind = 'vertical_brand'` sharing one database with tenant-scoped
indexes and a cross-tenant guard trigger. The alternative — separate databases per sister
company — gives stronger isolation and a harder story if the quiet common ownership is
ever examined. Cheap to change now, expensive later.

---

## Resolved during this build

- **Multi-tenancy retrofit** — done, `0004_multi_tenancy.sql`. Applied and verified
  against real Postgres, including that the two Phase 1 partial unique indexes were
  globally scoped and would have let one tenant's publish silently retire another's.
- **Fee schedule** — done, `0005_fee_schedule.sql`. `plans` migrated into `fee_schedule`
  with row IDs preserved so existing subscriptions stayed valid; price-freeze and
  pinning invariants carried over and re-verified.
- **No hardcoded prices** — confirmed by inspection. Phase 1 already read every amount
  from the database; the literals in the seed file are seed *data*, not code constants.
