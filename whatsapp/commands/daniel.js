import { promises as fs } from 'fs';

export default async function danielCommand(sock, sender) {
    const imageBuffer = await fs.readFile('../../../files/photo001.jpg');
    await sock.sendMessage(sender, {
        image: imageBuffer,
        caption: 'Foto do Daniel'
    });
}