// Safe mini-markdown for OBULU AI messages.
// 1. Escape ALL HTML first (Gemini output is untrusted).
// 2. Apply a small formatting subset: headings, bold, italic,
//    bullet lists, numbered lists, paragraphs, line breaks.
// Returns an HTML string safe to inject via dangerouslySetInnerHTML.

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inline(s) {
  // Bold **text**, italic *text*. Order matters: bold first.
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

export function renderMessage(text) {
  const src = escapeHtml(String(text || ""));
  const lines = src.split("\n");
  const out = [];
  let list = null; // "ul" | "ol" | null

  const closeList = () => {
    if (list) {
      out.push(list === "ul" ? "</ul>" : "</ol>");
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    // Headings: ## ... / ### ...
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      const level = Math.min(h[1].length + 1, 4);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    // Bullet list: - item  or * item
    const b = line.match(/^[-*]\s+(.*)$/);
    if (b) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(b[1])}</li>`);
      continue;
    }
    // Numbered list: 1. item
    const n = line.match(/^\d+[.)]\s+(.*)$/);
    if (n) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(n[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("");
}
