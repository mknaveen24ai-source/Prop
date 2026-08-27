#!/usr/bin/env node
'use strict'

/**
 * Normalise Ledger Desk typography and spacing onto the scales in tokens.css.
 *
 * Unlike the exact-match codemods, this is the deliberate visual-normalisation
 * pass: off-scale values move to their nearest token. Equidistant typography
 * and spacing move upward to preserve legibility and generous editorial rhythm.
 * The scanner is limited to font-size/fontSize and spacing properties, matching
 * the repository's design-drift and ESLint rules.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src')
const TOKENS = path.join(SRC, 'styles', 'tokens.css')
const WRITE = process.argv.includes('--write')

function readScale(prefix) {
  const css = fs.readFileSync(TOKENS, 'utf8')
  const scale = new Map()
  const re = new RegExp('--(' + prefix + '-[a-z0-9-]+):\\s*([0-9.]+)px', 'gi')
  let match
  while ((match = re.exec(css))) scale.set(Number(match[2]), match[1])
  return scale
}

function nearestToken(scale, value) {
  const values = [...scale.keys()]
  const nearest = values.reduce((best, candidate) => {
    const candidateDistance = Math.abs(candidate - value)
    const bestDistance = Math.abs(best - value)
    return candidateDistance < bestDistance || (candidateDistance === bestDistance && candidate > best)
      ? candidate
      : best
  })
  return `var(--${scale.get(nearest)})`
}

function sourceFiles() {
  const files = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsx') || (entry.name.endsWith('.css') && full !== TOKENS)) files.push(full)
    }
  }
  walk(SRC)
  return files
}

function normalisePxList(value, scale) {
  return value.replace(/([0-9.]+)px/g, (literal, raw) => {
    const px = Number(raw)
    return px === 0 || px === 1 ? literal : nearestToken(scale, px)
  })
}

function normaliseJsx(source, fontScale, spaceScale) {
  let result = source.replace(/fontSize:\s*'([0-9.]+)px'/g, (_match, raw) =>
    `fontSize: '${nearestToken(fontScale, Number(raw))}'`)

  result = result.replace(
    /(padding|margin|gap|rowGap|columnGap)([A-Za-z]*):\s*'([^']*)'/g,
    (match, property, suffix, value) => {
      const normalised = normalisePxList(value, spaceScale)
      return normalised === value ? match : `${property}${suffix}: '${normalised}'`
    }
  )
  return result
}

function normaliseCss(source, fontScale, spaceScale) {
  let result = source.replace(/font-size:(\s*)([0-9.]+)px/gi, (_match, whitespace, raw) =>
    `font-size:${whitespace}${nearestToken(fontScale, Number(raw))}`)

  result = result.replace(
    /((?:padding|margin|gap|row-gap|column-gap)[a-z-]*:\s*)([^;{}]+)([;}])/gi,
    (match, prefix, value, terminator) => {
      const normalised = normalisePxList(value, spaceScale)
      return normalised === value ? match : `${prefix}${normalised}${terminator}`
    }
  )
  return result
}

function main() {
  const fontScale = readScale('fs')
  const spaceScale = readScale('space')
  const changed = []

  for (const file of sourceFiles()) {
    const before = fs.readFileSync(file, 'utf8')
    const after = file.endsWith('.jsx')
      ? normaliseJsx(before, fontScale, spaceScale)
      : normaliseCss(before, fontScale, spaceScale)
    if (after === before) continue
    changed.push(path.relative(ROOT, file).split(path.sep).join('/'))
    if (WRITE) fs.writeFileSync(file, after)
  }

  console.log(`${WRITE ? 'Normalised' : 'Would normalise'} ${changed.length} Ledger Desk source files.`)
}

main()
