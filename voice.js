// Webchat voice for one Discord voice channel.
// The bot joins the channel; everything said in Discord is mixed and streamed
// to the web users in the room, and everything web users say is mixed and
// played into Discord through the bot. Audio is 48kHz mono 16-bit PCM in
// 20ms frames (960 samples) between the server and browsers.

const {
  joinVoiceChannel, createAudioPlayer, createAudioResource, entersState,
  StreamType, NoSubscriberBehavior, EndBehaviorType, VoiceConnectionStatus,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { PassThrough } = require('stream');

const FRAME = 960;           // samples per 20ms at 48kHz
const FRAME_BYTES = FRAME * 2;
const FRAME_MS = 20;
const MAX_QUEUE = 10;        // frames buffered per speaker before old ones are dropped
const PRIME_FRAMES = 3;      // frames to buffer before a speaker starts playing (jitter)
const SPEAKING_HOLD = 10;    // ticks a speaker stays "speaking" after their last frame
const BURST_END = 15;        // ticks of web silence before the Discord stream is ended
const MAX_CLIENT_BUFFER = 64 * 1024;

function clamp16(v) {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

// Takes the next frame from a speaker's queue, waiting until a few frames
// have built up after a gap so network jitter doesn't cause crackling.
function takeFrame(src) {
  if (!src.primed) {
    if (src.queue.length < PRIME_FRAMES) return null;
    src.primed = true;
  }
  const frame = src.queue.shift();
  if (!frame) src.primed = false;
  return frame ?? null;
}

class VoiceRoom {
  constructor(channel, { onSpeaking, onClosed }) {
    this.channel = channel;
    this.guild = channel.guild;
    this.onSpeaking = onSpeaking;
    this.onClosed = onClosed;
    this.web = new Map();      // ws -> { id, queue, primed }
    this.discord = new Map();  // userId -> { queue, primed, ended, opus, decoder }
    this.lastHeard = new Map(); // speaker id -> tick
    this.speaking = new Set();
    this.ticks = 0;
    this.outStream = null;
    this.silentTicks = 0;
    this.destroyed = false;

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 50 },
    });
    this.player.on('error', (err) => console.error('Voice player error:', err.message));
    this.connection.subscribe(this.player);

    this.connection.receiver.speaking.on('start', (userId) => this.listenTo(userId));
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        this.destroy('The bot was disconnected from voice.');
      }
    });
    this.connection.on(VoiceConnectionStatus.Destroyed, () => this.destroy());

    this.next = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      if (now - this.next > 200) this.next = now; // fell far behind (e.g. sleep): skip ahead
      while (now >= this.next) {
        this.next += FRAME_MS;
        this.tick();
      }
    }, 5);
  }

  ready() {
    return entersState(this.connection, VoiceConnectionStatus.Ready, 15000);
  }

  addWeb(ws) {
    this.web.set(ws, { id: ws.id, queue: [], primed: false });
  }

  removeWeb(ws) {
    this.web.delete(ws);
  }

  pushWebAudio(ws, buf) {
    const src = this.web.get(ws);
    if (!src || buf.length !== FRAME_BYTES) return;
    const frame = new Int16Array(FRAME);
    for (let i = 0; i < FRAME; i++) frame[i] = buf.readInt16LE(i * 2);
    src.queue.push(frame);
    if (src.queue.length > MAX_QUEUE) src.queue.shift();
  }

  // Start decoding a Discord user's audio when they begin speaking.
  listenTo(userId) {
    if (this.destroyed || userId === this.guild.client.user.id || this.discord.has(userId)) return;
    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 300 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: FRAME });
    const src = { queue: [], primed: false, ended: false, pending: Buffer.alloc(0), opus, decoder };
    this.discord.set(userId, src);

    decoder.on('data', (pcm) => {
      // Stereo -> mono, cut into 20ms frames.
      src.pending = src.pending.length ? Buffer.concat([src.pending, pcm]) : pcm;
      const stereoFrameBytes = FRAME * 4;
      while (src.pending.length >= stereoFrameBytes) {
        const frame = new Int16Array(FRAME);
        for (let i = 0; i < FRAME; i++) {
          frame[i] = (src.pending.readInt16LE(i * 4) + src.pending.readInt16LE(i * 4 + 2)) >> 1;
        }
        src.pending = src.pending.subarray(stereoFrameBytes);
        src.queue.push(frame);
        if (src.queue.length > MAX_QUEUE) src.queue.shift();
      }
    });
    const end = () => { src.ended = true; };
    opus.on('end', end);
    opus.on('error', end);
    decoder.on('error', (err) => { console.error('Opus decode error:', err.message); end(); });
    opus.pipe(decoder);
  }

  tick() {
    if (this.destroyed) return;
    this.ticks++;
    const total = new Int32Array(FRAME);
    const webFrames = new Map();

    for (const [ws, src] of this.web) {
      const frame = takeFrame(src);
      if (!frame) continue;
      webFrames.set(ws, frame);
      this.lastHeard.set(src.id, this.ticks);
      for (let i = 0; i < FRAME; i++) total[i] += frame[i];
    }

    // Web users' voices -> Discord (before Discord audio is added to the mix).
    if (webFrames.size) this.sendToDiscord(total);
    else if (this.outStream && ++this.silentTicks > BURST_END) {
      this.outStream.end();
      this.outStream = null;
    }

    let discordHeard = false;
    for (const [userId, src] of this.discord) {
      const frame = takeFrame(src);
      if (frame) {
        discordHeard = true;
        this.lastHeard.set(userId, this.ticks);
        for (let i = 0; i < FRAME; i++) total[i] += frame[i];
      } else if (src.ended && !src.queue.length) {
        this.discord.delete(userId);
      }
    }

    // Everyone's audio -> each web user, minus their own voice.
    if (discordHeard || webFrames.size) {
      for (const [ws] of this.web) {
        const own = webFrames.get(ws);
        if (!discordHeard && webFrames.size === (own ? 1 : 0)) continue; // only themselves
        if (ws.readyState !== ws.OPEN || ws.bufferedAmount > MAX_CLIENT_BUFFER) continue;
        const out = Buffer.alloc(FRAME_BYTES);
        for (let i = 0; i < FRAME; i++) out.writeInt16LE(clamp16(total[i] - (own ? own[i] : 0)), i * 2);
        ws.send(out, { binary: true });
      }
    }

    this.updateSpeaking();
  }

  sendToDiscord(mix) {
    if (!this.outStream) {
      this.outStream = new PassThrough();
      this.player.play(createAudioResource(this.outStream, { inputType: StreamType.Raw }));
    }
    this.silentTicks = 0;
    const buf = Buffer.alloc(FRAME * 4); // 48kHz stereo s16le
    for (let i = 0; i < FRAME; i++) {
      const s = clamp16(mix[i]);
      buf.writeInt16LE(s, i * 4);
      buf.writeInt16LE(s, i * 4 + 2);
    }
    this.outStream.write(buf);
  }

  updateSpeaking() {
    const now = new Set();
    for (const [id, tick] of this.lastHeard) {
      if (this.ticks - tick < SPEAKING_HOLD) now.add(id);
      else this.lastHeard.delete(id);
    }
    const changed = now.size !== this.speaking.size || [...now].some((id) => !this.speaking.has(id));
    if (changed) {
      this.speaking = now;
      this.onSpeaking(this, [...now]);
    }
  }

  destroy(reason) {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.timer);
    this.outStream?.end();
    for (const src of this.discord.values()) {
      src.opus.destroy();
      src.decoder.destroy();
    }
    this.discord.clear();
    try { this.connection.destroy(); } catch {}
    this.onClosed(this, reason);
  }
}

module.exports = { VoiceRoom };
