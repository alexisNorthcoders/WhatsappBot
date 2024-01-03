const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { OpenAI } = require('openai');
const dotenv = require("dotenv").config()
const path = require('path');
const fetch = require('node-fetch')

const app = express();
const port = process.env.PORT

// Initialize Twilio client
const twilioClient = new twilio(process.env.TWILIO_TOKEN1, process.env.TWILIO_TOKEN2);

// Initialize OpenAI API client
const openai = new OpenAI({apiKey:process.env.OPENAI_API_KEY});

// Function to fetch weather data
async function getWeatherData(city) {
  const apiKey = "b4316d96b76dc319de1c762d2e8af50c"
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

app.set("view engine", "ejs");

app.use(express.static(__dirname ));

app.get("/", (req, res) => {
  res.render("index");
});
app.get("/weather", async (req, res) => {
  const city = req.query.city;
  try {
    const weatherData = await getWeatherData(city);
    console.log(weatherData)
    res.render("index", { weather: weatherData });
  } catch (error) {
    console.log(error)
    res.status(500).send("Error fetching weather data.");
  }
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json())
app.post('/gpt3', async (req, res) => {
  const userMessage = req.body.userPrompt;
  
  
  try {
    // Process the user's message using ChatGPT
    const response = await gPT3generateResponse(userMessage);
    
    // Send the response back to the user via Twilio
    await sendMessage(req.body.From, response);

    res.send(response);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error processing message');
  }
});

// Function to generate a response from ChatGPT
async function gPT3generateResponse(userMessage) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo-1106',
      messages:[{"role":"user", "content": userMessage}],
      max_tokens:1000
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
      model: 'gpt-4',
      messages:[{"role":"user", "content": userMessage}],
      max_tokens:1000
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
      model: "dall-e-2",
      prompt:  userMessage,
      n: 1,
      size: "1024x1024",
    });
    imageUrl = response.data[0].url
    console.log(imageUrl)
     
    return imageUrl;
  } catch (error) {
    console.error('Error generating Dall-e response:', error);
    throw new Error('Error generating response');
  }
}

// Function to send a message via Twilio
async function sendMessage(to, message) {
  try {
    await twilioClient.messages.create({
      body: message,
      from: 'whatsapp:+14155238886', // Twilio phone number
      to,
    });
  } catch (error) {
    console.error('Error sending message:', error);
    throw new Error('Error sending message');
  }
}

app.post('/whatsapp', async (req, res) => {

  const userMessage = req.body.Body
  console.log(userMessage)
if (userMessage.startsWith("Dalle")){
  const prompt = userMessage.replace("Dalle","")
  try {
  const response = await dallegenerateResponse(prompt);
   // Send the response back to the user via Twilio
   await sendMessage(req.body.From, response);
   res.send(response);
}
catch (error) {
  console.error('Error:', error);
  res.status(500).send('Error processing message');
}}
if (userMessage.startsWith("Weather")){
  const prompt = userMessage.replace("Weather","")
  try {
    // Process the user's message using ChatGPT
    const response = await getWeatherData(prompt);
    
    // Send the response back to the user via Twilio
    await sendMessage(req.body.From, response);
  
    res.send(response);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error processing message');
  }}
if (userMessage.startsWith("Gpt3")){
  const prompt = userMessage.replace("Gpt3","")
try {
  // Process the user's message using ChatGPT
  const response = await gPT3generateResponse(prompt);
  
  // Send the response back to the user via Twilio
  await sendMessage(req.body.From, response);

  res.send(response);
} catch (error) {
  console.error('Error:', error);
  res.status(500).send('Error processing message');
}}
if (userMessage.startsWith("Gpt4")){
  const prompt = userMessage.replace("Gpt4","")
  try {
    // Process the user's message using ChatGPT
    const response = await gPT4generateResponse(prompt);
    
    // Send the response back to the user via Twilio
    await sendMessage(req.body.From, response);
  
    res.send(response);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error processing message');
  }}
  
  
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
