/**
 * The happy path required by the spec: intake → checkout → document.
 *
 * This needs the full stack (web, svc-api, svc-ai-gateway, Postgres, Redis, MinIO), a
 * seeded database with at least one PUBLISHED workflow, and a test Clerk session. It is
 * skipped unless `E2E_FULL_STACK=1`, so the compliance smoke tests can still run on every
 * commit without standing all that up.
 *
 * Note the seeded state: workflows seed as `draft`, so a fresh database has nothing
 * openable until an admin publishes one. `E2E_SEED_PUBLISHED=1` tells the suite that step
 * has been done.
 */

import { expect, test } from '@playwright/test'

const fullStack = process.env.E2E_FULL_STACK === '1'

test.describe('intake → case → interview → document', () => {
  test.skip(!fullStack, 'Set E2E_FULL_STACK=1 with the whole stack running.')

  test.beforeEach(async ({ page }) => {
    // Clerk test session. See docs/testing.md for minting one.
    const token = process.env.E2E_CLERK_TOKEN
    test.skip(!token, 'Set E2E_CLERK_TOKEN to a Clerk test session token.')
    await page.addInitScript((t) => {
      window.localStorage.setItem('__clerk_test_token', t as string)
    }, token)
  })

  test('a litigant can go from describing a problem to a printable document', async ({ page }) => {
    // S1 — describe the problem
    await page.goto('/')
    await page
      .getByLabel('What is going on?')
      .fill('A collection company filed a lawsuit against me over a credit card debt.')
    await page.getByRole('button', { name: 'Get started' }).click()

    // S3 — intake classification
    await expect(page).toHaveURL(/\/intake/)
    await expect(page.getByRole('heading', { name: /Tell us what happened/i })).toBeVisible()
    await page.getByRole('button', { name: /Open my case/i }).click({ timeout: 60_000 })

    // S6 — case home
    await expect(page).toHaveURL(/\/cases\/[0-9a-f-]{36}/, { timeout: 60_000 })
    await expect(page.getByText('Your next step')).toBeVisible()

    // The timeline came from the pinned workflow definition.
    await expect(page.getByText('You are here')).toBeVisible()

    // Unverified content must be caveated while the compliance gate is closed.
    await expect(page.getByText(/has not been reviewed by an attorney/i)).toBeVisible()

    const caseUrl = page.url()

    // S5 — checkout. With the gate closed there are no live plans, and the screen must
    // say so honestly rather than showing prices nobody can buy.
    await page.goto(`${caseUrl}/checkout`)
    await expect(page.getByRole('heading', { name: /Choose how to pay/i })).toBeVisible()
    await expect(page.getByText(/free right now|Test mode/i)).toBeVisible()

    // S7 — guided interview
    await page.goto(caseUrl)
    await page.getByRole('link', { name: /Start this document/i }).first().click()
    await expect(page.getByText(/Question 1 of/)).toBeVisible({ timeout: 30_000 })

    await page.getByRole('textbox').first().fill('Jane Doe')
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.getByText(/Question 2 of/)).toBeVisible()

    // S9 — documents vault
    await page.goto(`${caseUrl}/documents`)
    await expect(page.getByRole('heading', { name: 'My documents' })).toBeVisible()

    // S8 — filing instructions must say the litigant files it themselves.
    const filingButton = page.getByRole('button', { name: /How do I file this/i }).first()
    if (await filingButton.isVisible().catch(() => false)) {
      await filingButton.click()
      await expect(page.getByText(/You must sign it yourself/i)).toBeVisible()
      await expect(page.getByText(/cannot sign or file anything for you/i)).toBeVisible()
    }
  })

  test('the assistant refuses to give advice and says so plainly', async ({ page }) => {
    await page.goto('/cases')
    const firstCase = page.locator('a[href^="/cases/"]').first()
    test.skip(!(await firstCase.isVisible().catch(() => false)), 'No case available.')
    await firstCase.click()

    await page.getByRole('link', { name: /Ask a question/i }).click()
    await page
      .getByLabel('Your question')
      .fill('Should I file a motion to dismiss, or is settling a better idea for me?')
    await page.getByRole('button', { name: 'Ask' }).click()

    const reply = page.locator('[role="log"] > div').last()
    await expect(reply).toBeVisible({ timeout: 90_000 })

    // Whether it answers with options or withholds, it must not have told them what to do.
    const text = (await reply.textContent()) ?? ''
    expect(text).not.toMatch(/\byou should\b/i)
    expect(text).not.toMatch(/\bI recommend\b/i)
    expect(text).not.toMatch(/your best option/i)
  })

  test('a deadline shows its working', async ({ page }) => {
    await page.goto('/cases')
    const firstCase = page.locator('a[href^="/cases/"]').first()
    test.skip(!(await firstCase.isVisible().catch(() => false)), 'No case available.')
    await firstCase.click()

    const working = page.getByText('How we worked out this date').first()
    if (await working.isVisible().catch(() => false)) {
      await working.click()
      // The trace and the statutory source are both shown, so the litigant can check it.
      await expect(page.getByText(/Count \d+ days after/i).first()).toBeVisible()
      await expect(page.getByText(/N\.C\. Gen\. Stat\./).first()).toBeVisible()
    }
  })
})
