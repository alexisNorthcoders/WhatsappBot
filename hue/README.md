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

- `Light on <name>` - Turn on a specific light by name
- `Light off <name>` - Turn off a specific light by name
- `List lights` - Show all lights with their names and IDs
- `Lights in <room>` - Show lights in a specific room
- `Lights off` - Turn off all lights
