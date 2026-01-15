import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";

const packageJson = require('./package.json')
const config = require('./src/plugin.config');

export default defineConfig({
  plugins: [vue()],
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/main.ts"),
      name: "CiderImmerSync",
      formats: ["es"],
      fileName: () => "plugin.js",
    },
    rollupOptions: {
      external: [],
      output: {
        exports: 'default',
      },
    },
    outDir: "dist/me.stormy.immer-sync",
    emptyOutDir: true,
    minify: false, // Keep readable for debugging
  },
  define: {
    'process.env': JSON.stringify({
      cider: '2',
    }),
    'cplugin': {
      ce_prefix: packageJson?.plugin?.ce_prefix || 'mce',
      identifier: packageJson?.plugin?.identifier || 'mce',
    },
  }
})