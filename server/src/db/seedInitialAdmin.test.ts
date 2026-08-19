import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import { seedInitialAdmin } from './seedInitialAdmin';

test('空用户表创建必须改密的 admin/admin', async () => {
  const created: Array<{ data: Record<string, unknown> }> = [];
  const result = await seedInitialAdmin({
    user: {
      count: async () => 0,
      create: async (args) => { created.push(args); return args.data; },
    },
  });
  assert.equal(result, 'created');
  assert.equal(created[0].data.username, 'admin');
  assert.equal(created[0].data.mustChangePassword, true);
  assert.equal(await bcrypt.compare('admin', String(created[0].data.password)), true);
});

test('非空用户表跳过且不写用户', async () => {
  let createCalls = 0;
  const result = await seedInitialAdmin({
    user: {
      count: async () => 1,
      create: async () => { createCalls += 1; return {}; },
    },
  });
  assert.equal(result, 'skipped');
  assert.equal(createCalls, 0);
});
