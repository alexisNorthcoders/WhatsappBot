const gpt4Command = require('./gpt4');
const helpCommand = require('./help');
const deepInfraCommand = require('./deepinfra')
const wizardCommand = require('./wizard')
const recipeCommand = require('./recipe')
const imageCommand = require('./image')
const danielCommand = require('./daniel')

module.exports = {
    gpt4: gpt4Command,
    help: helpCommand,
    deepinfra: deepInfraCommand,
    wizard: wizardCommand,
    recipe: recipeCommand,
    image: imageCommand,
    daniel: danielCommand
};
