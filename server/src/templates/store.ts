// 导出模板持久化。移植自 client/electron/services/templateStore.cjs，改 better-sqlite3 → Prisma。
// 返回形状保持桌面 snake_case（template_id/template_name/config/created_at/updated_at），
// 客户端 MyTemplatesPage / ExportFormatPage / TechnicalPlanHome 无需改类型映射。
//
// 隔离语义（2026-08-11 共享模板）：
//  - 私有模板（isShared=false）：仅创建者可读写。
//  - 共享模板（isShared=true）：全员可读（list 自动含共享）；改删仅创建者 + admin。
//  - admin：list 看全量；可改删任何模板；可翻任意模板的共享开关；建模板默认共享。
//  - 普通用户：list 看"自己 + 全部共享"；建的模板强制私有（不能自行共享）。
import { randomUUID } from 'node:crypto';
import type { PrismaClient, ExportTemplate, User } from '@prisma/client';

export interface TemplateUser {
  id: number;
  role: string;
}

export interface TemplateDto {
  template_id: string;
  template_name: string;
  config: unknown;
  created_at: string;
  updated_at: string;
  is_shared: boolean;
  owner_id: number;
  owner_name: string | null;
  can_edit: boolean;
}

type RowWithUser = ExportTemplate & { user?: Pick<User, 'displayName'> | null };

function resolveTemplateName(config: unknown): string {
  const name = String((config as any)?.template_name || '').trim();
  return name || '未命名模板';
}

function toDto(row: RowWithUser, user: TemplateUser): TemplateDto {
  const canEdit = row.userId === user.id || user.role === 'admin';
  return {
    template_id: row.templateId,
    template_name: row.templateName,
    config: row.config,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    is_shared: row.isShared,
    owner_id: row.userId,
    owner_name: row.user?.displayName ?? null,
    can_edit: canEdit,
  };
}

export function createTemplateStore(prisma: PrismaClient) {
  async function listTemplates(user: TemplateUser): Promise<TemplateDto[]> {
    const where = user.role === 'admin' ? {} : { OR: [{ userId: user.id }, { isShared: true }] };
    const rows = await prisma.exportTemplate.findMany({
      where,
      include: { user: { select: { displayName: true } } },
      orderBy: [{ isShared: 'desc' }, { updatedAt: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((row) => toDto(row, user));
  }

  async function getTemplate(user: TemplateUser, templateId: string): Promise<TemplateDto | null> {
    const row = await prisma.exportTemplate.findFirst({
      where: { templateId },
      include: { user: { select: { displayName: true } } },
    });
    if (!row) return null;
    // 读守卫：自己的 / 共享的 / admin 任一可读。
    const canRead = row.userId === user.id || row.isShared || user.role === 'admin';
    return canRead ? toDto(row, user) : null;
  }

  async function createTemplate(
    user: TemplateUser,
    config: unknown,
    isShared?: boolean,
  ): Promise<TemplateDto> {
    // admin 不传 isShared 默认共享；普通用户强制私有（忽略入参）。
    const shared = user.role === 'admin' ? (isShared ?? true) : false;
    const templateName = resolveTemplateName(config);
    const nextConfig = { ...(config as object), template_name: templateName };
    const row = await prisma.exportTemplate.create({
      data: {
        templateId: `tpl-${randomUUID()}`,
        userId: user.id,
        templateName,
        config: nextConfig as any,
        isShared: shared,
      },
      include: { user: { select: { displayName: true } } },
    });
    return toDto(row, user);
  }

  async function updateTemplate(
    user: TemplateUser,
    templateId: string,
    config: unknown,
  ): Promise<TemplateDto> {
    const existing = await prisma.exportTemplate.findFirst({ where: { templateId } });
    if (!existing || !(existing.userId === user.id || user.role === 'admin')) {
      throw new Error('模板不存在或无权操作');
    }
    const templateName = resolveTemplateName(config);
    const nextConfig = { ...(config as object), template_name: templateName };
    const row = await prisma.exportTemplate.update({
      where: { templateId: existing.templateId },
      data: { templateName, config: nextConfig as any },
      include: { user: { select: { displayName: true } } },
    });
    return toDto(row, user);
  }

  async function deleteTemplate(
    user: TemplateUser,
    templateId: string,
  ): Promise<{ success: boolean; message: string }> {
    const existing = await prisma.exportTemplate.findFirst({ where: { templateId } });
    if (!existing || !(existing.userId === user.id || user.role === 'admin')) {
      return { success: false, message: '模板不存在或无权操作' };
    }
    await prisma.exportTemplate.delete({ where: { templateId: existing.templateId } });
    return { success: true, message: '模板已删除' };
  }

  async function setShared(
    user: TemplateUser,
    templateId: string,
    isShared: boolean,
  ): Promise<TemplateDto> {
    if (user.role !== 'admin') {
      throw new Error('仅管理员可调整共享状态');
    }
    const existing = await prisma.exportTemplate.findFirst({ where: { templateId } });
    if (!existing) {
      throw new Error('模板不存在');
    }
    const row = await prisma.exportTemplate.update({
      where: { templateId: existing.templateId },
      data: { isShared },
      include: { user: { select: { displayName: true } } },
    });
    return toDto(row, user);
  }

  return { listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, setShared };
}
