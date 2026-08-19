# Initial Admin Forced Password Change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fresh installations bootstrap with `admin/admin`, restrict that credential to a one-time forced password-change flow, and issue a normal session only after a strong password is saved.

**Architecture:** Add an explicit `User.mustChangePassword` state, a 10-minute JWT with `purpose=initial-password-change`, and a server-authoritative password policy. Fresh-only seed logic creates the default admin only when the user table is empty; the React auth provider holds the restricted token in memory and renders a non-dismissible Radix dialog until the server returns a normal token.

**Tech Stack:** TypeScript, Fastify 5, Prisma 6, PostgreSQL, bcryptjs, jsonwebtoken, React 19, Radix Dialog, Axios, Node test runner via `tsx`, Vite.

**Spec:** `docs/superpowers/specs/2026-08-19-initial-admin-forced-password-change-design.md`

## Global Constraints

- The behavior applies only to a fresh installation; upgrading an existing database must not reset credentials or force existing administrators to change passwords.
- The fresh-install credentials are exactly `admin/admin`.
- The replacement password must be at least 12 characters and include ASCII uppercase, lowercase, numeric, and special characters.
- The restricted password-change token lasts 600 seconds, is never persisted in browser storage, and cannot access protected application routes.
- Successful password change atomically clears `mustChangePassword` and immediately returns a normal 7-day application token.
- Existing normal JWTs without a `purpose` claim remain valid after upgrade.
- Passwords, hashes, restricted tokens, normal tokens, production data, secrets, and backups must not enter logs or Git.
- Do not modify `LICENSE`, `NOTICE`, original author attribution, original repository links, or AGPL statements except to keep their existing references intact in surrounding documentation.
- Do not deploy these changes to VM98 or VM92 as part of this implementation plan.
- Run frontend production builds from `client/` with `npx.cmd vite build` on Windows.

## File Map

- Create `server/src/auth/initialPassword.ts`: default bootstrap constants and server-authoritative strong-password validation.
- Create `server/src/auth/initialPassword.test.ts`: focused password-policy tests.
- Create `server/src/db/seedInitialAdmin.ts`: fresh-only default administrator creation.
- Create `server/src/db/seedInitialAdmin.test.ts`: mocked seed idempotency and existing-install safety tests.
- Modify `server/prisma/schema.prisma`: add `User.mustChangePassword` with a safe `false` default.
- Modify `server/src/db/seed.ts`: call the fresh-only administrator seed helper without overwriting existing users.
- Modify `server/src/auth/middleware.ts`: add token purposes, restricted-token signing/verification, and access-token rejection of restricted tokens.
- Create `server/src/auth/middleware.test.ts`: token-purpose and legacy-token compatibility tests.
- Modify `server/src/routes/auth.ts`: return the forced-change login response and expose the initial password-change endpoint.
- Create `server/src/routes/auth.test.ts`: Fastify injection tests for both login branches and one-time password change.
- Create `client/src/shared/auth/initialPasswordRules.ts`: client-side rule indicators and login-response type guard.
- Create `client/src/shared/auth/initialPasswordRules.test.ts`: pure frontend rule/type-guard tests runnable with the server `tsx` binary.
- Modify `client/src/shared/api/http.ts`: add an auth/public Axios instance that does not attach application tokens or reload on expected authentication errors.
- Modify `client/src/shared/api/auth.tsx`: hold the restricted token in memory, expose password-change state/actions, and finalize login only after receiving a normal token.
- Create `client/src/app/InitialPasswordChangeDialog.tsx`: non-dismissible password-change dialog.
- Modify `client/src/app/LoginPage.tsx`: connect login, forced-change state, expiry handling, and the dialog.
- Modify `client/src/styles/feature-login.css`: style the dialog and password-rule checklist using existing design tokens.
- Modify `.env.example` and `server/.env.example`: remove obsolete initial administrator credential variables.
- Modify `README.md`, `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md`, `docs/FEATURES.md`, and `SECURITY.md`: document the new bootstrap and security behavior.
- Modify the design spec status after implementation and verification.

---

### Task 1: Server-Authoritative Initial Password Policy

**Files:**
- Create: `server/src/auth/initialPassword.ts`
- Test: `server/src/auth/initialPassword.test.ts`

**Interfaces:**
- Produces: `DEFAULT_INITIAL_ADMIN_USERNAME`, `DEFAULT_INITIAL_ADMIN_PASSWORD`, `INITIAL_PASSWORD_MIN_LENGTH`, `InitialPasswordRuleState`, `getInitialPasswordRuleState(password)`, and `validateInitialPassword(password)`.
- Consumed by: seed logic in Task 2 and auth routes in Task 4.

- [ ] **Step 1: Write the failing policy tests**

Create `server/src/auth/initialPassword.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_INITIAL_ADMIN_PASSWORD,
  DEFAULT_INITIAL_ADMIN_USERNAME,
  getInitialPasswordRuleState,
  validateInitialPassword,
} from './initialPassword';

test('固定首次管理员凭据为 admin/admin', () => {
  assert.equal(DEFAULT_INITIAL_ADMIN_USERNAME, 'admin');
  assert.equal(DEFAULT_INITIAL_ADMIN_PASSWORD, 'admin');
});

test('12 位且包含四类字符的密码通过', () => {
  assert.deepEqual(validateInitialPassword('Strong-Pass1!'), []);
});

test('逐项拒绝长度和字符类型不满足的密码', () => {
  assert.equal(getInitialPasswordRuleState('Aa1!short').minLength, false);
  assert.match(validateInitialPassword('lowercase1!-').join('；'), /大写字母/);
  assert.match(validateInitialPassword('UPPERCASE1!-').join('；'), /小写字母/);
  assert.match(validateInitialPassword('NoNumber----').join('；'), /数字/);
  assert.match(validateInitialPassword('NoSpecial123').join('；'), /特殊字符/);
});

test('拒绝默认密码', () => {
  assert.match(validateInitialPassword('admin').join('；'), /默认密码/);
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run:

```powershell
cd D:\AI\yibiao-web-agpl\server
pnpm exec tsx --test src/auth/initialPassword.test.ts
```

Expected: FAIL because `src/auth/initialPassword.ts` does not exist.

- [ ] **Step 3: Implement the minimal policy module**

Create `server/src/auth/initialPassword.ts` with this public shape:

```ts
export const DEFAULT_INITIAL_ADMIN_USERNAME = 'admin';
export const DEFAULT_INITIAL_ADMIN_PASSWORD = 'admin';
export const INITIAL_PASSWORD_MIN_LENGTH = 12;

export interface InitialPasswordRuleState {
  minLength: boolean;
  uppercase: boolean;
  lowercase: boolean;
  number: boolean;
  special: boolean;
  notDefault: boolean;
}

export function getInitialPasswordRuleState(password: string): InitialPasswordRuleState {
  return {
    minLength: password.length >= INITIAL_PASSWORD_MIN_LENGTH,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number: /[0-9]/.test(password),
    special: /[^A-Za-z0-9]/.test(password),
    notDefault: password !== DEFAULT_INITIAL_ADMIN_PASSWORD,
  };
}

export function validateInitialPassword(password: string): string[] {
  const state = getInitialPasswordRuleState(password);
  const errors: string[] = [];
  if (!state.minLength) errors.push('新密码至少 12 位');
  if (!state.uppercase) errors.push('新密码必须包含大写字母');
  if (!state.lowercase) errors.push('新密码必须包含小写字母');
  if (!state.number) errors.push('新密码必须包含数字');
  if (!state.special) errors.push('新密码必须包含特殊字符');
  if (!state.notDefault) errors.push('新密码不能使用默认密码');
  return errors;
}
```

- [ ] **Step 4: Run the focused test**

Run: `pnpm exec tsx --test src/auth/initialPassword.test.ts`

Expected: 4 tests PASS.

- [ ] **Step 5: Commit the policy unit**

```powershell
git add server/src/auth/initialPassword.ts server/src/auth/initialPassword.test.ts
git commit -m "feat(auth): define initial password policy"
```

---

### Task 2: Fresh-Only Administrator Seed State

**Files:**
- Create: `server/src/db/seedInitialAdmin.ts`
- Test: `server/src/db/seedInitialAdmin.test.ts`
- Modify: `server/prisma/schema.prisma:12-32`
- Modify: `server/src/db/seed.ts:1-49`

**Interfaces:**
- Consumes: `DEFAULT_INITIAL_ADMIN_USERNAME` and `DEFAULT_INITIAL_ADMIN_PASSWORD` from Task 1.
- Produces: `seedInitialAdmin(db): Promise<'created' | 'skipped'>`.
- Produces database field: `User.mustChangePassword: boolean`.

- [ ] **Step 1: Write failing fresh-install and existing-install tests**

Create `server/src/db/seedInitialAdmin.test.ts` using a minimal fake database:

```ts
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
```

- [ ] **Step 2: Run the seed test and verify it fails**

Run: `pnpm exec tsx --test src/db/seedInitialAdmin.test.ts`

Expected: FAIL because `seedInitialAdmin.ts` does not exist.

- [ ] **Step 3: Add the safe database field and seed helper**

Add to `User` in `server/prisma/schema.prisma`:

```prisma
mustChangePassword Boolean @default(false)
```

Create `server/src/db/seedInitialAdmin.ts` with a narrow dependency interface so it can be tested without PostgreSQL:

```ts
import bcrypt from 'bcryptjs';
import {
  DEFAULT_INITIAL_ADMIN_PASSWORD,
  DEFAULT_INITIAL_ADMIN_USERNAME,
} from '../auth/initialPassword';

interface InitialAdminDb {
  user: {
    count(): Promise<number>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

export async function seedInitialAdmin(db: InitialAdminDb): Promise<'created' | 'skipped'> {
  if (await db.user.count() > 0) return 'skipped';
  const password = await bcrypt.hash(DEFAULT_INITIAL_ADMIN_PASSWORD, 10);
  await db.user.create({
    data: {
      username: DEFAULT_INITIAL_ADMIN_USERNAME,
      password,
      displayName: '管理员',
      role: 'admin',
      status: 'active',
      mustChangePassword: true,
    },
  });
  return 'created';
}
```

- [ ] **Step 4: Replace credential-overwriting seed behavior**

In `server/src/db/seed.ts`:

- remove reads of `INITIAL_ADMIN_USERNAME`, `INITIAL_ADMIN_PASSWORD`, `INITIAL_ADMIN_DISPLAY_NAME`, and `INITIAL_ADMIN_PHONE`;
- remove the minimum-length check, precomputed hash, and `user.upsert` that updates passwords;
- keep the legacy role migration and prompt seeding;
- call `const adminSeed = await seedInitialAdmin(prisma);`;
- log either `created default administrator account` or `skipped default administrator: users already exist`, without printing credentials.

- [ ] **Step 5: Generate Prisma client and run focused tests**

Run:

```powershell
pnpm exec prisma format
pnpm exec prisma generate
pnpm exec tsx --test src/auth/initialPassword.test.ts src/db/seedInitialAdmin.test.ts
```

Expected: Prisma commands succeed and 6 tests PASS.

- [ ] **Step 6: Commit schema and seed behavior**

```powershell
git add server/prisma/schema.prisma server/src/db/seed.ts server/src/db/seedInitialAdmin.ts server/src/db/seedInitialAdmin.test.ts
git commit -m "feat(auth): seed fresh installs with forced-change admin"
```

---

### Task 3: Restricted JWT Purpose Enforcement

**Files:**
- Modify: `server/src/auth/middleware.ts:12-36`
- Test: `server/src/auth/middleware.test.ts`

**Interfaces:**
- Produces: `JwtPayload.purpose?: 'access' | 'initial-password-change'`.
- Produces: `signInitialPasswordChangeToken(payload): string` and `verifyInitialPasswordChangeToken(token): JwtPayload`.
- Changes: `verifyToken` rejects `purpose=initial-password-change` while accepting legacy tokens without `purpose`.
- Consumed by: auth routes in Task 4.

- [ ] **Step 1: Write failing token-purpose tests**

Create `server/src/auth/middleware.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters';

test('受限令牌只能通过初始改密校验', async () => {
  const auth = await import('./middleware');
  const token = auth.signInitialPasswordChangeToken({ id: 1, username: 'admin', role: 'admin' });
  assert.equal(auth.verifyInitialPasswordChangeToken(token).purpose, 'initial-password-change');
  assert.throws(() => auth.verifyAccessToken(token), /restricted token/);
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
  assert.throws(() => auth.verifyInitialPasswordChangeToken(token), /wrong token purpose/);
});
```

- [ ] **Step 2: Run the token tests and verify missing exports**

Run: `pnpm exec tsx --test src/auth/middleware.test.ts`

Expected: FAIL because the restricted-token functions do not exist.

- [ ] **Step 3: Implement token-purpose helpers**

Refactor `server/src/auth/middleware.ts` around these signatures:

```ts
export type JwtPurpose = 'access' | 'initial-password-change';

export interface JwtPayload {
  id: number;
  username: string;
  role: string;
  purpose?: JwtPurpose;
}

export function signToken(payload: Omit<JwtPayload, 'purpose'>): string;
export function signInitialPasswordChangeToken(payload: Omit<JwtPayload, 'purpose'>): string;
export function verifyAccessToken(token: string): JwtPayload;
export function verifyInitialPasswordChangeToken(token: string): JwtPayload;
```

Implementation rules:

- `signToken` signs `{...payload, purpose:'access'}` for 7 days;
- `signInitialPasswordChangeToken` signs `{...payload, purpose:'initial-password-change'}` for 10 minutes;
- `verifyAccessToken` rejects only the restricted purpose and therefore accepts both `purpose='access'` and legacy missing-purpose tokens;
- `verifyInitialPasswordChangeToken` accepts only `purpose='initial-password-change'`;
- `verifyToken` extracts the bearer value and delegates to `verifyAccessToken`.

- [ ] **Step 4: Run focused token and existing auth-dependent tests**

Run:

```powershell
pnpm exec tsx --test src/auth/middleware.test.ts
pnpm exec tsx --test src/routes/response-deviation.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit token isolation**

```powershell
git add server/src/auth/middleware.ts server/src/auth/middleware.test.ts
git commit -m "feat(auth): isolate initial password change tokens"
```

---

### Task 4: Login Decision and One-Time Password Change API

**Files:**
- Modify: `server/src/routes/auth.ts:1-111`
- Test: `server/src/routes/auth.test.ts`

**Interfaces:**
- Consumes: password policy from Task 1, `User.mustChangePassword` from Task 2, and restricted-token helpers from Task 3.
- Produces login union: `{token,user}` or `{password_change_required:true,password_change_token,expires_in:600}`.
- Produces endpoint: `POST /api/change-initial-password` with a restricted bearer token.

- [ ] **Step 1: Write failing Fastify injection tests**

Create `server/src/routes/auth.test.ts` with an in-memory user row and Fastify injection helper:

```ts
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
```

- [ ] **Step 2: Run route tests and verify forced-flow assertions fail**

Run: `pnpm exec tsx --test src/routes/auth.test.ts`

Expected: FAIL because login still returns a normal token and the change endpoint is absent.

- [ ] **Step 3: Add a shared auth-user serializer**

Inside `server/src/routes/auth.ts`, define one local `toAuthUser(user)` helper returning:

```ts
{
  id,
  username,
  displayName,
  role,
  status,
  phone,
  department,
  modules: parseModules(modules),
}
```

Use it in normal login, successful initial password change, and `/me` so response fields cannot drift.

- [ ] **Step 4: Implement the forced login branch**

After credential and status validation, branch before normal token signing:

```ts
if (user.mustChangePassword) {
  return {
    password_change_required: true,
    password_change_token: signInitialPasswordChangeToken({
      id: user.id,
      username: user.username,
      role: user.role,
    }),
    expires_in: 600,
  };
}
```

Reject inconsistent data where `mustChangePassword=true` but `role!=='admin'` with `403` rather than granting the forced flow.

- [ ] **Step 5: Implement `POST /change-initial-password`**

The handler must:

1. require a bearer token;
2. call `verifyInitialPasswordChangeToken`;
3. load the user and enforce active admin plus `mustChangePassword=true`;
4. reject mismatched confirmation;
5. call `validateInitialPassword` and return its first Chinese error;
6. reject a password that bcrypt-compares equal to the current hash;
7. hash the new password;
8. call `updateMany({where:{id,mustChangePassword:true},data:{password:hash,mustChangePassword:false}})`;
9. return `409` when the update count is zero;
10. reload the user and return `signToken(...)` plus `toAuthUser(user)`.

Catch JWT verification failures locally and return a sanitized `401` message without logging or echoing the token.

- [ ] **Step 6: Prove restricted tokens fail on protected routes**

Extend `server/src/auth/middleware.test.ts` with a Fastify route protected by `verifyToken`, inject the restricted bearer token, and assert `401`. Inject a normal token and assert `200`.

- [ ] **Step 7: Run all focused server authentication tests**

Run:

```powershell
pnpm exec tsx --test src/auth/initialPassword.test.ts src/db/seedInitialAdmin.test.ts src/auth/middleware.test.ts src/routes/auth.test.ts
```

Expected: all tests PASS.

- [ ] **Step 8: Commit the server flow**

```powershell
git add server/src/routes/auth.ts server/src/routes/auth.test.ts server/src/auth/middleware.test.ts
git commit -m "feat(auth): require initial admin password change"
```

---

### Task 5: Client Rule State and In-Memory Auth Flow

**Files:**
- Create: `client/src/shared/auth/initialPasswordRules.ts`
- Test: `client/src/shared/auth/initialPasswordRules.test.ts`
- Modify: `client/src/shared/api/http.ts:1-45`
- Modify: `client/src/shared/api/auth.tsx:1-98`

**Interfaces:**
- Produces: `InitialPasswordRuleState`, `getInitialPasswordRuleState(password)`, and `isPasswordChangeRequiredResponse(value)`.
- Changes `AuthState` to expose `initialPasswordChange`, `login`, `changeInitialPassword`, and `clearInitialPasswordChange`.
- Keeps the restricted token private inside `AuthProvider`.
- Consumed by: `InitialPasswordChangeDialog` and `LoginPage` in Task 6.

- [ ] **Step 1: Write failing client rule and response-guard tests**

Create `client/src/shared/auth/initialPasswordRules.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { getInitialPasswordRuleState, isPasswordChangeRequiredResponse } from './initialPasswordRules';

test('前端密码规则与服务端四类规则一致', () => {
  assert.deepEqual(getInitialPasswordRuleState('Strong-Pass1!'), {
    minLength: true,
    uppercase: true,
    lowercase: true,
    number: true,
    special: true,
  });
});

test('只接受完整的强制改密响应', () => {
  assert.equal(isPasswordChangeRequiredResponse({
    password_change_required: true,
    password_change_token: 'token',
    expires_in: 600,
  }), true);
  assert.equal(isPasswordChangeRequiredResponse({ password_change_required: true }), false);
});
```

- [ ] **Step 2: Run the client pure test and verify it fails**

Run from `server/` so no new client test dependency is added:

```powershell
cd D:\AI\yibiao-web-agpl\server
pnpm exec tsx --test ..\client\src\shared\auth\initialPasswordRules.test.ts
```

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement the pure client helper**

Create `client/src/shared/auth/initialPasswordRules.ts` with the same five positive rules as the server and a structural type guard requiring:

```ts
export interface PasswordChangeRequiredResponse {
  password_change_required: true;
  password_change_token: string;
  expires_in: number;
}
```

Do not export or embed the default password from client code beyond the existing user-facing deployment documentation.

- [ ] **Step 4: Add a public/auth HTTP client**

In `client/src/shared/api/http.ts`, export `publicHttp = axios.create({baseURL, timeout:30000})` before the authenticated `http` instance. It must have no request interceptor and no global `401` reload interceptor. Login, registration, and initial password change use `publicHttp`; business calls continue using `http`.

- [ ] **Step 5: Refactor `AuthProvider` into a two-stage login**

Add these types:

```ts
export interface InitialPasswordChangeState {
  expiresAt: number;
}

export type LoginResult = 'authenticated' | 'password-change-required';

interface AuthState {
  user: YibiaoUser | null;
  initialPasswordChange: InitialPasswordChangeState | null;
  login(username: string, password: string): Promise<LoginResult>;
  changeInitialPassword(newPassword: string, confirmPassword: string): Promise<void>;
  clearInitialPasswordChange(): void;
  logout(): void;
  refreshUser(): Promise<void>;
}
```

Implementation rules:

- keep `passwordChangeToken` in React state or a ref that is never exposed and never persisted;
- forced login clears stale normal storage, does not set `user`, and does not start SSE;
- normal login continues through one `completeLogin(token,user)` helper;
- `changeInitialPassword` sends the private token in `Authorization` through `publicHttp` and calls `completeLogin` only on a normal response;
- a timeout based on `expires_in` clears restricted state;
- logout clears both normal and restricted state;
- registration uses `publicHttp` so expected `401`/`409` responses do not reload the page.

- [ ] **Step 6: Run the client pure tests and production type/build checks**

Run:

```powershell
cd D:\AI\yibiao-web-agpl\server
pnpm exec tsx --test ..\client\src\shared\auth\initialPasswordRules.test.ts
cd ..\client
npx.cmd tsc --noEmit
npx.cmd vite build
```

Expected: rule tests PASS; Vite build succeeds. Record any existing TypeScript baseline separately and require no errors in the files changed by this task.

- [ ] **Step 7: Commit the client auth state**

```powershell
git add client/src/shared/auth/initialPasswordRules.ts client/src/shared/auth/initialPasswordRules.test.ts client/src/shared/api/http.ts client/src/shared/api/auth.tsx
git commit -m "feat(auth): add client forced-change session state"
```

---

### Task 6: Non-Dismissible Password Change Dialog

**Files:**
- Create: `client/src/app/InitialPasswordChangeDialog.tsx`
- Modify: `client/src/app/LoginPage.tsx:1-193`
- Modify: `client/src/styles/feature-login.css:1-126`

**Interfaces:**
- Consumes: `initialPasswordChange`, `changeInitialPassword`, and `clearInitialPasswordChange` from Task 5.
- Consumes: `getInitialPasswordRuleState` from Task 5.
- Produces: a controlled dialog that has no close path before success or expiry.

- [ ] **Step 1: Add the dialog component with enforced dismissal guards**

Create `InitialPasswordChangeDialog.tsx` with this component contract:

```ts
interface InitialPasswordChangeDialogProps {
  open: boolean;
  expiresAt: number | null;
  onSubmit(newPassword: string, confirmPassword: string): Promise<void>;
  onExpired(): void;
}
```

Use `Dialog.Root open={open}` without a close trigger. On `Dialog.Content`, call `event.preventDefault()` in both `onEscapeKeyDown` and `onPointerDownOutside`. Render:

- title “首次登录必须修改密码”；
- an explanation that default credentials cannot enter the system;
- new password and confirmation inputs with `autoComplete="new-password"`;
- show/hide controls;
- five live indicators: minimum length, uppercase, lowercase, number, special character;
- mismatch and server errors in Chinese;
- one submit button disabled while rules fail, confirmation differs, or the request is busy.

Use a timer to call `onExpired` when `Date.now() >= expiresAt`; clear the timer on unmount.

- [ ] **Step 2: Integrate the dialog into `LoginPage`**

Change `LoginPage` to read the forced-change state/actions from `useAuth`. After `login(...)` returns `password-change-required`, clear the password input and rely on context state to open the dialog. On expiry:

1. call `clearInitialPasswordChange()`;
2. set the login-page message to “改密凭证已过期，请重新登录”；
3. keep the page in login mode.

On successful submission, `AuthProvider` sets `user`, so the existing root guard unmounts `LoginPage` and enters the application directly.

- [ ] **Step 3: Add login-dialog styles**

Extend `feature-login.css` with focused classes for overlay, scrollable content, rule checklist, valid/invalid indicators, and two password fields. Reuse `--yb-*` tokens, keep content within the viewport using `position: fixed`, `overflow-y: auto`, and `10vh` vertical padding, and do not vertically center a tall dialog with flex `items-center` behavior.

- [ ] **Step 4: Run build and static source assertions**

Run:

```powershell
cd D:\AI\yibiao-web-agpl\client
npx.cmd vite build
rg -n "onEscapeKeyDown|onPointerDownOutside|首次登录必须修改密码|至少 12 位" src/app/InitialPasswordChangeDialog.tsx
```

Expected: Vite build succeeds and all four dismissal/content assertions are found.

- [ ] **Step 5: Browser-test the interaction locally**

With a disposable local database or mocked local backend, verify:

1. `admin/admin` opens the dialog without mounting the dashboard;
2. Escape and overlay click do not close it;
3. each rule indicator changes independently;
4. weak and mismatched passwords cannot submit;
5. server errors remain visible without page reload;
6. a valid change enters the application immediately;
7. refreshing during the forced flow returns to login;
8. no restricted token appears in Local Storage or Session Storage.

- [ ] **Step 6: Commit the dialog**

```powershell
git add client/src/app/InitialPasswordChangeDialog.tsx client/src/app/LoginPage.tsx client/src/styles/feature-login.css
git commit -m "feat(auth): add mandatory initial password dialog"
```

---

### Task 7: Deployment and Security Documentation

**Files:**
- Modify: `.env.example:1-14`
- Modify: `server/.env.example:1-10`
- Modify: `README.md:38-49`
- Modify: `docs/DEPLOYMENT.md:12-44`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/FEATURES.md`
- Modify: `SECURITY.md:9-16`
- Modify: `docs/superpowers/specs/2026-08-19-initial-admin-forced-password-change-design.md`

**Interfaces:**
- Documents the exact operational contract implemented by Tasks 1-6.
- Removes obsolete initial-credential environment configuration without altering real `.env` files.

- [ ] **Step 1: Remove obsolete environment variables from templates**

Delete these template keys from both `.env.example` files:

```text
INITIAL_ADMIN_USERNAME
INITIAL_ADMIN_PASSWORD
INITIAL_ADMIN_DISPLAY_NAME
INITIAL_ADMIN_PHONE
```

Do not inspect, edit, or stage any real `.env` file.

- [ ] **Step 2: Update installation instructions**

In `README.md` and `docs/DEPLOYMENT.md`, replace the initial-password environment step with this exact operational sequence:

1. run Prisma generate, schema push, and seed;
2. open the Web login page;
3. sign in once with `admin/admin`;
4. set a password of at least 12 characters containing uppercase, lowercase, numeric, and special characters;
5. confirm that the system enters the application and `admin/admin` no longer works;
6. complete this step before exposing the service to untrusted networks.

State explicitly that rerunning seed does not reset an existing administrator.

- [ ] **Step 3: Update architecture, feature, and security references**

Add to `docs/ARCHITECTURE.md` the two JWT purposes and `mustChangePassword` state. Add to `docs/FEATURES.md` the fresh-install forced-change feature. Add to `SECURITY.md` the requirement to complete first-login password change before public exposure and the prohibition on storing the restricted token.

Set the design document status to “已实现、已验证” only after Task 8 succeeds.

- [ ] **Step 4: Verify attribution and secret hygiene**

Run:

```powershell
git diff --check
git diff -- LICENSE NOTICE ATTRIBUTION.md
git grep -n -E "INITIAL_ADMIN_PASSWORD=|JWT_SECRET=[^r]|postgresql://[^:]+:[^@]+@" -- . ':!*.lock'
```

Expected: no license/notice/attribution diff; no real credential values; only documented placeholders or test-only constants are present.

- [ ] **Step 5: Commit documentation**

```powershell
git add .env.example server/.env.example README.md docs/DEPLOYMENT.md docs/ARCHITECTURE.md docs/FEATURES.md SECURITY.md docs/superpowers/specs/2026-08-19-initial-admin-forced-password-change-design.md
git commit -m "docs: document first-login admin password change"
```

---

### Task 8: Full Verification and Release Readiness

**Files:**
- Verify all files changed by Tasks 1-7.
- Modify only the design status line if every required check succeeds.

**Interfaces:**
- Produces local release evidence; does not deploy or push by itself.

- [ ] **Step 1: Run all new focused tests**

Run:

```powershell
cd D:\AI\yibiao-web-agpl\server
pnpm exec tsx --test src/auth/initialPassword.test.ts src/db/seedInitialAdmin.test.ts src/auth/middleware.test.ts src/routes/auth.test.ts
pnpm exec tsx --test ..\client\src\shared\auth\initialPasswordRules.test.ts
```

Expected: every new test PASS with zero failures.

- [ ] **Step 2: Run relevant existing authentication-adjacent regressions**

Run:

```powershell
pnpm exec tsx --test src/routes/response-deviation.test.ts
pnpm exec tsx --test src/response-deviation/store.test.ts
```

Expected: all selected regressions PASS.

- [ ] **Step 3: Validate Prisma and server compilation**

Run:

```powershell
pnpm exec prisma format
pnpm exec prisma validate
pnpm exec prisma generate
pnpm exec tsc --noEmit
```

Expected: Prisma commands succeed. Record the full TypeScript result; if repository-baseline errors remain, prove none point to files modified by this change before proceeding.

- [ ] **Step 4: Build the frontend**

Run:

```powershell
cd D:\AI\yibiao-web-agpl\client
npx.cmd vite build
```

Expected: production build succeeds and writes hashed assets under `client/dist` without staging them if ignored.

- [ ] **Step 5: Verify repository scope and sensitive-data exclusions**

Run:

```powershell
cd D:\AI\yibiao-web-agpl
git diff --check origin/main...HEAD
git status --short
git diff --name-only origin/main...HEAD
git diff origin/main...HEAD -- LICENSE NOTICE ATTRIBUTION.md
```

Expected: only planned source, test, and documentation files differ; no real `.env`, data, uploads, logs, backups, generated dist, license, notice, or attribution files are changed.

- [ ] **Step 6: Mark the design verified and commit only if needed**

After all checks pass, change the design status from “设计已确认，待实施” to “已实现、已验证”. If this line was not included in Task 7's documentation commit, commit it now:

```powershell
git add docs/superpowers/specs/2026-08-19-initial-admin-forced-password-change-design.md
git commit -m "docs: mark initial password change verified"
```

- [ ] **Step 7: Produce the handoff summary**

Report:

- commits created;
- exact test and build results;
- any known pre-existing TypeScript errors;
- confirmation that existing deployments are not reset;
- confirmation that no VM deployment or production data change occurred;
- confirmation that `LICENSE`, `NOTICE`, author attribution, original repository, and AGPL statements remain intact;
- whether the branch is ready for an explicit user-approved GitHub push.
