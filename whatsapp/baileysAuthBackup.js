import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Snapshot the Baileys auth folder once, before Baileys 7.x migrates its Signal sessions to LID
 * format (one-way). An existing backup is never touched, so later starts keep the pre-v7 copy.
 * The copy is staged in `<backupDir>.partial` and renamed into place, so a crash mid-copy never
 * leaves a half backup that would then be treated as final.
 * @param {{ authDir: string, backupDir: string }} opts
 * @returns {Promise<{ status: 'created' | 'exists' | 'no-auth' }>}
 */
export async function backupAuthDirOnce({ authDir, backupDir }) {
  const auth = path.resolve(authDir);
  const backup = path.resolve(backupDir);
  if (backup === auth || backup.startsWith(auth + path.sep)) {
    throw new Error(`auth backup dir must be outside the live auth folder: ${backup}`);
  }

  if (await exists(backup)) return { status: 'exists' };
  if (!(await exists(auth))) return { status: 'no-auth' };

  const staging = `${backup}.partial`;
  await fs.rm(staging, { recursive: true, force: true });
  await fs.cp(auth, staging, { recursive: true, errorOnExist: true, force: false });
  await fs.rename(staging, backup);
  return { status: 'created' };
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
