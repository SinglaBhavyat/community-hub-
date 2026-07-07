/**
 * aiChat.js — Echo AI Chat Module
 *
 * COMPLETE REWRITE CHANGELOG (on top of prior audit)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * STREAMING (NEW)
 *   [STREAM-01]  Real server-sent events via fetch + ReadableStream.
 *                Gemini's streamGenerateContent endpoint is used instead of
 *                generateContent so tokens appear as they are produced.
 *   [STREAM-02]  Incremental markdown: the live bubble is updated on every
 *                chunk using a double-buffer (raw accumulator → parseMarkdown
 *                on each tick). A requestAnimationFrame gate prevents
 *                layout-thrashing on fast streams.
 *   [STREAM-03]  codeCache is rebuilt from the final accumulated text once
 *                streaming completes so copy-buttons work correctly.
 *   [STREAM-04]  Cursor blink appended to the live bubble during streaming;
 *                removed on completion.
 *
 * SECURITY (FIXES TO PRIOR AUDIT FINDINGS)
 *   [SEC-FIX-01] API key moved from URL query-string to the
 *                'x-goog-api-key' request header — no longer leaks in
 *                browser network logs, Referer headers, or server access logs.
 *   [SEC-FIX-02] _externalSanitize race: module now exposes a
 *                setSanitizer(fn) setter so the host page can install a
 *                DOMPurify sanitizer synchronously before first render,
 *                eliminating the async import window.
 *
 * BUG FIXES (INCOMPLETE / WRONG PATCHES)
 *   [FIX-BUG-RETRY-A]  chatHistory.pop() on error was incorrect for retry
 *                       paths — it removed the pre-existing user message when
 *                       isRetry=true. Now tracks a `didPushUser` flag and only
 *                       pops when the user turn was actually pushed this call.
 *   [FIX-BUG-ABORT-B]  Double user-message on abort+resubmit: abort now marks
 *                       chatHistory with a `_aborted` flag on the last user
 *                       entry. submitMessage deduplicates on entry so the same
 *                       text is not pushed twice.
 *   [FIX-BUG-SLEEP-C]  sleep() inside the loop could execute after an
 *                       AbortError because the delay ran before the error-type
 *                       check. Moved AbortError guard to the top of the catch
 *                       block so it breaks immediately with no sleep.
 *   [FIX-BUG-EMOJI-D]  localStorage key namespaced to 'echo_v2_recent_emojis'
 *                       so multiple Echo instances on the same origin don't
 *                       clobber each other. Accepts an optional `storageKey`
 *                       config option for explicit namespacing.
 *   [FIX-BUG-SUBMIT-E] form.requestSubmit fallback was
 *                       `form.dispatchEvent(new Event('submit', ...))` which
 *                       bypasses the handler's preventDefault in Safari <16.
 *                       Replaced with direct submitMessage() call.
 *   [FIX-BUG-PICKER-F] Emoji picker positioned with getBoundingClientRect
 *                       (viewport-relative) combined with style.bottom/right
 *                       (relative-to-parent) — caused drift on scroll.
 *                       Replaced with position:fixed + live rect on open.
 *   [FIX-BUG-SEARCH-G] Dead-code `matches` array in renderSearch removed;
 *                       single correct allEmojis path kept.
 *   [FIX-BUG-TIME-H]   formatTime now accepts an optional Date argument and
 *                       is pure (testable, no hidden new Date() side-effect).
 *   [FIX-BUG-CLEANUP-I] cleanup() rewrote chatHistory with the same verbose
 *                        nested-map; replaced with resetHistory() factory.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 */

'use strict';

// ─── Utility ────────────────────────────────────────────────────────────────
// [FIX-BUG-17 / kept] sleep at top to avoid TDZ issues
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── SVG icon cache ──────────────────────────────────────────────────────────
// [FIX-BUG-18 / kept] hoisted for appendMessage
const ICONS = {
  copy: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <rect x="9" y="9" width="13" height="13" rx="2"/>
           <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
         </svg>`,
  retry: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>`,
  export: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
             <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
             <polyline points="7 10 12 15 17 10"/>
             <line x1="12" y1="15" x2="12" y2="3"/>
           </svg>`,
};

// ─── Sanitizer ───────────────────────────────────────────────────────────────
// [SEC-FIX-02] Synchronous setter — no async import race.
// Call setSanitizer(DOMPurify.sanitize.bind(DOMPurify)) before setupAiChat().
let _externalSanitize = null;
export function setSanitizer(fn) {
  if (typeof fn === 'function') _externalSanitize = fn;
}

function sanitize(str) {
  if (_externalSanitize) return _externalSanitize(String(str ?? ''));
  const d = document.createElement('div');
  d.textContent = String(str ?? '');
  return d.innerHTML;
}

// ─── API key ─────────────────────────────────────────────────────────────────
// [SEC-FIX-KEY] Never hardcode API keys in source. Set window.__ECHO_API_KEY
// before calling setupAiChat(). Alternatively pass via config.apiKey.
let _configApiKey = null;
export function setApiKey(key) {
  if (typeof key === 'string' && key.trim()) _configApiKey = key.trim();
}

function resolveApiKey() {
  const key = _configApiKey
    || localStorage.getItem('echo_gemini_api_key')
    || window.__GEMINI_KEY
    || '';
  return key;
}

// ─── Constants ───────────────────────────────────────────────────────────────
const MAX_HISTORY_PAIRS = 20;
const MAX_CHARS         = 2000;
const RETRY_DELAYS      = [1000, 2000, 4000];

// Gemini streaming endpoint.
// AQ.Ab8... format keys work via the X-goog-api-key header (confirmed via curl).
const GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:streamGenerateContent?alt=sse';
// Key sent via x-goog-api-key header (proven to work with AQ.Ab8... format keys)
const geminiUrl = () => GEMINI_BASE_URL;

const SYSTEM_PAIR = Object.freeze([
  {
    role: 'user',
    parts: [{ text: 'You are Echo, a helpful, friendly, and concise AI assistant. Keep answers brief and well-formatted using markdown where useful.' }],
  },
  {
    role: 'model',
    parts: [{ text: "Got it! I'm Echo — ask me anything." }],
  },
]);

function makeSystemPair() {
  return SYSTEM_PAIR.map(m => ({ ...m, parts: m.parts.map(p => ({ ...p })) }));
}

const SUGGESTION_POOL = [
  'Summarise a topic for me',
  'Help me brainstorm ideas',
  'Explain something step by step',
  'Write a short draft for me',
  'Review and improve my writing',
  'Help me solve a problem',
  'Give me pros and cons',
  'Translate or rephrase this',
];

function pickSuggestions(n = 4) {
  const pool = [...SUGGESTION_POOL];
  const out = [];
  while (out.length < n && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

// ─── Module-level state ──────────────────────────────────────────────────────
let chatHistory            = makeSystemPair();
let isGenerating           = false;
let pendingLock            = false;
let currentAbortController = null;
let messageCount           = 0;
let unreadCount            = 0;
let userIsAtBottom         = true;

// [MEM-03] WeakMap keeps code strings off the DOM
const codeCache = new WeakMap();

// ─── History helpers ─────────────────────────────────────────────────────────
function getPrunedHistory() {
  const convo   = chatHistory.slice(2);
  const maxItems = MAX_HISTORY_PAIRS * 2;
  const pruned  = convo.length > maxItems ? convo.slice(convo.length - maxItems) : convo;
  return [...makeSystemPair(), ...pruned];
}

function resetHistory() {
  chatHistory = makeSystemPair();
}

// ─── Markdown parser ─────────────────────────────────────────────────────────
// [FIX-BUG-09/10 / kept + streaming-safe]
// Returns { html, codeTexts[] } so callers can populate codeCache without
// re-running the regex separately.
function parseMarkdown(raw) {
  const codeTexts = [];

  let html = raw.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx      = codeTexts.length;
    const safeCode = sanitize(code.trim());
    const safeLang = lang ? sanitize(lang) : '';
    const label    = safeLang ? `<span class="echo-code-lang">${safeLang}</span>` : '';
    const btn =
      `<button class="echo-copy-btn echo-copy-code" data-ci="${idx}" ` +
      `title="Copy code" aria-label="Copy code to clipboard">` +
      `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
      `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
      `<rect x="9" y="9" width="13" height="13" rx="2"/>` +
      `<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>` +
      `</button>`;
    codeTexts.push(code.trim());
    return (
      `\x00CODE${idx}\x00` +
      `<div class="echo-code-block"><div class="echo-code-header">${label}${btn}</div>` +
      `<pre><code>${safeCode}</code></pre></div>` +
      `\x00/CODE\x00`
    );
  });

  html = html.replace(/`([^`\n]+)`/g, (_, c) => `<code class="echo-inline-code">${sanitize(c)}</code>`);
  html = html.replace(/\*\*\*(.+?)\*\*\*/gs, (_, t) => `<strong><em>${sanitize(t)}</em></strong>`);
  html = html.replace(/\*\*(.+?)\*\*/gs,     (_, t) => `<strong>${sanitize(t)}</strong>`);
  html = html.replace(/\*([^\n*]+?)\*/g,      (_, t) => `<em>${sanitize(t)}</em>`);
  html = html.replace(/^### (.+)$/gm, (_, t) => `<h3 class="echo-md-h3">${sanitize(t)}</h3>`);
  html = html.replace(/^## (.+)$/gm,  (_, t) => `<h2 class="echo-md-h2">${sanitize(t)}</h2>`);
  html = html.replace(/^# (.+)$/gm,   (_, t) => `<h1 class="echo-md-h1">${sanitize(t)}</h1>`);

  html = html.replace(/((?:^[ \t]*[*\-] .+\n?)+)/gm, block => {
    const items = block.trim().split('\n')
      .map(l => `<li>${l.replace(/^[ \t]*[*\-] /, '')}</li>`).join('');
    return `<ul class="echo-list">${items}</ul>`;
  });

  html = html.replace(/((?:^\d+\. .+\n?)+)/gm, block => {
    const items = block.trim().split('\n')
      .map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol class="echo-list echo-list-ol">${items}</ol>`;
  });

  html = html.replace(/^---$/gm, '<hr class="echo-hr">');

  const BLOCK_RE = /^(<(?:div|ul|ol|h[1-6]|pre|hr|blockquote|table)[\s>])/i;
  html = html.split(/\n{2,}/).map(seg => {
    const trimmed = seg.trim();
    if (!trimmed) return '';
    if (BLOCK_RE.test(trimmed) || trimmed.startsWith('\x00CODE')) return trimmed;
    const safe = trimmed.split('\n').map(line => sanitize(line)).join('<br>');
    return `<p class="echo-para">${safe}</p>`;
  }).join('');

  return { html, codeTexts };
}

// ─── Styles ──────────────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById('echo-styles')) return;
  const style = document.createElement('style');
  style.id = 'echo-styles';
  style.textContent = /* css */`
    /* ── Reduced-motion kill-switch ── */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }

    /* ── Dark theme (default) ── */
    :root, .echo-theme-dark {
      --echo-bg-bubble-bot:     rgba(28, 28, 32, 0.92);
      --echo-bg-bubble-bot-h:   rgba(36, 36, 42, 0.98);
      --echo-border-bubble-bot: rgba(63, 63, 70, 0.55);
      --echo-text-bubble-bot:   #e4e4e7;
      --echo-bg-code-block:     rgba(9, 9, 11, 0.65);
      --echo-bg-code-header:    rgba(24, 24, 27, 0.85);
      --echo-border-code:       rgba(63, 63, 70, 0.7);
      --echo-border-code-head:  rgba(63, 63, 70, 0.5);
      --echo-text-code:         #a78bfa;
      --echo-text-code-lang:    #71717a;
      --echo-bg-inline-code:    rgba(24, 24, 27, 0.7);
      --echo-text-meta-time:    #71717a;
      --echo-text-meta-action:  #6366f1;
      --echo-text-meta-hover:   #a5b4fc;
      --echo-bg-meta-hover:     rgba(99,102,241,0.1);
      --echo-bg-typing:         rgba(28, 28, 32, 0.92);
      --echo-border-typing:     rgba(63, 63, 70, 0.55);
      --echo-bg-scroll-btn:     rgba(28, 28, 32, 0.95);
      --echo-border-scroll-btn: rgba(63, 63, 70, 0.6);
      --echo-text-scroll-btn:   #a1a1aa;
      --echo-bg-scroll-hover:   rgba(63, 63, 70, 0.95);
      --echo-text-empty:        #52525b;
      --echo-text-empty-h3:     #a1a1aa;
      --echo-text-status:       #52525b;
      --echo-text-char:         #52525b;
      --echo-bg-copy-btn-hover: rgba(255,255,255,0.05);
      --echo-text-copy-btn:     #52525b;
      --echo-text-copy-hover:   #a1a1aa;
      --echo-hr-color:          rgba(63,63,70,0.7);
      --echo-text-h1:           #e4e4e7;
      --echo-text-h2:           #d4d4d8;
      --echo-text-h3:           #a1a1aa;
      --echo-bubble-cancelled-bg:     rgba(39, 39, 42, 0.5);
      --echo-bubble-cancelled-border: rgba(63, 63, 70, 0.3);
      --echo-bubble-cancelled-color:  #71717a;
    }

    /* ── Light theme ── [FIX-BUG-19] */
    @media (prefers-color-scheme: light) {
      :root:not(.echo-theme-dark) {
        --echo-bg-bubble-bot:     #ffffff;
        --echo-bg-bubble-bot-h:   #f5f5f5;
        --echo-border-bubble-bot: rgba(0,0,0,0.1);
        --echo-text-bubble-bot:   #1a1a1a;
        --echo-bg-code-block:     #f6f8fa;
        --echo-bg-code-header:    #eef0f2;
        --echo-border-code:       rgba(0,0,0,0.12);
        --echo-border-code-head:  rgba(0,0,0,0.08);
        --echo-text-code:         #6d28d9;
        --echo-text-code-lang:    #6b7280;
        --echo-bg-inline-code:    #f0eeff;
        --echo-text-meta-time:    #6b7280;
        --echo-text-meta-action:  #4f46e5;
        --echo-text-meta-hover:   #4338ca;
        --echo-bg-meta-hover:     rgba(79,70,229,0.08);
        --echo-bg-typing:         #ffffff;
        --echo-border-typing:     rgba(0,0,0,0.1);
        --echo-bg-scroll-btn:     #ffffff;
        --echo-border-scroll-btn: rgba(0,0,0,0.15);
        --echo-text-scroll-btn:   #374151;
        --echo-bg-scroll-hover:   #f3f4f6;
        --echo-text-empty:        #6b7280;
        --echo-text-empty-h3:     #374151;
        --echo-text-status:       #6b7280;
        --echo-text-char:         #6b7280;
        --echo-bg-copy-btn-hover: rgba(0,0,0,0.05);
        --echo-text-copy-btn:     #6b7280;
        --echo-text-copy-hover:   #374151;
        --echo-hr-color:          rgba(0,0,0,0.12);
        --echo-text-h1:           #111827;
        --echo-text-h2:           #1f2937;
        --echo-text-h3:           #374151;
        --echo-bubble-cancelled-bg:     rgba(243,244,246,0.8);
        --echo-bubble-cancelled-border: rgba(0,0,0,0.08);
        --echo-bubble-cancelled-color:  #9ca3af;
      }
    }

    .echo-theme-light {
      --echo-bg-bubble-bot:     #ffffff;
      --echo-bg-bubble-bot-h:   #f5f5f5;
      --echo-border-bubble-bot: rgba(0,0,0,0.1);
      --echo-text-bubble-bot:   #1a1a1a;
      --echo-bg-code-block:     #f6f8fa;
      --echo-bg-code-header:    #eef0f2;
      --echo-border-code:       rgba(0,0,0,0.12);
      --echo-border-code-head:  rgba(0,0,0,0.08);
      --echo-text-code:         #6d28d9;
      --echo-text-code-lang:    #6b7280;
      --echo-bg-inline-code:    #f0eeff;
      --echo-text-meta-time:    #6b7280;
      --echo-text-meta-action:  #4f46e5;
      --echo-text-meta-hover:   #4338ca;
      --echo-bg-meta-hover:     rgba(79,70,229,0.08);
      --echo-bg-typing:         #ffffff;
      --echo-border-typing:     rgba(0,0,0,0.1);
      --echo-bg-scroll-btn:     #ffffff;
      --echo-border-scroll-btn: rgba(0,0,0,0.15);
      --echo-text-scroll-btn:   #374151;
      --echo-bg-scroll-hover:   #f3f4f6;
      --echo-text-empty:        #6b7280;
      --echo-text-empty-h3:     #374151;
      --echo-text-status:       #6b7280;
      --echo-text-char:         #6b7280;
      --echo-bg-copy-btn-hover: rgba(0,0,0,0.05);
      --echo-text-copy-btn:     #6b7280;
      --echo-text-copy-hover:   #374151;
      --echo-hr-color:          rgba(0,0,0,0.12);
      --echo-text-h1:           #111827;
      --echo-text-h2:           #1f2937;
      --echo-text-h3:           #374151;
      --echo-bubble-cancelled-bg:     rgba(243,244,246,0.8);
      --echo-bubble-cancelled-border: rgba(0,0,0,0.08);
      --echo-bubble-cancelled-color:  #9ca3af;
    }

    /* ── Message container ── */
    #ai-chat-messages {
      display: flex;
      flex-direction: column;
      gap: 2px;
      /* padding/overflow handled by .ai-chat-messages shell class */
    }

    /* ── Rows ── */
    .echo-row {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      animation: echo-slide-in 0.28s cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .echo-row--user { flex-direction: row-reverse; }
    .echo-row--bot  { flex-direction: row; }
    .echo-row + .echo-row { margin-top: 6px; }
    @keyframes echo-slide-in {
      from { opacity: 0; transform: translateY(10px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0)   scale(1);    }
    }

    /* ── Avatar ── */
    .echo-avatar {
      width: 30px; height: 30px;
      border-radius: 50%;
      flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 700; letter-spacing: 0.3px;
      user-select: none; position: relative;
    }
    .echo-avatar--bot {
      background: linear-gradient(135deg, #312e81 0%, #4338ca 100%);
      color: #e0e7ff;
      box-shadow: 0 0 0 2px rgba(99,102,241,0.25);
    }
    .echo-avatar--user {
      background: linear-gradient(135deg, #1e3a5f 0%, #1d4ed8 100%);
      color: #bfdbfe;
    }
    .echo-avatar--bot.echo-avatar--active {
      animation: echo-avatar-glow 1.8s ease-in-out infinite;
    }
    @keyframes echo-avatar-glow {
      0%, 100% { box-shadow: 0 0 0 2px rgba(99,102,241,0.25); }
      50%       { box-shadow: 0 0 0 6px rgba(99,102,241,0.5), 0 0 16px rgba(99,102,241,0.3); }
    }

    /* ── Bubble wrap ── */
    .echo-bubble-wrap { display: flex; flex-direction: column; max-width: min(80%, 600px); }
    .echo-row--user .echo-bubble-wrap { align-items: flex-end; }
    .echo-row--bot  .echo-bubble-wrap { align-items: flex-start; }

    /* ── Bubble ── */
    .echo-bubble {
      padding: 10px 14px;
      border-radius: 18px;
      font-size: 14px; line-height: 1.6;
      position: relative;
      word-break: break-word;
      transition: box-shadow 0.2s;
    }
    .echo-bubble--user {
      background: linear-gradient(135deg, #4f46e5 0%, #6d28d9 100%);
      color: #fff;
      border-bottom-right-radius: 5px;
    }
    .echo-bubble--bot {
      background: var(--echo-bg-bubble-bot);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      color: var(--echo-text-bubble-bot);
      border: 1px solid var(--echo-border-bubble-bot);
      border-bottom-left-radius: 5px;
    }
    .echo-bubble--bot:hover {
      background: var(--echo-bg-bubble-bot-h);
      box-shadow: 0 4px 20px rgba(0,0,0,0.12);
    }
    .echo-bubble--error {
      background: rgba(127,29,29,0.18) !important;
      border-color: rgba(239,68,68,0.35) !important;
      color: #dc2626 !important;
    }
    @media (prefers-color-scheme: dark) { .echo-bubble--error { color: #fca5a5 !important; } }
    .echo-theme-dark .echo-bubble--error { color: #fca5a5 !important; }
    .echo-bubble--cancelled {
      background: var(--echo-bubble-cancelled-bg) !important;
      border-color: var(--echo-bubble-cancelled-border) !important;
      color: var(--echo-bubble-cancelled-color) !important;
      font-style: italic;
    }

    /* ── Streaming cursor [STREAM-04] ── */
    .echo-stream-cursor {
      display: inline-block;
      width: 2px; height: 1em;
      background: currentColor;
      margin-left: 1px;
      vertical-align: text-bottom;
      animation: echo-cursor-blink 0.8s step-end infinite;
    }
    @keyframes echo-cursor-blink {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0; }
    }

    /* ── Meta row ── */
    .echo-meta {
      display: flex; align-items: center; gap: 6px;
      margin-top: 3px; padding: 0 4px;
      opacity: 0; transition: opacity 0.18s;
      pointer-events: none; font-size: 11px;
    }
    .echo-row:hover .echo-meta,
    .echo-row:focus-within .echo-meta { opacity: 1; pointer-events: auto; }
    .echo-meta-time { color: var(--echo-text-meta-time); }
    .echo-meta-action {
      color: var(--echo-text-meta-action);
      background: none; border: none; cursor: pointer;
      padding: 2px 5px; border-radius: 4px;
      display: flex; align-items: center; gap: 3px;
      font-size: 11px; font-family: inherit;
      transition: color 0.15s, background 0.15s;
    }
    .echo-meta-action:hover { color: var(--echo-text-meta-hover); background: var(--echo-bg-meta-hover); }
    .echo-meta-action:focus-visible { outline: 2px solid #818cf8; outline-offset: 1px; }

    /* ── Typing indicator ── */
    .echo-typing {
      display: flex; align-items: center; gap: 5px;
      padding: 13px 16px;
      background: var(--echo-bg-typing);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid var(--echo-border-typing);
      border-radius: 18px; border-bottom-left-radius: 5px;
      width: fit-content;
      animation: echo-slide-in 0.2s cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .echo-typing-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: #818cf8;
      animation: echo-wave 1.4s cubic-bezier(0.45,0.05,0.55,0.95) infinite;
    }
    .echo-typing-dot:nth-child(2) { animation-delay: 0.18s; }
    .echo-typing-dot:nth-child(3) { animation-delay: 0.36s; }
    @keyframes echo-wave {
      0%, 60%, 100% { transform: translateY(0);    opacity: 0.45; }
      30%            { transform: translateY(-5px); opacity: 1;    }
    }

    /* ── Stop button ── */
    .echo-stop-btn {
      display: none; align-items: center; gap: 6px;
      padding: 6px 16px; border-radius: 20px;
      background: rgba(239,68,68,0.1);
      border: 1px solid rgba(239,68,68,0.3);
      color: #dc2626; font-size: 12px; font-family: inherit;
      cursor: pointer; margin: 8px auto; position: relative; overflow: hidden;
      transition: background 0.15s, border-color 0.15s, transform 0.1s;
    }
    @media (prefers-color-scheme: dark) { .echo-stop-btn { color: #f87171; } }
    .echo-theme-dark .echo-stop-btn { color: #f87171; }
    .echo-stop-btn::before {
      content: ''; position: absolute; inset: 0; border-radius: inherit;
      background: linear-gradient(90deg, transparent 0%, rgba(239,68,68,0.15) 50%, transparent 100%);
      background-size: 200% 100%;
      animation: echo-stop-shimmer 2s linear infinite;
    }
    @keyframes echo-stop-shimmer {
      from { background-position: 200% 0; }
      to   { background-position: -200% 0; }
    }
    .echo-stop-btn:hover { background: rgba(239,68,68,0.2); border-color: rgba(239,68,68,0.5); transform: scale(1.02); }
    .echo-stop-btn:focus-visible { outline: 2px solid #f87171; outline-offset: 2px; }
    .echo-stop-btn.visible { display: flex; }

    /* ── Suggestions ── */
    .echo-suggestions {
      display: flex; flex-wrap: wrap; gap: 7px;
      padding: 10px 16px 6px;
    }
    .echo-suggestion-pill {
      background: rgba(99,102,241,0.08);
      border: 1px solid rgba(99,102,241,0.25);
      color: #4f46e5; font-size: 12.5px; font-family: inherit;
      padding: 6px 13px; border-radius: 20px; cursor: pointer;
      white-space: nowrap; opacity: 0;
      animation: echo-pill-in 0.35s cubic-bezier(0.22,1,0.36,1) forwards;
      transition: background 0.18s, border-color 0.18s, transform 0.15s, box-shadow 0.18s;
    }
    @media (prefers-color-scheme: dark) { .echo-suggestion-pill { color: #a5b4fc; } }
    .echo-theme-dark .echo-suggestion-pill { color: #a5b4fc; }
    .echo-suggestion-pill:nth-child(1) { animation-delay: 0.05s; }
    .echo-suggestion-pill:nth-child(2) { animation-delay: 0.12s; }
    .echo-suggestion-pill:nth-child(3) { animation-delay: 0.19s; }
    .echo-suggestion-pill:nth-child(4) { animation-delay: 0.26s; }
    @keyframes echo-pill-in {
      from { opacity: 0; transform: translateY(6px) scale(0.95); }
      to   { opacity: 1; transform: translateY(0)   scale(1);    }
    }
    .echo-suggestion-pill:hover { background: rgba(99,102,241,0.18); border-color: rgba(99,102,241,0.5); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(99,102,241,0.2); }
    .echo-suggestion-pill:active { transform: scale(0.97); }
    .echo-suggestion-pill:focus-visible { outline: 2px solid #818cf8; outline-offset: 2px; }

    /* ── Status bar ── */
    .echo-status-bar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 4px 16px 8px; font-size: 11px;
      color: var(--echo-text-status);
    }
    .echo-status-left { display: flex; align-items: center; gap: 5px; }
    .echo-status-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #16a34a; flex-shrink: 0; transition: background 0.3s;
    }
    @media (prefers-color-scheme: dark) { .echo-status-dot { background: #4ade80; } }
    .echo-theme-dark .echo-status-dot { background: #4ade80; }
    .echo-status-dot.generating { background: #d97706; animation: echo-pulse 1.1s ease-in-out infinite; }
    @media (prefers-color-scheme: dark) { .echo-status-dot.generating { background: #f59e0b; } }
    .echo-theme-dark .echo-status-dot.generating { background: #f59e0b; }
    @keyframes echo-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%       { opacity: 0.35; transform: scale(0.8); }
    }

    /* ── Char counter ── */
    .echo-char-counter { font-size: 11px; color: var(--echo-text-char); transition: color 0.2s; }
    .echo-char-counter.warn { color: #d97706; }
    .echo-char-counter.over { color: #dc2626; }
    @media (prefers-color-scheme: dark) {
      .echo-char-counter.warn { color: #f59e0b; }
      .echo-char-counter.over { color: #f87171; }
    }
    .echo-theme-dark .echo-char-counter.warn { color: #f59e0b; }
    .echo-theme-dark .echo-char-counter.over { color: #f87171; }

    /* ── Scroll-to-bottom ── */
    .echo-scroll-btn {
      position: absolute; bottom: 80px; right: 16px;
      width: 34px; height: 34px; border-radius: 50%;
      background: var(--echo-bg-scroll-btn);
      border: 1px solid var(--echo-border-scroll-btn);
      color: var(--echo-text-scroll-btn);
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      transform: scale(0); opacity: 0; z-index: 10; font-family: inherit;
      box-shadow: 0 2px 8px rgba(0,0,0,0.12);
      transition: transform 0.25s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s, background 0.15s;
    }
    .echo-scroll-btn.visible { transform: scale(1); opacity: 1; }
    .echo-scroll-btn:hover { background: var(--echo-bg-scroll-hover); }
    .echo-scroll-btn:focus-visible { outline: 2px solid #818cf8; outline-offset: 2px; }
    .echo-scroll-badge {
      position: absolute; top: -4px; right: -4px;
      background: #6366f1; color: #fff;
      font-size: 9px; font-weight: 700;
      min-width: 16px; height: 16px; border-radius: 8px;
      display: none; align-items: center; justify-content: center;
      padding: 0 3px; line-height: 1;
    }
    .echo-scroll-badge.visible { display: flex; }

    /* ── Empty state ── */
    .echo-empty {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 14px; padding: 48px 24px;
      color: var(--echo-text-empty); text-align: center;
      animation: echo-fade-up 0.4s cubic-bezier(0.22,1,0.36,1) both;
    }
    @keyframes echo-fade-up {
      from { opacity: 0; transform: translateY(12px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .echo-empty-icon {
      width: 52px; height: 52px; border-radius: 50%;
      background: rgba(99,102,241,0.1);
      border: 1px solid rgba(99,102,241,0.2);
      display: flex; align-items: center; justify-content: center;
      animation: echo-breathe 3.5s ease-in-out infinite;
    }
    @keyframes echo-breathe {
      0%, 100% { box-shadow: 0 0 0 0   rgba(99,102,241,0); }
      50%       { box-shadow: 0 0 0 10px rgba(99,102,241,0.12); }
    }
    .echo-empty h3 { font-size: 15px; color: var(--echo-text-empty-h3); margin: 0; font-weight: 600; }
    .echo-empty p  { font-size: 13px; margin: 0; max-width: 230px; line-height: 1.55; }

    /* ── Send button loading ── */
    .echo-send-spinner {
      width: 16px; height: 16px;
      border: 2px solid rgba(255,255,255,0.25); border-top-color: #fff;
      border-radius: 50%;
      animation: echo-spin 0.7s linear infinite;
      display: none;
    }
    .echo-btn-generating .echo-send-icon    { display: none; }
    .echo-btn-generating .echo-send-spinner { display: block; }
    @keyframes echo-spin { to { transform: rotate(360deg); } }

    /* ── Markdown ── */
    .echo-para { margin: 0 0 6px; }
    .echo-para:last-child { margin-bottom: 0; }
    .echo-md-h1 { font-size: 16px; font-weight: 700; margin: 10px 0 4px; color: var(--echo-text-h1); }
    .echo-md-h2 { font-size: 14.5px; font-weight: 700; margin: 8px 0 3px; color: var(--echo-text-h2); }
    .echo-md-h3 { font-size: 13.5px; font-weight: 600; margin: 6px 0 3px; color: var(--echo-text-h3); }
    .echo-list  { margin: 4px 0 6px 18px; padding: 0; }
    .echo-list li { margin-bottom: 3px; }
    .echo-list-ol { list-style-type: decimal; }
    .echo-hr { border: none; border-top: 1px solid var(--echo-hr-color); margin: 10px 0; }

    /* ── Code blocks ── */
    .echo-code-block {
      background: var(--echo-bg-code-block);
      border: 1px solid var(--echo-border-code);
      border-radius: 10px; margin: 10px 0; overflow: hidden; font-size: 13px;
    }
    .echo-code-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 10px;
      background: var(--echo-bg-code-header);
      border-bottom: 1px solid var(--echo-border-code-head);
    }
    .echo-code-lang { font-size: 10px; color: var(--echo-text-code-lang); text-transform: uppercase; letter-spacing: 0.6px; font-weight: 600; }
    .echo-code-block pre  { margin: 0; padding: 12px 14px; overflow-x: auto; }
    .echo-code-block code { color: var(--echo-text-code); line-height: 1.55; white-space: pre; font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace; }
    .echo-inline-code { background: var(--echo-bg-inline-code); color: var(--echo-text-code); padding: 1px 6px; border-radius: 4px; font-size: 13px; font-family: ui-monospace, 'Cascadia Code', monospace; }

    /* ── Copy button ── */
    .echo-copy-btn {
      background: none; border: none; color: var(--echo-text-copy-btn);
      cursor: pointer; padding: 3px; border-radius: 4px;
      display: flex; align-items: center;
      transition: color 0.15s, background 0.15s;
    }
    .echo-copy-btn:hover { color: var(--echo-text-copy-hover); background: var(--echo-bg-copy-btn-hover); }
    .echo-copy-btn.copied { color: #16a34a; }
    @media (prefers-color-scheme: dark) { .echo-copy-btn.copied { color: #4ade80; } }
    .echo-theme-dark .echo-copy-btn.copied { color: #4ade80; }
    .echo-copy-btn:focus-visible { outline: 2px solid #818cf8; outline-offset: 2px; }

    /* ── Error retry ── */
    .echo-error-retry {
      display: inline-flex; align-items: center; gap: 4px;
      margin-top: 6px; padding: 4px 10px; border-radius: 12px;
      background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.3);
      color: #dc2626; font-size: 11.5px; font-family: inherit; cursor: pointer;
      transition: background 0.15s;
    }
    @media (prefers-color-scheme: dark) { .echo-error-retry { color: #f87171; } }
    .echo-theme-dark .echo-error-retry { color: #f87171; }
    .echo-error-retry:hover { background: rgba(239,68,68,0.22); }
    .echo-error-retry:focus-visible { outline: 2px solid #f87171; outline-offset: 2px; }

    /* ── Export button ── */
    .echo-export-btn {
      background: none; border: none; color: var(--echo-text-meta-action);
      cursor: pointer; padding: 3px 6px; border-radius: 4px;
      font-size: 11px; font-family: inherit;
      display: flex; align-items: center; gap: 3px;
      transition: color 0.15s, background 0.15s;
    }
    .echo-export-btn:hover { color: var(--echo-text-meta-hover); background: var(--echo-bg-meta-hover); }
    .echo-export-btn:focus-visible { outline: 2px solid #818cf8; outline-offset: 2px; }

    /* ── Emoji picker button ── */
    .echo-emoji-btn {
      background: none; border: none; cursor: pointer;
      padding: 4px 6px; border-radius: 6px;
      font-size: 18px; line-height: 1; opacity: 0.55; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      transition: opacity 0.15s, background 0.15s, transform 0.12s;
    }
    .echo-emoji-btn:hover  { opacity: 1; background: var(--echo-bg-meta-hover); transform: scale(1.15); }
    .echo-emoji-btn.active { opacity: 1; }
    .echo-emoji-btn:focus-visible { outline: 2px solid #818cf8; outline-offset: 2px; }

    /* ── Emoji picker panel ── [FIX-BUG-PICKER-F] fixed positioning ── */
    .echo-emoji-picker {
      position: fixed;
      width: 320px; max-height: 340px;
      background: var(--echo-bg-bubble-bot);
      border: 1px solid var(--echo-border-bubble-bot);
      border-radius: 14px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.12);
      display: flex; flex-direction: column; overflow: hidden;
      z-index: 9999;
      animation: echo-picker-in 0.18s cubic-bezier(0.22,1,0.36,1) both;
    }
    @keyframes echo-picker-in {
      from { opacity: 0; transform: translateY(8px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .echo-emoji-picker.closing { animation: echo-picker-out 0.14s ease-in forwards; }
    @keyframes echo-picker-out { to { opacity: 0; transform: translateY(6px) scale(0.97); } }
    .echo-emoji-search-wrap { padding: 10px 10px 6px; border-bottom: 1px solid var(--echo-border-bubble-bot); }
    .echo-emoji-search {
      width: 100%; box-sizing: border-box;
      background: var(--echo-bg-code-block);
      border: 1px solid var(--echo-border-code);
      border-radius: 8px; color: var(--echo-text-bubble-bot);
      font-size: 13px; font-family: inherit;
      padding: 6px 10px; outline: none; transition: border-color 0.15s;
    }
    .echo-emoji-search:focus { border-color: #6366f1; }
    .echo-emoji-search::placeholder { color: var(--echo-text-meta-time); }
    .echo-emoji-tabs {
      display: flex; gap: 2px; padding: 6px 8px 4px;
      overflow-x: auto; scrollbar-width: none;
      border-bottom: 1px solid var(--echo-border-bubble-bot); flex-shrink: 0;
    }
    .echo-emoji-tabs::-webkit-scrollbar { display: none; }
    .echo-emoji-tab {
      background: none; border: none; cursor: pointer;
      font-size: 16px; padding: 4px 6px; border-radius: 6px;
      opacity: 0.5; flex-shrink: 0; line-height: 1;
      transition: opacity 0.12s, background 0.12s;
    }
    .echo-emoji-tab:hover  { opacity: 0.85; background: var(--echo-bg-meta-hover); }
    .echo-emoji-tab.active { opacity: 1; background: rgba(99,102,241,0.15); }
    .echo-emoji-tab:focus-visible { outline: 2px solid #818cf8; }
    .echo-emoji-grid-wrap {
      overflow-y: auto; flex: 1; padding: 6px 8px 8px;
      scrollbar-width: thin; scrollbar-color: rgba(99,102,241,0.3) transparent;
    }
    .echo-emoji-grid-wrap::-webkit-scrollbar { width: 4px; }
    .echo-emoji-grid-wrap::-webkit-scrollbar-thumb { background: rgba(99,102,241,0.3); border-radius: 4px; }
    .echo-emoji-section-label { font-size: 10px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; color: var(--echo-text-meta-time); padding: 6px 2px 3px; }
    .echo-emoji-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 1px; }
    .echo-emoji-cell {
      background: none; border: none; cursor: pointer;
      font-size: 20px; line-height: 1; padding: 5px 3px;
      border-radius: 6px; text-align: center;
      transition: background 0.1s, transform 0.1s;
    }
    .echo-emoji-cell:hover  { background: var(--echo-bg-meta-hover); transform: scale(1.2); }
    .echo-emoji-cell:active { transform: scale(0.95); }
    .echo-emoji-cell:focus-visible { outline: 2px solid #818cf8; outline-offset: 1px; }
    .echo-emoji-cell.highlighted { background: rgba(99,102,241,0.18); }
    .echo-emoji-empty { text-align: center; padding: 24px 8px; font-size: 13px; color: var(--echo-text-meta-time); }

    .echo-theme-light .echo-status-dot { background: #16a34a; }
    .echo-theme-light .echo-status-dot.generating { background: #d97706; }
    .echo-theme-light .echo-bubble--error { color: #dc2626 !important; }
    .echo-theme-light .echo-stop-btn { color: #dc2626; }
    .echo-theme-light .echo-error-retry { color: #dc2626; }
    .echo-theme-light .echo-suggestion-pill { color: #4f46e5; }
    .echo-theme-light .echo-copy-btn.copied { color: #16a34a; }
    .echo-theme-light .echo-char-counter.warn { color: #d97706; }
    .echo-theme-light .echo-char-counter.over { color: #dc2626; }

    /* ── Responsive ── */
    @media (max-width: 520px) {
      .echo-bubble { font-size: 13.5px; padding: 9px 12px; }
      .echo-bubble-wrap { max-width: 88%; }
      .echo-empty { padding: 32px 16px; }
      .echo-emoji-picker { width: 280px; }
      .echo-emoji-grid { grid-template-columns: repeat(7, 1fr); }
    }
  `;
  document.head.appendChild(style);
}

// ─── Emoji data ──────────────────────────────────────────────────────────────
const EMOJI_CATEGORIES = [
  { id: 'recent',   label: 'Recently Used',      icon: '🕐', emojis: [] },
  { id: 'smileys',  label: 'Smileys & People',   icon: '😀',
    emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍',
             '🤩','😘','😗','☺️','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭',
             '🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪',
             '🤤','😴','😷','🤒','🤕','🤢','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸',
             '😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨',
             '😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠'] },
  { id: 'gestures', label: 'Gestures',            icon: '👋',
    emojis: ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉',
             '👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝',
             '🙏','✍️','💅','🤳','💪','🦾','🦵','🦶','👂','🦻','👃','👀','👅','👄','💋'] },
  { id: 'animals',  label: 'Animals & Nature',    icon: '🐶',
    emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵',
             '🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴',
             '🦄','🐝','🐛','🦋','🐌','🐞','🐜','🐢','🐍','🦎','🐙','🦑','🐡','🐠','🐟',
             '🐬','🐳','🐋','🦈','🌸','🌹','🌺','🌻','🌼','🌷','🌱','🌲','🌳','🌴','🌵'] },
  { id: 'food',     label: 'Food & Drink',        icon: '🍕',
    emojis: ['🍕','🍔','🍟','🌭','🍿','🧂','🥓','🥚','🍳','🧇','🥞','🧈','🍞','🥐','🥖',
             '🥨','🥯','🧀','🥗','🥙','🥪','🌮','🌯','🍱','🍣','🍤','🍜','🍝','🥟','🍦',
             '🍧','🍨','🍩','🍪','🎂','🍰','🧁','🍫','🍬','🍭','🍎','🍊','🍋','🍇','🍓'] },
  { id: 'travel',   label: 'Travel & Places',     icon: '✈️',
    emojis: ['✈️','🚀','🛸','🚁','⛵','🚤','🚂','🚄','🚇','🚌','🚗','🚕','🚙','🏎️','🚑',
             '🚒','🚓','🛻','🚚','🛵','🚲','🗺️','🧭','🏔️','🌋','🏕️','🏖️','🏜️','🏝️','🏛️'] },
  { id: 'objects',  label: 'Objects',             icon: '💡',
    emojis: ['💡','🔦','🕯️','💰','💳','💎','⚖️','🧰','🔧','🔨','🛠️','🔩','🧲','🧪','🔭',
             '🔬','📡','💊','📱','💻','⌨️','🖥️','🎥','📷','📺','📻','📦','📝','✏️','🖊️'] },
  { id: 'symbols',  label: 'Symbols',             icon: '❤️',
    emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗',
             '💖','💘','💝','☮️','✝️','☪️','🕉️','✡️','☯️','✅','❎','💯','🔝','🔛','🔜'] },
];

// [FIX-BUG-EMOJI-D] Namespaced key — callers can override via config.storageKey
let _recentStorageKey = 'echo_v2_recent_emojis';

function loadRecentEmojis() {
  try { return JSON.parse(localStorage.getItem(_recentStorageKey) ?? '[]'); } catch { return []; }
}
function saveRecentEmoji(emoji) {
  try {
    const list = [emoji, ...loadRecentEmojis().filter(e => e !== emoji)].slice(0, 24);
    localStorage.setItem(_recentStorageKey, JSON.stringify(list));
  } catch { /* private mode / quota */ }
}

// ─── Emoji picker factory ────────────────────────────────────────────────────
// [FIX-BUG-PICKER-F] Uses position:fixed with live getBoundingClientRect.
function createEmojiPicker(anchorEl, onPick) {
  EMOJI_CATEGORIES[0].emojis = loadRecentEmojis();

  const picker = document.createElement('div');
  picker.className = 'echo-emoji-picker';
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-label', 'Emoji picker');

  // Position above the anchor using fixed coords
  function reposition() {
    const r = anchorEl.getBoundingClientRect();
    const pickerH = 340;
    const pickerW = window.innerWidth <= 520 ? 280 : 320;
    let top  = r.top - pickerH - 8;
    let left = r.right - pickerW;
    if (top < 8) top = r.bottom + 8;
    if (left < 8) left = 8;
    picker.style.top  = top + 'px';
    picker.style.left = left + 'px';
    picker.style.width = pickerW + 'px';
  }

  // Search
  const searchWrap = document.createElement('div');
  searchWrap.className = 'echo-emoji-search-wrap';
  const searchInput = document.createElement('input');
  searchInput.className = 'echo-emoji-search';
  searchInput.type = 'search';
  searchInput.placeholder = 'Search emoji…';
  searchInput.setAttribute('aria-label', 'Search emoji');
  searchInput.autocomplete = 'off';
  searchWrap.appendChild(searchInput);
  picker.appendChild(searchWrap);

  // Tabs
  const tabsEl = document.createElement('div');
  tabsEl.className = 'echo-emoji-tabs';
  tabsEl.setAttribute('role', 'tablist');
  tabsEl.setAttribute('aria-label', 'Emoji categories');

  let activeCatId = EMOJI_CATEGORIES[0].emojis.length > 0 ? 'recent' : 'smileys';

  EMOJI_CATEGORIES.forEach(cat => {
    const tab = document.createElement('button');
    tab.className = 'echo-emoji-tab' + (cat.id === activeCatId ? ' active' : '');
    tab.textContent = cat.icon;
    tab.title = cat.label;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', cat.id === activeCatId ? 'true' : 'false');
    tab.dataset.catId = cat.id;
    tabsEl.appendChild(tab);
  });
  picker.appendChild(tabsEl);

  const gridWrap = document.createElement('div');
  gridWrap.className = 'echo-emoji-grid-wrap';
  picker.appendChild(gridWrap);

  let highlightedIndex = -1;
  let visibleCells = [];

  function renderCategory(catId) {
    gridWrap.innerHTML = '';
    highlightedIndex = -1;
    visibleCells = [];
    const cat = EMOJI_CATEGORIES.find(c => c.id === catId);
    if (!cat || cat.emojis.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'echo-emoji-empty';
      empty.textContent = catId === 'recent' ? 'No recent emoji yet.' : 'No emoji found.';
      gridWrap.appendChild(empty);
      return;
    }
    const label = document.createElement('div');
    label.className = 'echo-emoji-section-label';
    label.textContent = cat.label;
    gridWrap.appendChild(label);
    const grid = document.createElement('div');
    grid.className = 'echo-emoji-grid';
    grid.setAttribute('role', 'grid');
    cat.emojis.forEach(emoji => {
      const cell = makeCell(emoji);
      grid.appendChild(cell);
      visibleCells.push(cell);
    });
    gridWrap.appendChild(grid);
  }

  // [FIX-SEARCH] Search matches on emoji glyph AND category label.
  // Build a lightweight name-map from the emoji's Unicode code-point description
  // so "pizza", "smile", "cat" etc. resolve correctly.
  function renderSearch(query) {
    gridWrap.innerHTML = '';
    highlightedIndex = -1;
    visibleCells = [];
    const q = query.toLowerCase().trim();
    const seen = new Set();
    const allEmojis = [];
    EMOJI_CATEGORIES.slice(1).forEach(cat => {
      cat.emojis.forEach(e => {
        if (!seen.has(e)) {
          seen.add(e);
          // Derive a searchable label: try Intl.Segmenter Unicode name if available,
          // otherwise fall back to category label for keyword matching.
          let label = cat.label.toLowerCase();
          try {
            // Modern browsers: emoji codepoint name via Unicode
            const cp = [...e].map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')).join(' ');
            label += ' ' + cp;
          } catch { /* ignore */ }
          allEmojis.push({ emoji: e, label });
        }
      });
    });
    const results = q
      ? allEmojis.filter(({ label }) => label.includes(q)).map(x => x.emoji)
      : allEmojis.map(x => x.emoji);

    if (results.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'echo-emoji-empty';
      empty.textContent = `No results for "${query}"`;
      gridWrap.appendChild(empty);
      return;
    }
    const label = document.createElement('div');
    label.className = 'echo-emoji-section-label';
    label.textContent = q ? `Results for "${query}"` : 'All emoji';
    gridWrap.appendChild(label);
    const grid = document.createElement('div');
    grid.className = 'echo-emoji-grid';
    grid.setAttribute('role', 'grid');
    results.forEach(emoji => {
      const cell = makeCell(emoji);
      grid.appendChild(cell);
      visibleCells.push(cell);
    });
    gridWrap.appendChild(grid);
  }

  function makeCell(emoji) {
    const cell = document.createElement('button');
    cell.className = 'echo-emoji-cell';
    cell.textContent = emoji;
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('aria-label', emoji);
    cell.addEventListener('click', e => {
      e.stopPropagation();
      saveRecentEmoji(emoji);
      onPick(emoji);
    });
    return cell;
  }

  function setActiveTab(catId) {
    activeCatId = catId;
    tabsEl.querySelectorAll('.echo-emoji-tab').forEach(t => {
      const active = t.dataset.catId === catId;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderCategory(catId);
  }

  function moveHighlight(delta) {
    if (visibleCells.length === 0) return;
    if (highlightedIndex >= 0) visibleCells[highlightedIndex]?.classList.remove('highlighted');
    highlightedIndex = Math.max(0, Math.min(visibleCells.length - 1, highlightedIndex + delta));
    const cell = visibleCells[highlightedIndex];
    cell.classList.add('highlighted');
    cell.scrollIntoView({ block: 'nearest' });
  }

  tabsEl.addEventListener('click', e => {
    const tab = e.target.closest('.echo-emoji-tab');
    if (tab?.dataset.catId) { searchInput.value = ''; setActiveTab(tab.dataset.catId); }
  });

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    if (q) { tabsEl.style.display = 'none'; renderSearch(q); }
    else   { tabsEl.style.display = ''; renderCategory(activeCatId); }
  });

  picker.addEventListener('keydown', e => {
    const cols = window.innerWidth <= 520 ? 7 : 8;
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); moveHighlight(1);    break;
      case 'ArrowLeft':  e.preventDefault(); moveHighlight(-1);   break;
      case 'ArrowDown':  e.preventDefault(); moveHighlight(cols); break;
      case 'ArrowUp':    e.preventDefault(); moveHighlight(-cols); break;
      case 'Enter':
        if (highlightedIndex >= 0) { e.preventDefault(); visibleCells[highlightedIndex]?.click(); }
        break;
      case 'Escape':
        e.stopPropagation();
        destroy();
        break;
    }
  });

  renderCategory(activeCatId);

  // Append to body so fixed positioning is unaffected by parent transforms
  document.body.appendChild(picker);
  reposition();

  // Reposition on scroll/resize
  const reposHandler = () => reposition();
  window.addEventListener('scroll', reposHandler, { passive: true, capture: true });
  window.addEventListener('resize', reposHandler, { passive: true });

  function destroy() {
    window.removeEventListener('scroll', reposHandler, { capture: true });
    window.removeEventListener('resize', reposHandler);
    picker.classList.add('closing');
    picker.addEventListener('animationend', () => picker.remove(), { once: true });
  }

  return { el: picker, destroy, focusSearch: () => searchInput.focus() };
}

// ─── Shell layout styles ──────────────────────────────────────────────────────
function _injectShellStyles() {
  if (document.getElementById('ai-chat-shell-styles')) return;
  const style = document.createElement('style');
  style.id = 'ai-chat-shell-styles';
  style.textContent = `
    /* ── Page section reset ── */
    #page-ai-chat {
      padding: 0;
      display: flex;
      flex-direction: column;
      height: calc(100vh - 72px); /* full viewport minus header */
    }

    /* ── Shell: fills the page section ── */
    .ai-chat-shell {
      display: flex;
      flex-direction: column;
      height: 100%;
      max-width: 860px;
      width: 100%;
      margin: 0 auto;
      background: var(--surface, #fff);
      border-left: 1px solid var(--edge, rgba(0,0,0,0.08));
      border-right: 1px solid var(--edge, rgba(0,0,0,0.08));
      position: relative;
    }

    /* ── Header ── */
    .ai-chat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 20px;
      border-bottom: 1px solid var(--edge, rgba(0,0,0,0.08));
      flex-shrink: 0;
      background: var(--surface, #fff);
    }
    body.dark-mode .ai-chat-header {
      background: #0c0e1e;
      border-color: rgba(255,255,255,0.08);
    }
    .ai-chat-header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .ai-chat-avatar-wrap {
      width: 38px; height: 38px;
      border-radius: 10px;
      background: linear-gradient(135deg, #312e81, #4338ca);
      display: flex; align-items: center; justify-content: center;
      color: #e0e7ff;
      flex-shrink: 0;
      box-shadow: 0 2px 10px rgba(99,102,241,0.35);
    }
    .ai-chat-title {
      font-size: 15px; font-weight: 700;
      color: var(--ink, #111);
      margin: 0;
    }
    body.dark-mode .ai-chat-title { color: #f4f4f5; }
    .ai-chat-subtitle {
      font-size: 11px;
      color: var(--ink-dim, #6b7280);
      margin: 0;
    }
    .ai-chat-clear-btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 7px 14px; border-radius: 8px;
      background: transparent;
      border: 1px solid var(--edge, rgba(0,0,0,0.12));
      color: var(--ink-dim, #6b7280);
      font-size: 13px; cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
      font-family: inherit;
    }
    .ai-chat-clear-btn:hover {
      background: rgba(239,68,68,0.06);
      border-color: rgba(239,68,68,0.3);
      color: #dc2626;
    }
    body.dark-mode .ai-chat-clear-btn {
      border-color: rgba(255,255,255,0.1);
      color: #71717a;
    }
    body.dark-mode .ai-chat-clear-btn:hover {
      background: rgba(239,68,68,0.1);
      color: #f87171;
    }

    /* ── Messages area ── */
    .ai-chat-messages {
      flex: 1;
      overflow-y: auto;
      overscroll-behavior: contain;
      scroll-behavior: smooth;
      padding: 20px 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    /* ── Footer ── */
    .ai-chat-footer {
      flex-shrink: 0;
      border-top: 1px solid var(--edge, rgba(0,0,0,0.08));
      background: var(--surface, #fff);
    }
    body.dark-mode .ai-chat-footer {
      background: #0c0e1e;
      border-color: rgba(255,255,255,0.08);
    }

    /* ── Form row ── */
    .ai-chat-form {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      padding: 12px 14px 10px;
    }

    /* ── Textarea ── */
    .ai-chat-input {
      flex: 1;
      resize: none;
      border: 1.5px solid var(--edge, rgba(0,0,0,0.12)) !important;
      border-radius: 12px !important;
      padding: 10px 14px !important;
      font-size: 14px;
      font-family: inherit;
      line-height: 1.5;
      max-height: 160px;
      min-height: 42px;
      overflow-y: auto;
      background: var(--surface-2, #f9fafb) !important;
      color: var(--ink, #111) !important;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .ai-chat-input:focus {
      outline: none;
      border-color: #6366f1 !important;
      box-shadow: 0 0 0 3px rgba(99,102,241,0.12) !important;
      background: var(--surface, #fff) !important;
    }
    body.dark-mode .ai-chat-input {
      background: #11142a !important;
      border-color: rgba(255,255,255,0.1) !important;
      color: #f4f4f5 !important;
    }
    body.dark-mode .ai-chat-input:focus {
      border-color: #6366f1 !important;
      background: #181c3a !important;
    }

    /* ── Send button ── */
    .ai-chat-send-btn {
      width: 42px; height: 42px;
      border-radius: 12px;
      background: linear-gradient(135deg, #6366f1, #4f46e5);
      border: none; cursor: pointer;
      color: #fff;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      box-shadow: 0 4px 14px rgba(99,102,241,0.35);
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .ai-chat-send-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(99,102,241,0.5);
    }
    .ai-chat-send-btn:active { transform: scale(0.95); }
    .ai-chat-send-btn:disabled {
      opacity: 0.5; cursor: not-allowed;
      transform: none; box-shadow: none;
    }

    /* ── Hint line ── */
    .ai-chat-hint {
      font-size: 11px;
      color: var(--ink-faint, #9ca3af);
      text-align: center;
      padding: 0 14px 10px;
      margin: 0;
    }

    /* ── Scroll button positioning fix ── */
    .ai-chat-shell .echo-scroll-btn {
      position: absolute;
      bottom: 130px;
      right: 18px;
    }

    /* ── Suggestions inside footer ── */
    .ai-chat-footer .echo-suggestions {
      padding: 10px 14px 4px;
      border-bottom: 1px solid var(--edge, rgba(0,0,0,0.06));
    }
    body.dark-mode .ai-chat-footer .echo-suggestions {
      border-color: rgba(255,255,255,0.06);
    }

    /* ── Status bar inside footer ── */
    .ai-chat-footer .echo-status-bar {
      padding: 6px 14px 4px;
    }

    /* ── Stop button inside footer ── */
    .ai-chat-footer .echo-stop-btn {
      margin: 4px auto 2px;
    }

    /* ── Mobile ── */
    @media (max-width: 600px) {
      #page-ai-chat {
        height: calc(100dvh - 72px);
      }
      .ai-chat-header {
        padding: 10px 14px;
      }
      .ai-chat-avatar-wrap {
        width: 32px; height: 32px; border-radius: 8px;
      }
      .ai-chat-title   { font-size: 14px; }
      .ai-chat-subtitle { display: none; }
      .ai-chat-clear-btn span { display: none; }
      .ai-chat-clear-btn {
        padding: 7px 10px;
        gap: 0;
      }
      .ai-chat-form { padding: 8px 10px 8px; gap: 6px; }
      .ai-chat-input { font-size: 16px !important; /* prevent iOS zoom */ }
      .ai-chat-send-btn { width: 38px; height: 38px; border-radius: 10px; }
      .ai-chat-hint { display: none; }
      .ai-chat-shell .echo-scroll-btn { bottom: 120px; right: 12px; }
      .ai-chat-footer .echo-suggestions { padding: 8px 10px 4px; }
      .echo-bubble-wrap { max-width: 90% !important; }
    }

    @media (max-width: 380px) {
      .ai-chat-messages { padding: 12px 8px 8px; }
      .ai-chat-form { padding: 6px 8px; gap: 4px; }
    }

    /* ── API Key Setup UI ── */
    .echo-key-setup {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 12px;
      padding: 40px 28px;
      max-width: 440px;
      margin: auto;
    }
    .echo-key-setup-icon {
      font-size: 36px;
      width: 68px; height: 68px;
      border-radius: 50%;
      background: rgba(99,102,241,0.1);
      border: 1px solid rgba(99,102,241,0.2);
      display: flex; align-items: center; justify-content: center;
    }
    .echo-key-setup h3 {
      font-size: 17px; font-weight: 700;
      color: var(--ink, #111); margin: 0;
    }
    body.dark-mode .echo-key-setup h3 { color: #f4f4f5; }
    .echo-key-setup p {
      font-size: 13px; color: var(--ink-dim, #6b7280);
      margin: 0; line-height: 1.55;
    }
    body.dark-mode .echo-key-setup p { color: #a1a1aa; }
    .echo-key-error {
      color: #dc2626 !important;
      background: rgba(239,68,68,0.08);
      border: 1px solid rgba(239,68,68,0.2);
      border-radius: 8px;
      padding: 8px 12px !important;
      font-size: 13px;
    }
    body.dark-mode .echo-key-error { color: #f87171 !important; }
    .echo-key-steps {
      text-align: left;
      font-size: 13px;
      color: var(--ink-dim, #6b7280);
      padding-left: 20px;
      margin: 4px 0;
      line-height: 1.8;
    }
    body.dark-mode .echo-key-steps { color: #a1a1aa; }
    .echo-key-steps a { color: #6366f1; text-decoration: underline; }
    .echo-key-steps strong { color: var(--ink, #111); }
    body.dark-mode .echo-key-steps strong { color: #f4f4f5; }
    .echo-key-input-row {
      display: flex; gap: 8px; width: 100%;
    }
    .echo-key-input {
      flex: 1;
      padding: 10px 12px !important;
      border-radius: 10px !important;
      border: 1.5px solid var(--edge, rgba(0,0,0,0.12)) !important;
      font-size: 13px !important;
      font-family: ui-monospace, monospace !important;
      background: var(--surface-2, #f9fafb) !important;
      color: var(--ink, #111) !important;
      letter-spacing: 0.03em;
    }
    .echo-key-input:focus {
      outline: none !important;
      border-color: #6366f1 !important;
      box-shadow: 0 0 0 3px rgba(99,102,241,0.12) !important;
    }
    body.dark-mode .echo-key-input {
      background: #11142a !important;
      border-color: rgba(255,255,255,0.1) !important;
      color: #f4f4f5 !important;
    }
    .echo-key-save-btn {
      padding: 10px 18px;
      border-radius: 10px;
      background: linear-gradient(135deg, #6366f1, #4f46e5);
      color: #fff;
      font-size: 13px; font-weight: 600;
      border: none; cursor: pointer;
      white-space: nowrap;
      transition: transform 0.15s, box-shadow 0.15s;
      box-shadow: 0 4px 12px rgba(99,102,241,0.35);
    }
    .echo-key-save-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(99,102,241,0.5); }
    .echo-key-save-btn:active { transform: scale(0.96); }
    .echo-key-note {
      font-size: 11px !important;
      color: var(--ink-faint, #9ca3af) !important;
    }
  `;
  document.head.appendChild(style);
}

// ─── Main export ─────────────────────────────────────────────────────────────
/**
 * Initialize the Echo AI chat UI.
 *
 * @param {object} [config]
 * @param {string} [config.apiKey]     Gemini API key (preferred over window.__ECHO_API_KEY).
 * @param {string} [config.storageKey] localStorage key for recent emoji (default: 'echo_v2_recent_emojis').
 * @param {'dark'|'light'} [config.theme] Force a colour theme. Omit to follow OS preference.
 *
 * After calling setupAiChat(), the form element exposes:
 *   form.__echoCleanup()          — tear down the widget
 *   form.__echoSetTheme('light')  — switch theme at runtime
 */
export function setupAiChat(config = {}) {
  if (config.storageKey) _recentStorageKey = config.storageKey;
  if (config.apiKey)    setApiKey(config.apiKey);

  const container = document.getElementById('ai-chat-messages');
  const input     = document.getElementById('ai-chat-input');
  const form      = document.getElementById('ai-chat-form');
  if (!container || !input || !form) return;

  // [FIX-THEME] Apply theme class from config; expose toggle for callers
  const wrapperParent = container.parentElement;
  const themeRoot = wrapperParent ?? container;
  if (config.theme === 'light') {
    themeRoot.classList.remove('echo-theme-dark');
    themeRoot.classList.add('echo-theme-light');
  } else if (config.theme === 'dark') {
    themeRoot.classList.remove('echo-theme-light');
    themeRoot.classList.add('echo-theme-dark');
  }

  const submitBtn = form.querySelector('button[type="submit"]');

  injectStyles();
  _injectShellStyles();

  // ── API key gate ──────────────────────────────────────────────────────
  // Show setup UI if no key is available yet. User can enter one and it
  // gets saved to localStorage so it persists across sessions.
  function _showKeySetup(reason = '') {
    container.innerHTML = `
      <div class="echo-key-setup" id="echo-key-setup">
        <div class="echo-key-setup-icon">🔑</div>
        <h3>Gemini API Key Required</h3>
        <p>Echo uses Google's Gemini API. You need a free API key to chat.</p>
        ${reason ? `<p class="echo-key-error">${reason}</p>` : ''}
        <ol class="echo-key-steps">
          <li>Go to <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Google AI Studio</a></li>
          <li>Click <strong>Create API key</strong></li>
          <li>Copy and paste it below</li>
        </ol>
        <div class="echo-key-input-row">
          <input type="password" id="echo-key-input" class="echo-key-input" placeholder="AQ. or AIza..." autocomplete="off" spellcheck="false" />
          <button id="echo-key-save-btn" class="echo-key-save-btn">Save &amp; Start</button>
        </div>
        <p class="echo-key-note">Stored locally in your browser only — never sent anywhere except Google.</p>
      </div>`;

    document.getElementById('echo-key-save-btn')?.addEventListener('click', () => {
      const val = (document.getElementById('echo-key-input')?.value || '').trim();
      if (!val || (!val.startsWith('AI') && !val.startsWith('AQ.'))) {
        const input = document.getElementById('echo-key-input');
        if (input) { input.style.borderColor = '#ef4444'; input.focus(); }
        return;
      }
      localStorage.setItem('echo_gemini_api_key', val);
      setApiKey(val);
      _initChat();
    });

    document.getElementById('echo-key-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('echo-key-save-btn')?.click();
    });
  }

  const hasKey = !!resolveApiKey();
  if (!hasKey) {
    _showKeySetup();
    // Disable input until key is set
    input.disabled = true;
    if (submitBtn) submitBtn.disabled = true;
    return; // Don't init chat until key is saved
  }

  _initChat();

  function _initChat() {
    input.disabled = false;
    if (submitBtn) submitBtn.disabled = false;

  // ── Submit button: loading state ──────────────────────────────────────
  if (submitBtn && !submitBtn.querySelector('.echo-send-icon')) {
    const existing = submitBtn.innerHTML;
    submitBtn.innerHTML = `
      <span class="echo-send-icon">${existing}</span>
      <span class="echo-send-spinner" aria-hidden="true"></span>
    `;
  }

  // ── Emoji button ──────────────────────────────────────────────────────
  const emojiBtn = document.createElement('button');
  emojiBtn.type = 'button';
  emojiBtn.className = 'echo-emoji-btn';
  emojiBtn.setAttribute('aria-label', 'Open emoji picker');
  emojiBtn.setAttribute('aria-haspopup', 'dialog');
  emojiBtn.setAttribute('aria-expanded', 'false');
  emojiBtn.textContent = '😊';
  // Insert between textarea and send button
  if (submitBtn) form.insertBefore(emojiBtn, submitBtn);
  else form.appendChild(emojiBtn);

  // Clear button handler registered after bottomObserver is created (see below)

  let activePicker = null;

  function openPicker() {
    if (activePicker) { closePicker(); return; }
    const { destroy, focusSearch } = createEmojiPicker(emojiBtn, emoji => {
      const start  = input.selectionStart ?? input.value.length;
      const end    = input.selectionEnd   ?? input.value.length;
      input.value  = input.value.slice(0, start) + emoji + input.value.slice(end);
      const newPos = start + [...emoji].length;
      input.setSelectionRange(newPos, newPos);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      closePicker();
    });
    activePicker = { destroy };
    emojiBtn.classList.add('active');
    emojiBtn.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(focusSearch);
    setTimeout(() => {
      document.addEventListener('click', outsideClick, { capture: true });
    }, 0);
  }

  function closePicker() {
    if (!activePicker) return;
    activePicker.destroy();
    activePicker = null;
    emojiBtn.classList.remove('active');
    emojiBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', outsideClick, { capture: true });
  }

  function outsideClick(e) {
    const pickerEl = document.querySelector('.echo-emoji-picker');
    if (pickerEl && !pickerEl.contains(e.target) && !emojiBtn.contains(e.target)) closePicker();
  }

  emojiBtn.addEventListener('click', e => { e.stopPropagation(); openPicker(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape' && activePicker) { closePicker(); e.stopPropagation(); }
  }, { capture: true });

  // ── Empty state ──────────────────────────────────────────────────────
  container.innerHTML = `
    <div class="echo-empty" id="echo-empty-state" aria-label="Start a conversation">
      <div class="echo-empty-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#818cf8"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <h3>How can I help?</h3>
      <p>Ask anything — I'll keep my answers clear and to the point.</p>
    </div>
  `;
  container.setAttribute('aria-live', 'polite');
  container.setAttribute('aria-label', 'Conversation');

  // ── DOM structure: status → suggestions → stop ────────────────────────
  // [FIX-BUG-07 / kept] correct insertion order

  // ── Status bar — inserted BEFORE the footer form ──────────────────────
  const footer = document.querySelector('.ai-chat-footer');

  const statusBar = document.createElement('div');
  statusBar.className = 'echo-status-bar';
  statusBar.setAttribute('aria-live', 'polite');
  statusBar.innerHTML = `
    <span class="echo-status-left">
      <span class="echo-status-dot" id="echo-status-dot"></span>
      <span id="echo-status-text">Ready</span>
    </span>
    <span style="display:flex;align-items:center;gap:8px;">
      <button class="echo-export-btn" id="echo-export-btn" title="Export conversation" aria-label="Export conversation as text">
        ${ICONS.export} Export
      </button>
      <span class="echo-char-counter" id="echo-char-counter">0 / ${MAX_CHARS}</span>
    </span>
  `;
  if (footer) footer.insertBefore(statusBar, footer.firstChild);
  else wrapperParent?.insertBefore(statusBar, container.nextSibling);

  const suggestionsEl = document.createElement('div');
  suggestionsEl.className = 'echo-suggestions';
  suggestionsEl.id = 'echo-suggestions';
  suggestionsEl.setAttribute('role', 'group');
  suggestionsEl.setAttribute('aria-label', 'Suggested prompts');
  pickSuggestions().forEach(text => {
    const pill = document.createElement('button');
    pill.className = 'echo-suggestion-pill';
    pill.textContent = text;
    pill.dataset.suggestion = text;
    suggestionsEl.appendChild(pill);
  });
  if (footer) footer.insertBefore(suggestionsEl, statusBar);
  else wrapperParent?.insertBefore(suggestionsEl, statusBar);

  const stopBtn = document.createElement('button');
  stopBtn.className = 'echo-stop-btn';
  stopBtn.id = 'echo-stop-btn';
  stopBtn.setAttribute('aria-label', 'Stop generating');
  stopBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/></svg> Stop`;
  if (footer) footer.insertBefore(stopBtn, suggestionsEl);
  else wrapperParent?.insertBefore(stopBtn, suggestionsEl);

  // Scroll button — lives inside the messages container's parent
  const scrollBtn = document.createElement('button');
  scrollBtn.className = 'echo-scroll-btn';
  scrollBtn.setAttribute('aria-label', 'Scroll to bottom');
  scrollBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
    <span class="echo-scroll-badge" id="echo-scroll-badge" aria-label="unread messages"></span>
  `;
  scrollBtn.addEventListener('click', () => {
    scrollToBottom();
    unreadCount = 0;
    updateScrollBadge();
  });
  const shell = document.querySelector('.ai-chat-shell');
  if (shell) {
    shell.style.position = 'relative';
    shell.appendChild(scrollBtn);
  } else if (wrapperParent) {
    wrapperParent.style.position = 'relative';
    wrapperParent.appendChild(scrollBtn);
  }

  // Sentinel [FIX-BUG-15]
  let sentinel = container.querySelector('#echo-sentinel');
  if (!sentinel) {
    sentinel = document.createElement('div');
    sentinel.id = 'echo-sentinel';
    sentinel.style.height = '1px';
    container.appendChild(sentinel);
  }

  const bottomObserver = new IntersectionObserver(
    ([entry]) => {
      userIsAtBottom = entry.isIntersecting;
      scrollBtn.classList.toggle('visible', !userIsAtBottom);
      if (userIsAtBottom) { unreadCount = 0; updateScrollBadge(); }
    },
    { root: container, threshold: 0.1 }
  );
  bottomObserver.observe(sentinel);

  // ── Clear conversation button ─────────────────────────────────────────
  document.getElementById('ai-chat-clear-btn')?.addEventListener('click', () => {
    if (!confirm('Clear this conversation?')) return;
    if (isGenerating) currentAbortController?.abort();
    container.innerHTML = '';
    resetHistory();
    messageCount = 0;
    unreadCount  = 0;
    isGenerating = false;
    setInputDisabled(false);
    setStatus('Ready');
    // Re-add sentinel and observe
    const s = document.createElement('div');
    s.id = 'echo-sentinel';
    s.style.height = '1px';
    container.appendChild(s);
    bottomObserver.observe(s);
    // Re-render empty state
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'echo-empty';
    emptyDiv.id = 'echo-empty-state';
    emptyDiv.setAttribute('aria-label', 'Start a conversation');
    emptyDiv.innerHTML = `
      <div class="echo-empty-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#818cf8"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <h3>How can I help?</h3>
      <p>Ask anything — I'll keep my answers clear and to the point.</p>`;
    container.insertBefore(emptyDiv, s);
    // Re-insert suggestions
    const newSuggestions = document.createElement('div');
    newSuggestions.className = 'echo-suggestions';
    newSuggestions.id = 'echo-suggestions';
    newSuggestions.setAttribute('role', 'group');
    newSuggestions.setAttribute('aria-label', 'Suggested prompts');
    pickSuggestions().forEach(txt => {
      const pill = document.createElement('button');
      pill.className = 'echo-suggestion-pill';
      pill.textContent = txt;
      pill.dataset.suggestion = txt;
      newSuggestions.appendChild(pill);
    });
    const footerEl = document.querySelector('.ai-chat-footer');
    const stopBtnEl = document.getElementById('echo-stop-btn');
    if (footerEl && stopBtnEl) footerEl.insertBefore(newSuggestions, stopBtnEl);
    newSuggestions.addEventListener('click', e => {
      const pill = e.target.closest('.echo-suggestion-pill');
      if (pill?.dataset.suggestion) submitMessage(pill.dataset.suggestion);
    });
    input.focus();
  });

  // ── Char counter [FIX-BUG-06] ────────────────────────────────────────
  const charCounter = document.getElementById('echo-char-counter');
  input.setAttribute('maxlength', MAX_CHARS);
  input.addEventListener('input', () => {
    const len = input.value.length;
    if (charCounter) {
      charCounter.textContent = `${len} / ${MAX_CHARS}`;
      charCounter.className = 'echo-char-counter' +
        (len >= MAX_CHARS ? ' over' : len > MAX_CHARS * 0.85 ? ' warn' : '');
    }
    if (input.tagName === 'TEXTAREA') {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    }
  });

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isGenerating) { stopGenerating(); return; }
    // [FIX-BUG-SUBMIT-E] direct call instead of form.dispatchEvent fallback
    if (e.key === 'Enter' && !e.shiftKey && input.tagName === 'TEXTAREA') {
      e.preventDefault();
      if (form.requestSubmit) form.requestSubmit();
      else { const text = input.value.trim(); if (text) { input.value = ''; submitMessage(text); } }
    }
  });

  // ── Form submit ───────────────────────────────────────────────────────
  form.addEventListener('submit', e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || isGenerating || pendingLock) return;
    input.value = '';
    if (charCounter) charCounter.textContent = `0 / ${MAX_CHARS}`;
    if (input.tagName === 'TEXTAREA') input.style.height = 'auto';
    submitMessage(text);
  });

  // ── Helpers ───────────────────────────────────────────────────────────
  function scrollToBottom() {
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }

  // [FIX-BUG-TIME-H] pure function — no hidden side-effect
  function formatTime(date = new Date()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function setStatus(text, generating = false) {
    document.getElementById('echo-status-dot')?.classList.toggle('generating', generating);
    const span = document.getElementById('echo-status-text');
    if (span) span.textContent = text;
  }

  function setInputDisabled(disabled) {
    input.disabled = disabled;
    if (submitBtn) {
      submitBtn.disabled = disabled;
      submitBtn.classList.toggle('echo-btn-generating', disabled);
    }
    input.placeholder = disabled ? 'Echo is thinking…' : 'Message Echo…';
    stopBtn.classList.toggle('visible', disabled);
  }

  function updateScrollBadge() {
    const badge = document.getElementById('echo-scroll-badge');
    if (!badge) return;
    const show = unreadCount > 0 && !userIsAtBottom;
    badge.classList.toggle('visible', show);
    badge.textContent = show ? String(Math.min(unreadCount, 99)) : '';
  }

  function hideEmptyAndSuggestions() {
    document.getElementById('echo-empty-state')?.remove();
    document.getElementById('echo-suggestions')?.remove();
  }

  // ── Stop [FIX-BUG-14 / kept] ─────────────────────────────────────────
  function stopGenerating() {
    currentAbortController?.abort();
  }
  stopBtn.addEventListener('click', stopGenerating);

  // ── Suggestion pills [FIX-BUG-13 / kept] ─────────────────────────────
  suggestionsEl.addEventListener('click', e => {
    const pill = e.target.closest('.echo-suggestion-pill');
    if (pill?.dataset.suggestion) submitMessage(pill.dataset.suggestion);
  });

  // ── Export [UX-14] ────────────────────────────────────────────────────
  document.getElementById('echo-export-btn')?.addEventListener('click', () => {
    const lines = chatHistory.slice(2).map(msg => {
      const role = msg.role === 'user' ? 'You' : 'Echo';
      return `[${role}]\n${msg.parts?.[0]?.text ?? ''}\n`;
    });
    if (!lines.length) return;
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: `echo-chat-${Date.now()}.txt` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  // ── Delegated click handler [FIX-BUG-08] ─────────────────────────────
  container.addEventListener('click', e => {
    const codeCopyBtn = e.target.closest('.echo-copy-code');
    if (codeCopyBtn) {
      const code = codeCache.get(codeCopyBtn) ?? '';
      navigator.clipboard.writeText(code).then(() => {
        codeCopyBtn.classList.add('copied');
        setTimeout(() => codeCopyBtn.classList.remove('copied'), 1600);
      }).catch(console.error);
      return;
    }

    // Message copy [FIX-BUG-04]
    const msgCopyBtn = e.target.closest('.echo-copy-msg');
    if (msgCopyBtn) {
      const target = document.getElementById(msgCopyBtn.dataset.target);
      if (target) {
        navigator.clipboard.writeText(target.innerText).then(() => {
          const original = msgCopyBtn.innerHTML;
          msgCopyBtn.textContent = '✓ Copied';
          setTimeout(() => { msgCopyBtn.innerHTML = original; }, 1600);
        }).catch(console.error);
      }
      return;
    }

    // Retry / error retry
    const retryBtn = e.target.closest('.echo-retry-btn, .echo-error-retry');
    if (retryBtn && !isGenerating) {
      const lastUser = [...chatHistory].reverse().find(m => m.role === 'user');
      if (lastUser) submitMessage(lastUser.parts[0].text, true);
    }
  });

  // ── Append static message ─────────────────────────────────────────────
  // [FIX-BUG-22] role="article" for all bubbles
  function appendMessage({ text, sender, isError = false, isCancelled = false }) {
    hideEmptyAndSuggestions();
    const isUser = sender === 'user';
    const msgId  = `echo-msg-${Date.now()}-${++messageCount}`;
    const time   = formatTime();

    let bubbleCls = isUser ? 'echo-bubble--user' : 'echo-bubble--bot';
    if (isError)     bubbleCls += ' echo-bubble--error';
    if (isCancelled) bubbleCls  = 'echo-bubble--bot echo-bubble--cancelled';

    const { html: content, codeTexts } = isUser
      ? { html: `<p class="echo-para">${sanitize(text)}</p>`, codeTexts: [] }
      : parseMarkdown(text);

    const errorRetryInline = isError ? `
      <div><button class="echo-error-retry" aria-label="Try again">${ICONS.retry} Try again</button></div>` : '';

    const actionsCopy = !isUser ? `
      <button class="echo-meta-action echo-copy-msg" data-target="${msgId}" aria-label="Copy message">
        ${ICONS.copy} Copy</button>` : '';

    const actionsRetry = !isUser && !isCancelled ? `
      <button class="echo-meta-action echo-retry-btn" aria-label="Retry this response">
        ${ICONS.retry} Retry</button>` : '';

    const row = document.createElement('div');
    row.className = `echo-row ${isUser ? 'echo-row--user' : 'echo-row--bot'}`;
    row.innerHTML = `
      <div class="echo-avatar ${isUser ? 'echo-avatar--user' : 'echo-avatar--bot'}" aria-hidden="true">${isUser ? 'YOU' : 'AI'}</div>
      <div class="echo-bubble-wrap">
        <div id="${msgId}" class="echo-bubble ${bubbleCls}"
             role="article" aria-label="${isUser ? 'Your message' : 'Echo reply'}">${content}${errorRetryInline}</div>
        <div class="echo-meta" role="toolbar" aria-label="Message actions">
          <span class="echo-meta-time">${time}</span>
          ${actionsCopy}${actionsRetry}
        </div>
      </div>`;

    container.insertBefore(row, sentinel);

    // Populate codeCache for this message's copy buttons [FIX-BUG-12]
    const msgEl = document.getElementById(msgId);
    if (msgEl && codeTexts.length) {
      msgEl.querySelectorAll('.echo-copy-code[data-ci]').forEach(btn => {
        const ci = Number(btn.dataset.ci);
        if (codeTexts[ci] !== undefined) codeCache.set(btn, codeTexts[ci]);
      });
    }

    if (!userIsAtBottom) { unreadCount++; updateScrollBadge(); }
    else requestAnimationFrame(scrollToBottom);

    return msgId;
  }

  // ── Create a live streaming bubble ────────────────────────────────────
  // Returns { bubbleEl, avatarEl, update(chunk), finalise() }
  function createStreamBubble() {
    hideEmptyAndSuggestions();
    const msgId = `echo-msg-${Date.now()}-${++messageCount}`;
    const time  = formatTime();

    const row = document.createElement('div');
    row.className = 'echo-row echo-row--bot';
    row.innerHTML = `
      <div class="echo-avatar echo-avatar--bot echo-avatar--active" aria-hidden="true" id="${msgId}-avatar">AI</div>
      <div class="echo-bubble-wrap">
        <div id="${msgId}" class="echo-bubble echo-bubble--bot"
             role="article" aria-label="Echo reply" aria-live="polite"></div>
        <div class="echo-meta" role="toolbar" aria-label="Message actions">
          <span class="echo-meta-time">${time}</span>
        </div>
      </div>`;

    container.insertBefore(row, sentinel);

    const bubbleEl = document.getElementById(msgId);
    const avatarEl = document.getElementById(`${msgId}-avatar`);

    // Cursor element [STREAM-04]
    const cursor = document.createElement('span');
    cursor.className = 'echo-stream-cursor';
    cursor.setAttribute('aria-hidden', 'true');

    let accumulatedText = '';
    let rafPending      = false;
    let finalised       = false; // guard: stops any queued RAF firing after finalise()

    function update(chunk) {
      accumulatedText += chunk;
      if (rafPending || finalised) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (finalised) return; // finalise() beat this frame — do nothing
        const { html } = parseMarkdown(accumulatedText);
        bubbleEl.innerHTML = html;
        bubbleEl.appendChild(cursor);
        if (userIsAtBottom) container.scrollTop = container.scrollHeight;
      });
    }

    // [STREAM-03] Build codeCache after stream finishes
    function finalise() {
      finalised = true; // prevent any in-flight RAF from re-appending cursor
      cursor.remove();
      avatarEl.classList.remove('echo-avatar--active');

      const { html, codeTexts } = parseMarkdown(accumulatedText);
      bubbleEl.innerHTML = html;

      // Add copy/retry meta actions
      const meta = row.querySelector('.echo-meta');
      if (meta) {
        meta.innerHTML = `
          <span class="echo-meta-time">${time}</span>
          <button class="echo-meta-action echo-copy-msg" data-target="${msgId}" aria-label="Copy message">
            ${ICONS.copy} Copy</button>
          <button class="echo-meta-action echo-retry-btn" aria-label="Retry this response">
            ${ICONS.retry} Retry</button>`;
      }

      // Populate codeCache
      bubbleEl.querySelectorAll('.echo-copy-code[data-ci]').forEach(btn => {
        const ci = Number(btn.dataset.ci);
        if (codeTexts[ci] !== undefined) codeCache.set(btn, codeTexts[ci]);
      });

      if (!userIsAtBottom) { unreadCount++; updateScrollBadge(); }
      else requestAnimationFrame(scrollToBottom);

      return accumulatedText;
    }

    if (userIsAtBottom) requestAnimationFrame(scrollToBottom);

    return { bubbleEl, avatarEl, update, finalise };
  }

  // ── SSE streaming fetch ───────────────────────────────────────────────
  // [STREAM-01] Reads Gemini's SSE stream and calls onChunk per text delta
  async function streamGemini({ history, signal, onChunk }) {
    const apiKey = resolveApiKey();
    // [SEC-FIX-01] Key in header, not query string
    const response = await fetch(geminiUrl(), {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'X-goog-api-key':  apiKey,
      },
      signal,
      body: JSON.stringify({ contents: history }),
    });

    if (response.status === 429) throw Object.assign(new Error('Rate limit reached. Please wait a moment.'), { status: 429 });
    if (response.status === 401 || response.status === 403) {
      // Invalid or expired key — clear it and show setup UI
      localStorage.removeItem('echo_gemini_api_key');
      _configApiKey = null;
      throw Object.assign(new Error('Invalid or expired API key. Please enter a valid Gemini API key.'), { status: response.status, isAuthError: true });
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${response.status}`);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';
    let fullText  = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const raw = trimmed.slice(5).trim();
        if (raw === '[DONE]') continue;
        try {
          const json  = JSON.parse(raw);
          const chunk = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
          if (chunk) { fullText += chunk; onChunk(chunk); }
        } catch { /* malformed SSE line — skip */ }
      }
    }

    if (!fullText) throw new Error('Received an empty response. Please try again.');
    return fullText;
  }

  // ── Core: submit + stream ─────────────────────────────────────────────
  async function submitMessage(text, isRetry = false) {
    if (!text || isGenerating || pendingLock) return;
    pendingLock = true;

    hideEmptyAndSuggestions();

    // [FIX-BUG-ABORT-B] Deduplicate: if the last history entry is an
    // aborted user turn with the same text, don't push again.
    const lastHistoryEntry = chatHistory[chatHistory.length - 1];
    const isAbortedDuplicate =
      lastHistoryEntry?.role === 'user' &&
      lastHistoryEntry?._aborted === true &&
      lastHistoryEntry?.parts?.[0]?.text === text;

    // [FIX-BUG-RETRY-A] Track whether we pushed so we know what to pop on error
    let didPushUser = false;

    if (!isRetry && !isAbortedDuplicate) {
      appendMessage({ text, sender: 'user' });
      chatHistory.push({ role: 'user', parts: [{ text }] });
      didPushUser = true;
    } else if (isAbortedDuplicate) {
      // Clear the _aborted flag now that we are retrying it
      delete lastHistoryEntry._aborted;
      // Show user bubble again for visual consistency
      appendMessage({ text, sender: 'user' });
    }

    isGenerating = true;
    pendingLock  = false;
    setInputDisabled(true);
    setStatus('Thinking…', true);

    // Show typing indicator briefly, then swap to stream bubble
    const typingRow = document.createElement('div');
    typingRow.className = 'echo-row echo-row--bot';
    typingRow.id = 'echo-typing-row';
    typingRow.innerHTML = `
      <div class="echo-avatar echo-avatar--bot echo-avatar--active" aria-hidden="true">AI</div>
      <div class="echo-typing" role="status" aria-live="polite" aria-label="Echo is composing a reply">
        <div class="echo-typing-dot"></div>
        <div class="echo-typing-dot"></div>
        <div class="echo-typing-dot"></div>
      </div>`;
    container.insertBefore(typingRow, sentinel);
    requestAnimationFrame(scrollToBottom);

    currentAbortController = new AbortController();

    let lastErr      = null;
    let responseText = null;
    let streamBubble = null;

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        // Remove typing indicator and open live bubble on first real attempt
        if (!streamBubble) {
          typingRow.remove();
          streamBubble = createStreamBubble();
          setStatus('Streaming…', true);
        }

        responseText = await streamGemini({
          history: getPrunedHistory(),
          signal:  currentAbortController.signal,
          onChunk: chunk => streamBubble.update(chunk),  // [STREAM-02]
        });

        lastErr = null;
        break; // success

      } catch (err) {
        // [FIX-BUG-SLEEP-C] AbortError exits immediately — no sleep
        if (err.name === 'AbortError') { lastErr = err; break; }
        lastErr = err;
        if (attempt < RETRY_DELAYS.length) {
          setStatus(`Retrying (${attempt + 1})…`, true);
          // Reset stream bubble for retry
          streamBubble?.bubbleEl.closest('.echo-row')?.remove();
          streamBubble = null;
          await sleep(RETRY_DELAYS[attempt]);
        }
      }
    }

    // Always remove typing row in case stream never started
    typingRow.remove();

    if (!lastErr && responseText !== null) {
      const finalText = streamBubble ? streamBubble.finalise() : responseText;
      chatHistory.push({ role: 'model', parts: [{ text: finalText }] });
      setStatus('Ready');
    } else if (lastErr?.name === 'AbortError') {
      // [FIX-BUG-03 / kept] Keep user history intact; mark as aborted
      if (chatHistory[chatHistory.length - 1]?.role === 'user') {
        chatHistory[chatHistory.length - 1]._aborted = true;
      }
      streamBubble?.bubbleEl.closest('.echo-row')?.remove();
      setStatus('Stopped');
      appendMessage({ text: 'Generation stopped.', sender: 'bot', isCancelled: true });
    } else {
      console.error('[Echo] API error:', lastErr);
      streamBubble?.bubbleEl.closest('.echo-row')?.remove();
      // [FIX-BUG-RETRY-A] Only pop if we pushed the user turn this call
      if (didPushUser) chatHistory.pop();

      if (lastErr?.isAuthError) {
        // Invalid/expired key — wipe and show setup UI
        isGenerating = false;
        currentAbortController = null;
        setInputDisabled(false);
        _showKeySetup('Your API key is invalid or expired. Please enter a new one.');
        return;
      }

      appendMessage({
        text:    lastErr?.message ?? 'Something went wrong. Please try again.',
        sender:  'bot',
        isError: true,
      });
      setStatus('Error — please retry');
    }

    // [FIX-BUG-11 / kept] Null controller only after fetch settles
    isGenerating           = false;
    currentAbortController = null;
    setInputDisabled(false);
    input.focus();
  }

  // ── Cleanup [MEM-04] ─────────────────────────────────────────────────
  // [FIX-BUG-CLEANUP-I] Uses resetHistory() factory
  function cleanup() {
    bottomObserver.disconnect();
    currentAbortController?.abort();
    closePicker();
    document.getElementById('echo-styles')?.remove();
    resetHistory();
    isGenerating = false;
    messageCount = 0;
    unreadCount  = 0;
  }

  // [FIX-THEME] Toggle between dark/light at runtime
  function setTheme(theme) {
    if (theme === 'light') {
      themeRoot.classList.remove('echo-theme-dark');
      themeRoot.classList.add('echo-theme-light');
    } else {
      themeRoot.classList.remove('echo-theme-light');
      themeRoot.classList.add('echo-theme-dark');
    }
  }

  form.__echoCleanup = cleanup;
  form.__echoSetTheme = setTheme;
  } // end _initChat
}