// OBULU AI chat state machine + SSE transport.
// States: idle | thinking | streaming | error
// Every request ends in exactly one terminal state: completed | error | stopped.
import { useCallback, useEffect, useRef, useState } from "react";
import { getAssistantContext } from "./assistantContext.js";

const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
// Absolute backstop: the backend caps at 75s, so this should never fire first.
const FRONTEND_TIMEOUT_MS = 90000;
const HISTORY_WINDOW = 8;

function apiUrl(path) {
  return `${API_BASE}/api${path}`;
}

async function postJson(url, body, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.error || "REQUEST_FAILED";
    throw err;
  }
  return data ?? {};
}

// Map backend error codes to UI-facing error states.
function toUiError(e) {
  if (e.code === "RATE_LIMITED" || e.status === 429) {
    return { code: "RATE_LIMITED", message: "OBULU AI is currently busy. Please try again in a moment." };
  }
  if (e.code === "TIMEOUT") {
    return { code: "TIMEOUT", message: "OBULU AI is taking too long to respond." };
  }
  if (e.code === "CHAT_NOT_CONFIGURED") {
    return { code: "UNAVAILABLE", message: "OBULU AI isn't connected yet. Please try again later." };
  }
  if (e.code === "EMPTY_RESPONSE") {
    return { code: "EMPTY", message: "OBULU AI couldn't generate a response this time. Please try again." };
  }
  if (e.name === "AbortError" || e.code === "CANCELLED") {
    return { code: "STOPPED", message: "" };
  }
  if (e.code === "NETWORK_ERROR" || e.status === 0 || /network|fetch|failed/i.test(e.message || "")) {
    return { code: "NETWORK", message: "Connection interrupted. Please check your internet connection and try again." };
  }
  return { code: "UPSTREAM", message: "OBULU AI is temporarily unavailable. Please try again." };
}

// Parse a Gemini-style SSE stream; yields {event, data} objects.
async function* parseSse(reader) {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const chunk of parts) {
      event = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      yield { event, data };
    }
  }
}

export function useAssistantChat() {
  const [messages, setMessages] = useState([]);
  const [phase, setPhase] = useState("idle"); // idle|thinking|streaming|error
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  const busyRef = useRef(false);
  const idRef = useRef(0);

  const pushMessage = useCallback((role, text) => {
    const id = ++idRef.current;
    setMessages((prev) => [...prev, { id, role, text }]);
    return id;
  }, []);

  const appendToMessage = useCallback((id, delta) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: m.text + delta } : m)));
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    busyRef.current = false;
    setMessages([]);
    setError(null);
    setPhase("idle");
  }, []);

  // Non-streaming fallback (POST /api/chat). Used only when the SSE
  // request fails before ANY token arrives — avoids duplicate charges.
  const fallbackChat = useCallback(async (body, signal, timeoutId) => {
    const data = await postJson(apiUrl("/chat"), body, signal);
    return data.reply || "";
  }, []);

  const send = useCallback(
    async (rawText) => {
      const text = String(rawText || "").trim();
      if (!text || busyRef.current) return;
      busyRef.current = true;
      setError(null);

      const history = [...messages, { role: "user", text }]
        .map((m) => ({ role: m.role, text: m.text }))
        .slice(-HISTORY_WINDOW);
      const context = getAssistantContext();
      const body = { message: text, history: history.slice(0, -1), context };

      pushMessage("user", text);
      const aiId = pushMessage("assistant", "");
      setPhase("thinking");

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const timeoutId = setTimeout(() => ctrl.abort(), FRONTEND_TIMEOUT_MS);
      let gotToken = false;

      try {
        let res;
        try {
          res = await fetch(apiUrl("/assistant/stream"), {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
        } catch (e) {
          throw Object.assign(new Error("NETWORK_ERROR"), { code: "NETWORK_ERROR", cause: e });
        }

        if (!res.ok || !res.body) {
          let code = "UPSTREAM";
          try {
            const j = await res.json();
            if (j?.error) code = j.error;
          } catch { /* ignore */ }
          const err = new Error("stream rejected");
          err.code = code;
          err.status = res.status;
          throw err;
        }

        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("text/event-stream")) {
          throw Object.assign(new Error("bad stream"), { code: "UPSTREAM" });
        }

        setPhase("streaming");
        const reader = res.body.getReader();
        let receivedText = "";
        try {
          for await (const { event, data } of parseSse(reader)) {
            if (ctrl.signal.aborted) break;
            if (event === "token") {
              let text_delta = "";
              try {
                text_delta = JSON.parse(data)?.text || "";
              } catch { /* ignore */ }
              if (text_delta) {
                gotToken = true;
                receivedText += text_delta;
                appendToMessage(aiId, text_delta);
              }
            } else if (event === "done") {
              break;
            } else if (event === "error") {
              let code = "UPSTREAM";
              try {
                code = JSON.parse(data)?.code || code;
              } catch { /* ignore */ }
              const err = new Error("stream error");
              err.code = code;
              throw err;
            }
          }
        } finally {
          try { reader.releaseLock(); } catch { /* ignore */ }
        }

        // Empty stream: treat as an empty response (retryable).
        if (!receivedText.trim()) {
          const err = new Error("empty");
          err.code = "EMPTY_RESPONSE";
          throw err;
        }
        setPhase("idle");
      } catch (e) {
        // Fallback: plain /api/chat, but ONLY if nothing streamed yet.
        if (!gotToken && e.code !== "CANCELLED" && e.name !== "AbortError") {
          try {
            const reply = await fallbackChat(body, ctrl.signal, timeoutId);
            if (reply.trim()) {
              setMessages((prev) => prev.map((m) => (m.id === aiId ? { ...m, text: reply.trim() } : m)));
              setPhase("idle");
              return;
            }
            const err = new Error("empty");
            err.code = "EMPTY_RESPONSE";
            throw err;
          } catch (fe) {
            if (fe.name !== "AbortError" && fe.code !== "CANCELLED") {
              e = fe.code ? fe : e;
            }
          }
        }
        const ui = toUiError(e);
        if (ui.code === "STOPPED") {
          // Keep partial text; back to idle so the user can continue.
          setPhase("idle");
        } else {
          // Remove the empty AI bubble on hard failure; show retry.
          setMessages((prev) => {
            const m = prev.find((x) => x.id === aiId);
            if (m && !m.text.trim()) return prev.filter((x) => x.id !== aiId);
            return prev;
          });
          setError({ ...ui, retryText: text });
          setPhase("error");
        }
      } finally {
        clearTimeout(timeoutId);
        busyRef.current = false;
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    },
    [messages, pushMessage, appendToMessage, fallbackChat]
  );

  const retry = useCallback(() => {
    if (error?.retryText) {
      setError(null);
      setPhase("idle");
      send(error.retryText);
    }
  }, [error, send]);

  // Abort any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    messages,
    phase, // idle|thinking|streaming|error
    error,
    send,
    stop,
    retry,
    reset,
    busy: phase === "thinking" || phase === "streaming",
  };
}
