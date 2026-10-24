/**
 * Dynamic Web Client bundle for the dsh-intellij-git plugin.
 *
 * The DSH Client loads plugin bundles through the shell-owned module loader, so
 * the artifact hands its factory to `window.__ModuleLoader__.load` instead of
 * exporting an ES module. React and its JSX runtimes stay external because the
 * loader owns those instances; inlining a second copy would break hooks.
 *
 * `process.env.NODE_ENV` is substituted because an inlined dependency reads it
 * and a browser bundle has no `process`; without the define the factory throws
 * `ReferenceError: process is not defined` at boot and the whole client half
 * fails to activate.
 */
import { defineConfig } from 'tsdown'

/** Package name; must equal the loader id and `package.json` `name`. */
const PLUGIN_ID = 'dsh-intellij-git'

/** Specifiers left to the shell's preloaded module table. */
const EXTERNAL = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

export default defineConfig({
  name: PLUGIN_ID,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { neverBundle: EXTERNAL },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
