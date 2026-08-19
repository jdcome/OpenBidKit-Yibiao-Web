// 人员资质库路由（受保护 + 模块门禁 knowledge-base，公司共享）。
// 人物档案 1→N 证书：每证书独立 certName/certType/expiryDate/obtainedAt/notes + 多文件。
// 写操作 multipart；文件落 <dataDir>/shared/personnel/<profileId>/<certId>/<fileId><ext>。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { createPersonnelStore, type ExpiryFilter } from '../personnel/store';
import { getPersonnelCertFile } from '../document/paths';
import { mimeFor, collectAssetParts, persistUploaded, asString, asStringList } from '../asset-library/multipart';

function parseExpiry(raw: unknown): ExpiryFilter | undefined {
  const v = asString(raw as string | string[] | undefined);
  return v === 'active' || v === 'expiring' || v === 'expired' ? v : undefined;
}

export async function personnelRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;
  const store = createPersonnelStore(prisma);

  // GET /personnel?q=&expiry= → { profiles, counts }
  app.get('/personnel', async (req) => {
    const query = (req as FastifyRequest & { query: { q?: string; expiry?: string } }).query;
    const [profiles, counts] = await Promise.all([
      store.listProfiles({ q: query.q, expiry: parseExpiry(query.expiry) }),
      store.countByExpiry(),
    ]);
    return { profiles, counts };
  });

  // GET /personnel/expiring?withinDays=30 → { items }（仪表盘聚合，必须在 :id 前注册）
  app.get('/personnel/expiring', async (req) => {
    const withinDaysRaw = Number((req as FastifyRequest & { query: { withinDays?: string } }).query.withinDays);
    const withinDays = Number.isFinite(withinDaysRaw) && withinDaysRaw > 0 ? withinDaysRaw : 30;
    const items = await store.listExpiring(withinDays);
    return { items };
  });

  // POST /personnel (multipart: name/department/position/phone/notes/tags) → { profile }
  app.post('/personnel', async (req, reply) => {
    const { fields } = await collectAssetParts(req);
    const name = asString(fields.name).trim();
    if (!name) return reply.code(400).send({ success: false, message: '姓名不能为空' });
    const profile = await store.createProfile({
      name,
      department: asString(fields.department),
      position: asString(fields.position),
      phone: asString(fields.phone),
      notes: asString(fields.notes),
      tags: asStringList(fields.tags),
    });
    return { profile };
  });

  // GET /personnel/:id → { profile }
  app.get('/personnel/:id', async (req, reply) => {
    const { id } = (req as FastifyRequest & { params: { id: string } }).params;
    const profile = await store.getProfile(id);
    if (!profile) return reply.code(404).send({ success: false, message: '人员不存在' });
    return { profile };
  });

  // PATCH /personnel/:id (multipart) → { profile }
  app.patch('/personnel/:id', async (req, reply) => {
    const { id } = (req as FastifyRequest & { params: { id: string } }).params;
    const existing = await store.getProfile(id);
    if (!existing) return reply.code(404).send({ success: false, message: '人员不存在' });
    const { fields } = await collectAssetParts(req);
    const profile = await store.updateProfile(id, {
      name: fields.name !== undefined ? asString(fields.name) : undefined,
      department: fields.department !== undefined ? asString(fields.department) : undefined,
      position: fields.position !== undefined ? asString(fields.position) : undefined,
      phone: fields.phone !== undefined ? asString(fields.phone) : undefined,
      notes: fields.notes !== undefined ? asString(fields.notes) : undefined,
      tags: fields.tags !== undefined ? asStringList(fields.tags) : undefined,
    });
    return { profile };
  });

  // DELETE /personnel/:id → { success }
  app.delete('/personnel/:id', async (req) => {
    const { id } = (req as FastifyRequest & { params: { id: string } }).params;
    await store.deleteProfile(id);
    return { success: true };
  });

  // POST /personnel/:id/certificates (multipart: certName/certType/expiryDate/obtainedAt/notes + files) → { certificate, profile }
  app.post('/personnel/:id/certificates', async (req, reply) => {
    const { id } = (req as FastifyRequest & { params: { id: string } }).params;
    const profile = await store.getProfile(id);
    if (!profile) return reply.code(404).send({ success: false, message: '人员不存在' });
    const { fields, files } = await collectAssetParts(req);
    const certName = asString(fields.certName).trim();
    if (!certName) return reply.code(400).send({ success: false, message: '证书名称不能为空' });

    let certificate = await store.addCertificate(id, {
      certName,
      certType: asString(fields.certType),
      expiryDate: asString(fields.expiryDate) || null,
      obtainedAt: asString(fields.obtainedAt) || null,
      notes: asString(fields.notes),
    });
    if (files.length) {
      const metas = await persistUploaded(files, (fid, ext) => getPersonnelCertFile(undefined, id, certificate.id, fid, ext));
      certificate = await store.updateCertificate(id, certificate.id, { files: metas });
    }
    const refreshed = await store.getProfile(id);
    return { certificate, profile: refreshed };
  });

  // PATCH /personnel/:id/certificates/:certId (multipart: 字段 + removeFileIds + 新文件) → { certificate, profile }
  app.patch('/personnel/:id/certificates/:certId', async (req, reply) => {
    const { id, certId } = (req as FastifyRequest & { params: { id: string; certId: string } }).params;
    const current = await store.getCertificate(id, certId);
    if (!current) return reply.code(404).send({ success: false, message: '证书不存在' });
    const { fields, files } = await collectAssetParts(req);
    const removeFileIds = asStringList(fields.removeFileIds);
    const newMetas = files.length ? await persistUploaded(files, (fid, ext) => getPersonnelCertFile(undefined, id, certId, fid, ext)) : [];
    const finalFiles = [...current.files.filter((f) => !removeFileIds.includes(f.fileId)), ...newMetas];

    for (const fid of removeFileIds) {
      const meta = current.files.find((f) => f.fileId === fid);
      if (meta) await fsp.rm(getPersonnelCertFile(undefined, id, certId, meta.fileId, meta.ext), { force: true }).catch(() => undefined);
    }

    const certificate = await store.updateCertificate(id, certId, {
      certName: fields.certName !== undefined ? asString(fields.certName) : undefined,
      certType: fields.certType !== undefined ? asString(fields.certType) : undefined,
      expiryDate: fields.expiryDate !== undefined ? (asString(fields.expiryDate) || null) : undefined,
      obtainedAt: fields.obtainedAt !== undefined ? (asString(fields.obtainedAt) || null) : undefined,
      notes: fields.notes !== undefined ? asString(fields.notes) : undefined,
      files: finalFiles,
    });
    const profile = await store.getProfile(id);
    return { certificate, profile };
  });

  // DELETE /personnel/:id/certificates/:certId → { success, profile }
  app.delete('/personnel/:id/certificates/:certId', async (req) => {
    const { id, certId } = (req as FastifyRequest & { params: { id: string; certId: string } }).params;
    await store.deleteCertificate(id, certId);
    const profile = await store.getProfile(id);
    return { success: true, profile };
  });

  // GET /personnel/:id/certificates/:certId/files/:fileId?download=1 → 字节流（Bearer 鉴权）
  app.get('/personnel/:id/certificates/:certId/files/:fileId', async (req, reply) => {
    const { id, certId, fileId } = (req as FastifyRequest & { params: { id: string; certId: string; fileId: string } }).params;
    const cert = await store.getCertificate(id, certId);
    if (!cert) return reply.code(404).send({ success: false, message: '证书不存在' });
    const meta = cert.files.find((f) => f.fileId === fileId);
    if (!meta) return reply.code(404).send({ success: false, message: '文件不存在' });
    const abs = getPersonnelCertFile(undefined, id, certId, meta.fileId, meta.ext);
    try {
      await fsp.access(abs);
    } catch {
      return reply.code(404).send({ success: false, message: '文件不存在' });
    }
    const isDownload = (req as FastifyRequest & { query: { download?: string } }).query.download === '1';
    reply.header('Content-Type', meta.mimeType || mimeFor(meta.originalName));
    if (isDownload) {
      const safeName = encodeURIComponent(meta.originalName);
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${safeName}`);
    }
    return reply.send(fs.createReadStream(abs));
  });
}
