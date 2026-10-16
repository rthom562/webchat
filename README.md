# Webchat

**⬇️ [Download the latest version](https://github.com/rthom562/webchat/releases/latest)** (get the `webchat-vX.Y.Z.zip` file under *Assets*)

A Discord bot plus a website that lets people chat in your Discord servers **without being on Discord**. Text and voice both work.

- **Website to Discord:** web users post into Discord channels under **their own name and profile picture**.
- **Discord to website:** Discord messages show on the website as **`[DISCORD] username`** with the person's Discord profile picture.
- **Whole servers:** the bot covers every channel a normal member can see, not just one. It also loads messages sent before the bot was added.
- **Works like Dyno:** anyone can add the bot to their server with an invite link, and it works right away.
- **Server list:** the website lists every **public** server the bot is in. **Private** servers can be joined by pasting their server ID.
- **Voice chat (optional):** web users can talk and listen in Discord voice channels from the browser.
- **Respects your server's permissions:** web users can only see, type, ping and talk where a normal member can.

---

## Contents

1. [What you need](#1-what-you-need)
2. [Create the Discord bot](#2-create-the-discord-bot)
3. [Install and configure](#3-install-and-configure)
4. [Start the bot](#4-start-the-bot)
5. [Add the bot to a server](#5-add-the-bot-to-a-server)
6. [Using the website](#6-using-the-website)
7. [Slash commands](#7-slash-commands)
8. [How permissions work](#8-how-permissions-work)
9. [Voice chat](#9-voice-chat)
10. [Letting other people use it (going online)](#10-letting-other-people-use-it-going-online)
11. [Configuration reference](#11-configuration-reference)
12. [Troubleshooting](#12-troubleshooting)
13. [Files in this folder](#13-files-in-this-folder)
14. [Limitations](#14-limitations)

---

## 1. What you need

- **A Windows, Mac or Linux computer** that stays on while the bot is running.
- **Node.js 22.12 or newer.** Download the **LTS** version from <https://nodejs.org> and install it with the default options.
  - To check your version, open a terminal and run `node --version`.
- **A Discord account** with **Manage Server** permission on the server you want to use.

---

## 2. Create the Discord bot

You only do this once.

1. Go to <https://discord.com/developers/applications> and sign in.
2. Click **New Application** (top right), give it a name (for example *Webchat*), accept the terms and click **Create**.
3. *(Optional)* On **General Information**, add an icon and description. This is what people see when they add the bot.
4. Click **Bot** in the left sidebar, then:
   - **Username / Icon:** set the bot's name and profile picture.
   - **Reset Token:** click it, confirm, and **copy the token**. Discord only shows it once. If you lose it, reset it again and update `config.json`.
   - **Privileged Gateway Intents:** turn on **Message Content Intent**. Without it, Discord messages reach the website blank.
   - **Public Bot:** leave it **on** if you want other people to be able to add your bot to their servers. Turn it **off** to keep it to yourself.
   - Click **Save Changes**.

> ⚠️ **Treat the token like a password.** Anyone who has it can control your bot. Never share it, put it in a screenshot or upload `config.json` anywhere. If it leaks, click **Reset Token** right away.

---

## 3. Install and configure

1. Unzip this folder somewhere permanent, such as your Desktop or Documents.
2. Open **`config.json`** in Notepad and replace `PASTE_BOT_TOKEN_HERE` with your bot token, keeping the quotes. If you forget, `run.bat` opens the file for you.

```json
{
  "discord": {
    "token": "PASTE_BOT_TOKEN_HERE"
  },
  "web": {
    "port": 3080,
    "chatPage": "./public",
    "chatPageUrl": "http://localhost:3080",
    "serverUrl": ""
  }
}
```

For now, leave the `web` settings as they are. [Section 11](#11-configuration-reference) explains them.

---

## 4. Start the bot

**On Windows:** double-click **`run.bat`**.

**On Mac or Linux:** open a terminal in this folder and run:

```
npm install
npm start
```

`run.bat` installs everything it needs the first time it runs, which takes a minute or so. When it's ready, you'll see something like:

```
Serving chat page from ...\public
Chat server listening on port 3080
Discord bot logged in as Webchat#1234, in 0 server(s)
Invite link: https://discord.com/api/oauth2/authorize?client_id=...
(also at http://localhost:3080/invite)
Website: http://localhost:3080
```

**Keep this window open.** The bot and the website only run while it's open. Close the window, or press **Ctrl+C**, to stop the bot.

---

## 5. Add the bot to a server

1. Open the **Invite link** shown in the window. You can also go to <http://localhost:3080/invite>, or use `/invite` in any server the bot is already in.
2. Pick the server, click **Continue** and then **Authorize**.
   - The link already asks for every permission the bot needs: View Channels, Send Messages, Read Message History, Manage Webhooks, Connect and Speak. Leave them all ticked.
3. That's it. The server is **on and public** straight away, so it shows on the website's server list.

Optional next steps, done in Discord by someone with **Manage Server** permission:

| Want to… | Run |
|---|---|
| Hide the server from the public list | `/private` |
| Require a password to join from the web | `/webchat password password:yourpassword` |
| Let web users use voice channels | `/vc enable` |
| Give web users the access of a "Member" role instead of @everyone | `/webchat role role:@Member` |
| See all the current settings | `/webchat status` |

If the slash commands don't show up, wait a minute and then restart Discord with **Ctrl+R**.

---

## 6. Using the website

Open **<http://localhost:3080>** in **Chrome or Edge**.

1. **Set up your profile.** The first time, you'll be asked for:
   - **A profile picture (required).** Click *Upload profile picture* and pick an image. It's cropped to a square automatically.
   - **A display name.** This is the name you'll appear under in Discord.

   You can change both later with the ⚙️ button at the bottom left.
2. **Pick a server** from the icons on the far left. A 🔒 on an icon means it's a private server you added yourself.
3. **Join a private server** with the green **+** at the bottom left. Paste the server's ID; admins can get it from `/webchat status` or `/private`.
4. **Chat.** Pick a text channel and type. Messages from Discord show as **`[DISCORD] name`**.
   - Type `@name` to ping someone or a role, if the server allows it (see [section 8](#8-how-permissions-work)).
   - Channels with a 🔒 are read-only for normal members, so you can read them but not type.
   - Opening a channel loads its last 100 messages, including ones sent before the bot was added.
5. **Voice.** If the server has `/vc enable` on, voice channels show with a 🔊.
   - Click one to join, and allow microphone access when the browser asks.
   - Use 🎙️ to mute and 📞 to disconnect, at the bottom of the channel list.
   - People talking get a green ring. Web users have a **WEB** tag.

**Direct links:** `http://localhost:3080/?server=SERVER_ID` opens a server straight away, even a private one. `/webchat link` gives you this link.

---

## 7. Slash commands

All commands except `/invite` need **Manage Server** permission. Server admins can change who can use them under **Server Settings → Integrations → (your bot)**.

| Command | What it does |
|---|---|
| `/public` | Show this server on the website's server list *(default)* |
| `/private` | Hide this server from the list. It can still be joined with the **+** button and the server ID. |
| `/webchat enable` | Turn Webchat on for this server *(default)* |
| `/webchat disable` | Turn Webchat off and disconnect every web user |
| `/webchat password [password]` | Set a password for joining from the web. Leave it empty to remove it. Changing it disconnects everyone. |
| `/webchat role [role]` | Web users get the same channel access as this role. Leave it empty to go back to `@everyone`. |
| `/webchat link` | Show the direct link to this server on the website |
| `/webchat status` | Show every setting, the server ID, and how many web users are online |
| `/vc enable` | Let web users talk in voice channels *(off by default)* |
| `/vc disable` | Turn web voice off and disconnect anyone in voice |
| `/invite` | Get the link to add the bot to another server *(anyone can use it)* |

Settings are saved per server in `data/servers.json`.

---

## 8. How permissions work

Web users are treated like a **normal member** of the server. By default that means the **`@everyone`** role. If your server gives chat access through a role such as "Member" or "Verified", run `/webchat role role:@Member` so web users get that role's access instead.

| Discord permission (for that role, in that channel) | What it controls on the website |
|---|---|
| **View Channel** | Whether the channel shows up at all. Private and staff channels stay hidden. |
| **Send Messages** | Whether web users can type there. If not, the channel shows a 🔒 and is read-only. |
| **Mention @everyone, @here, and All Roles** | Whether web users can ping `@everyone`, `@here` and any role. Without it, they can only ping users and roles marked *"Allow anyone to @mention this role"*. |
| **Connect** | Whether a voice channel shows up |
| **Speak** | Whether web users can talk in a voice channel, or only listen |

The bot itself also needs access to a channel (View Channel and Read Message History) for it to show up. If a channel is missing, check the bot's role permissions in that channel too.

---

## 9. Voice chat

Turn it on per server with **`/vc enable`**.

**How it works:**
1. When a web user clicks a voice channel, the bot joins it.
2. Everything Discord users say is streamed to the web users.
3. Everything web users say is played into Discord **through the bot**.
4. Web users also hear each other.
5. The bot leaves when the last web user disconnects.

**Things to know:**
- **Everyone talks through the bot:** Discord users see **the bot** talking, not each web user, because webhooks can't join voice channels. On the website, everyone shows individually.
- **One voice channel per server:** a bot can only be in one voice channel per server at a time, so all web users in a server share the same one.
- **Microphone needs a secure page:** browsers only allow the mic on `http://localhost` or an `https://` site. If you put the website online, it **must** use https (see section 10).
- **Browsers:** use Chrome or Edge. Firefox may not play voice correctly.
- **Echo:** it's best to wear headphones. Echo cancellation is on, but speakers can still cause echo.
- **Automatic mic gate:** the mic only sends audio while you're actually talking, so background silence isn't streamed.

---

## 10. Letting other people use it (going online)

Out of the box, the website is at `http://localhost:3080`, and **that only works on your own computer**. For other people to use it, the bot needs a public address. Pick one option:

### Option A: Cloudflare Tunnel (free, easiest, gives you https)
1. Install `cloudflared`: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>
2. With the bot running, open a second terminal and run:
   ```
   cloudflared tunnel --url http://localhost:3080
   ```
3. It prints an address like `https://random-words.trycloudflare.com`. Put it in `config.json`:
   ```json
   "chatPageUrl": "https://random-words.trycloudflare.com"
   ```
4. Restart the bot. Links from `/webchat link` now work for everyone, and voice works because the address is https.

> A quick tunnel's address changes every time you start it. For a permanent address, set up a named tunnel with your own domain. Cloudflare's docs explain how.

### Option B: ngrok
Same idea: run `ngrok http 3080` and use the `https://...` address it gives you as `chatPageUrl`.

### Option C: Port forwarding
Forward port **3080** on your router to this computer and use `http://YOUR-PUBLIC-IP:3080`. This has **no https**, so **voice won't work** for other people. Option A or B is recommended.

### Option D: A VPS (always online)
Rent a small Linux server, copy this folder to it, install Node.js 22+, and run `npm install` then `npm start`. A process manager like `pm2` keeps it running. Put a reverse proxy with https in front of it, such as Caddy or nginx with Let's Encrypt.

**Profile pictures in Discord:** Discord downloads web users' pictures from your bot's address. While that address is `localhost`, the website shows the pictures, but **Discord shows a default avatar** for web users. Once `chatPageUrl` (or `serverUrl`) is a public address, the real pictures show up in Discord too.

---

## 11. Configuration reference

### `config.json` (bot settings; keep it private)

| Setting | Meaning |
|---|---|
| `discord.token` | Your bot token (see [section 2](#2-create-the-discord-bot)) |
| `web.port` | The port the website and chat connection run on. Default `3080`. Change it if something else is using that port. |
| `web.chatPage` | The folder of the chat page to serve. Default `./public`. Set it to `""` if you host the page somewhere else (see below). |
| `web.chatPageUrl` | The public address of the chat page, used in the links the bot hands out (`/webchat link`, `/invite` page) |
| `web.serverUrl` | The public address of **this bot server**, used for profile picture links. Leave it empty to use `chatPageUrl`. You only need it if the chat page is hosted somewhere other than the bot. |

Restart the bot after changing `config.json`.

### `public/chat-config.js` (chat page settings; safe to upload)

| Setting | Meaning |
|---|---|
| `server` | Where the page connects to. Leave it empty when the bot serves the page itself, which is the default. Otherwise use the bot's address, such as `wss://webchat.example.com`. Use `wss://` for https sites and `ws://` for http sites. |
| `title` | The browser tab title. Leave it empty to use the server's name. |

### Hosting the chat page somewhere else
You can upload the `public` folder to any static host, such as GitHub Pages, Netlify or your own website:
1. Upload `index.html` and `chat-config.js`.
2. In the uploaded `chat-config.js`, set `server` to your bot's public `wss://` address.
3. In `config.json`, set `chatPageUrl` to the page's address, set `serverUrl` to the bot's public `https://` address, and optionally set `chatPage` to `""`.

Your token is in `config.json`, never in `public/`, so uploading the page is safe.

---

## 12. Troubleshooting

| Problem | Fix |
|---|---|
| `Node.js is not installed` | Install the LTS version from <https://nodejs.org>, then run `run.bat` again. |
| `Discord login failed: An invalid token was provided` | The token in `config.json` is wrong or was reset. Copy a new one from the Developer Portal (Bot → Reset Token). |
| `Used disallowed intents` | Turn on **Message Content Intent** in the Developer Portal (Bot page), then restart. |
| `Port 3080 is already in use` | The bot is probably already running in another window, so close it. Or change `web.port` in `config.json`, and `chatPageUrl` to match. |
| Slash commands don't show up | Wait a minute and restart Discord (Ctrl+R). Make sure you have Manage Server permission. |
| Server isn't on the website list | Run `/public` and check `/webchat status`. Webchat must be on. |
| A channel is missing on the website | Normal members (or the role set with `/webchat role`) can't see it, or the bot can't. Check channel permissions. |
| "Could not deliver to #channel" | The bot needs **Manage Webhooks** in that channel. |
| Discord messages appear blank | Turn on **Message Content Intent** (Developer Portal → Bot). |
| Web users have a default avatar in Discord | Expected while running on `localhost`. See [section 10](#10-letting-other-people-use-it-going-online). |
| Can't talk in voice / mic blocked | Allow the microphone in the browser (click the lock icon in the address bar). The site must be `localhost` or `https://`. Also check that the channel lets normal members **Speak**. |
| "Web users are already in 🔊 …" | Only one voice channel per server can be used from the web at a time. Join that one, or wait until it's empty. |
| Voice is choppy | Usually a slow connection. Wired internet helps. |

---

## 13. Files in this folder

| File | What it is |
|---|---|
| `run.bat` | Double-click to start the bot on Windows |
| `server.js` | The bot and the chat server |
| `voice.js` | Webchat voice |
| `public/index.html` | The chat website |
| `public/chat-config.js` | Chat page settings |
| `config.json` | Your settings and bot token. Never share it once your token is in it. |
| `data/servers.json` | Per-server settings, created automatically |
| `data/avatars/` | Uploaded profile pictures, created automatically |
| `package.json` | The list of libraries the bot uses |

---

## 14. Limitations

- **Message history while the bot is off:** the bot only relays messages while it's running. When someone opens a channel, the last 100 messages are loaded from Discord, so anything missed while it was off still shows up.
- **Web users' pings in Discord:** web users can only `@name` members the bot has seen talk since it started, plus any role.
- **Edits, deletes, reactions, embeds and stickers** aren't mirrored. Attachments from Discord show as links.
- **Threads:** messages from threads show inside their parent channel, labelled with the thread name. Web users can't post into threads.
- **Voice:** see [section 9](#9-voice-chat). Everyone speaks through the bot, and there's one voice channel per server.
