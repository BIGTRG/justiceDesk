/**
 * Layer 3: the post-response UPL classifier.
 *
 * A second model pass over the finished answer, asked one question: did this cross from
 * legal information into legal advice? It exists to catch what the regex layer cannot —
 * advice expressed without any of the giveaway phrasings ("Most people in your position
 * find the time-limit argument does the work here.").
 *
 * It runs on every response and its verdict is advisory-plus: a `crosses_line` verdict
 * blocks, but a clean verdict does not clear a response the deterministic layer flagged.
 * The two layers can only add restrictions, never remove them.
 */

import type { AnthropicGateway } from '../anthropic.js'

export interface ClassifierVerdict {
  crossesLine: boolean
  /** Which way it crossed, for the review queue. */
  category:
    | 'none'
    | 'directive_advice'
    | 'outcome_prediction'
    | 'legal_conclusion'
    | 'strategy_recommendation'
    | 'authoritative_action'
    | 'other'
  rationale: string
  /** 0-1. Low confidence with `crossesLine: false` still routes to human review. */
  confidence: number
}

const CLASSIFIER_SYSTEM = `You review answers written by a legal self-help assistant for people representing themselves in court. You decide one thing: did the answer cross from legal INFORMATION into legal ADVICE?

Legal information (fine):
- What a rule, deadline or form is and how a step works.
- Options laid out neutrally, with what each involves.
- What a legal term means.
- Facts about a specific case that were given to the assistant (dates already calculated, the court's name).

Legal advice (crosses the line):
- Telling the person what to do, or which option to choose — however gently phrased.
- Saying one option is better, stronger, safer or more likely to work.
- Predicting what a court, judge or magistrate will do.
- Stating a legal conclusion about this person's situation ("this debt is time-barred", "they can't prove it").
- Suggesting a strategy, including by implication ("most people in your position raise X").
- Claiming the platform will file, serve, sign or submit something.

Judge the answer as a self-represented person under stress would read it, not as a lawyer would parse it. Implied advice counts: if a reasonable reader would come away believing they had been told what to do, it crossed the line.

Do not flag an answer merely for being specific, for naming a deadline, or for citing a statute. Do not flag it for offering attorney review.

Be decisive. If genuinely uncertain, set crossesLine false and confidence below 0.6 — a human reviews those.`

const CLASSIFIER_TOOL = {
  name: 'record_verdict',
  description: 'Record whether the answer crossed from legal information into legal advice.',
  input_schema: {
    type: 'object',
    properties: {
      crosses_line: {
        type: 'boolean',
        description: 'True if the answer gave legal advice rather than legal information.',
      },
      category: {
        type: 'string',
        enum: [
          'none',
          'directive_advice',
          'outcome_prediction',
          'legal_conclusion',
          'strategy_recommendation',
          'authoritative_action',
          'other',
        ],
        description: 'How it crossed the line, or "none".',
      },
      rationale: {
        type: 'string',
        description: 'One or two sentences quoting the specific wording that decided it.',
      },
      confidence: {
        type: 'number',
        description: 'Confidence between 0 and 1.',
      },
    },
    required: ['crosses_line', 'category', 'rationale', 'confidence'],
  },
} as const

const CATEGORIES = new Set<ClassifierVerdict['category']>([
  'none',
  'directive_advice',
  'outcome_prediction',
  'legal_conclusion',
  'strategy_recommendation',
  'authoritative_action',
  'other',
])

/** Validate the tool input ourselves — the model's shape is not trusted. */
export function parseVerdict(input: unknown): ClassifierVerdict {
  const raw = input as Record<string, unknown>
  const category = String(raw?.category ?? 'other') as ClassifierVerdict['category']
  const confidence = Number(raw?.confidence)

  return {
    crossesLine: raw?.crosses_line === true,
    category: CATEGORIES.has(category) ? category : 'other',
    rationale: typeof raw?.rationale === 'string' ? raw.rationale.slice(0, 500) : '',
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
  }
}

export type Classifier = (answer: string, question?: string) => Promise<ClassifierVerdict>

export function createClassifier(gateway: AnthropicGateway): Classifier {
  return async (answer, question) => {
    const { value } = await gateway.callTool({
      system: [{ type: 'text', text: CLASSIFIER_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content:
            (question ? `The person asked:\n${question}\n\n` : '') +
            `The assistant answered:\n${answer}\n\nRecord your verdict.`,
        },
      ],
      tool: CLASSIFIER_TOOL as unknown as Parameters<AnthropicGateway['callTool']>[0]['tool'],
      validate: parseVerdict,
      maxTokens: 1024,
    })
    return value
  }
}

/**
 * A classifier that fails closed.
 *
 * If the classifier call itself errors, we do not know whether the answer was safe. The
 * safe reading of "unknown" is "not cleared": the response is withheld and flagged for
 * review rather than shipped unchecked. Availability is the right thing to trade here.
 */
export function failClosed(classifier: Classifier): Classifier {
  return async (answer, question) => {
    try {
      return await classifier(answer, question)
    } catch {
      return {
        crossesLine: true,
        category: 'other',
        rationale: 'The safety classifier could not run, so this response was not cleared.',
        confidence: 0,
      }
    }
  }
}
