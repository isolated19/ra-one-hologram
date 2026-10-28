/**
 * Central RA-ONE identity — display vs spoken pronunciation.
 * UI always shows RA-ONE; TTS speaks "Raw-One" (raw-wun).
 */

export const IDENTITY = {
  displayName: 'RA-ONE',
  spokenName: 'Raw-One',
  /** Preferred phonetic hint for stubborn TTS voices */
  phoneticSpokenName: 'Rawwun',
  canonicalId: 'ra_one',
  /** Per Piper voice-id overrides (optional) */
  voicePhonetics: {
    'en_US-bryce-medium': 'Raw-One',
    'en_US-joe-medium': 'Raw-One',
    'en_GB-alan-medium': 'Raw-One',
  },
};

/** Configurable wake dictionary (word-boundary aware matching). */
export const WAKE_DICTIONARY = {
  greetings: ['hey', 'hi', 'hello'],
  nameAliases: [
    'ra-one',
    'ra one',
    'raone',
    'raw one',
    'raw-one',
    'rawone',
    'ray one',
    'ray-one',
    'r a one',
    'r-a-one',
    'are a one',
    'are one', // common Chrome STT mishearing of "RA-ONE"
    'our one',
    'rowan',
    'r one',
  ],
  /** Wake-only replies keyed by greeting style; one is picked at random, never the same twice running */
  acknowledgements: {
    hey: ['Yes, sir?', "At your service. I'm listening.", 'Go ahead, I\'m all ears.', 'Right here. What do you need?'],
    hi: ['{daypart}, sir. What can I do for you?', 'Hey there. How can I help?', 'Good to hear from you. What do you need?'],
    hello: ['{daypart}, sir. What can I do for you?', 'Hello. Always a pleasure. How can I help?', 'Hello there. What are we working on?'],
    bare: ['Yes?', 'Right here, sir.', "At your service. I'm listening."],
    clap: ["You rang, sir? I'm listening.", "Online and ready. I'm listening.", "I'm listening. Go ahead."],
    /** Name called again while already awake — answer out loud instead of going quiet */
    repeat: [
      'Still here, sir. What do you need?',
      "Yes, I'm right here. Go ahead.",
      "I'm listening. Ask me anything.",
      "Here, sir. Whenever you're ready.",
    ],
  },
  /** Wake replies that notice the user's expression (camera on and confident) */
  moodAcknowledgements: {
    happy: ['You look cheerful, sir. What can I do for you?', "Someone's in a good mood. How can I help?"],
    sad: ['Hey, you seem a little down. I\'m here. What do you need?', "I'm right here for you. What's on your mind?"],
    angry: ["You look a bit tense, sir. Let's sort it out. What do you need?"],
    fearful: ["Everything alright? I'm here. Talk to me."],
    surprised: ['Something caught you off guard? I\'m listening.'],
  },
};

export const SLEEP_COMMANDS = [
  'go to sleep',
  'sleep now',
  'stop listening',
  'go sleep',
];

export const LIFECYCLE = {
  // Stay awake for follow-ups a full minute, like a real assistant, before dozing off
  STANDBY_FOLLOWUP_MS: 60000,
  CLAP_COOLDOWN_MS: 1500,
  POST_SPEAK_COOLDOWN_MS: 800,
  WAKE_DEBOUNCE_MS: 900,
};
