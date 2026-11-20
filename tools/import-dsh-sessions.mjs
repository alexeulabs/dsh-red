#!/usr/bin/env node
/**
 * Import sessions from an official `dsh` home into this edition's home.
 *
 * Both editions write the same physical layout — `sessions/<projectKey>/<sessionId>/
 * session.v<N>.jsonl.zstd` — so a migration moves files rather than converting them.
 * Three properties of that layout make this safe:
 *
 * - The session list is a directory scan, so a copied session needs no registration.
 * - The session `cwd` is absolute and unchanged, so the project grouping is preserved.
 * - Attachments are content-addressed by SHA-256, so they are home-independent.
 *
 * Copy only, never move: the official installation keeps working and stays the source
 * of truth for any session this script has not seen yet.
 *
 * Usage:
 *   node tools/import-dsh-sessions.mjs --dry-run
 *   node tools/import-dsh-sessions.mjs
 *   node tools/import-dsh-sessions.mjs --from "C:\\Users\\me\\.dsh" --attachments-only
 */

import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Compressed session logs by format generation; the only encoding this edition reads. */
const SESSION_FILE = /^session\.v(\d+)\.jsonl\.zstd$/u
/** The current writer generation, mirrored from `SESSION_FORMAT_VERSION` for the report. */
const CURRENT_VERSION = 4

const args = parseArgs(process.argv.slice(2))
const targetHome = process.env.DSHS_HOME?.trim() || join(homedir(), '.dshs')
const sourceHome = args.from ?? join(homedir(), '.dsh')

/**
 * Read the command line.
 * @param {string[]} argv - Arguments after the script name.
 * @returns {{ from?: string, dryRun: boolean, sessionsOnly: boolean, attachmentsOnly: boolean }}
 */
function parseArgs(argv) {
  const parsed = { dryRun: false, sessionsOnly: false, attachmentsOnly: false }
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === '--dry-run') parsed.dryRun = true
    else if (value === '--sessions-only') parsed.sessionsOnly = true
    else if (value === '--attachments-only') parsed.attachmentsOnly = true
    else if (value === '--from') {
      const next = argv[++index]
      if (next === undefined || next.startsWith('--')) throw new Error('--from needs a directory')
      parsed.from = next
    } else if (value === '--help' || value === '-h') {
      process.stdout.write(
        '用法: node tools/import-dsh-sessions.mjs [选项]\n\n'
        + '  --from <目录>        源 home，默认为 ~/.dsh\n'
        + '  --dry-run            只报告将要复制的会话与附件，不写文件\n'
        + '  --sessions-only      只迁移会话\n'
        + '  --attachments-only   只迁移附件\n',
      )
      process.exit(0)
    } else throw new Error(`无法识别的参数: ${value}`)
  }
  return parsed
}

/**
 * Find the newest format generation a session directory holds.
 *
 * A session upgraded across a format boundary keeps its predecessor file beside the
 * current one. Copying both would list the same session twice, so only the highest
 * generation is selected. Uncompressed `.jsonl` logs are deliberately ignored: the
 * storage layer refuses a root that mixes compressed and uncompressed generations.
 * @param {string} directory - Session directory to inspect.
 * @returns {Promise<{ version: number, name: string } | undefined>} Chosen log, when present.
 */
async function newestLog(directory) {
  const names = await readdir(directory).catch(() => [])
  let chosen
  for (const name of names) {
    const match = SESSION_FILE.exec(name)
    if (match === null) continue
    const version = Number(match[1])
    if (chosen === undefined || version > chosen.version) chosen = { version, name }
  }
  return chosen
}

/**
 * Collect every session the source home holds.
 * @param {string} root - Source sessions root.
 * @returns {Promise<{ project: string, id: string, log: string, version: number, bytes: number }[]>}
 */
async function collectSessions(root) {
  const found = []
  const projects = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDirectory = join(root, project.name)
    const sessions = await readdir(projectDirectory, { withFileTypes: true }).catch(() => [])
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const directory = join(projectDirectory, session.name)
      const log = await newestLog(directory)
      if (log === undefined) continue
      const path = join(directory, log.name)
      const { size } = await stat(path)
      found.push({ project: project.name, id: session.name, log: log.name, version: log.version, bytes: size, path })
    }
  }
  return found
}

/**
 * Copy each session log that the target does not already hold.
 * @param {Awaited<ReturnType<typeof collectSessions>>} sessions - Sessions to copy.
 * @param {string} root - Target sessions root.
 * @returns {Promise<{ copied: number, skipped: number, bytes: number }>}
 */
async function copySessions(sessions, root) {
  let copied = 0
  let skipped = 0
  let bytes = 0
  for (const session of sessions) {
    const destination = join(root, session.project, session.id, session.log)
    if (existsSync(destination)) {
      skipped++
      continue
    }
    if (!args.dryRun) {
      await mkdir(join(root, session.project, session.id), { recursive: true })
      await cp(session.path, destination)
    }
    copied++
    bytes += session.bytes
  }
  return { copied, skipped, bytes }
}

/**
 * Copy the content-addressed attachment store. Names are SHA-256 digests, so an
 * existing file is the same object and overwriting it is harmless.
 * @param {string} source - Source attachments root.
 * @param {string} target - Target attachments root.
 * @returns {Promise<{ files: number, bytes: number } | undefined>}
 */
async function copyAttachments(source, target) {
  if (!existsSync(source)) return undefined
  const entries = await readdir(source, { recursive: true, withFileTypes: true })
  let files = 0
  let bytes = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    files++
    bytes += (await stat(join(entry.parentPath, entry.name)).catch(() => ({ size: 0 }))).size
  }
  if (!args.dryRun) await cp(source, target, { recursive: true, force: true })
  return { files, bytes }
}

/** Human-readable size. */
function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const sessionsSource = join(sourceHome, 'sessions')
const attachmentsSource = join(sourceHome, 'attachments')

console.log(`源:   ${sourceHome}`)
console.log(`目标: ${targetHome}${args.dryRun ? '   [dry-run，不写文件]' : ''}\n`)

if (!existsSync(sourceHome)) {
  console.error(`找不到源 home: ${sourceHome}`)
  process.exit(1)
}

if (!args.attachmentsOnly) {
  if (!existsSync(sessionsSource)) {
    console.log('源没有 sessions 目录，跳过会话迁移。')
  } else {
    const sessions = await collectSessions(sessionsSource)
    const legacy = sessions.filter(session => session.version < CURRENT_VERSION)
    const result = await copySessions(sessions, join(targetHome, 'sessions'))
    console.log(`会话: 共 ${sessions.length} 个`)
    console.log(`  ${args.dryRun ? '将复制' : '已复制'} ${result.copied} 个 (${megabytes(result.bytes)})`)
    if (result.skipped > 0) console.log(`  跳过 ${result.skipped} 个（目标已存在）`)
    if (legacy.length > 0) {
      console.log(`  其中 ${legacy.length} 个是旧格式（v${legacy.map(s => s.version).sort()[0]}），运行时会在打开时升级`)
    }
  }
}

if (!args.sessionsOnly) {
  const result = await copyAttachments(attachmentsSource, join(targetHome, 'attachments'))
  if (result === undefined) console.log('\n源没有 attachments 目录，跳过附件迁移。')
  else {
    console.log(`\n附件: ${result.files} 个文件 (${megabytes(result.bytes)})`)
    console.log(`  ${args.dryRun ? '将复制' : '已复制'}到 ${join(targetHome, 'attachments')}`)
  }
}

console.log('\n完成。原 home 未被修改；重复运行只补缺失项。')
