import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiDiagnosticsService } from './service';

function fixtures() {
  const calls: Array<{ method: string; args: any }> = [];
  const prisma = {
    aiDiagnosticRun: {
      create: async (args: any) => { calls.push({ method: 'run.create', args }); return args.data; },
      update: async (args: any) => { calls.push({ method: 'run.update', args }); return args.data; },
      deleteMany: async (args: any) => { calls.push({ method: 'run.deleteMany', args }); return { count: 1 }; },
      findMany: async () => [],
      findUnique: async () => null,
      count: async () => 0,
    },
    aiDiagnosticAttempt: {
      create: async (args: any) => { calls.push({ method: 'attempt.create', args }); return { id: 'attempt-1', ...args.data }; },
      update: async (args: any) => { calls.push({ method: 'attempt.update', args }); return args.data; },
    },
  };
  const storageCalls: any[] = [];
  const storage = {
    writeFailure: async (...args: any[]) => { storageCalls.push(args); return '2026-08-12/trace-1/attempt-1.txt'; },
    readFailure: async () => '',
    deleteExpired: async () => 1,
  };
  const errors: unknown[] = [];
  const service = createAiDiagnosticsService({ prisma: prisma as any, storage, logger: { error: (value: unknown) => errors.push(value) } });
  return { service, calls, errors, storageCalls };
}

test('failed attempt stores content under its diagnostic trace', async () => {
  const { service, storageCalls } = fixtures();
  await service.failAttempt('trace-1', 'attempt-1', {
    code: 'AI_JSON_SYNTAX_ERROR', stage: 'parse', message: 'invalid json',
  }, '{bad json');
  assert.deepEqual(storageCalls[0], ['trace-1', 'attempt-1', '{bad json']);
});

test('successful attempt stores metadata without a response file', async () => {
  const { service, calls } = fixtures();
  const attemptId = await service.startAttempt('trace-1', { attemptNo: 1, phase: 'primary', requestChars: 42 });
  await service.completeAttempt(attemptId!, { responseChars: 80, responseHash: 'hash', responseShape: { type: 'object' } });
  const update = calls.find((call) => call.method === 'attempt.update');
  assert.equal(update?.args.data.responseFile, null);
  assert.equal(update?.args.data.status, 'success');
});

test('marks a fallback run as degraded', async () => {
  const { service, calls } = fixtures();
  await service.markFallback('trace-1', 'tender-merge', ['使用确定性合并']);
  const update = calls.find((call) => call.method === 'run.update');
  assert.equal(update?.args.data.degraded, true);
  assert.equal(update?.args.data.status, 'degraded');
});

test('swallows persistence failures and reports them once', async () => {
  const { errors } = fixtures();
  const broken = createAiDiagnosticsService({
    prisma: { aiDiagnosticRun: { create: async () => { throw new Error('db down'); } } } as any,
    storage: { writeFailure: async () => '', readFailure: async () => '', deleteExpired: async () => 0 },
    logger: { error: (value: unknown) => errors.push(value) },
  });
  await assert.doesNotReject(() => broken.startRun({ traceId: 'trace-1', operation: 'test' }, {}));
  assert.equal(errors.length, 1);
});

test('throttles expired cleanup to once per hour', async () => {
  const { service, calls } = fixtures();
  const now = new Date('2026-08-12T00:00:00.000Z');
  await service.cleanupExpired(now, true);
  await service.cleanupExpired(new Date(now.getTime() + 30 * 60 * 1000));
  assert.equal(calls.filter((call) => call.method === 'run.deleteMany').length, 1);
});
