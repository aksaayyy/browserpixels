/**
 * Client-side metadata (EXIF/XMP) parsing and stripping.
 *
 * Design choice: this operates on raw bytes (JPEG markers / PNG chunks /
 * WebP RIFF chunks) rather than drawing to a <canvas> and re-exporting.
 * Canvas re-encode is how most "free EXIF remover" sites work, and it has
 * two real costs: it silently recompresses JPEGs (quality loss on an image
 * the user never asked to re-compress), and it can't touch PNG/WebP
 * metadata chunks cleanly. Byte-level surgery removes exactly the metadata
 * segments/chunks and leaves every pixel byte untouched — the output is
 * bit-for-bit the same image, just without the tracking data.
 */

export type ImageKind = 'jpeg' | 'png' | 'webp' | 'unknown';

export interface FoundTag {
  label: string;
  value: string;
  /** Marks tags worth calling out prominently (GPS location). */
  sensitive?: boolean;
}

export interface MetadataScanResult {
  kind: ImageKind;
  tags: FoundTag[];
  hasGps: boolean;
  hadAnyMetadata: boolean;
}

export interface StripResult extends MetadataScanResult {
  cleaned: Uint8Array<ArrayBuffer>;
  originalBytes: number;
  cleanedBytes: number;
}

function detectKind(bytes: Uint8Array): ImageKind {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'png';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
  ) return 'webp';
  return 'unknown';
}

/* ---------------------------------------------------------------------- */
/* TIFF / EXIF decoding (shared by JPEG APP1, PNG eXIf, WebP EXIF chunk)  */
/* ---------------------------------------------------------------------- */

const TAG_TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

interface RawEntry {
  tag: number;
  type: number;
  count: number;
  valueFieldOffset: number; // offset (within view) of the 4-byte value/offset field
}

function readIfdEntries(view: DataView, tiffStart: number, ifdOffset: number, little: boolean): { entries: RawEntry[]; next: number } {
  const entries: RawEntry[] = [];
  if (ifdOffset + 2 > view.byteLength - tiffStart) return { entries, next: 0 };
  const abs = tiffStart + ifdOffset;
  if (abs + 2 > view.byteLength) return { entries, next: 0 };
  const count = view.getUint16(abs, little);
  let p = abs + 2;
  for (let i = 0; i < count; i++) {
    if (p + 12 > view.byteLength) break;
    entries.push({
      tag: view.getUint16(p, little),
      type: view.getUint16(p + 2, little),
      count: view.getUint32(p + 4, little),
      valueFieldOffset: p + 8,
    });
    p += 12;
  }
  const next = p + 4 <= view.byteLength ? view.getUint32(p, little) : 0;
  return { entries, next };
}

function entryDataOffset(view: DataView, tiffStart: number, e: RawEntry, little: boolean): number {
  const size = (TAG_TYPE_SIZE[e.type] ?? 1) * e.count;
  if (size <= 4) return e.valueFieldOffset;
  const rel = view.getUint32(e.valueFieldOffset, little);
  return tiffStart + rel;
}

function readAscii(view: DataView, tiffStart: number, e: RawEntry, little: boolean): string {
  const off = entryDataOffset(view, tiffStart, e, little);
  let s = '';
  for (let i = 0; i < e.count && off + i < view.byteLength; i++) {
    const c = view.getUint8(off + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function readRationalArray(view: DataView, tiffStart: number, e: RawEntry, little: boolean): number[] {
  const off = entryDataOffset(view, tiffStart, e, little);
  const out: number[] = [];
  for (let i = 0; i < e.count; i++) {
    const p = off + i * 8;
    if (p + 8 > view.byteLength) break;
    const num = view.getUint32(p, little);
    const den = view.getUint32(p + 4, little);
    out.push(den === 0 ? 0 : num / den);
  }
  return out;
}

function dmsToDecimal(dms: number[]): number | null {
  if (dms.length < 3) return null;
  return dms[0] + dms[1] / 60 + dms[2] / 3600;
}

/** Parses a raw TIFF/EXIF blob (as found inside a JPEG APP1, PNG eXIf, or WebP EXIF chunk). */
function parseTiff(view: DataView, tiffStart: number): FoundTag[] {
  if (tiffStart + 8 > view.byteLength) return [];
  const b0 = view.getUint8(tiffStart);
  const b1 = view.getUint8(tiffStart + 1);
  let little: boolean;
  if (b0 === 0x49 && b1 === 0x49) little = true; // "II"
  else if (b0 === 0x4d && b1 === 0x4d) little = false; // "MM"
  else return [];

  const magic = view.getUint16(tiffStart + 2, little);
  if (magic !== 42) return [];
  const ifd0Offset = view.getUint32(tiffStart + 4, little);

  const tags: FoundTag[] = [];
  const { entries: ifd0 } = readIfdEntries(view, tiffStart, ifd0Offset, little);

  let exifIfdOffset: number | null = null;
  let gpsIfdOffset: number | null = null;

  for (const e of ifd0) {
    try {
      if (e.tag === 0x010f) tags.push({ label: 'Camera make', value: readAscii(view, tiffStart, e, little) });
      else if (e.tag === 0x0110) tags.push({ label: 'Camera model', value: readAscii(view, tiffStart, e, little) });
      else if (e.tag === 0x0131) tags.push({ label: 'Software', value: readAscii(view, tiffStart, e, little) });
      else if (e.tag === 0x0132) tags.push({ label: 'Date/time', value: readAscii(view, tiffStart, e, little) });
      else if (e.tag === 0x8769) exifIfdOffset = view.getUint32(e.valueFieldOffset, little);
      else if (e.tag === 0x8825) gpsIfdOffset = view.getUint32(e.valueFieldOffset, little);
    } catch {
      /* malformed entry — skip it, don't fail the whole scan */
    }
  }

  if (exifIfdOffset != null) {
    const { entries: exifIfd } = readIfdEntries(view, tiffStart, exifIfdOffset, little);
    for (const e of exifIfd) {
      try {
        if (e.tag === 0x9003) tags.push({ label: 'Date taken', value: readAscii(view, tiffStart, e, little) });
        else if (e.tag === 0xa430) tags.push({ label: 'Camera owner', value: readAscii(view, tiffStart, e, little) });
        else if (e.tag === 0xa435) tags.push({ label: 'Lens serial', value: readAscii(view, tiffStart, e, little) });
      } catch {
        /* skip */
      }
    }
  }

  if (gpsIfdOffset != null) {
    const { entries: gpsIfd } = readIfdEntries(view, tiffStart, gpsIfdOffset, little);
    let latRef = '', lonRef = '', lat: number[] = [], lon: number[] = [];
    for (const e of gpsIfd) {
      try {
        if (e.tag === 0x0001) latRef = readAscii(view, tiffStart, e, little);
        else if (e.tag === 0x0002) lat = readRationalArray(view, tiffStart, e, little);
        else if (e.tag === 0x0003) lonRef = readAscii(view, tiffStart, e, little);
        else if (e.tag === 0x0004) lon = readRationalArray(view, tiffStart, e, little);
      } catch {
        /* skip */
      }
    }
    const latD = dmsToDecimal(lat);
    const lonD = dmsToDecimal(lon);
    if (latD != null && lonD != null) {
      const signedLat = latRef === 'S' ? -latD : latD;
      const signedLon = lonRef === 'W' ? -lonD : lonD;
      tags.push({
        label: 'GPS location',
        value: `${signedLat.toFixed(5)}, ${signedLon.toFixed(5)}`,
        sensitive: true,
      });
    }
  }

  return tags;
}

/* ---------------------------------------------------------------------- */
/* JPEG                                                                    */
/* ---------------------------------------------------------------------- */

const JPEG_NO_LENGTH = new Set([0xd8, 0xd9, 0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

function processJpeg(bytes: Uint8Array, strip: boolean): { tags: FoundTag[]; out: Uint8Array<ArrayBuffer> } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tags: FoundTag[] = [];
  const out: Uint8Array[] = [bytes.subarray(0, 2)]; // SOI
  let pos = 2;

  while (pos + 1 < bytes.length) {
    if (bytes[pos] !== 0xff) { pos++; continue; }
    let marker = bytes[pos + 1];
    let mp = pos + 2;
    // skip fill bytes (0xFF padding before the real marker)
    while (marker === 0xff && mp < bytes.length) { marker = bytes[mp]; mp++; }

    if (JPEG_NO_LENGTH.has(marker)) {
      if (strip === false || (marker < 0xd0 || marker > 0xd7)) out.push(bytes.subarray(pos, mp));
      pos = mp;
      continue;
    }

    if (mp + 2 > bytes.length) break;
    const segLen = view.getUint16(mp, false); // big-endian
    const segStart = pos; // includes 0xFF + marker
    const segEnd = mp + segLen; // length field counts itself, not the marker bytes
    if (segEnd > bytes.length) break;

    const isApp = marker >= 0xe0 && marker <= 0xef;
    const isCom = marker === 0xfe;

    if (isApp) {
      const dataStart = mp + 2;
      // APP1 "Exif\0\0"
      if (marker === 0xe1 && segLen >= 8) {
        const isExif =
          bytes[dataStart] === 0x45 && bytes[dataStart + 1] === 0x78 && bytes[dataStart + 2] === 0x69 &&
          bytes[dataStart + 3] === 0x66 && bytes[dataStart + 4] === 0x00 && bytes[dataStart + 5] === 0x00;
        if (isExif) {
          try { tags.push(...parseTiff(view, dataStart + 6)); } catch { /* ignore malformed exif */ }
        } else {
          // Likely XMP ("http://ns.adobe.com/xap/1.0/\0")
          tags.push({ label: 'XMP metadata', value: 'present' });
        }
      } else if (marker === 0xed) {
        tags.push({ label: 'Photoshop/IPTC metadata', value: 'present' });
      }
    }
    if (isCom) {
      tags.push({ label: 'Comment', value: 'present' });
    }

    const shouldDrop = strip && (isApp || isCom);
    if (!shouldDrop) out.push(bytes.subarray(segStart, segEnd));

    if (marker === 0xda) {
      // Start of Scan: everything after this belongs to entropy-coded data
      // (and, for progressive JPEGs, further scans) — copy verbatim to EOF.
      out.push(bytes.subarray(segEnd));
      pos = bytes.length;
      break;
    }

    pos = segEnd;
  }

  const totalLen = out.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(totalLen);
  let o = 0;
  for (const c of out) { merged.set(c, o); o += c.length; }
  return { tags, out: merged };
}

/* ---------------------------------------------------------------------- */
/* PNG                                                                     */
/* ---------------------------------------------------------------------- */

const PNG_METADATA_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function chunkTypeName(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function processPng(bytes: Uint8Array, strip: boolean): { tags: FoundTag[]; out: Uint8Array<ArrayBuffer> } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tags: FoundTag[] = [];
  const out: Uint8Array[] = [bytes.subarray(0, 8)]; // signature
  let pos = 8;

  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos, false);
    const type = chunkTypeName(bytes, pos + 4);
    const chunkEnd = pos + 8 + len + 4; // length + type + data + crc
    if (chunkEnd > bytes.length) break;

    if (type === 'eXIf') {
      try { tags.push(...parseTiff(view, pos + 8)); } catch { /* ignore */ }
    } else if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      // Read the keyword (null-terminated ASCII at the start of the chunk data).
      let kw = '';
      let p = pos + 8;
      while (p < pos + 8 + len && bytes[p] !== 0) { kw += String.fromCharCode(bytes[p]); p++; }
      tags.push({ label: kw.startsWith('XML:com.adobe.xmp') ? 'XMP metadata' : `Text field (${kw || type})`, value: 'present' });
    } else if (type === 'tIME') {
      tags.push({ label: 'File modified date', value: 'present' });
    }

    const shouldDrop = strip && PNG_METADATA_CHUNKS.has(type);
    if (!shouldDrop) out.push(bytes.subarray(pos, chunkEnd));
    pos = chunkEnd;
  }

  const totalLen = out.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(totalLen);
  let o = 0;
  for (const c of out) { merged.set(c, o); o += c.length; }
  return { tags, out: merged };
}

/* ---------------------------------------------------------------------- */
/* WebP (RIFF container)                                                   */
/* ---------------------------------------------------------------------- */

function processWebp(bytes: Uint8Array, strip: boolean): { tags: FoundTag[]; out: Uint8Array<ArrayBuffer> } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tags: FoundTag[] = [];
  const chunks: Uint8Array[] = [];
  let pos = 12; // past 'RIFF' size 'WEBP'

  while (pos + 8 <= bytes.length) {
    const fourcc = chunkTypeName(bytes, pos);
    const size = view.getUint32(pos + 4, true); // RIFF is little-endian
    const padded = size + (size % 2);
    const chunkEnd = pos + 8 + padded;
    if (chunkEnd > bytes.length) break;

    if (fourcc === 'EXIF') {
      const dataStart = pos + 8;
      const hasPrefix =
        size >= 6 && bytes[dataStart] === 0x45 && bytes[dataStart + 1] === 0x78 &&
        bytes[dataStart + 2] === 0x69 && bytes[dataStart + 3] === 0x66;
      try { tags.push(...parseTiff(view, hasPrefix ? dataStart + 6 : dataStart)); } catch { /* ignore */ }
    } else if (fourcc === 'XMP ') {
      tags.push({ label: 'XMP metadata', value: 'present' });
    }

    const shouldDrop = strip && (fourcc === 'EXIF' || fourcc === 'XMP ');
    if (!shouldDrop) chunks.push(bytes.subarray(pos, chunkEnd));
    pos = chunkEnd;
  }

  const bodyLen = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(12 + bodyLen);
  merged.set(bytes.subarray(0, 4), 0); // 'RIFF'
  new DataView(merged.buffer).setUint32(4, 4 + bodyLen, true); // new RIFF size (excludes 'RIFF'+size field, includes 'WEBP')
  merged.set(bytes.subarray(8, 12), 8); // 'WEBP'
  let o = 12;
  for (const c of chunks) { merged.set(c, o); o += c.length; }

  // Dropping EXIF/XMP chunks leaves the VP8X flags bit pointing at metadata
  // that no longer exists — a malformed "EXIF bit set, no EXIF chunk" file that
  // makes exiftool (and strict parsers) still report EXIF present. Clear those
  // bits in any retained VP8X chunk: flags byte sits at chunk-data offset +1,
  // i.e. 8 bytes into the chunk (past 'VP8X' + 4-byte size). EXIF is 0x08,
  // XMP is 0x10. ICCP (0x02) / Alpha (0x04) / Animation (0x20) are untouched
  // because we keep those kinds of chunks.
  if (strip) {
    let p = 12;
    while (p + 8 <= merged.length) {
      if (merged[p] === 0x56 && merged[p + 1] === 0x50 && merged[p + 2] === 0x38 && merged[p + 3] === 0x58) { // 'VP8X'
        // VP8X chunk data layout: byte 0 = flags, byte 1 = reserved,
        // bytes 2-9 = 24-bit canvas width-1 / height-1. Flags sit at the
        // first data byte (8 bytes into the chunk, past 'VP8X' + size).
        const flagsOff = p + 8;
        if (flagsOff < merged.length) merged[flagsOff] &= ~(0x08 | 0x10);
        break;
      }
      const sz = new DataView(merged.buffer, merged.byteOffset, merged.byteLength).getUint32(p + 4, true);
      p += 8 + sz + (sz % 2);
    }
  }

  return { tags, out: merged };
}

/* ---------------------------------------------------------------------- */
/* Public API                                                              */
/* ---------------------------------------------------------------------- */

function dedupeTags(tags: FoundTag[]): FoundTag[] {
  const seen = new Set<string>();
  const out: FoundTag[] = [];
  for (const t of tags) {
    const key = t.label + '::' + t.value;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export async function stripMetadata(file: File): Promise<StripResult> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const kind = detectKind(buf);

  let tags: FoundTag[] = [];
  let out = buf;

  if (kind === 'jpeg') ({ tags, out } = processJpeg(buf, true));
  else if (kind === 'png') ({ tags, out } = processPng(buf, true));
  else if (kind === 'webp') ({ tags, out } = processWebp(buf, true));
  else throw new Error('Unsupported file type — only JPEG, PNG, and WebP are supported.');

  const uniqueTags = dedupeTags(tags);
  return {
    kind,
    tags: uniqueTags,
    hasGps: uniqueTags.some((t) => t.sensitive),
    hadAnyMetadata: uniqueTags.length > 0,
    cleaned: out,
    originalBytes: buf.length,
    cleanedBytes: out.length,
  };
}
