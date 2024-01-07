const express = require('express');
const bodyParser = require('body-parser');
const { OpenAI } = require('openai');
const dotenv = require("dotenv").config();
const fetch = require('node-fetch');
const path = require('path');

const qrcode = require('qrcode-terminal');

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const client = new Client(

  {
    puppeteer: {
      args: ['--no-sandbox'],
    }, authStrategy: new LocalAuth()
  });
const app = express();
const port = process.env.PORT;
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('Whatsapp Initiated!');
});

client.on('message', async message => {
  console.log(message.body);
  try {

    if (message.body.startsWith("Gpt3")) {
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
      const prompt = message.body.replace("Weather ", "");
      const forecast = await getWeatherData(prompt);
      if (JSON.stringify(forecast).includes("not found")) {
        client.sendMessage(message.from, `${city} city not found!`);
      }
      else {
        const weather = `forecast: ${forecast.weather[0].description}\ntemperature:${forecast.main.temp}\nmax:${forecast.main.temp_max}\nmin:${forecast.main.temp_min}`;
        client.sendMessage(message.from, weather);
      }
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


async function getWeatherData(city) {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  const weatherURL = `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&APPID=${apiKey}`;
  try {
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
      quality:"standard"
    });
    imageUrl = response.data[0].url;
    console.log(imageUrl);

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

  let city = await req.body.city.trim();
  console.log(city);
  const forecast = await getWeatherData(city);
  if (JSON.stringify(forecast).includes("not found")) {
    res.status(404).send(`${city} city not found!`);
  }
  else {
    res.send({
      forecast: forecast.weather[0].description,
      temp: forecast.main.temp,
      max: forecast.main.temp_max,
      min: forecast.main.temp_min
    });
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
  console.log(userMessage);
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
  console.log(userMessage);
  try {
    const response = await recipeGenerateResponse(userMessage);

    res.send(response);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error processing message');
  }
});
app.post('/whatsapp?:number', async (req, res) => {
  const { number } = req.query;
  const userMessage = req.body.Body;
  console.log(userMessage);
  if (userMessage.startsWith("Dalle")) {
    const prompt = userMessage.replace("Dalle", "");
    try {
      const response = await dallegenerateResponse(prompt);
      client.sendMessage(`${number}@c.us`, response);
      res.send(response);
    }
    catch (error) {
      console.error('Error:', error);
      res.status(500).send('Error processing message');
    }
  }
  if (userMessage.startsWith("Weather")) {
    const prompt = userMessage.replace("Weather ", "");
    try {
      const forecast = await getWeatherData(prompt);

      if (JSON.stringify(forecast).includes("not found")) {
        res.status(404).send(`${city} city not found!`);
      }
      else {
        const weather = `forecast: ${forecast.weather[0].description}\ntemperature:${forecast.main.temp}\nmax:${forecast.main.temp_max}\nmin:${forecast.main.temp_min}`;

        console.log(forecast);

        await client.sendMessage(`${number}@c.us`, weather);

        res.send(weather);
      }
    } catch (error) {
      console.error('Error:', error);
      res.status(500).send('Error processing message');
    }
  }
  if (userMessage.startsWith("Gpt3")) {
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
  if (userMessage.startsWith("Gpt4")) {
    const prompt = userMessage.replace("Gpt4", "");
    try {
      // Process the user's message using ChatGPT
      const response = await gPT4generateResponse(prompt);

      await client.sendMessage(`${number}@c.us`, response);

      res.send(response);
    } catch (error) {
      console.error('Error:', error);
      res.status(500).send('Error processing message');
    }
  }
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '/index.html'));
 
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
