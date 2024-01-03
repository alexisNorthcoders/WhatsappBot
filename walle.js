const express = require('express');
const { OpenAI } = require('openai');
const dotenv = require("dotenv").config()
const app=express()
const { Client } = require('whatsapp-web.js');
const client = new Client();
const port = process.env.PORT
client.on('qr', (qr) => {
    // Display the QR code to the user and wait for scanning
    })
client.on('authenticated', (session) => {
        console.log('Authenticated');
        // Save session data to avoid logging in again on the next run
        });
client.initialize();

app.use(express.json())


const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, 
  });
 
app.get('/walle',async(req,res)=> {
    const userPrompt = req.query.userPrompt
    const response = await openai.images.generate({
        model: "dall-e-2",
        prompt:  userPrompt,
        n: 1,
        size: "1024x1024",
      });
      image_url = response.data

    res.send(image_url)
})
app.post('/gpt3',async(req,res)=> {
    const userPrompt = req.body.userPrompt
    const response = await openai.chat.completions.create({
        model:'gpt-3.5-turbo',
        messages:[{"role":"user", "content": userPrompt}],
        max_tokens:1000
    })
    res.send(response.choices[0].message.content)
})

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
  });
  