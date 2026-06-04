import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // node-sdk is a runtime dependency — never bundle it in.
  external: ['@larksuiteoapi/node-sdk'],
});
