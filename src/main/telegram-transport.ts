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
      const text = m.message ?? '';
      out.push({
        id: String(m.id),
        role: m.out ? 'user' : 'agent',
        text: text || textOf(m),
        date: (m.date ?? 0) * 1000,
        topicId: mTopic,
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
      // chats send without a thread.
      const replyTo = (b.isForum || b.hasTopics) && topicId && topicId !== '1' ? Number(topicId) : undefined;
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
    };
    this.sendEvent({ type: 'message', profileId: b.profileId, message: msg });
  }

  /** Upload a local file to the chat (drag-and-drop). Lands in the given
   * topic's thread like a text message would. */
  async sendFile(profile: Profile, filePath: string, topicId?: string): Promise<{ ok: boolean; error?: string }> {
    const b = this.bind(profile);
    if (!b) return { ok: false, error: 'profile has no Telegram binding' };
    try {
      const client = await this.ensureConnected();
      await this.resolveBot(client, b);
      const replyTo = (b.isForum || b.hasTopics) && topicId && topicId !== '1' ? Number(topicId) : undefined;
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
      return {
        isForum: false,
        topics: [],
        reason: 'no topics found in this chat yet — if the bot uses topics, send a message in one from Telegram first, or bind the forum GROUP instead',
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
    // DM-topic creation isn't exposed at our protocol layer — create new
    // topics from the Telegram app; they appear here on next refresh.
    return { isForum: true, topics, canCreate: false };
  }

  /** Create a new forum topic (a fresh discussion). */
  async createTopic(profile: Profile, title: string): Promise<import('../shared/types').RemoteChatTopic | { error: string }> {
    const b = this.bind(profile);
    if (!b) return { error: 'profile has no Telegram binding' };
    try {
      const client = await this.ensureConnected();
      await this.resolveBot(client, b);
      if (!b.isForum) return { error: 'this chat has no topics (not a forum group)' };
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

  private onMessage(m: { id: number; out?: boolean; message?: string; date?: number; senderId?: unknown; peerId?: unknown; replyTo?: unknown }, isEdit: boolean): void {
    // Match the message's peer (private bot OR forum group) against bindings.
    const peerId = extractPeerId(m.peerId) ?? extractPeerId(m.senderId);
    if (!peerId) return;
    for (const b of this.bindings.values()) {
      if (b.botId !== peerId) continue;
      const msg: RemoteChatMessage = {
        id: String(m.id),
        role: m.out ? 'user' : 'agent',
        text: textOf(m),
        date: (m.date ?? Math.floor(Date.now() / 1000)) * 1000,
        streaming: !m.out,
        topicId: (b.isForum || b.hasTopics) ? topicOf(m) : undefined,
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

/** Display text for a message: its text, or a file/photo label derived
 * from the media attachment. */
function textOf(m: { message?: string; media?: unknown }): string {
  if (m.message) return m.message;
  const media = m.media as {
    className?: string;
    document?: { attributes?: { className?: string; fileName?: string }[] };
  } | undefined;
  if (!media) return '[media]';
  if (media.className === 'MessageMediaPhoto') return '📷 [photo]';
  const name = media.document?.attributes?.find((a) => a.className === 'DocumentAttributeFilename')?.fileName;
  return name ? `📎 ${name}` : '[media]';
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
