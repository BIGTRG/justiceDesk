/**
 * Freeform document rendering: HTML → PDF via headless Chromium.
 *
 * Used for AI-drafted documents that have no official AOC form (the debt Answer, notices
 * of appeal). The HTML is built here rather than by the model — the model supplies body
 * prose only, and everything structural (caption, disclosure, signature block) is ours.
 */

import { chromium, type Browser } from 'playwright'

export interface DocumentSection {
  heading?: string
  /** Plain text. Escaped before it reaches the page — never trusted as markup. */
  body: string
}

export interface RenderRequest {
  title: string
  caption: {
    court: string
    county: string
    state: string
    caseNumber: string | null
    plaintiff: string
    defendant: string
  }
  sections: DocumentSection[]
  /** The template's disclosure. Always rendered — it is not optional. */
  disclosureText: string
  signerName: string
  watermark: boolean
}

/** Escape for HTML text context. Model output is data, never markup. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function buildDocumentHtml(req: RenderRequest): string {
  const sections = req.sections
    .map(
      (s) =>
        (s.heading ? `<h2>${escapeHtml(s.heading)}</h2>` : '') +
        s.body
          .split(/\n{2,}/)
          .filter((p) => p.trim())
          .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
          .join('')
    )
    .join('')

  const caseNumberRow = req.caption.caseNumber
    ? `<div class="case-no">File No. ${escapeHtml(req.caption.caseNumber)}</div>`
    : `<div class="case-no">File No. ______________</div>`

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(req.title)}</title>
<style>
  @page { size: Letter; margin: 1in; }
  body { font-family: "Times New Roman", Times, serif; font-size: 12pt; line-height: 1.9; color: #000; }
  .caption { border-bottom: 1.5px solid #000; padding-bottom: 12pt; margin-bottom: 18pt; }
  .court { text-align: center; font-weight: bold; text-transform: uppercase; letter-spacing: .04em; }
  .case-no { text-align: right; margin-top: 6pt; }
  .parties { margin-top: 12pt; }
  .parties .v { margin: 4pt 0 4pt 40pt; font-style: italic; }
  h1 { font-size: 13pt; text-align: center; text-transform: uppercase; margin: 24pt 0 18pt; letter-spacing: .05em; }
  h2 { font-size: 12pt; margin: 18pt 0 6pt; }
  p { margin: 0 0 10pt; text-align: left; }
  .signature { margin-top: 42pt; }
  .signature .line { border-bottom: 1px solid #000; width: 60%; margin-bottom: 4pt; height: 28pt; }
  .disclosure { margin-top: 36pt; padding-top: 10pt; border-top: 1px solid #999;
                font-size: 8.5pt; line-height: 1.45; color: #333; font-family: Arial, Helvetica, sans-serif; }
  .watermark { position: fixed; top: 42%; left: 8%; font-size: 68pt; font-weight: bold;
               color: rgba(200,20,20,.14); transform: rotate(-28deg); font-family: Arial, sans-serif;
               letter-spacing: .06em; pointer-events: none; }
</style></head>
<body>
${req.watermark ? '<div class="watermark">DRAFT — NOT FILED</div>' : ''}
<div class="caption">
  <div class="court">State of ${escapeHtml(req.caption.state)}<br>${escapeHtml(req.caption.county)} County<br>${escapeHtml(req.caption.court)}</div>
  ${caseNumberRow}
  <div class="parties">
    <div>${escapeHtml(req.caption.plaintiff)},</div>
    <div style="margin-left:40pt">Plaintiff,</div>
    <div class="v">v.</div>
    <div>${escapeHtml(req.caption.defendant)},</div>
    <div style="margin-left:40pt">Defendant.</div>
  </div>
</div>
<h1>${escapeHtml(req.title)}</h1>
${sections}
<div class="signature">
  <div class="line"></div>
  <div>${escapeHtml(req.signerName)}</div>
  <div>Defendant, appearing without a lawyer</div>
  <div style="margin-top:10pt">Date: ______________________</div>
</div>
<div class="disclosure">${escapeHtml(req.disclosureText)}</div>
</body></html>`
}

let browser: Browser | null = null

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    // Reused across jobs: launching Chromium per document is seconds of latency and
    // hundreds of megabytes each time.
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }
  return browser
}

export async function renderHtmlToPdf(req: RenderRequest): Promise<Buffer> {
  const page = await (await getBrowser()).newPage()
  try {
    await page.setContent(buildDocumentHtml(req), { waitUntil: 'load' })
    return await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '1in', bottom: '1in', left: '1in', right: '1in' },
    })
  } finally {
    await page.close()
  }
}

export async function closeBrowser(): Promise<void> {
  await browser?.close()
  browser = null
}
