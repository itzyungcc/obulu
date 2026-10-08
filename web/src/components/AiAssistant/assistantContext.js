// Tiny page-context store for OBULU AI.
// Pages publish real on-screen data (e.g. the match being analyzed);
// the floating assistant attaches the latest context to each request.
// No sensitive data should ever be put here.
let ctx = null;
const listeners = new Set();

export function setAssistantContext(c) {
  ctx = c || null;
  listeners.forEach((l) => {
    try { l(ctx); } catch { /* ignore */ }
  });
}

export function getAssistantContext() {
  return ctx;
}

export function clearAssistantContext() {
  setAssistantContext(null);
}

export function subscribeAssistantContext(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
