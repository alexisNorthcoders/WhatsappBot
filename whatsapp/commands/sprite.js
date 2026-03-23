import path from 'path';
import { pixelArtGenerateResponse, pixelArtEditFromFile } from '../../models/models.js';
import {
  setLastSpritePath,
  getLastSpritePath,
  resolveGeneratedPngBasename,
} from '../spriteLastPath.js';

const VALID_SIZES = ['16x16', '32x32', '48x48', '64x64', '128x128'];
const DEFAULT_SIZE = '32x32';

const EXPLICIT_PNG = /^(\S+\.png)\s+([\s\S]+)$/i;

function inferSpriteSizeFromAbsPath(absPath) {
  const m = path.basename(absPath).match(/sprite_(\d+x\d+)_/i);
  if (m && VALID_SIZES.includes(m[1])) return m[1];
  return DEFAULT_SIZE;
}

function iterationHint(savedBasename) {
  const ref = savedBasename ? `\`${savedBasename}\`` : 'the last sprite from this chat';
  return (
    `Refine (no re-upload): *sprite+ what to change* uses ${ref}. ` +
    `Or *sprite+ yourfile.png what to change* (files in assets/generated on the server).`
  );
}

export async function spriteIterateCommand(sock, sender, text) {
  const body = text.replace(/^\s*sprite\+\s*/i, '').trim();
  if (!body) {
    await sock.sendMessage(sender, {
      text: [
        '*Sprite refine*',
        '',
        '*sprite+* <what to change> — edits the last sprite from this chat (saved on server).',
        '*sprite+* <filename.png> <what to change> — pick a file from assets/generated.',
      ].join('\n'),
    });
    return;
  }

  if (/^\S+\.png$/i.test(body)) {
    await sock.sendMessage(sender, {
      text: 'Add what to change after the filename, e.g. *sprite+ file.png brighter outline*',
    });
    return;
  }

  let resolvedAbs;
  let instruction;

  const explicit = body.match(EXPLICIT_PNG);
  if (explicit) {
    try {
      resolvedAbs = await resolveGeneratedPngBasename(explicit[1]);
    } catch {
      await sock.sendMessage(sender, {
        text: `Could not open \`${explicit[1]}\`. Use the exact .png name from assets/generated.`,
      });
      return;
    }
    instruction = explicit[2].trim();
  } else {
    resolvedAbs = getLastSpritePath(sender);
    instruction = body;
  }

  if (!resolvedAbs) {
    await sock.sendMessage(sender, {
      text: 'No recent sprite for this chat. Run *sprite …* first, or use *sprite+ filename.png …*.',
    });
    return;
  }

  if (!instruction) {
    await sock.sendMessage(sender, { text: 'Say what to change after the filename or after *sprite+*.' });
    return;
  }

  const size = inferSpriteSizeFromAbsPath(resolvedAbs);

  await sock.sendMessage(sender, { text: 'Refining sprite…' });

  try {
    const { buffer, filepath } = await pixelArtEditFromFile(resolvedAbs, instruction, size);
    if (filepath) setLastSpritePath(sender, filepath);
    const cap = instruction.length > 180 ? `${instruction.slice(0, 177)}…` : instruction;
    await sock.sendMessage(sender, {
      image: buffer,
      caption: `Refined (${size}): ${cap}`,
    });
    await sock.sendMessage(sender, { text: iterationHint(filepath ? path.basename(filepath) : null) });
  } catch (e) {
    await sock.sendMessage(sender, {
      text: `Sprite refine failed: ${e.message || String(e)}`,
    });
  }
}

export default async function spriteCommand(sock, sender, text) {
  const args = text.replace(/^sprite\s*/i, '').trim();

  if (!args) {
    await sock.sendMessage(sender, {
      text: [
        '*Pixel Art Sprite Generator*',
        '',
        'Usage: sprite [size] <description>',
        '',
        `Sizes: ${VALID_SIZES.join(', ')}`,
        `Default: ${DEFAULT_SIZE}`,
        '',
        'Examples:',
        '• sprite a knight with a sword',
        '• sprite 64x64 fire dragon',
        '• sprite 16x16 heart pickup item',
        '',
        'After a sprite is sent, use *sprite+* to refine using the saved file on the server.',
      ].join('\n'),
    });
    return;
  }

  const sizeMatch = args.match(/^(\d+x\d+)\s+/);
  let size = DEFAULT_SIZE;
  let prompt = args;

  if (sizeMatch) {
    const requested = sizeMatch[1];
    if (VALID_SIZES.includes(requested)) {
      size = requested;
      prompt = args.slice(sizeMatch[0].length);
    }
  }

  await sock.sendMessage(sender, { text: `Generating ${size} pixel art sprite...` });

  const { buffer, filepath } = await pixelArtGenerateResponse(prompt, size);
  if (filepath) setLastSpritePath(sender, filepath);

  await sock.sendMessage(sender, {
    image: buffer,
    caption: `${size} pixel art: ${prompt}`,
  });

  await sock.sendMessage(sender, { text: iterationHint(filepath ? path.basename(filepath) : null) });
}
