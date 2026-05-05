const fs = require('fs')
const path = require('path')

const PARTS_DIR = path.join('C:', 'Users', 'mknav', '.gemini', 'antigravity', 'brain', '552083bf-bef8-48bf-86f4-2ca6f923d387')
const OUTPUT = path.join('e:', 'propfirm', 'AUDIT_REPORT.html')

// Read the 3 parts
const part1 = fs.readFileSync(path.join(PARTS_DIR, 'audit_report_part1.md'), 'utf8')
const part2 = fs.readFileSync(path.join(PARTS_DIR, 'audit_report_part2.md'), 'utf8')
const part3 = fs.readFileSync(path.join(PARTS_DIR, 'audit_report_part3.md'), 'utf8')

// Simple markdown to HTML converter
function md2html(md) {
  let html = md
  // Code blocks with language
  html = html.replace(/```(\w+)\n([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    return `<pre class="code-block"><code class="lang-${lang}">${escaped}</code></pre>`
  })
  // Code blocks without language
  html = html.replace(/```\n?([\s\S]*?)```/g, (_, code) => {
    const escaped = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    return `<pre class="code-block"><code>${escaped}</code></pre>`
  })
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="inline">$1</code>')
  // Tables
  html = html.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)*)/gm, (match, header, sep, body) => {
    const hCells = header.split('|').filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join('')
    const rows = body.trim().split('\n').map(row => {
      const cells = row.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('')
      return `<tr>${cells}</tr>`
    }).join('\n')
    return `<table><thead><tr>${hCells}</tr></thead><tbody>${rows}</tbody></table>`
  })
  // Blockquotes / alerts
  html = html.replace(/^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\n> (.+)/gm, '<div class="alert alert-$1"><strong>$1:</strong> $2</div>')
  html = html.replace(/^> (.+)/gm, '<blockquote>$1</blockquote>')
  // Headers
  html = html.replace(/^#### (.+)/gm, '<h4>$1</h4>')
  html = html.replace(/^### (.+)/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)/gm, '<h1>$1</h1>')
  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>')
  // Links (strip file:/// links)
  html = html.replace(/\[([^\]]+)\]\(file:\/\/\/[^)]+\)/g, '<code class="inline">$1</code>')
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  // List items
  html = html.replace(/^- (.+)/gm, '<li>$1</li>')
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
  // Paragraphs (lines not already tagged)
  html = html.replace(/^(?!<[huptdlboa]|<\/|<hr|<pre|<code|<div|<ul|<li|<blockquote|\s*$)(.+)$/gm, '<p>$1</p>')
  // Emojis for severity
  html = html.replace(/🔴/g, '<span class="sev-critical">●</span>')
  html = html.replace(/🟠/g, '<span class="sev-high">●</span>')
  html = html.replace(/🟡/g, '<span class="sev-medium">●</span>')
  html = html.replace(/🟢/g, '<span class="sev-low">●</span>')
  html = html.replace(/✅/g, '<span class="check">✓</span>')
  html = html.replace(/⚠️/g, '<span class="warn">⚠</span>')
  html = html.replace(/❌/g, '<span class="cross">✗</span>')
  return html
}

const combinedMd = part1.replace(/^# TECHNICAL AUDIT REPORT — Part 1 of 3\n/, '# TECHNICAL AUDIT REPORT\n')
  + '\n\n' + part2.replace(/^# TECHNICAL AUDIT REPORT — Part 2 of 3\n/, '')
  + '\n\n' + part3.replace(/^# TECHNICAL AUDIT REPORT — Part 3 of 3\n/, '')

const bodyHtml = md2html(combinedMd)

const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PropFirm Technical Audit Report — April 2026</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

  :root {
    --primary: #1a56db; --primary-light: #e8effd;
    --critical: #dc2626; --high: #ea580c; --medium: #d97706; --low: #16a34a;
    --bg: #ffffff; --text: #1f2937; --muted: #6b7280;
    --border: #e5e7eb; --code-bg: #f8fafc; --header-bg: #0f172a;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Inter', -apple-system, sans-serif;
    color: var(--text); background: var(--bg);
    font-size: 11pt; line-height: 1.65;
    max-width: 900px; margin: 0 auto; padding: 40px 50px;
  }

  /* Cover / Title */
  h1:first-of-type {
    font-size: 28pt; font-weight: 700; color: var(--header-bg);
    border-bottom: 4px solid var(--primary); padding-bottom: 16px;
    margin-bottom: 8px;
  }

  h1 { font-size: 22pt; font-weight: 700; color: var(--header-bg); margin: 36px 0 16px; page-break-after: avoid; }
  h2 { font-size: 16pt; font-weight: 600; color: var(--primary); margin: 28px 0 12px;
       border-bottom: 2px solid var(--primary-light); padding-bottom: 6px; page-break-after: avoid; }
  h3 { font-size: 13pt; font-weight: 600; color: #374151; margin: 20px 0 8px; page-break-after: avoid; }
  h4 { font-size: 11pt; font-weight: 600; color: #4b5563; margin: 16px 0 6px; }

  p { margin: 6px 0; }
  a { color: var(--primary); text-decoration: none; }

  hr { border: none; border-top: 1px solid var(--border); margin: 24px 0; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; margin: 12px 0 18px; font-size: 10pt; page-break-inside: avoid; }
  thead { background: var(--header-bg); color: white; }
  th { padding: 8px 12px; text-align: left; font-weight: 600; font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 7px 12px; border-bottom: 1px solid var(--border); }
  tr:nth-child(even) { background: #f9fafb; }
  tr:hover { background: var(--primary-light); }

  /* Code */
  .code-block {
    background: #0f172a; color: #e2e8f0; padding: 16px 20px;
    border-radius: 8px; overflow-x: auto; font-size: 9.5pt;
    line-height: 1.5; margin: 10px 0 16px;
    border-left: 4px solid var(--primary); page-break-inside: avoid;
  }
  .code-block code { font-family: 'JetBrains Mono', monospace; }
  code.inline {
    background: #f1f5f9; color: #be185d; padding: 2px 6px;
    border-radius: 4px; font-size: 9.5pt;
    font-family: 'JetBrains Mono', monospace;
  }

  /* Lists */
  ul { margin: 6px 0 6px 24px; }
  li { margin: 3px 0; }

  /* Severity dots */
  .sev-critical { color: var(--critical); font-size: 14pt; }
  .sev-high { color: var(--high); font-size: 14pt; }
  .sev-medium { color: var(--medium); font-size: 14pt; }
  .sev-low { color: var(--low); font-size: 14pt; }
  .check { color: var(--low); font-weight: 700; }
  .warn { color: var(--medium); font-weight: 700; }
  .cross { color: var(--critical); font-weight: 700; }

  /* Alerts */
  .alert { padding: 12px 16px; border-radius: 6px; margin: 10px 0; font-size: 10pt; border-left: 4px solid; }
  .alert-IMPORTANT { background: #fef3c7; border-color: var(--medium); }
  .alert-WARNING { background: #fff7ed; border-color: var(--high); }
  .alert-NOTE { background: #eff6ff; border-color: var(--primary); }

  blockquote { border-left: 3px solid var(--border); padding: 8px 16px; margin: 10px 0; color: var(--muted); background: #f9fafb; }

  /* Print styles */
  @media print {
    body { padding: 20px 30px; font-size: 10pt; }
    .code-block { background: #f1f5f9 !important; color: #1e293b !important; border: 1px solid #cbd5e1; }
    thead { background: #374151 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    tr:nth-child(even) { background: #f3f4f6 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    h1, h2 { page-break-after: avoid; }
    table, .code-block { page-break-inside: avoid; }
    .alert { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }

  /* Cover page info */
  .meta-block { margin: 8px 0 32px; padding: 16px 20px; background: #f8fafc; border-radius: 8px; border: 1px solid var(--border); }
  .meta-block p { margin: 4px 0; font-size: 10.5pt; color: var(--muted); }
  .meta-block strong { color: var(--text); }
</style>
</head>
<body>

<div class="meta-block">
  <p><strong>Project:</strong> PropFirm Trading Platform</p>
  <p><strong>Audited By:</strong> Claude Opus — Principal Engineer Review</p>
  <p><strong>Date:</strong> April 22, 2026</p>
  <p><strong>Prepared For:</strong> Engineering Team & CTO</p>
  <p><strong>Classification:</strong> CONFIDENTIAL — Internal Use Only</p>
</div>

${bodyHtml}

<div style="margin-top:48px; padding-top:16px; border-top:2px solid var(--border); text-align:center; color:var(--muted); font-size:9pt;">
  <p>PropFirm Technical Audit Report — Generated April 22, 2026</p>
  <p>This document is confidential and intended for internal engineering use only.</p>
</div>

</body>
</html>`

fs.writeFileSync(OUTPUT, fullHtml, 'utf8')
console.log(`SUCCESS: Audit report written to ${OUTPUT}`)
console.log(`File size: ${(fullHtml.length / 1024).toFixed(1)} KB`)
console.log('')
console.log('To save as PDF:')
console.log('  1. Open the file in your browser (double-click AUDIT_REPORT.html)')
console.log('  2. Press Ctrl+P')
console.log('  3. Set Destination to "Save as PDF"')
console.log('  4. Click Save')
