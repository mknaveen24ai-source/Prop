/**
 * Fix UTF-8 encoding issues in Admin.js
 * Replaces garbled characters with proper UTF-8 equivalents
 */

const fs = require('fs')
const path = require('path')

const filePath = path.join(__dirname, 'frontend', 'src', 'pages', 'Admin.js')

console.log('Reading Admin.js...')
let content = fs.readFileSync(filePath, 'utf8')

// Fix garbled characters using Unicode escapes
const replacements = [
  ['Â·', '\u00B7'],        // middle dot
  ['â€¢', '\u2022'],       // bullet
  ['â†»', '\u21BB'],       // refresh
  ['âš ', '\u26A0'],       // warning
  ['â—', '\u25CF'],        // filled circle
  ['â€"', '\u2014'],       // em dash
  ['â€"', '\u2013'],       // en dash
  ['â¬¡', '\u26A1'],       // lightning
  ['â‚¬', '\u20AC'],       // euro
  ['â€˜', '\u2018'],       // left single quote
  ['â€™', '\u2019'],        // right single quote
  ['â€œ', '\u201C'],       // left double quote
  ['â€', '\u201D'],        // right double quote
  ['Ã—', '\u00D7'],        // multiplication
  ['Ã·', '\u00F7'],        // division
  ['â‰¥', '\u2265'],       // greater than or equal
  ['â‰¤', '\u2264'],       // less than or equal
  ['â†"', '\u2192'],       // right arrow
  ['â†"', '\u2190'],       // left arrow
  ['â†"', '\u2191'],       // up arrow
  ['â†"', '\u2193'],       // down arrow
  ['âˆ"', '\u221E'],       // infinity
  ['Ã©', '\u00E9'],        // e acute
  ['Ã¨', '\u00E8'],        // e grave
  ['Ã ', '\u00E0'],        // a grave
  ['Ã¹', '\u00F9'],        // u grave
]

let replacedCount = 0
for (const [broken, correct] of replacements) {
  const regex = new RegExp(broken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  const count = (content.match(regex) || []).length
  if (count > 0) {
    content = content.replace(regex, correct)
    replacedCount += count
    console.log(`  Replaced "${broken}" → "${correct}" (${count} occurrences)`)
  }
}

fs.writeFileSync(filePath, content, 'utf8')
console.log(`\n✅ Fixed ${replacedCount} garbled characters in Admin.js`)
