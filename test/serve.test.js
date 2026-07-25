'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  isRemoteUrl,
  normalizeStartPaths,
  getWatchPaths,
  createRebuildQueue,
} = require('../lib/serve.js')

describe('isRemoteUrl', () => {
  it('detects remote protocols', () => {
    assert.equal(isRemoteUrl('https://gitlab.com/org/repo.git'), true)
    assert.equal(isRemoteUrl('git@gitlab.com:org/repo.git'), true)
    assert.equal(isRemoteUrl('./docs'), false)
    assert.equal(isRemoteUrl('../sibling'), false)
  })
})

describe('normalizeStartPaths', () => {
  it('prefers start_paths arrays', () => {
    assert.deepEqual(normalizeStartPaths({ start_paths: ['a', 'b'] }), ['a', 'b'])
  })
  it('falls back to start_path', () => {
    assert.deepEqual(normalizeStartPaths({ start_path: 'docs' }), ['docs'])
  })
})

describe('getWatchPaths', () => {
  it('skips remote sources and includes local ones', () => {
    const playbook = {
      dir: __dirname,
      file: __filename,
      content: {
        sources: [
          { url: 'https://example.com/repo.git', start_path: 'docs' },
          { url: '.', start_path: '.' },
        ],
      },
      output: { dir: 'build/site' },
    }
    const paths = getWatchPaths(playbook)
    assert.ok(paths.includes(__filename))
    assert.ok(paths.every((p) => !p.includes('example.com')))
  })
})

describe('createRebuildQueue', () => {
  it('coalesces overlapping runs', async () => {
    let runs = 0
    const queue = createRebuildQueue(async () => {
      runs += 1
      await new Promise((r) => setTimeout(r, 30))
    })
    const a = queue.kick()
    const b = queue.kick()
    const c = queue.kick()
    await Promise.all([a, b, c])
    // one in-flight + at most one trailing coalesced run
    assert.ok(runs >= 1 && runs <= 2)
  })
})
