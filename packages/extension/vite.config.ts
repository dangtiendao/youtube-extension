import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = process.env.BUILD_TARGET === 'web' ? 'web' : 'ext';

export default defineConfig({
  plugins: [react()],
  base: './',
  root: __dirname,
  build: {
    outDir: target === 'web' ? 'dist-web' : 'dist-ext',
    emptyOutDir: true,
    rollupOptions: {
      input:
        target === 'web'
          ? { index: path.resolve(__dirname, 'index.html') }
          : { sidepanel: path.resolve(__dirname, 'sidepanel.html') },
    },
  },
});
