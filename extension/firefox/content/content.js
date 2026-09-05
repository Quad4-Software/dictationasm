/**
 * Content script: page text collection, translation apply, toasts.
 */

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "CODE", "PRE", "KBD", "SVG", "MATH", "IFRAME"]);

function showToast(text, mode = "info") {
  let el = document.getElementById("asm-ext-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "asm-ext-toast";
    el.setAttribute("role", "status");
    document.documentElement.appendChild(el);
  }
  el.dataset.mode = mode;
  el.textContent = text;
  el.classList.add("asm-ext-toast-visible");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("asm-ext-toast-visible"), 3200);
}

function isVisible(node) {
  const el = node.parentElement;
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  return true;
}

function collectTextNodes() {
  const nodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || SKIP.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (!isVisible(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  return nodes;
}

function chunkNodes(nodes, maxLen = 900) {
  const chunks = [];
  const map = [];
  let buf = "";
  let group = [];
  for (const node of nodes) {
    const t = node.nodeValue;
    if (buf.length + t.length > maxLen && buf) {
      chunks.push(buf);
      map.push(group);
      buf = "";
      group = [];
    }
    buf += (buf ? "\n" : "") + t;
    group.push(node);
  }
  if (buf) {
    chunks.push(buf);
    map.push(group);
  }
  return { chunks, map };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "ping-content") {
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "show-toast") {
      showToast(msg.text || "", msg.mode || "info");
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "get-selection") {
      sendResponse({ text: window.getSelection()?.toString() || "" });
      return;
    }
    if (msg?.type === "replace-selection") {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) {
        showToast(msg.text || "", "ok");
        sendResponse({ ok: true });
        return;
      }
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(msg.text || ""));
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "collect-page-text") {
      const nodes = collectTextNodes();
      const { chunks, map } = chunkNodes(nodes);
      globalThis.__asmExtMap = map;
      for (const node of nodes) {
        if (node.__asmOrig == null) node.__asmOrig = node.nodeValue;
      }
      sendResponse({ chunks });
      return;
    }
    if (msg?.type === "apply-page-translation") {
      const map = globalThis.__asmExtMap || [];
      const chunks = msg.chunks || [];
      const BATCH = 12;
      for (let i = 0; i < map.length; i++) {
        const group = map[i];
        const translated = String(chunks[i] || "");
        const parts = translated.split("\n");
        await new Promise((r) => requestAnimationFrame(() => {
          for (let j = 0; j < group.length; j++) {
            const node = group[j];
            if (node && node.nodeType === Node.TEXT_NODE) {
              node.nodeValue = parts[j] != null ? parts[j] : translated;
            }
          }
          r();
        }));
        if (i % BATCH === 0 && globalThis.scheduler?.yield) await scheduler.yield();
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "restore-page") {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (n.__asmOrig != null) n.nodeValue = n.__asmOrig;
      }
      showToast("Original text restored.", "ok");
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false });
  })();
  return true;
});
