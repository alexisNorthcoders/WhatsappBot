const { OpenAI } = require('openai');
const dotenv = require("dotenv").config();
const fs = require('fs');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const buttons = ['a', 'b', 'up', 'down', 'left', 'right', 'start', 'select'];

function convertToBase64(file) {
    let fileData = fs.readFileSync(file);
    return new Buffer.from(fileData).toString("base64");

}

/* async function vision() {
    const response = await openai.chat.completions.create({
        model: "gpt-4-vision-preview",
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "You are playing Pokemon Red. Your goal is to catch pokemons and win against gymn leaders. Choose a button to press between ['a', 'b', 'up', 'down', 'left', 'right']. It is of utmost importance to give the answer in the JSON format (don't include the typical ```json) pokemon:{button:'button to press here',message:'your thought process here'" },
                    {
                        type: "image_url",
                        image_url: {
                            "url": `data:image/png;base64,${convertToBase64("./files/Pokemon.png")}`,
                            "detail": "low"
                        },
                    },
                ],
            },
        ],
        max_tokens: 1500,
    });
    const answer = JSON.parse(response.choices[0].message.content)
    console.log(answer)
    return answer.pokemon.button;
} */
async function openAiPlaysPokemon(){
  /*   let button = await vision()
    if (buttons.includes(button)) {
      if(['a', 'b'].includes(button)) {
        button = button.toUpperCase();
      }
   */
      fs.writeFileSync('button.txt', "right", 'utf8');

     /*  setTimeout(() => {
        fs.writeFileSync('button.txt', "Capture", 'utf8');
        }, 1000)
      */
  
    }

/* } */
openAiPlaysPokemon()