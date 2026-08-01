/**
 * debt_defense — defending a consumer debt collection lawsuit, NC District Court.
 *
 * ⚠️ UNVERIFIED LEGAL CONTENT. Every deadline rule below carries its statutory source and
 * a list of open questions for the reviewing attorney. Nothing here has been confirmed by
 * a licensed North Carolina attorney. The compliance gate in COMPLIANCE.md must clear
 * before this is shown to a real litigant.
 *
 * Where the answer was genuinely unclear, the stage is flagged rather than guessed —
 * per the build spec: "flag anything uncertain for human review rather than guessing".
 */

import type { WorkflowDefinition } from '@justicedesk/shared'

const UNVERIFIED = { status: 'unverified' as const }

export const debtDefenseWakeDistrict: WorkflowDefinition = {
  caseTypeKey: 'debt_defense',
  jurisdictionKey: 'NC-WAKE-DISTRICT',
  courtLevel: 'district',
  version: 1,
  status: 'draft',
  title: 'Defending a debt collection lawsuit',
  overview:
    'A company says you owe money and has sued you. This is what happens next, and what you can do at each step. ' +
    'The most important thing is the deadline to respond in writing. If you miss it, the court can decide the case without you.',
  initialStageKey: 'served',
  verification: {
    status: 'unverified',
    openQuestions: [
      'Confirm the 30-day answer period and the 3-day mailing extension apply to consumer debt suits in NC District Court as encoded.',
      'Confirm whether an extension of time to answer is available and how a pro se litigant requests one — the workflow currently omits it.',
      'Confirm the appeal route and deadline from a District Court civil judgment; the appeal stage is deliberately left without a computed deadline.',
      'Confirm the affirmative defenses listed in the Answer template are the right Phase 1 set and are correctly characterised.',
      'Decide whether counterclaims are in scope for Phase 1. The workflow currently does not model them.',
    ],
  },
  stages: [
    {
      key: 'served',
      title: 'You were served with court papers',
      plainLanguageExplainer:
        'You got a Summons and a Complaint. The Complaint says what the company claims you owe. ' +
        'The Summons tells you that you have a limited time to respond in writing. ' +
        'The clock started the day the papers were handed to you or mailed to you.',
      deadlineRule: {
        key: 'answer_due',
        title: 'File your written Answer',
        description:
          'This is the last day to give the court your written response. If you do not respond, the company can ask the court to rule against you without a hearing.',
        anchor: 'service_date',
        offset: { count: 30, unit: 'calendar_days' },
        direction: 'after',
        rollover: 'next_court_day',
        jurisdictional: true,
        serviceExtension: {
          appliesToMethods: ['first_class_mail', 'certified_mail', 'registered_mail'],
          days: 3,
          source: {
            citation: 'N.C. Gen. Stat. § 1A-1, Rule 6(e)',
            summary: 'When papers are served on you by mail, three days are added to your response time.',
          },
        },
        source: {
          citation: 'N.C. Gen. Stat. § 1A-1, Rule 12(a)(1)',
          summary: 'A defendant generally has 30 days after being served to file a written answer.',
        },
        verification: {
          status: 'unverified',
          openQuestions: [
            'Confirm 30 days is correct for this case type and court, and that no shorter local period applies.',
            'Confirm the mailing extension applies to the answer period and to these service methods.',
          ],
        },
      },
      requiredDocuments: [],
      courtFeeCents: null,
      next: ['prepare_answer', 'no_response_filed'],
    },
    {
      key: 'prepare_answer',
      title: 'Write and file your Answer',
      plainLanguageExplainer:
        'Your Answer is your side of the story in writing. You go through the Complaint paragraph by paragraph and say whether you agree, disagree, or do not know. ' +
        'You also list your defenses. Some defenses are lost if you do not raise them now. ' +
        'You file the Answer with the Clerk of Court and send a copy to the other side.',
      deadlineRule: null,
      requiredDocuments: [
        {
          templateKey: 'nc_debt_answer',
          title: 'Answer to Complaint',
          required: true,
          purpose: 'Your written response to what the company says you owe.',
        },
        {
          templateKey: 'nc_fee_waiver_aoc_g_106',
          title: 'Petition to proceed without paying court costs',
          required: false,
          purpose: 'Use this if you cannot afford a filing fee.',
        },
      ],
      courtFeeCents: 0,
      next: ['answer_filed'],
    },
    {
      key: 'answer_filed',
      title: 'Your Answer is on file',
      plainLanguageExplainer:
        'The court has your response. The case will move toward a hearing or trial. ' +
        'The other side may contact you about settling. You do not have to agree to anything.',
      deadlineRule: null,
      requiredDocuments: [],
      courtFeeCents: null,
      next: ['awaiting_hearing', 'case_closed'],
    },
    {
      key: 'awaiting_hearing',
      title: 'Waiting for your court date',
      plainLanguageExplainer:
        'The court will set a date. Watch your mail. If you move, tell the Clerk of Court in writing — ' +
        'notices go to the address on file, and missing a court date can cost you the case.',
      deadlineRule: {
        key: 'hearing_appearance',
        title: 'Go to your court hearing',
        description: 'Be at the courthouse on this date. Bring your papers and any proof you have.',
        anchor: 'hearing_date',
        offset: { count: 0, unit: 'calendar_days' },
        direction: 'after',
        rollover: 'none',
        jurisdictional: true,
        reminderOffsetsDays: [14, 7, 2, 1],
        source: {
          citation: 'N.C. Gen. Stat. § 1A-1, Rule 6',
          summary: 'The court sets the hearing date and notifies the parties.',
        },
        verification: {
          status: 'unverified',
          openQuestions: [
            'This is a pass-through of the court-assigned date rather than a computed deadline. Confirm that is the right treatment.',
          ],
        },
      },
      requiredDocuments: [],
      courtFeeCents: null,
      next: ['hearing_held'],
    },
    {
      key: 'hearing_held',
      title: 'Your hearing happened',
      plainLanguageExplainer:
        'The judge heard both sides. The decision may come the same day or later in the mail.',
      deadlineRule: null,
      requiredDocuments: [],
      courtFeeCents: null,
      next: ['judgment_entered', 'case_closed'],
    },
    {
      key: 'no_response_filed',
      title: 'No response was filed in time',
      plainLanguageExplainer:
        'The time to respond has passed without an Answer on file. The company can ask the court to enter a judgment against you without a hearing. ' +
        'There may still be steps available. This is a point where talking to a lawyer matters most.',
      deadlineRule: null,
      requiredDocuments: [],
      courtFeeCents: null,
      next: ['judgment_entered'],
    },
    {
      key: 'judgment_entered',
      title: 'A judgment was entered',
      plainLanguageExplainer:
        'The court has made a decision and entered it in the record. A judgment against you can be collected in ways that affect your wages, bank account or credit. ' +
        'There are time limits on challenging a judgment, and they are short.',
      // Deliberately no computed deadline: the appeal route and period from a District
      // Court civil judgment is an open question for counsel (see verification above).
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
