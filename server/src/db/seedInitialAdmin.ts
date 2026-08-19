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
