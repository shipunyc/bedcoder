import { defineConfig } from 'tsup';

// Bundle the CLI into a single self-contained dist/index.js with a Node shebang,
// so it can be published to npm and installed globally as `bedcoder`.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  dts: false,
  // Inline only the unpublished workspace protocol. Everything else (incl. its
  // deps zod / @msgpack/msgpack / tweetnacl) stays external and is declared in
  // dependencies — bundling tweetnacl breaks its require('crypto') under ESM.
  noExternal: ['@bedcoder/protocol'],
  banner: { js: '#!/usr/bin/env node' },
});
