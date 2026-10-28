/**
 * Separate pipelines:
 *  - STT / wake normalization → canonical ra_one
 *  - TTS pronunciation → spoken "Raw-One" (display text unchanged)
 */
import {
  IDENTITY,
  SLEEP_COMMANDS,
  WAKE_DICTIONARY,
} from './identityConfig.js';

export function normalizeForMatch(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s\-']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Collapse known STT spellings of RA-ONE into a sentinel token. */
export function canonicalizeNameTokens(text) {
  let t = normalizeForMatch(text);
  const patterns = [
    /\br\s*a\s*[\-]?\s*one\b/g,
    /\bare\s+a\s+one\b/g,
    /\bray[\s\-]?one\b/g,
    /\braw[\s\-]?one\b/g,
    /\bra[\s\-]?one\b/g,
    /\braone\b/g,
    /\br[\s\-]?one\b/g,
  ];
  for (const re of patterns) t = t.replace(re, ' ra_one ');
  return t.replace(/\s+/g, ' ').trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildNameAlternation() {
  const parts = WAKE_DICTIONARY.nameAliases
    .map((a) => escapeRe(a).replace(/\s+/g, '\\s+'))
    .sort((a, b) => b.length - a.length);
  return `(?:${parts.join('|')})`;
}

const NAME_ALT = buildNameAlternation();

/**
 * Match wake at start of utterance (conservative).
 * @returns {{ matched: boolean, remainder: string, greeting: string|null, wakeSpan: string, canonical: string }}
 */
export function matchWakePhrase(raw) {
  const text = normalizeForMatch(raw);
  if (!text) {
    return { matched: false, remainder: '', greeting: null, wakeSpan: '', canonical: IDENTITY.canonicalId };
  }

  const greetAlt = WAKE_DICTIONARY.greetings.join('|');
  // Optional greeting + name, must start near beginning
  const re = new RegExp(
    `^(?:(${greetAlt})\\s+)?(${NAME_ALT})(?:\\s*[,.]?\\s*|$)`,
    'i',
  );
  const m = text.match(re);
  if (!m || (m.index ?? 0) > 0) {
    // Also allow bare name anywhere in first 40 chars only if it's the whole short phrase
    const bare = new RegExp(`^(${NAME_ALT})$`, 'i');
    const b = text.match(bare);
    if (b) {
      return {
        matched: true,
        remainder: '',
        greeting: null,
        wakeSpan: b[1],
        canonical: IDENTITY.canonicalId,
      };
    }
    return { matched: false, remainder: text, greeting: null, wakeSpan: '', canonical: IDENTITY.canonicalId };
  }

  const greeting = m[1] ? m[1].toLowerCase() : null;
  const wakeSpan = m[2];
  const remainder = text.slice(m[0].length).replace(/^[\s,.!?]+/, '').trim();
  return {
    matched: true,
    remainder,
    greeting,
    wakeSpan,
    canonical: IDENTITY.canonicalId,
  };
}

/** True if transcript looks like background speech without a wake name. */
export function isNonWakeBackground(raw) {
  const hit = matchWakePhrase(raw);
  return !hit.matched;
}

/**
 * Detect explicit sleep commands (optionally prefixed with name).
 */
export function matchSleepCommand(raw) {
  const canon = canonicalizeNameTokens(raw);
  const stripped = canon
    .replace(new RegExp(`^(hey|hi|hello)?\\s*${IDENTITY.canonicalId}\\s*,?\\s*`), '')
    .trim();
  for (const cmd of SLEEP_COMMANDS) {
    if (stripped === cmd || stripped.startsWith(`${cmd} `)) {
      return { matched: true, command: cmd };
    }
  }
  // "RA-ONE go to sleep" without comma
  for (const cmd of SLEEP_COMMANDS) {
    if (canon.includes(`${IDENTITY.canonicalId} ${cmd}`)) {
      return { matched: true, command: cmd };
    }
  }
  return { matched: false, command: null };
}

let lastAck = '';

function pick(list, rng) {
  const options = list.length > 1 ? list.filter((s) => s !== lastAck) : list;
  lastAck = options[Math.floor(rng() * options.length) % options.length];
  return lastAck;
}

function daypart(hour) {
  if (hour < 5) return 'Up late';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Spoken wake reply. Varies the wording so RA-ONE doesn't sound like a recording.
 * @param {string|null} greeting
 * @param {'wake'|'clap'|'repeat'|string} [source]
 * @param {{ mood?: string|null, hour?: number, rng?: () => number }} [opts]
 */
export function wakeAcknowledgement(greeting, source = 'wake', {
  mood = null,
  hour = new Date().getHours(),
  rng = Math.random,
} = {}) {
  const acks = WAKE_DICTIONARY.acknowledgements;
  let list;
  if (source === 'repeat') list = acks.repeat;
  else if (mood && WAKE_DICTIONARY.moodAcknowledgements[mood]) list = WAKE_DICTIONARY.moodAcknowledgements[mood];
  else if (source === 'clap') list = acks.clap;
  else list = (greeting && acks[greeting]) || acks.bare;
  return pick(list, rng).replace('{daypart}', daypart(hour));
}

/**
 * TTS-only rewrite. Does not change UI/display strings.
 * @param {string} displayText
 * @param {{ voiceId?: string, usePhonetic?: boolean }} [opts]
 */
export function toSpokenText(displayText, opts = {}) {
  let t = String(displayText ?? '');
  if (!t) return t;
  const spoken = opts.usePhonetic
    ? IDENTITY.phoneticSpokenName
    : (IDENTITY.voicePhonetics[opts.voiceId] || IDENTITY.spokenName);

  const replacements = [
    [/\bR\s*A\s*[\-–—]?\s*ONE\b/gi, spoken],
    [/\bRA[\-–—]?ONE\b/gi, spoken],
    [/\bRA\s+ONE\b/gi, spoken],
    [/\bRay[\-–—]?\s*One\b/gi, spoken],
    [/\bRaw[\-–—]?\s*One\b/gi, spoken], // keep consistent casing of spoken form
  ];
  for (const [re, rep] of replacements) t = t.replace(re, rep);
  // Ensure final spoken form spelling
  t = t.replace(new RegExp(escapeRe(IDENTITY.spokenName), 'gi'), spoken);
  return t;
}

export { IDENTITY };
