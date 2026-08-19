// 人员资质库存储层（一人多证）：PersonnelProfile 1→N PersonnelCertificate。
// 公司共享（无 userId 隔离）。证书 files 存 JSON 元数据；文件字节由路由落 <dataDir>/shared/personnel/<profileId>/<certId>/。
// 到期按各证书 expiryDate 独立计算；null 表示不参与提醒。
import type { PrismaClient, Prisma } from '@prisma/client';
import fs from 'node:fs/promises';
import { getPersonnelProfileDir } from '../document/paths';
import type { AssetFileMeta } from '../asset-library/store';

export const EXPIRY_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PersonnelCertificate {
  id: string;
  profileId: string;
  certName: string;
  certType: string;
  files: AssetFileMeta[];
  expiryDate: string | null;
  obtainedAt: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonnelProfile {
  id: string;
  name: string;
  department: string;
  position: string;
  phone: string;
  notes: string;
  tags: string[];
  certificates: PersonnelCertificate[];
  certCount: number;
  expiringCount: number;
  expiredCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersonnelExpiringItem {
  profileId: string;
  profileName: string;
  department: string;
  certId: string;
  certName: string;
  certType: string;
  expiryDate: string;
  daysUntil: number;
}

export type ExpiryFilter = 'active' | 'expiring' | 'expired';

type CertState = 'expired' | 'expiring' | 'ok' | 'none';

function certState(exp: Date | null, now: Date, horizonEnd: Date): CertState {
  if (!exp) return 'none';
  const t = exp.getTime();
  if (t < now.getTime()) return 'expired';
  if (t <= horizonEnd.getTime()) return 'expiring';
  return 'ok';
}

function toIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function rowToCert(row: {
  id: string;
  profileId: string;
  certName: string;
  certType: string;
  files: unknown;
  expiryDate: Date | null;
  obtainedAt: Date | null;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}): PersonnelCertificate {
  const files = Array.isArray(row.files) ? (row.files as AssetFileMeta[]) : [];
  return {
    id: row.id,
    profileId: row.profileId,
    certName: row.certName,
    certType: row.certType ?? '',
    files,
    expiryDate: toIso(row.expiryDate),
    obtainedAt: toIso(row.obtainedAt),
    notes: row.notes ?? '',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToProfile(
  row: {
    id: string;
    name: string;
    department: string;
    position: string;
    phone: string;
    notes: string;
    tags: string[];
    createdAt: Date;
    updatedAt: Date;
    certificates: ReturnType<typeof rowToCert>[];
  },
  now: Date,
  horizonEnd: Date,
): PersonnelProfile {
  let expiring = 0;
  let expired = 0;
  for (const c of row.certificates) {
    const state = certState(c.expiryDate ? new Date(c.expiryDate) : null, now, horizonEnd);
    if (state === 'expiring') expiring++;
    else if (state === 'expired') expired++;
  }
  return {
    id: row.id,
    name: row.name,
    department: row.department ?? '',
    position: row.position ?? '',
    phone: row.phone ?? '',
    notes: row.notes ?? '',
    tags: row.tags ?? [],
    certificates: row.certificates,
    certCount: row.certificates.length,
    expiringCount: expiring,
    expiredCount: expired,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreateProfileInput {
  name: string;
  department?: string;
  position?: string;
  phone?: string;
  notes?: string;
  tags?: string[];
}

export interface UpdateProfileInput {
  name?: string;
  department?: string;
  position?: string;
  phone?: string;
  notes?: string;
  tags?: string[];
}

export interface CertificateInput {
  certName: string;
  certType?: string;
  expiryDate?: string | null;
  obtainedAt?: string | null;
  notes?: string;
  files?: AssetFileMeta[];
}

export function createPersonnelStore(prisma: PrismaClient) {
  async function listProfiles(opts: { q?: string; expiry?: ExpiryFilter } = {}): Promise<PersonnelProfile[]> {
    const now = new Date();
    const horizonEnd = new Date(now.getTime() + EXPIRY_WINDOW_DAYS * DAY_MS);
    const where: Prisma.PersonnelProfileWhereInput = {};
    const q = opts.q?.trim();
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { department: { contains: q, mode: 'insensitive' } },
        { position: { contains: q, mode: 'insensitive' } },
        { notes: { contains: q, mode: 'insensitive' } },
        { tags: { has: q } },
        { certificates: { some: { OR: [
          { certName: { contains: q, mode: 'insensitive' } },
          { certType: { contains: q, mode: 'insensitive' } },
        ] } } },
      ];
    }
    const rows = await prisma.personnelProfile.findMany({
      where,
      include: { certificates: { orderBy: [{ expiryDate: 'asc' }, { updatedAt: 'desc' }] } },
      orderBy: [{ updatedAt: 'desc' }],
    });
    let profiles = rows.map((row) =>
      rowToProfile({ ...row, certificates: row.certificates.map(rowToCert) }, now, horizonEnd),
    );
    if (opts.expiry) {
      profiles = profiles.filter((p) => {
        if (opts.expiry === 'expiring') return p.expiringCount > 0;
        if (opts.expiry === 'expired') return p.expiredCount > 0;
        return p.expiringCount === 0 && p.expiredCount === 0; // active
      });
    }
    return profiles;
  }

  async function countByExpiry(): Promise<{ expiring: number; expired: number }> {
    const now = new Date();
    const horizonEnd = new Date(now.getTime() + EXPIRY_WINDOW_DAYS * DAY_MS);
    const rows = await prisma.personnelProfile.findMany({
      select: { id: true, certificates: { select: { expiryDate: true } } },
    });
    let expiring = 0;
    let expired = 0;
    for (const r of rows) {
      let pExp = false;
      let pOver = false;
      for (const c of r.certificates) {
        const state = certState(c.expiryDate, now, horizonEnd);
        if (state === 'expiring') pExp = true;
        else if (state === 'expired') pOver = true;
      }
      if (pExp) expiring++;
      if (pOver) expired++;
    }
    return { expiring, expired };
  }

  async function getProfile(id: string): Promise<PersonnelProfile | null> {
    const now = new Date();
    const horizonEnd = new Date(now.getTime() + EXPIRY_WINDOW_DAYS * DAY_MS);
    const row = await prisma.personnelProfile.findUnique({
      where: { id },
      include: { certificates: { orderBy: [{ expiryDate: 'asc' }, { updatedAt: 'desc' }] } },
    });
    if (!row) return null;
    return rowToProfile({ ...row, certificates: row.certificates.map(rowToCert) }, now, horizonEnd);
  }

  async function createProfile(input: CreateProfileInput): Promise<PersonnelProfile> {
    const now = new Date();
    const horizonEnd = new Date(now.getTime() + EXPIRY_WINDOW_DAYS * DAY_MS);
    const row = await prisma.personnelProfile.create({
      data: {
        name: input.name.trim(),
        department: input.department?.trim() ?? '',
        position: input.position?.trim() ?? '',
        phone: input.phone?.trim() ?? '',
        notes: input.notes?.trim() ?? '',
        tags: input.tags ?? [],
      },
      include: { certificates: true },
    });
    return rowToProfile({ ...row, certificates: row.certificates.map(rowToCert) }, now, horizonEnd);
  }

  async function updateProfile(id: string, patch: UpdateProfileInput): Promise<PersonnelProfile> {
    const now = new Date();
    const horizonEnd = new Date(now.getTime() + EXPIRY_WINDOW_DAYS * DAY_MS);
    const data: Prisma.PersonnelProfileUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name.trim();
    if (patch.department !== undefined) data.department = patch.department.trim();
    if (patch.position !== undefined) data.position = patch.position.trim();
    if (patch.phone !== undefined) data.phone = patch.phone.trim();
    if (patch.notes !== undefined) data.notes = patch.notes.trim();
    if (patch.tags !== undefined) data.tags = patch.tags;
    const row = await prisma.personnelProfile.update({
      where: { id },
      data,
      include: { certificates: { orderBy: [{ expiryDate: 'asc' }, { updatedAt: 'desc' }] } },
    });
    return rowToProfile({ ...row, certificates: row.certificates.map(rowToCert) }, now, horizonEnd);
  }

  async function deleteProfile(id: string): Promise<void> {
    await prisma.personnelProfile.delete({ where: { id } });
    await fs.rm(getPersonnelProfileDir(undefined, id), { recursive: true, force: true }).catch(() => undefined);
  }

  async function addCertificate(profileId: string, input: CertificateInput): Promise<PersonnelCertificate> {
    const row = await prisma.personnelCertificate.create({
      data: {
        profileId,
        certName: input.certName.trim(),
        certType: input.certType?.trim() ?? '',
        files: (input.files ?? []) as unknown as Prisma.InputJsonValue,
        expiryDate: input.expiryDate ? new Date(input.expiryDate) : null,
        obtainedAt: input.obtainedAt ? new Date(input.obtainedAt) : null,
        notes: input.notes?.trim() ?? '',
      },
    });
    return rowToCert(row);
  }

  async function getCertificate(profileId: string, certId: string): Promise<PersonnelCertificate | null> {
    const row = await prisma.personnelCertificate.findFirst({ where: { id: certId, profileId } });
    return row ? rowToCert(row) : null;
  }

  async function updateCertificate(
    profileId: string,
    certId: string,
    patch: Partial<CertificateInput>,
  ): Promise<PersonnelCertificate> {
    const data: Prisma.PersonnelCertificateUpdateInput = {};
    if (patch.certName !== undefined) data.certName = patch.certName.trim();
    if (patch.certType !== undefined) data.certType = patch.certType.trim();
    if (patch.notes !== undefined) data.notes = patch.notes.trim();
    if (patch.files !== undefined) data.files = patch.files as unknown as Prisma.InputJsonValue;
    if (patch.expiryDate !== undefined) data.expiryDate = patch.expiryDate ? new Date(patch.expiryDate) : null;
    if (patch.obtainedAt !== undefined) data.obtainedAt = patch.obtainedAt ? new Date(patch.obtainedAt) : null;
    const row = await prisma.personnelCertificate.update({ where: { id: certId }, data });
    return rowToCert(row);
  }

  async function deleteCertificate(profileId: string, certId: string): Promise<void> {
    await prisma.personnelCertificate.delete({ where: { id: certId } });
    await fs.rm(`${getPersonnelProfileDir(undefined, profileId)}/${certId}`, { recursive: true, force: true }).catch(() => undefined);
  }

  async function listExpiring(withinDays = EXPIRY_WINDOW_DAYS, limit = 50): Promise<PersonnelExpiringItem[]> {
    const now = new Date();
    const horizonEnd = new Date(now.getTime() + withinDays * DAY_MS);
    const rows = await prisma.personnelCertificate.findMany({
      where: { expiryDate: { not: null, lte: horizonEnd } },
      include: { profile: { select: { id: true, name: true, department: true } } },
      orderBy: [{ expiryDate: 'asc' }, { updatedAt: 'desc' }],
      take: limit,
    });
    return rows.map((row) => {
      const exp = row.expiryDate as Date;
      return {
        profileId: row.profile.id,
        profileName: row.profile.name,
        department: row.profile.department ?? '',
        certId: row.id,
        certName: row.certName,
        certType: row.certType ?? '',
        expiryDate: exp.toISOString(),
        daysUntil: Math.ceil((exp.getTime() - now.getTime()) / DAY_MS),
      };
    });
  }

  return {
    listProfiles,
    countByExpiry,
    getProfile,
    createProfile,
    updateProfile,
    deleteProfile,
    addCertificate,
    getCertificate,
    updateCertificate,
    deleteCertificate,
    listExpiring,
  };
}

export type PersonnelStore = ReturnType<typeof createPersonnelStore>;
