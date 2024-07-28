const express = require('express');
const bodyParser = require('body-parser');
const { OpenAI } = require('openai');
const dotenv = require("dotenv").config();
const path = require('path');
const fs = require('fs');
const cors = require('cors')
const app = express();
const { dalle2generateResponse, switchLight, getWeatherData, gPT3generateResponse, gPT4generateResponse, dallegenerateResponse, recipeGenerateResponse, instructGenerateResponse, gPT3WizardgenerateResponse, assistantgenerateResponse, vision, visionQuality, visionHelp } = require("./models/models");

app.use(cors())

const port = process.env.PORT;
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

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
        { "role": "system", "content": "I'm the User and you are the Bot.I'm feeding previous interactions with each prompt." },
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
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '/index.html'));

});

app.use(express.static(path.join(__dirname, '/ChatAI/dist')));
app.use(express.static(path.join(__dirname, '/simongame')));
app.use(express.static(path.join(__dirname, '/Portfolio/dist')));
app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, '/ChatAI/dist', 'index.html'));
});
app.get('/simongame', (req, res) => {
  res.sendFile(path.join(__dirname, '/simongame', 'index.html'));
});
app.get('/portfolio', (req, res) => {
  res.sendFile(path.join(__dirname, '/Portfolio/dist', 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server is running at http://localhost:${port}`);
});