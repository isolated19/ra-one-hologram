import { hoodPoint, hoodFrontPoint, openingEdge, openingE, foldCrest } from './HoodGeometry.js';
import { faceDepth, faceHalfWidth } from './FaceParticles.js';

/**
 * Structural contour polylines drawn as thin luminous lines (part of Layer C).
 * Each entry: { points: [[x, y, z], ...], kind: 0 hood | 1 face, bright }.
 */
export function buildContours() {
  const lines = [];

  // Opening lip (outer) and where the fabric turns inward (inner) — two lines with depth between
  const outer = openingEdge(70, 1.01).map(([x, y]) => hoodFrontPoint(x, y, 1));
  const inner = openingEdge(70, 0.99).map(([x, y]) => hoodFrontPoint(x * 0.97, y, 0.86));
  lines.push({ points: outer, kind: 0, bright: 1.6 });
  lines.push({ points: inner, kind: 0, bright: 0.7 });

  // Fold crests running down the hood, skipping the face opening
  for (let k = 0; k < 14; k++) {
    const a0 = (k / 14) * Math.PI * 2 + 0.2;
    let run = [];
    for (let i = 0; i <= 40; i++) {
      const h = 0.05 + (i / 40) * 0.85;
      // follow the nearest crest of the fold pattern as it twists with height
      let a = a0;
      let best = -1;
      for (let s = -6; s <= 6; s++) {
        const c = foldCrest(a0 + s * 0.03, h);
        if (c > best) { best = c; a = a0 + s * 0.03; }
      }
      const p = hoodPoint(h, a, 1.004);
      const open = p[2] > 0 && openingE(p[0], p[1]) < 1.05;
      if (open) {
        if (run.length > 2) lines.push({ points: run, kind: 0, bright: 0.55 });
        run = [];
      } else {
        run.push(p);
      }
    }
    if (run.length > 2) lines.push({ points: run, kind: 0, bright: 0.55 });
  }

  const onFace = (x, y, lift = 0.006) => {
    const z = faceDepth(x, y);
    return z === null ? null : [x, y, z + lift];
  };
  const faceLine = (pts, bright) => {
    const points = pts.filter(Boolean);
    if (points.length > 2) lines.push({ points, kind: 1, bright });
  };

  // Jawline: both sides of the outline, joined under the chin
  const jaw = [];
  for (let i = 0; i <= 30; i++) {
    const y = 0.15 - (i / 30) * 0.99;
    jaw.push(onFace(-faceHalfWidth(y) * 0.95, y));
  }
  for (let i = 30; i >= 0; i--) {
    const y = 0.15 - (i / 30) * 0.99;
    jaw.push(onFace(faceHalfWidth(y) * 0.95, y));
  }
  faceLine(jaw, 0.55);

  // Brow ridge, nose bridge, cheekbones
  faceLine(Array.from({ length: 25 }, (_, i) => {
    const x = -0.42 + (i / 24) * 0.84;
    return onFace(x, 0.45 - 0.03 * Math.abs(x) * 2);
  }), 1.0);
  faceLine(Array.from({ length: 16 }, (_, i) => onFace(0, 0.38 - (i / 15) * 0.6)), 0.9);
  for (const side of [-1, 1]) {
    faceLine(Array.from({ length: 12 }, (_, i) => {
      const t = i / 11;
      return onFace(side * (0.2 + t * 0.3), -0.06 + t * 0.12 - t * t * 0.04);
    }), 0.8);
  }
  return lines;
}
