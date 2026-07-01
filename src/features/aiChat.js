import { sanitize } from '../ui/templates.js';

// 🚨 SECURITY WARNING: Do not push this to a public GitHub repository!
const API_KEY = 'AIzaSyC91ADdrp0yY16w0dPN67PjUh5Ca3cREwM';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;

// ─── State ─────────────────────────────────────────────────────────────────

let chatHistory = [
  {
    role: 'user',
    parts: [{ text: 'You are Echo, a helpful, friendly, and concise AI assistant for our campus community hub. Keep answers brief and well-formatted using markdown where useful.' }]
  },
  {
    role: 'model',
    parts: [{ text: "Understood! I'm Echo, ready to help the campus community. Ask me anything!" }]
  }
];

let isGenerating = false;
let currentAbortController = null;
let messageCount = 0;
const MAX_HISTORY_PAIRS = 20; // Keep last 20 user+model pairs to avoid token bloat

// ─── Markdown → HTML parser ────────────────────────────────────────────────

function parseMarkdown(raw) {
  let html = sanitize(raw);

  // Code blocks (``` lang ... ```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const label = lang ? `<span class="echo-code-lang">${sanitize(lang)}</span>` : '';
    const copyBtn = `<button class="echo-copy-btn" data-code="${encodeURIComponent(code.trim())}" title="Copy code" aria-label="Copy code">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    </button>`;
    return `<div class="echo-code-block"><div class="echo-code-header">${label}${copyBtn}</div><pre><code>${sanitize(code.trim())}</code></pre></div>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="echo-inline-code">$1</code>');

  // Bold & italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3 class="echo-md-h3">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 class="echo-md-h2">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 class="echo-md-h1">$1</h1>');

  // Unordered lists (group consecutive items)
  html = html.replace(/((?:^[*\-] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(line => `<li>${line.replace(/^[*\-] /, '')}</li>`).join('');
    return `<ul class="echo-list">${items}</ul>`;
  });

  // Ordered lists
  html = html.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(line => `<li>${line.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol class="echo-list echo-list-ol">${items}</ol>`;
  });

  // Horizontal rule
  html = html.replace(/^---$/gm, '<hr class="echo-hr">');

  // Line breaks (only outside block elements)
  html = html.replace(/\n{2,}/g, '</p><p class="echo-para">');
  html = html.replace(/\n/g, '<br>');

  return `<p class="echo-para">${html}</p>`;
}

// ─── History pruning ───────────────────────────────────────────────────────

function getPrunedHistory() {
  const systemPair = chatHistory.slice(0, 2); // Always keep the system prompt pair
  const convo = chatHistory.slice(2);
  const maxItems = MAX_HISTORY_PAIRS * 2;
  const pruned = convo.length > maxItems ? convo.slice(convo.length - maxItems) : convo;
  return [...systemPair, ...pruned];
}

// ─── Suggestions ──────────────────────────────────────────────────────────

const QUICK_SUGGESTIONS = [
  'What events are happening on campus?',
  'Where can I find study groups?',
  'How do I book a meeting room?',
  'What dining options are available today?'
];

// ─── Main setup ───────────────────────────────────────────────────────────

export function setupAiChat() {
  const container   = document.getElementById('ai-chat-messages');
  const input       = document.getElementById('ai-chat-input');
  const form        = document.getElementById('ai-chat-form');
  const submitBtn   = form?.querySelector('button[type="submit"]');

  if (!container || !input || !form) return;

  // ── Inject styles ──────────────────────────────────────────────────────

  if (!document.getElementById('echo-styles')) {
    const style = document.createElement('style');
    style.id = 'echo-styles';
    style.textContent = `
      /* ── Layout ── */
      #ai-chat-messages {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 16px;
        overflow-y: auto;
        scroll-behavior: smooth;
      }

      /* ── Message rows ── */
      .echo-row {
        display: flex;
        align-items: flex-end;
        gap: 8px;
        animation: echo-fade-in 0.2s ease;
      }
      .echo-row--user  { flex-direction: row-reverse; }
      .echo-row--bot   { flex-direction: row; }

      @keyframes echo-fade-in {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      /* ── Avatar ── */
      .echo-avatar {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: -0.3px;
        user-select: none;
      }
      .echo-avatar--bot  { background: #312e81; color: #e0e7ff; }
      .echo-avatar--user { background: #1e3a5f; color: #bfdbfe; }

      /* ── Bubble ── */
      .echo-bubble {
        max-width: min(82%, 600px);
        padding: 10px 14px;
        border-radius: 18px;
        font-size: 14.5px;
        line-height: 1.55;
        position: relative;
        word-break: break-word;
      }
      .echo-bubble--user {
        background: #4f46e5;
        color: #fff;
        border-bottom-right-radius: 4px;
      }
      .echo-bubble--bot {
        background: rgba(39,39,42,0.88);
        backdrop-filter: blur(12px);
        color: #e4e4e7;
        border: 1px solid rgba(63,63,70,0.6);
        border-bottom-left-radius: 4px;
      }

      /* ── Bubble meta row ── */
      .echo-meta {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 4px;
        padding: 0 2px;
        opacity: 0;
        transition: opacity 0.15s;
        pointer-events: none;
      }
      .echo-row:hover .echo-meta { opacity: 1; pointer-events: auto; }
      .echo-meta-time {
        font-size: 11px;
        color: #71717a;
      }
      .echo-meta-action {
        font-size: 11px;
        color: #6366f1;
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
        display: flex;
        align-items: center;
        gap: 3px;
        transition: color 0.15s;
      }
      .echo-meta-action:hover { color: #818cf8; }
      .echo-meta-action svg { flex-shrink: 0; }

      /* ── Typing indicator ── */
      .echo-typing {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 12px 14px;
        background: rgba(39,39,42,0.88);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(63,63,70,0.6);
        border-radius: 18px;
        border-bottom-left-radius: 4px;
        width: fit-content;
      }
      .echo-typing span {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #818cf8;
        animation: echo-bounce 1.2s infinite ease-in-out;
      }
      .echo-typing span:nth-child(2) { animation-delay: 0.2s; }
      .echo-typing span:nth-child(3) { animation-delay: 0.4s; }
      @keyframes echo-bounce {
        0%, 80%, 100% { transform: scale(0.7); opacity: 0.5; }
        40%            { transform: scale(1.1); opacity: 1; }
      }

      /* ── Stop button ── */
      .echo-stop-btn {
        display: none;
        align-items: center;
        gap: 6px;
        padding: 6px 14px;
        border-radius: 20px;
        background: rgba(239,68,68,0.15);
        border: 1px solid rgba(239,68,68,0.4);
        color: #f87171;
        font-size: 12px;
        cursor: pointer;
        transition: background 0.15s;
        margin: 8px auto;
      }
      .echo-stop-btn:hover { background: rgba(239,68,68,0.25); }
      .echo-stop-btn.visible { display: flex; }

      /* ── Suggestions ── */
      .echo-suggestions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 8px 16px 4px;
      }
      .echo-suggestion-pill {
        background: rgba(99,102,241,0.1);
        border: 1px solid rgba(99,102,241,0.3);
        color: #a5b4fc;
        font-size: 12.5px;
        padding: 5px 12px;
        border-radius: 20px;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
        white-space: nowrap;
      }
      .echo-suggestion-pill:hover {
        background: rgba(99,102,241,0.2);
        border-color: rgba(99,102,241,0.5);
      }

      /* ── Markdown styles (inside bot bubbles) ── */
      .echo-para { margin: 0 0 6px; }
      .echo-para:last-child { margin-bottom: 0; }
      .echo-md-h1 { font-size: 16px; font-weight: 700; margin: 8px 0 4px; color: #e4e4e7; }
      .echo-md-h2 { font-size: 14px; font-weight: 700; margin: 6px 0 3px; color: #d4d4d8; }
      .echo-md-h3 { font-size: 13.5px; font-weight: 600; margin: 6px 0 3px; color: #a1a1aa; }
      .echo-list  { margin: 4px 0 4px 16px; padding: 0; }
      .echo-list li { margin-bottom: 2px; }
      .echo-list-ol { list-style-type: decimal; }
      .echo-hr { border: none; border-top: 1px solid rgba(63,63,70,0.8); margin: 8px 0; }

      /* Code block */
      .echo-code-block {
        background: rgba(9,9,11,0.6);
        border: 1px solid rgba(63,63,70,0.7);
        border-radius: 8px;
        margin: 8px 0;
        overflow: hidden;
        font-size: 13px;
      }
      .echo-code-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 5px 10px;
        background: rgba(24,24,27,0.8);
        border-bottom: 1px solid rgba(63,63,70,0.5);
      }
      .echo-code-lang { font-size: 11px; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px; }
      .echo-code-block pre { margin: 0; padding: 10px 12px; overflow-x: auto; }
      .echo-code-block code { color: #a78bfa; line-height: 1.5; white-space: pre; }
      .echo-inline-code {
        background: rgba(24,24,27,0.7);
        color: #a78bfa;
        padding: 1px 5px;
        border-radius: 4px;
        font-size: 13px;
        font-family: ui-monospace, 'Cascadia Code', monospace;
      }

      /* Copy button inside code block */
      .echo-copy-btn {
        background: none;
        border: none;
        color: #71717a;
        cursor: pointer;
        padding: 2px;
        border-radius: 4px;
        display: flex;
        transition: color 0.15s;
      }
      .echo-copy-btn:hover { color: #a1a1aa; }
      .echo-copy-btn.copied { color: #4ade80; }

      /* ── Character counter ── */
      .echo-char-counter {
        font-size: 11px;
        color: #52525b;
        transition: color 0.2s;
      }
      .echo-char-counter.warn { color: #f59e0b; }
      .echo-char-counter.over { color: #f87171; }

      /* ── Token / status bar ── */
      .echo-status-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 16px 8px;
        font-size: 11px;
        color: #52525b;
      }
      .echo-status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #4ade80;
        display: inline-block;
        margin-right: 5px;
        flex-shrink: 0;
      }
      .echo-status-dot.generating { background: #f59e0b; animation: echo-pulse 1s infinite; }
      @keyframes echo-pulse {
        0%,100% { opacity: 1; } 50% { opacity: 0.3; }
      }

      /* ── Scroll-to-bottom button ── */
      .echo-scroll-btn {
        position: absolute;
        bottom: 80px;
        right: 20px;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: rgba(39,39,42,0.9);
        border: 1px solid rgba(63,63,70,0.6);
        color: #a1a1aa;
        cursor: pointer;
        display: none;
        align-items: center;
        justify-content: center;
        transition: background 0.15s;
        z-index: 10;
      }
      .echo-scroll-btn.visible { display: flex; }
      .echo-scroll-btn:hover { background: rgba(63,63,70,0.9); }

      /* ── Error bubble ── */
      .echo-bubble--error {
        background: rgba(127,29,29,0.3);
        border-color: rgba(239,68,68,0.3);
        color: #fca5a5;
      }

      /* ── Empty state ── */
      .echo-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 40px 20px;
        color: #52525b;
        text-align: center;
      }
      .echo-empty-icon {
        width: 48px;
        height: 48px;
        border-radius: 50%;
        background: rgba(99,102,241,0.1);
        border: 1px solid rgba(99,102,241,0.2);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .echo-empty h3 { font-size: 15px; color: #a1a1aa; margin: 0; font-weight: 600; }
      .echo-empty p  { font-size: 13px; margin: 0; max-width: 240px; line-height: 1.5; }
    `;
    document.head.appendChild(style);
  }

  // ── Inject empty state ────────────────────────────────────────────────

  container.innerHTML = `
    <div class="echo-empty" id="echo-empty-state">
      <div class="echo-empty-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      </div>
      <h3>Echo is ready</h3>
      <p>Ask me about campus events, study resources, or anything else!</p>
    </div>
  `;

  // ── Inject suggestions strip ──────────────────────────────────────────

  const suggestionsEl = document.createElement('div');
  suggestionsEl.className = 'echo-suggestions';
  suggestionsEl.id = 'echo-suggestions';
  suggestionsEl.setAttribute('aria-label', 'Suggested questions');
  QUICK_SUGGESTIONS.forEach(text => {
    const pill = document.createElement('button');
    pill.className = 'echo-suggestion-pill';
    pill.textContent = text;
    pill.addEventListener('click', () => submitMessage(text));
    suggestionsEl.appendChild(pill);
  });
  container.parentElement?.insertBefore(suggestionsEl, container.nextSibling);

  // ── Inject status bar ─────────────────────────────────────────────────

  const statusBar = document.createElement('div');
  statusBar.className = 'echo-status-bar';
  statusBar.innerHTML = `
    <span><span class="echo-status-dot" id="echo-status-dot"></span><span id="echo-status-text">Echo is online</span></span>
    <span><span class="echo-char-counter" id="echo-char-counter">0 / 2000</span></span>
  `;
  suggestionsEl.parentElement?.insertBefore(statusBar, suggestionsEl);

  // ── Inject stop button & scroll-to-bottom ────────────────────────────

  const stopBtn = document.createElement('button');
  stopBtn.className = 'echo-stop-btn';
  stopBtn.id = 'echo-stop-btn';
  stopBtn.setAttribute('aria-label', 'Stop generating');
  stopBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/></svg> Stop generating`;
  stopBtn.addEventListener('click', stopGenerating);
  container.parentElement?.insertBefore(stopBtn, container.nextSibling);

  const scrollBtn = document.createElement('button');
  scrollBtn.className = 'echo-scroll-btn';
  scrollBtn.id = 'echo-scroll-btn';
  scrollBtn.setAttribute('aria-label', 'Scroll to bottom');
  scrollBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;
  scrollBtn.addEventListener('click', scrollToBottom);

  const wrapperParent = container.parentElement;
  if (wrapperParent) {
    wrapperParent.style.position = 'relative';
    wrapperParent.appendChild(scrollBtn);
  }

  // ── Scroll detection ──────────────────────────────────────────────────

  container.addEventListener('scroll', () => {
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
    scrollBtn.classList.toggle('visible', !atBottom);
  });

  // ── Char counter + auto-resize ────────────────────────────────────────

  const MAX_CHARS = 2000;
  const charCounter = document.getElementById('echo-char-counter');

  input.setAttribute('maxlength', MAX_CHARS);
  input.addEventListener('input', () => {
    const len = input.value.length;
    charCounter.textContent = `${len} / ${MAX_CHARS}`;
    charCounter.className = 'echo-char-counter' + (len > MAX_CHARS * 0.9 ? ' warn' : '') + (len >= MAX_CHARS ? ' over' : '');

    // Auto-resize textarea if applicable
    if (input.tagName === 'TEXTAREA') {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    }
  });

  // Shift+Enter for newline if textarea; Enter submits
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && input.tagName === 'TEXTAREA') {
      e.preventDefault();
      form.requestSubmit?.() || form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  });

  // ── Helpers ────────────────────────────────────────────────────────────

  function scrollToBottom() {
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }

  function formatTime(date = new Date()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function setStatus(text, generating = false) {
    const dot  = document.getElementById('echo-status-dot');
    const span = document.getElementById('echo-status-text');
    if (dot)  dot.className  = 'echo-status-dot' + (generating ? ' generating' : '');
    if (span) span.textContent = text;
  }

  function setInputDisabled(disabled) {
    input.disabled = disabled;
    if (submitBtn) submitBtn.disabled = disabled;
    input.placeholder = disabled ? 'Echo is thinking…' : 'Ask Echo anything…';
    stopBtn.classList.toggle('visible', disabled);
  }

  function hideEmptyState() {
    document.getElementById('echo-empty-state')?.remove();
    document.getElementById('echo-suggestions')?.remove();
  }

  function hideSuggestions() {
    document.getElementById('echo-suggestions')?.remove();
  }

  // ── Stop generation ───────────────────────────────────────────────────

  function stopGenerating() {
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
  }

  // ── Copy handler (delegated) ──────────────────────────────────────────

  container.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.echo-copy-btn');
    if (copyBtn) {
      const code = decodeURIComponent(copyBtn.dataset.code || '');
      navigator.clipboard.writeText(code).then(() => {
        copyBtn.classList.add('copied');
        setTimeout(() => copyBtn.classList.remove('copied'), 1500);
      });
    }
  });

  // ── Append a message row ──────────────────────────────────────────────

  function appendMessage({ text, sender, id = null, isError = false }) {
    hideEmptyState();

    const isUser   = sender === 'user';
    const rowClass = isUser ? 'echo-row--user' : 'echo-row--bot';
    const bubbleCls = isUser
      ? 'echo-bubble--user'
      : (isError ? 'echo-bubble--bot echo-bubble--error' : 'echo-bubble--bot');

    const initials = isUser ? 'YOU' : 'AI';
    const avatarCls = isUser ? 'echo-avatar--user' : 'echo-avatar--bot';
    const content = isUser ? sanitize(text) : parseMarkdown(text);
    const time = formatTime();

    const idAttr = id ? `id="${sanitize(id)}"` : '';
    const msgId = `msg-${Date.now()}-${++messageCount}`;

    const copyMsgBtn = !isUser ? `
      <button class="echo-meta-action echo-copy-msg" data-target="${msgId}" aria-label="Copy message">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy
      </button>
    ` : '';

    const retryBtn = !isUser ? `
      <button class="echo-meta-action echo-retry-btn" aria-label="Retry">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        Retry
      </button>
    ` : '';

    container.insertAdjacentHTML('beforeend', `
      <div class="echo-row ${rowClass}">
        <div class="echo-avatar ${avatarCls}" aria-hidden="true">${initials}</div>
        <div>
          <div ${idAttr} id="${msgId}" class="echo-bubble ${bubbleCls}" role="${isUser ? 'note' : 'article'}">${content}</div>
          <div class="echo-meta" role="toolbar" aria-label="Message actions">
            <span class="echo-meta-time">${time}</span>
            ${copyMsgBtn}
            ${retryBtn}
          </div>
        </div>
      </div>
    `);

    scrollToBottom();
    return msgId;
  }

  // ── Delegated: copy message & retry ───────────────────────────────────

  container.addEventListener('click', (e) => {
    // Copy message text
    const copyMsg = e.target.closest('.echo-copy-msg');
    if (copyMsg) {
      const target = document.getElementById(copyMsg.dataset.target);
      if (target) {
        navigator.clipboard.writeText(target.innerText).then(() => {
          copyMsg.textContent = 'Copied!';
          setTimeout(() => { copyMsg.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2 2v1"/></svg> Copy`; }, 1500);
        });
      }
    }

    // Retry: re-submit the last user message
    const retryBtn = e.target.closest('.echo-retry-btn');
    if (retryBtn && !isGenerating) {
      // Find last user message in history
      const lastUser = [...chatHistory].reverse().find(m => m.role === 'user');
      if (lastUser) submitMessage(lastUser.parts[0].text, true);
    }
  });

  // ── Core: submit + call API ───────────────────────────────────────────

  async function submitMessage(text, isRetry = false) {
    if (!text || isGenerating) return;
    hideSuggestions();

    if (!isRetry) appendMessage({ text, sender: 'user' });

    chatHistory.push({ role: 'user', parts: [{ text }] });
    isGenerating = true;
    setInputDisabled(true);
    setStatus('Echo is thinking…', true);

    // Typing indicator
    const typingRow = document.createElement('div');
    typingRow.className = 'echo-row echo-row--bot';
    typingRow.id = 'echo-typing-row';
    typingRow.innerHTML = `
      <div class="echo-avatar echo-avatar--bot" aria-hidden="true">AI</div>
      <div class="echo-typing" role="status" aria-live="polite" aria-label="Echo is typing">
        <span></span><span></span><span></span>
      </div>
    `;
    container.appendChild(typingRow);
    scrollToBottom();

    currentAbortController = new AbortController();

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: currentAbortController.signal,
        body: JSON.stringify({ contents: getPrunedHistory() })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error?.message || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const botReply = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!botReply) throw new Error('Empty response from API.');

      chatHistory.push({ role: 'model', parts: [{ text: botReply }] });
      typingRow.remove();
      appendMessage({ text: botReply, sender: 'bot' });
      setStatus('Echo is online');

    } catch (err) {
      typingRow.remove();
      chatHistory.pop(); // Remove failed user turn

      if (err.name === 'AbortError') {
        setStatus('Generation stopped', false);
        appendMessage({ text: 'Generation stopped.', sender: 'bot' });
      } else {
        console.error('Echo API error:', err);
        const isQuota = err.message.includes('429') || err.message.toLowerCase().includes('quota');
        const msg = isQuota
          ? 'Rate limit reached. Please wait a moment before sending another message.'
          : `Something went wrong: ${err.message}`;
        appendMessage({ text: msg, sender: 'bot', isError: true });
        setStatus('Echo encountered an error');
      }
    } finally {
      isGenerating = false;
      currentAbortController = null;
      setInputDisabled(false);
      input.focus();
    }
  }

  // ── Form submit ───────────────────────────────────────────────────────

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || isGenerating) return;
    input.value = '';
    charCounter.textContent = `0 / ${MAX_CHARS}`;
    if (input.tagName === 'TEXTAREA') input.style.height = 'auto';
    submitMessage(text);
  });
}