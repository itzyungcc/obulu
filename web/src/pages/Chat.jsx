import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api.js";

const SUGGESTIONS = [
  "Who wins this weekend?",
  "Explain the latest predictions",
  "Any jackpot games I should know about?",
  "How is the automation doing?",
];

export default function Chat() {
  const [configured, setConfigured] = useState(null);
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      text: "Hi, I'm the OBULU assistant. Ask me about upcoming fixtures, predictions, or how the automation is doing — I answer from OBULU's real data.",
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    apiFetch("/chat/status")
      .then((s) => setConfigured(s.configured))
      .catch(() => setConfigured(false));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  async function send(text) {
    const msg = String(text || "").trim();
    if (!msg || sending) return;
    setInput("");
    const history = [...messages, { role: "user", text: msg }].slice(-9);
    setMessages(history);
    setSending(true);
    try {
      const data = await apiFetch("/chat", {
        method: "POST",
        body: {
          message: msg,
          history: history
            .slice(0, -1)
            .map((m) => ({ role: m.role, text: m.text })),
        },
      });
      setMessages((prev) => [...prev, { role: "assistant", text: data.reply }]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text:
            e.code === "CHAT_NOT_CONFIGURED"
              ? "Chat isn't set up on the server yet — the owner needs to add a Gemini API key."
              : e.code === "RATE_LIMITED"
                ? "You're asking a lot — give it a few minutes and try again."
                : "Sorry, I couldn't respond — try again.",
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="page chat-page">
      <h1>OBULU Assistant</h1>
      {configured === false && (
        <p className="muted">
          The assistant isn't connected yet — it needs a Gemini API key on the
          server.
        </p>
      )}

      <div className="chat-log">
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg chat-${m.role}`}>
            <div className="chat-bubble">{m.text}</div>
          </div>
        ))}
        {sending && (
          <div className="chat-msg chat-assistant">
            <div className="chat-bubble typing">
              <span>●</span>
              <span>●</span>
              <span>●</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {messages.length <= 1 && (
        <div className="chat-suggest">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className="btn-small"
              onClick={() => send(s)}
              disabled={sending}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        className="chat-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about fixtures or predictions…"
          maxLength={500}
        />
        <button type="submit" className="btn btn-primary" disabled={sending || !input.trim()}>
          Send
        </button>
      </form>
      <p className="muted small">
        Answers come from OBULU's statistical model — informational only, not
        betting advice.
      </p>
    </div>
  );
}
