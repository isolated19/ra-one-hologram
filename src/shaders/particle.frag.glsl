// uPoints = 1 for particle sprites, 0 for neural-link line segments
uniform float uPoints;
uniform float uTime;
uniform float uSpeed;
uniform float uNeural;

varying vec3 vColor;
varying float vAlpha;
varying float vBright;
varying float vNeb;
varying float vSeq;
varying float vRand;
varying float vAct;

void main() {
  if (uPoints < 0.5) {
    // Neural link: energy pulses travel along the segment, faster and brighter with activity
    float w = fract(uTime * uSpeed * (0.16 + 0.5 * uNeural) + vRand);
    float glow = exp(-pow((vSeq - w) * 7.0, 2.0));
    float a = vAlpha * (0.18 + (0.5 + vAct) * glow) * 0.3;
    gl_FragColor = vec4(vColor * vBright * (0.7 + glow), a);
    return;
  }

  vec2 uv = gl_PointCoord - 0.5;
  float r = length(uv);
  if (r > 0.5) discard;

  if (vNeb > 0.5) {
    // Nebula: soft procedural clouds
    float n = fbm(vec3(gl_PointCoord * 3.0, uTime * 0.04 * uSpeed));
    float halo = smoothstep(0.5, 0.0, r);
    float a = halo * smoothstep(0.38, 0.72, n) * vAlpha;
    gl_FragColor = vec4(vColor * (0.6 + n) * vBright, a);
    return;
  }

  // Sprite: hot core plus a soft halo, additive
  float core = exp(-r * r * 46.0);
  float halo = smoothstep(0.5, 0.0, r) * 0.35;
  float a = (core + halo) * vAlpha;
  vec3 col = vColor * vBright * (core * 1.6 + halo * 0.7);
  gl_FragColor = vec4(col, a);
}
