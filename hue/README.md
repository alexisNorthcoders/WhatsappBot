# Philips Hue API Functions

This folder contains all the Philips Hue API related functions for the WhatsApp Bot.

## Files

- `api.js` - Contains all the Hue API functions
- `index.js` - Exports all functions for easy importing

## Available Functions

### `switchLight(lightID, state)`
Turns a specific light on or off.
- **Parameters:**
  - `lightID` (string): The ID of the light to control
  - `state` (boolean): `true` to turn on, `false` to turn off

### `switchOffAllLights()`
Turns off all lights in the house.

### `listAllLights()`
Returns a list of all lights with their information.
- **Returns:** Array of light objects with:
  - `id`: Light ID
  - `name`: Light name
  - `room`: Room name
  - `state`: Current state (ON/OFF)
  - `type`: Light type
  - `modelid`: Model ID

### `getLightsByRoom(roomName)`
Returns lights filtered by room name.
- **Parameters:**
  - `roomName` (string): Name of the room to filter by
- **Returns:** Array of light objects in the specified room

### `findLightByName(lightName)`
Finds a light by its name (case-insensitive partial match).
- **Parameters:**
  - `lightName` (string): Name of the light to find
- **Returns:** Light object or undefined if not found

### `switchLightByName(lightName, state)`
Turns a light on or off by its name.
- **Parameters:**
  - `lightName` (string): Name of the light to control
  - `state` (boolean): `true` to turn on, `false` to turn off
- **Throws:** Error if light is not found

### `setLightBrightness(lightID, brightness)`
Sets the brightness of a light (0-254).
- **Parameters:**
  - `lightID` (string): ID of the light
  - `brightness` (number): Brightness value (0-254)

### `setLightBrightnessByName(lightName, brightness)`
Sets the brightness of a light by name.
- **Parameters:**
  - `lightName` (string): Name of the light
  - `brightness` (number): Brightness value (0-254)

### `setLightColorTemperature(lightID, colorTemp)`
Sets the color temperature of a light (153-500 mireds).
- **Parameters:**
  - `lightID` (string): ID of the light
  - `colorTemp` (number): Color temperature in mireds (153=warmest, 500=coolest)

### `setLightColorTemperatureByName(lightName, colorTemp)`
Sets the color temperature of a light by name.
- **Parameters:**
  - `lightName` (string): Name of the light
  - `colorTemp` (number): Color temperature in mireds

### `setLightColor(lightID, hue, saturation, brightness)`
Sets the color of a light using HSB values.
- **Parameters:**
  - `lightID` (string): ID of the light
  - `hue` (number): Hue value (0-65535)
  - `saturation` (number): Saturation value (0-254)
  - `brightness` (number): Brightness value (0-254)

### `setLightColorByName(lightName, hue, saturation, brightness)`
Sets the color of a light by name using HSB values.
- **Parameters:**
  - `lightName` (string): Name of the light
  - `hue` (number): Hue value (0-65535)
  - `saturation` (number): Saturation value (0-254)
  - `brightness` (number): Brightness value (0-254)

### `getLightInfo(lightID)`
Gets detailed information about a light including capabilities and current state.
- **Parameters:**
  - `lightID` (string): ID of the light
- **Returns:** Object with light info, capabilities, and current state

### `getLightInfoByName(lightName)`
Gets detailed information about a light by name.
- **Parameters:**
  - `lightName` (string): Name of the light
- **Returns:** Object with light info, capabilities, and current state

## Environment Variables Required

- `HUE_IP`: IP address of your Philips Hue Bridge
- `HUE_USERNAME`: Username for Hue API authentication

## Usage Example

```javascript
import { listAllLights, switchLight, switchLightByName } from './hue/index.js';

// List all lights
const lights = await listAllLights();
console.log(lights);

// Turn on light with ID "1"
await switchLight("1", true);

// Turn on light by name
await switchLightByName("Living Room Light", true);
```

## WhatsApp Commands

### Basic Control
- `Light on <name>` - Turn on a specific light by name
- `Light off <name>` - Turn off a specific light by name
- `Lights off` - Turn off all lights

### Light Information
- `List lights` - Show all lights with their names and IDs
- `Lights in <room>` - Show lights in a specific room
- `Light info <name>` - Get detailed info about a specific light

### Brightness Control
- `Brightness <0-100> <name>` - Set brightness percentage (0-100%)

### Color Temperature Control
- `Color temp <1-10> <name>` - Set color temperature (1=warmest, 10=coolest)

### Color Control
- `Color <color> <name>` - Set light color using predefined colors
  - Available colors: red, green, blue, yellow, orange, purple, pink, white
  - Or use HSB values: `Color 0,254,254 <name>` (hue,sat,bri)

### Cache Management
- `Refresh cache` - Manually refresh the light cache
- `Cache status` - Check cache status and statistics
