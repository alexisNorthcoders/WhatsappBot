import { promises as fs } from 'fs';
import type { Command } from '../types.ts';

const danielCommand: Command = async (sock, sender) => {
    const imageBuffer = await fs.readFile('../../../files/photo001.jpg');
    await sock.sendMessage(sender, {
        image: imageBuffer,
        caption: 'Foto do Daniel'
    });
};

export default danielCommand;
