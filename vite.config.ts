import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds one self-contained index.html: works from GitHub Pages and offline
// by double-clicking the downloaded file.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  worker: { format: 'es' },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
