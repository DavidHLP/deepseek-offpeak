#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')
const manifestPath = path.join(root, 'manifest.json')

function fail(message) {
  console.error(`manifest: ${message}`)
  process.exitCode = 1
}

let manifest
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
} catch (error) {
  fail(`cannot parse manifest.json: ${error.message}`)
  process.exit(1)
}
if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
  fail('manifest root must be an object')
  process.exit(1)
}

if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1')
if (typeof manifest.id !== 'string' || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(manifest.id)) {
  fail('id must contain only lowercase letters, numbers, dots, underscores, or hyphens')
}
if (typeof manifest.name !== 'string' || manifest.name.length === 0) fail('name must be a non-empty string')
if (typeof manifest.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) {
  fail('version must be semantic version (MAJOR.MINOR.PATCH)')
}
const allowedKinds = new Set(['service', 'bar-widget'])
if (!Array.isArray(manifest.kinds) || manifest.kinds.length !== allowedKinds.size ||
    manifest.kinds.some((kind) => typeof kind !== 'string' || !allowedKinds.has(kind)) ||
    new Set(manifest.kinds).size !== manifest.kinds.length) {
  fail('kinds must contain exactly service and bar-widget')
}
if (!manifest.entryPoints || typeof manifest.entryPoints !== 'object' || Array.isArray(manifest.entryPoints)) {
  fail('entryPoints must be an object')
} else {
  for (const name of ['service', 'barWidget']) {
    const relative = manifest.entryPoints[name]
    if (typeof relative !== 'string' || relative.length === 0 || path.posix.isAbsolute(relative) || relative.split('/').includes('..')) {
      fail(`entryPoints.${name} must be a safe relative path`)
      continue
    }
    const entry = path.join(root, relative)
    try {
      if (!fs.lstatSync(entry).isFile()) fail(`entryPoints.${name} is not a regular file: ${relative}`)
    } catch {
      fail(`entryPoints.${name} does not exist: ${relative}`)
    }
  }
}

const cli = path.join(root, 'bin', 'deepseek-offpeak')
try {
  if ((fs.statSync(cli).mode & 0o111) === 0) fail('bin/deepseek-offpeak is not executable')
} catch {
  fail('bin/deepseek-offpeak does not exist')
}

if (!process.exitCode) console.log('manifest: valid')
