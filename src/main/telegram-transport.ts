import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { shell, dialog } from 'electron';
import { TelegramClient, Api, helpers } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { EditedMessage, EditedMessageEvent } from 'telegram/events/EditedMessage';
import type {
  Profile, RemoteChatMessage, RemoteChatState, RemoteChatEvent,
} from '../shared/types';
import { loadSettings, saveSettings } from './config-loader';

// ── Hermes-over-Telegram transport ────────────────────────────────────
//
// Vyb side of the remote-agent chat pane: a GramJS (MTProto) client logged
// into the USER's Telegram account, conversing with a Hermes gateway's bot
// chat. Runs entirely in the main process — the renderer only sees typed
// IPC (login steps, history, send) and a stream of chat events.
//
// Streaming model: Hermes gateways stream replies by editing the bot
// message in place. We forward new-message and edit events as they come
// and run a per-profile settle timer — no edits for SETTLE_MS means the
// turn is done → 'settled' event + synthesized profile status 'ready'.
// While a turn is in flight the profile status is 'working', so the
// sidebar flames behave exactly like PTY agents.

const SETTLE_MS = 3000;

interface Binding {
  profileId: string;
  botUsername: string;   // without '@' — a private bot OR a forum group
  botId?: string;        // resolved numeric peer id (string form), cached
  /** True when the peer is a forum supergroup (topics available). */
  isForum?: boolean;
  /** True when topic-scoped messaging applies: forum supergroups AND
   * private bot chats with Telegram's newer DM topics (detected from
   * message history — see topics()). Drives send/history/event tagging. */
  hasTopics?: boolean;
  /** Concrete entity when the binding was resolved via the dialog-title
   * fallback (private groups have no @username to resolve). */
  resolvedEntity?: unknown;
}

type StatusSender = (profileId: string, status: 'working' | 'ready') => void;
type EventSender = (event: RemoteChatEvent) => void;

export class TelegramTransport {
  private client: TelegramClient | null = null;
  private state: RemoteChatState = { state: 'unconfigured' };
  private bindings = new Map<string, Binding>(); // by profileId
  private settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastAgentMsgId = new Map<string, string>(); // profileId → streaming msg id
  // Login-flow bridges: client.start()'s callbacks await these resolvers,
  // which the LOGIN_CODE / LOGIN_PASSWORD IPC calls fulfil.
  private codeResolver: ((code: string) => void) | null = null;
  private passwordResolver: ((pw: string) => void) | null = null;
  private loginInFlight = false;

  constructor(
    private sendEvent: EventSender,
    private sendStatus: StatusSender,
  ) {
    const t = loadSettings().telegram;
    this.state = t?.apiId && t?.apiHash
      ? { state: 'disconnected' }
      : { state: 'unconfigured' };
    // A persisted session means the user already logged in — reconnect
    // eagerly (slightly deferred so app startup isn't gated on network)
    // instead of waiting for the chat pane to poke us. Failures just
    // leave the state 'disconnected' with the reason; nothing is lost.
    if (t?.session) {
      setTimeout(() => {
        void this.ensureConnected().catch((): undefined => undefined);
      }, 1500);
    }
  }

  getState(): RemoteChatState {
    return this.state;
  }

  private setState(next: RemoteChatState): void {
    this.state = next;
    this.sendEvent({ type: 'state', state: next });
  }

  /** Register a profile's bot binding (called on demand from history/send). */
  private bind(profile: Profile): Binding | null {
    const remote = profile.remoteAgent;
    if (!remote || remote.kind !== 'hermes-telegram' || !remote.botUsername) return null;
    let b = this.bindings.get(profile.id);
    if (!b || b.botUsername !== remote.botUsername) {
      b = { profileId: profile.id, botUsername: remote.botUsername.replace(/^@/, ''), botId: remote.chatId };
      this.bindings.set(profile.id, b);
    }
    return b;
  }

  // ── Connection ──────────────────────────────────────────────────

  /** Connect with the persisted session. No-op when already connected. */
  private async ensureConnected(): Promise<TelegramClient> {
    if (this.client?.connected) return this.client;
    const t = loadSettings().telegram;
    if (!t?.apiId || !t?.apiHash) {
      this.setState({ state: 'unconfigured' });
      throw new Error('Telegram is not configured');
    }
    if (!t.session) {
      this.setState({ state: 'disconnected', error: 'not logged in' });
      throw new Error('Telegram login required');
    }
    this.setState({ state: 'connecting' });
    const client = new TelegramClient(new StringSession(t.session), t.apiId, t.apiHash, {
      connectionRetries: 3,
    });
    await client.connect();
    if (!(await client.checkAuthorization())) {
      this.setState({ state: 'disconnected', error: 'session expired — log in again' });
      throw new Error('Telegram session expired');
    }
    this.client = client;
    this.attachHandlers(client);
    const me = await client.getMe().catch((): null => null);
    const username = me && 'username' in me ? (me.username ?? undefined) : undefined;
    this.setState({ state: 'connected', user: username });
    return client;
  }

  private attachHandlers(client: TelegramClient): void {
    client.addEventHandler((e: NewMessageEvent) => this.onMessage(e.message, false), new NewMessage({}));
    client.addEventHandler((e: EditedMessageEvent) => this.onMessage(e.message, true), new EditedMessage({}));
  }

  // ── Login flow (IPC-driven client.start) ────────────────────────

  async loginStart(apiId: number, apiHash: string, phone: string): Promise<RemoteChatState> {
    if (this.loginInFlight) return this.state;
    this.loginInFlight = true;
    // Persist creds immediately so a later relaunch can reconnect.
    const settings = loadSettings();
    saveSettings({ ...settings, telegram: { apiId, apiHash, session: settings.telegram?.session } });

    const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
    this.setState({ state: 'connecting' });
    // start() drives the whole auth conversation; our callbacks block on
    // resolvers that the LOGIN_CODE / LOGIN_PASSWORD IPC calls fulfil.
    client.start({
      phoneNumber: async () => phone,
      phoneCode: async () => {
        this.setState({ state: 'awaiting-code' });
        return await new Promise<string>((resolve) => { this.codeResolver = resolve; });
      },
      password: async () => {
        this.setState({ state: 'awaiting-password' });
        return await new Promise<string>((resolve) => { this.passwordResolver = resolve; });
      },
      onError: (err: Error) => {
        this.setState({ state: 'disconnected', error: err.message });
      },
    }).then(async () => {
      // Logged in — persist the session string and go live.
      const s = loadSettings();
      saveSettings({
        ...s,
        telegram: { apiId, apiHash, session: (client.session as StringSession).save() },
      });
      this.client = client;
      this.attachHandlers(client);
      const me = await client.getMe().catch((): null => null);
      const username = me && 'username' in me ? (me.username ?? undefined) : undefined;
      this.setState({ state: 'connected', user: username });
    }).catch((err: Error) => {
      this.setState({ state: 'disconnected', error: err.message });
    }).finally(() => {
      this.loginInFlight = false;
      this.codeResolver = null;
      this.passwordResolver = null;
    });
    return this.state;
  }

  submitCode(code: string): void {
    this.codeResolver?.(code.trim());
    this.codeResolver = null;
    this.setState({ state: 'connecting' });
  }

  submitPassword(password: string): void {
    this.passwordResolver?.(password);
    this.passwordResolver = null;
    this.setState({ state: 'connecting' });
  }

  async logout(): Promise<void> {
    try { await this.client?.disconnect(); } catch { /* best-effort */ }
    this.client = null;
    const s = loadSettings();
    if (s.telegram) {
      saveSettings({ ...s, telegram: { apiId: s.telegram.apiId, apiHash: s.telegram.apiHash } });
    }
    this.setState({ state: 'disconnected' });
  }

  // ── Chat ────────────────────────────────────────────────────────

  /** Resolve (and cache) the peer for a binding. The identifier may be a
   * private bot's @username OR a forum group the bot lives in — forum
   * groups unlock topics (one discussion per topic). Private groups have
   * no @username, so when username resolution fails we fall back to
   * matching a dialog by TITLE (case-insensitive) — the user can simply
   * enter the group's name. */
  private async resolveBot(client: TelegramClient, b: Binding): Promise<string> {
    if (b.botId && b.isForum !== undefined) return b.botId;
    let entity: { id: { toString(): string }; className?: string; forum?: boolean };
    try {
      entity = await client.getEntity(b.botUsername) as typeof entity;
    } catch {
      // Private groups have no @username — match the user's dialog list by
      // TITLE, or by numeric chat id (Hermes' config uses the -100… form).
      const wanted = b.botUsername.toLowerCase();
      const wantedId = wanted.replace(/^-100/, '').replace(/^-/, '');
      const dialogs = await client.getDialogs({ limit: 200 });
      const hit = dialogs.find((d) => {
        if ((d.title ?? '').toLowerCase() === wanted) return true;
        const did = d.id != null ? String(d.id).replace(/^-100/, '').replace(/^-/, '') : '';
        return did !== '' && did === wantedId;
      });
      if (!hit?.entity) throw new Error(`No Telegram chat named "${b.botUsername}" found (checked usernames, dialog titles, and chat ids)`);
      entity = hit.entity as unknown as typeof entity;
      // Bind future sends/history to the concrete entity, not the name.
      b.resolvedEntity = hit.entity;
    }
    b.botId = String(entity.id);
    b.isForum = entity.className === 'Channel' && entity.forum === true;
    return b.botId;
  }

  /** The peer to pass to send/getMessages: the concrete entity when the
   * binding was resolved via dialog-title fallback, else the username. */
  private peerOf(b: Binding): unknown {
    return b.resolvedEntity ?? b.botUsername;
  }

  async history(profile: Profile, limit = 50, topicId?: string): Promise<RemoteChatMessage[]> {
    const b = this.bind(profile);
    if (!b) return [];
    const client = await this.ensureConnected();
    await this.resolveBot(client, b);
    // Topic scoping:
    //  • forum supergroups fetch a topic via the reply-thread API (topic
    //    id = thread root message id); General ('1') has no thread.
    //  • bot-DM topics have no thread API at our layer — fetch plain
    //    history wide and filter by each message's thread marker.
    const topical = b.isForum || b.hasTopics;
    const isGeneral = topicId === '1';
    const useThread = b.isForum && topicId && !isGeneral;
    const needsFilter = topical && !!topicId && !useThread;
    const msgs = await client.getMessages(this.peerOf(b) as never, {
      limit: needsFilter ? limit * 3 : limit,
      ...(useThread ? { replyTo: Number(topicId) } : {}),
    });
    const out: RemoteChatMessage[] = [];
    for (const m of msgs) {
      // Skip service messages (topic created/renamed etc.) — they'd
      // render as noise rows.
      if ((m as { action?: unknown }).action) continue;
      const mTopic = topical ? topicOf(m) : undefined;
      if (needsFilter && mTopic !== topicId) continue;
      out.push({
        id: String(m.id),
        role: m.out ? 'user' : 'agent',
        text: textOf(m as { message?: string; media?: unknown; entities?: TgEntity[] }),
        date: (m.date ?? 0) * 1000,
        topicId: mTopic,
        media: mediaOf(m),
        buttons: buttonsOf(m as { replyMarkup?: unknown }),
      });
    }
    return out.reverse(); // chronological
  }

  async send(profile: Profile, text: string, topicId?: string): Promise<{ ok: boolean; error?: string }> {
    const b = this.bind(profile);
    if (!b) return { ok: false, error: 'profile has no Telegram binding' };
    try {
      const client = await this.ensureConnected();
      await this.resolveBot(client, b);
      // Posting into a topic = replying to its thread root (works for
      // forum groups AND bot-DM topics). General ('1') and plain private
      // chats send without a thread. NOTE: a plain (non-reply) send does
      // NOT start a new thread — Hermes treats the lobby as overflow and
      // reroutes it to the last active topic. New DM topics are created
      // by the BOT via createTopic() (Bot API, needs the bot token).
      const replyTo = (b.isForum || b.hasTopics) && topicId && topicId !== '1'
        ? Number(topicId)
        : undefined;
      const sent = await client.sendMessage(this.peerOf(b) as never, { message: text, ...(replyTo ? { replyTo } : {}) });
      // Telegram does NOT echo this client's own sends through the update
      // loop (they come back as the RPC result instead), so emit the chat
      // event ourselves — otherwise the user's message only appears after
      // a history reload. The pane dedupes by id if an echo ever arrives.
      this.emitOwnMessage(b, sent, text, topicId);
      // Turn started: the agent is (about to be) working. The settle timer
      // arms on the bot's first reply; arm a generous one now too so a
      // never-answered send doesn't strand the status on 'working'.
      this.sendStatus(profile.id, 'working');
      this.armSettle(profile.id, 60_000);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Emit a chat event for a message THIS client just sent. `sent` is the
   * Message returned by sendMessage/sendFile; some paths return a sparse
   * object (UpdateShortSentMessage-derived), so fall back to the known
   * text/topic from the send call. */
  private emitOwnMessage(
    b: Binding,
    sent: { id?: number; message?: string; media?: unknown; date?: number; replyTo?: unknown } | undefined,
    fallbackText: string | undefined,
    topicId: string | undefined,
  ): void {
    if (!sent?.id) return;
    const text = sent.message || fallbackText || textOf(sent as { message?: string; media?: unknown });
    const topical = b.isForum || b.hasTopics;
    const msg: RemoteChatMessage = {
      id: String(sent.id),
      role: 'user',
      text,
      date: sent.date ? sent.date * 1000 : Date.now(),
      topicId: topical ? (sent.replyTo ? topicOf(sent as { replyTo?: unknown }) : (topicId ?? '1')) : undefined,
      media: mediaOf(sent),
    };
    this.sendEvent({ type: 'message', profileId: b.profileId, message: msg });
  }

  // Downloaded media, cached per chat+message so repeat opens are instant.
  private mediaCache = new Map<string, { path: string; name: string; kind: 'photo' | 'voice' | 'sticker' | 'file' }>();

  /** Download a message's attachment to the temp cache (idempotent).
   * Returns the on-disk path plus a clean display filename. Throws with a
   * user-facing message on failure. */
  private async ensureMediaDownloaded(profile: Profile, messageId: string): Promise<{ path: string; name: string; kind: 'photo' | 'voice' | 'sticker' | 'file' }> {
    const b = this.bind(profile);
    if (!b) throw new Error('profile has no Telegram binding');
    const client = await this.ensureConnected();
    await this.resolveBot(client, b);
    const cacheKey = `${b.botId}:${messageId}`;
    const cached = this.mediaCache.get(cacheKey);
    if (cached && fs.existsSync(cached.path)) return cached;

    const [msg] = await client.getMessages(this.peerOf(b) as never, { ids: [Number(messageId)] });
    if (!msg || !(msg as { media?: unknown }).media) throw new Error('message has no media');
    const meta = mediaOf(msg) ?? { name: `media-${messageId}`, kind: 'file' as const };
    let fname = meta.name.replace(/[/\\:]/g, '_');
    if (meta.kind === 'photo' && !/\.[a-z0-9]{2,4}$/i.test(fname)) fname = `photo-${messageId}.jpg`;
    if (meta.kind === 'voice' && !/\.[a-z0-9]{2,4}$/i.test(fname)) fname = `voice-${messageId}.ogg`;
    if (meta.kind === 'sticker' && !/\.[a-z0-9]{2,4}$/i.test(fname)) fname = `sticker-${messageId}.webp`;
    const dir = path.join(os.tmpdir(), 'vyb-telegram-media');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${messageId}-${fname}`);
    const buf = await client.downloadMedia(msg as never, {});
    if (!buf || buf.length === 0) throw new Error('download failed');
    fs.writeFileSync(target, buf as Buffer);
    const entry = { path: target, name: fname, kind: meta.kind };
    this.mediaCache.set(cacheKey, entry);
    return entry;
  }

  /** Download + open with the OS default app (falls back to revealing in
   * Finder/Explorer when nothing is registered for the type). */
  async openMedia(profile: Profile, messageId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const media = await this.ensureMediaDownloaded(profile, messageId);
      const openErr = await shell.openPath(media.path);
      if (openErr) shell.showItemInFolder(media.path); // no app registered — reveal instead
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Download for the in-app preview dialog: returns the temp path (the
   * renderer previews it via the local-file:// protocol). */
  async fetchMedia(profile: Profile, messageId: string): Promise<{ ok: true; path: string; name: string; kind: string } | { ok: false; error: string }> {
    try {
      const media = await this.ensureMediaDownloaded(profile, messageId);
      return { ok: true, ...media };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Save the attachment via the OS save dialog, defaulting into
   * `defaultDir` (the agent profile's working directory). */
  async saveMedia(profile: Profile, messageId: string, defaultDir: string): Promise<{ ok: boolean; savedTo?: string; canceled?: boolean; error?: string }> {
    try {
      const media = await this.ensureMediaDownloaded(profile, messageId);
      const res = await dialog.showSaveDialog({
        defaultPath: path.join(defaultDir, media.name),
        buttonLabel: 'Save',
      });
      if (res.canceled || !res.filePath) return { ok: true, canceled: true };
      fs.copyFileSync(media.path, res.filePath);
      return { ok: true, savedTo: res.filePath };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Tap an inline keyboard button (e.g. Hermes' Approve Once / Cancel).
   * Telegram answers via GetBotCallbackAnswer; the bot then usually edits
   * the message (edit event refreshes the pane). */
  async pressButton(profile: Profile, messageId: string, dataBase64: string): Promise<{ ok: boolean; error?: string; answer?: string }> {
    const b = this.bind(profile);
    if (!b) return { ok: false, error: 'profile has no Telegram binding' };
    try {
      const client = await this.ensureConnected();
      await this.resolveBot(client, b);
      const res = await client.invoke(new Api.messages.GetBotCallbackAnswer({
        peer: await client.getInputEntity(this.peerOf(b) as never),
        msgId: Number(messageId),
        data: Buffer.from(dataBase64, 'base64'),
      }));
      const answer = (res as { message?: string }).message;
      // Button taps usually kick off agent work (approvals) — reflect it.
      this.sendStatus(profile.id, 'working');
      this.armSettle(profile.id, 60_000);
      return { ok: true, answer };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Upload a local file to the chat (drag-and-drop). Lands in the given
   * topic's thread like a text message would. */
  async sendFile(profile: Profile, filePath: string, topicId?: string): Promise<{ ok: boolean; error?: string }> {
    const b = this.bind(profile);
    if (!b) return { ok: false, error: 'profile has no Telegram binding' };
    try {
      const client = await this.ensureConnected();
      await this.resolveBot(client, b);
      const replyTo = (b.isForum || b.hasTopics) && topicId && topicId !== '1'
        ? Number(topicId)
        : undefined;
      const sent = await client.sendFile(this.peerOf(b) as never, {
        file: filePath,
        forceDocument: false, // let Telegram pick photo/document rendering
        ...(replyTo ? { replyTo } : {}),
      });
      // Own sends aren't echoed via the update loop — emit directly (see send()).
      this.emitOwnMessage(b, sent, undefined, topicId);
      this.sendStatus(profile.id, 'working');
      this.armSettle(profile.id, 60_000);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** List forum topics (each is a separate Hermes discussion). Plain
   * private-chat bindings return isForum:false — the pane hides topics. */
  async topics(profile: Profile): Promise<import('../shared/types').RemoteChatTopics> {
    const b = this.bind(profile);
    if (!b) return { isForum: false, topics: [], reason: 'profile has no Telegram binding' };
    const client = await this.ensureConnected();
    await this.resolveBot(client, b);

    // Forum supergroup: the real topics API.
    if (b.isForum) {
      b.hasTopics = true;
      const res = await client.invoke(new Api.channels.GetForumTopics({
        channel: await client.getInputEntity(this.peerOf(b) as never),
        offsetDate: 0, offsetId: 0, offsetTopic: 0, limit: 100,
      }));
      // Map topMessage → date so "last active" is real activity, not
      // topic-creation time.
      const msgDates = new Map<number, number>();
      for (const m of res.messages ?? []) {
        const mm = m as { id?: number; date?: number };
        if (mm.id != null && mm.date != null) msgDates.set(mm.id, mm.date * 1000);
      }
      const topics = (res.topics ?? [])
        .filter((t): t is InstanceType<typeof Api.ForumTopic> => t.className === 'ForumTopic')
        .map((t) => ({
          id: String(t.id),
          title: t.title,
          lastActive: msgDates.get(t.topMessage) ?? (t.date ? t.date * 1000 : 0),
        }))
        .sort((a, b2) => b2.lastActive - a.lastActive);
      return { isForum: true, topics, canCreate: true };
    }

    // Private bot chat: Telegram's newer DM topics have no listing API at
    // our MTProto layer, but every topic leaves traces in the history —
    // service messages (topic created/renamed, carrying the title) and
    // thread markers on ordinary messages. Reconstruct the list from the
    // last 200 messages. Titles fall back to "Topic <id>" when the
    // creating service message is older than the scan window.
    const msgs = await client.getMessages(this.peerOf(b) as never, { limit: 200 });
    const found = new Map<string, { title?: string; lastActive: number }>();
    let sawTopicMarkers = false;
    for (const m of msgs) {
      const svc = m as { action?: { className?: string; title?: string }; id: number; date?: number };
      const date = (m.date ?? 0) * 1000;
      let tid: string | null = null;
      if (svc.action?.className === 'MessageActionTopicCreate') {
        tid = String(svc.id);
        sawTopicMarkers = true;
        const e = found.get(tid) ?? { lastActive: 0 };
        e.title = svc.action.title ?? e.title;
        e.lastActive = Math.max(e.lastActive, date);
        found.set(tid, e);
        continue;
      }
      if (svc.action?.className === 'MessageActionTopicEdit') {
        tid = topicOf(m);
        sawTopicMarkers = true;
        const e = found.get(tid) ?? { lastActive: 0 };
        if (svc.action.title) e.title = svc.action.title;
        e.lastActive = Math.max(e.lastActive, date);
        found.set(tid, e);
        continue;
      }
      const r = (m as { replyTo?: { forumTopic?: boolean } }).replyTo;
      tid = topicOf(m);
      if (r?.forumTopic || tid !== '1') sawTopicMarkers = true;
      const e = found.get(tid) ?? { lastActive: 0 };
      e.lastActive = Math.max(e.lastActive, date);
      found.set(tid, e);
    }

    if (!sawTopicMarkers) {
      // History is inconclusive (fresh chat, or an old one from before
      // topic mode). With the bot token we can ask authoritatively:
      // getMe.has_topics_enabled says whether this bot's DMs use topics.
      const enabled = await this.botTopicsEnabled(profile.remoteAgent?.botToken);
      if (enabled === true) {
        b.hasTopics = true;
        return {
          isForum: true,
          topics: [{ id: '1', title: 'General', lastActive: 0 }],
          canCreate: true,
        };
      }
      if (enabled === false) {
        // getMe reflects only the BOT-GLOBAL topic mode. The user can
        // still enable topics PER-CHAT (bot profile → Topics) and no API
        // exposes that state — so this is "probably off", not definitive.
        // The pane shows the splash but keeps + available (with the bot
        // token) as the probe: createForumTopic succeeds iff the chat
        // really has topics.
        return { isForum: false, topics: [], topicsOff: true, canCreate: true };
      }
      return {
        isForum: false,
        topics: [],
        reason: 'no topics found in this chat yet — if the bot uses topics, send a message in one from Telegram first, or add the bot token to the profile so Vyb can check',
      };
    }

    b.hasTopics = true;
    const topics = [...found.entries()]
      .map(([id, e]) => ({
        id,
        title: e.title ?? (id === '1' ? 'General' : `Topic ${id}`),
        lastActive: e.lastActive,
      }))
      .sort((a, b2) => b2.lastActive - a.lastActive);
    // DM-topic creation isn't exposed at our protocol layer (user side),
    // but the BOT can do it via the Bot API — possible when the profile
    // carries the bot's token (the user runs Hermes, so they own it).
    return { isForum: true, topics, canCreate: !!profile.remoteAgent?.botToken };
  }

  // getMe.has_topics_enabled per bot token, cached briefly so topic
  // refreshes don't hammer the Bot API. null = couldn't determine
  // (no token, or the call failed).
  private topicsEnabledCache = new Map<string, { value: boolean; ts: number }>();

  /** Ask the Bot API whether this bot has DM topic mode enabled
   * (User.has_topics_enabled, Bot API 9.3+). Returns null when there is
   * no token or the check fails — callers fall back to heuristics. */
  private async botTopicsEnabled(botToken: string | undefined): Promise<boolean | null> {
    const token = botToken?.trim();
    if (!token) return null;
    const cached = this.topicsEnabledCache.get(token);
    if (cached && Date.now() - cached.ts < 60_000) return cached.value;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const body = await res.json() as { ok: boolean; result?: { has_topics_enabled?: boolean } };
      if (!body.ok) return null;
      const value = body.result?.has_topics_enabled === true;
      this.topicsEnabledCache.set(token, { value, ts: Date.now() });
      return value;
    } catch {
      return null;
    }
  }

  /** Create a new topic (a fresh discussion). Forum groups use the
   * user-side RPC; bot-DM topics can only be created BY THE BOT, so
   * those go through the Bot API with the profile's bot token. */
  async createTopic(profile: Profile, title: string): Promise<import('../shared/types').RemoteChatTopic | { error: string }> {
    const b = this.bind(profile);
    if (!b) return { error: 'profile has no Telegram binding' };
    try {
      const client = await this.ensureConnected();
      await this.resolveBot(client, b);
      if (!b.isForum) {
        const token = profile.remoteAgent?.botToken?.trim();
        if (!token) return { error: 'this chat has no topics (not a forum group)' };
        // Bot API createForumTopic on the DM: chat_id is OUR user id
        // (the DM chat, seen from the bot's side). Returns the new
        // message_thread_id, which doubles as the topic id we post to.
        const me = await client.getMe();
        const res = await fetch(`https://api.telegram.org/bot${token}/createForumTopic`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: Number(me.id), name: title }),
        });
        const body = await res.json() as { ok: boolean; description?: string; result?: { message_thread_id?: number } };
        if (!body.ok || !body.result?.message_thread_id) {
          const desc = body.description ?? `HTTP ${res.status}`;
          // Most common failure: the BOT's topic mode is off (a BotFather
          // setting — the per-chat threads toggle isn't enough).
          return {
            error: /not a forum/i.test(desc)
              ? 'the bot\'s Topic mode is off — enable it in @BotFather (/mybots → Bot Settings → Topics), then try again'
              : `bot API: ${desc}`,
          };
        }
        b.hasTopics = true;
        return { id: String(body.result.message_thread_id), title, lastActive: Date.now() };
      }
      await client.invoke(new Api.channels.CreateForumTopic({
        channel: await client.getInputEntity(this.peerOf(b) as never),
        title,
        randomId: helpers.generateRandomBigInt(),
      }));
      // The new topic id lives in the returned updates blob — rather than
      // dissect it, re-list and match by title (newest wins).
      const listed = await this.topics(profile);
      const created = listed.topics.find((t) => t.title === title);
      return created ?? { error: 'topic created but not found in listing' };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  // ── Incoming updates ────────────────────────────────────────────

  private onMessage(m: { id: number; out?: boolean; message?: string; date?: number; senderId?: unknown; peerId?: unknown; replyTo?: unknown; media?: unknown }, isEdit: boolean): void {
    // Match the message's peer (private bot OR forum group) against bindings.
    const peerId = extractPeerId(m.peerId) ?? extractPeerId(m.senderId);
    if (!peerId) return;
    for (const b of this.bindings.values()) {
      if (b.botId !== peerId) continue;
      const msg: RemoteChatMessage = {
        id: String(m.id),
        role: m.out ? 'user' : 'agent',
        text: textOf(m as { message?: string; media?: unknown; entities?: TgEntity[] }),
        date: (m.date ?? Math.floor(Date.now() / 1000)) * 1000,
        streaming: !m.out,
        topicId: (b.isForum || b.hasTopics) ? topicOf(m) : undefined,
        media: mediaOf(m),
        buttons: buttonsOf(m as { replyMarkup?: unknown }),
      };
      this.sendEvent({ type: isEdit ? 'edit' : 'message', profileId: b.profileId, message: msg });
      if (!m.out) {
        // Agent output — keep 'working' alive and (re)arm the settle timer.
        this.lastAgentMsgId.set(b.profileId, msg.id);
        this.sendStatus(b.profileId, 'working');
        this.armSettle(b.profileId, SETTLE_MS);
      }
    }
  }

  private armSettle(profileId: string, ms: number): void {
    const t = this.settleTimers.get(profileId);
    if (t) clearTimeout(t);
    this.settleTimers.set(profileId, setTimeout(() => {
      this.settleTimers.delete(profileId);
      const msgId = this.lastAgentMsgId.get(profileId) ?? '';
      this.sendEvent({ type: 'settled', profileId, messageId: msgId });
      this.sendStatus(profileId, 'ready');
    }, ms));
  }

  dispose(): void {
    for (const t of this.settleTimers.values()) clearTimeout(t);
    this.settleTimers.clear();
    void this.client?.disconnect().catch((): undefined => undefined);
    this.client = null;
  }
}

/** Telegram formatting entity — offsets/lengths are UTF-16 code units,
 * which is exactly how JS indexes strings, so slicing lines up. */
interface TgEntity { className?: string; offset: number; length: number; url?: string }

/** Convert Telegram entities (bold/italic/code/…) to markdown for the
 * pane's ReactMarkdown renderer. Marker positions are computed against
 * the ORIGINAL offsets and inserted in one pass, so nested/overlapping
 * entities don't corrupt each other. Unsupported kinds pass through. */
function entitiesToMarkdown(text: string, entities?: TgEntity[]): string {
  if (!text || !entities || entities.length === 0) return text;
  const marks = (e: TgEntity): [string, string] | null => {
    switch (e.className) {
      case 'MessageEntityBold': return ['**', '**'];
      case 'MessageEntityItalic': return ['*', '*'];
      case 'MessageEntityCode': return ['`', '`'];
      case 'MessageEntityPre': return ['\n```\n', '\n```\n'];
      case 'MessageEntityStrike': return ['~~', '~~'];
      case 'MessageEntityTextUrl': return ['[', `](${e.url ?? ''})`];
      default: return null; // underline/spoiler/mentions: render as plain text
    }
  };
  const inserts: { pos: number; str: string; closer: boolean }[] = [];
  for (const e of entities) {
    const m = marks(e);
    if (!m || e.length <= 0) continue;
    // Trim spaces at the entity edges: `**Confirm **` is invalid markdown
    // (no space allowed inside the closing delimiter), so shift the
    // markers to hug the visible text instead.
    let start = e.offset;
    let end = e.offset + e.length;
    while (end > start && text[end - 1] === ' ') end--;
    while (start < end && text[start] === ' ') start++;
    if (end <= start) continue;
    inserts.push({ pos: start, str: m[0], closer: false });
    inserts.push({ pos: end, str: m[1], closer: true });
  }
  if (inserts.length === 0) return text;
  // Closers before openers at the same position keeps adjacency sane.
  inserts.sort((a, b) => a.pos - b.pos || Number(b.closer) - Number(a.closer));
  let out = '';
  let last = 0;
  for (const ins of inserts) {
    out += text.slice(last, ins.pos) + ins.str;
    last = ins.pos;
  }
  return out + text.slice(last);
}

/** Telegram inline keyboard rows → serializable button descriptors.
 * Callback data travels base64 so it survives the IPC boundary. */
function buttonsOf(m: { replyMarkup?: unknown }): { text: string; data?: string; url?: string }[][] | undefined {
  const markup = m.replyMarkup as {
    className?: string;
    rows?: { buttons?: { className?: string; text?: string; data?: Buffer; url?: string }[] }[];
  } | undefined;
  if (markup?.className !== 'ReplyInlineMarkup' || !markup.rows?.length) return undefined;
  const rows = markup.rows
    .map((r) => (r.buttons ?? [])
      .filter((b) => b.className === 'KeyboardButtonCallback' || b.className === 'KeyboardButtonUrl')
      .map((b) => ({
        text: b.text ?? '',
        data: b.className === 'KeyboardButtonCallback' && b.data ? Buffer.from(b.data).toString('base64') : undefined,
        url: b.className === 'KeyboardButtonUrl' ? b.url : undefined,
      })))
    .filter((r) => r.length > 0);
  return rows.length > 0 ? rows : undefined;
}

/** Classify a message's media attachment for the clickable chip. */
function mediaOf(m: { media?: unknown }): { name: string; kind: 'photo' | 'voice' | 'sticker' | 'file' } | undefined {
  const media = m.media as {
    className?: string;
    document?: { attributes?: { className?: string; fileName?: string; voice?: boolean; alt?: string }[] };
  } | undefined;
  if (!media) return undefined;
  if (media.className === 'MessageMediaPhoto') return { name: 'photo', kind: 'photo' };
  const attrs = media.document?.attributes ?? [];
  const sticker = attrs.find((a) => a.className === 'DocumentAttributeSticker');
  if (sticker) return { name: `sticker ${sticker.alt ?? ''}`.trim(), kind: 'sticker' };
  const audio = attrs.find((a) => a.className === 'DocumentAttributeAudio');
  if (audio?.voice) return { name: 'voice message', kind: 'voice' };
  const fileName = attrs.find((a) => a.className === 'DocumentAttributeFilename')?.fileName;
  return { name: fileName ?? 'file', kind: 'file' };
}

/** Display text for a message: its formatted text, or a media label. */
function textOf(m: { message?: string; media?: unknown; entities?: TgEntity[] }): string {
  if (m.message) return entitiesToMarkdown(m.message, m.entities);
  const media = mediaOf(m);
  if (!media) return '[media]';
  switch (media.kind) {
    case 'photo': return '📷 photo';
    case 'voice': return '🎤 voice message';
    case 'sticker': return media.name.replace(/^sticker\s*/, '') || '[sticker]';
    default: return `📎 ${media.name}`;
  }
}

/** Forum topic id of a message: replies carry the thread root in
 * replyTo; untopiced messages belong to the General topic ('1'). */
function topicOf(m: { replyTo?: unknown }): string {
  const r = m.replyTo as { replyToTopId?: number; replyToMsgId?: number; forumTopic?: boolean } | undefined;
  if (r?.replyToTopId != null) return String(r.replyToTopId);
  if (r?.forumTopic && r.replyToMsgId != null) return String(r.replyToMsgId);
  return '1';
}

/** Pull the numeric peer id out of a GramJS Peer / BigInteger-ish value.
 * Handles PeerUser (private bot), PeerChannel (forum supergroup) and
 * PeerChat (legacy group). */
function extractPeerId(peer: unknown): string | null {
  if (peer == null) return null;
  const p = peer as {
    userId?: { toString(): string };
    channelId?: { toString(): string };
    chatId?: { toString(): string };
    toString?: () => string;
    className?: string;
  };
  if (p.userId != null) return String(p.userId);
  if (p.channelId != null) return String(p.channelId);
  if (p.chatId != null) return String(p.chatId);
  // Bare BigInteger (senderId) — stringify unless it's a complex peer type.
  if (typeof p.toString === 'function' && p.className === undefined) {
    const s = p.toString();
    return /^\d+$/.test(s) ? s : null;
  }
  return null;
}
