/**
 * Compliance smoke tests.
 *
 * These assert the properties that must hold on every screen a litigant can reach,
 * regardless of auth state. They need only the web app running — no database, no API —
 * so they can run on every commit.
 */

import { expect, test } from '@playwright/test'

const PUBLIC_ROUTES = ['/', '/intake', '/sign-in']

test.describe('the disclosure is inescapable', () => {
  for (const route of PUBLIC_ROUTES) {
    test(`${route} shows the persistent disclosure`, async ({ page }) => {
      await page.goto(route)
      // Rendered in the root layout, so no screen can ship without it.
      await expect(
        page.getByText('This platform is not a law firm and does not provide legal advice.').first()
      ).toBeVisible()
    })
  }

  test('the landing page states it up front, not only in the footer', async ({ page }) => {
    await page.goto('/')
    const strip = page.getByText(/not a law firm/i).first()
    await expect(strip).toBeVisible()
  })

  test('the footer points people to a real lawyer', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText(/talk to a licensed attorney/i)).toBeVisible()
  })
})

test.describe('accessibility basics', () => {
  test('there is a skip link for keyboard users', async ({ page }) => {
    await page.goto('/')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
  })

  test('the page has one h1', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('h1')).toHaveCount(1)
  })

  test('zoom is not disabled', async ({ page }) => {
    await page.goto('/')
    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content')
    // Pinch-to-zoom is an accessibility requirement for this audience.
    expect(viewport).not.toContain('user-scalable=no')
    expect(viewport).not.toMatch(/maximum-scale=1\b/)
  })

  test('tap targets on the landing page are large enough', async ({ page }) => {
    await page.goto('/')
    const button = page.getByRole('button', { name: /Someone is suing me over a debt/i })
    const box = await button.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
  })
})

test.describe('the landing page leads with what to do', () => {
  test('offers the three Phase 1 case types', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: /suing me over a debt/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Small claims/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /evict me/i })).toBeVisible()
  })

  test('tells someone with an imminent court date to go to it', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText(/Go to your hearing/i)).toBeVisible()
  })

  test('the free-text box carries into intake', async ({ page }) => {
    await page.goto('/')
    await page.getByLabel('What is going on?').fill('A company is suing me over an old credit card')
    await page.getByRole('button', { name: 'Get started' }).click()
    await expect(page).toHaveURL(/\/intake\?q=/)
    await expect(page.getByText('A company is suing me over an old credit card')).toBeVisible()
  })
})

test.describe('nothing is indexable', () => {
  test('robots headers are set', async ({ page }) => {
    const response = await page.goto('/')
    // A case portal in a search index is a disclosure incident.
    expect(response?.headers()['x-robots-tag']).toContain('noindex')
  })

  test('clickjacking and sniffing protections are on', async ({ page }) => {
    const response = await page.goto('/')
    expect(response?.headers()['x-frame-options']).toBe('DENY')
    expect(response?.headers()['x-content-type-options']).toBe('nosniff')
  })
})
