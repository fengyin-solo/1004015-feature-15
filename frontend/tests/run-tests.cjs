#!/usr/bin/env node
/**
 * 轻量测试入口：项目不引入额外测试框架，直接用已有的 esbuild 把 tests/ 即时打包，
 * 再交给 Node 执行断言。新增 spec 文件时在 entryPoints 里加一行即可。
 */
const { build } = require('esbuild')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trenchless-tests-'))

async function main() {
  await build({
    entryPoints: [
      path.join(root, 'tests/shim.ts'),
      path.join(root, 'tests/trenchless.spec.ts'),
    ],
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { '@': path.join(root, 'src') },
    outdir: outDir,
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning',
  })
  const spec = path.join(outDir, 'trenchless.spec.mjs')
  try {
    execFileSync(process.execPath, [spec], { stdio: 'inherit' })
  } catch {
    process.exitCode = 1
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
