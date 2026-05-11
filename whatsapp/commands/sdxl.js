import { sdxlTurboGenerateResponse } from '../../models/models.js';

const VALID_SIZES = ['256x256', '512x512', '768x768', '1024x1024'];
const DEFAULT_SIZE = '1024x1024';

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
    const { buffer } = await sdxlTurboGenerateResponse(prompt, { size });
    const capPrompt = prompt.length > 200 ? `${prompt.slice(0, 197)}…` : prompt;
    await sock.sendMessage(sender, {
      image: buffer,
      caption: `SDXL Turbo (${size}): ${capPrompt}`,
    });
  } catch (e) {
    await sock.sendMessage(sender, {
      text: `SDXL Turbo generation failed: ${e?.message || String(e)}`,
    });
  }
}

