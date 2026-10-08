// OBULU AI floating button — tiny and eager. The heavy chat panel
// (hook, markdown, UI) loads lazily on first open, so the homepage
// stays fast even if the user never opens the assistant.
import { Suspense, lazy, useState } from "react";
import "./AiAssistant.css";

const AssistantPanel = lazy(() => import("./AssistantPanel.jsx"));

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none">
      <path
        d="M12 2C6.48 2 2 6.14 2 11.25c0 2.92 1.44 5.53 3.7 7.24-.14 1.02-.7 2.5-1.7 3.51 2.06-.2 3.9-1.06 5.02-2.02.96.24 1.96.37 2.98.37 5.52 0 10-4.14 10-9.25S17.52 2 12 2Z"
        fill="currentColor"
        opacity="0.95"
      />
      <circle cx="8.2" cy="11" r="1.4" fill="#0d0d0c" />
      <circle cx="12" cy="11" r="1.4" fill="#0d0d0c" />
      <circle cx="15.8" cy="11" r="1.4" fill="#0d0d0c" />
    </svg>
  );
}

export default function FloatingAssistant() {
  const [open, setOpen] = useState(false);
  const [noticed, setNoticed] = useState(() => {
    try {
      return localStorage.getItem("obulu-ai-noticed") === "1";
    } catch {
      return false;
    }
  });

  const handleOpen = () => {
    setOpen(true);
    if (!noticed) {
      setNoticed(true);
      try {
        localStorage.setItem("obulu-ai-noticed", "1");
      } catch { /* ignore */ }
    }
  };

  return (
    <>
      {!open && (
        <button
          type="button"
          className={`obulu-ai-fab${noticed ? "" : " pulse"}`}
          onClick={handleOpen}
          aria-label="Open OBULU AI assistant"
          title="Ask OBULU AI"
        >
          <ChatIcon />
        </button>
      )}
      {open && (
        <Suspense fallback={null}>
          <AssistantPanel onClose={() => setOpen(false)} onMinimize={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
