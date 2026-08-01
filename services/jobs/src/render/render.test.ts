/**
 * Renderer safety tests. No Chromium and no real PDFs needed — these cover the two
 * failure modes that would put a wrong document in a courthouse.
 */

import { buildDocumentHtml, escapeHtml } from './htmlPdf.js'
import { fillabilityProblems, type FillableTemplate } from './pdfForm.js'

const verified = { status: 'attorney_verified' }

function template(over: Partial<FillableTemplate> = {}): FillableTemplate {
  return {
    key: 'nc_small_claims_complaint_aoc_cvm_102',
    fieldMap: { full_name: 'PlaintiffName', amount_claimed: 'AmountClaimed' },
    verification: verified,
    ...over,
  }
}

describe('fillabilityProblems — refusing to fill a form we are not sure about', () => {
  it('accepts a verified template whose fields all exist in the PDF', () => {
    expect(fillabilityProblems(template(), ['PlaintiffName', 'AmountClaimed'])).toEqual([])
  })

  it('refuses while any field name is still a seed placeholder', () => {
    const problems = fillabilityProblems(
      template({ fieldMap: { full_name: 'PLACEHOLDER_plaintiff_name' } }),
      ['PLACEHOLDER_plaintiff_name']
    )
    expect(problems.join(' ')).toMatch(/placeholders from the seed data/)
  })

  it('refuses while the template is not attorney-verified', () => {
    const problems = fillabilityProblems(
      template({ verification: { status: 'unverified' } }),
      ['PlaintiffName', 'AmountClaimed']
    )
    expect(problems.join(' ')).toMatch(/not been attorney-verified/)
  })

  it('refuses when a mapped field does not exist in the PDF', () => {
    // pdf-lib would otherwise leave the box blank and produce a form that looks complete.
    const problems = fillabilityProblems(template(), ['PlaintiffName'])
    expect(problems.join(' ')).toMatch(/no field named "AmountClaimed"/)
  })

  it('names the fields the PDF does have, so the mapping can be fixed', () => {
    const problems = fillabilityProblems(template(), ['Party1', 'Party2'])
    expect(problems.join(' ')).toMatch(/Available fields: Party1, Party2/)
  })

  it('refuses an empty field map rather than emitting a blank form', () => {
    expect(fillabilityProblems(template({ fieldMap: {} }), ['A']).join(' ')).toMatch(/field map is empty/)
  })

  it('reports every problem at once', () => {
    const problems = fillabilityProblems(
      template({ fieldMap: { a: 'PLACEHOLDER_x', b: 'Missing' }, verification: { status: 'unverified' } }),
      ['Other']
    )
    expect(problems.length).toBeGreaterThanOrEqual(3)
  })
})

describe('escapeHtml', () => {
  it('neutralises markup in model or litigant text', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;'
    )
  })

  it('escapes quotes and ampersands', () => {
    expect(escapeHtml(`Smith & "Jones" 'Co'`)).toBe('Smith &amp; &quot;Jones&quot; &#39;Co&#39;')
  })
})

describe('buildDocumentHtml', () => {
  const request = {
    title: 'Answer to Complaint',
    caption: {
      court: 'District Court Division',
      county: 'Wake',
      state: 'North Carolina',
      caseNumber: '26 CVD 001234',
      plaintiff: 'Acme Recovery LLC',
      defendant: 'Jane Doe',
    },
    sections: [{ heading: 'Response', body: 'I deny paragraph 4.\n\nI deny paragraph 5.' }],
    disclosureText: 'JusticeDesk is not a law firm and did not give you legal advice.',
    signerName: 'Jane Doe',
    watermark: true,
  }

  it('renders the caption, title and body', () => {
    const html = buildDocumentHtml(request)
    expect(html).toContain('Answer to Complaint')
    expect(html).toContain('26 CVD 001234')
    expect(html).toContain('Acme Recovery LLC')
    expect(html).toContain('I deny paragraph 4.')
  })

  it('splits blank-line-separated text into paragraphs', () => {
    expect(buildDocumentHtml(request).match(/<p>I deny paragraph/g)).toHaveLength(2)
  })

  it('always renders the disclosure', () => {
    expect(buildDocumentHtml(request)).toContain('not a law firm')
  })

  it('stamps the draft watermark when asked', () => {
    expect(buildDocumentHtml(request)).toContain('DRAFT — NOT FILED')
    expect(buildDocumentHtml({ ...request, watermark: false })).not.toContain('DRAFT — NOT FILED')
  })

  it('leaves a blank for the case number when there is not one yet', () => {
    const html = buildDocumentHtml({ ...request, caption: { ...request.caption, caseNumber: null } })
    expect(html).toContain('File No. ______________')
  })

  it('escapes body text rather than treating it as markup', () => {
    // Body prose comes from the model. It is data.
    const html = buildDocumentHtml({
      ...request,
      sections: [{ body: '<img src=x onerror="alert(1)">' }],
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  it('escapes party names in the caption', () => {
    const html = buildDocumentHtml({
      ...request,
      caption: { ...request.caption, plaintiff: '<b>Acme</b>' },
    })
    expect(html).toContain('&lt;b&gt;Acme&lt;/b&gt;')
  })

  it('renders a signature line for the litigant to sign themselves', () => {
    const html = buildDocumentHtml(request)
    expect(html).toContain('class="line"')
    expect(html).toContain('appearing without a lawyer')
  })
})
