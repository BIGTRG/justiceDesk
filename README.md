# JusticeDesk

A guided self-help litigation platform for people handling a North Carolina court case
without a lawyer.

Someone describes their problem in plain English. The system works out which procedural
process applies, maps it to a jurisdiction-specific state machine, and gives them a case
portal: a timeline, their real deadlines, guided document preparation, and printable
court-ready filings.

> ### ⚠️ Read [`COMPLIANCE.md`](./COMPLIANCE.md) first
>
> This build is **staging-only**. Public deployment and live payments are gated on ethics
> counsel review. The gate is enforced in code — services refuse to boot in a
> production/live configuration until it clears — and **all legal content is currently
> unverified**.

---

## Phase 1 scope

Litigant side only, North Carolina only, three case types:

| Key | Situation | Court |
|---|---|---|
| `debt_defense` | Defendant in a consumer debt collection suit | District |
| `small_claims` | Either party, ≤ $10,000 | Magistrate |
| `eviction_tenant` | Tenant defending summary ejectment | Magistrate |

Everything is data-driven. A new case type or county is a workflow definition plus a
template — no code change.

---

## Layout

```
apps/web              Next.js 14 — S1–S11, S15, admin console
services/api          svc-api      :4101  the only public service
services/ai-gateway   svc-ai-gateway :4102  internal; wraps Anthropic + UPL guardrails
services/jobs         svc-jobs           BullMQ workers: reminders, rendering
packages/shared       state machine, deadline calculator, UPL patterns, citation allowlist
packages/service-kit  logging, metrics, HTTP plumbing, the compliance interlock
db                    migrations, NC seed content, migration/seed runners
```

`packages/shared` holds everything a litigant actually depends on and is pure — no I/O,
no clock reads. That is why it carries the heaviest test coverage.

---

## Running it

### Prerequisites

Node 20+, pnpm 9+, Docker (for local Postgres/Redis/MinIO).

### Secrets

**Nothing secret lives in this repo.** Secrets are read at boot from
`/opt/credential-vault/<name>` — one file per secret. See
`packages/shared/src/config/vault.ts`.

For local development the loader falls back to environment variables (uppercased key
name). That fallback is **refused** when `NODE_ENV` is `production` or `staging`.

Secrets used: `postgres_password`, `redis_password`, `minio_access_key`,
`minio_secret_key`, `clerk_secret_key`, `anthropic_api_key`,
`ai_gateway_service_token`, `stripe_secret_key`, `stripe_webhook_secret`,
`twilio_account_sid`, `twilio_auth_token`.

### First run

```sh
cp .env.example .env
pnpm install
pnpm infra:up                                  # postgres, redis, minio

pnpm --filter @justicedesk/shared build
pnpm --filter @justicedesk/service-kit build
pnpm --filter @justicedesk/db build

POSTGRES_PASSWORD=justicedesk_local_dev pnpm --filter @justicedesk/db migrate
POSTGRES_PASSWORD=justicedesk_local_dev pnpm --filter @justicedesk/db seed

pnpm dev                                       # all services in watch mode
```

Then open http://localhost:3000.

Seeded content is `draft` and unverified, so **no case type is purchasable or openable
until an admin publishes a workflow** from the admin console. That is the compliance gate
working as intended, not a bug.

### Tests

```sh
pnpm test                                      # every package
pnpm --filter @justicedesk/shared test:coverage
pnpm test:e2e                                  # Playwright
pnpm --filter @justicedesk/db verify-content   # outstanding legal review items
```

`packages/shared` enforces coverage thresholds on `src/deadlines/` and `src/workflow/` —
the spec calls date math "the product", and the bar is there to keep it that way.

### Deploying to staging

```sh
pnpm build
pm2 start ecosystem.config.js --env staging
```

There is no production env block in the PM2 file, on purpose.

---

## How it works

### The deadline calculator

`packages/shared/src/deadlines/`. Pure functions: `(rule, case facts, calendar) → due
date + an explanation trace`.

Dates are ISO `YYYY-MM-DD` strings, and all arithmetic goes through UTC. A filing due
October 3 is due October 3 in the courthouse's county regardless of where the litigant's
phone thinks it is; representing these as `Date` invites an off-by-one every time a value
crosses a timezone or a DST boundary, and an off-by-one here defaults a case.

Order of operations: count the base period → apply the service-of-process extension → roll
off closed days.

It **refuses to guess**. If the case does not yet have the date a rule counts from, it
throws `MissingAnchorError` and the UI says what it still needs.

Every result carries the steps it took, its statutory source, and warnings. The UI shows
the working under a "How we worked out this date" disclosure, so a litigant can check it.

### The state machine

`packages/shared/src/workflow/`. A workflow definition is JSON: ordered stages with a
title, a plain-language explainer, an optional deadline rule, required documents, a court
fee, and the stages reachable next.

A case **pins the definition version it opened on** and rides it to close. Publishing a new
version affects new cases only — enforced by a database trigger, not by convention.

The validator runs in the admin editor, the seed script and CI. Errors block publication;
warnings do not, and every unverified citation raises one, so the warning count is the
compliance backlog.

### The UPL guardrails

Three layers — see [`COMPLIANCE.md`](./COMPLIANCE.md) §1. The property that matters:
**there is no raw model passthrough**. Routes never see the model's text, only a
`GuardrailResult`, so a new endpoint cannot accidentally bypass the guardrails.

Blocked text is never returned to the caller. It survives only in the flag row for the
review queue.

### The document vault

Documents live in MinIO and leave only through a short-lived signed URL. The audit write
happens **before** the URL is minted and gates it — a failed audit write means no
download. `audit_log` is append-only at the database level.

### Model selection

The spec names `claude-sonnet-4-6`; it is configurable via `ANTHROPIC_MODEL`. The gateway
uses adaptive thinking, forced tool calls for anything structured (validated on our side,
not trusted), and prompt caching on the per-case grounding block.

---

## Design decisions worth knowing

**Legal content is data, and it is all marked unverified.** Every deadline rule carries a
citation, a plain-language summary, a verification status, and open questions for the
reviewing attorney. Where the answer was genuinely unclear the stage is flagged rather
than guessed — per the spec's instruction to flag uncertainty rather than guess.

**The renderer refuses to fill an unverified form.** A court form that looks official and
has the wrong values in its boxes is worse than no form: a self-represented litigant will
file it, and neither they nor the clerk will catch it.

**Reminders never send twice and never send late-and-silent.** If the worker was down over
a weekend, the next pass still sends the notice it missed — but only the most urgent one,
because three texts in one minute reads as a malfunction.

**SMS says as little as possible.** No party names, no amounts, no case type. A text
saying "your eviction hearing" on a shared phone can out someone.

**Logs carry IDs, not people.** The logger drops known personal fields even when a caller
spreads a whole object into it, and redacts secret-shaped strings.

**Price changes reach new signups only.** A live plan's price is frozen by a database
trigger; changing a price publishes a new plan row and supersedes the old one.

---

## Runbook

| Task | Command |
|---|---|
| Apply migrations | `pnpm --filter @justicedesk/db migrate` |
| Seed / re-seed content | `pnpm --filter @justicedesk/db seed` |
| Outstanding legal review items | `pnpm --filter @justicedesk/db verify-content` |
| Start staging | `pm2 start ecosystem.config.js --env staging` |
| Health | `GET :4101/healthz`, `:4102/healthz`, `:4103/healthz` |
| Readiness (checks DB) | `GET :4101/readyz` |
| Metrics | `GET :4101/metrics`, `:4102/metrics`, `:4103/metrics` |

Migrations are checksummed. Editing an applied migration is a hard error — add a new one.

Useful metrics: `justicedesk_ai_guardrail_outcomes_total`,
`justicedesk_upl_flags_total`, `justicedesk_citation_violations_total`,
`justicedesk_document_access_total`, `justicedesk_reminders_sent_total`.

---

## Licence

Proprietary — TRG TechLink. Not for distribution.
