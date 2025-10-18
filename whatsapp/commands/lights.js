import { switchLight, switchOffAllLights } from "../../models/models.js";

export async function allOff(sock, sender) {
    console.log('turning lights off')
    await switchOffAllLights();
    await sock.sendMessage(sender, { text: "Switched all lights off" });
}

export async function lightOn(sock, sender) {
    await switchLight(5, true);
    await sock.sendMessage(sender, { text: "Switched office light on" });
}