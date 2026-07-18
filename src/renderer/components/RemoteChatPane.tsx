import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Profile, RemoteChatMessage, RemoteChatState, RemoteChatEvent, RemoteChatTopics } from '../../shared/types';

// ── Remote-agent chat pane (Hermes over Telegram) ─────────────────────
//
// Rendered in place of the agent terminal for profiles with
// `remoteAgent` set. The main-process TelegramTransport does all the
// protocol work; this pane renders history + live events and sends
// messages. Hermes streams by editing its reply in place, so 'edit'
// events re-render the matching bubble; 'settled' clears the streaming
// indicator.
//
// TOPICS: when the bound chat is a Telegram forum group, each topic is a
// separate discussion with the agent. The header shows a topic switcher
// (+ new-topic); messages are cached per topic, live events land in
// their topic's bucket (so background discussions keep accumulating),
// and sends target the active topic's thread.

interface Props {
  profile: Profile;
  hidden: boolean;
  /** Split mode: this pane is the LEFT column at this width % (negative
   * flex order places it ahead of the resize handle + right overlay,
   * same trick as ParallelAgentTerminal). Null = full-pane flex. */
  splitWidth?: number | null;
}

function relTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Bucket key for a message: its topic id in forums, '' otherwise. */
const PRIVATE_KEY = '';

/** What the preview dialog can render for an attachment, from its media
 * kind + filename extension. Chromium plays ogg/opus natively, so voice
 * notes preview in-app even though macOS has no OS handler for them. */
function previewTypeOf(name: string, kind: string): 'image' | 'audio' | 'video' | 'text' | 'none' {
  if (kind === 'photo' || kind === 'sticker') return 'image';
  if (kind === 'voice') return 'audio';
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(ext)) return 'image';
  if (['mp3', 'ogg', 'oga', 'm4a', 'wav', 'opus', 'flac', 'aac'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  if ([
    'txt', 'md', 'markdown', 'json', 'log', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'css',
    'js', 'ts', 'tsx', 'jsx', 'sh', 'zsh', 'bash', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp',
    'h', 'swift', 'kt', 'sql', 'toml', 'ini', 'conf', 'env', 'diff', 'patch',
  ].includes(ext)) return 'text';
  return 'none';
}

export function RemoteChatPane({ profile, hidden, splitWidth = null }: Props) {
  const [state, setState] = useState<RemoteChatState>({ state: 'connecting' });
  const [topics, setTopics] = useState<RemoteChatTopics | null>(null);
  const [activeTopicId, setActiveTopicId] = useState<string>(PRIVATE_KEY);
  const [byTopic, setByTopic] = useState<Map<string, RemoteChatMessage[]>>(new Map());
  const loadedTopicsRef = useRef<Set<string>>(new Set());
  const [input, setInput] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [newTopicOpen, setNewTopicOpen] = useState(false);
  // Drag-and-drop file sending. Counter-based so child enter/leave events
  // don't flicker the overlay; uploading gates repeat drops.
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  // In-app attachment preview dialog. Downloads to the temp cache, then
  // previews via local-file:// (images / audio / video) or readFile (text).
  const [preview, setPreview] = useState<null | {
    messageId: string;
    name: string;
    previewType: 'image' | 'audio' | 'video' | 'text' | 'none';
    path?: string;
    text?: string;
    loading: boolean;
    error?: string;
    notice?: string;
  }>(null);

  const openPreview = useCallback(async (messageId: string, name: string) => {
    setPreview({ messageId, name, previewType: 'none', loading: true });
    const res = await window.api.remoteChatFetchMedia(profile.id, messageId);
    if (res.ok !== true) {
      const msg = 'error' in res ? res.error : 'download failed';
      setPreview({ messageId, name, previewType: 'none', loading: false, error: msg });
      return;
    }
    const type = previewTypeOf(res.name, res.kind);
    if (type === 'text') {
      const content = await window.api.readFile(res.path);
      setPreview({
        messageId, name: res.name, previewType: 'text', path: res.path, loading: false,
        text: content === null
          ? undefined
          : content.length > 200_000 ? content.slice(0, 200_000) + '\n… (truncated)' : content,
        error: content === null ? 'could not read file' : undefined,
      });
      return;
    }
    setPreview({ messageId, name: res.name, previewType: type, path: res.path, loading: false });
  }, [profile.id]);

  const saveFromPreview = useCallback(async () => {
    if (!preview) return;
    const res = await window.api.remoteChatSaveMedia(profile.id, preview.messageId);
    setPreview((p) => p && {
      ...p,
      notice: res.ok
        ? (res.canceled ? undefined : `Saved to ${res.savedTo}`)
        : undefined,
      error: res.ok ? undefined : (res.error ?? 'save failed'),
    });
  }, [preview, profile.id]);
  const [newTopicTitle, setNewTopicTitle] = useState('');
  // Session-local dismiss for the "topics not enabled" splash — it comes
  // back on next app start (gentle reminder, not nagging).
  const [topicsOffDismissed, setTopicsOffDismissed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const upsert = useCallback((key: string, message: RemoteChatMessage, isEdit: boolean) => {
    setByTopic((prev) => {
      const next = new Map(prev);
      const list = next.get(key) ?? [];
      if (isEdit) {
        next.set(key, list.map((m) => (m.id === message.id ? { ...message } : m)));
      } else if (!list.some((m) => m.id === message.id)) {
        next.set(key, [...list, message]);
      }
      return next;
    });
  }, []);

  // ── Topics ──────────────────────────────────────────────────────
  // Loaded on connect, re-loadable any time (↻ button; automatically when
  // a message arrives in a topic we don't know about — e.g. a thread
  // created from the phone). Keeps the current selection when it still
  // exists; only the very first load picks a default. Declared BEFORE the
  // events effect below, which references loadTopics.
  const topicsRef = useRef<RemoteChatTopics | null>(null);
  topicsRef.current = topics;
  const refreshingRef = useRef(false);
  const loadTopics = useCallback(async (initial: boolean) => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const t = await window.api.remoteChatTopics(profile.id);
      setTopics(t);
      if (t.isForum && initial) setActiveTopicId(t.topics[0]?.id ?? '1');
    } finally {
      refreshingRef.current = false;
    }
  }, [profile.id]);

  // ── Transport state + events ────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    window.api.remoteChatState().then((s) => { if (!cancelled) setState(s); });
    const unsub = window.api.onRemoteChatEvent((event: RemoteChatEvent) => {
      if (event.type === 'state') {
        setState(event.state);
        return;
      }
      if (event.profileId !== profile.id) return;
      if (event.type === 'message' || event.type === 'edit') {
        upsert(event.message.topicId ?? PRIVATE_KEY, event.message, event.type === 'edit');
        // A message in a topic we don't have listed = a thread created
        // elsewhere (e.g. from the phone) — refresh the list so the
        // dropdown stays current without restarting.
        const tid = event.message.topicId;
        const known = topicsRef.current;
        if (tid && known?.isForum && !known.topics.some((t) => t.id === tid)) {
          void loadTopics(false);
        }
      } else if (event.type === 'settled') {
        setByTopic((prev) => {
          const next = new Map(prev);
          for (const [k, list] of next) {
            if (list.some((m) => m.streaming)) {
              next.set(k, list.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
            }
          }
          return next;
        });
      }
    });
    return () => { cancelled = true; unsub(); };
  }, [profile.id, upsert, loadTopics]);

  useEffect(() => {
    if (topics !== null || state.state !== 'connected') return;
    void loadTopics(true);
  }, [state.state, topics, loadTopics]);

  // Re-list when the profile's bot token changes (adding it flips
  // canCreate — otherwise the + button stays stale until manual ⟳).
  const tokenRef = useRef(profile.remoteAgent?.botToken);
  useEffect(() => {
    if (tokenRef.current === profile.remoteAgent?.botToken) return;
    tokenRef.current = profile.remoteAgent?.botToken;
    if (state.state === 'connected') void loadTopics(false);
  }, [profile.remoteAgent?.botToken, state.state, loadTopics]);

  // ── History for the active topic (lazy, once per topic) ────────
  useEffect(() => {
    if (state.state !== 'connected') return;
    if (topics === null) return; // wait until we know forum-ness
    const key = topics.isForum ? activeTopicId : PRIVATE_KEY;
    if (topics.isForum && !key) return;
    if (loadedTopicsRef.current.has(key)) return;
    loadedTopicsRef.current.add(key);
    let cancelled = false;
    window.api.remoteChatHistory(profile.id, topics.isForum ? key : undefined).then((h) => {
      if (cancelled) return;
      setByTopic((prev) => {
        const next = new Map(prev);
        const live = next.get(key) ?? [];
        const seen = new Set(h.map((m) => m.id));
        next.set(key, [...h, ...live.filter((m) => !seen.has(m.id))]);
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [state.state, topics, activeTopicId, profile.id]);

  // Trigger a connection attempt when the pane first shows and creds
  // exist but we're not connected (history call connects lazily).
  useEffect(() => {
    if (hidden || state.state !== 'disconnected') return;
    window.api.remoteChatHistory(profile.id).catch((): void => undefined);
    // ensureConnected inside history will broadcast state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden]);

  const activeKey = topics?.isForum ? activeTopicId : PRIVATE_KEY;
  const messages = useMemo(() => byTopic.get(activeKey) ?? [], [byTopic, activeKey]);

  // ── Autoscroll (stick to bottom unless the user scrolled up) ────
  useEffect(() => {
    const el = listRef.current;
    if (!el || hidden) return;
    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, hidden, activeKey]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  // ── Send ────────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    setSendError(null);
    const res = await window.api.remoteChatSend(
      profile.id, text, topics?.isForum ? activeTopicId : undefined,
    );
    if (!res.ok) setSendError(res.error ?? 'send failed');
  }, [input, profile.id, topics?.isForum, activeTopicId]);

  // Reset the ACTIVE conversation: Hermes' /new discards that thread's
  // session history (it asks to confirm — the inline buttons handle it).
  const resetChat = useCallback(async () => {
    setSendError(null);
    const res = await window.api.remoteChatSend(
      profile.id, '/new', topics?.isForum ? activeTopicId : undefined,
    );
    if (!res.ok) setSendError(res.error ?? '/new failed');
  }, [profile.id, topics?.isForum, activeTopicId]);

  // Inline keyboard press (approval prompts etc.). The bot edits the
  // message afterwards, which lands as a normal edit event.
  const [pressingButton, setPressingButton] = useState<string | null>(null);
  const pressButton = useCallback(async (messageId: string, data: string) => {
    setPressingButton(`${messageId}:${data}`);
    try {
      const res = await window.api.remoteChatPressButton(profile.id, messageId, data);
      if (!res.ok) setSendError(res.error ?? 'button press failed');
    } finally {
      setPressingButton(null);
    }
  }, [profile.id]);

  // Send dropped files sequentially so ordering matches the drop and
  // Telegram rate limits stay happy. Errors surface via sendError.
  const sendFiles = useCallback(async (files: FileList) => {
    if (state.state !== 'connected') return;
    setUploading(true);
    setSendError(null);
    try {
      for (let i = 0; i < files.length; i++) {
        const path = window.api.getPathForFile(files[i]);
        if (!path) continue;
        const res = await window.api.remoteChatSendFile(
          profile.id, path, topics?.isForum ? activeTopicId : undefined,
        );
        if (!res.ok) {
          setSendError(`${files[i].name}: ${res.error ?? 'upload failed'}`);
          break;
        }
      }
    } finally {
      setUploading(false);
    }
  }, [state.state, profile.id, topics?.isForum, activeTopicId]);

  const createTopic = useCallback(async () => {
    const title = newTopicTitle.trim();
    if (!title) return;
    setNewTopicOpen(false);
    setNewTopicTitle('');
    const res = await window.api.remoteChatCreateTopic(profile.id, title);
    if ('error' in res) {
      setSendError(`Could not create chat: ${res.error}`);
      return;
    }
    if (topicsRef.current?.isForum) {
      setTopics((prev) => prev
        ? { ...prev, topics: [{ ...res, lastActive: Date.now() }, ...prev.topics.filter((t) => t.id !== res.id)] }
        : prev);
    } else {
      // The + probe succeeded while topics LOOKED off (getMe only sees the
      // bot-global mode, not the per-chat toggle) — so this chat does have
      // topics. Re-detect: the new topic's service message flips the scan
      // and the full topics UI comes up.
      await loadTopics(false);
    }
    setActiveTopicId(res.id);
  }, [newTopicTitle, profile.id, loadTopics]);

  const connected = state.state === 'connected';

  return (
    <div
      className="remote-chat-pane"
      style={
        hidden
          ? { display: 'none' }
          : splitWidth != null
            ? { flex: `0 0 ${splitWidth}%`, order: -2, overflow: 'hidden' }
            : undefined
      }
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        dragCounterRef.current++;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
        if (dragCounterRef.current === 0) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        dragCounterRef.current = 0;
        setDragOver(false);
        void sendFiles(e.dataTransfer.files);
      }}
    >
      {dragOver && connected && (
        <div className="remote-chat-drop-overlay">
          Drop to send to Hermes{topics?.isForum ? ` · ${topics.topics.find((t) => t.id === activeTopicId)?.title ?? 'topic'}` : ''}
        </div>
      )}
      {uploading && <div className="remote-chat-uploading">Uploading…</div>}
      <div className="remote-chat-header">
        <span className="remote-chat-title">
          Hermes · @{profile.remoteAgent?.botUsername}
        </span>
        {topics?.isForum && (
          <span className="remote-chat-topicbar">
            <select
              className="remote-chat-topic-select"
              value={activeTopicId}
              onChange={(e) => setActiveTopicId(e.target.value)}
              title="Chats — each is a separate discussion with the agent"
            >
              {topics.topics.map((t) => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
            <button
              className="remote-chat-newtopic-btn"
              title={topics.canCreate !== false
                ? 'New chat (fresh discussion in its own topic)'
                : 'Creating chats needs the bot token — add it in the profile settings'}
              onClick={() => {
                if (topics.canCreate !== false) setNewTopicOpen((v) => !v);
                else setSendError('To create new chats from Vyb, add the bot token in the profile settings (only the bot can open DM threads).');
              }}
            >+</button>
            <button
              className="remote-chat-newtopic-btn"
              title="Reset this conversation — the agent forgets this thread's history (asks to confirm first)"
              onClick={() => { void resetChat(); }}
            >🧹</button>
            <button
              className="remote-chat-newtopic-btn"
              title="Refresh chats"
              onClick={() => { void loadTopics(false); }}
            >⟳</button>
          </span>
        )}
        {/* Single-conversation mode still gets the reset broom — /new is
            just as valid without topics. With the bot token, + stays too:
            it doubles as the probe for per-chat topics (no API can read
            that toggle; createForumTopic succeeds iff it's on). */}
        {connected && topics && !topics.isForum && (
          <span className="remote-chat-topicbar">
            {topics.canCreate === true && (
              <button
                className="remote-chat-newtopic-btn"
                title="New chat — works once Topics are enabled for this bot"
                onClick={() => setNewTopicOpen((v) => !v)}
              >+</button>
            )}
            <button
              className="remote-chat-newtopic-btn"
              title="Reset this conversation — the agent forgets its history (asks to confirm first)"
              onClick={() => { void resetChat(); }}
            >🧹</button>
          </span>
        )}
        <span className={`remote-chat-conn remote-chat-conn-${state.state}`}>
          {state.state === 'connected' ? `Telegram · ${state.user ? '@' + state.user : 'connected'}`
            : state.state === 'connecting' ? 'Connecting…'
            : state.state === 'unconfigured' ? 'Telegram not set up'
            : state.state === 'awaiting-code' || state.state === 'awaiting-password' ? 'Logging in…'
            : `Disconnected${state.error ? ` — ${state.error}` : ''}`}
        </span>
        {!connected && state.state !== 'connecting' && (
          <button className="remote-chat-connect-btn" onClick={() => setLoginOpen(true)}>
            Connect Telegram…
          </button>
        )}
      </div>


      {/* Topic mode definitively OFF — friendly, dismissible splash (it's a
          supported mode, not an error): single conversation, with a pointer
          to BotFather for enabling parallel chats. */}
      {connected && topics?.topicsOff && !topicsOffDismissed && (
        <div className="remote-chat-topicsoff-splash">
          <span>
            Single-conversation mode — Topics look disabled for this bot. To run
            multiple parallel chats, enable Topics in the bot&apos;s profile
            (Telegram app) or via @BotFather. Already enabled? Just hit + to
            start a new chat.
          </span>
          <button onClick={() => { void loadTopics(false); }}>Check again</button>
          <button onClick={() => setTopicsOffDismissed(true)} title="Dismiss">✕</button>
        </div>
      )}

      {/* Topics unavailable for an UNKNOWN reason — say WHY (silent hiding
          made a misconfigured group binding look like a missing feature). */}
      {connected && topics && !topics.isForum && !topics.topicsOff && topics.reason && (
        <div className="remote-chat-topics-hint">No topics: {topics.reason}</div>
      )}

      {newTopicOpen && (
        <div className="remote-chat-newtopic-row">
          <input
            autoFocus
            type="text"
            placeholder="New chat name…"
            value={newTopicTitle}
            onChange={(e) => setNewTopicTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createTopic();
              if (e.key === 'Escape') { setNewTopicOpen(false); setNewTopicTitle(''); }
            }}
          />
          <button disabled={!newTopicTitle.trim()} onClick={() => { void createTopic(); }}>Create</button>
        </div>
      )}

      <div className="remote-chat-list" ref={listRef} onScroll={onScroll}>
        {messages.length === 0 && (
          <div className="remote-chat-empty">
            {connected
              ? 'No messages yet — say hello to Hermes below.'
              : 'Connect your Telegram account to chat with this Hermes agent. Messages go through the same bot chat you use on your phone.'}
          </div>
        )}
        {messages.map((m) => {
          // Media messages render a clickable chip (download + open with
          // the OS default app). A caption, when present, renders as
          // markdown below the chip; the auto-generated label doesn't.
          const mediaLabel = m.media
            ? (m.media.kind === 'photo' ? '📷 photo'
              : m.media.kind === 'voice' ? '🎤 voice message'
              : m.media.kind === 'sticker' ? `${m.media.name.replace(/^sticker\s*/, '') || '🩵'} sticker`
              : `📎 ${m.media.name}`)
            : '';
          const isAutoLabel = m.media && (m.text === mediaLabel
            || m.text === m.media.name.replace(/^sticker\s*/, ''));
          return (
            <div key={m.id} className={`remote-chat-msg remote-chat-msg-${m.role}`}>
              <div className="remote-chat-bubble">
                {m.media && (
                  <button
                    className="remote-chat-media-chip"
                    title="Preview attachment"
                    onClick={() => { void openPreview(m.id, m.media?.name ?? 'attachment'); }}
                  >
                    {mediaLabel}
                  </button>
                )}
                {(!m.media || !isAutoLabel) && (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                )}
                {m.streaming && <span className="remote-chat-streaming" title="Hermes is still writing">▋</span>}
                {m.buttons && m.buttons.length > 0 && (
                  <div className="remote-chat-buttons">
                    {m.buttons.map((row, ri) => (
                      <div key={ri} className="remote-chat-button-row">
                        {row.map((btn, bi) => (
                          <button
                            key={bi}
                            className="remote-chat-inline-btn"
                            disabled={pressingButton !== null}
                            onClick={() => {
                              if (btn.data) void pressButton(m.id, btn.data);
                              else if (btn.url) window.open(btn.url, '_blank');
                            }}
                          >
                            {pressingButton === `${m.id}:${btn.data ?? ''}` ? '…' : btn.text}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <span className="remote-chat-time">{relTime(m.date)}</span>
            </div>
          );
        })}
      </div>

      {sendError && <div className="remote-chat-error">{sendError}</div>}

      <div className="remote-chat-inputrow">
        <textarea
          className="remote-chat-input"
          placeholder={connected ? 'Message Hermes… (Enter to send, Shift+Enter for newline)' : 'Connect Telegram to send messages'}
          value={input}
          disabled={!connected}
          rows={Math.min(6, Math.max(1, input.split('\n').length))}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="remote-chat-send" disabled={!connected || !input.trim()} onClick={() => { void send(); }}>
          Send
        </button>
      </div>

      {loginOpen && (
        <TelegramLoginDialog state={state} onClose={() => setLoginOpen(false)} />
      )}

      {preview && (
        <div className="modal-overlay" onClick={() => setPreview(null)}>
          <div className="modal remote-chat-preview" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>{preview.name}</h3></div>
            <div className="modal-body remote-chat-preview-body">
              {preview.loading && <div className="remote-chat-preview-hint">Downloading…</div>}
              {!preview.loading && preview.error && (
                <div className="remote-chat-preview-hint" style={{ color: 'var(--c-red, #ef4444)' }}>{preview.error}</div>
              )}
              {!preview.loading && !preview.error && preview.path && (
                preview.previewType === 'image' ? (
                  <img className="remote-chat-preview-image" src={`local-file://${preview.path}`} alt={preview.name} />
                ) : preview.previewType === 'audio' ? (
                  <audio className="remote-chat-preview-audio" controls src={`local-file://${preview.path}`} />
                ) : preview.previewType === 'video' ? (
                  <video className="remote-chat-preview-video" controls src={`local-file://${preview.path}`} />
                ) : preview.previewType === 'text' ? (
                  <pre className="remote-chat-preview-text">{preview.text ?? ''}</pre>
                ) : (
                  <div className="remote-chat-preview-hint">
                    No in-app preview for this file type — open it in the default app or save it.
                  </div>
                )
              )}
              {preview.notice && <div className="remote-chat-preview-notice">{preview.notice}</div>}
            </div>
            <div className="modal-footer">
              <button className="cancel-btn" onClick={() => setPreview(null)}>Close</button>
              <div className="modal-footer-right">
                <button
                  className="browse-btn"
                  disabled={preview.loading}
                  onClick={() => { void window.api.remoteChatOpenMedia(profile.id, preview.messageId); }}
                  title="Open with the OS default application"
                >
                  Open in default app
                </button>
                <button
                  className="save-btn"
                  disabled={preview.loading}
                  onClick={() => { void saveFromPreview(); }}
                  title={`Save — defaults to ${profile.workingDirectory}`}
                >
                  Save…
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Telegram login dialog ─────────────────────────────────────────────
// api_id/api_hash (from my.telegram.org/apps) → phone → code → optional
// 2FA password. The main process drives GramJS's auth flow; this dialog
// just feeds each step over IPC and follows the broadcast state.

function TelegramLoginDialog({ state, onClose }: { state: RemoteChatState; onClose: () => void }) {
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [started, setStarted] = useState(false);

  // Close automatically once fully connected.
  useEffect(() => {
    if (started && state.state === 'connected') onClose();
  }, [state.state, started, onClose]);

  const begin = () => {
    const id = Number(apiId.trim());
    if (!id || !apiHash.trim() || !phone.trim()) return;
    setStarted(true);
    void window.api.remoteChatLoginStart(id, apiHash.trim(), phone.trim());
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h3>Connect Telegram</h3></div>
        <div className="modal-body">
          {!started && (
            <>
              <p className="field-hint" style={{ marginBottom: 10 }}>
                Vyb signs into <strong>your</strong> Telegram account to talk to the
                Hermes bot. Create API credentials once at my.telegram.org/apps
                (any app name works), then enter them here. Credentials and the
                login session are stored locally in Vyb&apos;s settings.
              </p>
              <label className="field">
                <span className="field-label">API ID</span>
                <input type="text" value={apiId} onChange={(e) => setApiId(e.target.value)} placeholder="123456" />
              </label>
              <label className="field">
                <span className="field-label">API hash</span>
                <input type="text" value={apiHash} onChange={(e) => setApiHash(e.target.value)} placeholder="0123abcd…" />
              </label>
              <label className="field">
                <span className="field-label">Phone number</span>
                <input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+46701234567" />
              </label>
            </>
          )}
          {started && state.state === 'awaiting-code' && (
            <label className="field">
              <span className="field-label">Login code (sent via Telegram/SMS)</span>
              <input
                type="text" autoFocus value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) void window.api.remoteChatLoginCode(code); }}
              />
            </label>
          )}
          {started && state.state === 'awaiting-password' && (
            <label className="field">
              <span className="field-label">Two-factor password</span>
              <input
                type="password" autoFocus value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && password) void window.api.remoteChatLoginPassword(password); }}
              />
            </label>
          )}
          {started && state.state === 'connecting' && (
            <p className="field-hint">Talking to Telegram…</p>
          )}
          {state.state === 'disconnected' && state.error && (
            <p className="field-hint" style={{ color: 'var(--c-red, #ef4444)' }}>{state.error}</p>
          )}
        </div>
        <div className="modal-footer">
          <button className="cancel-btn" onClick={onClose}>Cancel</button>
          <div className="modal-footer-right">
            {!started && (
              <button className="save-btn" disabled={!apiId.trim() || !apiHash.trim() || !phone.trim()} onClick={begin}>
                Send login code
              </button>
            )}
            {started && state.state === 'awaiting-code' && (
              <button className="save-btn" disabled={!code.trim()} onClick={() => { void window.api.remoteChatLoginCode(code); }}>
                Verify code
              </button>
            )}
            {started && state.state === 'awaiting-password' && (
              <button className="save-btn" disabled={!password} onClick={() => { void window.api.remoteChatLoginPassword(password); }}>
                Sign in
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
