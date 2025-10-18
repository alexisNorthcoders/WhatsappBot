import dotenv from 'dotenv';

dotenv.config();

// Light cache to store lights in memory
let lightCache = {
  lights: [],
  lastUpdated: null,
  isUpdating: false
};

// Cache refresh interval (5 minutes)
const CACHE_REFRESH_INTERVAL = 5 * 60 * 1000;

// Initialize the light cache
export async function initializeLightCache() {
  console.log('Initializing light cache...');
  await refreshLightCache();
  
  // Set up periodic refresh
  setInterval(async () => {
    await refreshLightCache();
  }, CACHE_REFRESH_INTERVAL);
  
  console.log('Light cache initialized and refresh timer set');
}

// Refresh the light cache
export async function refreshLightCache() {
  if (lightCache.isUpdating) {
    console.log('Cache refresh already in progress, skipping...');
    return;
  }
  
  lightCache.isUpdating = true;
  
  try {
    const lightsURL = `http://${process.env.HUE_IP}/api/${process.env.HUE_USERNAME}/lights`;
    const groupsURL = `http://${process.env.HUE_IP}/api/${process.env.HUE_USERNAME}/groups`;
    
    // Fetch both lights and groups data
    const [lightsResponse, groupsResponse] = await Promise.all([
      fetch(lightsURL),
      fetch(groupsURL)
    ]);
    
    const lights = await lightsResponse.json();
    const groups = await groupsResponse.json();
    
    // Create a mapping of light ID to room name
    const lightToRoomMap = {};
    Object.entries(groups).forEach(([groupId, groupInfo]) => {
      if (groupInfo.type === 'Room' && groupInfo.lights) {
        groupInfo.lights.forEach(lightId => {
          lightToRoomMap[lightId] = groupInfo.name;
        });
      }
    });
    
    // Format the response to show light ID, name, and room
    const formattedLights = Object.entries(lights).map(([id, light]) => ({
      id: id,
      name: light.name,
      room: lightToRoomMap[id] || 'Unknown Room',
      state: light.state.on ? 'ON' : 'OFF',
      type: light.type,
      modelid: light.modelid
    }));
    
    lightCache.lights = formattedLights;
    lightCache.lastUpdated = new Date();
    
    console.log(`Light cache refreshed: ${formattedLights.length} lights loaded`);
  } catch (error) {
    console.log("Error refreshing light cache:", error);
  } finally {
    lightCache.isUpdating = false;
  }
}

// Get cached lights
export function getCachedLights() {
  return lightCache.lights;
}

// Get cache status
export function getCacheStatus() {
  return {
    lastUpdated: lightCache.lastUpdated,
    lightCount: lightCache.lights.length,
    isUpdating: lightCache.isUpdating
  };
}

export async function switchOffAllLights() {
  const URL = `http://${process.env.HUE_IP}/api/${process.env.HUE_USERNAME}/groups/0/action`;
  try {
    return await fetch(URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: false })
    });
  } catch (error) {
    console.log(error);
    console.log("Error ", error);
  }
}

export async function switchLight(lightID, state) {
  const URL = `http://${process.env.HUE_IP}/api/${process.env.HUE_USERNAME}/lights/${lightID}/state`;
  
  try {
    return await fetch(URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: state })
    });
  } catch (error) {
    console.log("Error ", error);
  }
}

export async function listAllLights() {
  // Return cached lights if available, otherwise refresh cache
  if (lightCache.lights.length === 0) {
    await refreshLightCache();
  }
  
  return lightCache.lights;
}

export async function getLightsByRoom(roomName) {
  const allLights = await listAllLights();
  return allLights.filter(light => 
    light.room.toLowerCase().includes(roomName.toLowerCase())
  );
}

export async function findLightByName(lightName) {
  const allLights = await listAllLights();
  return allLights.find(light => 
    light.name.toLowerCase().includes(lightName.toLowerCase())
  );
}

export async function switchLightByName(lightName, state) {
  try {
    const light = await findLightByName(lightName);
    
    if (!light) {
      throw new Error(`Light "${lightName}" not found`);
    }
    
    return await switchLight(light.id, state);
  } catch (error) {
    console.log("Error switching light by name:", error);
    throw error;
  }
}

// Set light brightness (0-254)
export async function setLightBrightness(lightID, brightness) {
  const URL = `http://${process.env.HUE_IP}/api/${process.env.HUE_USERNAME}/lights/${lightID}/state`;
  
  try {
    // Clamp brightness between 0 and 254
    const clampedBrightness = Math.max(0, Math.min(254, brightness));
    
    return await fetch(URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        on: clampedBrightness > 0,
        bri: clampedBrightness 
      })
    });
  } catch (error) {
    console.log("Error setting brightness:", error);
    throw error;
  }
}

// Set light brightness by name
export async function setLightBrightnessByName(lightName, brightness) {
  try {
    const light = await findLightByName(lightName);
    
    if (!light) {
      throw new Error(`Light "${lightName}" not found`);
    }
    
    return await setLightBrightness(light.id, brightness);
  } catch (error) {
    console.log("Error setting brightness by name:", error);
    throw error;
  }
}

// Set color temperature (153-500 mireds, lower = warmer, higher = cooler)
export async function setLightColorTemperature(lightID, colorTemp) {
  const URL = `http://${process.env.HUE_IP}/api/${process.env.HUE_USERNAME}/lights/${lightID}/state`;
  
  try {
    // Clamp color temperature between 153 and 500 mireds
    const clampedColorTemp = Math.max(153, Math.min(500, colorTemp));
    
    return await fetch(URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        on: true,
        ct: clampedColorTemp 
      })
    });
  } catch (error) {
    console.log("Error setting color temperature:", error);
    throw error;
  }
}

// Set color temperature by name
export async function setLightColorTemperatureByName(lightName, colorTemp) {
  try {
    const light = await findLightByName(lightName);
    
    if (!light) {
      throw new Error(`Light "${lightName}" not found`);
    }
    
    return await setLightColorTemperature(light.id, colorTemp);
  } catch (error) {
    console.log("Error setting color temperature by name:", error);
    throw error;
  }
}

// Set light color using HSB values
export async function setLightColor(lightID, hue, saturation, brightness) {
  const URL = `http://${process.env.HUE_IP}/api/${process.env.HUE_USERNAME}/lights/${lightID}/state`;
  
  try {
    // Clamp values to valid ranges
    const clampedHue = Math.max(0, Math.min(65535, hue));
    const clampedSat = Math.max(0, Math.min(254, saturation));
    const clampedBri = Math.max(0, Math.min(254, brightness));
    
    return await fetch(URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        on: true,
        hue: clampedHue,
        sat: clampedSat,
        bri: clampedBri
      })
    });
  } catch (error) {
    console.log("Error setting color:", error);
    throw error;
  }
}

// Set light color by name
export async function setLightColorByName(lightName, hue, saturation, brightness) {
  try {
    const light = await findLightByName(lightName);
    
    if (!light) {
      throw new Error(`Light "${lightName}" not found`);
    }
    
    return await setLightColor(light.id, hue, saturation, brightness);
  } catch (error) {
    console.log("Error setting color by name:", error);
    throw error;
  }
}

// Get light capabilities and current state
export async function getLightInfo(lightID) {
  const URL = `http://${process.env.HUE_IP}/api/${process.env.HUE_USERNAME}/lights/${lightID}`;
  
  try {
    const response = await fetch(URL);
    const light = await response.json();
    
    return {
      id: lightID,
      name: light.name,
      type: light.type,
      modelid: light.modelid,
      capabilities: {
        hasColor: light.capabilities && light.capabilities.control && light.capabilities.control.colorgamut,
        hasColorTemp: light.capabilities && light.capabilities.control && light.capabilities.control.ct,
        hasBrightness: light.capabilities && light.capabilities.control && light.capabilities.control.bri
      },
      state: {
        on: light.state.on,
        brightness: light.state.bri,
        colorTemp: light.state.ct,
        hue: light.state.hue,
        saturation: light.state.sat,
        xy: light.state.xy,
        colormode: light.state.colormode
      }
    };
  } catch (error) {
    console.log("Error getting light info:", error);
    throw error;
  }
}

// Get light info by name
export async function getLightInfoByName(lightName) {
  try {
    const light = await findLightByName(lightName);
    
    if (!light) {
      throw new Error(`Light "${lightName}" not found`);
    }
    
    return await getLightInfo(light.id);
  } catch (error) {
    console.log("Error getting light info by name:", error);
    throw error;
  }
}
