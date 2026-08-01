/**
 * eviction_tenant — a tenant defending a summary ejectment (eviction), NC magistrate court.
 *
 * This is the most time-critical of the three Phase 1 case types: the periods are days,
 * not weeks, and the consequence of missing one is losing the home. Every deadline here
 * is marked jurisdictional and gets the compressed reminder cadence.
 *
 * ⚠️ UNVERIFIED LEGAL CONTENT — see COMPLIANCE.md. The appeal-and-stay interaction
 * (giving notice of appeal versus paying rent into court to stay the eviction) is the
 * highest-risk item in this file and is called out as an open question.
 */

import type { WorkflowDefinition } from '@justicedesk/shared'

export const evictionTenantWakeMagistrate: WorkflowDefinition = {
  caseTypeKey: 'eviction_tenant',
  jurisdictionKey: 'NC-WAKE-MAGISTRATE',
  courtLevel: 'magistrate',
  version: 1,
  status: 'draft',
  title: 'Responding to an eviction case',
  overview:
    'Your landlord has filed to have you removed from the property. This is called summary ejectment. ' +
    'Eviction cases move very quickly — sometimes in a week or two from start to hearing. ' +
    'Going to the hearing is the single most important thing you can do.',
  initialStageKey: 'served_summons',
  verification: {
    status: 'unverified',
    openQuestions: [
      'CRITICAL: confirm the relationship between the 10-day notice of appeal period and the separate requirement to pay rent into court to stay execution. Encoding these as two independent deadlines may misstate what a tenant must do to stay in the home pending appeal.',
      'Confirm the minimum period between issuance of the summons and the hearing, and whether encoding it as an estimate superseded by the printed date is correct.',
      'Confirm the waiting period before a writ of possession may issue and what, if anything, a tenant can do during it.',
      'Confirm which defenses belong in the Phase 1 answer template and whether any are waived if not raised at the hearing.',
      'Confirm whether a written answer is required or optional in summary ejectment before the workflow describes it as optional.',
    ],
  },
  stages: [
    {
      key: 'served_summons',
      title: 'You were served with eviction papers',
      plainLanguageExplainer:
        'You got a Complaint in Summary Ejectment and a Magistrate Summons. ' +
        'The summons has your court date on it. Eviction cases are heard quickly. ' +
        'You do not have to move out because of these papers — a judge has not decided anything yet.',
      deadlineRule: {
        key: 'ejectment_hearing',
        title: 'Go to your eviction hearing',
        description:
          'Be at the courthouse on this date. If you do not come, the magistrate can decide the case without hearing from you.',
        anchor: 'summons_issued_date',
        // Encodes the minimum period between issuance and the hearing. Superseded by the
        // date actually printed on the summons as soon as we have it.
        offset: { count: 7, unit: 'calendar_days' },
        direction: 'after',
        rollover: 'next_court_day',
        jurisdictional: true,
        reminderOffsetsDays: [7, 3, 2, 1],
        source: {
          citation: 'N.C. Gen. Stat. § 42-28',
          summary:
            'The eviction summons sets a hearing a short time after the summons is issued.',
        },
        verification: {
          status: 'unverified',
          openQuestions: [
            'Confirm the minimum period and that presenting it as an estimate is appropriate.',
            'Confirm this estimate is always replaced by the printed hearing date before display.',
          ],
        },
      },
      requiredDocuments: [
        {
          templateKey: 'nc_ejectment_answer',
          title: 'Answer in summary ejectment',
          required: false,
          purpose:
            'Puts your side in writing before the hearing. You can also just come and tell the magistrate.',
        },
        {
          templateKey: 'nc_fee_waiver_aoc_g_106',
          title: 'Petition to proceed without paying court costs',
          required: false,
          purpose: 'Use this if you cannot afford a court fee.',
        },
      ],
      courtFeeCents: null,
      next: ['prepare_for_hearing', 'hearing_missed'],
    },
    {
      key: 'prepare_for_hearing',
      title: 'Get ready for your hearing',
      plainLanguageExplainer:
        'Bring your lease, your rent receipts or bank records, any messages with your landlord, and photos if the condition of the place is part of the dispute. ' +
        'Bring a copy for the landlord. Get there early and allow time for parking and security.',
      deadlineRule: null,
      requiredDocuments: [],
      courtFeeCents: null,
      next: ['hearing_held'],
    },
    {
      key: 'hearing_held',
      title: 'The hearing happened',
      plainLanguageExplainer: 'The magistrate heard both sides and will enter a decision.',
      deadlineRule: null,
      requiredDocuments: [],
      courtFeeCents: null,
      next: ['judgment_entered'],
    },
    {
      key: 'hearing_missed',
      title: 'The hearing happened without you',
      plainLanguageExplainer:
        'The hearing went ahead without you and the magistrate likely ruled for the landlord. ' +
        'There may still be steps available, and the time to take them is very short. This is a point where legal help matters most.',
      deadlineRule: null,
      requiredDocuments: [],
      courtFeeCents: null,
      next: ['judgment_entered'],
    },
    {
      key: 'judgment_entered',
      title: 'The magistrate made a decision',
      plainLanguageExplainer:
        'If the magistrate ruled for the landlord, you can appeal for a new hearing in District Court. ' +
        'Appealing and staying in the home are two separate things — giving notice of appeal on its own may not stop the eviction. ' +
        'There is usually also a requirement to pay rent to the court while the appeal is going on.',
      deadlineRule: {
        key: 'ejectment_notice_of_appeal_due',
        title: 'Last day to give notice of appeal',
        description:
          'If you want a new hearing in District Court, this is the last day to tell the court.',
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
            'CRITICAL: confirm how this interacts with the separate stay-of-execution requirement. A tenant who gives notice of appeal but does not meet the stay requirement may still be removed.',
            'Confirm whether the period runs from entry or service of the judgment.',
          ],
        },
      },
      requiredDocuments: [
        {
          templateKey: 'nc_ejectment_notice_of_appeal',
          title: 'Notice of appeal',
          required: false,
          purpose: 'Tells the court you want a new hearing in District Court.',
        },
      ],
      courtFeeCents: null,
      next: ['appeal_and_stay', 'writ_period', 'case_closed'],
    },
    {
      key: 'appeal_and_stay',
      title: 'Appealing and asking to stay in the home',
      plainLanguageExplainer:
        'To stay in the property while your appeal is pending, there is normally a separate step: paying rent to the court on a schedule. ' +
        'Ask the Clerk of Court exactly what you must pay and by when. Getting this wrong can mean being removed even though your appeal is on file.',
      deadlineRule: null,
      requiredDocuments: [],
      courtFeeCents: null,
      next: ['case_closed'],
    },
    {
      key: 'writ_period',
      title: 'Before the sheriff can act',
      plainLanguageExplainer:
        'If the landlord won and there is no appeal or stay, the landlord can ask for a writ of possession. ' +
        'That is the order that lets the sheriff remove you. There is a waiting period first. ' +
        'Use this time to make a plan and to look for local emergency housing help.',
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
