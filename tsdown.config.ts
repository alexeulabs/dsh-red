import { globSync } from 'node:fs'
import { defineConfig } from 'tsdown'
import { decoratorPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'
import { workspacePackageGlobs } from './scripts/workspace-package-globs.ts'

/**
 * Vendored packages that ship their own finalized runtime under `lib/` and must
 * not be re-bundled by the workspace build. `dsh-purge-safe` upstream publishes
 * plain JavaScript with no TypeScript source, so a tsdown pass would rewrite its
 * `lib/index.js` entry and leave the rest of its modules unreachable.
 */
const PREBUILT_VENDOR = new Set(['vendor/dsh-purge-safe'])

function isBuildFaceClient(value: unknown): boolean {
  if (value === undefined || value === 'host') return false
  if (value === 'client') return true
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

/**
 * The ordinary workspace build consumes JavaScript emitted by the Host
 * TypeScript project after source-only Typert generation. The Client pass selects packages that
 * declare a browser bundle and lets their package-local configs emit both
 * their Node loader entry and browser artifact. `apps/desktop` bundles after
 * this pass (root package.json `build:lib:host`): its main bundle inlines
 * workspace devDependencies from their lib/ output, and tsdown builds
 * workspace members concurrently without ordering them.
 */
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  const packages = workspacePackageGlobs(globSync(['vendor/*/package.json', 'packages/*/*/package.json'], { cwd: import.meta.dirname }))
  return {
    workspace: [...packages.filter(dir => !PREBUILT_VENDOR.has(dir)), 'apps/cli', ...client ? [] : ['apps/desktop-host']],
    entry: client ? '' : ['lib/types/{index,startup}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: client ? [] : [decoratorPlugin()],
  }
})
