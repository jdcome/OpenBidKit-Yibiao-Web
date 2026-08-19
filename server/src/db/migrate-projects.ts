import { PrismaClient } from '@prisma/client';

// 一次性迁移：多项目重构后给每个用户建一个默认项目并写 activeProjectId。
// 运行：cd server && npx tsx src/db/migrate-projects.ts
// 注：工作区表已重键为 projectId 分区；106 为全新部署、工作区表为空，无需回填业务行。
const prisma = new PrismaClient();

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

async function nextProjectCode(year: number): Promise<string> {
  const last = await prisma.project.findFirst({
    where: { projectCode: { startsWith: `XM${year}-` } },
    orderBy: { projectCode: 'desc' },
  });
  let seq = 1;
  if (last) {
    const m = last.projectCode.match(/-(\d+)$/);
    if (m) seq = parseInt(m[1], 10) + 1;
  }
  return `XM${year}-${pad4(seq)}`;
}

async function ensureUserConfig(userId: number) {
  await prisma.userConfig.upsert({
    where: { userId },
    update: {},
    create: { userId, data: {} },
  });
  return prisma.userConfig.findUnique({ where: { userId } });
}

async function main(): Promise<void> {
  const year = new Date().getFullYear();
  const users = await prisma.user.findMany();
  for (const u of users) {
    const existing = await prisma.project.findFirst({
      where: { ownerId: u.id },
      orderBy: { id: 'asc' },
    });
    let projectId: number;
    if (existing) {
      projectId = existing.id;
      console.log(`user ${u.username} 已有项目 ${existing.projectCode}`);
    } else {
      const code = await nextProjectCode(year);
      const p = await prisma.project.create({
        data: { projectCode: code, name: '默认项目', ownerId: u.id, status: 'active' },
      });
      projectId = p.id;
      console.log(`user ${u.username} 建默认项目 ${code} (id=${p.id})`);
    }
    const cfg = await ensureUserConfig(u.id);
    const data = cfg && typeof cfg.data === 'object' ? (cfg.data as Record<string, unknown>) : {};
    if (data.activeProjectId !== projectId) {
      await prisma.userConfig.update({
        where: { userId: u.id },
        data: { data: { ...data, activeProjectId: projectId } },
      });
    }
  }
  console.log('migrate-projects done');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
