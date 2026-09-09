import { deflateSync, inflateSync } from 'node:zlib';
import { chunk } from '../media/pngChunk.ts';

export interface ParsedCard {
  name: string;
  chatName: string | null;
  personality: string;
  scenario: string;
  examples: string;
  firstMessage: string;
  systemPrompt: string | null;
  raw: unknown;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(data: Buffer): boolean {
  return data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE);
}
const MAX_COMPRESSED_METADATA = 1024 * 1024;
const MAX_DECOMPRESSED_METADATA = 8 * 1024 * 1024;

function relevantKeyword(keyword: string): boolean {
  return keyword === 'chara' || keyword === 'ccv3';
}

function boundedText(payload: Buffer, compressed: boolean): string {
  if (payload.length > (compressed ? MAX_COMPRESSED_METADATA : MAX_DECOMPRESSED_METADATA)) {
    throw new Error('Character card metadata is too large');
  }
  const decoded = compressed
    ? inflateSync(payload, { maxOutputLength: MAX_DECOMPRESSED_METADATA })
    : payload;
  if (decoded.length > MAX_DECOMPRESSED_METADATA) {
    throw new Error('Character card metadata is too large');
  }
  return decoded.toString('utf8');
}

function extractTextChunks(png: Buffer): Map<string, string> {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG file');
  }
  const chunks = new Map<string, string>();
  let off = 8;
  while (off + 12 <= png.length) {
    const length = png.readUInt32BE(off);
    const chunkEnd = off + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > png.length) {
      throw new Error('PNG contains a truncated chunk');
    }
    const type = png.toString('latin1', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + length);
    if (type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul > 0) {
        const keyword = data.toString('latin1', 0, nul);
        if (relevantKeyword(keyword))
          chunks.set(keyword, boundedText(data.subarray(nul + 1), false));
      }
    } else if (type === 'iTXt') {
      const nul = data.indexOf(0);
      if (nul > 0 && nul + 2 < data.length) {
        const keyword = data.toString('latin1', 0, nul);
        if (!relevantKeyword(keyword)) {
          off = chunkEnd;
          continue;
        }
        const compressed = data[nul + 1] === 1;
        if (data[nul + 1] !== 0 && !compressed) throw new Error('Invalid iTXt compression flag');
        if (data[nul + 2] !== 0) throw new Error('Unsupported iTXt compression method');
        // Skip compression bytes, then the NUL-terminated language and translated keyword.
        let p = nul + 3;
        const languageEnd = data.indexOf(0, p);
        if (languageEnd === -1) throw new Error('Invalid iTXt language field');
        p = languageEnd + 1;
        const translatedEnd = data.indexOf(0, p);
        if (translatedEnd === -1) throw new Error('Invalid iTXt translated keyword');
        p = translatedEnd + 1;
        if (p <= data.length) {
          const payload = data.subarray(p);
          chunks.set(keyword, boundedText(payload, compressed));
        }
      }
    } else if (type === 'IEND') {
      break;
    }
    off = chunkEnd;
  }
  return chunks;
}

interface CardData {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  mes_example?: string;
  first_mes?: string;
  system_prompt?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalCardString(
  data: Record<string, unknown>,
  key: keyof CardData,
): string | undefined {
  const value = data[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Character card ${key} must be a string`);
  return value;
}

/** Parses a SillyTavern character card PNG (V1 flat, V2 'chara', or V3 'ccv3'). */
export function parseCharacterCard(png: Buffer): ParsedCard {
  const chunks = extractTextChunks(png);
  const encoded = chunks.get('ccv3') ?? chunks.get('chara');
  if (!encoded) throw new Error('No character card data found in PNG (missing chara/ccv3 chunk)');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    throw new Error('Character card data is not valid base64 JSON');
  }
  const json = record(parsed);
  if (!json) throw new Error('Character card JSON must be an object');
  const nested = json.data;
  const data = nested === undefined ? json : record(nested);
  if (!data) throw new Error('Character card data must be an object');
  const name = optionalCardString(data, 'name');
  if (!name?.trim()) throw new Error('Character card has no name');
  const description = optionalCardString(data, 'description');
  const traits = optionalCardString(data, 'personality');
  const scenario = optionalCardString(data, 'scenario');
  const examples = optionalCardString(data, 'mes_example');
  const firstMessage = optionalCardString(data, 'first_mes');
  const systemPrompt = optionalCardString(data, 'system_prompt');
  const extension = record(record(data.extensions)?.tinytavern);
  const chatName = extension?.chatName;
  if (chatName != null && typeof chatName !== 'string') {
    throw new Error('Character card chatName must be a string or null');
  }
  const personality = [description?.trim(), traits?.trim()].filter(Boolean).join('\n\n');
  return {
    name: name.trim(),
    chatName: typeof chatName === 'string' ? chatName.trim() || null : null,
    personality,
    scenario: scenario?.trim() ?? '',
    // Preserve SillyTavern's <START>-separated examples.
    examples: examples?.trim() ?? '',
    firstMessage: firstMessage?.trim() ?? '',
    systemPrompt: systemPrompt?.trim() || null,
    raw: parsed,
  };
}

/** Minimal fallback portrait for characters without a PNG avatar. */
export function makePlaceholderPng(): Buffer {
  const size = 256;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      raw[rowStart + 1 + x * 3] = 0x17;
      raw[rowStart + 2 + x * 3] = 0x17;
      raw[rowStart + 3 + x * 3] = 0x17;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Replace existing chara/ccv3 metadata with a V2 tEXt 'chara' chunk. */
export function buildCharacterCard(png: Buffer, card: unknown): Buffer {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('avatar is not a PNG');
  }
  const parts: Buffer[] = [png.subarray(0, 8)];
  let off = 8;
  while (off + 12 <= png.length) {
    const length = png.readUInt32BE(off);
    if (!Number.isSafeInteger(off + 12 + length) || off + 12 + length > png.length) {
      throw new Error('PNG contains a truncated chunk');
    }
    const type = png.toString('latin1', off + 4, off + 8);
    const rawChunk = png.subarray(off, off + 12 + length);
    off += 12 + length;
    if (type === 'tEXt' || type === 'iTXt') {
      const data = rawChunk.subarray(8, 8 + length);
      const nul = data.indexOf(0);
      const keyword = nul > 0 ? data.toString('latin1', 0, nul) : '';
      if (keyword === 'chara' || keyword === 'ccv3') continue;
    }
    if (type === 'IEND') break;
    parts.push(rawChunk);
  }
  const payload = Buffer.concat([
    Buffer.from('chara', 'latin1'),
    Buffer.from([0]),
    Buffer.from(Buffer.from(JSON.stringify(card), 'utf8').toString('base64'), 'latin1'),
  ]);
  parts.push(chunk('tEXt', payload));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
