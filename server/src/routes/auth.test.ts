import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import bcrypt from 'bcryptjs';

process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters';
const { authRoutes } = await import('./auth');
const { signInitialPasswordChangeToken } = await import('../auth/middleware');

interface UserRow {
  id: number;
  username: string;
  password: string;
  displayName: string | null;
  role: string;
  status: string;
  phone: string | null;
  department: string | null;
  modules: string;
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
}

async function makeUser(overrides: Partial<UserRow> = {}): Promise<UserRow> {
  return {
    id: 1,
    username: 'admin',
    password: await bcrypt.hash('admin', 10),
    displayName: '管理员',
    role: 'admin',
    status: 'active',
    phone: null,
    department: null,
    modules: '[]',
    mustChangePassword: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

async function buildApp(initial: UserRow) {
  let row = { ...initial };
  const app = Fastify();
  app.decorate('prisma', {
    user: {
      findUnique: async ({ where }: { where: { id?: number; username?: string } }) => {
        if (where.id != null && where.id !== row.id) return null;
        if (where.username != null && where.username !== row.username) return null;
        return { ...row };
      },
      updateMany: async ({ where, data }: {
        where: { id: number; mustChangePassword: boolean };
        data: Partial<UserRow>;
      }) => {
        if (where.id !== row.id || row.mustChangePassword !== where.mustChangePassword) return { count: 0 };
        row = { ...row, ...data };
        return { count: 1 };
      },
      create: async () => { throw new Error('not used'); },
    },
  });
  await app.register(authRoutes, { prefix: '/api' });
  return { app, readUser: () => ({ ...row }) };
}

test('默认管理员登录只返回改密令牌', async (t) => {
  const { app } = await buildApp(await makeUser());
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'admin', password: 'admin' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().password_change_required, true);
  assert.equal(response.json().expires_in, 600);
  assert.equal('token' in response.json(), false);
});

test('弱密码和确认不一致均不能完成初始改密', async (t) => {
  const user = await makeUser();
  const { app } = await buildApp(user);
  t.after(() => app.close());
  const restrictedToken = signInitialPasswordChangeToken({ id: user.id, username: user.username, role: user.role });
  const response = await app.inject({
    method: 'POST',
    url: '/api/change-initial-password',
    headers: { authorization: `Bearer ${restrictedToken}` },
    payload: { newPassword: 'weak-password', confirmPassword: 'weak-password' },
  });
  assert.equal(response.statusCode, 400);
  const mismatch = await app.inject({
    method: 'POST',
    url: '/api/change-initial-password',
    headers: { authorization: `Bearer ${restrictedToken}` },
    payload: { newPassword: 'Strong-Pass1!', confirmPassword: 'Strong-Pass2!' },
  });
  assert.equal(mismatch.statusCode, 400);
});

test('默认密码和当前密码不能作为新密码', async (t) => {
  const currentPassword = 'Already-Strong1!';
  const user = await makeUser({ password: await bcrypt.hash(currentPassword, 10) });
  const { app } = await buildApp(user);
  t.after(() => app.close());
  const restrictedToken = signInitialPasswordChangeToken({ id: user.id, username: user.username, role: user.role });
  const defaultReuse = await app.inject({
    method: 'POST',
    url: '/api/change-initial-password',
    headers: { authorization: `Bearer ${restrictedToken}` },
    payload: { newPassword: 'admin', confirmPassword: 'admin' },
  });
  assert.equal(defaultReuse.statusCode, 400);
  const currentReuse = await app.inject({
    method: 'POST',
    url: '/api/change-initial-password',
    headers: { authorization: `Bearer ${restrictedToken}` },
    payload: { newPassword: currentPassword, confirmPassword: currentPassword },
  });
  assert.equal(currentReuse.statusCode, 400);
});

test('停用管理员不能完成初始改密', async (t) => {
  const user = await makeUser({ status: 'disabled' });
  const { app } = await buildApp(user);
  t.after(() => app.close());
  const restrictedToken = signInitialPasswordChangeToken({ id: user.id, username: user.username, role: user.role });
  const response = await app.inject({
    method: 'POST',
    url: '/api/change-initial-password',
    headers: { authorization: `Bearer ${restrictedToken}` },
    payload: { newPassword: 'Strong-Pass1!', confirmPassword: 'Strong-Pass1!' },
  });
  assert.equal(response.statusCode, 401);
});

test('普通用户登录行为保持不变', async (t) => {
  const password = 'User-Pass1!';
  const user = await makeUser({
    username: '13800000000',
    password: await bcrypt.hash(password, 10),
    role: 'user',
    mustChangePassword: false,
  });
  const { app } = await buildApp(user);
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: user.username, password },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(typeof response.json().token, 'string');
  assert.equal(response.json().user.username, user.username);
});

test('强密码修改成功并直接返回正式令牌且不能重放', async (t) => {
  const user = await makeUser();
  const { app, readUser } = await buildApp(user);
  t.after(() => app.close());
  const restrictedToken = signInitialPasswordChangeToken({ id: user.id, username: user.username, role: user.role });
  const response = await app.inject({
    method: 'POST',
    url: '/api/change-initial-password',
    headers: { authorization: `Bearer ${restrictedToken}` },
    payload: { newPassword: 'Strong-Pass1!', confirmPassword: 'Strong-Pass1!' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(typeof response.json().token, 'string');
  assert.equal(response.json().user.username, 'admin');
  const updated = readUser();
  assert.equal(updated.mustChangePassword, false);
  assert.equal(await bcrypt.compare('Strong-Pass1!', updated.password), true);
  const replay = await app.inject({
    method: 'POST',
    url: '/api/change-initial-password',
    headers: { authorization: `Bearer ${restrictedToken}` },
    payload: { newPassword: 'Another-Pass2!', confirmPassword: 'Another-Pass2!' },
  });
  assert.equal(replay.statusCode, 409);
});
