module.exports = lights = {
    async allOff(sock, sender) {
        await switchOffAllLights();
        await sock.sendMessage(sender, { text: "Switched all lights off" });
    },
    async lightOn(sock, sender) {
        await switchLight(5, true);
        await sock.sendMessage(sender, { text: "Switched office light on" });
    }
}