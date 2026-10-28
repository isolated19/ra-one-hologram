import { defineConfig } from 'vite';

/** Faster cold starts: pre-bundle Three.js + postprocessing once. */
export default defineConfig({
  server: {
    port: 5173,
    strictPort: false,
  },
  // Production builds call their own origin (see src/api/config.js); forward to the backend
  preview: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
  optimizeDeps: {
    include: [
      'three',
      'three/addons/postprocessing/EffectComposer.js',
      'three/addons/postprocessing/RenderPass.js',
      'three/addons/postprocessing/UnrealBloomPass.js',
      'three/addons/postprocessing/OutputPass.js',
      'three/addons/postprocessing/ShaderPass.js',
      'three/addons/postprocessing/SMAAPass.js',
      'three/addons/shaders/VignetteShader.js',
    ],
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
