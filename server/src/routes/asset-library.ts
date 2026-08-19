// 资产/资质库路由（受保护 + 模块门禁 knowledge-base，公司共享）。
// 三库共用：工具模板库 tool / 公司资质库 company / 人员资质库 personnel，:library 参数白名单。
// 写操作用 multipart：字段 name/notes/expiryDate/tags/removeFileIds + 多个文件 part。
// 文件字节落 <dataDir>/shared/asset-library/<library>/<itemId>/<fileId><ext>；下载经 GET .../files/:fileId 流式返回。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { createAssetLibraryStore, ASSET_LIBRARIES, type AssetLibrary, type AssetFileMeta, type ExpiryFilter } from '../asset-library/store';
import { getAssetFilePath } from '../document/paths';
import {
  mimeFor,
  collectAssetParts,
  persistUploaded,
  asString,
  asStringList,
} from '../asset-library/multipart';

function parseLibrary(raw: unknown): AssetLibrary | null {
  return ASSET_LIBRARIES.includes(raw as AssetLibrary) ? (raw as AssetLibrary) : null;
}

function parseExpiry(raw: unknown): ExpiryFilter | undefined {
  const v = asString(raw as string | string[] | undefined);
  return v === 'active' || v === 'expiring' || v === 'expired' ? v : undefined;
}

async function persistFiles(library: AssetLibrary, itemId: string, uploads: { filename: string; mimetype: string; buffer: Buffer }[]): Promise<AssetFileMeta[]> {
  return persistUploaded(uploads, (fileId, ext) => getAssetFilePath(undefined, library, itemId, fileId, ext));
}

export async function assetLibraryRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;
  const store = createAssetLibraryStore(prisma);

  // GET /asset-library/:library?q=&expiry= → { items, counts }
  app.get('/asset-library/:library', async (req, reply) => {
    const library = parseLibrary((req as FastifyRequest & { params: { library: string } }).params.library);
    if (!library) return reply.code(400).send({ success: false, message: '无效的库类型' });
    const query = (req as FastifyRequest & { query: { q?: string; expiry?: string } }).query;
    const [items, counts] = await Promise.all([
      store.listItems(library, { q: query.q, expiry: parseExpiry(query.expiry) }),
      store.countByExpiry(library),
    ]);
    return { items, counts };
  });

  // POST /asset-library/:library (multipart) → { item }
  app.post('/asset-library/:library', async (req, reply) => {
    const library = parseLibrary((req as FastifyRequest & { params: { library: string } }).params.library);
    if (!library) return reply.code(400).send({ success: false, message: '无效的库类型' });
    const { fields, files } = await collectAssetParts(req);
    const name = asString(fields.name).trim();
    if (!name) return reply.code(400).send({ success: false, message: '名称不能为空' });

    const item = await store.createItem(library, {
      name,
      notes: asString(fields.notes),
      expiryDate: asString(fields.expiryDate) || null,
      tags: asStringList(fields.tags),
    });
    if (files.length) {
      const metas = await persistFiles(library, item.id, files);
      const updated = await store.updateItem(library, item.id, { files: metas });
      return { item: updated };
    }
    return { item };
  });

  // GET /asset-library/:library/:id → { item }
  app.get('/asset-library/:library/:id', async (req, reply) => {
    const library = parseLibrary((req as FastifyRequest & { params: { library: string } }).params.library);
    if (!library) return reply.code(400).send({ success: false, message: '无效的库类型' });
    const { id } = (req as FastifyRequest & { params: { id: string } }).params;
    const item = await store.getItem(library, id);
    if (!item) return reply.code(404).send({ success: false, message: '条目不存在' });
    return { item };
  });

  // PATCH /asset-library/:library/:id (multipart) → { item }
  // 字段 name/notes/expiryDate/tags/removeFileIds + 新文件 part。
  app.patch('/asset-library/:library/:id', async (req, reply) => {
    const library = parseLibrary((req as FastifyRequest & { params: { library: string } }).params.library);
    if (!library) return reply.code(400).send({ success: false, message: '无效的库类型' });
    const { id } = (req as FastifyRequest & { params: { id: string } }).params;
    const current = await store.getItem(library, id);
    if (!current) return reply.code(404).send({ success: false, message: '条目不存在' });

    const { fields, files } = await collectAssetParts(req);
    const removeFileIds = asStringList(fields.removeFileIds);
    const newMetas = files.length ? await persistFiles(library, id, files) : [];
    const finalFiles = [...current.files.filter((f) => !removeFileIds.includes(f.fileId)), ...newMetas];

    // 删除被移除文件的字节
    for (const fid of removeFileIds) {
      const meta = current.files.find((f) => f.fileId === fid);
      if (meta) {
        const p = getAssetFilePath(undefined, library, id, meta.fileId, meta.ext);
        await fsp.rm(p, { force: true }).catch(() => undefined);
      }
    }

    const item = await store.updateItem(library, id, {
      name: asString(fields.name) || undefined,
      notes: fields.notes !== undefined ? asString(fields.notes) : undefined,
      expiryDate: fields.expiryDate !== undefined ? (asString(fields.expiryDate) || null) : undefined,
      tags: fields.tags !== undefined ? asStringList(fields.tags) : undefined,
      files: finalFiles,
    });
    return { item };
  });

  // DELETE /asset-library/:library/:id → { success }
  app.delete('/asset-library/:library/:id', async (req, reply) => {
    const library = parseLibrary((req as FastifyRequest & { params: { library: string } }).params.library);
    if (!library) return reply.code(400).send({ success: false, message: '无效的库类型' });
    const { id } = (req as FastifyRequest & { params: { id: string } }).params;
    await store.deleteItem(library, id);
    return { success: true };
  });

  // GET /asset-library/:library/:id/files/:fileId?download=1 → 文件字节流（Bearer 鉴权）。
  app.get('/asset-library/:library/:id/files/:fileId', async (req, reply) => {
    const library = parseLibrary((req as FastifyRequest & { params: { library: string } }).params.library);
    if (!library) return reply.code(400).send({ success: false, message: '无效的库类型' });
    const { id, fileId } = (req as FastifyRequest & { params: { id: string; fileId: string } }).params;
    const item = await store.getItem(library, id);
    if (!item) return reply.code(404).send({ success: false, message: '条目不存在' });
    const meta = item.files.find((f) => f.fileId === fileId);
    if (!meta) return reply.code(404).send({ success: false, message: '文件不存在' });

    const abs = getAssetFilePath(undefined, library, id, meta.fileId, meta.ext);
    try {
      await fsp.access(abs);
    } catch {
      return reply.code(404).send({ success: false, message: '文件不存在' });
    }
    const isDownload = (req as FastifyRequest & { query: { download?: string } }).query.download === '1';
    reply.header('Content-Type', meta.mimeType || 'application/octet-stream');
    if (isDownload) {
      const safeName = encodeURIComponent(meta.originalName);
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${safeName}`);
    }
    return reply.send(fs.createReadStream(abs));
  });

  // GET /asset-library/expiring?withinDays=30 → { items }（仪表盘聚合，跨库）
  app.get('/asset-library/expiring', async (req) => {
    const withinDaysRaw = Number((req as FastifyRequest & { query: { withinDays?: string } }).query.withinDays);
    const withinDays = Number.isFinite(withinDaysRaw) && withinDaysRaw > 0 ? withinDaysRaw : 30;
    const items = await store.listExpiring(withinDays);
    return { items };
  });
}
