import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths: the build works from any subfolder,
  // e.g. https://user.github.io/dom-lab/, with no extra config.
  base: './',
  build: {
    // CodeMirror (editor + HTML, CSS and JS parsers) is ~200 kB gzipped
    chunkSizeWarningLimit: 800,
  },
});
