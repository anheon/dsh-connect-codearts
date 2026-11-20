import { readFileSync } from 'node:fs'
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-connect-codearts'

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string

const VERSION_DEFINE = { __DSH_CODEARTS_VERSION__: JSON.stringify(PACKAGE_VERSION) }

/**
 * `react-dom` and `react-dom/client` MUST stay external.
 *
 * The shell registers them in its module loader, so externalizing turns the
 * import into a `require` the page resolves. Bundling inlines the development
 * and production CJS builds, both of which open with
 *   if (process.env.NODE_ENV !== "production") …
 * which throws `ReferenceError: process is not defined` in the browser — at
 * module-evaluation time, so the ENTIRE client half fails to import and the
 * web boot reports "1 entry did not activate".
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

export default [
  {
    entry: {
      index: 'src/index.ts',
      bin: 'src/bin.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    define: VERSION_DEFINE,
    deps: {
      /**
       * Every host package stays external so the plugin borrows the DSH
       * installation's copies instead of carrying its own.
       *
       * The `bin` entry shares one chunk with `index`, so a static import of an
       * entry from this list is fine for `index` (always loaded inside a booted
       * host, where the app-boot interception layer supplies the package) but
       * is a LOAD-TIME crash for `bin`, which `dsh plugin … exec` runs under
       * stock Node resolution in a profile whose peers are never installed
       * (`autoInstallPeers: false`). Code reachable from `bin.ts` must
       * therefore import peers through `import()` at call time.
       */
      neverBundle: [
        '@earendil-works/pi-ai',
        '@deepseek-ai/schemastery',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-home-paths',
        '@deepseek-ai/dsh-host-webserver',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-llm-pi-ai',
        '@deepseek-ai/dsh-settings',
      ],
    },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    clean: false,
    define: VERSION_DEFINE,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
