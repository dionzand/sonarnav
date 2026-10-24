import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths: works at a domain root and under GitHub Pages' /sonarnav/.
  base: './',
  // --host exposes the dev server on the LAN (for quick phone checks of the layout).
  server: { port: 5173, open: false },
  test: { include: ['tests/**/*.test.ts'] },
} as any);
