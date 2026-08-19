import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { seedPromptDefaults } from '../prompts/store';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const adminUsername = process.env.INITIAL_ADMIN_USERNAME?.trim() || 'admin';
  const adminPassword = process.env.INITIAL_ADMIN_PASSWORD || '';
  const adminDisplayName = process.env.INITIAL_ADMIN_DISPLAY_NAME?.trim() || '管理员';
  const adminPhone = process.env.INITIAL_ADMIN_PHONE?.trim() || null;

  if (adminPassword.length < 12) {
    throw new Error('INITIAL_ADMIN_PASSWORD must contain at least 12 characters');
  }

  const hash = await bcrypt.hash(adminPassword, 10);

  // 旧角色值迁移：editor/viewer → user（二元角色模型：admin / user）。
  const migrated = await prisma.user.updateMany({
    where: { role: { in: ['editor', 'viewer'] } },
    data: { role: 'user' },
  });
  if (migrated.count > 0) {
    console.log(`migrated ${migrated.count} user(s): role editor/viewer -> user`);
  }

  // 主管理员凭据来自环境变量；普通用户走手机号注册（username=手机号）。
  await prisma.user.upsert({
    where: { username: adminUsername },
    update: { password: hash, displayName: adminDisplayName, role: 'admin', status: 'active', phone: adminPhone },
    create: {
      username: adminUsername,
      password: hash,
      displayName: adminDisplayName,
      role: 'admin',
      status: 'active',
      phone: adminPhone,
    },
  });
  console.log(`seeded administrator account: ${adminUsername}`);

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
