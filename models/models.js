const { OpenAI } = require('openai');
const dotenv = require("dotenv").config();
const fs = require('fs');
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
      model: 'gpt-4o-mini',
      messages: [
        { "role": "system", "content": "You are a helpful assistant. You are inside a whatsapp conversation. You have many capabilities. You can tell the weather, recipes, tell jokes and so on." },
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
      messages: [
        { "role": "system", "content": "If asked say that you're talking through a Node.js server made by Alexis, a software developer." },
        { "role": "user", "content": userMessage }],
      max_tokens: 1000
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
      model: 'gpt-4o',
      temperature: 0.7,
      messages: [
        { "role": "system", "content": "You will always give your responses summarized in bullet points unless asked otherwise." },
        { "role": "user", "content": userMessage }],
      max_tokens: 1000

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
function convertToBase64(file) {
  let fileData = fs.readFileSync(file);
  return new Buffer.from(fileData).toString("base64");

}
async function visionQuality(base64) {
  const response = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [
          {
              role: "user",
              content: [
                  { type: "text", text: "Scan the image and extract the text." },
                  {
                      type: "image_url",
                      image_url: {
                          "url": `data:image/jpeg;base64,${base64}`,
                          "detail": "high"
                      },
                  },
              ],
          },
      ],
      max_tokens: 5000,
  });
  console.log(response.usage)
  console.log(`Total cost: $${calculateCost(response.usage)}`)
  return response.choices[0].message.content;
}
  async function vision(base64) {
    const response = await openai.chat.completions.create({
        model: "gpt-4-turbo",
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "Scan the image and extract the text." },
                    {
                        type: "image_url",
                        image_url: {
                            "url": `data:image/jpeg;base64,${base64}`,
                            "detail": "low"
                        },
                    },
                ],
            },
        ],
        max_tokens: 1500,
    });
    console.log(response.usage)
    console.log(`Total cost: $${calculateCost(response.usage)}`)
    return response.choices[0].message.content;
  }
async function visionHelp(base64) {
  const response = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [
          {
              role: "user",
              content: [
                  { type: "text", text: "The image will be coding exercise in python. Help me solve it. Only give me the code." },
                  {
                      type: "image_url",
                      image_url: {
                          "url": `data:image/jpeg;base64,${base64}`,
                          "detail": "high"
                      },
                  },
              ],
          },
      ],
      max_tokens: 1500,
  });
  console.log(response.usage)
  console.log(`Total cost: $${calculateCost(response.usage)}`)
  return response.choices[0].message.content;
}
async function dalle2generateResponse(userMessage) {
  try {
    const response = await openai.images.generate({
      model: "dall-e-2",
      prompt: userMessage,
      n: 1,
      size: "512x512",
      
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
async function switchLight(lightID,state){
  
  const URL = `http://${process.env.HUE_IP}/api/${process.env.HUE_USERNAME}/lights/${lightID}/state`;
  try {
    
    return await fetch(URL,{
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: state })})
   
  } catch (error) {
    console.log("Error ", error);
    
  }
}
function calculateCost(tokens){
  const promptCost = tokens.prompt_tokens * 10/1000000
  const outputCost = tokens.completion_tokens * 30/1000000
  return (promptCost + outputCost).toFixed(3)
}
module.exports = {visionHelp,visionQuality,vision,dalle2generateResponse,switchLight,getGeocoding,getWeatherData,assistantgenerateResponse,gPT3WizardgenerateResponse,gPT4generateResponse,gPT3generateResponse,dallegenerateResponse,recipeGenerateResponse,instructGenerateResponse}