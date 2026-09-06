import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { GenerationKind, MessageStatus, Role } from '@minitavern/shared';
import { IMAGES_DIR, stmt, toConversation, toMessage, transaction } from '../db.ts';
import { invalidate } from '../events.ts';
import { mergeLiveBuffers } from '../generation.ts';
import { deleteImageFiles, rasterImageFormat, saveImage } from '../images.ts';
import { HttpError, route } from '../router.ts';
import { getPathToMessage } from '../tree.ts';
import { positiveId } from '../validation.ts';
import { parseImageConfig } from '../comfy.ts';

const FORMAT = 'minitavern-conversation';
const VERSION = 1;
const MAX_MESSAGES = 10_000;
const MAX_ASSETS = 1_000;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_IMPORT_BODY_BYTES = 256 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

interface TransferReference {
  sourceId: number;
  name: string;
}

interface TransferConversation {
  title: string;
  character: TransferReference | null;
  persona: TransferReference | null;
  endpoint: TransferReference | null;
  speakerName: string | null;
  scenarioOverride: string | null;
  activeLeafId: number | null;
  createdAt: number;
  updatedAt: number;
}

interface TransferAsset {
  id: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  dataBase64: string;
}

interface TransferMessage {
  id: number;
  parentId: number | null;
  role: Role;
  content: string;
  reasoning: string | null;
  name: string | null;
  status: MessageStatus;
  activeChildId: number | null;
  model: string | null;
  genMeta: JsonObject | null;
  generationKind: GenerationKind;
  imageAssetIds: string[];
  activeImage: number;
  imageRender: { workflow: string; comfyUrl: string } | null;
  createdAt: number;
}

export interface PortableConversationV1 {
  format: typeof FORMAT;
  version: typeof VERSION;
  exportedAt: number;
  conversation: TransferConversation;
  messages: TransferMessage[];
  assets: TransferAsset[];
}

interface MessageRow {
  id: number;
  parent_id: number | null;
  role: Role;
  content: string;
  reasoning: string | null;
  status: MessageStatus;
  active_child_id: number | null;
  model: string | null;
  gen_meta_json: string | null;
  created_at: number;
  name: string | null;
  generation_kind: GenerationKind;
  images_json: string;
  active_image: number;
  image_render_json: string | null;
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be an object`);
  }
  return value as JsonObject;
}

function string(value: unknown, label: string, max?: number): string {
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string`);
  if (max != null && value.length > max) throw new HttpError(400, `${label} is too long`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value == null ? null : string(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new HttpError(400, `${label} must be a positive integer`);
  }
  return value as number;
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  return value == null ? null : positiveInteger(value, label);
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HttpError(400, `${label} must be a non-negative integer`);
  }
  return value as number;
}

function parseJsonObject(raw: string | null, label: string): JsonObject | null {
  if (raw == null) return null;
  try {
    return object(JSON.parse(raw), label);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(409, `${label} contains invalid JSON`);
  }
}

function namedReference(table: 'characters' | 'personas' | 'endpoints', id: number | null) {
  if (id == null) return null;
  const row = stmt(`SELECT id, name FROM ${table} WHERE id = ?`).get(id) as
    { id: number; name: string } | undefined;
  return row ? { sourceId: row.id, name: row.name } : null;
}

function exportImage(path: string): { mime: TransferAsset['mime']; data: Buffer } {
  if (!path.startsWith('/images/')) throw new HttpError(409, `unsupported image path: ${path}`);
  const name = path.slice('/images/'.length);
  if (!name || basename(name) !== name) throw new HttpError(409, `unsafe image path: ${path}`);
  let data: Buffer;
  try {
    data = readFileSync(join(IMAGES_DIR, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HttpError(409, `cannot export missing image: ${path}`);
    }
    throw err;
  }
  const format = rasterImageFormat(data);
  if (!format) throw new HttpError(409, `cannot export invalid image: ${path}`);
  if (data.length > MAX_IMAGE_BYTES)
    throw new HttpError(409, `cannot export oversized image: ${path}`);
  return { mime: format.mime, data };
}

export function exportPortableConversation(conversationId: number): PortableConversationV1 {
  const convRow = stmt('SELECT * FROM conversations WHERE id = ?').get(conversationId) as
    Record<string, unknown> | undefined;
  if (!convRow) throw new HttpError(404, `conversation ${conversationId} not found`);
  const conv = toConversation(convRow);
  const rows = stmt('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(
    conversationId,
  ) as unknown as MessageRow[];
  if (rows.length > MAX_MESSAGES) {
    throw new HttpError(409, `conversation has more than ${MAX_MESSAGES} messages`);
  }
  const live = new Map(
    mergeLiveBuffers(rows.map((row) => toMessage(row as unknown as Record<string, unknown>))).map(
      (message) => [message.id, message],
    ),
  );
  const assets: TransferAsset[] = [];
  const assetByPath = new Map<string, string>();
  let totalImageBytes = 0;
  const messages = rows.map((row): TransferMessage => {
    const imageAssetIds = (JSON.parse(row.images_json) as string[]).map((path) => {
      const existing = assetByPath.get(path);
      if (existing) return existing;
      const image = exportImage(path);
      if (assets.length >= MAX_ASSETS) {
        throw new HttpError(409, `conversation has more than ${MAX_ASSETS} image assets`);
      }
      totalImageBytes += image.data.length;
      if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
        throw new HttpError(409, 'conversation image assets are too large to export');
      }
      const id = `image-${assets.length + 1}`;
      assetByPath.set(path, id);
      assets.push({ id, mime: image.mime, dataBase64: image.data.toString('base64') });
      return id;
    });
    let imageRender: TransferMessage['imageRender'] = null;
    if (row.image_render_json != null) {
      try {
        imageRender = parseImageConfig(JSON.parse(row.image_render_json));
      } catch (err) {
        throw new HttpError(
          409,
          `message ${row.id} has invalid image render configuration: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const current = live.get(row.id);
    return {
      id: row.id,
      parentId: row.parent_id,
      role: row.role,
      content: current?.content ?? row.content,
      reasoning: current?.reasoning ?? row.reasoning,
      name: row.name,
      status: row.status,
      activeChildId: row.active_child_id,
      model: current?.model ?? row.model,
      genMeta: parseJsonObject(row.gen_meta_json, `message ${row.id} genMeta`),
      generationKind: row.generation_kind,
      imageAssetIds,
      activeImage: row.active_image,
      imageRender,
      createdAt: row.created_at,
    };
  });

  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: Date.now(),
    conversation: {
      title: conv.title,
      character: namedReference('characters', conv.characterId),
      persona: namedReference('personas', conv.personaId),
      endpoint: namedReference('endpoints', conv.endpointId),
      speakerName: conv.speakerName,
      scenarioOverride: conv.scenarioOverride,
      activeLeafId: conv.activeLeafId,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    },
    messages,
    assets,
  };
}

function parseReference(value: unknown, label: string): TransferReference | null {
  if (value == null) return null;
  const ref = object(value, label);
  return {
    sourceId: positiveInteger(ref.sourceId, `${label}.sourceId`),
    name: string(ref.name, `${label}.name`),
  };
}

function decodeBase64(value: unknown, label: string): Buffer {
  const encoded = string(value, label, Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new HttpError(400, `${label} is not canonical base64`);
  }
  const data = Buffer.from(encoded, 'base64');
  if (data.length > MAX_IMAGE_BYTES || data.toString('base64') !== encoded) {
    throw new HttpError(400, `${label} is not canonical base64`);
  }
  return data;
}

function parsePortableConversation(raw: unknown): {
  conversation: TransferConversation;
  messages: TransferMessage[];
  assets: Map<string, { data: Buffer; ext: string }>;
} {
  const root = object(raw, 'import');
  if (root.format !== FORMAT) throw new HttpError(400, `format must be ${FORMAT}`);
  if (root.version !== VERSION)
    throw new HttpError(400, `unsupported export version: ${String(root.version)}`);
  const sourceConversation = object(root.conversation, 'conversation');
  const title = string(sourceConversation.title, 'conversation.title');
  const conversation: TransferConversation = {
    title,
    character: parseReference(sourceConversation.character, 'conversation.character'),
    persona: parseReference(sourceConversation.persona, 'conversation.persona'),
    endpoint: parseReference(sourceConversation.endpoint, 'conversation.endpoint'),
    speakerName: nullableString(sourceConversation.speakerName, 'conversation.speakerName'),
    // Older V1 exports omit this field and retain inherited scenario behavior.
    scenarioOverride: nullableString(
      sourceConversation.scenarioOverride,
      'conversation.scenarioOverride',
    ),
    activeLeafId: nullablePositiveInteger(
      sourceConversation.activeLeafId,
      'conversation.activeLeafId',
    ),
    createdAt: timestamp(sourceConversation.createdAt, 'conversation.createdAt'),
    updatedAt: timestamp(sourceConversation.updatedAt, 'conversation.updatedAt'),
  };
  if (!conversation.title.trim()) throw new HttpError(400, 'conversation.title is required');

  if (!Array.isArray(root.assets)) throw new HttpError(400, 'assets must be an array');
  if (root.assets.length > MAX_ASSETS) throw new HttpError(400, 'too many image assets');
  const assets = new Map<string, { data: Buffer; ext: string }>();
  let totalImageBytes = 0;
  for (let i = 0; i < root.assets.length; i++) {
    const asset = object(root.assets[i], `assets[${i}]`);
    const id = string(asset.id, `assets[${i}].id`, 200);
    if (!id || assets.has(id)) throw new HttpError(400, `assets[${i}].id must be unique`);
    const data = decodeBase64(asset.dataBase64, `assets[${i}].dataBase64`);
    totalImageBytes += data.length;
    if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new HttpError(400, 'embedded image assets are too large');
    }
    const detected = rasterImageFormat(data);
    if (!detected) throw new HttpError(400, `assets[${i}] is not a valid supported raster image`);
    if (asset.mime !== detected.mime) {
      throw new HttpError(400, `assets[${i}].mime does not match its image bytes`);
    }
    assets.set(id, { data, ext: detected.ext });
  }

  if (!Array.isArray(root.messages)) throw new HttpError(400, 'messages must be an array');
  if (root.messages.length > MAX_MESSAGES) throw new HttpError(400, 'too many messages');
  const ids = new Set<number>();
  const usedAssets = new Set<string>();
  const roles = new Set<Role>(['user', 'assistant', 'system', 'tool']);
  const statuses = new Set<MessageStatus>(['done', 'streaming', 'error', 'stopped']);
  const generationKinds = new Set<GenerationKind>(['normal', 'speculative']);
  const messages = root.messages.map((rawMessage, i): TransferMessage => {
    const source = object(rawMessage, `messages[${i}]`);
    const id = positiveInteger(source.id, `messages[${i}].id`);
    if (ids.has(id)) throw new HttpError(400, `duplicate message id ${id}`);
    ids.add(id);
    if (!roles.has(source.role as Role)) throw new HttpError(400, `messages[${i}].role is invalid`);
    if (!statuses.has(source.status as MessageStatus)) {
      throw new HttpError(400, `messages[${i}].status is invalid`);
    }
    if (!generationKinds.has(source.generationKind as GenerationKind)) {
      throw new HttpError(400, `messages[${i}].generationKind is invalid`);
    }
    if (!Array.isArray(source.imageAssetIds)) {
      throw new HttpError(400, `messages[${i}].imageAssetIds must be an array`);
    }
    const imageAssetIds = source.imageAssetIds.map((value, imageIndex) => {
      const assetId = string(value, `messages[${i}].imageAssetIds[${imageIndex}]`, 200);
      if (!assets.has(assetId)) throw new HttpError(400, `unknown image asset ${assetId}`);
      usedAssets.add(assetId);
      return assetId;
    });
    const activeImage = source.activeImage;
    if (!Number.isSafeInteger(activeImage) || (activeImage as number) < 0) {
      throw new HttpError(400, `messages[${i}].activeImage must be a non-negative integer`);
    }
    if (
      (imageAssetIds.length === 0 && activeImage !== 0) ||
      (imageAssetIds.length > 0 && (activeImage as number) >= imageAssetIds.length)
    ) {
      throw new HttpError(400, `messages[${i}].activeImage is out of range`);
    }
    let genMeta: JsonObject | null = null;
    if (source.genMeta != null) genMeta = object(source.genMeta, `messages[${i}].genMeta`);
    let imageRender: TransferMessage['imageRender'] = null;
    if (source.imageRender != null) {
      try {
        imageRender = parseImageConfig(source.imageRender);
      } catch (err) {
        throw new HttpError(
          400,
          `messages[${i}].imageRender is invalid: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return {
      id,
      parentId: nullablePositiveInteger(source.parentId, `messages[${i}].parentId`),
      role: source.role as Role,
      content: string(source.content, `messages[${i}].content`),
      reasoning: nullableString(source.reasoning, `messages[${i}].reasoning`),
      name: nullableString(source.name, `messages[${i}].name`),
      status: source.status as MessageStatus,
      activeChildId: nullablePositiveInteger(source.activeChildId, `messages[${i}].activeChildId`),
      model: nullableString(source.model, `messages[${i}].model`),
      genMeta,
      generationKind: source.generationKind as GenerationKind,
      imageAssetIds,
      activeImage: activeImage as number,
      imageRender,
      createdAt: timestamp(source.createdAt, `messages[${i}].createdAt`),
    };
  });
  if (usedAssets.size !== assets.size)
    throw new HttpError(400, 'export contains unused image assets');

  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const message of messages) {
    if (message.parentId != null && !byId.has(message.parentId)) {
      throw new HttpError(400, `message ${message.id} has an unknown parent`);
    }
    if (message.activeChildId != null) {
      const child = byId.get(message.activeChildId);
      if (!child || child.parentId !== message.id) {
        throw new HttpError(400, `message ${message.id} has an invalid active child`);
      }
    }
  }
  // Cache completed walks to keep cycle detection linear on deep chains.
  const visit = new Map<number, 1 | 2>();
  for (const start of messages) {
    if (visit.get(start.id) === 2) continue;
    const chain: number[] = [];
    let current: TransferMessage | undefined = start;
    while (current && visit.get(current.id) !== 2) {
      if (visit.get(current.id) === 1) throw new HttpError(400, 'message tree contains a cycle');
      visit.set(current.id, 1);
      chain.push(current.id);
      current = current.parentId == null ? undefined : byId.get(current.parentId);
    }
    for (const id of chain) visit.set(id, 2);
  }
  if (messages.length === 0 && conversation.activeLeafId != null) {
    throw new HttpError(400, 'empty conversation cannot have an active leaf');
  }
  if (messages.length > 0 && conversation.activeLeafId == null) {
    throw new HttpError(400, 'non-empty conversation must have an active leaf');
  }
  if (conversation.activeLeafId != null) {
    let childId = conversation.activeLeafId;
    for (;;) {
      const current: TransferMessage | undefined = byId.get(childId);
      if (!current) throw new HttpError(400, 'conversation.activeLeafId is unknown');
      if (current.parentId == null) break;
      const parent: TransferMessage | undefined = byId.get(current.parentId);
      if (!parent) throw new HttpError(400, `message ${current.id} has an unknown parent`);
      if (parent.activeChildId !== childId) {
        throw new HttpError(400, 'active leaf path does not match selected alternatives');
      }
      childId = parent.id;
    }
  }
  return { conversation, messages, assets };
}

function resolveReference(
  table: 'characters' | 'personas' | 'endpoints',
  reference: TransferReference | null,
): number | null {
  if (!reference) return null;
  const byId = stmt(`SELECT id, name FROM ${table} WHERE id = ?`).get(reference.sourceId) as
    { id: number; name: string } | undefined;
  if (byId?.name === reference.name) return byId.id;
  const byName = stmt(`SELECT id FROM ${table} WHERE name = ? ORDER BY id LIMIT 2`).all(
    reference.name,
  ) as { id: number }[];
  return byName.length === 1 ? byName[0]!.id : null;
}

/** Validate and import without retaining any source-server image pathname. */
export function importPortableConversation(raw: unknown): ReturnType<typeof toConversation> {
  const parsed = parsePortableConversation(raw);
  const writtenImages: string[] = [];
  try {
    const newConversationId = transaction(() => {
      const conv = parsed.conversation;
      const result = stmt(
        `INSERT INTO conversations
           (title, character_id, persona_id, endpoint_id, speaker_name, scenario_override,
            active_leaf_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        conv.title,
        resolveReference('characters', conv.character),
        resolveReference('personas', conv.persona),
        resolveReference('endpoints', conv.endpoint),
        conv.speakerName,
        conv.scenarioOverride,
        conv.createdAt,
        conv.updatedAt,
      );
      const conversationId = Number(result.lastInsertRowid);
      const idMap = new Map<number, number>();
      for (const message of parsed.messages) {
        const images = message.imageAssetIds.map((assetId) => {
          const asset = parsed.assets.get(assetId)!;
          const path = saveImage(`msg-import-${randomUUID()}${asset.ext}`, asset.data);
          writtenImages.push(path);
          return path;
        });
        const inserted = stmt(
          `INSERT INTO messages
             (conversation_id, parent_id, role, content, reasoning, status, active_child_id,
              model, gen_meta_json, created_at, name, generation_kind, images_json, active_image,
              image_pending, image_render_json)
           VALUES (?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        ).run(
          conversationId,
          message.role,
          message.content,
          message.reasoning,
          message.status === 'streaming' ? 'stopped' : message.status,
          message.model,
          message.genMeta == null ? null : JSON.stringify(message.genMeta),
          message.createdAt,
          message.name,
          message.generationKind,
          JSON.stringify(images),
          message.activeImage,
          message.imageRender == null ? null : JSON.stringify(message.imageRender),
        );
        idMap.set(message.id, Number(inserted.lastInsertRowid));
      }
      for (const message of parsed.messages) {
        stmt('UPDATE messages SET parent_id = ?, active_child_id = ? WHERE id = ?').run(
          message.parentId == null ? null : idMap.get(message.parentId)!,
          message.activeChildId == null ? null : idMap.get(message.activeChildId)!,
          idMap.get(message.id)!,
        );
      }
      if (conv.activeLeafId != null) {
        const activeLeafId = idMap.get(conv.activeLeafId)!;
        stmt('UPDATE conversations SET active_leaf_id = ? WHERE id = ?').run(
          activeLeafId,
          conversationId,
        );
        const importedPath = getPathToMessage(activeLeafId);
        if (importedPath.length === 0 || importedPath.at(-1)?.id !== activeLeafId) {
          throw new Error('imported conversation active path failed validation');
        }
      }
      return conversationId;
    });
    invalidate('conversations');
    const row = stmt('SELECT * FROM conversations WHERE id = ?').get(newConversationId) as Record<
      string,
      unknown
    >;
    return toConversation(row);
  } catch (err) {
    deleteImageFiles(writtenImages);
    throw err;
  }
}

route.get('/api/conversations/:id/export', ({ params, res }) => {
  const payload = exportPortableConversation(positiveId(params.id));
  const filename = payload.conversation.title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'chat';
  const json = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(json) > MAX_IMPORT_BODY_BYTES) {
    throw new HttpError(413, 'conversation export is too large to import');
  }
  res
    .writeHead(200, {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="${filename}.minitavern.json"`,
    })
    .end(json);
});

route.post('/api/conversations/import', ({ body }) => importPortableConversation(body), {
  maxBodyBytes: MAX_IMPORT_BODY_BYTES,
});
