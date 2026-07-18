import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [newTopicTitle, setNewTopicTitle] = useState('');
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
  }, [profile.id, upsert]);

  // ── Topics (once connected) ─────────────────────────────────────
  useEffect(() => {
    if (topics !== null || state.state !== 'connected') return;
    let cancelled = false;
    window.api.remoteChatTopics(profile.id).then((t) => {
      if (cancelled) return;
      setTopics(t);
      if (t.isForum) setActiveTopicId(t.topics[0]?.id ?? '1');
    });
    return () => { cancelled = true; };
  }, [state.state, topics, profile.id]);

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
  const messages = byTopic.get(activeKey) ?? [];

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
      setSendError(`Could not create topic: ${res.error}`);
      return;
    }
    setTopics((prev) => prev
      ? { ...prev, topics: [{ ...res, lastActive: Date.now() }, ...prev.topics.filter((t) => t.id !== res.id)] }
      : prev);
    setActiveTopicId(res.id);
  }, [newTopicTitle, profile.id]);

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
              title="Topics — each is a separate discussion with Hermes"
            >
              {topics.topics.map((t) => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
            {topics.canCreate !== false && (
              <button
                className="remote-chat-newtopic-btn"
                title="New topic (fresh discussion)"
                onClick={() => setNewTopicOpen((v) => !v)}
              >+</button>
            )}
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

      {/* Topics unavailable — say WHY (silent hiding made a misconfigured
          group binding look like a missing feature). */}
      {connected && topics && !topics.isForum && topics.reason && (
        <div className="remote-chat-topics-hint">No topics: {topics.reason}</div>
      )}

      {newTopicOpen && (
        <div className="remote-chat-newtopic-row">
          <input
            autoFocus
            type="text"
            placeholder="New topic title…"
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
        {messages.map((m) => (
          <div key={m.id} className={`remote-chat-msg remote-chat-msg-${m.role}`}>
            <div className="remote-chat-bubble">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
              {m.streaming && <span className="remote-chat-streaming" title="Hermes is still writing">▋</span>}
            </div>
            <span className="remote-chat-time">{relTime(m.date)}</span>
          </div>
        ))}
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
