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

### G-1a · RESOLVED (key issued) · Voice app registered
`justice-desk-voice` is registered on the gateway at 120 req/min and the key is in the
vault as `legal_gateway_voice_key`. svc-voice declares `x-app-surface: voice`, and
svc-ai-gateway runs those calls under the `justice_desk_voice` identity — rate-limit
isolation only, identical guardrail pipeline.

### G-1b · ACTION REQUIRED · Rotate the voice key
The key was supplied in a chat transcript, which is not a secret store. It should be
regenerated on the gateway and replaced in the vault. Nothing in the codebase needs to
change — the key is read from the vault at boot, never from a literal.

### G-1c · BLOCKING (verification) · Contract unverified against the live gateway
The contract is implemented from the operator's written answers, not from a live call:
`10.2.0.2` is unreachable from the development machine, which is not on the private
network. `scripts/verify-gateway.sh` checks all five assumptions and must be run **on a
host with a route** before real traffic. Until it passes, "wired up" means "written to
spec", not "confirmed working".

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

## V — Voice (build-order step 1)

### V-1 · DECISION + COUNSEL · Does the paywall ever get waived?
The spec is unambiguous: three minutes free, then pay. Implemented as written.

But the caller whose hearing is tomorrow, phoning at 11pm, is cut off at three minutes
unless they pay — and that caller is the one the product exists for. The state machine
carries a `waivePaywall(snapshot)` hook that **defaults to never waiving**, so no policy
has been invented; the mechanism simply exists so a decision can be implemented without a
rewrite.

Needs an explicit call: never waive, waive on an imminent deadline, waive on a detected
crisis, or something else. This interacts directly with `COMPLIANCE.md` §3's conversion-
pressure item.

### V-2 · BLOCKING (COUNSEL) · Spanish scripts are machine-drafted
`services/voice/src/scripts.ts` carries Spanish for every line, translated from the
English without review. A mistranslated recording announcement or TCPA consent is a
defective disclosure, not a cosmetic bug. The Spanish line must not open until these are
professionally translated and reviewed. Tracked with L-2.

### V-3 · DECISION · Metered billing rounds down
Partial minutes are free: 61 seconds bills one minute, not two. Rounding up is defensible
and disclosed, but reads as sharp practice to someone already being sued over money.
Confirm, or change `meteredChargeCents`.

### V-4 · DECISION · Two outcomes the spec's list omits
The spec lists `doc | subscription | referral | drip | none`. The implementation adds
`abandoned` (hung up inside the free window) and `transferred`, because non-negotiable #1
requires every call to carry an outcome and folding those into `none` would inflate the
no-capture bucket with people who were never asked for anything — and would make
free-window abandonment, a metric the spec explicitly wants, unmeasurable.

### V-5 · BLOCKING · svc-voice cannot scale past one process yet
Live calls are held in process memory keyed by Twilio call SID, so PM2 runs it
single-instance. Clustering would route a mid-call webhook to a worker that has never
heard of the call. Moving session state to Redis is the prerequisite for horizontal
scale, and should happen before any volume.

---

## R — Referral (build-order step 4)

### R-1 · BLOCKING (COUNSEL) · No referral fee amounts are seeded
The engine is built and the flat-fee structure is enforced by trigger, but **no
`referral_lead` rows exist**. Seeding an amount would imply the structure is settled while
`COMPLIANCE.md` §3 is open. `billingEligibility` returns `no_published_fee` until amounts
are published, which is the correct staging behaviour rather than a fault.

### R-2 · DECISION · Contact details are released on acceptance, not with the offer
A lead offered to a panel carries the matter and the county, not the caller's phone
number. It is released only when a recipient accepts. The alternative — broadcasting
contact details to everyone who looks — would hand a distressed caller's number to every
firm that declined. Confirm this is the intent, since it slows speed-to-lead slightly.

### R-3 · DECISION · An unqualified lead is kept, not discarded
A lead that failed only because a consent was never asked for stays in `draft` with its
reasons, so it is recoverable on a callback. Confirm that retention is wanted; the
alternative is deleting non-consented contact data immediately.

### R-4 · DECISION · Damages band routes but cannot price
`damages_band` exists on `leads` because an injury matter routes to a different panel than
a small claim. `feeKeyFor` takes practice area and county only — two arguments, asserted by
a test — so case value is structurally unable to reach the fee (#2). Confirm that routing
on damages band is itself acceptable.

---

## D — Drip (build-order step 5)

### D-1 · COUNSEL · How long does TCPA consent stay fresh?
No fixed statutory number. The implementation uses **18 months** as a conservative
placeholder so the system errs toward re-asking. Counsel should set the real figure.

### D-2 · BLOCKING (COUNSEL) · Drip copy is unwritten
`drip_campaigns.copy_approved` defaults false and `shouldSendDrip` suppresses on it, so no
drip can send until copy is approved. The messages go unsolicited to people in legal
distress; wording is counsel's.

### D-3 · DECISION · Quiet hours are wider than the legal floor
8pm–8am recipient-local, deliberately more conservative than required. Confirm or narrow.

### D-4 · DECISION · Opt-out matching is loose on purpose
"please stop texting me" and "leave me alone" are honoured, not just the exact keyword
STOP. Requiring the keyword to honour a plain request would be indefensible; confirm.

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
