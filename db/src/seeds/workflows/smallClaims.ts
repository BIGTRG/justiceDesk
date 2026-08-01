/**
 * small_claims — a small claim before a magistrate, NC, $10,000 or less.
 *
 * Either party role. Plaintiff-only and defendant-only stages are marked with
 * `appliesToRoles` so the timeline shows a litigant only their own path.
 *
 * ⚠️ UNVERIFIED LEGAL CONTENT — see COMPLIANCE.md.
 */

import type { WorkflowDefinition } from '@justicedesk/shared'

export const smallClaimsWakeMagistrate: WorkflowDefinition = {
  caseTypeKey: 'small_claims',
  jurisdictionKey: 'NC-WAKE-MAGISTRATE',
  courtLevel: 'magistrate',
  version: 1,
  status: 'draft',
  title: 'Small claims court',
  overview:
    'Small claims court is for disputes up to $10,000. A magistrate hears the case, usually in a single short hearing. ' +
    'You do not need a lawyer, and you do not have to file a written response to be heard — but you do have to show up.',
  initialStageKey: 'case_started',
  verification: {
    status: 'unverified',
    openQuestions: [
      'Confirm the $10,000 magistrate jurisdictional limit is current and applies in Wake County.',
      'Confirm the hearing-date window in the small claims summons (encoded as 5 to 30 days after issuance) and which end of the window to show the litigant.',
      'Confirm the 10-day appeal period, when it starts (entry of judgment vs. service of judgment), and what "notice of appeal" requires from a pro se litigant.',
      'Confirm whether a defendant filing a written response changes any deadline, given a written answer is not required.',
      'Confirm current filing and service fees before any fee figure is shown; the workflow currently reports fees as unknown rather than guessing.',
    ],
  },
  stages: [
    {
      key: 'case_started',
      title: 'The case has been started',
      plainLanguageExplainer:
        'A small claims case has been filed with the Clerk of Court and a Magistrate Summons has been issued. ' +
        'The summons tells everyone when and where to come to court.',
      deadlineRule: null,
      requiredDocuments: [
        {
          templateKey: 'nc_small_claims_complaint_aoc_cvm_102',
          title: 'Small claims complaint',
          required: false,
          purpose: 'The form that starts a small claims case. Only the person suing files this.',
        },
        {
          templateKey: 'nc_fee_waiver_aoc_g_106',
          title: 'Petition to proceed without paying court costs',
          required: false,
          purpose: 'Use this if you cannot afford the filing fee.',
        },
      ],
      // Fees are deliberately unknown rather than guessed — see open questions.
      courtFeeCents: null,
      next: ['hearing_scheduled'],
    },
    {
      key: 'hearing_scheduled',
      title: 'Your hearing date is set',
      plainLanguageExplainer:
        'Small claims moves fast. The hearing is set for a short time after the summons is issued. ' +
        'The date is printed on the summons. Put it somewhere you will see it.',
      deadlineRule: {
        key: 'small_claims_hearing',
        title: 'Go to your small claims hearing',
        description:
          'Be at the courthouse on this date. Bring everything you want the magistrate to see: contracts, receipts, photos, messages.',
        anchor: 'summons_issued_date',
        // The summons sets the appearance a short time after issuance. This encodes the
        // near end of that window so the reminder cadence starts early; the actual date
        // printed on the summons overrides it once OCR or the litigant supplies it.
        offset: { count: 5, unit: 'calendar_days' },
        direction: 'after',
        rollover: 'next_court_day',
        jurisdictional: true,
        source: {
          citation: 'N.C. Gen. Stat. § 7A-214',
          summary:
            'The small claims summons sets your hearing date a short time after the summons is issued.',
        },
        verification: {
          status: 'unverified',
          openQuestions: [
            'Confirm the statutory window and whether encoding the near end of it is the right default.',
            'Confirm this estimate is always superseded by the date printed on the summons before anything is shown to a litigant.',
          ],
        },
      },
      requiredDocuments: [],
      courtFeeCents: null,
      next: ['prepare_for_hearing'],
    },
    {
      key: 'prepare_for_hearing',
      title: 'Get ready for your hearing',
      plainLanguageExplainer:
        'Gather your proof and put it in order. Bring the originals and a copy for the other side. ' +
        'If someone saw what happened and can help, ask them to come with you. ' +
        'You do not have to file anything in writing before the hearing.',
      deadlineRule: null,
      requiredDocuments: [
        {
          templateKey: 'nc_small_claims_response_aoc_cvm_103',
          title: 'Written response (optional)',
          required: false,
          purpose:
            'You do not have to file a written response in small claims court, but you can if you want your side in the record early.',
        },
      ],
      courtFeeCents: null,
      next: ['hearing_held'],
    },
    {
      key: 'hearing_held',
      title: 'The hearing happened',
      plainLanguageExplainer:
        'The magistrate heard both sides. In small claims the decision usually comes the same day.',
      deadlineRule: null,
      requiredDocuments: [],
      courtFeeCents: null,
      next: ['judgment_entered'],
    },
    {
      key: 'judgment_entered',
      title: 'The magistrate made a decision',
      plainLanguageExplainer:
        'The magistrate has entered a judgment. If you disagree, you can appeal for a completely new hearing in District Court — ' +
        'but the time to say so is very short, and it starts running immediately.',
      deadlineRule: {
        key: 'notice_of_appeal_due',
        title: 'Last day to give notice of appeal',
        description:
          'If you want a new hearing in District Court, this is the last day to tell the court. After this date the magistrate’s decision usually stands.',
        anchor: 'judgment_date',
        offset: { count: 10, unit: 'calendar_days' },
        direction: 'after',
        rollover: 'next_court_day',
        jurisdictional: true,
        reminderOffsetsDays: [7, 3, 2, 1],
        source: {
          citation: 'N.C. Gen. Stat. § 7A-228',
          summary:
            'A party has a short period after the magistrate’s judgment to give notice of appeal for a new hearing in district court.',
        },
        verification: {
          status: 'unverified',
          openQuestions: [
            'Confirm the 10-day period and whether it runs from entry of judgment or from service of the judgment.',
            'Confirm whether the period counts calendar days or excludes weekends and holidays under Rule 6(a) — 10 days is over the under-7-day threshold, so it is encoded as calendar days.',
            'Confirm what a pro se litigant must actually do to perfect the appeal, and any fee or bond.',
          ],
        },
      },
      requiredDocuments: [
        {
          templateKey: 'nc_notice_of_appeal_small_claims',
          title: 'Notice of appeal',
          required: false,
          purpose: 'Tells the court you want a new hearing in District Court.',
        },
      ],
      courtFeeCents: null,
      next: ['appealed', 'case_closed'],
    },
    {
      key: 'appealed',
      title: 'You appealed for a new hearing',
      plainLanguageExplainer:
        'Your case is going to District Court for a completely new hearing. The magistrate’s decision does not carry over — ' +
        'the District Court starts fresh. A District Court hearing is more formal than small claims.',
      deadlineRule: null,
      requiredDocuments: [],
      courtFeeCents: null,
      next: ['case_closed'],
    },
    {
      key: 'case_closed',
      title: 'Case closed',
      plainLanguageExplainer:
        'This case is finished on JusticeDesk. You can still download and print everything in your documents folder.',
      deadlineRule: null,
      requiredDocuments: [],
      courtFeeCents: null,
      next: [],
      terminal: true,
    },
  ],
}
