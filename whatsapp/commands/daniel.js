module.exports = async function danielCommand(sock, sender) {
    const imageBuffer = fs.readFileSync('../../../files/photo001.jpg');
    await sock.sendMessage(sender, {
        image: imageBuffer,
        caption: 'Foto do Daniel'
    });
}