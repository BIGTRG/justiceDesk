/**
 * Document templates and their guided interviews.
 *
 * Two kinds:
 *   * `aoc_form` — the official blank AOC PDF is stored in MinIO and filled with pdf-lib
 *     using `fieldMap`. Field names must match the AcroForm field names in the real PDF.
 *   * `ai_freeform` — drafted from interview answers and rendered HTML → PDF.
 *
 * ⚠️ EVERY TEMPLATE IS UNVERIFIED.
 *
 * Two distinct verification problems, both blocking:
 *   1. Form identity — that AOC-CVM-102 etc. are the correct current forms for these
 *      case types, with the titles used here.
 *   2. Field maps — `fieldMap` values are PLACEHOLDERS. They were not read off the real
 *      PDFs, because the blank AOC forms are not in this repo. Filling a court form with
 *      a guessed field map produces a document that looks right and is wrong. The PDF
 *      renderer refuses to run against an unverified field map; see
 *      services/jobs/src/render/pdfForm.ts.
 */

import type { InterviewSchema } from '@justicedesk/shared'

export interface TemplateSeed {
  key: string
  caseTypeKey: string
  jurisdictionKey: string
  name: string
  source: 'aoc_form' | 'ai_freeform'
  formPdfMinioKey: string | null
  fieldMap: Record<string, string>
  interviewSchema: InterviewSchema
  disclosureText: string
  verification: { status: 'unverified' | 'attorney_verified'; openQuestions: string[] }
}

const STANDARD_DISCLOSURE =
  'JusticeDesk prepared this document from the answers you gave. JusticeDesk is not a law firm and did not give you legal advice. ' +
  'Read it carefully before you sign it — you are responsible for what it says. You must sign and file it yourself. ' +
  'A licensed attorney can review it for you before you file.'

/** Questions common to every document: who you are and how the court reaches you. */
const identityQuestions: InterviewSchema['questions'] = [
  {
    key: 'full_name',
    type: 'short_text',
    prompt: 'What is your full name?',
    helpText: 'Use the same name that appears on the court papers, if you can.',
    required: true,
    validation: { minLength: 2, maxLength: 120 },
  },
  {
    key: 'mailing_address',
    type: 'long_text',
    prompt: 'What address should the court use to reach you?',
    helpText: 'The court mails notices here. If you move, tell the Clerk of Court in writing.',
    required: true,
  },
  {
    key: 'phone',
    type: 'short_text',
    prompt: 'What phone number should the court use?',
    required: false,
  },
  {
    key: 'court_case_number',
    type: 'short_text',
    prompt: 'What is the case number on your papers?',
    helpText: 'Look at the top right of the first page. It often looks like 26 CVD 001234.',
    required: false,
    glossaryTerms: ['case number'],
  },
]

export const TEMPLATES: TemplateSeed[] = [
  // ---------------------------------------------------------------- debt defense
  {
    key: 'nc_debt_answer',
    caseTypeKey: 'debt_defense',
    jurisdictionKey: 'NC-WAKE-DISTRICT',
    name: 'Answer to Complaint (debt collection)',
    source: 'ai_freeform',
    formPdfMinioKey: null,
    fieldMap: {},
    disclosureText: STANDARD_DISCLOSURE,
    verification: {
      status: 'unverified',
      openQuestions: [
        'Confirm the affirmative defenses offered below are the correct Phase 1 set for NC consumer debt defense, and that presenting them as a checklist does not itself constitute legal advice.',
        'Confirm the required caption, formatting and certificate of service for a District Court answer in Wake County.',
        'Confirm that a paragraph-by-paragraph admit/deny structure is what the court expects from a pro se defendant.',
      ],
    },
    interviewSchema: {
      version: 1,
      questions: [
        ...identityQuestions,
        {
          key: 'plaintiff_name',
          type: 'short_text',
          prompt: 'Who is suing you?',
          helpText: 'The name at the top of the Complaint. It may be a company you have never heard of.',
          required: true,
        },
        {
          key: 'amount_claimed',
          type: 'money',
          prompt: 'How much do they say you owe?',
          required: false,
        },
        {
          key: 'recognize_debt',
          type: 'single_select',
          prompt: 'Do you recognize this debt?',
          required: true,
          options: [
            { value: 'yes', label: 'Yes, I recognize it' },
            { value: 'partly', label: 'Partly — some of it looks wrong' },
            { value: 'no', label: 'No, I do not recognize it at all' },
            { value: 'unsure', label: 'I am not sure' },
          ],
        },
        {
          key: 'defense_not_mine',
          type: 'yes_no',
          prompt: 'Do you believe this debt is not yours — for example, mistaken identity or identity theft?',
          required: true,
          glossaryTerms: ['identity theft'],
        },
        {
          key: 'defense_already_paid',
          type: 'yes_no',
          prompt: 'Have you already paid this debt, in full or in part?',
          required: true,
        },
        {
          key: 'defense_wrong_amount',
          type: 'yes_no',
          prompt: 'Do you think the amount they are asking for is wrong?',
          required: true,
        },
        {
          key: 'defense_too_old',
          type: 'yes_no',
          prompt: 'Was your last payment or activity on this account more than three years ago?',
          helpText:
            'North Carolina has time limits on how long someone has to sue over a debt. Whether a limit applies depends on the facts. An attorney can review this with you.',
          required: true,
          glossaryTerms: ['statute of limitations'],
        },
        {
          key: 'defense_wrong_company',
          type: 'yes_no',
          prompt: 'Is the company suing you different from the one you originally owed?',
          helpText:
            'Debts are often sold. A company that buys a debt generally has to show the court that it owns it.',
          required: true,
          glossaryTerms: ['standing', 'chain of title'],
        },
        {
          key: 'additional_facts',
          type: 'long_text',
          prompt: 'Is there anything else the court should know about this debt?',
          helpText: 'Write it in your own words. Stick to facts you can back up.',
          required: false,
        },
      ],
    },
  },

  // ---------------------------------------------------------------- small claims
  {
    key: 'nc_small_claims_complaint_aoc_cvm_102',
    caseTypeKey: 'small_claims',
    jurisdictionKey: 'NC-WAKE-MAGISTRATE',
    name: 'AOC-CVM-102 (small claims) — title pending verification',
    source: 'aoc_form',
    formPdfMinioKey: 'templates/nc/aoc-cvm-102.pdf',
    // PLACEHOLDER field names. Not read from the real PDF. See file header.
    fieldMap: {
      full_name: 'PLACEHOLDER_plaintiff_name',
      mailing_address: 'PLACEHOLDER_plaintiff_address',
      defendant_name: 'PLACEHOLDER_defendant_name',
      defendant_address: 'PLACEHOLDER_defendant_address',
      amount_claimed: 'PLACEHOLDER_amount',
      claim_description: 'PLACEHOLDER_claim_basis',
      court_case_number: 'PLACEHOLDER_case_number',
    },
    disclosureText: STANDARD_DISCLOSURE,
    verification: {
      status: 'unverified',
      openQuestions: [
        'BLOCKING: obtain the official blank AOC-CVM-102 PDF and replace every PLACEHOLDER_ field name with the real AcroForm field name.',
        'Confirm AOC-CVM-102 is the correct current form for a Wake County small claims complaint, and record its exact title and revision date.',
        'Confirm which party this form is for — the workflow currently offers it to the plaintiff only.',
      ],
    },
    interviewSchema: {
      version: 1,
      questions: [
        ...identityQuestions,
        {
          key: 'defendant_name',
          type: 'short_text',
          prompt: 'Who are you suing?',
          helpText: 'Use their full legal name. For a business, use the registered business name.',
          required: true,
        },
        {
          key: 'defendant_address',
          type: 'long_text',
          prompt: 'What is their address?',
          helpText: 'The court needs this to deliver the papers.',
          required: true,
        },
        {
          key: 'amount_claimed',
          type: 'money',
          prompt: 'How much money are you asking for?',
          helpText: 'Small claims court can handle up to $10,000.',
          required: true,
          validation: { min: 1, max: 1000000 },
        },
        {
          key: 'claim_description',
          type: 'long_text',
          prompt: 'In your own words, what happened?',
          helpText: 'Keep it short and stick to the facts. Dates and amounts help.',
          required: true,
          validation: { minLength: 20, maxLength: 2000 },
        },
      ],
    },
  },
  {
    key: 'nc_small_claims_response_aoc_cvm_103',
    caseTypeKey: 'small_claims',
    jurisdictionKey: 'NC-WAKE-MAGISTRATE',
    name: 'AOC-CVM-103 (small claims) — title pending verification',
    source: 'aoc_form',
    formPdfMinioKey: 'templates/nc/aoc-cvm-103.pdf',
    fieldMap: {
      full_name: 'PLACEHOLDER_party_name',
      court_case_number: 'PLACEHOLDER_case_number',
      response_text: 'PLACEHOLDER_response',
    },
    disclosureText: STANDARD_DISCLOSURE,
    verification: {
      status: 'unverified',
      openQuestions: [
        'BLOCKING: obtain the official blank AOC-CVM-103 PDF and replace every PLACEHOLDER_ field name.',
        'Confirm AOC-CVM-103 is the correct form for a small claims written response and record its exact title.',
        'Confirm that filing a written response has no effect on any deadline, as the workflow currently tells the litigant.',
      ],
    },
    interviewSchema: {
      version: 1,
      questions: [
        ...identityQuestions,
        {
          key: 'response_text',
          type: 'long_text',
          prompt: 'What do you want the magistrate to know?',
          helpText: 'Your side of the story, in your own words.',
          required: true,
          validation: { minLength: 20, maxLength: 2000 },
        },
      ],
    },
  },
  {
    key: 'nc_notice_of_appeal_small_claims',
    caseTypeKey: 'small_claims',
    jurisdictionKey: 'NC-WAKE-MAGISTRATE',
    name: 'Notice of appeal from magistrate judgment',
    source: 'ai_freeform',
    formPdfMinioKey: null,
    fieldMap: {},
    disclosureText: STANDARD_DISCLOSURE,
    verification: {
      status: 'unverified',
      openQuestions: [
        'Confirm whether NC provides an official AOC form for notice of appeal from a magistrate judgment. If so, this should be an aoc_form template, not freeform.',
        'Confirm what the notice must contain and any fee or bond a pro se appellant must post.',
      ],
    },
    interviewSchema: {
      version: 1,
      questions: [
        ...identityQuestions,
        {
          key: 'judgment_date',
          type: 'date',
          prompt: 'What date did the magistrate make the decision?',
          required: true,
        },
      ],
    },
  },

  // ---------------------------------------------------------------- eviction
  {
    key: 'nc_ejectment_answer',
    caseTypeKey: 'eviction_tenant',
    jurisdictionKey: 'NC-WAKE-MAGISTRATE',
    name: 'Answer in summary ejectment',
    source: 'ai_freeform',
    formPdfMinioKey: null,
    fieldMap: {},
    disclosureText: STANDARD_DISCLOSURE,
    verification: {
      status: 'unverified',
      openQuestions: [
        'Confirm whether an official AOC answer form exists for summary ejectment; if so this should be an aoc_form template.',
        'Confirm which defenses must be raised in writing versus at the hearing, and whether any are waived if not raised.',
        'Confirm that describing a written answer as optional is correct.',
      ],
    },
    interviewSchema: {
      version: 1,
      questions: [
        ...identityQuestions,
        {
          key: 'landlord_name',
          type: 'short_text',
          prompt: 'What is your landlord’s name, as it appears on the papers?',
          required: true,
        },
        {
          key: 'property_address',
          type: 'long_text',
          prompt: 'What is the address of the place you rent?',
          required: true,
        },
        {
          key: 'reason_given',
          type: 'single_select',
          prompt: 'What reason did the landlord give for the eviction?',
          required: true,
          options: [
            { value: 'nonpayment', label: 'Not paying rent' },
            { value: 'lease_violation', label: 'Breaking a rule in the lease' },
            { value: 'holdover', label: 'Staying after the lease ended' },
            { value: 'other', label: 'Something else' },
            { value: 'unsure', label: 'I am not sure' },
          ],
        },
        {
          key: 'rent_paid',
          type: 'yes_no',
          prompt: 'Have you paid the rent your landlord says you did not pay?',
          required: true,
          showIf: { questionKey: 'reason_given', equals: 'nonpayment' },
        },
        {
          key: 'rent_proof',
          type: 'long_text',
          prompt: 'What proof of payment do you have?',
          helpText: 'Receipts, bank records, money order stubs, cashed checks, text messages.',
          required: false,
          showIf: { questionKey: 'rent_paid', equals: true },
        },
        {
          key: 'condition_problems',
          type: 'yes_no',
          prompt: 'Are there serious repair or safety problems where you live?',
          helpText:
            'A landlord in North Carolina has a duty to keep the place fit and safe. Whether that affects this case depends on the facts.',
          required: true,
          glossaryTerms: ['implied warranty of habitability'],
        },
        {
          key: 'condition_details',
          type: 'long_text',
          prompt: 'What are the problems, and when did you tell your landlord about them?',
          required: false,
          showIf: { questionKey: 'condition_problems', equals: true },
        },
        {
          key: 'additional_facts',
          type: 'long_text',
          prompt: 'Is there anything else the magistrate should know?',
          required: false,
        },
      ],
    },
  },
  {
    key: 'nc_ejectment_notice_of_appeal',
    caseTypeKey: 'eviction_tenant',
    jurisdictionKey: 'NC-WAKE-MAGISTRATE',
    name: 'Notice of appeal from summary ejectment judgment',
    source: 'ai_freeform',
    formPdfMinioKey: null,
    fieldMap: {},
    disclosureText:
      STANDARD_DISCLOSURE +
      ' Giving notice of appeal may not by itself stop an eviction. Ask the Clerk of Court what you must do to stay in the property while your appeal is pending.',
    verification: {
      status: 'unverified',
      openQuestions: [
        'CRITICAL: confirm the wording that separates giving notice of appeal from staying execution. A tenant who reads this as "filing this keeps me housed" could lose their home.',
        'Confirm whether an official AOC form exists for this notice.',
      ],
    },
    interviewSchema: {
      version: 1,
      questions: [
        ...identityQuestions,
        {
          key: 'judgment_date',
          type: 'date',
          prompt: 'What date did the magistrate make the decision?',
          required: true,
        },
      ],
    },
  },

  // ---------------------------------------------------------------- shared
  {
    key: 'nc_fee_waiver_aoc_g_106',
    caseTypeKey: 'debt_defense',
    jurisdictionKey: 'NC-WAKE-DISTRICT',
    name: 'AOC-G-106 Petition to proceed without paying court costs',
    source: 'aoc_form',
    formPdfMinioKey: 'templates/nc/aoc-g-106.pdf',
    fieldMap: {
      full_name: 'PLACEHOLDER_petitioner_name',
      court_case_number: 'PLACEHOLDER_case_number',
      monthly_income: 'PLACEHOLDER_income',
      household_size: 'PLACEHOLDER_household_size',
      receives_assistance: 'PLACEHOLDER_public_assistance',
    },
    disclosureText: STANDARD_DISCLOSURE,
    verification: {
      status: 'unverified',
      openQuestions: [
        'BLOCKING: obtain the official blank AOC-G-106 PDF and replace every PLACEHOLDER_ field name.',
        'Confirm AOC-G-106 is the current fee-waiver form and record its exact title and revision date.',
        'This template is seeded once under debt_defense. Confirm whether it should be duplicated per case type and jurisdiction, since the schema keys templates by both.',
      ],
    },
    interviewSchema: {
      version: 1,
      questions: [
        ...identityQuestions,
        {
          key: 'monthly_income',
          type: 'money',
          prompt: 'About how much money does your household bring in each month?',
          helpText: 'Before taxes. A close estimate is fine.',
          required: true,
        },
        {
          key: 'household_size',
          type: 'short_text',
          prompt: 'How many people live in your household, including you?',
          required: true,
        },
        {
          key: 'receives_assistance',
          type: 'yes_no',
          prompt: 'Do you receive help such as SNAP, Medicaid, TANF or SSI?',
          required: true,
        },
      ],
    },
  },
]
