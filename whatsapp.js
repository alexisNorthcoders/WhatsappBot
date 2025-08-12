const makeWASocket = require('@whiskeysockets/baileys').default;
const commands = require('./whatsapp/commands');
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');
const P = require('pino');
const logger = P()
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const { getWeatherData, deepInfraAPI,
  vision, visionQuality, visionHelp, assistantgenerateResponse
} = require('./models/models');
const { pickRandomTopic } = require('./data/helper');
const { topics } = require('./data/topics');
const lights = require('./whatsapp/commands/lights');
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
      logger.info('✅ WhatsApp connected.');
    } else if (connection === 'close') {
      logger.error('❌ Connection closed.', lastDisconnect?.error?.message);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const button = text.toLowerCase();

    const command = text.split(' ')[0].toLowerCase();

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

      }
      else if (commands[command]) {
        await commands[command](sock, sender, text);
      }
      else if (text.startsWith('Altweather')) {
        await sendWeatherMessage(sock, sender);

      }
      else if (text === '!sendpoll') {
        await sock.sendMessage(sender, {
          poll: {
            name: 'Winter or Summer?',
            values: ['Winter', 'Summer'],
            selectableCount: 1
          }
        });

      }
      else if (text.startsWith("Send")) {
        await sendRandomMessage(sock, sender);
        await sendRandomMessage(sock, secondPhone + '@s.whatsapp.net');
      }
      else if (text.startsWith("Weather")) {
        const city = text.replace("Weather ", "");
        const forecast = await getWeatherData(city);
        const response = formatWeather(city, forecast);
        await sock.sendMessage(sender, { text: response });

      }
      else if (text === "Office light") lights.lightOn(sock, send)
      else if (text === "Lights off") lights.allOff(sock, sender)
      else {
        const response = await assistantgenerateResponse(text);
        await sock.sendMessage(sender, { text: response });
      }
    } catch (err) {
      logger.error("❌ Error:", err);
    }
  });

  logger.info("✅ Baileys connected.");
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
