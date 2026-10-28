/**
 * Canned replies for the simulated conversation. No language model is involved;
 * the UI labels every reply as simulated.
 */
const RULES = [
  [/\b(hello|hi|hey|greetings)\b/i, () => 'Systems online. How may I assist you?'],
  [/\bwho are you|what are you|your name\b/i, () => 'I am RA-ONE, a cosmic intelligence interface. My language core is not connected yet, so this reply is simulated.'],
  [/\btime\b/i, () => `Local system time is ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`],
  [/\b(date|day|today)\b/i, () => `Today is ${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}.`],
  [/\b(thanks|thank you)\b/i, () => 'Acknowledged. Standing by.'],
  [/\b(status|how are you|systems?)\b/i, () => 'All visual systems are nominal. Neural lattice stable. Language core: offline.'],
];

const FALLBACK = 'Simulation mode: my language core is not connected yet, so I cannot truly answer that. Visual systems remain fully operational.';

/** Sample "spoken" phrases for the simulated microphone input. */
export const SAMPLE_VOICE_INPUTS = ['Hello RA-ONE', 'Who are you?', 'What time is it?', 'System status'];

export function mockReply(text) {
  for (const [pattern, reply] of RULES) if (pattern.test(text)) return reply();
  return FALLBACK;
}
