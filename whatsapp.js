const { Client, LocalAuth, MessageMedia,Buttons ,Poll} = require('whatsapp-web.js');
const { dalle2generateResponse, switchLight, getWeatherData, gPT3generateResponse, gPT4generateResponse, dallegenerateResponse, recipeGenerateResponse, instructGenerateResponse, gPT3WizardgenerateResponse, assistantgenerateResponse, vision, visionQuality, visionHelp } = require("./models/models")
const qrcode = require('qrcode-terminal');
const dotenv = require("dotenv").config();

const buttons = ['a', 'b', 'up', 'down', 'left', 'right', 'start', 'select'];
console.log("Starting WhatsApp Assistant...wait..")

const client = new Client({
    authStrategy: new LocalAuth()
});
client.on('qr', qr => {
        qrcode.generate(qr, { small: true });
      });
client.on('ready', () => {
        console.log('Whatsapp Initiated!');
      });
client.on('message', async message => {
        console.log(message.body);
        let button = message.body.toLowerCase();
        try {
          if (buttons.includes(button)) {
            if (['a', 'b'].includes(button)) {
              button = button.toUpperCase();
            }
      
            fs.writeFileSync('button.txt', button, 'utf8');
      
          }
          if (message.hasMedia) {
            if (message.body.startsWith("Text high")) {
              console.log("reading image...")
              const media = await message.downloadMedia()
              if (media) {
                console.log("sending to vision..")
                const response = await visionQuality(media.data)
                client.sendMessage(message.from, response)
              }
              else {
                client.sendMessage(message.from, "Error downloading file.")
              }
            }
            else if (message.body.startsWith("Text")) {
              console.log("reading image...")
              const media = await message.downloadMedia()
              if (media) {
                console.log("sending to vision..")
                const response = await vision(media.data)
                client.sendMessage(message.from, response)
              }
              else {
                client.sendMessage(message.from, "Error downloading file.")
              }
            }
            else if (message.body.startsWith("Help")) {
              console.log("reading image...")
              const media = await message.downloadMedia()
              if (media) {
                console.log("sending to vision..")
                const response = await visionHelp(media.data)
                client.sendMessage(message.from, response)
              }
              else {
                client.sendMessage(message.from, "Error downloading file.")
              }
            }
          }
          //deprecated
      /*     else if (message.body.startsWith('!buttons')) {
            let button = new Buttons('Button body', [{ body: 'bt1' }, { body: 'bt2' }, { body: 'bt3' }], 'title', 'footer');
            console.log("sending buttons message")
            client.sendMessage(message.from, button)
          } */
          else if (message.body === '!sendpoll') {
            
            await message.reply(new Poll('Winter or Summer?', ['Winter', 'Summer']))
          }
          else if (message.body.startsWith("Gpt3")) {
            const prompt = message.body.replace("Gpt3 ", "");
            const response = await gPT3generateResponse(prompt);
            client.sendMessage(message.from, response);
          }
          else if (message.body.startsWith("Gpt3Instruct")) {
            const prompt = message.body.replace("GptInstruct ", "");
            const response = await instructGenerateResponse(prompt);
            client.sendMessage(message.from, response);
          }
          else if (message.body.startsWith("Gpt4")) {
            const prompt = message.body.replace("Gpt4 ", "");
            const response = await gPT4generateResponse(prompt);
            client.sendMessage(message.from, response);
          }
          else if (message.body.startsWith("Wizard")) {
            const prompt = message.body.replace("Wizard ", "");
            const response = await gPT3WizardgenerateResponse(prompt);
            client.sendMessage(message.from, response);
          }
          else if (message.body.startsWith("Recipe")) {
            const prompt = message.body.replace("Recipe ", "");
            const response = await recipeGenerateResponse(prompt);
            client.sendMessage(message.from, response);
          }
          else if (message.body.startsWith("Weather")) {
            const city = message.body.replace("Weather ", "");
            const forecast = await getWeatherData(city);
            const weather = `${city}
            ${forecast.list[0].dt_txt}:
                temperature: ${forecast.list[0].main.temp}
                humidity: ${forecast.list[0].main.humidity}
                description: ${forecast.list[0].weather[0].description}
            ${forecast.list[2].dt_txt}:
                temperature: ${forecast.list[2].main.temp}
                humidity: ${forecast.list[2].main.humidity}
                description: ${forecast.list[2].weather[0].description}
            ${forecast.list[4].dt_txt}
                temperature: ${forecast.list[4].main.temp}
                humidity: ${forecast.list[4].main.humidity}
                description: ${forecast.list[4].weather[0].description} 
            ${forecast.list[6].dt_txt}:
                temperature: ${forecast.list[6].main.temp}
                humidity: ${forecast.list[6].main.humidity}
                description: ${forecast.list[6].weather[0].description}`;
            client.sendMessage(message.from, weather);
          }
      
          else if (message.body === '!Daniel') {
            const media = MessageMedia.fromFilePath('./files/photo001.jpg');
            client.sendMessage(message.from, media, { caption: 'Foto do Daniel' });
          }
          else if (message.body === "Light off") {
            const response = await switchLight(8, false)
            console.log(response)
            client.sendMessage(message.from, "Switched light off");
          }
          else if (message.body === "Light on") {
            const response = await switchLight(8, true)
            console.log(response)
            client.sendMessage(message.from, "Switched light on");
          }
          else if (message.body.startsWith("Dalle2")) {
            const prompt = message.body.replace("Dalle2 ", "");
            const response = await dalle2generateResponse(prompt);
            const media = await MessageMedia.fromUrl(response);
            client.sendMessage(message.from, media);
          }
          else if (message.body.startsWith("Dalle")) {
            const prompt = message.body.replace("Dalle ", "");
            const response = await dallegenerateResponse(prompt);
            const media = await MessageMedia.fromUrl(response);
            client.sendMessage(message.from, media);
          }
          else if (message.body.startsWith("Help")) {
            client.sendMessage(message.from, "Try any of my commands: \nWizard \nGpt3 \nDalle\nRecipe \nWeather");
          }
      
          else {
            const prompt = message.body;
            const response = await assistantgenerateResponse(prompt);
            client.sendMessage(message.from, response);
          }
        }
        catch (err) { console.log(err); }
      });
client.initialize();