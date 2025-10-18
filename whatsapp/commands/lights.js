import { 
  switchLight, 
  switchOffAllLights, 
  listAllLights, 
  getLightsByRoom, 
  switchLightByName, 
  setLightBrightnessByName,
  setLightColorTemperatureByName,
  setLightColorByName,
  getLightInfoByName,
  refreshLightCache, 
  getCacheStatus 
} from "../../hue/index.js";

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

export async function setBrightness(sock, sender, lightName, brightness) {
    try {
        const brightnessValue = parseInt(brightness);
        if (isNaN(brightnessValue) || brightnessValue < 0 || brightnessValue > 100) {
            await sock.sendMessage(sender, { text: "Brightness must be a number between 0-100" });
            return;
        }
        
        // Convert percentage to 0-254 range
        const hueBrightness = Math.round((brightnessValue / 100) * 254);
        
        await setLightBrightnessByName(lightName, hueBrightness);
        await sock.sendMessage(sender, { text: `Set ${lightName} brightness to ${brightness}%` });
    } catch (error) {
        console.log("Error setting brightness:", error);
        await sock.sendMessage(sender, { text: `Could not set brightness for "${lightName}". Use "List lights" to see available lights.` });
    }
}

export async function setColorTemp(sock, sender, lightName, colorTemp) {
    try {
        const tempValue = parseInt(colorTemp);
        if (isNaN(tempValue) || tempValue < 1 || tempValue > 10) {
            await sock.sendMessage(sender, { text: "Color temperature must be a number between 1-10 (1=warmest, 10=coolest)" });
            return;
        }
        
        // Convert 1-10 scale to 153-500 mireds (inverted: 1=coolest, 10=warmest)
        const hueColorTemp = Math.round(153 + ((10 - tempValue) / 9) * (500 - 153));
        
        await setLightColorTemperatureByName(lightName, hueColorTemp);
        await sock.sendMessage(sender, { text: `Set ${lightName} color temperature to ${colorTemp}/10` });
    } catch (error) {
        console.log("Error setting color temperature:", error);
        await sock.sendMessage(sender, { text: `Could not set color temperature for "${lightName}". Use "List lights" to see available lights.` });
    }
}

export async function setColor(sock, sender, lightName, color) {
    try {
        // Predefined colors for easy use
        const colorMap = {
            'red': [0, 254, 254],
            'green': [25500, 254, 254],
            'blue': [46920, 254, 254],
            'yellow': [12750, 254, 254],
            'orange': [6375, 254, 254],
            'purple': [56100, 254, 254],
            'pink': [56100, 100, 254],
            'white': [0, 0, 254],
            'warm': [0, 0, 254], // Will be overridden by color temp
            'cool': [0, 0, 254]  // Will be overridden by color temp
        };
        
        let hue, sat, bri;
        
        if (colorMap[color.toLowerCase()]) {
            [hue, sat, bri] = colorMap[color.toLowerCase()];
        } else {
            // Try to parse as comma-separated values
            const parts = color.split(',').map(p => parseInt(p.trim()));
            if (parts.length === 3 && parts.every(p => !isNaN(p))) {
                [hue, sat, bri] = parts;
            } else {
                await sock.sendMessage(sender, { 
                    text: `Invalid color. Use predefined colors (red, green, blue, yellow, orange, purple, pink, white) or HSB values (hue,sat,bri)` 
                });
                return;
            }
        }
        
        await setLightColorByName(lightName, hue, sat, bri);
        await sock.sendMessage(sender, { text: `Set ${lightName} color to ${color}` });
    } catch (error) {
        console.log("Error setting color:", error);
        await sock.sendMessage(sender, { text: `Could not set color for "${lightName}". Use "List lights" to see available lights.` });
    }
}

export async function lightInfo(sock, sender, lightName) {
    try {
        const info = await getLightInfoByName(lightName);
        
        let message = `💡 *${info.name} Info:*\n\n`;
        message += `Type: ${info.type}\n`;
        message += `Model: ${info.modelid}\n\n`;
        
        message += `*Capabilities:*\n`;
        message += `• Color: ${info.capabilities.hasColor ? 'Yes' : 'No'}\n`;
        message += `• Color Temperature: ${info.capabilities.hasColorTemp ? 'Yes' : 'No'}\n`;
        message += `• Brightness: ${info.capabilities.hasBrightness ? 'Yes' : 'No'}\n\n`;
        
        message += `*Current State:*\n`;
        message += `• On: ${info.state.on ? 'Yes' : 'No'}\n`;
        message += `• Brightness: ${info.state.brightness ? Math.round((info.state.brightness / 254) * 100) + '%' : 'N/A'}\n`;
        message += `• Color Temp: ${info.state.colorTemp ? Math.round(10 - ((info.state.colorTemp - 153) / (500 - 153)) * 9) + '/10' : 'N/A'}\n`;
        message += `• Color Mode: ${info.state.colormode || 'N/A'}\n`;
        
        await sock.sendMessage(sender, { text: message });
    } catch (error) {
        console.log("Error getting light info:", error);
        await sock.sendMessage(sender, { text: `Could not get info for "${lightName}". Use "List lights" to see available lights.` });
    }
}