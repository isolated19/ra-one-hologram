// Per-particle data supplied by ParticleSystem / ParticleConnections.
// `position` is the formed target position; aStart is where the particle begins.
attribute vec3 aStart;
attribute vec3 aDir;
attribute float aPhase;
attribute float aRandom;
attribute float aSize;
attribute float aBright;
attribute float aKind;   // 0 hood, 1 face, 2 dust, 3 eye, 4 nebula, 5 drift cluster, 7 energy node
attribute float aGlitch;
attribute float aSeq;    // links: 0/1 endpoint; drift particles: cluster seed

uniform float uTime;
uniform float uForm;       // global formation progress 0..1
uniform float uDissolve;   // 0 formed .. 1 dissolved
uniform float uSpeed;
uniform float uPulseY;     // height of the energy pulse band
uniform float uPulseAmp;
uniform float uDensity;
uniform float uScale;      // CSS px per world unit at distance 1
uniform float uPixelRatio;
uniform float uBrightness;
uniform float uPoints;     // 1 points, 0 line segments
uniform float uCamDist;

// Assistant state (smoothed weights 0..1) and derived activity levels
uniform float uListen;
uniform float uThink;
uniform float uSpeak;
uniform float uNeural;
uniform float uGlitchRate;
uniform float uDust;
uniform float uAudioIn;
uniform float uMouthOpen;
uniform float uMouthY;
uniform float uEyeIntensity;

varying vec3 vColor;
varying float vAlpha;
varying float vBright;
varying float vNeb;
varying float vSeq;
varying float vRand;
varying float vAct;

float isKind(float k) { return 1.0 - step(0.5, abs(aKind - k)); }

void main() {
  float t = uTime * uSpeed;

  // Formation: each particle starts at its own time (aPhase) within uForm
  float p = clamp((uForm - aPhase * 0.7) / 0.3, 0.0, 1.0);
  p = p * p * (3.0 - 2.0 * p);
  vec3 pos = mix(aStart, position, p);

  float hood = isKind(0.0);
  float face = isKind(1.0);
  float dust = isKind(2.0);
  float eye = isKind(3.0);
  float neb = isKind(4.0);
  float drift = isKind(5.0);
  float node = isKind(7.0);
  float figure = hood + face + drift + node;
  bool isLine = uPoints < 0.5;

  // --- Idle life -----------------------------------------------------------
  vec3 q = position * 1.3 + vec3(0.0, t * 0.09, t * 0.03);
  vec3 n3 = vec3(vnoise(q), vnoise(q + 17.3), vnoise(q + 41.7)) - 0.5;
  float amp = 0.012 * figure + 0.11 * dust * (1.0 + uDust) + 0.015 * node;
  pos += n3 * amp * p;

  // Breathing: the hood swells and settles; the whole figure bobs subtly
  pos.xz += position.xz * 0.006 * sin(t * 0.9) * hood * p;
  pos.y += sin(t * 0.8 + position.y * 1.5) * 0.004 * p * figure;

  // Dust occasionally drifts outward, fading before it wraps back
  float dc = fract(t * 0.05 + aRandom * 5.0);
  pos += normalize(position + 1e-4) * dust * smoothstep(0.6, 1.0, dc) * (0.3 + 0.5 * uDust) * p;

  // --- Listening: converge toward the face, ripples on the hood, audio on the face
  vec3 faceC = vec3(0.0, 0.15, 0.85);
  float rd = length(position.xy - faceC.xy);
  pos += (faceC - position) * 0.04 * uListen * (hood * 0.6 + node + drift * 0.5) * p;
  pos += normalize(position - vec3(0.0, 0.15, 0.0) + 1e-4) * sin(rd * 9.0 - t * 5.0) * 0.014 * uListen * hood;
  pos.z += face * (vnoise(position * 7.0 + t * 2.0) - 0.5) * 0.06 * uAudioIn * uListen;
  pos += n3 * 0.08 * uListen * dust;

  // --- Thinking: particle clusters around brow and eyes gather and separate
  float brow = exp(-(position.x * position.x * 2.5 + pow(position.y - 0.45, 2.0) * 6.0));
  vec3 sw = vec3(vnoise(position * 3.0 + t * 0.5), vnoise(position * 3.0 + 9.1 + t * 0.5), 0.0) - 0.5;
  pos += sw * 0.07 * uThink * (face * brow + node) * sin(t * 1.4 + aRandom * 6.2831);

  // --- Speaking: lips part and the jaw follows the mouth amplitude
  float mouthW = exp(-(pow(position.x / 0.24, 2.0) + pow((position.y - uMouthY) / 0.09, 2.0)));
  pos.y += face * sign(position.y - uMouthY) * mouthW * uMouthOpen * 0.035;
  pos.y -= face * smoothstep(uMouthY + 0.02, uMouthY - 0.3, position.y) * uMouthOpen * 0.04;

  // --- Layer F: drift clusters peel off the edges, then return
  float cyc = fract(t * 0.06 * (0.7 + aSeq * 0.6) + aSeq * 7.0);
  float det = smoothstep(0.55, 0.8, cyc) * (1.0 - smoothstep(0.85, 1.0, cyc));
  pos += drift * (normalize(aDir) * (0.2 + aSeq * 0.4) + n3 * 0.15) * det;

  // --- Dissolve: outward burst with a swirl
  float d = uDissolve * uDissolve * (3.0 - 2.0 * uDissolve);
  pos += aDir * d * (1.2 + aRandom * 3.2) * (1.0 + 0.6 * (drift + hood * step(1.5, aBright)));
  pos.x += sin(t * 1.3 + aRandom * 6.2831) * d * 0.35;
  pos.y += cos(t * 0.9 + aRandom * 6.2831) * d * 0.25;

  // Density slider: particles above the threshold are hidden (eyes always stay)
  if (eye < 0.5 && aRandom > uDensity) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vAlpha = 0.0;
    vBright = 0.0;
    vNeb = 0.0;
    vSeq = 0.0;
    vRand = 0.0;
    vAct = 0.0;
    return;
  }

  // --- Layer G: glitch — a few particles jump and flicker, then snap back
  float tick = floor(t * 4.0);
  float glitchOn = aGlitch * step(1.0 - 0.07 * uGlitchRate, hash12(vec2(tick, aRandom * 97.0)));
  vec3 jitter = vec3(
    hash12(vec2(tick, aRandom * 13.0)),
    hash12(vec2(aRandom * 7.0, tick)),
    hash12(vec2(tick * 3.0, aRandom * 29.0))
  ) - 0.5;
  pos += jitter * 0.3 * glitchOn;

  // --- Brightness: pulses, waves and state energy -------------------------
  float band = exp(-pow((position.y - uPulseY) * 2.8, 2.0)) * uPulseAmp;
  float wave = mod(t * 0.5, 4.6) - 1.9;
  float thinkWave = exp(-pow((position.y - wave) * 3.0, 2.0)) * uThink * 0.9 * (hood + drift);
  float flow = exp(-pow((position.x * 0.6 + position.y - (mod(t * 0.3, 3.2) - 1.3)) * 5.0, 2.0)) * 0.5 * face;
  float dm = length(position.xy - vec2(0.0, uMouthY));
  float rp = fract(t * 0.9);
  float speakRing = exp(-pow((dm - rp * 1.2) * 9.0, 2.0)) * (1.0 - rp) * uSpeak * (0.4 + uMouthOpen * 1.5) * (face + hood * 0.5);
  float listenRing = exp(-pow((rd - fract(t * 0.5) * 2.2) * 6.0, 2.0)) * uListen * 0.7 * hood;
  float boost = 1.0 + band + thinkWave + flow + speakRing + listenRing + glitchOn * 1.5;
  float bright = aBright * boost;

  vec3 crimson = vec3(1.0, 0.09, 0.27);
  vec3 deep = vec3(0.55, 0.0, 0.02);
  vec3 hot = vec3(1.0, 0.23, 0.19);
  vec3 pale = vec3(1.0, 0.54, 0.5);

  vec3 col;
  float alpha = 0.9;
  if (hood > 0.5) {
    col = mix(deep, crimson, 0.45 + 0.55 * aRandom);
    col = mix(col, hot, step(1.2, aBright) * 0.6);   // rim highlights
  } else if (face > 0.5) {
    col = mix(crimson, hot, aRandom * 0.5);
    bright *= 1.0 + uThink * brow * 0.9;             // neural activity at the brow
  } else if (dust > 0.5) {
    col = mix(deep, crimson, aRandom);
    alpha = 0.45 * (1.0 - smoothstep(0.85, 1.0, dc));
  } else if (eye > 0.5) {
    col = mix(crimson, pale, aRandom * 0.4);
    bright *= uEyeIntensity * 1.1;
  } else if (neb > 0.5) {
    col = deep;
    alpha = 0.05;
  } else if (drift > 0.5) {
    col = mix(crimson, hot, 0.5);
    alpha = 0.85 * (1.0 - det * 0.35);
  } else {                                           // energy node
    col = mix(hot, pale, aRandom * 0.6);
    bright *= (0.55 + 0.45 * sin(t * (1.5 + uNeural * 3.0) + aRandom * 40.0)) * (0.6 + uNeural * 1.2) * (1.0 + uThink * brow);
  }

  // State colour: listening cools toward pale, thinking lights the brow amber, speaking warms the mouth
  vec3 amber = vec3(1.0, 0.55, 0.12);
  float tintable = 1.0 - eye - neb;
  col = mix(col, pale, uListen * 0.35 * (face + hood * 0.6 + node) * tintable);
  col = mix(col, amber, clamp(uThink * (brow * (face + node) * 0.85 + thinkWave * 0.6), 0.0, 0.8) * tintable);
  float mouthGlow = exp(-dm * dm * 9.0) * face;
  col = mix(col, pale, uSpeak * (mouthGlow * 0.5 + speakRing * 0.4) * tintable);
  bright *= 1.0 + uSpeak * mouthGlow * (0.4 + uMouthOpen);

  // Particles fade in as they start moving, and fade slightly during dissolve
  alpha *= smoothstep(0.0, 0.05, p) * (1.0 - 0.45 * d);

  // Neural links / contours: show up late in formation, weaken first on dissolve
  float act = uNeural * (1.0 + 2.0 * uThink * brow * face);
  if (isLine) alpha *= smoothstep(0.72, 0.92, uForm) * (1.0 - d) * (1.0 - d);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);

  // Depth-aware glow: the far side of the figure is dimmer, which separates the layers in parallax
  float depthK = smoothstep(uCamDist + 1.8, uCamDist - 1.2, -mv.z);
  float depthMix = mix(0.35, 1.0, depthK);
  alpha *= mix(depthMix, 1.0, neb);
  bright *= mix(mix(0.6, 1.0, depthK), 1.0, neb);

  vColor = col;
  vAlpha = alpha;
  vBright = bright * uBrightness;
  vNeb = neb;
  vSeq = aSeq;
  vRand = aRandom;
  vAct = act;

  gl_Position = projectionMatrix * mv;
  float size = aSize * (1.0 + aBright * 0.12) * (1.0 + eye * uEyeIntensity * 0.3);
  gl_PointSize = min(size * uScale * uPixelRatio / max(-mv.z, 0.1), 220.0);
}
