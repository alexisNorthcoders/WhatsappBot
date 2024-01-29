const express = require('express');
const bodyParser = require('body-parser');
const { OpenAI } = require('openai');
const dotenv = require("dotenv").config();
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const qrcode = require('qrcode-terminal');

const buttons = ['a', 'b', 'up', 'down', 'left', 'right', 'start', 'select'];

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');


const app = express();
const port = process.env.PORT;
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

const client = new Client(
  {
    puppeteer: {
      args: ['--no-sandbox'],
    }, authStrategy: new LocalAuth()
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
      if(['a', 'b'].includes(button)) {
        button = button.toUpperCase();
      }
  
      fs.writeFileSync('button.txt', button, 'utf8');

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

// Initialize OpenAI API client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getGeocoding(city) {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  const geocodeURL = `http://api.openweathermap.org/geo/1.0/direct?q=${city}&limit=1&appid=${apiKey}`;
  try {
    const response = await fetch(geocodeURL);
    const geocode = await response.json();
    return geocode;
  } catch (error) {
    console.log("Error fetching weather data:", error);
    throw error;
  }

}
async function getWeatherData(city) {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  ;
  try {
    const geocode = await getGeocoding(city, cnt = 3);
    const { lat, lon } = geocode[0];
    const weatherURL = `http://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=metric&APPID=${apiKey}`;
    const response = await fetch(weatherURL);
    const weatherData = await response.json();
    return weatherData;
  } catch (error) {
    console.log("Error fetching weather data:", error);
    throw error;
  }
}

async function assistantgenerateResponse(userMessage) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo-1106',
      messages: [
        { "role": "system", "content": "You are a helpful assistant. You are inside a whatsapp conversation. You have many capabilities. You can tell the weather, send random pictures of Daniel, tell jokes and so on." },
        { "role": "user", "content": userMessage }],
      max_tokens: 1000
      // Adjust this as needed for desired response length
    });


    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error generating GPT-3 response:', error);
    throw new Error('Error generating response');
  }
}
async function gPT3generateResponse(userMessage) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo-1106',
      messages: [{ "role": "user", "content": userMessage }],
      max_tokens: 1000
      // Adjust this as needed for desired response length
    });


    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error generating GPT-3 response:', error);
    throw new Error('Error generating response');
  }
}
async function gPT4generateResponse(userMessage) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4-1106-preview',
      temperature: 0.7,
      messages: [
        { "role": "system", "content": "You are a helpful javascript assistant. When given code you will refactor according to instructions." },
        { "role": "user", "content": userMessage }],
      max_tokens: 1000
      // Adjust this as needed for desired response length
    });


    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error generating GPT-3 response:', error);
    throw new Error('Error generating response');
  }
}
async function dallegenerateResponse(userMessage) {
  try {
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: userMessage,
      n: 1,
      size: "1024x1024",
      quality: "standard"
    });
    imageUrl = response.data[0].url;


    return imageUrl;
  } catch (error) {
    console.error('Error generating Dall-e response:', error);
    throw new Error('Error generating response');
  }
}
async function recipeGenerateResponse(userMessage) {
  try {
    const completion = await openai.completions.create({
      model: 'gpt-3.5-turbo-instruct',
      temperature: 0.7,
      prompt: `create a detailed recipe with only the following ingredients: ${userMessage}. Start off with 'recipe name', 'ingredients list' and 'step-by-step procedure for cooking`,
      max_tokens: 1000
    });

    return completion.choices[0].text.trim();
  } catch (error) {
    console.error('Error generating GPT-3 response:', error);
    throw new Error('Error generating response');
  }
}
async function instructGenerateResponse(userMessage) {
  try {
    const completion = await openai.completions.create({
      model: 'gpt-3.5-turbo-instruct',
      temperature: 0.7,
      prompt: userMessage,
      max_tokens: 1400
    });

    return completion.choices[0].text.trim();
  } catch (error) {
    console.error('Error generating GPT-3 response:', error);
    throw new Error('Error generating response');
  }
}
async function gPT3WizardgenerateResponse(userMessage) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo-1106',
      messages: [{ "role": "system", "content": "You are a wizard. You speak like an eclectic wizard and in riddles. If someone asks your name is Isildor The Great. You always finish your conversation in a form of a wise advice." },
      { "role": "user", "content": userMessage }],
      max_tokens: 1000
      // Adjust this as needed for desired response length
    });


    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error generating GPT-3 response:', error);
    throw new Error('Error generating response');
  }
}

app.post('/weather', async function (req, res) {
  try {
    let { city } = await req.body;


    const forecast = await getWeatherData(city);
    console.log(forecast);
    res.send({
      city,
      now: {
        temperature: forecast.list[0].main.temp,
        humidity: forecast.list[0].main.humidity,
        description: forecast.list[0].weather[0].description,
        timestamp: forecast.list[0].dt_txt
      },
      "+6hour": {
        temperature: forecast.list[2].main.temp,
        humidity: forecast.list[2].main.humidity,
        description: forecast.list[2].weather[0].description,
        timestamp: forecast.list[2].dt_txt
      },
      "+12hour": {
        temperature: forecast.list[4].main.temp,
        humidity: forecast.list[4].main.humidity,
        description: forecast.list[4].weather[0].description,
        timestamp: forecast.list[4].dt_txt
      },
      "+18hour": {
        temperature: forecast.list[6].main.temp,
        humidity: forecast.list[6].main.humidity,
        description: forecast.list[6].weather[0].description,
        timestamp: forecast.list[6].dt_txt
      },
      "+24hour": {
        temperature: forecast.list[8].main.temp,
        humidity: forecast.list[8].main.humidity,
        description: forecast.list[8].weather[0].description,
        timestamp: forecast.list[8].dt_txt
      }
    });
  }
  catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error processing message');
  }
});
app.post('/gpt3', async (req, res) => {
  const userMessage = req.body.userPrompt;

  try {

    const response = await gPT3generateResponse(userMessage);

    res.send(response);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error processing message');
  }
});
app.post('/gpt4', async (req, res) => {
  const userMessage = req.body.userPrompt;

  try {

    const response = await gPT4generateResponse(userMessage);

    res.send(response);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error processing message');
  }
});
app.post('/dalle', async (req, res) => {
  const userMessage = req.body.userPrompt;

  try {

    const response = await dallegenerateResponse(userMessage);

    res.send(response);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error processing message');
  }
});
app.post('/instruct', async (req, res) => {
  const userMessage = req.body.userPrompt;
  try {
    const response = await instructGenerateResponse(userMessage);

    res.send(response);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error processing message');
  }
});
app.post('/recipe', async (req, res) => {
  const userMessage = req.body.userPrompt;
  try {
    const response = await recipeGenerateResponse(userMessage);

    res.send(response);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error processing message');
  }
});
app.post('/whatsapp?:number', async (req, res) => {
  const number = req.query.number ? req.query.number : req.body.phoneNumber;
  const userMessage = req.body.message;

  if (userMessage.startsWith("Dalle")) {
    const prompt = userMessage.replace("Dalle", "");
    try {
      const response = await dallegenerateResponse(prompt);
      client.sendMessage(`whatsapp:${number}@c.us`, response);
      res.send(response);
    }
    catch (error) {
      console.error('Error:', error);
      res.status(500).send('Error processing message');
    }
  }
  else if (userMessage.startsWith("Weather")) {
    const prompt = userMessage.replace("Weather ", "");
    try {
      const forecast = await getWeatherData(prompt);

      if (JSON.stringify(forecast).includes("not found")) {
        res.status(404).send(`${city} city not found!`);
      }
      else {
        const weather = `forecast: ${forecast.weather[0].description}\ntemperature:${forecast.main.temp}\nmax:${forecast.main.temp_max}\nmin:${forecast.main.temp_min}`;
        await client.sendMessage(`${number}@c.us`, weather);

        res.send(weather);
      }
    } catch (error) {
      console.error('Error:', error);
      res.status(500).send('Error processing message');
    }
  }
  else if (userMessage.startsWith("Gpt3")) {
    const prompt = userMessage.replace("Gpt3", "");
    try {
      // Process the user's message using ChatGPT
      const response = await gPT3generateResponse(prompt);
      client.sendMessage(`${number}@c.us`, response);

      res.send(response);
    } catch (error) {
      console.error('Error:', error);
      res.status(500).send('Error processing message');
    }
  }
  else if (userMessage.startsWith("Gpt4")) {
    const prompt = userMessage.replace("Gpt4", "");
    try {

      const response = await gPT4generateResponse(prompt);

      await client.sendMessage(`${number}@c.us`, response);

      res.send(response);
    } catch (error) {
      console.error('Error:', error);
      res.status(500).send('Error processing message');
    }
  }
  else {
    console.log(number, userMessage);
    client.sendMessage(`${number}@c.us`, userMessage).then(err => console.log(err))
      .catch(err => console.log(err));
  }
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '/index.html'));

});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
