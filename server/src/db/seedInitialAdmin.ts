import bcrypt from 'bcryptjs';
import {
  DEFAULT_INITIAL_ADMIN_PASSWORD,
  DEFAULT_INITIAL_ADMIN_USERNAME,
} from '../auth/initialPassword';

interface InitialAdminTransaction {
  $executeRawUnsafe(sql: string): Promise<unknown>;
  user: {
    count(): Promise<number>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

interface InitialAdminDb {
  $transaction<T>(
    run: (tx: InitialAdminTransaction) => Promise<T>,
    options: { isolationLevel: 'Serializable' },
  ): Promise<T>;
}

interface PrismaLikeError {
  code?: unknown;
  meta?: { code?: unknown };
}

const USERS_TABLE_LOCK = 'LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE';
const MAX_TRANSACTION_ATTEMPTS = 3;

function prismaErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { code } = error as PrismaLikeError;
  return typeof code === 'string' ? code : undefined;
}

function isRetryableTransactionError(error: unknown): boolean {
  const code = prismaErrorCode(error);
  if (code === 'P2034' || code === '40001' || code === '40P01') return true;
  if (code !== 'P2010') return false;
  const metaCode = (error as PrismaLikeError).meta?.code;
  return metaCode === '40001' || metaCode === '40P01';
}

export async function seedInitialAdmin(db: InitialAdminDb): Promise<'created' | 'skipped'> {
  const password = await bcrypt.hash(DEFAULT_INITIAL_ADMIN_PASSWORD, 10);
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(USERS_TABLE_LOCK);
        if (await tx.user.count() > 0) return 'skipped';

        await tx.user.create({
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
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') return 'skipped';
      if (attempt < MAX_TRANSACTION_ATTEMPTS && isRetryableTransactionError(error)) continue;
      throw error;
    }
  }
  throw new Error('unreachable initial administrator seed state');
}
