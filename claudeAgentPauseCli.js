import {
  pauseAgentForWorkspace,
  resumeAgentForWorkspace,
  getAgentPauseForWorkspace,
  parsePauseArgs,
  formatDurationSeconds,
} from './whatsapp/agents/claudeAgentPause.js';
import {
  getDefaultWorkspaceRoot,
  resolveWorkspaceFromAlias,
  resolveWorkspaceFromUserPath,
} from './whatsapp/claudeWorkspaces.js';

function printUsage() {
  console.log(
    `Stops the cron issue tracer and the manual "claude" WhatsApp command from touching a\n` +
      `workspace's git checkout — run "pause" before doing manual git work in that directory.\n`
  );
  console.log(`Usage:`);
  console.log(`  node claudeAgentPauseCli.js pause  [--alias <name> | --path <abs-path>] [duration] [reason...]`);
  console.log(`  node claudeAgentPauseCli.js resume [--alias <name> | --path <abs-path>]`);
  console.log(`  node claudeAgentPauseCli.js status [--alias <name> | --path <abs-path>]\n`);
  console.log(`With no --alias/--path, the workspace defaults to this bot's own repo root.`);
  console.log(`Duration is compact (30m, 2h, 1d); default is ${formatDurationSeconds(7200)} if omitted.\n`);
  console.log(`Examples:`);
  console.log(`  node claudeAgentPauseCli.js pause 2h working on issue 90 by hand`);
  console.log(`  node claudeAgentPauseCli.js pause --alias dots 30m`);
  console.log(`  node claudeAgentPauseCli.js status --alias dots`);
  console.log(`  node claudeAgentPauseCli.js resume`);
}

/**
 * Pulls a `--alias <name>` or `--path <abs-path>` flag out of `args` (mutating it) and resolves
 * the target workspace root, defaulting to this bot's own repo when neither flag is present.
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function resolveWorkspace(args) {
  const aliasIdx = args.indexOf('--alias');
  if (aliasIdx !== -1) {
    const alias = args[aliasIdx + 1];
    if (!alias) throw new Error('--alias requires a value');
    args.splice(aliasIdx, 2);
    return resolveWorkspaceFromAlias(alias);
  }
  const pathIdx = args.indexOf('--path');
  if (pathIdx !== -1) {
    const path = args[pathIdx + 1];
    if (!path) throw new Error('--path requires a value');
    args.splice(pathIdx, 2);
    return resolveWorkspaceFromUserPath(path);
  }
  return getDefaultWorkspaceRoot();
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    printUsage();
    process.exit(cmd ? 0 : 1);
    return;
  }
  if (!['pause', 'resume', 'status'].includes(cmd)) {
    console.error(`Unknown command "${cmd}".\n`);
    printUsage();
    process.exit(1);
    return;
  }

  const args = [...rest];
  const resumeSuffix = args.includes('--alias')
    ? ` --alias ${args[args.indexOf('--alias') + 1]}`
    : args.includes('--path')
      ? ` --path ${args[args.indexOf('--path') + 1]}`
      : '';

  let workspaceRoot;
  try {
    workspaceRoot = await resolveWorkspace(args);
  } catch (e) {
    console.error(`Workspace error: ${e.message || e}`);
    process.exit(1);
    return;
  }

  if (cmd === 'status') {
    const state = await getAgentPauseForWorkspace({ workspaceRoot });
    if (!state) {
      console.log(`Not paused: ${workspaceRoot}`);
    } else {
      console.log(`Paused: ${workspaceRoot}`);
      console.log(`Reason: ${state.reason}`);
      console.log(
        `Resumes in: ${state.ttlRemainingSeconds ? formatDurationSeconds(state.ttlRemainingSeconds) : 'unknown'}`
      );
    }
    process.exit(0);
    return;
  }

  if (cmd === 'resume') {
    const cleared = await resumeAgentForWorkspace({ workspaceRoot });
    console.log(cleared ? `Resumed: ${workspaceRoot}` : `Nothing to resume: ${workspaceRoot}`);
    process.exit(0);
    return;
  }

  const { ttlSeconds, reason } = parsePauseArgs(args.join(' '));
  const state = await pauseAgentForWorkspace({ workspaceRoot, ttlSeconds, reason });
  console.log(`Paused: ${workspaceRoot}`);
  console.log(`For: ${formatDurationSeconds(state.ttlSeconds)}`);
  console.log(`Reason: ${state.reason}`);
  console.log(`Run \`node claudeAgentPauseCli.js resume${resumeSuffix}\` to lift it early.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e?.message || String(e));
  process.exit(1);
});
