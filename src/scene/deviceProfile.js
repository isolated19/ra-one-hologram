/**
 * Picks the starting graphics preset from what the machine can actually do.
 *
 *   probeDevice()                       → { webgl, software, gpu, memory, cores, mobile }
 *   choosePreset(profile, { forced, saved }) → 'high' | 'medium' | 'low' | 'minimal'
 *
 * "software" means WebGL works but runs on the CPU (no GPU, blocklisted driver,
 * remote desktop, VM): SwiftShader, llvmpipe, WARP / Microsoft Basic Render.
 * Those machines get the Minimal preset; without WebGL the app runs in 2D lite mode.
 */
export const QUALITY_ORDER = ['high', 'medium', 'low', 'minimal'];

const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|software|basic render|\bwarp\b|mesa offscreen/i;
const INTEGRATED_GPU = /intel|uhd|iris|hd graphics|mali|adreno|powervr/i;

function release(gl) {
  try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* ignore */ }
}

export function probeDevice({ nav = navigator, doc = document, mobile = false } = {}) {
  const profile = {
    webgl: false,
    software: false,
    gpu: '',
    memory: nav.deviceMemory ?? 4,
    cores: nav.hardwareConcurrency ?? 4,
    mobile,
  };
  try {
    const gl = doc.createElement('canvas').getContext('webgl2') || doc.createElement('canvas').getContext('webgl');
    if (!gl) return profile;
    profile.webgl = true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    profile.gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    // The browser refuses this flag when it would fall back to CPU rendering
    const strict = doc.createElement('canvas').getContext('webgl', { failIfMajorPerformanceCaveat: true });
    profile.software = !strict || SOFTWARE_GPU.test(profile.gpu);
    release(strict);
    release(gl);
  } catch { /* treat as no WebGL */ }
  return profile;
}

export function choosePreset(profile, { forced, saved } = {}) {
  if (QUALITY_ORDER.includes(forced)) return forced;
  if (QUALITY_ORDER.includes(saved)) return saved;
  if (!profile.webgl || profile.software) return 'minimal';
  if (profile.memory <= 2 || profile.cores <= 2) return 'minimal';
  if (profile.mobile || INTEGRATED_GPU.test(profile.gpu)) return 'low';
  if (profile.memory < 8 || profile.cores < 4) return 'low';
  return 'medium';
}
