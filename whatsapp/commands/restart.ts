import { spawn } from 'child_process';

const PM2_ID = process.env.PM2_RESTART_APP_ID || '0';
const DELAY_MS = parseInt(process.env.PM2_RESTART_DELAY_MS || '800', 10);

/**
 * Notify on WhatsApp, then ask PM2 to restart this app (default id 0).
 * Spawn is detached so the CLI can outlive this Node process as it shuts down.
 */
export default async function restartCommand(sock, sender) {
  await sock.sendMessage(sender, {
    text: `Restarting bot via \`pm2 restart ${PM2_ID}\`…`,
  });
  setTimeout(() => {
    const child = spawn('pm2', ['restart', PM2_ID], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }, DELAY_MS);
}
