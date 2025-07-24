const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const {
  dalle2generateResponse, switchLight, getWeatherData, gPT4generateResponse,
  gPT3WizardgenerateResponse, recipeGenerateResponse, deepInfraAPI,
  vision, visionQuality, visionHelp, assistantgenerateResponse
} = require('./models/models');
const { pickRandomTopic } = require('./data/helper');
const { topics } = require('./data/topics');
require("dotenv").config();

const myPhone = process.env.MY_PHONE;
const secondPhone = process.env.SECOND_PHONE;
const buttons = ['a', 'b', 'up', 'down', 'left', 'right', 'start', 'select'];

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./.auth/baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      console.log("📱 Scan the QR code below:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp connected.');
    } else if (connection === 'close') {
      console.log('❌ Connection closed.', lastDisconnect?.error?.message);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const button = text.toLowerCase();

    try {
      if (buttons.includes(button)) {
        if (['a', 'b'].includes(button)) fs.writeFileSync('button.txt', button.toUpperCase(), 'utf8');
        else fs.writeFileSync('button.txt', button, 'utf8');
      }

      // Media processing (image with caption)
      if (msg.message.imageMessage) {
        const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger: sock.logger, reuploadRequest: sock.updateMediaMessage });

        if (text.startsWith("Text high")) {
          const res = await visionQuality(buffer.toString('base64'));
          await sock.sendMessage(sender, { text: res });
        } else if (text.startsWith("Text")) {
          const res = await vision(buffer.toString('base64'));
          await sock.sendMessage(sender, { text: res });
        } else if (text.startsWith("Help")) {
          const res = await visionHelp(buffer.toString('base64'));
          await sock.sendMessage(sender, { text: res });
        }

      } else if (text.startsWith('Altweather')) {
        await sendWeatherMessage(sock, sender);

      } else if (text.startsWith('Deepinfra')) {
        const prompt = text.replace("Deepinfra ", "");
        const response = await deepInfraAPI(prompt);
        await sock.sendMessage(sender, { text: response });

      } else if (text === '!sendpoll') {
        await sock.sendMessage(sender, {
          poll: {
            name: 'Winter or Summer?',
            values: ['Winter', 'Summer'],
            selectableCount: 1
          }
        });

      } else if (text.startsWith("Send")) {
        await sendRandomMessage(sock, sender);
        await sendRandomMessage(sock, secondPhone + '@s.whatsapp.net');

      } else if (text.startsWith("Gpt4")) {
        const prompt = text.replace("Gpt4 ", "");
        const response = await gPT4generateResponse(prompt);
        await sock.sendMessage(sender, { text: response });

      } else if (text.startsWith("Wizard")) {
        const prompt = text.replace("Wizard ", "");
        const response = await gPT3WizardgenerateResponse(prompt);
        await sock.sendMessage(sender, { text: response });

      } else if (text.startsWith("Recipe")) {
        const prompt = text.replace("Recipe ", "");
        const response = await recipeGenerateResponse(prompt);
        await sock.sendMessage(sender, { text: response });

      } else if (text.startsWith("Weather")) {
        const city = text.replace("Weather ", "");
        const forecast = await getWeatherData(city);
        const response = formatWeather(city, forecast);
        await sock.sendMessage(sender, { text: response });

      } else if (text === '!Daniel') {
        const imageBuffer = fs.readFileSync('./files/photo001.jpg');
        await sock.sendMessage(sender, {
          image: imageBuffer,
          caption: 'Foto do Daniel'
        });

      } else if (text === "Light on") {
        await switchLight(8, true);
        await sock.sendMessage(sender, { text: "Switched light on" });

      } else if (text === "Light off") {
        await switchLight(8, false);
        await sock.sendMessage(sender, { text: "Switched light off" });

      } else if (text.startsWith("Dalle2")) {
        const prompt = text.replace("Dalle2 ", "");
        const url = await dalle2generateResponse(prompt);
        await sock.sendMessage(sender, { image: { url }, caption: prompt });

      } else if (text.startsWith("Dalle")) {
        const prompt = text.replace("Dalle ", "");
        const url = await dallegenerateResponse(prompt);
        await sock.sendMessage(sender, { image: { url }, caption: prompt });

      } else if (text.startsWith("Help")) {
        await sock.sendMessage(sender, { text: "Try commands: Deepinfra, Wizard, Gpt4, Dalle, Recipe, Weather, Text (image), etc." });

      } else {
        const response = await assistantgenerateResponse(text);
        await sock.sendMessage(sender, { text: response });
      }
    } catch (err) {
      console.error("❌ Error:", err);
    }
  });

  console.log("✅ Baileys connected.");
}

function formatWeather(city, forecast) {
  return `${city}
${forecast.list.slice(0, 8).map(f => `
${f.dt_txt}:
• Temp: ${f.main.temp}
• Humidity: ${f.main.humidity}
• Desc: ${f.weather[0].description}
`).join('')}`;
}

async function sendRandomMessage(sock, recipient = myPhone + "@s.whatsapp.net") {
  const topic = pickRandomTopic(topics);
  const response = await deepInfraAPI(`Give me a random fact about ${topic}`);
  await sock.sendMessage(recipient, { text: response });
}

async function sendWeatherMessage(sock, recipient = myPhone + "@s.whatsapp.net", city = "Manchester") {
  const weatherData = await getWeatherData(city);
  const summary = await deepInfraAPI(`Summarize this weather: ${JSON.stringify(weatherData)}`);
  await sock.sendMessage(recipient, { text: summary });
}

startSock();
