import { describe, expect, it, vi } from 'vitest';
import { FaceEmotionTracker } from '../src/vision/FaceEmotionTracker.js';

const dims = { videoWidth: 320, videoHeight: 240 };

function detection({ x = 140, y = 100, expr = { neutral: 1 } } = {}) {
  return { detection: { box: { x, y, width: 40, height: 40 } }, expressions: expr };
}

describe('FaceEmotionTracker._ingest', () => {
  it('maps the face box to mirrored screen space', () => {
    const t = new FaceEmotionTracker();
    // Face on the image's left → the user's right → look right (+x)
    t._ingest(detection({ x: 0, y: 100 }), 0, dims);
    expect(t.current.present).toBe(true);
    expect(t.current.x).toBeGreaterThan(0.7);
    expect(Math.abs(t.current.y)).toBeLessThan(0.1);
  });

  it('fires "emotion" only after the expression holds steady', () => {
    const t = new FaceEmotionTracker({ smoothing: 1, holdMs: 1000 });
    const onEmotion = vi.fn();
    t.on('emotion', onEmotion);
    const sad = detection({ expr: { sad: 0.9, neutral: 0.1 } });
    t._ingest(sad, 0, dims);
    t._ingest(sad, 500, dims);
    expect(onEmotion).not.toHaveBeenCalled();
    t._ingest(sad, 1100, dims);
    expect(onEmotion).toHaveBeenCalledWith(expect.objectContaining({ emotion: 'sad', previous: 'neutral' }));
    expect(t.stableEmotion).toBe('sad');
  });

  it('keeps the face present through a brief miss, drops it after a long one', () => {
    const t = new FaceEmotionTracker();
    t._ingest(detection(), 0, dims);
    t._ingest(undefined, 800, dims);
    expect(t.current.present).toBe(true);
    t._ingest(undefined, 2000, dims);
    expect(t.current.present).toBe(false);
  });

  it('mood() is null while the camera is off', () => {
    const t = new FaceEmotionTracker();
    t._ingest(detection(), 0, dims);
    expect(t.mood()).toBeNull();
    t.active = true;
    expect(t.mood()).toEqual(expect.objectContaining({ present: true, emotion: 'neutral' }));
  });
});
