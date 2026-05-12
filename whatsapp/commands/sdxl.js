import { promises as fs } from 'fs';
import path from 'path';
import { sdxlTurboGenerateResponse, qwenImageEditGenerateResponse } from '../../models/models.js';
import {
  setLastSdxlPath,
  getLastSdxlPath,
  resolveSdxlGeneratedPngBasename,
} from '../sdxlLastPath.js';

const VALID_SIZES = ['256x256', '512x512', '768x768', '1024x1024'];
const DEFAULT_SIZE = '1024x1024';

const EXPLICIT_PNG = /^(\S+\.png)\s+([\s\S]+)$/i;

function iterationHint(savedBasename) {
  const ref = savedBasename ? `\`${savedBasename}\`` : 'the last SDXL image from this chat';
  return (
    `Refine (no re-upload): *sdxl+ what to change* uses ${ref}. ` +
    `Or *sdxl+ yourfile.png what to change* (files in assets/generated on the server).`
  );
}

export async function sdxlIterateCommand(sock, sender, text) {
  const body = text.replace(/^\s*sdxl\+\s*/i, '').trim();
  if (!body) {
    await sock.sendMessage(sender, {
      text: [
        '*SDXL refine*',
        '',
        '*sdxl+* <what to change> — edits the last SDXL image from this chat (saved on server).',
        '*sdxl+* <filename.png> <what to change> — pick a file from assets/generated.',
      ].join('\n'),
    });
    return;
  }

  if (/^\S+\.png$/i.test(body)) {
    await sock.sendMessage(sender, {
      text: 'Add what to change after the filename, e.g. *sdxl+ file.png add sunset lighting*',
    });
    return;
  }

  let resolvedAbs;
  let instruction;

  const explicit = body.match(EXPLICIT_PNG);
  if (explicit) {
    try {
      resolvedAbs = await resolveSdxlGeneratedPngBasename(explicit[1]);
    } catch {
      await sock.sendMessage(sender, {
        text: `Could not open \`${explicit[1]}\`. Use the exact .png name from assets/generated.`,
      });
      return;
    }
    instruction = explicit[2].trim();
  } else {
    resolvedAbs = getLastSdxlPath(sender);
    instruction = body;
  }

  if (!resolvedAbs) {
    await sock.sendMessage(sender, {
      text: 'No recent SDXL image for this chat. Run *sdxl …* first, or use *sdxl+ filename.png …*.',
    });
    return;
  }

  if (!instruction) {
    await sock.sendMessage(sender, { text: 'Say what to change after the filename or after *sdxl+*.' });
    return;
  }

  let buf;
  try {
    buf = await fs.readFile(resolvedAbs);
  } catch {
    await sock.sendMessage(sender, {
      text: 'Could not read the saved image file. Generate again with *sdxl* or pick another *filename.png*.',
    });
    return;
  }

  if (buf.length > 4 * 1024 * 1024) {
    await sock.sendMessage(sender, {
      text: 'Image file too large for edit API (max 4MB).',
    });
    return;
  }

  await sock.sendMessage(sender, { text: 'Refining SDXL image…' });

  try {
    const { buffer, filepath } = await qwenImageEditGenerateResponse({
      image: buf,
      prompt: instruction,
    });
    if (filepath) setLastSdxlPath(sender, filepath);
    const cap = instruction.length > 180 ? `${instruction.slice(0, 177)}…` : instruction;
    await sock.sendMessage(sender, {
      image: buffer,
      caption: `SDXL refine: ${cap}`,
    });
    await sock.sendMessage(sender, { text: iterationHint(filepath ? path.basename(filepath) : null) });
  } catch (e) {
    await sock.sendMessage(sender, {
      text: `SDXL refine failed: ${e?.message || String(e)}`,
    });
  }
}

function usageText() {
  return [
    '*SDXL Turbo image generation*',
    '',
    'Usage: sdxl [size] <prompt>',
    '',
    `Sizes: ${VALID_SIZES.join(', ')}`,
    `Default: ${DEFAULT_SIZE}`,
    '',
    'Example:',
    '• sdxl 1024x1024 A photo of an astronaut riding a horse on Mars',
    '',
    'After an image is sent, use *sdxl+* to refine using the saved file on the server.',
  ].join('\n');
}

export default async function sdxlCommand(sock, sender, text) {
  const args = text.replace(/^sdxl\s*/i, '').trim();
  if (!args) {
    await sock.sendMessage(sender, { text: usageText() });
    return;
  }

  const sizeMatch = args.match(/^(\d+x\d+)\s+/);
  let size = DEFAULT_SIZE;
  let prompt = args;

  if (sizeMatch) {
    const requested = sizeMatch[1];
    if (VALID_SIZES.includes(requested)) {
      size = requested;
      prompt = args.slice(sizeMatch[0].length).trim();
    }
  }

  if (!prompt) {
    await sock.sendMessage(sender, { text: usageText() });
    return;
  }

  await sock.sendMessage(sender, { text: `Generating SDXL Turbo image (${size})...` });

  try {
    const { buffer, filepath } = await sdxlTurboGenerateResponse(prompt, { size });
    if (filepath) setLastSdxlPath(sender, filepath);
    const capPrompt = prompt.length > 200 ? `${prompt.slice(0, 197)}…` : prompt;
    await sock.sendMessage(sender, {
      image: buffer,
      caption: `SDXL Turbo (${size}): ${capPrompt}`,
    });
    await sock.sendMessage(sender, { text: iterationHint(filepath ? path.basename(filepath) : null) });
  } catch (e) {
    await sock.sendMessage(sender, {
      text: `SDXL Turbo generation failed: ${e?.message || String(e)}`,
    });
  }
}
