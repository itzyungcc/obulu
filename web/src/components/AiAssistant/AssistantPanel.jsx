import { useCallback, useEffect, useRef, useState } from "react";
import { useAssistantChat } from "./useAssistantChat.js";
import { renderMessage } from "./renderMessage.js";

const GREETING =
  "Hi \uD83D\uDC4B I'm OBULU AI. Ask me about OBULU, football analysis, predictions, matches, teams, or how our analysis works.";

const SUGGESTIONS = [
  "How does OBULU predict matches?",
  "Explain this prediction",
  "What does this percentage mean?",
  "Analyze this match",
  "What is OBULU?",
];

const QUICK_ACTIONS = [
  "Explain prediction",
  "Analyze match",
  "How OBULU works",
  "Football terms",
];

function useOnlineStatus() {
  const [online, setOnline] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const base = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
    fetch(`${base}/api/chat/status`, { method: "GET" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled) setOnline(j?.configured !== false);
      })
      .catch(() => {
        if (!cancelled) setOnline(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return online;
}

function MessageBubble({ role, text }) {
  if (role === "user") {
    return <div className="obulu-ai-bubble obulu-ai-user">{text}</div>;
  }
  return (
    <div
      className="obulu-ai-bubble obulu-ai-assistant"
      dangerouslySetInnerHTML={{ __html: renderMessage(text) }}
    />
  );
}

export default function AssistantPanel({ onClose, onMinimize }) {
  const { messages, phase, error, send, stop, retry, reset, busy } = useAssistantChat();
  const [input, setInput] = useState("");
  const [started, setStarted] = useState(false);
  const online = useOnlineStatus();
  const logRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, phase]);

  const doSend = useCallback(
    (text) => {
      if (!started) setStarted(true);
      send(text);
      setInput("");
    },
    [send, started]
  );

  const onSubmit = (e) => {
    e.preventDefault();
    if (input.trim() && !busy) doSend(input);
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() && !busy) doSend(input);
    }
    if (e.key === "Escape") onClose();
  };

  const showGreeting = !started && messages.length === 0;

  return (
    <div className="obulu-ai-panel" role="dialog" aria-label="OBULU AI assistant" aria-modal="false">
      <div className="obulu-ai-header">
        <div className="obulu-ai-title">
          <span className={`obulu-ai-dot ${online === false ? "off" : "on"}`} aria-hidden="true" />
          <div>
            <strong>OBULU AI</strong>
            <span className="obulu-ai-subtitle">Your intelligent football analysis assistant</span>
          </div>
        </div>
        <div className="obulu-ai-status" aria-live="polite">
          {online === null ? "…" : online ? "Online" : "Temporarily unavailable"}
        </div>
        <div className="obulu-ai-header-btns">
          <button
            type="button"
            className="obulu-ai-icon-btn"
            aria-label="New conversation"
            title="New conversation"
            onClick={() => {
              if (messages.some((m) => m.role === "user")) {
                if (!window.confirm("Start a new conversation? Current messages will be cleared.")) return;
              }
              reset();
              setStarted(false);
            }}
          >
            ⟳
          </button>
          <button
            type="button"
            className="obulu-ai-icon-btn"
            aria-label="Minimize OBULU AI assistant"
            title="Minimize"
            onClick={onMinimize}
          >
            —
          </button>
          <button
            type="button"
            className="obulu-ai-icon-btn"
            aria-label="Close OBULU AI assistant"
            title="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="obulu-ai-quick" aria-label="Quick actions">
        {QUICK_ACTIONS.map((q) => (
          <button
            key={q}
            type="button"
            className="obulu-ai-chip"
            disabled={busy}
            onClick={() => doSend(q)}
          >
            {q}
          </button>
        ))}
      </div>

      <div className="obulu-ai-log" ref={logRef} aria-live="polite">
        {showGreeting && (
          <>
            <div className="obulu-ai-row assistant">
              <MessageBubble role="assistant" text={GREETING} />
            </div>
            <div className="obulu-ai-suggest">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="obulu-ai-chip"
                  disabled={busy}
                  onClick={() => doSend(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`obulu-ai-row ${m.role}`}>
            <MessageBubble role={m.role} text={m.text} />
          </div>
        ))}
        {phase === "thinking" && (
          <div className="obulu-ai-row assistant">
            <div className="obulu-ai-bubble obulu-ai-assistant obulu-ai-thinking">
              <span className="obulu-ai-thinking-text">OBULU AI is thinking…</span>
              <span className="obulu-ai-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </div>
          </div>
        )}
        {phase === "error" && error && (
          <div className="obulu-ai-row assistant">
            <div className="obulu-ai-bubble obulu-ai-error">
              <p>{error.message}</p>
              <div className="obulu-ai-error-actions">
                <button type="button" className="obulu-ai-chip" onClick={retry}>
                  {error.code === "TIMEOUT" ? "Try again" : "Retry"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {phase === "streaming" && (
        <div className="obulu-ai-stop-row">
          <button type="button" className="obulu-ai-chip obulu-ai-stop" onClick={stop} aria-label="Stop generating">
            ■ Stop generating
          </button>
        </div>
      )}

      <form className="obulu-ai-input-row" onSubmit={onSubmit}>
        <label className="visually-hidden" htmlFor="obulu-ai-input">
          Ask OBULU AI
        </label>
        <textarea
          id="obulu-ai-input"
          ref={inputRef}
          className="obulu-ai-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask OBULU AI..."
          rows={1}
          maxLength={1000}
          aria-label="Ask OBULU AI"
        />
        <button
          type="submit"
          className="obulu-ai-send"
          disabled={busy || !input.trim()}
          aria-label="Send message"
        >
          ➤
        </button>
      </form>
      <p className="obulu-ai-disclaimer">
        Answers come from OBULU's statistical model — informational only, not betting advice.
      </p>
    </div>
  );
}

