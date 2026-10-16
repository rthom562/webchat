// Webchat: Discord <-> website chat
// A public bot (like Dyno): it works as soon as it's added to a server.
// - The website lists every public server the bot is in. Private servers can
//   be opened by pasting their server ID (the + button).
// - Web users must upload a profile picture. Their messages are posted into
//   Discord through a webhook that uses their name and picture.
// - Web users get the same channel access as a normal member.
// - Discord messages (including ones from before the bot joined) show up on
//   the website as [DISCORD] username, with their Discord profile picture.
// - With /vc enable, web users can talk in voice channels (see voice.js).
// Bot settings live in config.json; per-server settings in data/servers.json.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const {
  Client, GatewayIntentBits, Events, ChannelType, PermissionFlagsBits,
  PermissionsBitField, SlashCommandBuilder, MessageFlags,
} = require('discord.js');
const { VoiceRoom } = require('./voice');

const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('Missing config.json. It should be in the same folder as server.js.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
const TOKEN = config.discord?.token;
const PORT = Number(config.web?.port) || 3080;
const CHAT_PAGE = config.web?.chatPage;
const CHAT_PAGE_URL = (config.web?.chatPageUrl || `http://localhost:${PORT}`).replace(/\/+$/, '');
// Public address of this server, used for profile picture links. Discord can
// only show web users' pictures if this is reachable from the internet.
const SERVER_URL = (config.web?.serverUrl || CHAT_PAGE_URL).replace(/\/+$/, '');

if (!TOKEN || TOKEN === 'PASTE_BOT_TOKEN_HERE') {
  console.error('Paste your bot token into config.json (discord.token), then start again.');
  process.exit(1);
}

const WEBHOOK_NAME = 'Webchat';
const OLD_WEBHOOK_NAMES = ['Web Chat Bridge']; // reused so older messages still show as web users
const HISTORY_LIMIT = 100; // per channel
const MAX_LEN = 2000;
const MAX_AVATAR_BYTES = 512 * 1024;
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const BOT_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
]);

// ------------------------------------------------------ per-server settings --

const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'servers.json');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

// New servers work straight away and show on the list; voice is opt-in.
const DEFAULT_SETTINGS = { enabled: true, public: true, password: '', memberRoleId: null, voice: false };

let servers = {};
try { servers = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8').replace(/^﻿/, '')); } catch {}

function settingsFor(guildId) {
  return { ...DEFAULT_SETTINGS, ...servers[guildId] };
}

function updateSettings(guildId, changes) {
  servers[guildId] = { ...settingsFor(guildId), ...changes };
  fs.writeFileSync(DATA_PATH, JSON.stringify(servers, null, 2));
}

function chatLink(guildId) {
  return `${CHAT_PAGE_URL}/?server=${guildId}`;
}

// Saves an uploaded PNG (sent as a data: URL) and returns its public link.
function saveAvatar(dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  if (!match) return null;
  const buf = Buffer.from(match[1], 'base64');
  const isPng = buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isPng || buf.length > MAX_AVATAR_BYTES) return null;
  const file = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32) + '.png';
  const filePath = path.join(AVATAR_DIR, file);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buf);
  return `${SERVER_URL}/avatars/${file}`;
}

// ----------------------------------------------------------------- webchat --

const app = express();
app.get('/invite', (req, res) => {
  if (!client.isReady()) return res.status(503).send('Bot is starting, try again in a moment.');
  res.redirect(inviteUrl());
});
app.use('/avatars', express.static(AVATAR_DIR, { maxAge: '30d', immutable: true }));
if (CHAT_PAGE) {
  const pageDir = path.resolve(__dirname, CHAT_PAGE);
  app.use(express.static(pageDir));
  console.log(`Serving chat page from ${pageDir}`);
} else {
  console.log('chatPage is empty: not serving a chat page, only the chat connection.');
}
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });

const history = new Map();         // channelId -> messages[] (oldest first)
const loadedChannels = new Set();  // channels whose Discord history has been fetched
const loading = new Map();         // channelId -> Promise while fetching
const rooms = new Map();           // guildId -> VoiceRoom

function send(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}

function sendToGuild(guildId, data) {
  for (const ws of wss.clients) if (ws.guildId === guildId) send(ws, data);
}

function broadcast(guildId, msg) {
  const list = history.get(msg.channelId) ?? [];
  list.push(msg);
  if (list.length > HISTORY_LIMIT) list.shift();
  history.set(msg.channelId, list);
  sendToGuild(guildId, { type: 'message', message: msg });
}

function kickGuild(guildId, reason) {
  for (const ws of wss.clients) {
    if (ws.guildId !== guildId) continue;
    leaveVoice(ws);
    send(ws, { type: 'kicked', server: guildId, error: reason });
    ws.guildId = null;
  }
}

function clean(str, max) {
  return String(str ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

// Discord rejects webhook usernames containing "discord" or "clyde".
function webhookSafeName(name) {
  const safe = name.replace(/discord/gi, 'd1scord').replace(/clyde/gi, 'clyd3');
  return safe.length ? safe.slice(0, 80) : 'Web User';
}

function serverInfo(guild) {
  return {
    id: guild.id,
    name: guild.name,
    icon: guild.iconURL({ size: 128 }),
    members: guild.memberCount,
    password: Boolean(settingsFor(guild.id).password),
  };
}

function publicServers() {
  return [...client.guilds.cache.values()]
    .filter((g) => settingsFor(g.id).enabled && settingsFor(g.id).public)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(serverInfo);
}

function pushServerList() {
  if (!client.isReady()) return;
  const data = { type: 'servers', servers: publicServers() };
  for (const ws of wss.clients) send(ws, data);
}

async function handleWebMessage(ws, data) {
  if (data.type === 'servers') {
    send(ws, { type: 'servers', servers: client.isReady() ? publicServers() : [] });
    return;
  }

  if (data.type === 'serverInfo') {
    const guild = client.guilds.cache.get(clean(data.server, 25));
    if (!guild || !settingsFor(guild.id).enabled) {
      send(ws, { type: 'serverInfoError', error: 'No server with that ID has Webchat available.' });
      return;
    }
    send(ws, { type: 'serverInfo', server: serverInfo(guild) });
    return;
  }

  if (data.type === 'profile') {
    const name = clean(data.name, 32);
    const avatar = saveAvatar(data.avatar);
    if (!name || !avatar) {
      send(ws, { type: 'profileError', error: !name ? 'Pick a name.' : 'Upload a profile picture.' });
      return;
    }
    ws.user = { name, avatar };
    send(ws, { type: 'profile', user: ws.user });
    if (ws.guildId) pushVoiceStates(client.guilds.cache.get(ws.guildId));
    return;
  }

  if (data.type === 'join') {
    const guildId = clean(data.server, 25);
    const guild = client.guilds.cache.get(guildId);
    const settings = settingsFor(guildId);
    if (!ws.user) {
      send(ws, { type: 'joinError', server: guildId, code: 'profile', error: 'Set up your profile first.' });
      return;
    }
    if (!guild || !settings.enabled) {
      send(ws, { type: 'joinError', server: guildId, code: 'unavailable', error: 'That server does not have Webchat available.' });
      return;
    }
    if (settings.password && data.password !== settings.password) {
      send(ws, {
        type: 'joinError', server: guildId, code: 'password',
        error: data.password ? 'Wrong password.' : 'This server needs a password.',
      });
      return;
    }
    if (ws.guildId !== guildId) leaveVoice(ws);
    ws.guildId = guildId;
    send(ws, {
      type: 'joined',
      server: serverInfo(guild),
      voiceEnabled: settings.voice,
      channels: listChannels(guild),
      voiceStates: voiceStates(guild),
    });
    return;
  }

  if (!ws.guildId || !ws.user) return;
  const guild = client.guilds.cache.get(ws.guildId);
  if (!guild) return;

  if (data.type === 'history') {
    const channel = getTextChannel(guild, data.channelId);
    if (!channel) return;
    try {
      const messages = await loadHistory(channel);
      send(ws, { type: 'history', channelId: channel.id, messages });
    } catch (err) {
      console.error(`[${guild.name}] Could not load history for #${channel.name}:`, err.message);
      send(ws, { type: 'history', channelId: channel.id, messages: history.get(channel.id) ?? [] });
    }
    return;
  }

  if (data.type === 'chat') {
    const content = String(data.content ?? '').trim().slice(0, MAX_LEN);
    const channel = getTextChannel(guild, data.channelId);
    if (!content) return;
    if (!channel) {
      send(ws, { type: 'error', error: 'That channel is not available.' });
      return;
    }
    if (!canMembersSend(channel)) {
      send(ws, { type: 'error', error: `You can't send messages in #${channel.name}.` });
      return;
    }
    try {
      const sent = await sendToDiscord(channel, ws.user, content);
      broadcast(guild.id, {
        id: sent.id, source: 'web', channelId: channel.id,
        name: ws.user.name, avatar: ws.user.avatar, content: sent.content || content,
        time: sent.createdTimestamp ?? Date.now(),
      });
    } catch (err) {
      console.error(`[${guild.name}] Failed to send to #${channel.name}:`, err.message);
      send(ws, { type: 'error', error: `Could not deliver to #${channel.name}.` });
    }
    return;
  }

  if (data.type === 'voiceJoin') {
    await joinVoice(ws, guild, data.channelId);
    return;
  }

  if (data.type === 'voiceLeave') {
    leaveVoice(ws);
  }
}

wss.on('connection', (ws) => {
  ws.id = 'web-' + crypto.randomBytes(6).toString('hex');
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      if (ws.voice && ws.canSpeak) ws.voice.pushWebAudio(ws, raw);
      return;
    }
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    handleWebMessage(ws, data).catch((err) => console.error('Web request failed:', err));
  });
  ws.on('close', () => leaveVoice(ws));
});

// ----------------------------------------------------------------- discord --

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const webhooks = new Map(); // channelId -> Webhook

function inviteUrl() {
  return client.generateInvite({
    scopes: ['bot', 'applications.commands'],
    permissions: BOT_PERMISSIONS,
  });
}

// The role whose permissions web users get: the server's chosen member role,
// or @everyone if none is set (or it was deleted).
function memberRole(guild) {
  const id = settingsFor(guild.id).memberRoleId;
  return (id && guild.roles.cache.get(id)) || guild.roles.everyone;
}

function memberCan(channel, perms) {
  return Boolean(channel.permissionsFor(memberRole(channel.guild))?.has(perms));
}

function botCan(channel, perms) {
  return Boolean(channel.permissionsFor(client.user)?.has(perms));
}

function canMembersSend(channel) {
  return memberCan(channel, PermissionFlagsBits.SendMessages) && botCan(channel, PermissionFlagsBits.ManageWebhooks);
}

// Text channels normal members can see and the bot can read.
function textChannels(guild) {
  return [...guild.channels.cache.values()].filter((c) => TEXT_TYPES.includes(c.type)
    && memberCan(c, PermissionFlagsBits.ViewChannel)
    && botCan(c, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]));
}

// Voice channels normal members can join and the bot can join and talk in.
function voiceChannels(guild) {
  if (!settingsFor(guild.id).voice) return [];
  return [...guild.channels.cache.values()].filter((c) => c.type === ChannelType.GuildVoice
    && memberCan(c, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])
    && botCan(c, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]));
}

// Same order as Discord: by category, text channels before voice channels.
function channelSortKey(c) {
  return [c.parent?.rawPosition ?? -1, c.type === ChannelType.GuildVoice ? 1 : 0, c.rawPosition];
}

function listChannels(guild) {
  return [...textChannels(guild), ...voiceChannels(guild)]
    .sort((a, b) => {
      const ka = channelSortKey(a);
      const kb = channelSortKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
    })
    .map((c) => c.type === ChannelType.GuildVoice
      ? { id: c.id, name: c.name, category: c.parent?.name ?? null, type: 'voice', canSpeak: memberCan(c, PermissionFlagsBits.Speak) }
      : { id: c.id, name: c.name, category: c.parent?.name ?? null, type: 'text', canSend: canMembersSend(c) });
}

function getTextChannel(guild, id) {
  return textChannels(guild).find((c) => c.id === id) ?? null;
}

function getVoiceChannel(guild, id) {
  return voiceChannels(guild).find((c) => c.id === id) ?? null;
}

function pushChannelList(guild) {
  if (!guild) return;
  sendToGuild(guild.id, { type: 'channels', voiceEnabled: settingsFor(guild.id).voice, channels: listChannels(guild) });
}

async function findOwnWebhook(channel) {
  if (webhooks.has(channel.id)) return webhooks.get(channel.id);
  const hooks = await channel.fetchWebhooks();
  const hook = hooks.find((h) => h.owner?.id === client.user.id
    && (h.name === WEBHOOK_NAME || OLD_WEBHOOK_NAMES.includes(h.name))) ?? null;
  if (hook) webhooks.set(channel.id, hook);
  return hook;
}

async function getWebhook(channel) {
  const hook = await findOwnWebhook(channel)
    ?? await channel.createWebhook({ name: WEBHOOK_NAME, reason: 'Webchat' });
  webhooks.set(channel.id, hook);
  return hook;
}

// Converts a Discord message to the web chat format. Messages from our own
// webhook are shown as the web user who sent them; other bots are skipped.
function toChatMessage(message, ownWebhookId, channelId = message.channelId) {
  const parts = [message.cleanContent];
  for (const att of message.attachments.values()) parts.push(att.url);
  const content = parts.filter(Boolean).join('\n');
  if (!content) return null;

  if (message.webhookId) {
    if (!ownWebhookId || message.webhookId !== ownWebhookId) return null;
    return {
      id: message.id, source: 'web', channelId,
      name: message.author.username, avatar: message.author.avatarURL({ size: 128 }),
      content, time: message.createdTimestamp,
    };
  }
  if (message.author.bot) return null;

  const name = message.member?.displayName ?? message.author.globalName ?? message.author.username;
  return {
    id: message.id,
    source: 'discord',
    channelId,
    thread: message.channel.isThread() ? message.channel.name : null,
    name: `[DISCORD] ${name}`,
    avatar: message.member?.displayAvatarURL({ size: 128 }) ?? message.author.displayAvatarURL({ size: 128 }),
    content,
    time: message.createdTimestamp,
  };
}

// Fetches the channel's recent messages from Discord the first time someone
// opens it, so the web chat shows messages from before the bot was added.
function loadHistory(channel) {
  if (loadedChannels.has(channel.id)) return Promise.resolve(history.get(channel.id) ?? []);
  if (loading.has(channel.id)) return loading.get(channel.id);

  const promise = (async () => {
    const own = await findOwnWebhook(channel).catch(() => null);
    const fetched = await channel.messages.fetch({ limit: HISTORY_LIMIT });
    const older = [...fetched.values()].map((m) => toChatMessage(m, own?.id)).filter(Boolean);
    const merged = new Map([...older, ...(history.get(channel.id) ?? [])].map((m) => [m.id, m]));
    const list = [...merged.values()].sort((a, b) => a.time - b.time).slice(-HISTORY_LIMIT);
    history.set(channel.id, list);
    loadedChannels.add(channel.id);
    return list;
  })().finally(() => loading.delete(channel.id));

  loading.set(channel.id, promise);
  return promise;
}

// Turn "@name" typed in the web chat into a real Discord mention when it
// matches a role or a member the bot has seen. @everyone / @here stay as-is.
function resolveMentions(guild, text) {
  return text.replace(/(^|\s)@([\w.\-]{2,32})/g, (match, lead, word) => {
    const lower = word.toLowerCase();
    if (lower === 'everyone' || lower === 'here') return match;
    const role = guild.roles.cache.find((r) => r.name.toLowerCase() === lower);
    if (role) return `${lead}<@&${role.id}>`;
    const member = guild.members.cache.find((m) =>
      m.user.username.toLowerCase() === lower || m.displayName.toLowerCase() === lower);
    if (member) return `${lead}<@${member.id}>`;
    return match;
  });
}

// Pings follow what a normal member may do in that channel: @everyone/@here
// and any role only with "Mention @everyone, @here, and All Roles"; otherwise
// only roles marked mentionable. User pings are always allowed.
function allowedMentionsFor(channel, content) {
  if (memberCan(channel, PermissionFlagsBits.MentionEveryone)) {
    return { parse: ['users', 'roles', 'everyone'] };
  }
  const roleIds = [...content.matchAll(/<@&(\d+)>/g)].map((m) => m[1])
    .filter((id) => channel.guild.roles.cache.get(id)?.mentionable);
  return { parse: ['users'], roles: [...new Set(roleIds)] };
}

async function sendToDiscord(channel, user, text) {
  const hook = await getWebhook(channel);
  const content = resolveMentions(channel.guild, text);
  return hook.send({
    content,
    username: webhookSafeName(user.name),
    avatarURL: user.avatar,
    allowedMentions: allowedMentionsFor(channel, content),
  });
}

// ------------------------------------------------------------------- voice --

// Who is in each voice channel: Discord members plus web users.
function voiceStates(guild) {
  const result = {};
  if (!guild || !settingsFor(guild.id).voice) return result;
  const ids = new Set(voiceChannels(guild).map((c) => c.id));
  for (const state of guild.voiceStates.cache.values()) {
    if (!ids.has(state.channelId) || state.id === client.user.id || !state.member) continue;
    (result[state.channelId] ??= []).push({
      id: state.id,
      name: state.member.displayName,
      avatar: state.member.displayAvatarURL({ size: 64 }),
      web: false,
    });
  }
  const room = rooms.get(guild.id);
  if (room) {
    for (const ws of room.web.keys()) {
      if (!ws.user) continue;
      (result[room.channel.id] ??= []).push({ id: ws.id, name: ws.user.name, avatar: ws.user.avatar, web: true });
    }
  }
  return result;
}

function pushVoiceStates(guild) {
  if (guild) sendToGuild(guild.id, { type: 'voiceStates', voiceStates: voiceStates(guild) });
}

async function joinVoice(ws, guild, channelId) {
  if (!settingsFor(guild.id).voice) {
    send(ws, { type: 'error', error: 'Voice chat is turned off for this server.' });
    return;
  }
  const channel = getVoiceChannel(guild, channelId);
  if (!channel) {
    send(ws, { type: 'error', error: 'That voice channel is not available.' });
    return;
  }
  if (ws.voice?.channel.id === channel.id) return;

  let room = rooms.get(guild.id);
  if (room && room.channel.id !== channel.id) {
    const others = [...room.web.keys()].filter((w) => w !== ws);
    if (others.length) {
      send(ws, {
        type: 'error',
        error: `Web users are already in 🔊 ${room.channel.name}. Only one voice channel per server can be used from the web at a time.`,
      });
      return;
    }
    leaveVoice(ws); // this was the last web user, so the old room closes
    room = null;
  }
  leaveVoice(ws);

  if (!room || room.destroyed) {
    room = new VoiceRoom(channel, { onSpeaking: handleSpeaking, onClosed: handleRoomClosed });
    rooms.set(guild.id, room);
    try {
      await room.ready();
    } catch {
      room.destroy('Could not connect to the voice channel.');
      send(ws, { type: 'error', error: 'Could not connect to the voice channel.' });
      return;
    }
  }
  if (room.destroyed || ws.readyState !== ws.OPEN || ws.guildId !== guild.id) {
    if (!room.web.size) room.destroy(); // nobody is left waiting for it
    return;
  }

  ws.canSpeak = memberCan(channel, PermissionFlagsBits.Speak);
  ws.voice = room;
  room.addWeb(ws);
  send(ws, { type: 'voiceJoined', channelId: channel.id, canSpeak: ws.canSpeak });
  pushVoiceStates(guild);
}

function leaveVoice(ws) {
  const room = ws.voice;
  if (!room) return;
  ws.voice = null;
  room.removeWeb(ws);
  if (!room.web.size) room.destroy();
  else pushVoiceStates(room.guild);
}

function handleSpeaking(room, ids) {
  sendToGuild(room.guild.id, { type: 'speaking', channelId: room.channel.id, ids });
}

function handleRoomClosed(room, reason) {
  if (rooms.get(room.guild.id) === room) rooms.delete(room.guild.id);
  for (const ws of room.web.keys()) {
    ws.voice = null;
    send(ws, { type: 'voiceLeft', reason: reason ?? null });
  }
  room.web.clear();
  sendToGuild(room.guild.id, { type: 'speaking', channelId: room.channel.id, ids: [] });
  pushVoiceStates(room.guild);
}

// ---------------------------------------------------------- slash commands --

const webchatCommand = new SlashCommandBuilder()
  .setName('webchat')
  .setDescription('Set up Webchat for this server')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(0) // servers only
  .addSubcommand((s) => s.setName('enable').setDescription('Turn Webchat on'))
  .addSubcommand((s) => s.setName('disable').setDescription('Turn Webchat off and disconnect everyone'))
  .addSubcommand((s) => s.setName('link').setDescription('Show the direct link to this server on Webchat'))
  .addSubcommand((s) => s.setName('status').setDescription('Show Webchat settings'))
  .addSubcommand((s) => s.setName('password').setDescription('Set or clear the Webchat password')
    .addStringOption((o) => o.setName('password').setDescription('Leave empty to remove the password').setMaxLength(100)))
  .addSubcommand((s) => s.setName('role').setDescription('Give web users the same channel access as this role')
    .addRoleOption((o) => o.setName('role').setDescription('Leave empty to use @everyone')));

const publicCommand = new SlashCommandBuilder()
  .setName('public')
  .setDescription('Show this server on the website\'s server list')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(0);

const privateCommand = new SlashCommandBuilder()
  .setName('private')
  .setDescription('Hide this server from the website\'s list (joinable by server ID only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(0);

const vcCommand = new SlashCommandBuilder()
  .setName('vc')
  .setDescription('Voice chat from the website')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(0)
  .addSubcommand((s) => s.setName('enable').setDescription('Let web users talk in voice channels'))
  .addSubcommand((s) => s.setName('disable').setDescription('Stop web users from using voice channels'));

const inviteCommand = new SlashCommandBuilder()
  .setName('invite')
  .setDescription('Get the link to add this bot to another server');

async function handleCommand(interaction) {
  const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

  if (interaction.commandName === 'invite') {
    return reply(`Add me to a server: ${inviteUrl()}`);
  }
  if (!interaction.inGuild()) return;
  const guild = interaction.guild;
  const settings = settingsFor(guild.id);

  if (interaction.commandName === 'public') {
    updateSettings(guild.id, { public: true });
    pushServerList();
    return reply(`**${guild.name}** now shows on the website's server list.`
      + (settings.enabled ? '' : '\nWebchat is off, though. Turn it on with `/webchat enable`.'));
  }
  if (interaction.commandName === 'private') {
    updateSettings(guild.id, { public: false });
    pushServerList();
    return reply(`**${guild.name}** is hidden from the server list. People can still join with the **+** button and this server ID: \`${guild.id}\``);
  }

  if (interaction.commandName === 'vc') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'enable') {
      updateSettings(guild.id, { voice: true });
      pushChannelList(guild);
      pushVoiceStates(guild);
      const me = guild.members.me.permissions;
      const missing = me.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])
        ? '' : '\n⚠️ I need the **Connect** and **Speak** permissions to use voice channels.';
      return reply(`Voice chat is **on**. Web users can now join voice channels that normal members can join.${missing}`);
    }
    updateSettings(guild.id, { voice: false });
    rooms.get(guild.id)?.destroy('Voice chat was turned off for this server.');
    pushChannelList(guild);
    return reply('Voice chat is **off**.');
  }

  if (interaction.commandName !== 'webchat') return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'enable') {
    updateSettings(guild.id, { enabled: true });
    pushServerList();
    const missing = guild.members.me.permissions.has(PermissionFlagsBits.ManageWebhooks)
      ? '' : '\n⚠️ I need the **Manage Webhooks** permission to post web messages here.';
    return reply(`Webchat is **on**. Direct link: ${chatLink(guild.id)}${missing}`);
  }
  if (sub === 'disable') {
    updateSettings(guild.id, { enabled: false });
    kickGuild(guild.id, 'Webchat was turned off for this server.');
    pushServerList();
    return reply('Webchat is **off**. Everyone connected was disconnected.');
  }
  if (sub === 'password') {
    const password = interaction.options.getString('password') ?? '';
    updateSettings(guild.id, { password });
    if (password) kickGuild(guild.id, 'The password changed. Join again with the new one.');
    pushServerList();
    return reply(password ? 'Password set. Connected web users must rejoin with it.' : 'Password removed.');
  }
  if (sub === 'role') {
    const role = interaction.options.getRole('role');
    updateSettings(guild.id, { memberRoleId: role && role.id !== guild.id ? role.id : null });
    pushChannelList(guild);
    pushVoiceStates(guild);
    return reply(`Web users now get the same channel access as **${memberRole(guild).name}**.`);
  }
  if (sub === 'link') {
    return reply(settings.enabled
      ? `Direct link: ${chatLink(guild.id)}`
      : 'Webchat is off. Turn it on with `/webchat enable`.');
  }
  if (sub === 'status') {
    const online = [...wss.clients].filter((ws) => ws.guildId === guild.id).length;
    const text = textChannels(guild);
    return reply([
      `**Webchat:** ${settings.enabled ? 'on' : 'off'}`,
      `**Server list:** ${settings.public ? 'public (shown)' : 'private (join by ID)'}`,
      `**Voice chat:** ${settings.voice ? `on (${voiceChannels(guild).length} voice channels)` : 'off'}`,
      `**Password:** ${settings.password ? 'set' : 'none'}`,
      `**Web users act as:** ${memberRole(guild).name}`,
      `**Text channels visible:** ${text.length} (can type in ${text.filter(canMembersSend).length})`,
      `**Web users online:** ${online}`,
      `**Server ID:** \`${guild.id}\``,
    ].join('\n'));
  }
}

// ------------------------------------------------------------ discord events --

client.once(Events.ClientReady, async (c) => {
  console.log(`Discord bot logged in as ${c.user.tag}, in ${c.guilds.cache.size} server(s)`);
  await c.application.commands.set([webchatCommand, publicCommand, privateCommand, vcCommand, inviteCommand]);
  console.log(`Invite link: ${inviteUrl()}`);
  console.log(`(also at ${CHAT_PAGE_URL}/invite)`);
  console.log(`Website: ${CHAT_PAGE_URL}`);
  if (/localhost|127\.0\.0\.1/.test(SERVER_URL)) {
    console.log('Note: serverUrl is local, so Discord cannot show web users\' profile pictures yet.');
  }
  pushServerList();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await handleCommand(interaction);
  } catch (err) {
    console.error('Command failed:', err);
    if (!interaction.replied) interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.on(Events.GuildCreate, (guild) => {
  console.log(`Added to server "${guild.name}" (${guild.id})`);
  pushServerList();
});
client.on(Events.GuildDelete, (guild) => {
  console.log(`Removed from server "${guild.name}" (${guild.id})`);
  rooms.get(guild.id)?.destroy('The bot was removed from this server.');
  kickGuild(guild.id, 'The bot was removed from this server.');
  pushServerList();
});
client.on(Events.GuildUpdate, () => pushServerList());

for (const evt of [Events.ChannelCreate, Events.ChannelDelete, Events.ChannelUpdate]) {
  client.on(evt, (channel) => {
    if (!channel.guild) return;
    pushChannelList(channel.guild);
    pushVoiceStates(channel.guild);
  });
}
client.on(Events.GuildRoleUpdate, (_, role) => pushChannelList(role.guild));
client.on(Events.GuildMemberUpdate, (_, member) => {
  if (member.id === client.user.id) pushChannelList(member.guild);
});
client.on(Events.ChannelDelete, (c) => {
  webhooks.delete(c.id);
  history.delete(c.id);
  loadedChannels.delete(c.id);
  const room = c.guild && rooms.get(c.guild.id);
  if (room?.channel.id === c.id) room.destroy('The voice channel was deleted.');
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guild = newState.guild;
  const room = rooms.get(guild.id);
  // Someone moved or disconnected the bot.
  if (room && newState.id === client.user.id && newState.channelId !== room.channel.id) {
    room.destroy('The bot was moved or disconnected from voice.');
  }
  pushVoiceStates(guild);
});

client.on(Events.MessageCreate, (message) => {
  if (!message.inGuild() || !settingsFor(message.guildId).enabled) return;
  if (message.webhookId) return; // our own relayed messages are broadcast when sent

  // Thread messages go under their parent channel, labelled with the thread name.
  const channelId = message.channel.isThread() ? message.channel.parentId : message.channelId;
  if (!getTextChannel(message.guild, channelId)) return;

  const msg = toChatMessage(message, null, channelId);
  if (msg) broadcast(message.guildId, msg);
});

client.login(TOKEN).catch((err) => {
  console.error('Discord login failed:', err.message, '(check discord.token in config.json)');
});
wss.on('error', () => {}); // the same error is reported by server below
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use. Change web.port in config.json, or close the bot if it's already running.`
    : err.message);
  process.exit(1);
});
server.listen(PORT, () => console.log(`Chat server listening on port ${PORT}`));
