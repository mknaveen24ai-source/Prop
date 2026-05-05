const fs = require('fs')
const path = require('path')
const {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
  AlignmentType,
} = require('../backend/node_modules/docx')

const SOURCE_PATH = path.join(__dirname, '..', 'docs', 'generated', 'PropFirm_SaaS_Build_And_Operations_Guide.md')
const OUTPUT_PATH = path.join(__dirname, '..', 'docs', 'generated', 'PropFirm_SaaS_Build_And_Operations_Guide.docx')

function buildParagraphs(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n')
  const paragraphs = []

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const trimmed = line.trim()

    if (!trimmed) {
      paragraphs.push(new Paragraph({ spacing: { after: 120 } }))
      continue
    }

    if (trimmed.startsWith('# ')) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.TITLE,
          alignment: AlignmentType.CENTER,
          spacing: { after: 240 },
          children: [new TextRun({ text: trimmed.slice(2).trim(), bold: true })],
        })
      )
      continue
    }

    if (trimmed.startsWith('## ')) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 120 },
          children: [new TextRun({ text: trimmed.slice(3).trim(), bold: true })],
        })
      )
      continue
    }

    if (trimmed.startsWith('### ')) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 180, after: 100 },
          children: [new TextRun({ text: trimmed.slice(4).trim(), bold: true })],
        })
      )
      continue
    }

    if (trimmed.startsWith('- ')) {
      paragraphs.push(
        new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 60 },
          children: [new TextRun({ text: trimmed.slice(2).trim() })],
        })
      )
      continue
    }

    if (/^\d+\.\s/.test(trimmed)) {
      paragraphs.push(
        new Paragraph({
          spacing: { after: 60 },
          children: [new TextRun({ text: trimmed })],
        })
      )
      continue
    }

    paragraphs.push(
      new Paragraph({
        spacing: { after: 100 },
        children: [new TextRun({ text: trimmed })],
      })
    )
  }

  return paragraphs
}

async function main() {
  const markdown = fs.readFileSync(SOURCE_PATH, 'utf8')
  const doc = new Document({
    creator: 'OpenAI Codex',
    title: 'PropFirm SaaS Build And Operations Guide',
    description: 'Guide explaining how the PropFirm SaaS platform is built and operated.',
    sections: [
      {
        properties: {},
        children: buildParagraphs(markdown),
      },
    ],
  })

  const buffer = await Packer.toBuffer(doc)
  fs.writeFileSync(OUTPUT_PATH, buffer)
  process.stdout.write(`${OUTPUT_PATH}\n`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
