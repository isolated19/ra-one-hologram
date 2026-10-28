/**
 * Produces a speech-like amplitude envelope (syllables, word gaps, phrase pauses)
 * for demo mode. This is synthetic motion, not lip-sync to any real audio.
 */
export class DemoSpeechGenerator {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.segTime = 0;
    this.segLength = 0.1;
    this.from = 0;
    this.to = 0;
    this.syllablesLeft = 0;
    this.wordsLeft = 3;
    this.value = 0;
  }

  // Next segment: a syllable peak, a short gap, a word gap or a phrase pause
  next() {
    const r = this.rng;
    this.from = this.value;
    this.segTime = 0;
    if (this.syllablesLeft > 0) {
      this.syllablesLeft--;
      const peak = this.to < 0.3;
      this.to = peak ? 0.45 + r() * 0.55 : 0.08 + r() * 0.15;
      this.segLength = peak ? 0.07 + r() * 0.12 : 0.03 + r() * 0.06;
    } else if (this.wordsLeft > 0) {
      this.wordsLeft--;
      this.syllablesLeft = 2 * (1 + Math.floor(r() * 3));
      this.to = 0.02 + r() * 0.05;
      this.segLength = 0.06 + r() * 0.12;
    } else {
      this.wordsLeft = 3 + Math.floor(r() * 6);
      this.to = 0;
      this.segLength = 0.25 + r() * 0.45;
    }
  }

  /** Advance by dt seconds; returns amplitude 0..1. */
  update(dt) {
    this.segTime += dt;
    while (this.segTime >= this.segLength) {
      this.segTime -= this.segLength;
      this.value = this.to;
      this.next();
    }
    const x = this.segTime / this.segLength;
    const e = x * x * (3 - 2 * x);
    this.value = this.from + (this.to - this.from) * e;
    return this.value;
  }
}
