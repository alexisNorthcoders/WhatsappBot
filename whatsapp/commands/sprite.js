import { pixelArtGenerateResponse } from "../../models/models.js";

const VALID_SIZES = ['16x16', '32x32', '48x48', '64x64', '128x128'];
const DEFAULT_SIZE = '32x32';

export default async function spriteCommand(sock, sender, text) {
    const args = text.replace(/^sprite\s*/i, "").trim();

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

    const imageBuffer = await pixelArtGenerateResponse(prompt, size);
    await sock.sendMessage(sender, {
        image: imageBuffer,
        caption: `${size} pixel art: ${prompt}`,
    });
}
