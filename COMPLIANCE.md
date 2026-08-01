# Compliance gate — READ BEFORE DEPLOYING

**Status: CLOSED.** This codebase is complete and runnable. It must not be deployed
publicly, and payments must not be taken, until the review below is signed off.

From the build specification:

> ⚠️ COMPLIANCE GATE: Build the full codebase, but DO NOT deploy publicly or enable
> payments in production until ethics counsel (Brad Bannon) has reviewed the UPL
> guardrails, disclosure language, and attorney marketplace fee structure.
> Ship to staging only.

---

## How the gate is enforced

The gate is not only a document. Four mechanisms make an accidental launch fail loudly:

| Mechanism | Where | What it does |
|---|---|---|
| Boot interlock | `packages/service-kit/src/compliance.ts` | Every service calls `assertComplianceGate()` before binding a port. Refuses to start with `NODE_ENV=production`, `DEPLOY_TARGET=production`, or `PAYMENTS_MODE=live` while `COMPLIANCE_REVIEW_COMPLETE !== "true"`. |
| Payment interlock | `services/api/src/routes/billing.ts` | A live Stripe key is refused at checkout, not just unused. |
| Content interlock | `db/seeds/*` | Every workflow, template and plan seeds as `draft` / `unverified`. Nothing is purchasable or publishable without an explicit admin action. |
| Renderer interlock | `services/jobs/src/render/pdfForm.ts` | Refuses to fill an AOC form whose template is unverified or whose field map still holds placeholders. |

`COMPLIANCE_REVIEW_COMPLETE` is compared against the exact string `"true"` — `TRUE`,
`1` and `yes` all read as *not reviewed*. That is deliberate and is covered by a test.

Run the outstanding-items report at any time:

```sh
pnpm --filter @justicedesk/db verify-content
```

It exits non-zero while anything is unverified, so it can gate the branch that flips the
env var.

---

## 1. UPL guardrails — for counsel's review

> **These are the ONLY guardrails.** The operator's shared legal gateway, which the v2
> spec described as enforcing a `prose_platform` policy profile, is in fact an
> authenticated proxy: no profiles, no RBAC, no guardrails, only per-app rate limiting.
> Nothing upstream catches unauthorized-practice output, an uncurated citation, or a
> missing disclosure. Every layer below is load-bearing.

Three layers. The deterministic and classifier layers can only **add** restrictions; a
clean classifier verdict cannot clear a response the pattern layer blocked.

| Layer | File | Nature |
|---|---|---|
| 1. System prompt | `services/ai-gateway/src/guardrails/systemPrompts.ts` | Constrains generation. Probabilistic. |
| 2. Pattern scan | `packages/shared/src/upl/guardrails.ts` | Deterministic, always fires, auditable by a non-engineer. |
| 3. Model classifier | `services/ai-gateway/src/guardrails/classifier.ts` | Catches implied advice with no giveaway phrasing. **Fails closed** — if it errors, the response is withheld. |

**What counsel needs to decide:**

1. **Is the line drawn in the right place?** The operative statement is `CORE_BOUNDARY` in
   `systemPrompts.ts` and the `reason` field of each pattern in `guardrails.ts`. These are
   a good-faith engineering draft of a legal distinction.
2. **Are the blocked patterns right?** Sixteen patterns across directive advice, outcome
   prediction, legal conclusions, and claims of authoritative action. Each has a code, a
   reason, and a test asserting it fires.
3. **Are the permitted examples right?** `guardrails.test.ts` asserts that specific
   sentences are *allowed* through. That list is as much a policy statement as the blocks
   are, and is the more dangerous list to get wrong.
4. **Is "options, not recommendations" a sufficient posture?** The whole design rests on
   it.
5. **Is the blocked-response substitute message appropriate?** `UPL_BLOCK_MESSAGE`.
6. **Does the affirmative-defenses checklist in the debt Answer interview itself
   constitute advice?** Presenting a menu of defenses to select from is the closest this
   product comes to the line. See `db/src/seeds/templates.ts`, `nc_debt_answer`.

**Citations.** `packages/shared/src/citations/allowlist.ts` enforces a deny-by-default
allowlist. Case citations are refused outright in Phase 1. Conversational output has bad
citations stripped; **document** output is hard-failed, because a filing with a
hallucinated authority can be struck.

---

## 2. Disclosure language — for counsel's review

| Copy | Location | Status |
|---|---|---|
| Persistent footer | `apps/web/src/components/Disclosure.tsx` → `PERSISTENT_DISCLOSURE` | Draft |
| AI response footer | `packages/shared/src/upl/guardrails.ts` → `DEFAULT_DISCLOSURE_FOOTER` | Draft |
| Document disclosure | `db/src/seeds/templates.ts` → `STANDARD_DISCLOSURE` | Draft |
| Glossary definitions | `apps/web/src/lib/glossary.ts` | Draft — 17 entries |
| Filing instructions | `apps/web/src/app/cases/[caseId]/documents/page.tsx` | Draft |

`DISCLOSURE_COPY_STATUS` is `'draft_pending_counsel'` and a test asserts it, so approved
copy cannot ship while still flagged as draft.

The persistent footer renders in the **root layout**, not per page, so a new screen
cannot ship without it.

---

## 3. Referral fee structure — SUPERSEDED BY v2, NOW LIVE FOR REVIEW

> **This section previously read "Not built — nothing to review."** That was accurate for
> Phase 1 and is no longer true. The v2 spec introduces paid attorney referral (rung 5),
> which makes this the single largest new item in counsel's review. Rewritten accordingly.

### What changed

Phase 1 had no fee-bearing attorney arrangement of any kind. v2 introduces one:
qualified leads are routed to the Ask Michael attorney network and the attorney pays a
**flat per-qualified-lead advertising fee**, admin-set per practice area and county.

### The consequence nobody should miss

The Phase 1 UI **already offers attorney review in two places** — the blocked-response
message (`UPL_BLOCK_MESSAGE`) and the chat screen. Today those are neutral pointers to
legal aid and the NC Bar referral service, with no commercial relationship behind them.

**The moment referral revenue exists, those offers change character.** The same words,
unchanged, stop being a public-service pointer and start being the top of a paid funnel.
Counsel needs to decide whether they then constitute attorney advertising or a referral
solicitation, and whether they require disclosure at the point they are shown — not only
at the point a lead is transmitted.

This is not hypothetical or deferred. Those strings ship today.

### What the build gets right by construction

These are already structural, not aspirational, and counsel should confirm they are the
correct posture:

- **Flat fee, never contingent.** The `fee_schedule` category is `referral_lead` with
  unit `lead`. There is no field anywhere in the schema for case value, recovery, or
  attorney fee — the contingent structure is not merely disallowed, it is unrepresentable.
- **Not-already-represented check** gates billing (v2 non-negotiable #3).
- **TCPA express written consent** captured in-call before any drip, with global one-tap
  opt-out (#4).
- **Recording announced on every call**, one-party state notwithstanding, for multi-state
  posture (#5).

### What counsel must decide

1. Do the two existing attorney-review offers become advertising once referral revenue
   exists, and what disclosure do they then require *at the point of display*?
2. Is the flat-fee-per-lead structure compliant under NC bar advertising rules — and is
   "flat, never contingent on retention or fee amount" sufficient, or is more needed?
3. Is the in-call referral disclosure script adequate, and must it be read, displayed,
   or both?
4. Does routing injury leads to an **incident-intelligence buyer network** (not attorneys)
   carry a different analysis from attorney referral? The spec treats them in one breath;
   they may not be one thing.
5. Is per-county, per-practice-area price variation defensible, or does it create the
   appearance of value-based pricing the flat-fee structure exists to avoid?
6. **Court-records-triggered direct mail to defendants** (v2 §5B): several states
   regulate solicitation of newly-served defendants specifically, including waiting
   periods and required labelling. The spec already routes the letter copy to counsel;
   the trigger feed and mail path must not be built send-capable before that clears.

### Structural tension to settle now

v2 non-negotiable #1 — "no call ends without a revenue event or a captured lead" — and
the UPL guardrails pull against each other. An agent under standing instruction to always
convert has structural pressure to keep answering questions it should decline and hand
off instead.

The guardrails fail closed and will withhold those answers, which will surface as
free-window abandonment in the call-economics dashboard rather than as an error. Someone
optimising that metric later could "fix" it by loosening layer 1. **Decide explicitly that
the guardrail wins, and encode it as a test**, before `svc-voice` exists and the incentive
is live.

---

## 4. Legal content — the substantive backlog

**Every piece of legal content in this repository is `unverified`.** It was written from
the statutory scheme by an engineer, not by a licensed North Carolina attorney, and it
has not been checked against the current General Statutes or the AOC forms.

Highest-risk items, in order:

1. **CRITICAL — eviction appeal vs. stay of execution.** `evictionTenant.ts` encodes the
   10-day notice of appeal and the requirement to pay rent into court as two separate
   things. If that framing is wrong, a tenant who follows it could give notice of appeal
   and still be removed. This is the single most consequential item in the repository.
2. **BLOCKING — AOC form field maps.** Every `fieldMap` value is a `PLACEHOLDER_` string.
   They were not read off the real PDFs, because the blank forms are not in this repo. The
   renderer refuses to run against them.
3. **BLOCKING — courthouse addresses.** `reference.ts` contains `VERIFY BEFORE USE`
   placeholders. A wrong address means a missed hearing.
4. **Deadline periods and their triggers.** Particularly whether appeal periods run from
   *entry* or *service* of judgment.
5. **Court holiday schedule.** `packages/shared/src/deadlines/calendar.ts` derives NC
   holidays from the published pattern rather than transcribing a signed schedule. The
   Christmas block rule is the most likely to be wrong; it is documented in place.
6. **Form identity.** That AOC-CVM-102/103, AOC-CVM-201 and AOC-G-106 are the correct
   current forms, with the titles used here.
7. **Curated citation library.** 30 entries, each with a plain-language summary that must
   be confirmed as accurate and as not stating a legal conclusion.

---

## 5. Open engineering items

- **Audit log tamper-evidence.** `audit_log` is append-only via database triggers plus
  privilege revocation. That stops the application; it does not stop a superuser who can
  drop the trigger. Genuine tamper-evidence needs off-host log shipping.
- **Reminder SMS is off by default.** `SMS_SENDING_ENABLED` must be explicitly `"true"`.
  Staging runs on real case data with real phone numbers.
- **Attorney-review routing** is a UI promise with no backend.
- **Model choice.** The spec names `claude-sonnet-4-6`; it is configurable via
  `ANTHROPIC_MODEL`. `claude-sonnet-5` is the current generation and is materially
  stronger at instruction-following, which is what layers 1 and 3 rest on. Worth
  benchmarking against the guardrail test set before launch.
- **Shared legal gateway is a proxy, not a policy engine.** Contract now confirmed and
  implemented (`services/ai-gateway/src/transport.ts`). It provides centralised credential
  custody, one auditable egress path, and per-app rate limiting — but no policy
  enforcement whatsoever. This is why §1 above is the whole of the UPL defence. An
  engineer who assumes an upstream policy layer exists might reasonably relax the local
  one; nobody should.
- **svc-voice must route through svc-ai-gateway, never directly to the gateway.** v2
  non-negotiable #6 (voice shares the app's guardrail profile, no drift) can only be met
  by topology, since there is no profile to share. A voice agent wired straight to the
  proxy would have zero guardrails. See HUMAN_REVIEW.md G-3.

---

## Sign-off

The gate opens when someone sets `COMPLIANCE_REVIEW_COMPLETE=true`. Before that:

- [ ] Ethics counsel has reviewed §1 (UPL guardrails) and the permitted-examples list
- [ ] Ethics counsel has approved §2 (disclosure copy); `DISCLOSURE_COPY_STATUS` → `'approved'`
- [ ] §3 referral fee structure reviewed — including whether the two attorney-review
      offers already live in the UI become advertising once referral revenue exists
- [ ] A licensed NC attorney has verified every item in §4; `verify-content` exits zero
- [ ] §5 items resolved or accepted in writing
- [ ] Written sign-off filed, naming the reviewer and date

| | Name | Date |
|---|---|---|
| Ethics counsel | | |
| NC legal content reviewer | | |
| Engineering owner | | |
