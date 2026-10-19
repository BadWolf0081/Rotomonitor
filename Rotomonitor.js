const Discord = require('discord.js');
const request = require('request');
const config = require('./RotomonitorConfig.json');

const DEVICE_QUERY = 'api/status';
const WEBSITE_AUTH = {
    'auth': {
        'user': config.basicUsername || "",
        'password': config.basicPassword || ""
    },
    'jar': true,
    'headers': config.rotomSecret ? { 'X-Rotom-Secret': config.rotomSecret } : {}
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
    console.info("Bot started. Waiting for first device status update...");
    postStatusLoop();
});

bot.login(config.token);

function postStatusLoop() {
    updateDevices().then(() => {
        // Log after every API update
        logDeviceCounts();
        postGroupedDevices();
        setTimeout(postStatusLoop, (config.postingDelay || 1) * 60000);
    });
}

function updateDevices() {
    return new Promise((resolve) => {
        request.get(config.rotomURL.replace(/\/$/, '') + '/' + DEVICE_QUERY, WEBSITE_AUTH, (err, res, body) => {
            if (err) {
                console.error(`Unable to read Rotom status: ${err.message}`);
                return resolve();
            }
            if (res && res.statusCode >= 400) {
                console.error(`Rotom status request failed with HTTP ${res.statusCode}`);
                return resolve();
            }
            let data;
            try { data = JSON.parse(body); }
            catch { return resolve(); }
            devices = normalizeStatusDevices(data);
            resolve();
        });
    });
}

function normalizeStatusDevices(data) {
    const normalized = {};

    // Rotom OG exposes workers as a top-level array with camelCase fields.
    if (Array.isArray(data.workers)) {
        data.workers.forEach(entry => {
            const worker = entry.worker;
            if (!worker || !worker.deviceId || !worker.workerId) return;
            addNormalizedWorker(normalized, {
                deviceId: worker.deviceId,
                workerId: worker.workerId,
                origin: worker.origin,
                version: worker.version || entry.version,
                isAlive: typeof worker.isAlive === 'boolean'
                    ? worker.isAlive
                    : typeof entry.controller?.isAlive === 'boolean' ? entry.controller.isAlive : false,
                isAllocated: entry.isAllocated
            });
        });
    }

    // Rotom NG nests workers under each device and uses snake_case fields.
    if (Array.isArray(data.devices)) {
        data.devices.forEach(device => {
            const deviceId = device.id || device.device_id || device.deviceId;
            const workers = Array.isArray(device.workers) ? device.workers : [];
            workers.forEach(worker => {
                const workerId = worker.id || worker.worker_id || worker.workerId;
                if (!deviceId || !workerId) return;
                addNormalizedWorker(normalized, {
                    deviceId,
                    workerId,
                    origin: worker.origin || device.origin,
                    version: worker.version || device.version,
                    isAlive: typeof worker.is_connected === 'boolean'
                        ? worker.is_connected
                        : !!device.is_connected,
                    isAllocated: worker.is_in_use
                });
            });

            const hasWorker = Object.keys(normalized).some(key => key.startsWith(`${deviceId}_`));
            const isAlive = typeof device.is_connected === 'boolean' ? device.is_connected : device.isAlive;
            if (!hasWorker && isAlive === false && deviceId) {
                normalized[deviceId] = {
                    name: deviceId,
                    parent: cleanName(device.origin || deviceId),
                    version: device.version,
                    isAllocated: false,
                    isAlive: false
                };
            }
        });
    }

    return normalized;
}

function addNormalizedWorker(normalized, worker) {
    const name = worker.deviceId + "_" + worker.workerId.slice(-3);
    normalized[name] = {
        name,
        parent: cleanName(worker.origin || worker.deviceId),
        version: worker.version,
        isAllocated: !!worker.isAllocated,
        isAlive: worker.isAlive === true
    };
}

function cleanName(str) {
    return str.startsWith('--=') ? str.slice(22) : str;
}

function formatDeviceVersion(version) {
    if (!version) return '';
    const [mitm, game, store] = String(version).split('•').map(part => part.trim());
    return [mitm, game && game.replace(/^v0\./i, ''), store].filter(Boolean).join(' - ');
}

async function postGroupedDevices() {
    let activeDevices = [];
    let availableDevices = [];
    let deadDevices = [];
    for (let deviceName in devices) {
        let device = devices[deviceName];
        if (device.isAlive !== true) { // Treat undefined or false as dead
            deadDevices.push(device.name);
        } else if (device.isAllocated) {
            activeDevices.push(device.name);
        } else {
            availableDevices.push(device.name);
        }
    }
    if (activeDevices.length === 0) activeDevices.push("None");
    if (availableDevices.length === 0) availableDevices.push("None");
    if (deadDevices.length === 0) deadDevices.push("None");

    // Log device counts after grouping
    console.info(`[Device Status] Active: ${activeDevices[0] === "None" ? 0 : activeDevices.length}, Available: ${availableDevices[0] === "None" ? 0 : availableDevices.length}, Dead: ${deadDevices[0] === "None" ? 0 : deadDevices.length}`);

    okDeviceMessage = await postDeviceGroup(activeDevices, okColor, okImage, 'Active Devices: ' + (activeDevices[0] === "None" ? 0 : activeDevices.length), 'okDeviceMessage');
    warnDeviceMessage = await postDeviceGroup(availableDevices, warningColor, warningImage, 'Available Devices: ' + (availableDevices[0] === "None" ? 0 : availableDevices.length), 'warnDeviceMessage');
    offlineDeviceMessage = await postDeviceGroup(deadDevices, offlineColor, offlineImage, 'Dead Devices: ' + (deadDevices[0] === "None" ? 0 : deadDevices.length), 'offlineDeviceMessage');
    await postLastUpdated();
}

function logDeviceCounts() {
    let active = 0, available = 0, dead = 0;
    for (let deviceName in devices) {
        let device = devices[deviceName];
        if (device.isAlive !== true) { // Treat undefined or false as dead
            dead++;
        } else if (device.isAllocated) {
            active++;
        } else {
            available++;
        }
    }
    console.info(`[Device Status] Active: ${active}, Available: ${available}, Dead: ${dead}`);
}

async function postDeviceGroup(deviceList, color, image, title, messageIDKey) {
    let channel = await bot.channels.fetch(config.deviceSummaryChannel || config.channel);

    let lines = [];
    if (messageIDKey === 'offlineDeviceMessage') {
        // For Dead Devices, just show device names (parent field)
        for (let d of deviceList) {
            if (d === "None") continue;
            let device = devices[d];
            if (!device) continue;
            // Remove PokemodAegis- prefix if present
            let deviceName = device.parent.startsWith('PokemodAegis-') ? 
                device.parent.substring(13) : device.parent;
            const version = formatDeviceVersion(device.version);
            lines.push(version ? `${deviceName} - ${version}` : deviceName);
        }
        // Remove duplicates and sort
        lines = [...new Set(lines)].sort();
    } else {
        // Group devices by parent, collect worker numbers
        let parentMap = new Map();
        for (let d of deviceList) {
            if (d === "None") continue;
            let device = devices[d];
            if (!device) continue;
            // Remove PokemodAegis- prefix if present
            let parent = device.parent.startsWith('PokemodAegis-') ? 
                device.parent.substring(13) : device.parent;
            
            // Extract worker number - handle PokemodAegis format differently
            let workerNum;
            if (device.parent.startsWith('PokemodAegis-')) {
                // For PokemodAegis devices, extract the number after the last dash in the worker name
                let parts = d.split('_');
                if (parts.length > 1) {
                    let workerPart = parts[1];
                    // Look for pattern like "2-10" and extract just the "10" part
                    let dashIndex = workerPart.indexOf('-');
                    if (dashIndex >= 0) {
                        // Take everything after the first dash
                        workerNum = workerPart.substring(dashIndex + 1);
                    } else {
                        workerNum = workerPart.replace(/^0+/, '') || workerPart;
                    }
                } else {
                    workerNum = d.slice(-3).replace(/^0+/, '') || d.slice(-3);
                }
            } else {
                // For regular devices, use the last 3 characters
                workerNum = d.slice(-3).replace(/^0+/, '') || d.slice(-3);
            }

            const version = formatDeviceVersion(device.version);
            const groupKey = `${parent}\u0000${version}`;
            if (!parentMap.has(groupKey)) parentMap.set(groupKey, { parent, version, workers: [] });
            parentMap.get(groupKey).workers.push(workerNum);
        }

        // Build output lines
        for (let group of parentMap.values()) {
            // Sort worker numbers numerically
            let workers = group.workers.sort((a, b) => Number(a) - Number(b)).join(',');
            const version = group.version ? ` - ${group.version}` : '';
            lines.push(`${group.parent}${version} (${workers})`);
        }
        if (deviceList.length === 1 && deviceList[0] === "None") lines = ["None"];
        lines.sort(); // <-- Sort parent groups alphabetically
    }

    if (deviceList.length === 1 && deviceList[0] === "None") lines = ["None"];

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
