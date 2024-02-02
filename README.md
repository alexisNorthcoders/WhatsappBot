# Chat Assistant and other small projects

This project was made as a learning experience to practice and showcase my knowledge.

## Features:

Backend server made in **Node.js**:

- Listens to a Whatsapp Account and responds with messages accordingly.
- It allows to make easy API calls to wherever our server is set up.
- Currently you can send and receive messages to OpenAI models directly from Whatsapp.
- Get Weather forecast, speak with an AI wizard, randomnly stored pictures in the server and much more.

<img src="image-6.png" alt="whatsapp assistant giving recipe" width="300"/>

<img src="image-4.png" alt="whatsapp assistant using dalle to create an image" width="300"/>

<img src="image-5.png" alt="whatsapp assistant acting like a wizard" width="300"/>


- POST **/gpt3** (send a message to OpenAI model gpt-3.5-turbo-1106)
- POST **/gpt4** (send a message to OpenAI model gpt-4-1106-preview, this will respond with a stream)
- POST **/dalle** (send a detailed message to ask OpenAI model to create an image)
- POST **/instruct** (send a message to OpenAI model gpt-3.5-turbo-instruct)
- POST **/recipe** (send an ingredient list and OpenAI model gpt-3.5-turbo-instruct will respond with a formated recipe )
- POST **/weather** (receive weather forecast for a city)
- POST **/whatsapp?:number** (send a Whatsapp message from the server mobile number to your chosen number)
- GET **/** (serves the index.html)
- GET **/chat** (serves my React App chat)

**index.html** - built using DOM manipulation to showcase this node API calls and display the information.

<img src="image.png" alt="website built in html js and css" width="300"/>

**React** APP that connects to this Node.js API to make requests to OpenAI and receive responses in a fluid manner.

- markdown react library
- highlight library to display code blocks in a stylish way

<img src="image-2.png" alt="react app showing streaming response" width="300"/>
<img src="image-3.png" alt="react app with code block highlight" width="300"/>


**Stream.js**:

- Node.js server using Node-media-server to stream content, for example with OBS streaming software.

**AI plays Pokemon Red with Vision.js** :

- small app that uses OpenAI vision model (gpt-4-vision-preview) to play Pokemon Red.
- It sends a screenshot from the state of the game and asks which button to press next.
- AI gives the response back as a JSON object with properties of button and a message with the thought process.
- Writes the button to press in a text file (button.txt).
- Emulator running the game and the pokemon.lua script will read the file and press the button.
- We can also use our Node.js API to sending a Whatsapp message with the key to play. Multiple people could play at the same time.

   <img src="image-7.png" alt="response from gpt vision" width="400"/>
   
   <img src="image-9.png" alt="pokemon game initial state" width="200"/>
   <img src="image-8.png" alt="pokemon game going right" width="200"/>

