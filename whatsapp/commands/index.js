import gpt4Command from './gpt4.js';
import helpCommand from './help.js';
import deepInfraCommand from './deepinfra.js';
import wizardCommand from './wizard.js';
import recipeCommand from './recipe.js';
import imageCommand from './image.js';
import danielCommand from './daniel.js';
import * as lightsCommands from './lights.js';
import * as joplinCommands from './joplin.js';

export {
    gpt4Command as gpt4,
    helpCommand as help,
    deepInfraCommand as deepinfra,
    wizardCommand as wizard,
    recipeCommand as recipe,
    imageCommand as image,
    danielCommand as daniel
};

export const hue = {
    lightOn: lightsCommands.lightOn,
    lightOff: lightsCommands.lightOff,
    lightsOff: lightsCommands.allOff,
    listLights: lightsCommands.listLights,
    listLightsByRoom: lightsCommands.listLightsByRoom,
    setBrightness: lightsCommands.setBrightness,
    setColorTemp: lightsCommands.setColorTemp,
    setColor: lightsCommands.setColor,
    lightInfo: lightsCommands.lightInfo,
    refreshCache: lightsCommands.refreshCache,
    cacheStatus: lightsCommands.cacheStatus
}

export const joplin = {
    addNote: joplinCommands.addNote,
    listNotebooks: joplinCommands.listNotebooks,
    searchNotes: joplinCommands.searchNotes,
    getNote: joplinCommands.getNote,
    updateNote: joplinCommands.updateNote,
    deleteNote: joplinCommands.deleteNote,
    help: joplinCommands.joplinHelp
}
