const { switchLight, switchOffAllLights } = require("../../models/models");

module.exports = lightsCommand = {
    async allOff(sock, sender) {
        console.log('turning lights off')
        await switchOffAllLights();
        await sock.sendMessage(sender, { text: "Switched all lights off" });
    },
    async lightOn(sock, sender) {
        await switchLight(5, true);
        await sock.sendMessage(sender, { text: "Switched office light on" });
    }
}