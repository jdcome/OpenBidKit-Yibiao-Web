// 资产/资质库存储层（工具模板库 tool / 公司资质库 company / 人员资质库 personnel）。
// 公司共享（无 userId 隔离）。files 存 JSON 元数据数组；文件字节由路由落 <dataDir>/shared/asset-library/<library>/<itemId>/。
// 到期提醒：expiryDate 为空表示不参与提醒（工具库典型留空）；临期窗口默认 30 天。
import type { PrismaClient, Prisma } from '@prisma/client';
import fs from 'node:fs/promises';
import { getAssetItemDir } from '../document/paths';

export type AssetLibrary = 'tool' | 'company' | 'personnel';
export const ASSET_LIBRARIES: AssetLibrary[] = ['tool', 'company', 'personnel'];
export const EXPIRY_WINDOW_DAYS = 30;

export interface AssetFileMeta {
  fileId: string;
  originalName: string;
  mimeType: string;
  size: number;
  ext: string;
}

export interface AssetItem {
  id: string;
  library: string;
  name: string;
  notes: string;
  files: AssetFileMeta[];
  expiryDate: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AssetExpiringItem extends AssetItem {
  daysUntil: number;
}

export type ExpiryFilter = 'active' | 'expiring' | 'expired';

function toIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function rowToItem(row: {
  id: string;
  library: string;
  name: string;
  notes: string;
  files: unknown;
  expiryDate: Date | null;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}): AssetItem {
  const files = Array.isArray(row.files) ? (row.files as AssetFileMeta[]) : [];
  return {
    id: row.id,
    library: row.library,
    name: row.name,
    notes: row.notes ?? '',
    files,
    expiryDate: toIso(row.expiryDate),
    tags: row.tags ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function expiryWhere(expiry: ExpiryFilter, now: Date, horizonEnd: Date): Prisma.AssetItemWhereInput {
  switch (expiry) {
    case 'expired':
      return { expiryDate: { not: null, lt: now } };
    case 'expiring':
      return { expiryDate: { not: null, gte: now, lte: horizonEnd } };
    case 'active':
    default:
      return { OR: [{ expiryDate: null }, { expiryDate: { gt: horizonEnd } }] };
  }
}

export interface CreateAssetInput {
  name: string;
  notes?: string;
  expiryDate?: string | null;
  tags?: string[];
  files?: AssetFileMeta[];
}

export interface UpdateAssetInput {
  name?: string;
  notes?: string;
  expiryDate?: string | null;
  tags?: string[];
  files?: AssetFileMeta[];
}

export function createAssetLibraryStore(prisma: PrismaClient) {
  async function listItems(
    library: AssetLibrary,
    opts: { q?: string; expiry?: ExpiryFilter } = {},
  ): Promise<AssetItem[]> {
    const now = new Date();
    const horizonEnd = new Date(now.getTime() + EXPIRY_WINDOW_DAYS * DAY_MS);
    const where: Prisma.AssetItemWhereInput = { library };
    const q = opts.q?.trim();
    if (q) {
      where.AND = [
        {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { notes: { contains: q, mode: 'insensitive' } },
            { tags: { has: q } },
          ],
        },
      ];
    }
    if (opts.expiry) {
      where.AND = [...((where.AND as Prisma.AssetItemWhereInput[]) ?? []), expiryWhere(opts.expiry, now, horizonEnd)];
    }
    const orderBy: Prisma.AssetItemOrderByWithRelationInput[] =
      opts.expiry === 'expiring' || opts.expiry === 'expired'
        ? [{ expiryDate: 'asc' }, { updatedAt: 'desc' }]
        : [{ updatedAt: 'desc' }];
    const rows = await prisma.assetItem.findMany({ where, orderBy });
    return rows.map(rowToItem);
  }

  async function countByExpiry(library: AssetLibrary): Promise<{ expiring: number; expired: number }> {
    const now = new Date();
    const horizonEnd = new Date(now.getTime() + EXPIRY_WINDOW_DAYS * DAY_MS);
    const [expiring, expired] = await Promise.all([
      prisma.assetItem.count({ where: { library, ...expiryWhere('expiring', now, horizonEnd) } }),
      prisma.assetItem.count({ where: { library, ...expiryWhere('expired', now, horizonEnd) } }),
    ]);
    return { expiring, expired };
  }

  async function getItem(library: AssetLibrary, id: string): Promise<AssetItem | null> {
    const row = await prisma.assetItem.findFirst({ where: { id, library } });
    return row ? rowToItem(row) : null;
  }

  async function createItem(library: AssetLibrary, input: CreateAssetInput): Promise<AssetItem> {
    const row = await prisma.assetItem.create({
      data: {
        library,
        name: input.name.trim(),
        notes: input.notes?.trim() ?? '',
        files: (input.files ?? []) as unknown as Prisma.InputJsonValue,
        expiryDate: input.expiryDate ? new Date(input.expiryDate) : null,
        tags: input.tags ?? [],
      },
    });
    return rowToItem(row);
  }

  async function updateItem(library: AssetLibrary, id: string, patch: UpdateAssetInput): Promise<AssetItem> {
    const data: Prisma.AssetItemUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name.trim();
    if (patch.notes !== undefined) data.notes = patch.notes.trim();
    if (patch.tags !== undefined) data.tags = patch.tags;
    if (patch.files !== undefined) data.files = patch.files as unknown as Prisma.InputJsonValue;
    if (patch.expiryDate !== undefined) {
      data.expiryDate = patch.expiryDate ? new Date(patch.expiryDate) : null;
    }
    const row = await prisma.assetItem.update({ where: { id_library: { id, library } }, data });
    return rowToItem(row);
  }

  async function deleteItem(library: AssetLibrary, id: string): Promise<void> {
    await prisma.assetItem.delete({ where: { id_library: { id, library } } });
    await fs.rm(getAssetItemDir(undefined, library, id), { recursive: true, force: true }).catch(() => undefined);
  }

  // 跨库聚合临期/已到期条目（仪表盘卡片用），按到期日升序，最多 limit 条。
  async function listExpiring(withinDays = EXPIRY_WINDOW_DAYS, limit = 50): Promise<AssetExpiringItem[]> {
    const now = new Date();
    const horizonEnd = new Date(now.getTime() + withinDays * DAY_MS);
    const rows = await prisma.assetItem.findMany({
      where: { expiryDate: { not: null, lte: horizonEnd } },
      orderBy: [{ expiryDate: 'asc' }, { updatedAt: 'desc' }],
      take: limit,
    });
    return rows.map((row) => {
      const item = rowToItem(row);
      const exp = row.expiryDate as Date;
      const daysUntil = Math.ceil((exp.getTime() - now.getTime()) / DAY_MS);
      return { ...item, daysUntil };
    });
  }

  // 删除指定文件的 DB 元数据（磁盘由调用方删除）。返回剩余 files。
  async function removeFiles(library: AssetLibrary, id: string, fileIds: string[]): Promise<AssetFileMeta[]> {
    const row = await prisma.assetItem.findFirst({ where: { id, library } });
    if (!row) return [];
    const current = Array.isArray(row.files) ? (row.files as unknown as AssetFileMeta[]) : [];
    const remaining = current.filter((f) => !fileIds.includes(f.fileId));
    await prisma.assetItem.update({
      where: { id_library: { id, library } },
      data: { files: remaining as unknown as Prisma.InputJsonValue },
    });
    return remaining;
  }

  return { listItems, countByExpiry, getItem, createItem, updateItem, deleteItem, listExpiring, removeFiles };
}

export type AssetLibraryStore = ReturnType<typeof createAssetLibraryStore>;
