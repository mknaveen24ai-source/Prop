'use strict'

/**
 * Minimal intrinsic-size reader for PNG and JPEG buffers.
 *
 * Certificate template uploads need width/height to validate a minimum
 * resolution and to record the canvas the layout editor positions against.
 * That is the only requirement, and it is a header read — not worth pulling in
 * an image library for. Deliberately supports exactly the two formats the
 * upload route accepts; anything else returns null so the caller rejects it.
 */

/** PNG: 8-byte signature, then the IHDR chunk carries width/height as BE u32. */
function readPngDimensions(buffer) {
  if (buffer.length < 24) return null
  const signature = buffer.subarray(0, 8)
  if (!signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'png' }
}

/**
 * JPEG: walk the marker segments to the frame header (SOF0-SOF15), which
 * carries the real dimensions. SOF4 (0xC4, Huffman tables), SOF8 (0xC8) and
 * SOF12 (0xCC, arithmetic coding) sit inside that numeric range but are NOT
 * frame headers, so they must be skipped or a Huffman table gets misread as a
 * size. Progressive JPEGs use SOF2, which is why matching only SOF0 is wrong.
 */
function readJpegDimensions(buffer) {
  if (buffer.length < 4) return null
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null

  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue }
    const marker = buffer[offset + 1]
    // Standalone markers: padding (0xFF), RSTn (0xD0-0xD7), SOI/EOI — no length.
    if (marker === 0xff || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue }

    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2) return null

    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrameHeader) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
        format: 'jpeg'
      }
    }
    offset += 2 + length
  }
  return null
}

/** @returns {{width:number,height:number,format:'png'|'jpeg'}|null} */
function readImageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer)) return null
  return readPngDimensions(buffer) || readJpegDimensions(buffer)
}

module.exports = { readImageDimensions, readPngDimensions, readJpegDimensions }
