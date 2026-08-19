import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { seedPromptDefaults } from '../prompts/store';
import { seedInitialAdmin } from './seedInitialAdmin';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // 旧角色值迁移：editor/viewer → user（二元角色模型：admin / user）。
  const migrated = await prisma.user.updateMany({
    where: { role: { in: ['editor', 'viewer'] } },
    data: { role: 'user' },
  });
  if (migrated.count > 0) {
    console.log(`migrated ${migrated.count} user(s): role editor/viewer -> user`);
  }

  const adminSeed = await seedInitialAdmin(prisma);
  console.log(adminSeed === 'created'
    ? 'created default administrator account'
    : 'skipped default administrator: users already exist');

  // 提示词管理：幂等写 20 条 builtin（18 投标分析 task + 1 system prompt + 1 废标 invalid_bid）。
  // 已存在不覆盖（保留管理员编辑）。runner 加载兜底硬编码，故未 seed 也能跑；seed 仅为可编辑。
  await seedPromptDefaults(prisma);
  console.log('seeded prompt defaults');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
