import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters';

test('受限令牌只能通过初始改密校验', async () => {
  const auth = await import('./middleware');
  const token = auth.signInitialPasswordChangeToken({ id: 1, username: 'admin', role: 'admin' });
  const decoded = jwt.decode(token) as { iat?: number; exp?: number };

  assert.equal(decoded.exp! - decoded.iat!, 600);
  assert.equal(auth.verifyInitialPasswordChangeToken(token).purpose, 'initial-password-change');
  assert.throws(() => auth.verifyAccessToken(token));
});

test('旧正式令牌没有 purpose 时继续兼容', async () => {
  const auth = await import('./middleware');
  const token = jwt.sign(
    { id: 2, username: 'legacy', role: 'user' },
    process.env.JWT_SECRET as string,
    { expiresIn: '7d' },
  );

  assert.equal(auth.verifyAccessToken(token).username, 'legacy');
});

test('正式令牌不能用于初始改密', async () => {
  const auth = await import('./middleware');
  const token = auth.signToken({ id: 1, username: 'admin', role: 'admin' });
  const decoded = jwt.decode(token) as { purpose?: string; iat?: number; exp?: number };

  assert.equal(decoded.purpose, 'access');
  assert.equal(decoded.exp! - decoded.iat!, 7 * 24 * 60 * 60);
  assert.throws(() => auth.verifyInitialPasswordChangeToken(token));
});

test('受限令牌不能访问普通受保护路由', async (t) => {
  const auth = await import('./middleware');
  const app = Fastify();
  t.after(() => app.close());
  app.get('/protected', { onRequest: auth.verifyToken }, async () => ({ success: true }));

  const restrictedResponse = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: {
      authorization: `Bearer ${auth.signInitialPasswordChangeToken({ id: 1, username: 'admin', role: 'admin' })}`,
    },
  });
  assert.equal(restrictedResponse.statusCode, 401);

  const accessResponse = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: {
      authorization: `Bearer ${auth.signToken({ id: 1, username: 'admin', role: 'admin' })}`,
    },
  });
  assert.equal(accessResponse.statusCode, 200);
});
