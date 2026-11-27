#!/usr/bin/env node
/**
 * Redteam environment preflight.
 *
 * The bundled redteam skills assume a prepared Linux penetration workstation:
 * absolute `/usr/bin/*` binaries, an X display, systemd services, and API keys.
 * This script reports, per skill, whether those premises hold on the machine
 * running DSH Special, so a missing toolchain surfaces before an engagement
 * instead of midway through one.
 *
 * Usage: node scripts/redteam-preflight.mjs [--json]
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const DSH_HOME = process.env.DSHS_HOME?.trim() || join(homedir(), '.dshs')
const IS_WINDOWS = platform() === 'win32'

/** Binaries the bundled skills invoke, with the skill families that need them. */
const BINARIES = [
  { name: 'nmap', skill: 'active-scan / recon-pipeline', args: ['--version'] },
  { name: 'nuclei', skill: 'nuclei-scan / recon-pipeline', args: ['-version'] },
  { name: 'sqlmap', skill: 'unauth-exploit', args: ['--version'] },
  { name: 'fscan', skill: 'fscan-intranet', args: ['-h'] },
  { name: 'gogo', skill: 'gogo-intranet', args: ['-h'] },
  { name: 'chisel', skill: 'chisel-tunnel', args: ['--version'] },
  { name: 'frpc', skill: 'frp-tunnel', args: ['--version'] },
  { name: 'hashcat', skill: 'credential-attack', args: ['--version'] },
  { name: 'john', skill: 'credential-attack', args: ['--version'] },
  { name: 'msfconsole', skill: 'shell-handler', args: ['--version'] },
  { name: 'nc', skill: 'shell-handler', args: ['-h'] },
  { name: 'curl', skill: 'passive-recon / web-fingerprint', args: ['--version'] },
  { name: 'dig', skill: 'passive-recon', args: ['-v'] },
  { name: 'chromium', skill: 'browser-automation', args: ['--version'] },
  { name: 'tshark', skill: 'REA traffic analysis', args: ['-v'] },
]

/** Local services the browser skills expect to be reachable. */
const ENDPOINTS = [
  { name: 'Kimi WebBridge', host: '127.0.0.1', port: 10086, skill: 'kimi-webbridge' },
]

/** Configuration values an engagement needs; empty means unset. */
const SETTINGS = ['FOFA_KEY', 'REDTEAM_VPS_HOST', 'REDTEAM_VPS_USER']

function run(command, args) {
  try {
    const out = execFileSync(command, args, {
      encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'],
      // Windows resolves .cmd/.bat shims only through a shell.
      shell: IS_WINDOWS,
    })
    return { ok: true, detail: out.split('\n')[0]?.trim().slice(0, 60) ?? '' }
  } catch {
    return { ok: false, detail: '' }
  }
}

function readDotEnv() {
  const path = join(DSH_HOME, '.env')
  const values = {}
  if (!existsSync(path)) return values
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
  }
  return values
}

function wslDistros() {
  if (!IS_WINDOWS) return []
  try {
    const out = execFileSync('wsl', ['--list', '--quiet'], {
      encoding: 'utf16le', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split(/\r?\n/).map(line => line.replace(/\0/g, '').trim()).filter(Boolean)
  } catch {
    return []
  }
}

function checkBinaries() {
  return BINARIES.map(entry => {
    const found = run(entry.name, entry.args)
    return { ...entry, available: found.ok, detail: found.detail }
  })
}

function checkEndpoints() {
  return ENDPOINTS.map(entry => {
    // A bound loopback port answers a TCP connect; no protocol handshake is attempted.
    const probe = run(process.execPath, ['-e', `
      const net = require('node:net')
      const socket = net.connect(${entry.port}, '${entry.host}')
      socket.setTimeout(1500)
      socket.on('connect', () => { socket.destroy(); process.exit(0) })
      socket.on('timeout', () => { socket.destroy(); process.exit(1) })
      socket.on('error', () => process.exit(1))
    `])
    return { ...entry, available: probe.ok }
  })
}

function checkLinuxRuntime() {
  if (!IS_WINDOWS) {
    return { label: 'Linux runtime', available: true, detail: 'native platform' }
  }
  const distros = wslDistros().filter(name => !/^docker-desktop$/.test(name))
  if (distros.length === 0) {
    return { label: 'Linux runtime', available: false, detail: 'WSL has no distribution besides docker-desktop' }
  }
  // The skills call absolute Linux paths, so the check runs inside the default distro.
  const probe = run('wsl', ['-e', 'sh', '-c', 'test -x /usr/bin/nuclei || test -x /usr/bin/nmap; echo $?'])
  return {
    label: 'Linux runtime',
    available: distros.length > 0,
    detail: `${distros.join(', ')}${probe.detail === '0' ? ' (tools present)' : ' (no pentest tools inside)'}`,
  }
}

function groups(rows) {
  const ready = rows.filter(row => row.available)
  const missing = rows.filter(row => !row.available)
  return { ready, missing }
}

const binaries = checkBinaries()
const endpoints = checkEndpoints()
const linux = checkLinuxRuntime()
const env = readDotEnv()
const settings = SETTINGS.map(name => ({ name, set: (env[name] ?? process.env[name] ?? '') !== '' }))

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ dshHome: DSH_HOME, platform, linux, binaries, endpoints, settings }, null, 2))
} else {
  const binaryGroups = groups(binaries)
  const endpointGroups = groups(endpoints)
  const missingSettings = settings.filter(item => !item.set)

  console.log(`DSH Special 渗透环境自检  (${platform()}, ${DSH_HOME})\n`)

  console.log('== 执行环境 ==')
  console.log(`  ${linux.available ? '✓' : '✗'} ${linux.label}: ${linux.detail}`)

  console.log('\n== 工具链 ==')
  for (const row of binaries) {
    console.log(`  ${row.available ? '✓' : '✗'} ${row.name.padEnd(12)} ${row.available ? row.detail : `缺失 — ${row.skill}`}`)
  }

  console.log('\n== 本地服务 ==')
  for (const row of endpoints) {
    console.log(`  ${row.available ? '✓' : '✗'} ${row.name.padEnd(16)} ${row.available ? 'online' : `未监听 — ${row.skill}`}`)
  }

  console.log('\n== 外部配置 ==')
  for (const item of settings) console.log(`  ${item.set ? '✓' : '✗'} ${item.name}`)

  const blocked = binaryGroups.missing.length
  console.log(`\n== 结论 ==`)
  console.log(`  工具 ${binaryGroups.ready.length}/${binaries.length} 可用，服务 ${endpointGroups.ready.length}/${endpoints.length} 在线，配置 ${settings.length - missingSettings.length}/${settings.length} 已填`)
  if (blocked > 0) {
    console.log(`  ${blocked} 个工具缺失：相关技能会失败或让模型自行找替代方案。`)
    console.log('  安装方式见 README 的「环境准备」一节。')
  } else {
    console.log('  工具链齐备，技能的前置条件满足。')
  }
}
