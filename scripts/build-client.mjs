#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { PACKAGE_NAME } from '../src/shared/wire.js'

const root = new URL('../', import.meta.url)
const dist = new URL('dist/', root)
const { outputFiles: [client] } = await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ['src/client/index.js'],
  bundle: true,
  format: 'iife',
  globalName: 'BTW',
  target: 'es2022',
  charset: 'utf8',
  legalComments: 'none',
  write: false,
})

const factory = `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(PACKAGE_NAME)},\n  factory(require) {\n${client.text}\n    return { inject: BTW.inject, apply: ctx => BTW.mountClient(ctx, require('react')) };\n  },\n});\n`
mkdirSync(dist, { recursive: true })
writeFileSync(new URL('client.js', dist), factory)
