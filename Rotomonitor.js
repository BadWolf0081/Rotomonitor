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

bot.once('ready', () => {
    console.info("Discord bot logged in and ready");
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

    await postDeviceGroup(activeDevices, okColor, okImage, 'Active Devices: ' + (activeDevices[0] === "None" ? 0 : activeDevices.length), okDeviceMessage);
    await postDeviceGroup(availableDevices, warningColor, warningImage, 'Available Devices: ' + (availableDevices[0] === "None" ? 0 : availableDevices.length), warnDeviceMessage);
    await postDeviceGroup(deadDevices, offlineColor, offlineImage, 'Dead Devices: ' + (deadDevices[0] === "None" ? 0 : deadDevices.length), offlineDeviceMessage);
    await postLastUpdated();
}

async function postDeviceGroup(deviceList, color, image, title, messageID) {
    let channel = await bot.channels.fetch(config.deviceSummaryChannel || config.channel);
    let deviceString = deviceList.join('\n');
    let embed = new Discord.MessageEmbed()
        .setTitle(title)
        .setColor(color)
        .setThumbnail(image)
        .setDescription(deviceString);
    if (messageID) {
        try {
            let message = await channel.messages.fetch(messageID);
            await message.edit({ embeds: [embed] });
        } catch { await channel.send({ embeds: [embed] }); }
    } else {
        await channel.send({ embeds: [embed] });
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
        } catch { await channel.send(lastUpdated); }
    } else {
        await channel.send(lastUpdated);
    }
}
