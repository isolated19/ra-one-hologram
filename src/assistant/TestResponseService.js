/**
 * Module 2 predefined answers — not live LLM / labour-market analytics.
 */

function normalize(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const FALLBACK =
  'My advanced analysis system is not connected yet. I can currently demonstrate speech interaction and predefined responses.';

const RULES = [
  {
    id: 'greeting',
    test: (t) => /^(hello|hi|hey)\b/.test(t) && !/\bra[\s\-]?one\b/.test(t.slice(0, 12)),
    // Allow "hello" / "hi" even with trailing words
    match: (t) => /\b(hello|hi)\b/.test(t) && t.length < 40 && !/who are you|what can you/.test(t),
    response: 'Hello. I am RA-ONE. How can I assist you?',
  },
  {
    id: 'identity',
    match: (t) => /\bwho are you\b/.test(t) || /\bwhat are you\b/.test(t) || /\byour name\b/.test(t),
    response:
      'I am RA-ONE, a futuristic AI assistant being developed to help explore labour market information.',
  },
  {
    id: 'capabilities',
    match: (t) => /\bwhat can you do\b/.test(t) || /\byour capabilities\b/.test(t) || /\bwhat do you do\b/.test(t),
    response:
      'I am being developed to help analyze employment trends, skill requirements, job availability, regional wage differences and future hiring needs.',
  },
  {
    id: 'labour-challenges',
    match: (t) =>
      /\bchalleng/.test(t)
      && (/\blabou?r market\b/.test(t) || /\bemployment\b/.test(t) || /\banalysis\b/.test(t)),
    response:
      'Major challenges include outdated employment data, rapidly changing skill requirements, regional differences in wages and opportunities, mismatches between education and industry, data privacy concerns, and uncertainty in future hiring demand.',
  },
];

export class TestResponseService {
  respond(rawQuestion) {
    const text = normalize(rawQuestion);
    if (!text) {
      return { id: 'empty', response: FALLBACK, simulated: true };
    }
    for (const rule of RULES) {
      if (rule.match(text)) {
        return { id: rule.id, response: rule.response, simulated: true, query: text };
      }
    }
    return { id: 'unsupported', response: FALLBACK, simulated: true, query: text };
  }
}

export const TEST_FALLBACK_RESPONSE = FALLBACK;
export const TEST_RESPONSE_RULES = RULES;
