const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const MinecraftServerUtil = require('minecraft-server-util');
const fs = require('fs');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');

dotenv.config();

puppeteer.use(StealthPlugin());

// Constants
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ATERNOS_URL = 'https://aternos.org/servers/';
const COOKIE_PATH = './cookies.json';
const ERROR_LOG = './server_actions.log';
const DETAIL_LOG = './detailed_log.log';

// Minecraft Server Constants
const SERVER_IP = 'Mrvirak1234.aternos.me'; // Replace with your server IP
const SERVER_PORT = 46405;
let previousServerStatus = null; // To track server state changes

let lockStartServer = false; // Lock for /startserver due to CAPTCHA
let cooldownStartServer = false; // Cooldown for /startserver command

// Utility Functions
const logError = (error) => {
    const errorMessage = `[${new Date().toISOString()}] ERROR: ${error}\n`;
    fs.appendFile(ERROR_LOG, errorMessage, (err) => {
        if (err) console.error('Error writing to log:', err);
    });
};

const logDetail = (message) => {
    const logMessage = `[${new Date().toISOString()}] DETAIL: ${message}\n`;
    fs.appendFile(DETAIL_LOG, logMessage, (err) => {
        if (err) console.error('Error writing to log:', err);
    });
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Minecraft Server Status Function with Optimized Retry Logic
const getMinecraftServerStatus = async (ip, port, retries = 1, timeout = 3000) => {
    try {
        const response = await MinecraftServerUtil.status(ip, port, { timeout });
        if (response && response.players) {
            return {
                online: true,
                players: `${response.players.online}/${response.players.max}`,
                version: response.version.name,
                motd: response.motd.clean,
            };
        } else {
            return { online: false, error: 'Server is not responding properly.' };
        }
    } catch (error) {
        if (retries > 0) {
            return await getMinecraftServerStatus(ip, port, retries - 1, timeout); // Retry once if failed
        }
        return { online: false, error: error.message };
    }
};

// Puppeteer Task: Start Aternos Server (with headless optimization)
const startServer = async (chatId) => {
    try {
        const browser = await puppeteer.launch({
            headless: true, // Use headless mode for better performance
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-infobars',
                `--user-agent=${uuidv4()}`, // Random user agent
            ],
        });
        const page = await browser.newPage();

        if (fs.existsSync(COOKIE_PATH)) {
            const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH));
            await page.setCookie(...cookies);
            logDetail('Loaded pre-authenticated cookies.');
        }

        await page.goto(ATERNOS_URL, { waitUntil: 'networkidle2' });

        // Wait for Server Menu
        const serverMenuSelector = '.server-body';
        await page.waitForSelector(serverMenuSelector, { timeout: 15000 });
        logDetail('Server menu loaded. Clicking server menu...');
        await page.click(serverMenuSelector);

        // Detect CAPTCHA
        const captchaDetected = await page.evaluate(() => {
            return !!document.querySelector('#cf-challenge') || !!document.querySelector('.hcaptcha');
        });

        if (captchaDetected) {
            logDetail('CAPTCHA detected, unable to proceed.');
            await browser.close();
            return 'CAPTCHA detected! Unable to start the server.';
        }

        logDetail('Navigated to Aternos server page.');

        // Find and click the start button
        const startButtonSelector = '#start';
        await page.waitForSelector(startButtonSelector);
        await page.click(startButtonSelector);
        logDetail('Clicked the start button.');

        await delay(50000); // Wait for 50 seconds to allow the server to start
        logDetail('Server start process completed.');

        // Save cookies for future use
        const cookies = await page.cookies();
        fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
        logDetail('Cookies saved for the next session.');

        await browser.close();
        return 'Server started successfully!';
    } catch (error) {
        logError(error.message);
        return `Error starting the server: ${error.message}`;
    }
};

// Monitor Server Periodically
const monitorMinecraftServer = async () => {
    const status = await getMinecraftServerStatus(SERVER_IP, SERVER_PORT);

    if (status.online !== previousServerStatus) {
        previousServerStatus = status.online;

        for (const [chatId, preferences] of Object.entries(userPreferences)) {
            if (preferences.notificationsEnabled) {
                const serverStatusText = status.online ? 'Online' : 'Offline';
                const message = `
🌐 **Server is ${serverStatusText}!**
- **Players:** ${status.players}
- **Version:** ${status.version}
- **MOTD:** ${status.motd}
                `;
                bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            }
        }
    }
};

// Monitor every 5 minutes
setInterval(monitorMinecraftServer, 5 * 60 * 1000);

// Telegram Bot Initialization
const bot = new TelegramBot(TOKEN, { polling: true });

// Telegram Bot Commands
bot.onText(/\/startserver/, async (msg) => {
    const chatId = msg.chat.id;

    if (lockStartServer) {
        bot.sendMessage(chatId, 'The /startserver command is currently locked due to a CAPTCHA or Cloudflare issue. Please wait 15 minutes and try again.');
        return;
    }

    if (cooldownStartServer) {
        bot.sendMessage(chatId, 'The /startserver command is on cooldown. Please wait 5 minutes before trying again.');
        return;
    }

    bot.sendMessage(chatId, 'Attempting to start the server...');
    const response = await startServer(chatId);
    bot.sendMessage(chatId, response);

    // Start cooldown
    cooldownStartServer = true;
    setTimeout(() => {
        cooldownStartServer = false;
        bot.sendMessage(chatId, 'The /startserver command is now available again.');
    }, 5 * 60 * 1000); // 5 minutes
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;

    const serverStatus = await getMinecraftServerStatus(SERVER_IP, SERVER_PORT);

    const serverStatusText = serverStatus.online ? 'Online' : 'Offline';

    if (serverStatus.online) {
        const reply = `
🌐 **Server is ${serverStatusText}!**
- **Players:** ${serverStatus.players}
- **Version:** ${serverStatus.version}
- **MOTD:** ${serverStatus.motd}
        `;
        bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
    } else {
        bot.sendMessage(chatId, `❌ The server is ${serverStatusText}. Unable to retrieve status. Error: ${serverStatus.error}`);
    }
});

bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;

    const helpMessage = `
Here are the available commands:
1. /startserver - Start your Aternos server (5-minute cooldown).
2. /status - Check the status of your Minecraft server.
3. /IP - Get the IP address of the Minecraft server.
4. /help - Get a list of available commands.
    `;

    bot.sendMessage(chatId, helpMessage);
});

bot.onText(/\/IP/, (msg) => {
    const chatId = msg.chat.id;
    const ipMessage = `The Minecraft server IP is: ${SERVER_IP}:${SERVER_PORT}`;
    bot.sendMessage(chatId, ipMessage);
});
