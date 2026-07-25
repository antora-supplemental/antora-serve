'use strict'

const fs = require('node:fs')
const http = require('node:http')
const ospath = require('node:path')

const RELOAD_ENDPOINT = '/__antora_reload'
const RELOAD_SCRIPT = `<script>(function(){
  var es = new EventSource('${RELOAD_ENDPOINT}');
  es.onmessage = function(){ location.reload(); };
  es.onerror = function(){ /* browser reconnects */ };
})();</script>`

const WATCH_EXT = /\.(adoc|asciidoc|yml|yaml|css|js|hbs|html|md|json|json5)$/i
const IGNORE_DIR_PARTS = new Set(['.git', 'node_modules', '.cache', 'build'])

/**
 * Collect local filesystem paths from the playbook that should be watched.
 * Skips remote git URLs. Honors start_path and start_paths.
 */
function getWatchPaths (playbook) {
  const { dir: playbookDir } = playbook
  const watchSet = new Set()

  if (playbook.file) watchSet.add(ospath.resolve(playbook.file))
  else if (playbook.playbook) watchSet.add(ospath.resolve(playbookDir, playbook.playbook))

  for (const source of playbook.content?.sources || []) {
    const url = source.url
    if (!url || typeof url !== 'string') continue
    if (isRemoteUrl(url)) continue

    const resolved = ospath.resolve(playbookDir, url)
    const startPaths = normalizeStartPaths(source)
    if (startPaths.length) {
      for (const sp of startPaths) {
        if (sp.includes('!')) continue
        const dir = ospath.join(resolved, sp)
        addIfExists(watchSet, dir) || addIfExists(watchSet, resolved)
      }
    } else {
      addIfExists(watchSet, resolved)
    }
  }

  const uiBundleUrl = playbook.ui?.bundle?.url
  if (uiBundleUrl && typeof uiBundleUrl === 'string' && !isRemoteUrl(uiBundleUrl)) {
    addIfExists(watchSet, ospath.resolve(playbookDir, uiBundleUrl))
  }

  const supplemental = playbook.ui?.supplementalFiles || playbook.ui?.supplemental_files
  if (typeof supplemental === 'string' && !isRemoteUrl(supplemental)) {
    addIfExists(watchSet, ospath.resolve(playbookDir, supplemental))
  } else if (Array.isArray(supplemental)) {
    for (const entry of supplemental) {
      const p = typeof entry === 'string' ? entry : entry?.path || entry?.cwd
      if (p && typeof p === 'string' && !isRemoteUrl(p)) addIfExists(watchSet, ospath.resolve(playbookDir, p))
    }
  }

  // Never watch the output tree (rebuild feedback loop).
  const outputDir = ospath.resolve(playbookDir, playbook.output?.dir || 'build/site')
  watchSet.delete(outputDir)

  return [...watchSet]
}

function normalizeStartPaths (source) {
  if (Array.isArray(source.start_paths) && source.start_paths.length) return source.start_paths
  if (Array.isArray(source.startPaths) && source.startPaths.length) return source.startPaths
  const single = source.start_path || source.startPath
  return single ? [single] : []
}

function isRemoteUrl (url) {
  return /^https?:\/\//i.test(url) || url.startsWith('git@') || url.startsWith('git://') || url.startsWith('ssh://')
}

function addIfExists (set, path) {
  try {
    if (fs.existsSync(path)) {
      set.add(ospath.resolve(path))
      return true
    }
  } catch (_) {}
  return false
}

/**
 * Static file server with SSE live-reload and Antora-friendly indexify paths.
 */
function createServer (rootDir, opts = {}) {
  let reloadVersion = opts.reloadVersion || 0
  const sseClients = new Set()
  const rootResolved = ospath.resolve(rootDir)

  const mime = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    mjs: 'application/javascript; charset=utf-8',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    xml: 'application/xml',
    pdf: 'application/pdf',
    map: 'application/json',
    txt: 'text/plain; charset=utf-8',
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')

    if (url.pathname === RELOAD_ENDPOINT) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      })
      res.write(`data: ${reloadVersion}\n\n`)
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }

    let pathname = decodeURIComponent(url.pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'

    let filePath = ospath.join(rootResolved, ospath.join('/', pathname))
    if (!filePath.startsWith(rootResolved + ospath.sep) && filePath !== rootResolved) {
      res.statusCode = 403
      res.end()
      return
    }

    serveFile(filePath, pathname, res, () => {
      // indexify fallback: /foo -> /foo/index.html
      if (!pathname.endsWith('.html') && !pathname.endsWith('/')) {
        const alt = ospath.join(filePath, 'index.html')
        serveFile(alt, pathname + '/index.html', res, () => {
          res.statusCode = 404
          res.end('Not Found')
        })
      } else {
        res.statusCode = 404
        res.end('Not Found')
      }
    })
  })

  function serveFile (filePath, pathname, res, onMissing) {
    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) return onMissing()
      fs.readFile(filePath, (readErr, data) => {
        if (readErr) {
          res.statusCode = 500
          res.end('Internal Server Error')
          return
        }
        const ext = ospath.extname(pathname).slice(1).toLowerCase()
        res.setHeader('Content-Type', mime[ext] || 'application/octet-stream')
        if ((ext === 'html' || ext === 'htm') && data.includes('</body>')) {
          const injected = data.toString('utf8').replace('</body>', RELOAD_SCRIPT + '</body>')
          res.end(injected)
        } else {
          res.end(data)
        }
      })
    })
  }

  server.bumpReload = () => {
    reloadVersion += 1
    for (const client of sseClients) {
      try {
        client.write(`data: ${reloadVersion}\n\n`)
      } catch (_) {
        sseClients.delete(client)
      }
    }
  }
  server.reloadVersion = () => reloadVersion
  return server
}

/**
 * Watch paths; debounce; ignore output/cache/.git noise.
 * Returns { stop, building flag helpers via onChange contract }.
 */
function watchPaths (paths, onChange, debounceMs = 600) {
  let timeout
  const watchers = []
  const pending = new Set()

  const schedule = (absOrRel) => {
    if (absOrRel && shouldIgnore(absOrRel)) return
    if (absOrRel) pending.add(absOrRel)
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => {
      timeout = null
      const batch = [...pending]
      pending.clear()
      onChange(batch)
    }, debounceMs)
  }

  for (const p of paths) {
    try {
      const stat = fs.statSync(p)
      const target = stat.isDirectory() ? p : ospath.dirname(p)
      const w = fs.watch(target, { recursive: true }, (_event, filename) => {
        if (filename) {
          if (shouldIgnore(filename)) return
          const base = filename.split(/[/\\]/).pop() || ''
          if (base.includes('.') && !WATCH_EXT.test(base) && !base.includes('antora')) return
          schedule(ospath.join(target, filename))
        } else {
          schedule(target)
        }
      })
      watchers.push(w)
    } catch (_) {}
  }

  return () => {
    if (timeout) clearTimeout(timeout)
    for (const w of watchers) {
      try {
        w.close()
      } catch (_) {}
    }
  }
}

function shouldIgnore (filename) {
  const parts = filename.split(/[/\\]/)
  return parts.some((p) => IGNORE_DIR_PARTS.has(p))
}

/**
 * Serialize rebuilds: coalesce overlapping change events into one trailing run.
 */
function createRebuildQueue (run) {
  let running = false
  let queued = false
  let pendingPaths = []

  const kick = async (paths = []) => {
    if (paths.length) pendingPaths = [...new Set([...pendingPaths, ...paths])]
    if (running) {
      queued = true
      return
    }
    running = true
    try {
      do {
        queued = false
        const batch = pendingPaths
        pendingPaths = []
        await run(batch)
      } while (queued)
    } finally {
      running = false
    }
  }

  return { kick, get busy () { return running } }
}

module.exports = {
  RELOAD_ENDPOINT,
  createServer,
  createRebuildQueue,
  getWatchPaths,
  watchPaths,
  isRemoteUrl,
  normalizeStartPaths,
}
