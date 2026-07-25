#!/usr/bin/env node
'use strict'

const ospath = require('node:path')
const {
  createServer,
  createRebuildQueue,
  getWatchPaths,
  watchPaths,
} = require('../lib/serve.js')

async function main (argv = process.argv.slice(2)) {
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
    printHelp()
    return 0
  }
  if (argv.includes('-V') || argv.includes('--version')) {
    const { version } = require('../package.json')
    process.stdout.write(`@antora-supplemental/serve ${version}\n`)
    return 0
  }

  const { playbookFile, port, passthrough } = parseArgs(argv)
  if (!playbookFile) {
    process.stderr.write('antora-serve: missing playbook file\n')
    printHelp()
    return 1
  }

  const playbookPath = ospath.resolve(playbookFile)
  const playbookDir = ospath.dirname(playbookPath)

  let buildPlaybook
  let userRequire
  try {
    buildPlaybook = require('@antora/playbook-builder')
    userRequire = require('@antora/user-require-helper')
  } catch (err) {
    process.stderr.write(
      'antora-serve: peer dependency missing. Install antora (or @antora/playbook-builder + @antora/site-generator) in this project.\n'
    )
    process.stderr.write(String(err.message) + '\n')
    return 1
  }

  const userRequireContext = { dot: playbookDir, paths: [playbookDir, __dirname] }
  const args = [...passthrough, '--playbook', playbookPath]

  let generator = '@antora/site-generator'
  let generatorPath
  let playbook
  try {
    playbook = buildPlaybook(args, process.env, buildPlaybook.defaultSchema, (config) => {
      try {
        generator = config.get('antora.generator') || generator
        generatorPath = userRequire.resolve(generator, userRequireContext)
      } catch (_) {}
    })
  } catch (err) {
    process.stderr.write(`antora-serve: failed to build playbook: ${err.message}\n`)
    return 1
  }

  // Ensure playbook.file is set for watchers (playbook-builder may use different keys).
  if (!playbook.file) playbook.file = playbookPath

  let generateSite
  try {
    const mod = require(generatorPath || userRequire.resolve(generator, userRequireContext))
    generateSite = mod.length === 1 ? mod.bind(null, playbook) : mod.bind(null, args, process.env)
  } catch (err) {
    process.stderr.write(`antora-serve: generator not found (${generator}). ${err.message}\n`)
    return 1
  }

  const outputDir = ospath.resolve(playbook.dir || playbookDir, playbook.output?.dir || 'build/site')
  const log = (msg) => process.stdout.write(`[antora-serve] ${msg}\n`)
  const logErr = (msg) => process.stderr.write(`[antora-serve] ${msg}\n`)

  const runGenerate = async () => {
    const started = Date.now()
    log('Generating site…')
    try {
      await generateSite()
      log(`Generate ok (${Date.now() - started}ms)`)
      return true
    } catch (err) {
      logErr(`Generate failed; keeping previous output. ${err.message || err}`)
      return false
    }
  }

  const ok = await runGenerate()
  if (!ok && !fsExists(outputDir)) {
    logErr('Initial generate failed and no output directory exists. Exiting.')
    return 1
  }

  const server = createServer(outputDir)
  const queue = createRebuildQueue(async () => {
    const success = await runGenerate()
    if (success) server.bumpReload()
  })

  const paths = getWatchPaths(playbook)
  log(`Watching ${paths.length} path(s):`)
  for (const p of paths) log(`  - ${p}`)

  const stopWatching = watchPaths(paths, () => queue.kick(), 600)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => {
      log(`Serving http://localhost:${port}/ (SSE live reload). Ctrl+C to stop.`)
      resolve()
    })
  })

  const shutdown = () => {
    stopWatching()
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Keep event loop alive
  await new Promise(() => {})
}

function parseArgs (argv) {
  let port = 5252
  let playbookFile
  const passthrough = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-p' || a === '--port') {
      port = Number(argv[++i]) || 5252
    } else if (a.startsWith('--port=')) {
      port = Number(a.slice(7)) || 5252
    } else if (a === '--') {
      passthrough.push(...argv.slice(i + 1))
      break
    } else if (a.startsWith('-') && a !== '-') {
      // Forward unknown flags to playbook-builder / generator (e.g. --fetch, --stacktrace)
      passthrough.push(a)
      const next = argv[i + 1]
      if (next && !next.startsWith('-') && !looksLikePlaybook(next)) {
        passthrough.push(next)
        i++
      }
    } else if (!playbookFile) {
      playbookFile = a
    } else {
      passthrough.push(a)
    }
  }
  return { playbookFile, port, passthrough }
}

function looksLikePlaybook (s) {
  return /\.(ya?ml|json|json5|toml|cjs|js)$/i.test(s)
}

function printHelp () {
  process.stdout.write(`Usage: antora-serve <playbook> [options] [-- antora-options]

Generate an Antora site, serve it locally, rebuild when local content/UI files
change, and live-reload the browser (SSE).

Options:
  -p, --port <port>   HTTP port (default: 5252)
  -h, --help          Show help
  -V, --version       Show version

Any other flags are forwarded to Antora (e.g. --fetch, --stacktrace, -a attr=value).

Only local content sources (filesystem / worktree URLs) are watched. Remote
https:// git sources are not polled — that is intentional for this tool.
`)
}

function fsExists (p) {
  try {
    require('node:fs').accessSync(p)
    return true
  } catch {
    return false
  }
}

module.exports = { main, parseArgs }

if (require.main === module) {
  main().then(
    (code) => {
      if (typeof code === 'number' && code !== 0) process.exit(code)
    },
    (err) => {
      console.error(err)
      process.exit(1)
    }
  )
}
