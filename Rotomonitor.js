const Discord = require('discord.js');
const request = require('request');
const config = require('./RotomonitorConfig.json');

const DEVICE_QUERY = 'api/status';
const WEBSITE_AUTH = {
    'auth': {
        'user': config.basicUsername || "",
        'password': config.basicPassword || ""
    },
    'jar': true
};

const okColor = 0x008000;
const warningColor = 0xFFFF00;
const offlineColor = 0xFF0000;
const warningImage = "https://raw.githubusercontent.com/Kneckter/Rotomonitor/rotomonitor/static/warned.png";
const okImage = "https://raw.githubusercontent.com/Kneckter/Rotomonitor/rotomonitor/static/ok.png";
const offlineImage = "https://raw.githubusercontent.com/Kneckter/Rotomonitor/rotomonitor/static/offline.png";

const bot = new Discord.Client({ intents: [Discord.Intents.FLAGS.GUILDS] });
let devices = {};
let okDeviceMessage = "";
let warnDeviceMessage = "";
let offlineDeviceMessage = "";
let lastUpdatedMessage = "";

bot.once('ready', async () => {
    console.info("Discord bot logged in and ready");
    await clearBotMessages();
    postStatusLoop();
});

bot.login(config.token);

function postStatusLoop() {
    updateDevices().then(() => {
        postGroupedDevices();
        setTimeout(postStatusLoop, (config.postingDelay || 1) * 60000);
    });
}

function updateDevices() {
    return new Promise((resolve) => {
        request.get(config.rotomURL + DEVICE_QUERY, WEBSITE_AUTH, (err, res, body) => {
            if (err) return resolve();
            let data;
            try { data = JSON.parse(body); }
            catch { return resolve(); }
            if (!data.workers) return resolve();
            devices = {};
            data.workers.forEach(worker => {
                let name = worker.worker.deviceId + "_" + worker.worker.workerId.slice(-3);
                devices[name] = {
                    name,
                    parent: cleanName(worker.worker.origin),
                    isAllocated: worker.isAllocated || false,
                    isAlive: worker.worker.isAlive || false
                };
            });
            resolve();
        });
    });
}

function cleanName(str) {
    return str.startsWith('--=') ? str.slice(22) : str;
}

async function postGroupedDevices() {
    let activeDevices = [];
    let availableDevices = [];
    let deadDevices = [];
    for (let deviceName in devices) {
        let device = devices[deviceName];
        if (device.isAllocated) activeDevices.push(device.name);
        else if (device.isAlive) availableDevices.push(device.name);
        else deadDevices.push(device.name);
    }
    if (activeDevices.length === 0) activeDevices.push("None");
    if (availableDevices.length === 0) availableDevices.push("None");
    if (deadDevices.length === 0) deadDevices.push("None");

    okDeviceMessage = await postDeviceGroup(activeDevices, okColor, okImage, 'Active Devices: ' + (activeDevices[0] === "None" ? 0 : activeDevices.length), 'okDeviceMessage');
    warnDeviceMessage = await postDeviceGroup(availableDevices, warningColor, warningImage, 'Available Devices: ' + (availableDevices[0] === "None" ? 0 : availableDevices.length), 'warnDeviceMessage');
    offlineDeviceMessage = await postDeviceGroup(deadDevices, offlineColor, offlineImage, 'Dead Devices: ' + (deadDevices[0] === "None" ? 0 : deadDevices.length), 'offlineDeviceMessage');
    await postLastUpdated();
}

async function postDeviceGroup(deviceList, color, image, title, messageIDKey) {
    let channel = await bot.channels.fetch(config.deviceSummaryChannel || config.channel);

    // Group devices by parent, collect worker numbers
    let parentMap = {};
    for (let d of deviceList) {
        if (d === "None") continue;
        let device = devices[d];
        if (!device) continue;
        let parent = device.parent;
        let workerNum = d.slice(-3).replace(/^0+/, ''); // Remove leading zeros for cleaner look
        if (!parentMap[parent]) parentMap[parent] = [];
        parentMap[parent].push(workerNum);
    }

    // Build output lines
    let lines = [];
    for (let parent in parentMap) {
        let workers = parentMap[parent].join(',');
        lines.push(`${parent} (${workers})`);
    }
    if (deviceList.length === 1 && deviceList[0] === "None") lines = ["None"];

    lines.sort(); // <-- Sort alphabetically

    let deviceString = lines.join('\n');
    // Truncate to avoid Discord embed limit (safe margin)
    if (deviceString.length > 1900) {
        deviceString = deviceString.slice(0, 1897) + '\n...and more';
    }

    let embed = new Discord.MessageEmbed()
        .setTitle(title)
        .setColor(color)
        .setThumbnail(image)
        .setDescription(deviceString);

    // Use the messageIDKey to store the message ID for each group
    let messageID = global[messageIDKey];
    if (messageID) {
        try {
            let message = await channel.messages.fetch(messageID);
            await message.edit({ embeds: [embed] });
            return message.id;
        } catch {
            let sent = await channel.send({ embeds: [embed] });
            global[messageIDKey] = sent.id;
            return sent.id;
        }
    } else {
        let sent = await channel.send({ embeds: [embed] });
        global[messageIDKey] = sent.id;
        return sent.id;
    }
}

async function postLastUpdated() {
    let channel = await bot.channels.fetch(config.deviceSummaryChannel || config.channel);
    let now = new Date();
    let lastUpdated = "Last Updated at: **" + now.toLocaleString() + "**";
    if (lastUpdatedMessage) {
        try {
            let message = await channel.messages.fetch(lastUpdatedMessage);
            await message.edit(lastUpdated);
            return;
        } catch {
            // If fetch or edit fails (e.g., message deleted), fall through to send a new one
        }
    }
    let sent = await channel.send(lastUpdated);
    lastUpdatedMessage = sent.id;
}

async function clearBotMessages() {
    const channel = await bot.channels.fetch(config.deviceSummaryChannel || config.channel);
    let messages;
    do {
        messages = await channel.messages.fetch({ limit: 100 });
        const botMessages = messages.filter(m => m.author.id === bot.user.id);
        if (botMessages.size > 0) {
            await channel.bulkDelete(botMessages, true);
        }
    } while (messages.size === 100);
}
