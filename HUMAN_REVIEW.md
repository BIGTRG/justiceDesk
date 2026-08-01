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

### G-1 · RESOLVED · Gateway wire contract confirmed
All nine questions answered by the operator and the code corrected to match. Verified
differences from the assumed contract:

| # | Assumed | Actual |
|---|---|---|
| 1 | `http://10.2.0.2` | `http://10.2.0.2:3500` |
| 2 | `POST /v1/messages` | **`POST /v1/chat/completions`** — OpenAI-style route, Anthropic-shaped body |
| 3 | `Authorization: Bearer` | correct |
| 4 | `x-app-id` header | **no header** — identity is which bearer key is sent |
| 5 | `x-policy-profile` header | **no such thing** — no policy profiles exist |
| 6 | Anthropic-compatible body | correct |
| 7 | Anthropic-compatible response | correct |
| 8 | profile registration API | **none** — add key to `/opt/claude-gateway/.env`, add app name to `APP_KEYS` and `RATE_LIMITS` in `main.py`, restart PM2 |
| 9 | RBAC roles/scopes | **none** — every app gets identical access; only per-app rate limiting (60–150 req/min) |

Pinned by tests in `services/ai-gateway/src/transport.test.ts` so a refactor cannot drift
back to the assumed shape.

### G-1a · BLOCKING · Voice app key not yet issued
`svc-voice` must run as its own registered app so its call volume cannot exhaust the web
app's rate-limit budget. Needs, on the gateway:

1. `APP_KEY_JUSTICE_DESK_VOICE=<generated>` in `/opt/claude-gateway/.env`
2. `"justice-desk-voice"` added to the `APP_KEYS` and `RATE_LIMITS` dicts in `main.py`
3. PM2 restart
4. The key placed in this platform's credential vault as `legal_gateway_voice_key`

Until then the code registers only `justice_desk` and refuses voice calls rather than
borrowing the web app's key.

### G-2 · RESOLVED — and the answer changes the architecture
The question was whether the gateway *replaces* or *precedes* the local guardrails.
Neither: **the gateway enforces nothing.** It is an authenticated proxy with rate
limiting. There is no upstream policy layer at all.

So the guardrails in `svc-ai-gateway` are not defence in depth. They are the only defence.
Nothing upstream catches unauthorized-practice output, an uncurated citation, or a missing
disclosure. Recorded in `COMPLIANCE.md` §1 and in the transport file header, because an
engineer who assumes an upstream policy layer exists might reasonably relax the local one.

### G-3 · RESOLVED, with a consequence for svc-voice
There is no `justice_desk_voice` policy profile to define — profiles do not exist. The
name survives only as an app identity for rate-limit accounting.

**The consequence is the important part.** v2 non-negotiable #6 requires voice to share
the app's guardrail profile with no prompt drift. That cannot be satisfied at the gateway.
It is satisfied only by topology:

```
svc-voice ──> svc-ai-gateway ──> legal gateway ──> Claude
              (guardrails live here)   (proxy)
```

A voice agent wired straight to `10.2.0.2` would have **zero** guardrails — the proxy will
faithfully relay an answer telling a caller what to do. This constrains build-order step 1
and is not optional.

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
