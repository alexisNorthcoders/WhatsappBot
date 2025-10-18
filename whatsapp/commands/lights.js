import { switchLight, switchOffAllLights, listAllLights, getLightsByRoom, switchLightByName, refreshLightCache, getCacheStatus } from "../../hue/index.js";

export async function allOff(sock, sender) {
    console.log('turning lights off')
    await switchOffAllLights();
    await sock.sendMessage(sender, { text: "Switched all lights off" });
}

export async function lightOn(sock, sender, lightName) {
    try {
        await switchLightByName(lightName, true);
        await sock.sendMessage(sender, { text: `Switched ${lightName} on` });
    } catch (error) {
        console.log("Error turning light on:", error);
        await sock.sendMessage(sender, { text: `Could not find light "${lightName}". Use "List lights" to see available lights.` });
    }
}

export async function lightOff(sock, sender, lightName) {
    try {
        await switchLightByName(lightName, false);
        await sock.sendMessage(sender, { text: `Switched ${lightName} off` });
    } catch (error) {
        console.log("Error turning light off:", error);
        await sock.sendMessage(sender, { text: `Could not find light "${lightName}". Use "List lights" to see available lights.` });
    }
}

export async function listLights(sock, sender) {
    try {
        const lights = await listAllLights();
        let message = "🏠 *All Lights:*\n\n";
        
        lights.forEach(light => {
            message += `• *${light.name}* (ID: ${light.id})\n`;
            message += `  Room: ${light.room}\n`;
            message += `  State: ${light.state}\n`;
            message += `  Type: ${light.type}\n\n`;
        });
        
        await sock.sendMessage(sender, { text: message });
    } catch (error) {
        console.log("Error listing lights:", error);
        await sock.sendMessage(sender, { text: "Error fetching lights list" });
    }
}

export async function listLightsByRoom(sock, sender, roomName) {
    try {
        const lights = await getLightsByRoom(roomName);
        let message = `🏠 *Lights in ${roomName}:*\n\n`;
        
        if (lights.length === 0) {
            message += "No lights found in this room.";
        } else {
            lights.forEach(light => {
                message += `• *${light.name}* (ID: ${light.id})\n`;
                message += `  State: ${light.state}\n`;
                message += `  Type: ${light.type}\n\n`;
            });
        }
        
        await sock.sendMessage(sender, { text: message });
    } catch (error) {
        console.log("Error listing lights by room:", error);
        await sock.sendMessage(sender, { text: "Error fetching lights for room" });
    }
}

export async function refreshCache(sock, sender) {
    try {
        await refreshLightCache();
        const status = getCacheStatus();
        await sock.sendMessage(sender, { 
            text: `✅ Cache refreshed!\nLast updated: ${status.lastUpdated}\nLights loaded: ${status.lightCount}` 
        });
    } catch (error) {
        console.log("Error refreshing cache:", error);
        await sock.sendMessage(sender, { text: "Error refreshing cache" });
    }
}

export async function cacheStatus(sock, sender) {
    try {
        const status = getCacheStatus();
        await sock.sendMessage(sender, { 
            text: `📊 *Cache Status:*\n\nLast updated: ${status.lastUpdated || 'Never'}\nLights loaded: ${status.lightCount}\nCurrently updating: ${status.isUpdating ? 'Yes' : 'No'}` 
        });
    } catch (error) {
        console.log("Error getting cache status:", error);
        await sock.sendMessage(sender, { text: "Error getting cache status" });
    }
}