const express = require('express');
const bodyParser = require('body-parser');
const { OpenAI } = require('openai');
const dotenv = require("dotenv").config();
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const cors = require('cors')
const {getWeatherData,gPT3generateResponse,gPT4generateResponse,dallegenerateResponse, recipeGenerateResponse,instructGenerateResponse,gPT3WizardgenerateResponse, assistantgenerateResponse} = require("./models/models")

app.use(cors())
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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


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
  const userMessage = req.body.userPrompt
  
  try {
    const stream = await openai.chat.completions.create({
      model: 'gpt-4-1106-preview',
      temperature: 0.7,
      messages: [
        { "role": "system", "content": "You are a helpful javascript assistant. When given code you will refactor according to instructions." },
        { "role": "user", "content": userMessage }],
      stream: true,
      max_tokens: 1000

    });
    let final_response = '';


    for await (const chunk of stream) {
      
      res.write(chunk.choices[0]?.delta?.content || '');
      final_response += chunk.choices[0]?.delta?.content || '';
    }
    res.end();


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

app.use(express.static(path.join(__dirname, '/ChatAI/build')));

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, '/ChatAI/build', 'index.html'));
});

app.listen(port,'0.0.0.0', () => {
  console.log(`Server is running at http://localhost:${port}`);
});