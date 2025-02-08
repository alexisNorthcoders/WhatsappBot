const { Client, LocalAuth, MessageMedia, Buttons, Poll } = require('whatsapp-web.js');
const { dalle2generateResponse, switchLight, getWeatherData, gPT3generateResponse, gPT4generateResponse, dallegenerateResponse, recipeGenerateResponse, instructGenerateResponse, gPT3WizardgenerateResponse, assistantgenerateResponse, vision, visionQuality, visionHelp, deepInfraAPI } = require("./models/models")
const qrcode = require('qrcode-terminal');
const { pickRandomTopic } = require('./data/helper');
const { topics } = require('./data/topics');
const dotenv = require("dotenv").config();

const myPhone = process.env.MY_PHONE;
const secondPhone = process.env.SECOND_PHONE;


const buttons = ['a', 'b', 'up', 'down', 'left', 'right', 'start', 'select'];
console.log("Starting WhatsApp Assistant...wait..")
const client = new Client({
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2410.1.html',
  },

  authStrategy: new LocalAuth(),

});

client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
});
client.on('ready', () => {
  console.log('Whatsapp Initiated!');

  const sendDailyMessage = () => {
    const now = new Date();
    const targetTime = new Date(now);
    targetTime.setHours(10, 0, 0, 0);

    if (now > targetTime) {
      targetTime.setDate(targetTime.getDate() + 1);
    }

    const timeUntilTarget = targetTime - now;

    setTimeout(() => {
      sendRandomMessage(myPhone);
      sendRandomMessage(secondPhone);

      sendDailyMessage();
    }, timeUntilTarget);
  };

  sendDailyMessage();
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
    else if (message.body.startsWith('Altweather')) {
      sendWeatherMessage()
    }
    else if (message.body.startsWith('Deepinfra')) {
      const prompt = message.body.replace("Deepinfra ", "");
      const response = await deepInfraAPI(prompt)
      client.sendMessage(message.from, response);
    }
    else if (message.body === '!sendpoll') {

      await message.reply(new Poll('Winter or Summer?', ['Winter', 'Summer']))
    }
    else if (message.body.startsWith("Send")) {
      await sendRandomMessage()
      await sendRandomMessage(secondPhone)

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
      client.sendMessage(message.from, "Try any of my commands: \nDeepinfra \nWizard \nGpt3 \nDalle\nRecipe \nWeather \nText high (send image to extract text) \nText (send image to extract text \nHelp (send image with code) \n!sendpoll (creates a poll)");
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

async function sendRandomMessage(recipient = myPhone) {

  const randomTopic = pickRandomTopic(topics)

  const response = await deepInfraAPI(`Give me a random fact about ${randomTopic}.`)

  client.sendMessage(recipient, response)
    .then(() => {
      console.log('Random message sent:', response);
    })
    .catch((err) => {
      console.error('Failed to send message:', err);
    });
}
async function sendWeatherMessage(recipient = myPhone, city = "Manchester") {

  const weatherResponse = await getWeatherData(city)

  const response = await deepInfraAPI(`Read the following weather data and parse it in bullet points like you were a weatherman. ${JSON.stringify(weatherResponse)}`)

  client.sendMessage(recipient, response)
    .then(() => {
      console.log('Weather message sent:', response);
    })
    .catch((err) => {
      console.error('Failed to send message:', err);
    });
}