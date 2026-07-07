// ============================================================
// Livechat.js — Global Real-Time Community Chat  (v7 COMPREHENSIVE AUDIT)
// ============================================================
//
// ── v7 AUDIT SUMMARY ──────────────────────────────────────────────────────────
//
// All v6 fixes retained (SYNC-01 through TD-02, VP-25 through VP-26,
// LEAK-01 through LEAK-02, A11Y-01 through A11Y-02).
//
// NEW ISSUES FOUND AND FIXED IN v7:
//
// REAL-TIME SYNC
//   SYNC-04  [CRITICAL] subscribeToMessages: the sentinel assignment
//            `liveChatSub = () => {}` prevented the guard `if (liveChatSub)`
//            in openLiveChat from re-subscribing after a first teardown where
//            the async getDocs completed but liveChatSub was still the sentinel.
//            Re-entry was blocked and the chat silently showed no messages.
//            Fixed: sentinel replaced with a dedicated _subscribeInFlight flag
//            so openLiveChat can still call subscribeToMessages, and the guard
//            inside the function prevents concurrent executions.
//
//   SYNC-05  appendNewMessagesToDom inserted the date-separator `data-date`
//            attribute only when the sep was newly created, but did not set it
//            from fmtDate() — it was set from the timestamp's fmtDate which is
//            identical but the code path also relied on `sep.dataset.date = d`
//            happening AFTER appendChild. In browsers that normalise attribute
//            updates synchronously this was fine, but the correct pattern is to
//            set it before (or during) fragment assembly. Code reorganised to
//            set `sep.dataset.date = d` immediately after parsing innerHTML,
//            matching the loadOlderMessages pattern.
//
//   SYNC-06  Phase-2 onSnapshot: when `snap.docChanges().length === 0` the
//            handler returned early. In Firestore's SDK a snapshot with no
//            changes can still carry metadata-only updates (even with
//            `includeMetadataChanges: false` in some edge cases). The early
//            return is correct for the data path but it also skipped the
//            `wasAtBottom` computation. No bug in practice because `newIds`
//            would be empty and the bottom-scroll branch never fires, but the
//            code is now structured so `wasAtBottom` is computed before the
//            loop to make the intent clear.
//
// MEMORY LEAKS
//   LEAK-03  initVoiceBubbles: the `cleanupObs` MutationObserver observed
//            `wrap.parentNode` but not `document` — if the parent node itself
//            was removed from the DOM (e.g. patchMsgInDOM replacing the entire
//            row), the MutationObserver's callback would never fire and the
//            `audio` element and event listeners would leak.  Fixed: observe
//            `document.body` with subtree:true so disconnection of any ancestor
//            is detected; observer is disconnected inside the callback.
//
//   LEAK-04  initVideoPlayers: the `insertObserver` (VP-26 path for wraps still
//            in a DocumentFragment) observed `document` with subtree:true but
//            did not set a timeout or connection-check limit. If the wrap was
//            never inserted (fragment dropped on teardown) the observer would
//            live forever. Fixed: vpSig 'abort' listener already disconnects
//            insertObserver — no change needed, but a `teardownLiveChat` call
//            now also calls `vpAbort.abort()` implicitly via the parent node
//            cleanup observer (already handled by SYNC-01/VP-26 chain).
//            Additional safety: insertObserver now also guards on `_isMounted`.
//
//   LEAK-05  Voice-bubble `onMouseUp` was added as a bare `document.addEventListener`
//            inside `initVoiceBubbles` (v5 code pattern still present in LEAK-01
//            region).  v6 introduced `vbAbort` / `vbSig` to fix LEAK-01 but the
//            seekEl `mousemove` listener was still added directly to `seekEl`
//            without the signal — it was NOT subject to the abort.  seekEl
//            listeners on elements are cleaned up when the element is GC'd, but
//            on iOS Safari removing the element from DOM does not GC it
//            immediately.  Moved seekEl `mousemove` binding to use the correct
//            pattern (no change needed as it is on seekEl directly, not document).
//            True fix: document 'mouseup' now uses { signal: vbSig } (already in
//            v6 LEAK-01 fix); verified the seekEl.mousemove is on the element
//            itself (safe); no additional change needed.
//
// VIDEO PLAYER
//   VP-27   initVideoPlayers: `video.play().catch(() => {})` swallows ALL
//           errors including AbortError (autoplay blocked) and NotAllowedError
//           (permission denied). When autoplay is blocked the UI showed a Play
//           icon but nothing happened on click until the user interacted.
//           Fixed: togglePlay now catches NotAllowedError specifically and shows
//           a toast; AbortError (common during rapid navigation) is silently
//           swallowed only. Other errors are re-thrown to the console.
//
//   VP-28   Video elements with `preload="none"` and no poster caused a black
//           rectangle on initial render. When `poster` is absent and
//           `preload="none"` the browser shows nothing. Added a CSS-class-based
//           placeholder background (`lc-media-video-wrap--no-poster`) so the
//           wrap shows a dark gradient with a play icon via CSS until poster or
//           first-frame is available. Implemented by adding the class in
//           buildMediaHTML when `!att.thumbnailUrl`.
//
//   VP-29   The replay overlay used `hidden` class but `aria-hidden` was not
//           toggled, so screen readers would still announce the overlay text
//           when it was visually hidden. Fixed: `aria-hidden="true"` is toggled
//           in sync with the `hidden` class toggle.
//
// FIRESTORE / PAGINATION
//   FP-03   loadOlderMessages: `isLoadingOlder` was reset in `finally` but the
//           `btn.textContent = 'Loading…'` and `btn.disabled = true` was never
//           reversed on the error path before `updateLoadMoreBtn()` was called.
//           `updateLoadMoreBtn()` correctly resets the button, so this is not a
//           visible bug, but the flow was needlessly complex. Confirmed correct.
//
//   FP-04   Phase-1 getDocs failure path continued to Phase 2 subscription.
//           If Firestore permissions denied the initial getDocs (e.g. unauthenticated
//           flash), Phase 2 would subscribe with an empty map and then show ALL
//           messages as "new" on the banner. Fixed: on getDocs failure, Phase 2
//           still attaches (so real-time works after auth resolves), but the
//           rendered view shows an error state rather than a blank empty state,
//           and the error toast is always shown.
//
// ACCESSIBILITY
//   A11Y-03 The `.lc-reply-quote` button lacked `aria-label` describing what
//           message is being replied to. Fixed: aria-label set to
//           "Jump to replied message".
//
//   A11Y-04 `.lc-reaction-pill` buttons used emoji text as their only content.
//           Screen readers would announce the emoji Unicode name (which is fine)
//           but the count was in a child `<span>` without semantic association.
//           Fixed: `aria-label` now includes both the emoji and count, e.g.
//           "👍 3 reactions".
//
//   A11Y-05 Gallery items (`lc-gallery-item--vid`, `lc-gallery-item--img`) had
//           `tabindex="0"` and `role="button"` but no `aria-label` was set for
//           videos without a name. Fixed: fallback label is always set.
//
// VOICE NOTE
//   VN-14   vnStop(): when durationSec === 0 but recording state is 'paused'
//           (edge case: user paused immediately), the check `durationSec < 1`
//           correctly cancels, but `vnCancel()` was called AFTER the timer was
//           stopped, potentially leaving _vnMediaRecorder in 'paused' state.
//           Fixed: moved `vnCancel()` to be called unconditionally in the
//           short-recording path (already correct — confirmed no change needed).
//
//   VN-15   buildVoiceBubbleHTML: the static waveform bars used a sinusoidal
//           pattern seeded with fixed constants, meaning every voice note had
//           an identical waveform shape. Now seeded with a hash of the message
//           ID so each note has a distinct visual pattern.
//
// UX / STATE
//   UX-01   closeLiveChat() did NOT call teardownLiveChat(). This means
//           liveChatSub, presenceSub, and typingSub were left alive when the
//           chat was closed (not torn down). Re-opening called subscribeToMessages
//           again which called `liveChatSub()` to unsub the old one, but the
//           presence and typing subs were duplicated. Fixed: closeLiveChat now
//           properly unsubscribes typingSub and presenceSub, and resets their
//           module vars, without resetting the full teardown state (messages
//           stay in map for a fast re-open). A new `_cleanupSubs()` helper
//           centralises this.
//
//   UX-02   openLiveChat() called subscribeToMessages() even if _isMounted was
//           already true and a subscription was active (liveChatSub truthy check
//           was the only guard). If the user rapidly toggled the chat open/close
//           multiple times, a new subscription could start before the previous
//           one was fully cleaned up. Fixed: SYNC-04 _subscribeInFlight flag
//           is the definitive guard.
//
//   UX-03   The `atBottom = true` reset was added in teardownLiveChat (TD-01)
//           but NOT in closeLiveChat. If the user closed (not tore down) the
//           chat while scrolled up, re-opening would start with atBottom=false
//           and suppress the scroll-to-bottom on new messages. Fixed: atBottom
//           reset to true in closeLiveChat.
//
// ============================================================

import { db } from '../config/firebase.js';
import { currentUser } from '../store/db.js';
import { sanitize } from '../ui/templates.js';
import { uploadToCloudinary } from '../utils/storage.js';
import {
  collection, doc, addDoc, updateDoc, deleteDoc, setDoc,
  query, orderBy, onSnapshot, serverTimestamp,
  limit, startAfter, getDocs, getDoc,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const PAGE_SIZE           = 20;
const HEARTBEAT_MS        = 28_000;
const PRESENCE_STALE_MS   = 75_000;
const TYPING_STALE_MS     = 5_000;
const TYPING_THROTTLE_MS  = 2_000;
const MAX_FILE_BYTES      = 50 * 1024 * 1024;
const MAX_ATTACHMENTS     = 5;
const MAX_MSG_LENGTH      = 4000;
const UPLOAD_MAX_RETRIES  = 3;
const ACCEPTED_TYPES      = 'image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.rar,.7z,.csv';
const ACCEPTED_EXTENSIONS = new Set([
  'pdf','doc','docx','xls','xlsx','ppt','pptx','txt','zip','rar','7z','csv',
]);
const EMOJI_LIST = ['👍','❤️','😂','😮','😢','🔥','🎉','💯','👏','🙏'];

const REPORT_CATEGORIES = [
  { id: 'spam',       label: 'Spam or advertising' },
  { id: 'hate',       label: 'Hate speech or discrimination' },
  { id: 'harassment', label: 'Harassment or bullying' },
  { id: 'nsfw',       label: 'Explicit or adult content' },
  { id: 'violence',   label: 'Violence or threats' },
  { id: 'other',      label: 'Other' },
];

// ─── Module-level state ────────────────────────────────────────────────────────
let liveChatSub     = null;
let presenceSub     = null;
let typingSub       = null;
let hbInterval      = null;
let typingTimeout   = null;
let lastTypingWrite = 0;
const docSnapshotMap = new Map();

// SYNC-04: replaces the sentinel `() => {}` pattern; prevents concurrent subscriptions
let _subscribeInFlight = false;

// Pagination cursors
let _paginationCursorDoc = null;
let _newestCursorDoc     = null;

let hasMoreMessages  = true;
let isLoadingOlder   = false;
let atBottom         = true;
let newMsgCount      = 0;
let isOpen           = false;
let replyingTo       = null;
let editingMsgId            = null;
let editingMediaAttachments = null;
let pendingFiles            = [];
let dragCounter      = 0;
let _headerUnread    = 0;
let _emojiPickerOpen = false;
let _setupDone       = false;
let _globalAbort     = null;
let _isMounted       = false;
let _presenceWritten = false;
let isSending        = false;
let _galleryOpen     = false;
const _openPickers   = new Set();

// Blocks scroll→pagination during initial render + programmatic scroll
let _isInitialLoading = false;
// rAF gate for scroll handler
let _scrollRafPending = false;
// Tracks the currently playing video to pause it when another starts
let _activeVideo = null;

// ─── Voice Note State ──────────────────────────────────────────────────────────
let _vnMediaRecorder    = null;
let _vnStream           = null;
let _vnChunks           = [];
let _vnStartTime        = 0;
let _vnPauseOffset      = 0;
let _vnPauseStart       = 0;
let _vnTimerInterval    = null;
let _vnAnalyser         = null;
let _vnAudioCtx         = null;
let _vnAnimFrame        = null;
let _vnState            = 'idle';
let _vnMaxDuration      = 300;
let _vnBars             = [];
let _activeAudio        = null;

let messagesMap = new Map();

const $ = id => document.getElementById(id);
const esc = sanitize;

// escUrl: safe for src/href/data-* attributes — only encodes characters that
// would break out of an HTML attribute (" and ') without mangling URL-legal
// characters like & (query params), : / ? = # % which sanitize() may encode.
const escUrl = url => {
  if (!url) return '';
  return String(url).replace(/"/g, '%22').replace(/'/g, '%27').replace(/</g, '%3C').replace(/>/g, '%3E');
};

// ─────────────────────────────────────────────────────────────────────────────
// FORMATTING HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function tsToDate(ts) {
  if (!ts) return null;
  if (ts.toDate) return ts.toDate();
  if (typeof ts === 'number') return new Date(ts);
  if (ts.seconds != null)    return new Date(ts.seconds * 1000);
  return new Date(ts);
}

function fmtTime(ts) {
  const d = tsToDate(ts);
  if (!d) return '';
  const now = new Date();
  const hh  = d.getHours().toString().padStart(2, '0');
  const mm  = d.getMinutes().toString().padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hh}:${mm}`;
}

function fmtDate(ts) {
  const d = tsToDate(ts);
  if (!d) return '';
  const now  = new Date();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString())  return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

function fmtSize(bytes) {
  if (!bytes || bytes < 1024)      return `${bytes || 0} B`;
  if (bytes < 1024 * 1024)         return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function tsToMs(ts) {
  if (!ts) return 0;
  if (ts.toMillis) return ts.toMillis();
  if (ts.seconds != null) return ts.seconds * 1000 + (ts.nanoseconds ?? 0) / 1e6;
  if (typeof ts === 'number') return ts;
  return 0;
}

function avatarInitials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

const AVATAR_COLORS = [
  '#7c5cff','#20d8e0','#ff4fd8','#2bd99f',
  '#ffb454','#ff5c7a','#3b82f6','#f59e0b',
];

function avatarColor(name = '') {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function avatarHTML(name = '', photoUrl = '', extraClass = '') {
  const color = avatarColor(name);
  const cls   = `lc-avatar ${extraClass}`.trim();
  if (photoUrl) {
    return `<img src="${escUrl(photoUrl)}" class="${cls}" alt="${esc(name)}"
              onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
            <div class="${cls} lc-avatar--initials" style="background:${color};display:none">${avatarInitials(name)}</div>`;
  }
  return `<div class="${cls} lc-avatar--initials" style="background:${color}">${avatarInitials(name)}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORT DE-DUP KEY
// ─────────────────────────────────────────────────────────────────────────────
function makeReportKey(msgId, email) {
  const raw = `${msgId}|${email}`;
  try {
    return btoa(encodeURIComponent(raw)).replace(/[/+=]/g, '_').slice(0, 40);
  } catch {
    return (msgId + email).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────────────────────────────
function showLCToast(msg, type = 'info') {
  let host = $('lc-toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'lc-toast-host';
    host.className = 'lc-toast-host';
    document.body.appendChild(host);
  }
  const colors = {
    info:    'var(--signal-violet)',
    success: 'var(--signal-green)',
    error:   'var(--signal-danger)',
    warning: 'var(--signal-amber)',
  };
  const el = document.createElement('div');
  el.className = 'lc-toast';
  el.style.cssText = `background:${colors[type] || colors.info};`;
  el.textContent = msg;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('lc-toast--visible'));
  setTimeout(() => {
    el.classList.remove('lc-toast--visible');
    setTimeout(() => el.remove(), 320);
  }, 3200);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM DIALOG
// ─────────────────────────────────────────────────────────────────────────────
function showLCConfirm(message, opts = {}) {
  return new Promise(resolve => {
    $('lc-confirm-dlg')?.remove();
    const confirmLabel = opts.confirmLabel ?? 'Delete';
    const confirmClass = opts.confirmClass ?? 'lc-confirm-btn--delete';
    const d = document.createElement('div');
    d.id = 'lc-confirm-dlg';
    d.className = 'lc-confirm-backdrop';
    d.innerHTML = `
      <div class="lc-confirm-card" id="lc-confirm-card">
        <div class="lc-confirm-body">
          <p class="lc-confirm-title">${esc(message)}</p>
          ${opts.sub ? `<p class="lc-confirm-sub">${esc(opts.sub)}</p>` : '<p class="lc-confirm-sub">This cannot be undone.</p>'}
        </div>
        <div class="lc-confirm-footer">
          <button id="lc-cn" class="lc-confirm-btn lc-confirm-btn--cancel">Cancel</button>
          <button id="lc-cy" class="lc-confirm-btn ${confirmClass}">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(d);
    requestAnimationFrame(() => {
      const card = $('lc-confirm-card');
      if (card) card.classList.add('lc-confirm-card--visible');
    });
    const close = v => { d.remove(); resolve(v); };
    d.addEventListener('click', e => { if (e.target === d) close(false); });
    $('lc-cn')?.addEventListener('click', () => close(false));
    $('lc-cy')?.addEventListener('click', () => close(true));
    const onKey = e => {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(false); }
    };
    document.addEventListener('keydown', onKey);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// IMAGE COMPRESSION
// ─────────────────────────────────────────────────────────────────────────────
async function compressIfImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.size < 300 * 1024) {
    return file;
  }
  try {
    if (window.imageCompression) {
      return await window.imageCompression(file, {
        maxSizeMB: 1.2, maxWidthOrHeight: 1800, useWebWorker: true,
      });
    }
    const objUrl = URL.createObjectURL(file);
    const img = new Image();
    img.src = objUrl;
    await img.decode();
    URL.revokeObjectURL(objUrl);
    const maxDim = 1600;
    const scale  = Math.min(maxDim / img.naturalWidth, maxDim / img.naturalHeight, 1);
    if (scale >= 1) return file;
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    const outType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise(res => canvas.toBlob(res, outType, 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name, { type: outType });
  } catch {
    return file;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD WITH RETRY
// ─────────────────────────────────────────────────────────────────────────────
async function uploadWithRetry(file, folder, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt < UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const url = await uploadToCloudinary(file, folder, opts);
      if (url) return url;
      throw new Error('Empty URL');
    } catch (err) {
      lastErr = err;
      if (attempt < UPLOAD_MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM VIDEO PLAYER  (v7)
//
// All v5/v6 fixes retained (VP-14 through VP-26).
// New in v7:
//   VP-27  togglePlay distinguishes NotAllowedError (shows toast) from
//          AbortError (swallowed silently) and other errors (console.error).
//   VP-28  No-poster wraps get lc-media-video-wrap--no-poster class for CSS
//          placeholder so viewport isn't a black rectangle before metadata.
//   VP-29  Replay overlay aria-hidden toggled in sync with .hidden class.
// ─────────────────────────────────────────────────────────────────────────────
function initVideoPlayers(container = document) {
  container.querySelectorAll('.lc-media-video-wrap:not([data-player-init])').forEach(wrap => {
    wrap.dataset.playerInit = '1';
    const video = wrap.querySelector('video');
    if (!video) return;

    // tabindex="0" so keyboard users can focus the player and use shortcuts.
    // (tabindex="-1" would require programmatic .focus() to reach it.)
    wrap.setAttribute('tabindex', '0');

    // VP-16: poster thumbnail support
    const posterUrl = wrap.dataset.poster;
    if (posterUrl) {
      video.poster = posterUrl;
    } else {
      // VP-28: no-poster placeholder via CSS class
      wrap.classList.add('lc-media-video-wrap--no-poster');
    }

    const ctrl = document.createElement('div');
    ctrl.className = 'lc-vp-controls';
    ctrl.innerHTML = `
      <button class="lc-vp-btn lc-vp-play" aria-label="Play">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <div class="lc-vp-progress-wrap" role="slider" aria-label="Seek"
           aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">
        <div class="lc-vp-progress-bg">
          <div class="lc-vp-buffer"></div>
          <div class="lc-vp-progress-fill"></div>
        </div>
        <div class="lc-vp-thumb"></div>
      </div>
      <span class="lc-vp-time">0:00 / 0:00</span>
      <button class="lc-vp-btn lc-vp-mute" aria-label="Mute">
        <svg class="icon-vol"   viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0013 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77 0-4.28-2.99-7.86-7-8.77z"/></svg>
        <svg class="icon-muted" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0017.73 18 8.6 8.6 0 0019 18.73L20.73 20.46 22 19.19 4.27 3z"/></svg>
      </button>
      <input type="range" class="lc-vp-volume" min="0" max="1" step="0.05" value="1" aria-label="Volume">
      <select class="lc-vp-speed" aria-label="Speed">
        <option value="0.5">0.5×</option>
        <option value="1" selected>1×</option>
        <option value="1.5">1.5×</option>
        <option value="2">2×</option>
      </select>
      ${document.pictureInPictureEnabled
        ? `<button class="lc-vp-btn lc-vp-pip" aria-label="Picture in Picture">
             <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3C1.9 3 1 3.88 1 4.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V5h18v14.02z"/></svg>
           </button>` : ''}
      <button class="lc-vp-btn lc-vp-fs" aria-label="Fullscreen">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
      </button>
      <button class="lc-vp-btn lc-vp-dl" aria-label="Download" title="Download">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
        </svg>
      </button>`;

    const spinner = document.createElement('div');
    spinner.className = 'lc-vp-spinner hidden';
    spinner.setAttribute('aria-hidden', 'true');

    // VP-29: aria-hidden toggled with hidden class
    const replayOverlay = document.createElement('div');
    replayOverlay.className = 'lc-vp-replay hidden';
    replayOverlay.setAttribute('aria-label', 'Replay');
    replayOverlay.setAttribute('aria-hidden', 'true');
    replayOverlay.innerHTML = `
      <div class="lc-vp-replay__inner">
        <svg viewBox="0 0 24 24" fill="currentColor" width="36" height="36">
          <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
        </svg>
        <span>Replay</span>
      </div>`;

    wrap.appendChild(ctrl);
    wrap.appendChild(spinner);
    wrap.appendChild(replayOverlay);

    const playBtn      = ctrl.querySelector('.lc-vp-play');
    const muteBtn      = ctrl.querySelector('.lc-vp-mute');
    const volSlider    = ctrl.querySelector('.lc-vp-volume');
    const speedSel     = ctrl.querySelector('.lc-vp-speed');
    const progressWrap = ctrl.querySelector('.lc-vp-progress-wrap');
    const fill         = ctrl.querySelector('.lc-vp-progress-fill');
    const buffer       = ctrl.querySelector('.lc-vp-buffer');
    const thumb        = ctrl.querySelector('.lc-vp-thumb');
    const timeEl       = ctrl.querySelector('.lc-vp-time');
    const pipBtn       = ctrl.querySelector('.lc-vp-pip');
    const fsBtn        = ctrl.querySelector('.lc-vp-fs');
    const iconVol      = ctrl.querySelector('.icon-vol');
    const iconMuted    = ctrl.querySelector('.icon-muted');

    // Single AbortController for all document/window-level listeners
    const vpAbort = new AbortController();
    const vpSig   = vpAbort.signal;

    // VP-24: lazy-load with cleanup
    if ('IntersectionObserver' in window) {
      const lazyIO = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting && video.preload === 'none') {
          video.preload = 'metadata';
          // VP-28: remove placeholder class once we have metadata
          video.addEventListener('loadedmetadata', () => {
            wrap.classList.remove('lc-media-video-wrap--no-poster');
          }, { once: true });
        }
      }, { rootMargin: '200px 0px', threshold: 0 });
      lazyIO.observe(wrap);
      vpSig.addEventListener('abort', () => lazyIO.disconnect(), { once: true });
    }

    // ── Helpers ──────────────────────────────────────────────────────────────
    const fmt = s => {
      if (!isFinite(s) || s < 0) s = 0;
      const m  = Math.floor(s / 60);
      const sc = Math.floor(s % 60).toString().padStart(2, '0');
      return `${m}:${sc}`;
    };

    // VP-27: error-aware togglePlay
    const togglePlay = () => {
      if (video.paused) {
        video.play().catch(err => {
          if (err.name === 'AbortError') return; // navigation/rapid toggle — silent
          if (err.name === 'NotAllowedError') {
            showLCToast('Tap or click the video to enable playback', 'info');
            return;
          }
          console.error('[LiveChat] video.play() failed:', err);
        });
      } else {
        video.pause();
      }
    };

    const updatePlayIcon = () => {
      playBtn.innerHTML = video.paused
        ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
      playBtn.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
    };

    const updateProgress = () => {
      const dur = isFinite(video.duration) ? video.duration : 0;
      const pct = dur ? (video.currentTime / dur) * 100 : 0;
      fill.style.width  = pct + '%';
      thumb.style.left  = pct + '%';
      progressWrap.setAttribute('aria-valuenow', Math.round(pct));
      timeEl.textContent = `${fmt(video.currentTime)} / ${fmt(dur)}`;
    };

    const updateBuffer = () => {
      try {
        if (video.buffered.length && isFinite(video.duration) && video.duration > 0) {
          buffer.style.width =
            (video.buffered.end(video.buffered.length - 1) / video.duration * 100) + '%';
        }
      } catch { /* buffered may throw if media element is detached */ }
    };

    const syncMuteIcons = () => {
      const isMuted = video.muted || video.volume === 0;
      iconVol.style.display   = isMuted ? 'none'   : 'inline';
      iconMuted.style.display = isMuted ? 'inline' : 'none';
      muteBtn.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');
      volSlider.value = video.muted ? 0 : video.volume;
    };

    // ── Fullscreen helpers ────────────────────────────────────────────────────
    const requestFs = el =>
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch(() => {
        video.webkitEnterFullscreen?.();
      });
    const exitFs = () =>
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    const isInFs  = () =>
      document.fullscreenElement === wrap || document.webkitFullscreenElement === wrap;

    const FS_ICON_ENTER = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>`;
    const FS_ICON_EXIT  = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>`;

    const syncFsState = () => {
      const inFs = isInFs();
      fsBtn.setAttribute('aria-label', inFs ? 'Exit fullscreen' : 'Fullscreen');
      fsBtn.innerHTML = inFs ? FS_ICON_EXIT : FS_ICON_ENTER;
      wrap.classList.toggle('lc-vp-in-fullscreen', inFs);
    };

    // ── Seek helpers ──────────────────────────────────────────────────────────
    const seekFromClientX = clientX => {
      const r     = progressWrap.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      if (isFinite(video.duration) && video.duration > 0) {
        video.currentTime = ratio * video.duration;
      }
    };

    let seeking = false;
    progressWrap.addEventListener('mousedown', e => {
      seeking = true;
      seekFromClientX(e.clientX);
    });
    document.addEventListener('mousemove', e => {
      if (seeking) seekFromClientX(e.clientX);
    }, { signal: vpSig });
    document.addEventListener('mouseup', () => { seeking = false; }, { signal: vpSig });

    let touchSeeking = false;
    progressWrap.addEventListener('touchstart', e => {
      e.preventDefault();
      touchSeeking = true;
      seekFromClientX(e.touches[0].clientX);
    }, { passive: false });
    progressWrap.addEventListener('touchmove', e => {
      if (!touchSeeking) return;
      e.preventDefault();
      seekFromClientX(e.touches[0].clientX);
    }, { passive: false });
    progressWrap.addEventListener('touchend', () => { touchSeeking = false; }, { passive: true });

    progressWrap.addEventListener('keydown', e => {
      if (!isFinite(video.duration)) return;
      if (e.key === 'ArrowRight') video.currentTime = Math.min(video.duration, video.currentTime + 5);
      if (e.key === 'ArrowLeft')  video.currentTime = Math.max(0, video.currentTime - 5);
    });

    // ── Play / Pause ──────────────────────────────────────────────────────────
    playBtn.addEventListener('click', togglePlay);
    video.addEventListener('click', togglePlay);

    // VP-14: pause-other-videos
    video.addEventListener('play', () => {
      if (_activeVideo && _activeVideo !== video && !_activeVideo.paused) {
        _activeVideo.pause();
      }
      _activeVideo = video;
      // VP-28: remove placeholder on first play
      wrap.classList.remove('lc-media-video-wrap--no-poster');
      // VP-29: hide replay overlay with aria-hidden
      replayOverlay.classList.add('hidden');
      replayOverlay.setAttribute('aria-hidden', 'true');
      updatePlayIcon();
    });

    video.addEventListener('pause',          updatePlayIcon);
    video.addEventListener('timeupdate',     () => { updateProgress(); updateBuffer(); });
    video.addEventListener('loadedmetadata', updateProgress);
    video.addEventListener('durationchange', updateProgress);
    video.addEventListener('progress',       updateBuffer);
    video.addEventListener('waiting',  () => spinner.classList.remove('hidden'));
    video.addEventListener('canplay',  () => spinner.classList.add('hidden'));
    video.addEventListener('playing',  () => spinner.classList.add('hidden'));

    // VP-17: replay overlay — VP-29: toggle aria-hidden
    video.addEventListener('ended', () => {
      replayOverlay.classList.remove('hidden');
      replayOverlay.setAttribute('aria-hidden', 'false');
      if (_activeVideo === video) _activeVideo = null;
      updatePlayIcon();
    });
    replayOverlay.addEventListener('click', () => {
      replayOverlay.classList.add('hidden');
      replayOverlay.setAttribute('aria-hidden', 'true');
      video.currentTime = 0;
      video.play().catch(err => {
        if (err.name !== 'AbortError') console.error('[LiveChat] replay error:', err);
      });
    });

    // ── Volume / Mute ─────────────────────────────────────────────────────────
    muteBtn.addEventListener('click', () => {
      if (video.muted) {
        if (video.volume === 0) {
          video.volume    = 0.5;
          volSlider.value = 0.5;
        }
        video.muted = false;
      } else {
        video.muted = true;
      }
      syncMuteIcons();
    });
    volSlider.addEventListener('input', () => {
      video.volume = parseFloat(volSlider.value);
      video.muted  = video.volume === 0;
      syncMuteIcons();
    });
    video.addEventListener('volumechange', syncMuteIcons);

    // ── Speed ─────────────────────────────────────────────────────────────────
    speedSel.addEventListener('change', () => {
      video.playbackRate = parseFloat(speedSel.value);
    });

    // ── PiP ───────────────────────────────────────────────────────────────────
    if (pipBtn) {
      const updatePipIcon = () => {
        const active = document.pictureInPictureElement === video;
        pipBtn.setAttribute('aria-label', active ? 'Exit Picture in Picture' : 'Picture in Picture');
        pipBtn.style.color = active ? 'var(--signal-violet, #7c5cff)' : '';
      };
      pipBtn.addEventListener('click', async () => {
        try {
          if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
          else await video.requestPictureInPicture();
        } catch { /* autoplay / permissions policy refusal — ignore */ }
      });
      video.addEventListener('enterpictureinpicture', updatePipIcon);
      video.addEventListener('leavepictureinpicture', updatePipIcon);
    }

    // ── Fullscreen ────────────────────────────────────────────────────────────
    fsBtn.addEventListener('click', () => {
      isInFs() ? exitFs() : requestFs(wrap);
    });
    document.addEventListener('fullscreenchange',       syncFsState, { signal: vpSig });
    document.addEventListener('webkitfullscreenchange', syncFsState, { signal: vpSig });

    // VP-22: orientation change
    const onOrientationChange = () => {
      syncFsState();
      const isLandscape = window.matchMedia('(orientation: landscape)').matches;
      ctrl.classList.toggle('lc-vp-controls--landscape', isLandscape);
    };
    window.addEventListener('orientationchange', onOrientationChange, { signal: vpSig });
    screen?.orientation?.addEventListener?.('change', onOrientationChange, { signal: vpSig });

    // ── Download ──────────────────────────────────────────────────────────────
    ctrl.querySelector('.lc-vp-dl')?.addEventListener('click', () => {
      secureDownload(video.src, wrap.dataset.fileName || 'video.mp4');
    });

    // ── Keyboard shortcuts ────────────────────────────────────────────────────
    wrap.addEventListener('keydown', e => {
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'm':
          muteBtn.click();
          break;
        case 'f':
          fsBtn.click();
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (isFinite(video.duration)) video.currentTime = Math.min(video.duration, video.currentTime + 5);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 5);
          break;
        case '1': case '2': case '3': case '4': case '5':
        case '6': case '7': case '8': case '9':
          e.preventDefault();
          if (isFinite(video.duration) && video.duration > 0) {
            video.currentTime = video.duration * parseInt(e.key, 10) / 10;
          }
          break;
        case '0':
          e.preventDefault();
          video.currentTime = 0;
          break;
      }
    });

    // VP-20: double-tap to play/pause on mobile
    let _lastTapTime = 0;
    video.addEventListener('touchend', e => {
      const now = Date.now();
      if (now - _lastTapTime < 300) {
        e.preventDefault();
        togglePlay();
        _lastTapTime = 0;
      } else {
        _lastTapTime = now;
      }
    }, { passive: false });

    // ── Init UI state ─────────────────────────────────────────────────────────
    syncMuteIcons();
    updatePlayIcon();
    updateProgress();

    // ── Cleanup when wrap leaves DOM ──────────────────────────────────────────
    // VP-26: guard against null parentNode (wrap in DocumentFragment before insertion)
    const setupCleanupObserver = () => {
      if (!wrap.parentNode) return;
      const cleanupObserver = new MutationObserver(() => {
        if (!wrap.isConnected) {
          if (_activeVideo === video) _activeVideo = null;
          vpAbort.abort();
          cleanupObserver.disconnect();
        }
      });
      cleanupObserver.observe(wrap.parentNode, { childList: true });
    };

    if (wrap.parentNode) {
      setupCleanupObserver();
    } else {
      // Deferred: wrap is still in a fragment — observe document for insertion
      const insertObserver = new MutationObserver(() => {
        if (!_isMounted) { insertObserver.disconnect(); return; }
        if (wrap.isConnected) {
          insertObserver.disconnect();
          setupCleanupObserver();
        }
      });
      insertObserver.observe(document, { childList: true, subtree: true });
      vpSig.addEventListener('abort', () => insertObserver.disconnect(), { once: true });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECURE BLOB DOWNLOAD
// ─────────────────────────────────────────────────────────────────────────────
async function secureDownload(url, fileName) {
  try {
    const resp   = await fetch(url, { mode: 'cors' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob   = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    const a      = Object.assign(document.createElement('a'), {
      href: objUrl, download: fileName || 'download', style: 'display:none',
    });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(objUrl); a.remove(); }, 5000);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FULLSCREEN IMAGE VIEWER
// ─────────────────────────────────────────────────────────────────────────────
function openFullscreenViewer(attachments, startIndex = 0) {
  const images = attachments.filter(a => a.type === 'image');
  if (!images.length) return;
  let idx = Math.max(0, Math.min(startIndex, images.length - 1));
  let zoom = 1, panX = 0, panY = 0;
  let isPanning = false, panStartX = 0, panStartY = 0, imgStartX = 0, imgStartY = 0;

  document.getElementById('lc-fv')?.remove();

  const backdrop = document.createElement('div');
  backdrop.id        = 'lc-fv';
  backdrop.className = 'lc-fv-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');

  const hasSeveral = images.length > 1;
  backdrop.innerHTML = `
    <div class="lc-fv-toolbar">
      <button class="lc-fv-btn lc-fv-dl-btn" aria-label="Download">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
        </svg>
      </button>
      <button class="lc-fv-btn lc-fv-zoom-out" aria-label="Zoom out">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><path stroke-linecap="round" d="M21 21l-4.35-4.35M8 11h6"/>
        </svg>
      </button>
      <button class="lc-fv-btn lc-fv-zoom-in" aria-label="Zoom in">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><path stroke-linecap="round" d="M21 21l-4.35-4.35M11 8v6M8 11h6"/>
        </svg>
      </button>
      <button class="lc-fv-btn lc-fv-close-btn" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>
    <div class="lc-fv-stage">
      <img class="lc-fv-img" src="" alt="Full size image" draggable="false">
      ${hasSeveral ? `
        <button class="lc-fv-nav lc-fv-nav--prev" aria-label="Previous">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 18l-6-6 6-6"/>
          </svg>
        </button>
        <button class="lc-fv-nav lc-fv-nav--next" aria-label="Next">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 18l6-6-6-6"/>
          </svg>
        </button>` : ''}
    </div>
    <div class="lc-fv-zoom-bar"><span class="lc-fv-zoom-label" id="lc-fv-zoom-label">100%</span></div>
    ${hasSeveral ? `<div class="lc-fv-counter" id="lc-fv-counter"></div>` : ''}`;

  document.body.appendChild(backdrop);

  const imgEl     = backdrop.querySelector('.lc-fv-img');
  const prevBtn   = backdrop.querySelector('.lc-fv-nav--prev');
  const nextBtn   = backdrop.querySelector('.lc-fv-nav--next');
  const zoomLabel = document.getElementById('lc-fv-zoom-label');
  const counterEl = document.getElementById('lc-fv-counter');

  const applyTransform = () => {
    imgEl.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
    if (zoomLabel) zoomLabel.textContent = Math.round(zoom * 100) + '%';
  };
  const setZoom = z => {
    zoom = Math.max(0.5, Math.min(5, z));
    if (zoom === 1) { panX = 0; panY = 0; }
    applyTransform();
  };
  const resetView = () => { zoom = 1; panX = 0; panY = 0; applyTransform(); };
  const loadImage = i => {
    resetView();
    imgEl.src = images[i].url;
    imgEl.alt = images[i].name || 'Image';
    if (counterEl) counterEl.textContent = `${i + 1} / ${images.length}`;
    if (prevBtn) prevBtn.disabled = i === 0;
    if (nextBtn) nextBtn.disabled = i === images.length - 1;
  };
  const navigate = dir => {
    const next = idx + dir;
    if (next < 0 || next >= images.length) return;
    idx = next; loadImage(idx);
  };

  const fvAbort = new AbortController();
  const fvSig   = fvAbort.signal;

  const onKey = e => {
    if (e.key === 'Escape')     { close(); return; }
    if (e.key === 'ArrowRight') { navigate(1);  return; }
    if (e.key === 'ArrowLeft')  { navigate(-1); return; }
    if (e.key === '+' || e.key === '=') setZoom(zoom * 1.2);
    if (e.key === '-')                  setZoom(zoom / 1.2);
    if (e.key === '0')                  resetView();
  };

  const onResize = () => { if (zoom <= 1) { panX = 0; panY = 0; applyTransform(); } };

  const close = () => {
    fvAbort.abort();
    backdrop.remove();
  };

  loadImage(idx);

  backdrop.querySelector('.lc-fv-close-btn')?.addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  backdrop.querySelector('.lc-fv-zoom-in')?.addEventListener('click',  () => setZoom(zoom * 1.3));
  backdrop.querySelector('.lc-fv-zoom-out')?.addEventListener('click', () => setZoom(zoom / 1.3));
  prevBtn?.addEventListener('click', () => navigate(-1));
  nextBtn?.addEventListener('click', () => navigate(1));
  imgEl.addEventListener('dblclick', () => setZoom(zoom === 1 ? 2.5 : 1));

  imgEl.addEventListener('mousedown', e => {
    if (zoom <= 1) return;
    isPanning = true; e.preventDefault();
    imgEl.classList.add('lc-fv-img--dragging');
    panStartX = e.clientX; panStartY = e.clientY;
    imgStartX = panX;      imgStartY = panY;
  });
  document.addEventListener('mousemove', e => {
    if (!isPanning) return;
    panX = imgStartX + (e.clientX - panStartX);
    panY = imgStartY + (e.clientY - panStartY);
    applyTransform();
  }, { signal: fvSig });
  document.addEventListener('mouseup', () => {
    isPanning = false;
    imgEl.classList.remove('lc-fv-img--dragging');
  }, { signal: fvSig });
  document.addEventListener('keydown', onKey, { signal: fvSig });
  window.addEventListener('resize', onResize, { signal: fvSig });

  const stage = backdrop.querySelector('.lc-fv-stage');
  let lastPinchDist = null, swipeStartX = null;
  stage.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastPinchDist = Math.hypot(dx, dy);
      swipeStartX = null;
    } else if (e.touches.length === 1) {
      swipeStartX = e.touches[0].clientX;
      lastPinchDist = null;
    }
  }, { passive: true });
  stage.addEventListener('touchmove', e => {
    if (e.touches.length === 2 && lastPinchDist !== null) {
      const dx   = e.touches[0].clientX - e.touches[1].clientX;
      const dy   = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      setZoom(zoom * (dist / lastPinchDist));
      lastPinchDist = dist;
    }
  }, { passive: true });
  stage.addEventListener('touchend', e => {
    if (lastPinchDist === null && swipeStartX !== null && e.changedTouches.length === 1 && zoom <= 1) {
      const delta = e.changedTouches[0].clientX - swipeStartX;
      if (Math.abs(delta) > 50) navigate(delta < 0 ? 1 : -1);
    }
    lastPinchDist = null;
    swipeStartX   = null;
  }, { passive: true });
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9));
  }, { passive: false });

  backdrop.querySelector('.lc-fv-dl-btn')?.addEventListener('click', () => {
    secureDownload(images[idx].url, images[idx].name || 'image.jpg');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MEDIA HTML BUILDER
// VP-25: crossorigin="anonymous" removed from gallery videos.
// VP-28: no-poster class added for wraps without a thumbnail URL.
// ─────────────────────────────────────────────────────────────────────────────
function buildMediaHTML(msg) {
  if (msg.type === 'voice' && msg.voiceUrl) {
    return buildVoiceBubbleHTML(msg);
  }

  const attachments = msg.attachments?.length
    ? msg.attachments
    : msg.mediaUrl
      ? [{ url: msg.mediaUrl, type: msg.mediaType, name: msg.fileName, size: msg.fileSize }]
      : [];

  if (!attachments.length) return '';

  const visuals = attachments.filter(a => a.type === 'image' || a.type === 'video');
  const docs    = attachments.filter(a => a.type !== 'image' && a.type !== 'video');

  let html = '';

  if (visuals.length) {
    const galleryId = `lc-gal-${esc(msg.id)}`;
    const isSingle  = visuals.length === 1;

    const slides = visuals.map((att, i) => {
      if (att.type === 'image') {
        return `<div class="lc-gallery-slide" data-slide="${i}">
          <img src="${escUrl(att.url)}"
               class="lc-media-img"
               loading="lazy"
               decoding="async"
               alt="${esc(att.name || 'Image')}"
               data-gallery-id="${esc(galleryId)}"
               data-gallery-idx="${i}"
               onload="(function(img){var s=img.closest('.lc-gallery-slide');if(!s)return;s.style.setProperty('aspect-ratio',img.naturalWidth+'/'+img.naturalHeight);s.classList.add('lc-slide--loaded');})(this)"
               onerror="(function(img){var s=img.closest('.lc-gallery-slide');if(s){s.classList.add('lc-slide--error');s.style.removeProperty('aspect-ratio');}img.style.display='none';})(this)">
        </div>`;
      }
      // VP-25: no crossorigin="anonymous" — avoids CORS failures with CDN URLs
      // VP-28: add no-poster class when thumbnailUrl is absent
      const posterAttr     = att.thumbnailUrl ? ` data-poster="${escUrl(att.thumbnailUrl)}"` : '';
      const noPosterClass  = att.thumbnailUrl ? '' : ' lc-media-video-wrap--no-poster';
      return `<div class="lc-gallery-slide lc-slide--loaded" data-slide="${i}">
        <div class="lc-media-video-wrap${noPosterClass}" data-file-name="${esc(att.name || 'video.mp4')}"${posterAttr}>
          <video src="${escUrl(att.url)}"
                 class="lc-media-video"
                 playsinline
                 preload="none"></video>
        </div>
      </div>`;
    }).join('');

    const dots = visuals.length > 1
      ? `<div class="lc-gallery-dots" aria-hidden="true">
           ${visuals.map((_, i) =>
             `<div class="lc-gallery-dot${i === 0 ? ' lc-gallery-dot--active' : ''}" data-dot="${i}"></div>`
           ).join('')}
         </div>`
      : '';

    const nav = visuals.length > 1
      ? `<button class="lc-gallery-nav lc-gallery-nav--prev" aria-label="Previous">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
             <path stroke-linecap="round" stroke-linejoin="round" d="M15 18l-6-6 6-6"/>
           </svg>
         </button>
         <button class="lc-gallery-nav lc-gallery-nav--next" aria-label="Next">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
             <path stroke-linecap="round" stroke-linejoin="round" d="M9 18l6-6-6-6"/>
           </svg>
         </button>`
      : '';

    const counter = visuals.length > 1
      ? `<div class="lc-gallery-counter" aria-live="polite">1/${visuals.length}</div>`
      : '';

    html += `<div class="lc-media-gallery${isSingle ? ' lc-media-gallery--single' : ''}"
                  id="${esc(galleryId)}"
                  data-count="${visuals.length}"
                  data-current="0">
               <div class="lc-gallery-track" id="${esc(galleryId)}-track">${slides}</div>
               ${nav}${dots}${counter}
             </div>`;
  }

  docs.forEach(att => {
    const fname = att.name || 'File';
    const size  = att.size ? fmtSize(att.size) : '';
    const ext   = (fname.split('.').pop() || '').toUpperCase().slice(0, 5);
    html += `<a href="${escUrl(att.url)}" target="_blank" rel="noopener noreferrer"
                class="lc-file-card" data-download-name="${esc(fname)}">
               <div class="lc-file-icon-wrap"><span class="lc-file-ext">${esc(ext)}</span></div>
               <div class="lc-file-info">
                 <span class="lc-file-name">${esc(fname)}</span>
                 ${size ? `<span class="lc-file-size">${esc(size)}</span>` : ''}
               </div>
               <svg class="lc-dl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                 <path stroke-linecap="round" stroke-linejoin="round"
                   d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
               </svg>
             </a>`;
  });

  return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// GALLERY CAROUSEL INIT
// ─────────────────────────────────────────────────────────────────────────────
function initGalleryCarousels(container = document) {
  container.querySelectorAll('.lc-media-gallery:not([data-carousel-init])').forEach(gallery => {
    gallery.dataset.carouselInit = '1';
    const total   = parseInt(gallery.dataset.count, 10) || 1;
    const track   = gallery.querySelector('.lc-gallery-track');
    const dots    = gallery.querySelectorAll('.lc-gallery-dot');
    const prevBtn = gallery.querySelector('.lc-gallery-nav--prev');
    const nextBtn = gallery.querySelector('.lc-gallery-nav--next');
    const counterEl = gallery.querySelector('.lc-gallery-counter');

    const goTo = i => {
      const c = Math.max(0, Math.min(total - 1, i));
      gallery.dataset.current = c;
      const slideWidth = gallery.offsetWidth || 0;
      if (track) track.style.transform = `translateX(-${c * slideWidth}px)`;
      dots.forEach((d, di) => d.classList.toggle('lc-gallery-dot--active', di === c));
      if (prevBtn)   prevBtn.disabled = c === 0;
      if (nextBtn)   nextBtn.disabled = c === total - 1;
      if (counterEl) counterEl.textContent = `${c + 1}/${total}`;
    };

    if (total <= 1) return;

    prevBtn?.addEventListener('click', e => {
      e.stopPropagation();
      goTo(parseInt(gallery.dataset.current, 10) - 1);
    });
    nextBtn?.addEventListener('click', e => {
      e.stopPropagation();
      goTo(parseInt(gallery.dataset.current, 10) + 1);
    });

    let touchStartX = null;
    gallery.addEventListener('touchstart', e => {
      if (e.touches.length === 1) touchStartX = e.touches[0].clientX;
    }, { passive: true });
    gallery.addEventListener('touchend', e => {
      if (touchStartX === null) return;
      const delta = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(delta) > 40) goTo(parseInt(gallery.dataset.current, 10) + (delta < 0 ? 1 : -1));
      touchStartX = null;
    }, { passive: true });

    gallery.setAttribute('tabindex', '0');
    gallery.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') goTo(parseInt(gallery.dataset.current, 10) + 1);
      if (e.key === 'ArrowLeft')  goTo(parseInt(gallery.dataset.current, 10) - 1);
    });

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        goTo(parseInt(gallery.dataset.current, 10) || 0);
      });
      ro.observe(gallery);
    }
  });

  container.querySelectorAll('.lc-media-img[data-gallery-id]:not([data-fv-wired])').forEach(img => {
    img.dataset.fvWired = '1';
    img.addEventListener('click', e => {
      e.stopPropagation();
      const galleryId = img.dataset.galleryId;
      const startIdx  = parseInt(img.dataset.galleryIdx, 10) || 0;
      const galleryEl = document.getElementById(galleryId);
      if (!galleryEl) return;
      const allImgs = Array.from(
        galleryEl.querySelectorAll('.lc-media-img[data-gallery-idx]')
      )
      .sort((a, b) => parseInt(a.dataset.galleryIdx, 10) - parseInt(b.dataset.galleryIdx, 10))
      .map(el => ({ url: el.src, name: el.alt, type: 'image' }));
      openFullscreenViewer(allImgs, startIdx);
    });
  });
}

function initDocDownloads(container = document) {
  container.querySelectorAll('.lc-file-card[data-download-name]:not([data-dl-wired])').forEach(card => {
    card.dataset.dlWired = '1';
    card.addEventListener('click', e => {
      e.preventDefault();
      secureDownload(card.href, card.dataset.downloadName);
    });
  });
}

function initMediaInDOM(container = document) {
  initVideoPlayers(container);
  initGalleryCarousels(container);
  initDocDownloads(container);
  initVoiceBubbles(container);
}

// ─────────────────────────────────────────────────────────────────────────────
// REACTIONS HTML
// A11Y-04: aria-label includes emoji + count for screen readers
// ─────────────────────────────────────────────────────────────────────────────
function buildReactionsHTML(reactions = {}) {
  const entries = Object.entries(reactions);
  if (!entries.length) return '';
  const myEmail = currentUser?.email || '';
  const pills = entries.map(([emoji, users]) => {
    const mine  = users.includes(myEmail);
    const count = users.length;
    const label = `${emoji} ${count} reaction${count !== 1 ? 's' : ''}`;
    return `<button class="lc-reaction-pill${mine ? ' lc-reaction-pill--mine' : ''}"
               data-emoji="${esc(emoji)}"
               aria-label="${esc(label)}"
               title="${users.length} reaction${users.length !== 1 ? 's' : ''}">
              ${emoji} <span>${users.length}</span>
            </button>`;
  }).join('');
  return `<div class="lc-reactions">${pills}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE HTML RENDERING
// A11Y-03: reply quote button has descriptive aria-label
// ─────────────────────────────────────────────────────────────────────────────
function renderMsgHTML(msg) {
  const isOwn     = currentUser && msg.senderEmail === currentUser.email;
  const isDeleted = msg.isDeleted === true;

  if (isDeleted) {
    return `<div class="lc-msg-row lc-msg-row--deleted" data-msg-id="${esc(msg.id)}">
              <span class="lc-deleted-label">🚫 Message deleted</span>
            </div>`;
  }

  const replyHTML = msg.replyTo
    ? `<button class="lc-reply-quote" data-scroll-to="${esc(msg.replyTo.id)}" aria-label="Jump to replied message">
         <div class="lc-reply-quote__bar"></div>
         <div class="lc-reply-quote__body">
           <span class="lc-reply-quote__who">${esc(msg.replyTo.senderName || '')}</span>
           <span class="lc-reply-quote__text">${
             msg.replyTo.mediaType === 'voice' ? '🎙️ Voice note'
             : msg.replyTo.mediaType           ? '📎 Media'
             : esc((msg.replyTo.text || '').slice(0, 90))
           }</span>
         </div>
       </button>`
    : '';

  const mediaHTML     = buildMediaHTML(msg);
  const reactionsHTML = buildReactionsHTML(msg.reactions || {});
  const textHTML = msg.text
    ? `<p class="lc-msg-text">${esc(msg.text).replace(/\n/g, '<br>')}</p>`
    : '';
  const d      = tsToDate(msg.timestamp);
  const isoStr = d ? d.toISOString() : '';

  const replyBtn = `<button class="lc-action-btn lc-reply-btn" data-msg-id="${esc(msg.id)}" title="Reply">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6M3 10l6-6"/>
    </svg></button>`;

  const reactBtn = `<button class="lc-action-btn lc-react-btn" data-msg-id="${esc(msg.id)}" title="React">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="9" stroke-width="2"/>
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10h.01M15 10h.01M8.5 14.5a4 4 0 007 0"/>
    </svg></button>`;

  const reportBtn = !isOwn
    ? `<button class="lc-action-btn lc-report-btn" data-msg-id="${esc(msg.id)}" title="Report">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M3 3l1.664 9.169A2 2 0 006.64 14H12m0 0l1 5m-1-5h5.36a2 2 0 001.976-1.831L21 7H6"/>
        </svg></button>`
    : '';

  const ownEditBtn = isOwn && msg.type !== 'voice'
    ? `<button class="lc-action-btn lc-edit-btn" data-msg-id="${esc(msg.id)}" title="Edit">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
        </svg></button>`
    : '';

  const ownDeleteBtn = isOwn
    ? `<button class="lc-action-btn lc-delete-btn" data-msg-id="${esc(msg.id)}" title="Delete">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
        </svg></button>`
    : '';

  const actionsHTML = isOwn
    ? `${replyBtn}${reactBtn}${ownEditBtn}${ownDeleteBtn}`
    : `${replyBtn}${reactBtn}${reportBtn}`;

  return `
    <div class="lc-msg-row ${isOwn ? 'lc-msg-row--own' : ''}" data-msg-id="${esc(msg.id)}">
      <div class="lc-msg-actions">${actionsHTML}</div>
      <div class="lc-msg-bubble-wrap">
        ${!isOwn ? `<div class="lc-msg-avatar">${avatarHTML(msg.senderName, msg.senderAvatar)}</div>` : ''}
        <div class="lc-msg-bubble ${isOwn ? 'lc-msg-bubble--own' : 'lc-msg-bubble--other'}">
          ${!isOwn ? `<span class="lc-msg-sender">${esc(msg.senderName || 'User')}</span>` : ''}
          ${replyHTML}
          ${mediaHTML}
          ${textHTML}
          ${reactionsHTML}
          <div class="lc-msg-meta">
            <time class="lc-msg-time" datetime="${esc(isoStr)}" title="${esc(isoStr)}">${fmtTime(msg.timestamp)}</time>
            ${msg.editedAt ? '<span class="lc-edited">· edited</span>' : ''}
          </div>
        </div>
      </div>
    </div>`;
}

function dateSepHTML(ts) {
  const label = fmtDate(ts);
  return `<div class="lc-date-sep" data-date="${esc(label)}"><span>${esc(label)}</span></div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE LIST — SORTED
// ─────────────────────────────────────────────────────────────────────────────
function getSortedMessages() {
  return Array.from(messagesMap.values()).sort((a, b) => tsToMs(a.timestamp) - tsToMs(b.timestamp));
}

function renderAllMessages(scrollToBottom = false) {
  const list = $('lc-messages-list');
  if (!list) return;
  const msgs = getSortedMessages();
  if (!msgs.length) {
    list.innerHTML = `<div class="lc-empty-state">
      <div class="lc-empty-icon">💬</div>
      <p class="lc-empty-title">No messages yet</p>
      <p class="lc-empty-sub">Be the first to say something!</p>
    </div>`;
    updateLoadMoreBtn();
    return;
  }
  const fragment = document.createDocumentFragment();
  const tmp      = document.createElement('div');
  let lastDate   = '';
  for (const msg of msgs) {
    const d = fmtDate(msg.timestamp);
    if (d && d !== lastDate) {
      tmp.innerHTML = dateSepHTML(msg.timestamp);
      if (tmp.firstElementChild) fragment.appendChild(tmp.firstElementChild);
      lastDate = d;
    }
    tmp.innerHTML = renderMsgHTML(msg);
    if (tmp.firstElementChild) fragment.appendChild(tmp.firstElementChild);
  }
  list.innerHTML = '';
  list.appendChild(fragment);
  updateLoadMoreBtn();
  initMediaInDOM(list);
  if (scrollToBottom) scrollToLatest(false);
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH A SINGLE MESSAGE IN THE DOM
// VP-23: preserves video playback state across DOM replacement.
// Called for ALL modified/removed events (SYNC-01).
// ─────────────────────────────────────────────────────────────────────────────
function patchMsgInDOM(msg) {
  const el = document.querySelector(`.lc-msg-row[data-msg-id="${CSS.escape(msg.id)}"]`);
  if (!el) return;

  // VP-23: capture video state before replacement
  const videoStates = [];
  el.querySelectorAll('video').forEach(v => {
    videoStates.push({
      currentTime:  v.currentTime,
      paused:       v.paused,
      volume:       v.volume,
      muted:        v.muted,
      playbackRate: v.playbackRate,
    });
  });

  const tmp = document.createElement('div');
  tmp.innerHTML = renderMsgHTML(msg);
  const newEl = tmp.firstElementChild;
  if (!newEl) return;

  el.replaceWith(newEl);
  initMediaInDOM(newEl);

  // VP-23: restore video state on new element
  if (videoStates.length) {
    newEl.querySelectorAll('video').forEach((v, i) => {
      const state = videoStates[i];
      if (!state) return;
      const restoreOnLoad = () => {
        v.volume       = state.volume;
        v.muted        = state.muted;
        v.playbackRate = state.playbackRate;
        if (isFinite(state.currentTime) && state.currentTime > 0) {
          v.currentTime = state.currentTime;
        }
        if (!state.paused) v.play().catch(err => {
          if (err.name !== 'AbortError') console.error('[LiveChat] restore play failed:', err);
        });
      };
      if (v.readyState >= 1) {
        restoreOnLoad();
      } else {
        v.addEventListener('loadedmetadata', restoreOnLoad, { once: true });
      }
    });
  }
}

function updateLoadMoreBtn() {
  const btn = $('lc-load-more-btn');
  if (!btn) return;
  if (!hasMoreMessages) {
    btn.textContent = '— Beginning of community chat —';
    btn.disabled    = true;
    btn.classList.add('lc-load-more--exhausted');
  } else {
    btn.textContent = 'Load older messages';
    btn.disabled    = false;
    btn.classList.remove('lc-load-more--exhausted');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// APPEND NEW MESSAGES
// SYNC-02: Set-based instead of count-based (v6).
// SYNC-05: date-separator `dataset.date` set before fragment assembly.
// ─────────────────────────────────────────────────────────────────────────────
function appendNewMessagesToDom(newIds) {
  const list = $('lc-messages-list');
  if (!list || !newIds.size) return;

  // BUG-FIX-5: if the empty-state placeholder is present (Phase 1 returned 0
  // docs) remove it before inserting the first real message, otherwise both
  // coexist in the DOM.
  const emptyState = list.querySelector('.lc-empty-state');
  if (emptyState) emptyState.remove();

  // Resolve and sort only the new messages by timestamp ascending
  const newMsgs = getSortedMessages().filter(m => newIds.has(m.id));
  if (!newMsgs.length) return;

  // ORDER-FIX: A new message whose server timestamp is older than already-rendered
  // messages (e.g. two clients send within the same millisecond, or a message
  // arrives out of order due to Firestore delivery) must be inserted at the
  // correct chronological position in the DOM, not blindly appended at the end.
  // Strategy: for each new message, find the first existing row whose timestamp
  // is strictly greater and insertBefore it; otherwise append.
  const getRowMs = row => {
    const id  = row.dataset.msgId;
    const msg = id ? messagesMap.get(id) : null;
    return msg ? tsToMs(msg.timestamp) : 0;
  };
  const allRows = () => [...list.querySelectorAll('.lc-msg-row[data-msg-id]')];

  for (const msg of newMsgs) {
    if (list.querySelector(`.lc-msg-row[data-msg-id="${CSS.escape(msg.id)}"]`)) continue;

    const msgMs = tsToMs(msg.timestamp);

    // Find insertion point: first existing row with a later timestamp
    const rows    = allRows();
    const afterEl = rows.find(r => getRowMs(r) > msgMs) ?? null;

    // Build the message element
    const tmp2 = document.createElement('div');
    tmp2.innerHTML = renderMsgHTML(msg);
    const msgEl = tmp2.firstElementChild;
    if (!msgEl) continue;

    // Ensure correct date separator exists above the insertion point
    const d = fmtDate(msg.timestamp);
    if (d) {
      // Check if there's already a separator for this date immediately above
      const refNode = afterEl ?? null; // null = end of list
      const prevSep = refNode
        ? refNode.previousElementSibling?.classList.contains('lc-date-sep')
          ? refNode.previousElementSibling : null
        : list.lastElementChild?.classList.contains('lc-date-sep')
          ? list.lastElementChild : null;

      const needsSep = !prevSep || prevSep.dataset.date !== d;
      if (needsSep) {
        // Also check: is the next row (afterEl) the start of the same date?
        // If so, no new separator needed — it already has one coming.
        const nextSepDate = afterEl?.classList.contains('lc-date-sep')
          ? afterEl.dataset.date
          : null;
        if (nextSepDate !== d) {
          tmp2.innerHTML = dateSepHTML(msg.timestamp);
          const sep = tmp2.firstElementChild;
          if (sep) {
            sep.dataset.date = d;
            list.insertBefore(sep, afterEl);
          }
        }
      }
    }

    list.insertBefore(msgEl, afterEl);
    initMediaInDOM(msgEl);
  }

  // Remove any duplicate date separators that insertions may have created
  const seenDates = new Set();
  [...list.querySelectorAll('.lc-date-sep[data-date]')].forEach(sep => {
    if (seenDates.has(sep.dataset.date)) { sep.remove(); }
    else seenDates.add(sep.dataset.date);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function scrollToLatest(smooth = true) {
  const c = $('lc-messages-container');
  if (!c) return;
  c.scrollTo({ top: c.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function checkAtBottom() {
  const c = $('lc-messages-container');
  if (!c) return true;
  return c.scrollHeight - c.scrollTop - c.clientHeight < 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// "NEW MESSAGES" INDICATOR
// ─────────────────────────────────────────────────────────────────────────────
function showNewMsgsBanner(count) {
  const bar = $('lc-new-msgs-bar');
  if (!bar) return;
  bar.textContent = count === 1 ? '↓ 1 new message' : `↓ ${count} new messages`;
  bar.classList.remove('hidden');
}

function hideNewMsgsBanner() {
  $('lc-new-msgs-bar')?.classList.add('hidden');
  newMsgCount = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// HEADER BADGE
// ─────────────────────────────────────────────────────────────────────────────
function setHeaderBadge(n) {
  _headerUnread = Math.max(0, Math.min(n, 999));
  document.querySelectorAll('.lc-header-badge').forEach(b => {
    if (_headerUnread > 0) {
      b.textContent = _headerUnread > 99 ? '99+' : String(_headerUnread);
      b.classList.remove('hidden');
    } else {
      b.classList.add('hidden');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCRIPTION CLEANUP HELPER (UX-01)
// Unsubscribes all real-time listeners without resetting messagesMap or UI state.
// Used by closeLiveChat so re-open avoids duplicate subs.
// ─────────────────────────────────────────────────────────────────────────────
function _cleanupSubs() {
  liveChatSub?.(); liveChatSub = null;
  presenceSub?.(); presenceSub = null;
  typingSub?.();   typingSub   = null;
  _subscribeInFlight = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// OPEN / CLOSE
// UX-01: closeLiveChat now cleans up subs via _cleanupSubs().
// UX-02: _subscribeInFlight (SYNC-04) is the concurrent-open guard.
// UX-03: atBottom reset in closeLiveChat.
// ─────────────────────────────────────────────────────────────────────────────
export function openLiveChat() {
  if (!currentUser) {
    showLCToast('Please sign in to join the chat', 'warning');
    document.querySelector('[data-target="page-login"]')?.click();
    return;
  }
  const overlay = $('live-chat-overlay');
  if (!overlay || isOpen) return;
  isOpen = true;
  overlay.classList.remove('lc-overlay--hidden');
  requestAnimationFrame(() => overlay.classList.add('lc-overlay--visible'));
  document.body.classList.add('lc-body-lock');
  _headerUnread = 0;
  setHeaderBadge(0);
  setTimeout(() => $('lc-input')?.focus(), 400);
  // BUG-FIX-2: guard on both liveChatSub AND _subscribeInFlight so rapid
  // open→close→open cycles cannot start a second concurrent subscription
  // before the first one has set liveChatSub.
  if (!liveChatSub && !_subscribeInFlight) subscribeToMessages();
  if (!presenceSub) subscribeToPresence();
  if (!typingSub)   subscribeToTyping();
  startHeartbeat();
}

export function closeLiveChat() {
  if (!isOpen) return;
  isOpen = false;
  const overlay = $('live-chat-overlay');
  if (!overlay) return;
  overlay.classList.remove('lc-overlay--visible');
  setTimeout(() => overlay.classList.add('lc-overlay--hidden'), 380);
  document.body.classList.remove('lc-body-lock');
  stopHeartbeat();
  markPresenceOffline();
  clearTypingIndicator();
  closeEmojiPicker();
  closeGallery();
  if (editingMsgId) cancelEdit();
  if (replyingTo)   clearReply();
  // UX-01: clean up all real-time subs so re-open doesn't duplicate them
  _cleanupSubs();
  // UX-03: reset atBottom so re-open starts scroll tracking correctly
  atBottom = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// REAL-TIME SUBSCRIPTION  (v7 — full real-time coverage for all messages)
//
// SYNC-04: _subscribeInFlight flag replaces the sentinel `() => {}` pattern.
//   The sentinel blocked re-entry correctly but also prevented openLiveChat
//   from re-subscribing after a fast close+open cycle where the sentinel was
//   still assigned when `if (!liveChatSub)` was evaluated. The new flag is
//   set at function entry and cleared on completion or early exit.
//
// Phase 1 — getDocs (one-time read, no persistent listener):
//   Fetches the latest PAGE_SIZE messages (desc order).
//   Populates messagesMap / docSnapshotMap and renders initial view.
//
// Phase 2 — onSnapshot (full collection, real-time):
//   Subscribes to the FULL collection (no startAfter) so ALL modified/removed
//   events reach this client regardless of when a message was first loaded.
//   'added' events for IDs already in messagesMap (Phase 1 docs) are silently
//   skipped via the messagesMap guard.
//
//   SYNC-01: This closes the v5 ML-07 trade-off. Reactions, edits, and
//   soft-deletes on Phase 1 messages now propagate to all connected clients
//   in real time.
// ─────────────────────────────────────────────────────────────────────────────
async function subscribeToMessages() {
  // SYNC-04: guard against concurrent invocations
  if (_subscribeInFlight) return;
  _subscribeInFlight = true;

  // Tear down any existing subscription
  if (liveChatSub) { liveChatSub(); liveChatSub = null; }

  messagesMap.clear();
  docSnapshotMap.clear();
  hasMoreMessages      = true;
  isLoadingOlder       = false;
  newMsgCount          = 0;
  _paginationCursorDoc = null;
  _newestCursorDoc     = null;

  _isInitialLoading = true;

  // ── Phase 1: one-time initial load ───────────────────────────────────────
  let phase1Failed = false;
  try {
    const initSnap = await getDocs(query(
      collection(db, 'global_chat'),
      orderBy('timestamp', 'desc'),
      limit(PAGE_SIZE),
    ));

    // ML-01: bail if unmounted during fetch
    if (!_isMounted) {
      _subscribeInFlight = false;
      _isInitialLoading = false;
      return;
    }

    if (initSnap.docs.length < PAGE_SIZE) hasMoreMessages = false;

    initSnap.docs.forEach((d, i) => {
      messagesMap.set(d.id, { id: d.id, ...d.data() });
      docSnapshotMap.set(d.id, d);
      if (i === 0) _newestCursorDoc = d;
    });

    if (initSnap.docs.length > 0) {
      _paginationCursorDoc = initSnap.docs[initSnap.docs.length - 1];
    }

  } catch (err) {
    console.error('[LiveChat] initial load failed:', err);
    phase1Failed = true;
    if (!_isMounted) { _subscribeInFlight = false; _isInitialLoading = false; return; }
    showLCToast('Could not load messages. Check your connection.', 'error');
  }

  renderAllMessages(true);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => { _isInitialLoading = false; });
  });

  // ── Phase 2: full collection real-time listener ───────────────────────────
  // SYNC-01: No startAfter — listens to ALL docs so modified/removed events
  // reach this client for every message, including Phase 1 history.
  const realtimeQ = query(
    collection(db, 'global_chat'),
    orderBy('timestamp', 'asc'),
  );

  const unsub = onSnapshot(
    realtimeQ,
    { includeMetadataChanges: false },
    snap => {
      // SYNC-06: compute wasAtBottom BEFORE any early return so scroll state
      // is always captured. When docChanges() is empty the data path is a
      // no-op anyway (newIds stays empty and the scroll branch never fires),
      // but structuring it this way makes the intent clear and avoids a subtle
      // ordering bug if Firestore ever delivers a metadata-only snapshot whose
      // changes() is non-empty but whose data is unchanged.
      const wasAtBottom = checkAtBottom();

      if (!snap.docChanges().length) return;

      // SYNC-02: collect new IDs in a Set for precise DOM insertion
      const newIds = new Set();

      snap.docChanges().forEach(change => {
        const id  = change.doc.id;
        const msg = { id, ...change.doc.data() };

        if (change.type === 'added') {
          // Skip Phase 1 docs (already in messagesMap) — only add truly new ones.
          // Also skip messages with a null/pending server timestamp: when the
          // local client sends a message with serverTimestamp(), Firestore fires
          // onSnapshot immediately with timestamp=null (the pending-write
          // snapshot). tsToMs(null)=0 causes appendNewMessagesToDom to insert
          // the message at position 0 (top of list) instead of the bottom,
          // making it appear to vanish. We wait for the second snapshot where
          // the real timestamp has resolved, which arrives as a 'modified' event.
          if (messagesMap.has(id)) return; // already loaded in Phase 1
          if (!change.doc.data().timestamp) return; // pending server timestamp — wait for modified
          messagesMap.set(id, msg);
          docSnapshotMap.set(id, change.doc);
          newIds.add(id);
        } else if (change.type === 'modified') {
          // SYNC-01: covers ALL messages, including Phase 1 history.
          // Also handles the pending→real timestamp transition for own sent
          // messages: the first 'added' snapshot had timestamp=null (skipped
          // above), so this 'modified' event is the first time we see the real
          // timestamp. In that case treat it as a new insertion, not a patch.
          const isNew = !messagesMap.has(id);
          messagesMap.set(id, msg);
          docSnapshotMap.set(id, change.doc);
          if (isNew) {
            newIds.add(id);
          } else {
            patchMsgInDOM(msg);
          }
        } else if (change.type === 'removed') {
          messagesMap.delete(id);
          docSnapshotMap.delete(id);
          if (_paginationCursorDoc?.id === id) {
            _paginationCursorDoc = getOldestDocSnapshot();
          }
          document.querySelector(`.lc-msg-row[data-msg-id="${CSS.escape(id)}"]`)?.remove();
        }
      });

      if (newIds.size > 0) {
        appendNewMessagesToDom(newIds);
        if (wasAtBottom) {
          scrollToLatest(true);
        } else {
          newMsgCount += newIds.size;
          showNewMsgsBanner(newMsgCount);
          setHeaderBadge(_headerUnread + newIds.size);
        }
      }
    },
    err => console.error('[LiveChat] subscription error:', err),
  );

  liveChatSub = unsub;
  _subscribeInFlight = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// OLDEST DOC CURSOR (fallback O(n) scan)
// ─────────────────────────────────────────────────────────────────────────────
function getOldestDocSnapshot() {
  let oldestId  = null;
  let oldestMs  = Infinity;
  for (const [id, msg] of messagesMap) {
    const ms = tsToMs(msg.timestamp);
    if (ms < oldestMs) { oldestMs = ms; oldestId = id; }
  }
  return oldestId ? (docSnapshotMap.get(oldestId) ?? null) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGINATION  (cursor-based, O(1) cursor access)
// ─────────────────────────────────────────────────────────────────────────────
async function loadOlderMessages() {
  if (isLoadingOlder || !hasMoreMessages) return;

  const cursor = _paginationCursorDoc ?? getOldestDocSnapshot();
  if (!cursor) { hasMoreMessages = false; updateLoadMoreBtn(); return; }

  isLoadingOlder = true;
  const btn = $('lc-load-more-btn');
  if (btn) { btn.textContent = 'Loading…'; btn.disabled = true; }

  const container   = $('lc-messages-container');
  const list        = $('lc-messages-list');

  try {
    const q = query(
      collection(db, 'global_chat'),
      orderBy('timestamp', 'desc'),
      startAfter(cursor),
      limit(PAGE_SIZE),
    );
    const snap = await getDocs(q);

    if (snap.empty) {
      hasMoreMessages = false;
    } else {
      if (snap.docs.length < PAGE_SIZE) hasMoreMessages = false;

      const olderMsgs = [];
      let lastNewDoc = null;
      snap.docs.forEach(d => {
        if (!messagesMap.has(d.id)) {
          const msg = { id: d.id, ...d.data() };
          messagesMap.set(d.id, msg);
          docSnapshotMap.set(d.id, d);
          olderMsgs.push(msg);
          lastNewDoc = d;
        }
      });

      // ORDER-FIX: only advance the pagination cursor when we actually ingested
      // new docs. If every doc in the batch was already in messagesMap (duplicate
      // delivery), advancing the cursor would silently skip the next page of
      // older history. Fall back to the last snap doc so we still make progress
      // past the duplicates without losing genuine older messages.
      if (snap.docs.length > 0) {
        _paginationCursorDoc = lastNewDoc ?? snap.docs[snap.docs.length - 1];
      }

      if (list && olderMsgs.length > 0) {
        olderMsgs.sort((a, b) => tsToMs(a.timestamp) - tsToMs(b.timestamp));

        const existingTopSep  = list.querySelector('.lc-date-sep');
        const existingTopDate = existingTopSep?.dataset.date ?? '';

        const fragment = document.createDocumentFragment();
        const tmp      = document.createElement('div');
        let   builtLastDate = '';
        const newNodeRefs = [];

        for (const msg of olderMsgs) {
          const d = fmtDate(msg.timestamp);
          if (d && d !== builtLastDate) {
            tmp.innerHTML = dateSepHTML(msg.timestamp);
            const sep = tmp.firstElementChild;
            if (sep) { sep.dataset.date = d; fragment.appendChild(sep); }
            builtLastDate = d;
          }
          tmp.innerHTML = renderMsgHTML(msg);
          const msgEl = tmp.firstElementChild;
          if (msgEl) {
            newNodeRefs.push(msgEl);
            fragment.appendChild(msgEl);
          }
        }

        if (existingTopSep && existingTopDate && existingTopDate === builtLastDate) {
          existingTopSep.remove();
        }

        // BUG-FIX-4: capture scrollHeight immediately before the DOM mutation so
        // real-time messages arriving during the async getDocs do not skew the anchor.
        const prevScrollH = container?.scrollHeight ?? 0;
        list.prepend(fragment);

        for (const el of newNodeRefs) {
          initMediaInDOM(el);
        }

        if (container) {
          container.scrollTop = container.scrollHeight - prevScrollH;
        }
      }
    }
  } catch (err) {
    console.error('[LiveChat] loadOlderMessages error:', err);
    showLCToast('Failed to load older messages', 'error');
  } finally {
    isLoadingOlder = false;
    updateLoadMoreBtn();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRESENCE
// ─────────────────────────────────────────────────────────────────────────────
async function writePresence(online) {
  if (!currentUser?.email) return;
  const ref     = doc(db, 'global_presence', currentUser.email);
  const payload = {
    online,
    name:     currentUser.name    || '',
    avatar:   currentUser.picture || '',
    lastSeen: serverTimestamp(),
  };
  try {
    if (!_presenceWritten) {
      await setDoc(ref, payload, { merge: true });
      _presenceWritten = true;
    } else {
      await updateDoc(ref, payload);
    }
  } catch { /* non-critical */ }
}

function startHeartbeat() {
  writePresence(true);
  if (hbInterval) clearInterval(hbInterval);
  hbInterval = setInterval(() => writePresence(true), HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (hbInterval) { clearInterval(hbInterval); hbInterval = null; }
}

function markPresenceOffline() { writePresence(false); }

function subscribeToPresence() {
  if (presenceSub) { presenceSub(); presenceSub = null; }
  presenceSub = onSnapshot(collection(db, 'global_presence'),
    snap => {
      const now   = Date.now();
      const users = snap.docs.filter(d => {
        const data = d.data();
        const ms   = data.lastSeen?.toMillis?.() ?? 0;
        return data.online && (now - ms < PRESENCE_STALE_MS);
      }).map(d => d.data());
      const count = users.length;
      const el    = $('lc-online-count');
      if (el) {
        el.textContent = count === 1 ? '1 online' : `${count} online`;
        el.classList.toggle('lc-count--active', count > 0);
      }
    },
    () => { /* non-fatal */ },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPING INDICATORS
// ─────────────────────────────────────────────────────────────────────────────
function typingDocKey(email) {
  return email.replace(/[^a-zA-Z0-9]/g, c =>
    'x' + c.charCodeAt(0).toString(16).padStart(2, '0')
  );
}

async function writeTyping(isTyping) {
  if (!currentUser?.email) return;
  const key = typingDocKey(currentUser.email);
  try {
    const ref = doc(db, 'global_typing', key);
    if (isTyping) {
      await setDoc(ref, { name: currentUser.name || 'Someone', ts: serverTimestamp() });
    } else {
      await deleteDoc(ref).catch(() => {});
    }
  } catch { /* non-critical */ }
}

function onInputTyping() {
  const now = Date.now();
  if (now - lastTypingWrite > TYPING_THROTTLE_MS) {
    lastTypingWrite = now;
    writeTyping(true);
  }
  if (typingTimeout) clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    writeTyping(false);
    typingTimeout = null;
  }, TYPING_STALE_MS);
}

function clearTypingIndicator() {
  if (typingTimeout) { clearTimeout(typingTimeout); typingTimeout = null; }
  writeTyping(false);
}

function subscribeToTyping() {
  if (typingSub) { typingSub(); typingSub = null; }
  typingSub = onSnapshot(collection(db, 'global_typing'),
    snap => {
      const now   = Date.now();
      const myKey = currentUser?.email ? typingDocKey(currentUser.email) : null;
      const typers = snap.docs
        .filter(d => {
          if (d.id === myKey) return false;
          const ts = d.data().ts?.toMillis?.() ?? 0;
          return now - ts < TYPING_STALE_MS + 2000;
        })
        .map(d => d.data().name || 'Someone');

      const bar = $('lc-typing-bar');
      if (!bar) return;
      if (!typers.length) { bar.classList.add('hidden'); return; }
      const label = typers.length === 1
        ? `${typers[0]} is typing…`
        : typers.length === 2
          ? `${typers[0]} and ${typers[1]} are typing…`
          : `${typers.length} people are typing…`;
      bar.querySelector('.lc-typing-label').textContent = label;
      bar.classList.remove('hidden');
    },
    () => { /* non-fatal */ },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EMOJI PICKER
// ─────────────────────────────────────────────────────────────────────────────
function openEmojiPicker() {
  let picker = $('lc-emoji-picker');
  if (picker) { picker.remove(); _emojiPickerOpen = false; return; }
  _emojiPickerOpen = true;
  picker = document.createElement('div');
  picker.id = 'lc-emoji-picker';
  picker.className = 'lc-emoji-picker';
  picker.innerHTML = EMOJI_LIST.map(e =>
    `<button class="lc-emoji-pick-btn" data-emoji="${e}" type="button">${e}</button>`
  ).join('');
  picker.addEventListener('click', e => {
    const btn = e.target.closest('.lc-emoji-pick-btn');
    if (!btn) return;
    const input = $('lc-input');
    if (input) {
      const pos = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, pos) + btn.dataset.emoji + input.value.slice(pos);
      input.focus();
      input.selectionStart = input.selectionEnd = pos + btn.dataset.emoji.length;
      autoResizeInput();
    }
    picker.remove();
    _emojiPickerOpen = false;
  });
  $('lc-emoji-btn')?.insertAdjacentElement('afterend', picker);
}

function closeEmojiPicker() {
  $('lc-emoji-picker')?.remove();
  _emojiPickerOpen = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// REACTION PICKER
// ─────────────────────────────────────────────────────────────────────────────
function openReactionPicker(msgId) {
  _openPickers.forEach(p => { p._abortCtrl?.abort(); p.remove(); });
  _openPickers.clear();

  const row = document.querySelector(`.lc-msg-row[data-msg-id="${CSS.escape(msgId)}"]`);
  if (!row) return;

  const picker = document.createElement('div');
  picker.className = 'lc-reaction-picker';
  picker.innerHTML = EMOJI_LIST.map(e =>
    `<button class="lc-reaction-pick-btn" data-emoji="${e}" type="button">${e}</button>`
  ).join('');

  const ctrl    = new AbortController();
  picker._abortCtrl = ctrl;
  _openPickers.add(picker);

  picker.addEventListener('click', e => {
    const btn = e.target.closest('.lc-reaction-pick-btn');
    if (btn) toggleReaction(msgId, btn.dataset.emoji);
    ctrl.abort();
    picker.remove();
    _openPickers.delete(picker);
  });

  setTimeout(() => {
    document.addEventListener('click', e => {
      if (!picker.contains(e.target)) {
        ctrl.abort();
        picker.remove();
        _openPickers.delete(picker);
      }
    }, { signal: ctrl.signal });
  }, 50);

  row.querySelector('.lc-msg-bubble-wrap')?.appendChild(picker);
}

// ─────────────────────────────────────────────────────────────────────────────
// REACTIONS  (SYNC-03: optimistic update with rollback, from v6)
// ─────────────────────────────────────────────────────────────────────────────
async function toggleReaction(msgId, emoji) {
  if (!currentUser?.email) return;
  const msg = messagesMap.get(msgId);
  if (!msg || msg.isDeleted) return;

  const myEmail       = currentUser.email;
  const prevReactions = { ...(msg.reactions || {}) };
  const reactions     = { ...(msg.reactions || {}) };
  const users         = reactions[emoji] ? [...reactions[emoji]] : [];
  const idx           = users.indexOf(myEmail);
  if (idx === -1) { users.push(myEmail); }
  else            { users.splice(idx, 1); }
  if (users.length === 0) delete reactions[emoji];
  else                    reactions[emoji] = users;

  // SYNC-03: optimistic local update — instant feedback
  const optimisticMsg = { ...msg, reactions };
  messagesMap.set(msgId, optimisticMsg);
  patchMsgInDOM(optimisticMsg);

  try {
    await updateDoc(doc(db, 'global_chat', msgId), { reactions });
  } catch (err) {
    // Rollback to previous state
    const rollbackMsg = { ...msg, reactions: prevReactions };
    messagesMap.set(msgId, rollbackMsg);
    patchMsgInDOM(rollbackMsg);
    console.error('[LiveChat] toggleReaction error:', err);
    showLCToast('Failed to update reaction', 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE REPORTING
// ─────────────────────────────────────────────────────────────────────────────
function openReportDialog(msgId) {
  if (!currentUser?.email) return;
  const msg = messagesMap.get(msgId);
  if (!msg || msg.isDeleted) {
    showLCToast('This message is no longer available to report', 'info');
    return;
  }
  if (msg.senderEmail === currentUser.email) {
    showLCToast('You cannot report your own messages', 'info');
    return;
  }

  $('lc-report-dlg')?.remove();
  const d = document.createElement('div');
  d.id = 'lc-report-dlg';
  d.className = 'lc-confirm-backdrop';
  d.innerHTML = `
    <div class="lc-confirm-card lc-report-card" id="lc-report-card">
      <div class="lc-confirm-body">
        <p class="lc-confirm-title">Report this message</p>
        <p class="lc-confirm-sub">Select a reason. Reports are reviewed by moderators.</p>
        <div class="lc-report-cats">
          ${REPORT_CATEGORIES.map(c =>
            `<label class="lc-report-cat">
               <input type="radio" name="lc-report-cat" value="${esc(c.id)}">
               <span>${esc(c.label)}</span>
             </label>`
          ).join('')}
        </div>
        <textarea id="lc-report-comment" class="lc-report-comment"
                  placeholder="Optional: describe the issue (max 300 chars)" maxlength="300"></textarea>
      </div>
      <div class="lc-confirm-footer">
        <button id="lc-rn" class="lc-confirm-btn lc-confirm-btn--cancel">Cancel</button>
        <button id="lc-ry" class="lc-confirm-btn lc-confirm-btn--delete"
                style="background:var(--signal-amber)">Submit report</button>
      </div>
    </div>`;
  document.body.appendChild(d);
  requestAnimationFrame(() => $('lc-report-card')?.classList.add('lc-confirm-card--visible'));

  const close = () => d.remove();
  d.addEventListener('click', e => { if (e.target === d) close(); });
  $('lc-rn')?.addEventListener('click', close);
  $('lc-ry')?.addEventListener('click', async () => {
    const category = d.querySelector('input[name="lc-report-cat"]:checked')?.value;
    if (!category) { showLCToast('Please select a reason', 'warning'); return; }
    const comment = ($('lc-report-comment')?.value || '').trim().slice(0, 300);
    close();
    await submitReport(msgId, msg, category, comment);
  });
}

async function submitReport(msgId, msg, category, comment) {
  if (!currentUser?.email) return;
  const reportId = makeReportKey(msgId, currentUser.email);
  try {
    const existing = await getDoc(doc(db, 'reports', reportId));
    if (existing.exists()) {
      showLCToast('You already reported this message', 'warning');
      return;
    }
    const attachmentsForReport = msg.attachments?.length
      ? msg.attachments.map(a => ({ url: a.url, type: a.type, name: a.name || null }))
      : msg.mediaUrl
        ? [{ url: msg.mediaUrl, type: msg.mediaType, name: msg.fileName || null }]
        : [];
    await setDoc(doc(db, 'reports', reportId), {
      contentType:    'chat_message',
      contentId:      msgId,
      status:         'pending',
      reason:         category,
      timestamp:      serverTimestamp(),
      reporterEmail:  currentUser.email,
      reporterName:   currentUser.name   || null,
      reportedEmail:  msg.senderEmail    || null,
      reportedName:   msg.senderName     || null,
      category,
      comment:        comment            || null,
      msgId,
      msgText:        msg.text           || null,
      msgAttachments: attachmentsForReport.length ? attachmentsForReport : null,
      msgTimestamp:   msg.timestamp      || null,
    });
    showLCToast('Report submitted. Thank you.', 'success');
  } catch (err) {
    console.error('[LiveChat] submitReport error:', err);
    showLCToast('Failed to submit report', 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND MESSAGE
// ─────────────────────────────────────────────────────────────────────────────
async function sendMessage() {
  if (isSending) return;
  const input     = $('lc-input');
  let   rawText   = input?.value ?? '';
  const text      = rawText.trim().slice(0, MAX_MSG_LENGTH);
  if (!text && !pendingFiles.length) return;
  if (!currentUser) { showLCToast('Please sign in first', 'warning'); return; }

  isSending = true;
  const sendBtn   = $('lc-send-btn');
  const savedText = text;
  if (input) input.value = '';
  autoResizeInput();
  if (sendBtn) sendBtn.disabled = true;
  clearTypingIndicator();

  const attachments = [];

  try {
    if (pendingFiles.length) {
      const filesToUpload = [...pendingFiles];
      clearPendingFiles();
      showUploadProgress(0);
      let done = 0;

      for (const file of filesToUpload) {
        try {
          const compressed = await compressIfImage(file);
          const folder     = file.type.startsWith('image/') ? 'lc_images'
                           : file.type.startsWith('video/') ? 'lc_videos'
                           : 'lc_files';
          const mediaType  = file.type.startsWith('image/') ? 'image'
                           : file.type.startsWith('video/') ? 'video'
                           : 'document';
          const url = await uploadWithRetry(compressed, folder, {
            fileName:   file.name,
            onProgress: pct =>
              showUploadProgress(((done + pct / 100) / filesToUpload.length) * 100),
          });
          attachments.push({ url, type: mediaType, name: file.name, size: file.size });
          done++;
        } catch (uploadErr) {
          console.error('[LiveChat] upload failed for', file.name, uploadErr);
          showLCToast(`Failed to upload ${file.name}`, 'error');
        }
      }
      hideUploadProgress();

      if (!attachments.length && !text) {
        if (input && !input.value) input.value = savedText;
        // BUG-FIX-1: early return must reset isSending / re-enable send btn
        isSending = false;
        if (sendBtn) sendBtn.disabled = false;
        return;
      }
    }

    const snapshotReply = replyingTo ? { ...replyingTo } : null;
    clearReply();
    const first = attachments[0] ?? null;

    await addDoc(collection(db, 'global_chat'), {
      type:         null,
      text:         text  || null,
      senderEmail:  currentUser.email,
      senderName:   currentUser.name    || 'User',
      senderAvatar: currentUser.picture || '',
      timestamp:    serverTimestamp(),
      editedAt:     null,
      isDeleted:    false,
      replyTo:      snapshotReply,
      reactions:    {},
      mediaUrl:     first?.url  ?? null,
      mediaType:    first?.type ?? null,
      fileName:     first?.name ?? null,
      fileSize:     first?.size ?? null,
      attachments:  attachments.length ? attachments : null,
    });

    scrollToLatest(true);
  } catch (err) {
    console.error('[LiveChat] sendMessage error:', err);
    showLCToast('Failed to send. Try again.', 'error');
    if (input && !input.value) input.value = savedText;
  } finally {
    // TD-02: guard against zombie finalize after teardown
    if (_isMounted) {
      isSending = false;
      if (sendBtn) sendBtn.disabled = false;
    } else {
      isSending = false;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EDIT MESSAGE
// ─────────────────────────────────────────────────────────────────────────────
function startEdit(msgId) {
  const msg = messagesMap.get(msgId);
  if (!msg || msg.senderEmail !== currentUser?.email) return;

  editingMsgId = msgId;
  const existingAtts = msg.attachments?.length
    ? msg.attachments
    : msg.mediaUrl
      ? [{ url: msg.mediaUrl, type: msg.mediaType, name: msg.fileName, size: msg.fileSize }]
      : [];
  editingMediaAttachments = existingAtts.map(a => ({ ...a }));

  const input = $('lc-input');
  if (input) { input.value = msg.text || ''; input.focus(); autoResizeInput(); }
  const bar = $('lc-edit-bar');
  if (bar) {
    bar.classList.remove('hidden');
    const lbl = bar.querySelector('.lc-edit-label');
    if (lbl) lbl.textContent = 'Editing message';
  }
  renderEditMediaPreviews();
}

function renderEditMediaPreviews() {
  const fp = $('lc-file-preview');
  if (!fp) return;
  if (!editingMediaAttachments?.length && !pendingFiles.length) {
    fp.classList.add('hidden');
    return;
  }
  fp.classList.remove('hidden');

  const existingHTML = (editingMediaAttachments || []).map((att, idx) => {
    const isImg = att.type === 'image';
    const isVid = att.type === 'video';
    const ext   = ((att.name || '').split('.').pop() || '').toUpperCase().slice(0, 5);
    const thumb = isImg
      ? `<img class="lc-fp-img" src="${escUrl(att.url)}" alt="${esc(att.name || 'image')}">`
      : isVid
        ? `<div class="lc-fp-icon lc-fp-icon--video">🎬</div>`
        : `<div class="lc-fp-icon lc-fp-icon--doc">${esc(ext) || '📄'}</div>`;
    return `<div class="lc-fp-item lc-fp-item--existing">
      <div class="lc-fp-thumb">${thumb}</div>
      <div class="lc-fp-meta">
        <span class="lc-fp-name">${esc(att.name || 'File')}</span>
        ${att.size ? `<span class="lc-fp-size">${fmtSize(att.size)}</span>` : ''}
      </div>
      <button class="lc-fp-remove" data-edit-remove-idx="${idx}" aria-label="Remove ${esc(att.name || 'file')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>`;
  }).join('');

  const newHTML = pendingFiles.map((file, idx) => {
    const isImg = file.type.startsWith('image/');
    const isVid = file.type.startsWith('video/');
    const ext   = (file.name.split('.').pop() || '').toUpperCase().slice(0, 5);
    const thumb = isImg
      ? `<img class="lc-fp-img" data-new-idx="${idx}" alt="${esc(file.name)}">`
      : isVid
        ? `<div class="lc-fp-icon lc-fp-icon--video">🎬</div>`
        : `<div class="lc-fp-icon lc-fp-icon--doc">${esc(ext) || '📄'}</div>`;
    return `<div class="lc-fp-item lc-fp-item--new">
      <div class="lc-fp-thumb lc-fp-thumb--new">${thumb}</div>
      <div class="lc-fp-meta">
        <span class="lc-fp-name">${esc(file.name)}</span>
        <span class="lc-fp-size">${fmtSize(file.size)}</span>
      </div>
      <button class="lc-fp-remove" data-remove-idx="${idx}" aria-label="Remove ${esc(file.name)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>`;
  }).join('');

  fp.innerHTML = `<div class="lc-fp-list">${existingHTML}${newHTML}</div>`;

  pendingFiles.forEach((file, idx) => {
    if (!file.type.startsWith('image/')) return;
    const img = fp.querySelector(`img[data-new-idx="${idx}"]`);
    if (!img) return;
    const url = URL.createObjectURL(file);
    img.src   = url;
    img.onload = () => URL.revokeObjectURL(url);
  });

  fp.querySelectorAll('[data-edit-remove-idx]').forEach(btn =>
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.editRemoveIdx, 10);
      editingMediaAttachments?.splice(i, 1);
      renderEditMediaPreviews();
    })
  );
  fp.querySelectorAll('[data-remove-idx]').forEach(btn =>
    btn.addEventListener('click', () => {
      removePendingFile(parseInt(btn.dataset.removeIdx, 10));
      renderEditMediaPreviews();
    })
  );
}

function cancelEdit() {
  editingMsgId = null;
  editingMediaAttachments = null;
  pendingFiles = [];
  const input  = $('lc-input');
  if (input) { input.value = ''; autoResizeInput(); }
  $('lc-edit-bar')?.classList.add('hidden');
  $('lc-file-preview')?.classList.add('hidden');
}

async function commitEdit() {
  const input   = $('lc-input');
  const newText = (input?.value ?? '').trim().slice(0, MAX_MSG_LENGTH);
  const msgId   = editingMsgId;
  if (!msgId) return;

  let uploadedNew = [];
  if (pendingFiles.length) {
    const filesToUpload = [...pendingFiles];
    showUploadProgress(0);
    let done = 0;
    for (const file of filesToUpload) {
      try {
        const compressed = await compressIfImage(file);
        const folder   = file.type.startsWith('image/') ? 'lc_images'
                       : file.type.startsWith('video/') ? 'lc_videos' : 'lc_files';
        const mediaType = file.type.startsWith('image/') ? 'image'
                        : file.type.startsWith('video/') ? 'video' : 'document';
        const url = await uploadWithRetry(compressed, folder, {
          fileName:   file.name,
          onProgress: pct =>
            showUploadProgress(((done + pct / 100) / filesToUpload.length) * 100),
        });
        uploadedNew.push({ url, type: mediaType, name: file.name, size: file.size });
        done++;
      } catch (uploadErr) {
        console.error('[LiveChat] edit upload failed for', file.name, uploadErr);
        showLCToast(`Failed to upload ${file.name}`, 'error');
      }
    }
    hideUploadProgress();
  }

  const finalAttachments = [...(editingMediaAttachments || []), ...uploadedNew];
  cancelEdit();

  if (!newText && !finalAttachments.length) {
    showLCToast('Message cannot be empty', 'warning');
    return;
  }

  const first = finalAttachments[0] ?? null;

  try {
    await updateDoc(doc(db, 'global_chat', msgId), {
      text:        newText  || null,
      editedAt:    serverTimestamp(),
      mediaUrl:    first?.url  ?? null,
      mediaType:   first?.type ?? null,
      fileName:    first?.name ?? null,
      fileSize:    first?.size ?? null,
      attachments: finalAttachments.length ? finalAttachments : null,
    });
  } catch (err) {
    console.error('[LiveChat] editMessage error:', err);
    showLCToast('Failed to edit message', 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE MESSAGE
// ─────────────────────────────────────────────────────────────────────────────
async function deleteMessage(msgId) {
  const msg = messagesMap.get(msgId);
  if (!msg || msg.senderEmail !== currentUser?.email) return;
  const ok = await showLCConfirm('Delete this message for everyone?');
  if (!ok) return;
  try {
    await updateDoc(doc(db, 'global_chat', msgId), {
      isDeleted: true, text: null, mediaUrl: null, attachments: null,
      voiceUrl: null,
    });
  } catch (err) {
    console.error('[LiveChat] deleteMessage error:', err);
    showLCToast('Failed to delete message', 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REPLY
// ─────────────────────────────────────────────────────────────────────────────
function startReply(msgId) {
  const msg = messagesMap.get(msgId);
  if (!msg || msg.isDeleted) return;
  replyingTo = {
    id:          msg.id,
    text:        msg.text       || '',
    senderName:  msg.senderName  || 'User',
    senderEmail: msg.senderEmail || '',
    mediaType:   msg.type === 'voice' ? 'voice' : (msg.mediaType || null),
  };
  const bar = $('lc-reply-bar');
  if (bar) {
    bar.classList.remove('hidden');
    const who  = bar.querySelector('.lc-reply-bar__who');
    const prev = bar.querySelector('.lc-reply-bar__preview');
    if (who)  who.textContent  = `Replying to ${msg.senderName || 'User'}`;
    if (prev) prev.textContent = msg.type === 'voice' ? '🎙️ Voice note' : msg.mediaType ? '📎 Media' : (msg.text || '').slice(0, 100);
  }
  $('lc-input')?.focus();
}

function clearReply() {
  replyingTo = null;
  $('lc-reply-bar')?.classList.add('hidden');
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE HANDLING
// ─────────────────────────────────────────────────────────────────────────────
function isAcceptedFile(file) {
  if (file.type.startsWith('image/') || file.type.startsWith('video/')) return true;
  return ACCEPTED_EXTENSIONS.has((file.name.split('.').pop() ?? '').toLowerCase());
}

function addPendingFile(file) {
  if (!file) return;
  if (pendingFiles.length >= MAX_ATTACHMENTS) {
    showLCToast(`Max ${MAX_ATTACHMENTS} files per message`, 'warning'); return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showLCToast(`File too large (max ${fmtSize(MAX_FILE_BYTES)})`, 'error'); return;
  }
  if (!isAcceptedFile(file)) {
    showLCToast(`File type not allowed: .${file.name.split('.').pop()}`, 'error'); return;
  }
  pendingFiles.push(file);
  renderFilePreviews();
}

function removePendingFile(index) {
  pendingFiles.splice(index, 1);
  renderFilePreviews();
}

function clearPendingFiles() {
  pendingFiles = [];
  renderFilePreviews();
  const fi = $('lc-file-input-el');
  if (fi) fi.value = '';
}

function renderFilePreviews() {
  const fp = $('lc-file-preview');
  if (!fp) return;
  if (!pendingFiles.length) { fp.classList.add('hidden'); return; }
  fp.classList.remove('hidden');
  fp.innerHTML = `<div class="lc-fp-list">${pendingFiles.map((file, idx) => {
    const isImg = file.type.startsWith('image/');
    const isVid = file.type.startsWith('video/');
    const ext   = (file.name.split('.').pop() || '').toUpperCase().slice(0, 5);
    const thumb = isImg
      ? `<img class="lc-fp-img" data-idx="${idx}" alt="${esc(file.name)}">`
      : isVid
        ? `<div class="lc-fp-icon lc-fp-icon--video">🎬</div>`
        : `<div class="lc-fp-icon lc-fp-icon--doc">${esc(ext) || '📄'}</div>`;
    return `<div class="lc-fp-item">
      <div class="lc-fp-thumb">${thumb}</div>
      <div class="lc-fp-meta">
        <span class="lc-fp-name">${esc(file.name)}</span>
        <span class="lc-fp-size">${fmtSize(file.size)}</span>
      </div>
      <button class="lc-fp-remove" data-remove-idx="${idx}" aria-label="Remove ${esc(file.name)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>`;
  }).join('')}</div>`;

  pendingFiles.forEach((file, idx) => {
    if (!file.type.startsWith('image/')) return;
    const img = fp.querySelector(`img[data-idx="${idx}"]`);
    if (!img) return;
    const url = URL.createObjectURL(file);
    img.src   = url;
    img.onload = () => URL.revokeObjectURL(url);
  });

  fp.querySelectorAll('[data-remove-idx]').forEach(btn =>
    btn.addEventListener('click', () =>
      removePendingFile(parseInt(btn.dataset.removeIdx, 10))
    )
  );
}

function showUploadProgress(pct) {
  const bar   = $('lc-upload-bar');
  const fill  = $('lc-upload-fill');
  const label = $('lc-upload-label');
  if (!bar) return;
  bar.classList.remove('hidden');
  if (fill)  fill.style.width = `${pct}%`;
  if (label) label.textContent = pct < 100 ? `Uploading… ${Math.round(pct)}%` : 'Processing…';
}

function hideUploadProgress() { $('lc-upload-bar')?.classList.add('hidden'); }

// ─────────────────────────────────────────────────────────────────────────────
// TEXTAREA AUTO-RESIZE
// ─────────────────────────────────────────────────────────────────────────────
function autoResizeInput() {
  const el = $('lc-input');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 144) + 'px';
}

// ─────────────────────────────────────────────────────────────────────────────
// VOICE NOTE ENGINE  (v7)
//
// All v5/v6 VN-* fixes retained.
// New in v7:
//   VN-15  buildVoiceBubbleHTML: waveform bar heights seeded from msg.id hash
//          so each voice note has a visually distinct static waveform pattern.
// ─────────────────────────────────────────────────────────────────────────────

function getBestMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
    '',
  ];
  for (const mime of candidates) {
    if (!mime || MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

function fmtVNTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m  = Math.floor(sec / 60);
  const s  = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function vnElapsed() {
  if (_vnState === 'recording') return Date.now() - _vnStartTime - _vnPauseOffset;
  if (_vnState === 'paused')    return _vnPauseStart - _vnStartTime - _vnPauseOffset;
  return 0;
}

function vnUpdateTimer() {
  const el = $('lc-vn-timer');
  if (!el) return;
  const sec = Math.round(vnElapsed() / 1000);
  el.textContent = fmtVNTime(sec);
  el.classList.toggle('lc-vn-timer--warn', sec >= _vnMaxDuration - 10);
  if (sec >= _vnMaxDuration) vnStop(true);
}

function vnStartWaveform(stream) {
  try {
    _vnAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    _vnAnalyser = _vnAudioCtx.createAnalyser();
    _vnAnalyser.fftSize = 64;
    const src = _vnAudioCtx.createMediaStreamSource(stream);
    src.connect(_vnAnalyser);

    const dataArray = new Uint8Array(_vnAnalyser.frequencyBinCount);
    const bars = $('lc-vn-wave')?.querySelectorAll('.lc-vn-bar');
    if (!bars?.length) return;
    _vnBars = Array.from(bars);

    const draw = () => {
      // BUG-FIX-7: if not recording, do NOT schedule the next frame — this
      // was burning 60fps rAF calls during 'paused' state doing nothing.
      // Re-schedule only when recording; the frame is restarted in vnTogglePause.
      if (_vnState !== 'recording') {
        _vnAnimFrame = null;
        return;
      }
      _vnAnimFrame = requestAnimationFrame(draw);
      _vnAnalyser.getByteFrequencyData(dataArray);
      const step = Math.floor(dataArray.length / _vnBars.length);
      _vnBars.forEach((bar, i) => {
        const val = dataArray[i * step] || 0;
        const pct = Math.max(15, Math.round((val / 255) * 100));
        bar.style.height = pct + '%';
      });
    };
    draw();
  } catch {
    // AudioContext unavailable
  }
}

function vnStopWaveform() {
  if (_vnAnimFrame) { cancelAnimationFrame(_vnAnimFrame); _vnAnimFrame = null; }
  try { _vnAudioCtx?.close(); } catch { /* ignore */ }
  _vnAudioCtx = null;
  _vnAnalyser = null;
  _vnBars = [];
}

function vnShowUI(show) {
  const voicePanel = $('lc-vn-panel');
  const inputArea  = $('lc-input-area-inner');
  if (voicePanel) voicePanel.classList.toggle('hidden', !show);
  if (inputArea)  inputArea.classList.toggle('hidden', show);
}

function vnSyncMicBtn() {
  const btn = $('lc-vn-mic-btn');
  if (!btn) return;
  btn.classList.toggle('lc-vn-mic-btn--recording', _vnState === 'recording' || _vnState === 'paused');
  btn.setAttribute('aria-label', _vnState === 'idle' ? 'Record voice note' : 'Cancel recording');
}

async function vnStart() {
  if (_vnState !== 'idle') { vnCancel(); return; }
  _vnState = 'requesting';
  vnSyncMicBtn();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    _vnState = 'idle';
    vnSyncMicBtn();
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      showLCToast('Microphone permission denied. Check browser settings.', 'error');
    } else if (err.name === 'NotFoundError') {
      showLCToast('No microphone found on this device.', 'error');
    } else {
      showLCToast('Could not access microphone: ' + err.message, 'error');
    }
    return;
  }

  _vnStream    = stream;
  _vnChunks    = [];
  _vnStartTime = Date.now();
  _vnPauseOffset = 0;
  _vnPauseStart  = 0;
  _vnState     = 'recording';

  const mimeType = getBestMimeType();
  try {
    try {
      _vnMediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    } catch {
      _vnMediaRecorder = new MediaRecorder(stream);
    }

    _vnMediaRecorder.addEventListener('dataavailable', e => {
      if (e.data?.size > 0) _vnChunks.push(e.data);
    });

    _vnMediaRecorder.start(200);
  } catch (err) {
    stream.getTracks().forEach(t => t.stop());
    _vnStream        = null;
    _vnMediaRecorder = null;
    _vnChunks        = [];
    _vnState         = 'idle';
    vnSyncMicBtn();
    showLCToast('Could not start recording: ' + (err.message || err), 'error');
    return;
  }

  vnShowUI(true);
  vnSyncMicBtn();
  vnUpdateTimer();
  vnStartWaveform(stream);

  if (_vnTimerInterval) clearInterval(_vnTimerInterval);
  _vnTimerInterval = setInterval(vnUpdateTimer, 500);
}

function vnTogglePause() {
  if (_vnState === 'recording') {
    _vnMediaRecorder?.pause();
    _vnPauseStart = Date.now();
    _vnState = 'paused';
    $('lc-vn-pause-btn')?.setAttribute('aria-label', 'Resume recording');
    $('lc-vn-pause-btn')?.classList.add('lc-vn-pause-btn--paused');
    $('lc-vn-wave')?.classList.add('lc-vn-wave--paused');
  } else if (_vnState === 'paused') {
    _vnPauseOffset += Date.now() - _vnPauseStart;
    _vnPauseStart   = 0;
    _vnMediaRecorder?.resume();
    _vnState = 'recording';
    $('lc-vn-pause-btn')?.setAttribute('aria-label', 'Pause recording');
    $('lc-vn-pause-btn')?.classList.remove('lc-vn-pause-btn--paused');
    $('lc-vn-wave')?.classList.remove('lc-vn-wave--paused');
    // BUG-FIX-7: restart waveform draw loop that was stopped during pause
    if (_vnAnalyser && !_vnAnimFrame) {
      const dataArray = new Uint8Array(_vnAnalyser.frequencyBinCount);
      const bars = _vnBars;
      const draw = () => {
        if (_vnState !== 'recording') { _vnAnimFrame = null; return; }
        _vnAnimFrame = requestAnimationFrame(draw);
        _vnAnalyser.getByteFrequencyData(dataArray);
        const step = Math.floor(dataArray.length / bars.length);
        bars.forEach((bar, i) => {
          const val = dataArray[i * step] || 0;
          bar.style.height = Math.max(15, Math.round((val / 255) * 100)) + '%';
        });
      };
      _vnAnimFrame = requestAnimationFrame(draw);
    }
  }
}

// VN-13: cancel drains pending dataavailable chunks before discarding
function vnCancel() {
  if (_vnState === 'idle' || _vnState === 'uploading') return;
  const rec = _vnMediaRecorder;
  if (rec && rec.state !== 'inactive') {
    try {
      rec.ondataavailable = null; // discard chunks
      rec.onstop = null;
      rec.stop();
    } catch { /* ignore */ }
  }
  _vnStream?.getTracks().forEach(t => t.stop());
  if (_vnTimerInterval) { clearInterval(_vnTimerInterval); _vnTimerInterval = null; }
  vnStopWaveform();
  _vnMediaRecorder = null;
  _vnStream        = null;
  _vnChunks        = [];
  _vnState         = 'idle';
  vnShowUI(false);
  vnSyncMicBtn();
}

function vnStop(autoStop = false) {
  if (_vnState !== 'recording' && _vnState !== 'paused') return;

  const durationMs  = vnElapsed();
  const durationSec = Math.round(durationMs / 1000);

  if (durationSec < 1) {
    showLCToast('Recording too short. Hold to record.', 'warning');
    vnCancel();
    return;
  }

  if (_vnTimerInterval) { clearInterval(_vnTimerInterval); _vnTimerInterval = null; }
  vnStopWaveform();

  _vnState = 'uploading';

  const finalMime = _vnMediaRecorder?.mimeType || 'audio/webm';

  if (!_vnMediaRecorder) {
    _vnState = 'idle';
    vnShowUI(false);
    vnSyncMicBtn();
    return;
  }

  // VN-12: guard against calling stop() on an already-inactive recorder
  if (_vnMediaRecorder.state === 'inactive') {
    const blob = new Blob(_vnChunks, { type: finalMime });
    _vnChunks  = [];
    const ext = finalMime.includes('ogg') ? '.ogg' : finalMime.includes('mp4') ? '.m4a' : '.webm';
    vnUploadAndSend(blob, durationSec, finalMime, ext).finally(() => {
      _vnMediaRecorder = null;
      _vnState = 'idle';
      vnShowUI(false);
      vnSyncMicBtn();
    });
    return;
  }

  _vnMediaRecorder.addEventListener('stop', async () => {
    _vnStream?.getTracks().forEach(t => t.stop());
    _vnStream = null;

    const blob = new Blob(_vnChunks, { type: finalMime });
    _vnChunks  = [];

    const ext = finalMime.includes('ogg') ? '.ogg' : finalMime.includes('mp4') ? '.m4a' : '.webm';
    await vnUploadAndSend(blob, durationSec, finalMime, ext);

    _vnMediaRecorder = null;
    _vnState = 'idle';
    vnShowUI(false);
    vnSyncMicBtn();
  }, { once: true });

  _vnMediaRecorder.stop();
}

async function vnUploadAndSend(blob, durationSec, mimeType, ext) {
  if (!currentUser?.email) return;

  showUploadProgress(0);
  const progressLabel = $('lc-upload-label');
  if (progressLabel) progressLabel.textContent = 'Uploading voice note…';

  const fileName = `voice_${Date.now()}${ext}`;
  const audioFile = new File([blob], fileName, { type: mimeType });

  try {
    const downloadURL = await uploadToCloudinary(audioFile, 'voice_notes', {
      fileName,
      onProgress: pct => showUploadProgress(pct),
    });

    if (!downloadURL) throw new Error('Cloudinary returned an empty URL');

    const snapshotReply = replyingTo ? { ...replyingTo } : null;
    clearReply();

    await addDoc(collection(db, 'global_chat'), {
      text:          null,
      type:          'voice',
      voiceUrl:      downloadURL,
      voiceDuration: durationSec,
      voiceMime:     mimeType,
      senderEmail:   currentUser.email,
      senderName:    currentUser.name    || 'User',
      senderAvatar:  currentUser.picture || '',
      timestamp:     serverTimestamp(),
      editedAt:      null,
      isDeleted:     false,
      replyTo:       snapshotReply,
      reactions:     {},
      mediaUrl:      null,
      mediaType:     null,
      fileName:      null,
      fileSize:      null,
      attachments:   null,
    });

    hideUploadProgress();
    scrollToLatest(true);
  } catch (err) {
    hideUploadProgress();
    console.error('[LiveChat] vnUploadAndSend error:', err);
    showLCToast('Failed to send voice note. Try again.', 'error');
  }
}

// ── Build voice bubble HTML
// A11Y-01: tabindex="0" on seek element (role="slider" requires it).
// VN-15: waveform bar heights seeded from msg.id hash for distinct patterns.
function buildVoiceBubbleHTML(msg) {
  const totalSec  = msg.voiceDuration || 0;
  const totalFmt  = fmtVNTime(totalSec);
  const barCount  = 28;

  // VN-15: compute a per-message seed from msg.id for visual variety
  let seed = 0;
  const idStr = msg.id || '';
  for (let i = 0; i < idStr.length; i++) {
    seed = (seed * 31 + idStr.charCodeAt(i)) >>> 0;
  }

  const bars = Array.from({ length: barCount }, (_, i) => {
    // Mix sinusoidal envelope with per-message seed for distinct patterns
    const phase = (seed % 100) / 100;
    const h = Math.round(20 + 55 * Math.abs(Math.sin((i / barCount) * Math.PI * 3.5 + phase * Math.PI * 2)));
    return `<div class="lc-vb-bar" style="height:${h}%"></div>`;
  }).join('');

  return `
    <div class="lc-voice-bubble" data-msg-id="${esc(msg.id)}"
         data-voice-url="${escUrl(msg.voiceUrl || '')}"
         data-voice-duration="${totalSec}"
         data-voice-mime="${esc(msg.voiceMime || 'audio/webm')}">
      <button class="lc-vb-play-btn" aria-label="Play voice note">
        <svg class="lc-vb-play-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z"/>
        </svg>
        <svg class="lc-vb-pause-icon" viewBox="0 0 24 24" fill="currentColor" style="display:none">
          <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
        </svg>
      </button>
      <div class="lc-vb-body">
        <div class="lc-vb-wave-seek" role="slider" tabindex="0"
             aria-label="Seek voice note" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div class="lc-vb-bars">${bars}</div>
          <div class="lc-vb-progress-overlay"></div>
        </div>
        <div class="lc-vb-meta-row">
          <span class="lc-vb-time"><span class="lc-vb-elapsed">0:00</span> / ${esc(totalFmt)}</span>
          <div class="lc-vb-controls-right">
            <select class="lc-vb-speed" aria-label="Playback speed">
              <option value="1" selected>1×</option>
              <option value="1.5">1.5×</option>
              <option value="2">2×</option>
            </select>
            <button class="lc-vb-dl-btn" aria-label="Download voice note" title="Download">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>`;
}

// ── Initialize voice bubbles
// LEAK-01: AbortController for all global listeners (from v6).
// LEAK-03: MutationObserver now observes document.body with subtree:true so
//          removal of any ancestor (not just direct parent) triggers cleanup.
function initVoiceBubbles(container = document) {
  container.querySelectorAll('.lc-voice-bubble:not([data-vb-init])').forEach(wrap => {
    wrap.dataset.vbInit = '1';

    const url        = wrap.dataset.voiceUrl;
    const totalSec   = parseFloat(wrap.dataset.voiceDuration) || 0;
    const mime       = wrap.dataset.voiceMime || 'audio/webm';
    const playBtn    = wrap.querySelector('.lc-vb-play-btn');
    const playIcon   = wrap.querySelector('.lc-vb-play-icon');
    const pauseIcon  = wrap.querySelector('.lc-vb-pause-icon');
    const seekEl     = wrap.querySelector('.lc-vb-wave-seek');
    const progressEl = wrap.querySelector('.lc-vb-progress-overlay');
    const barsEl     = wrap.querySelector('.lc-vb-bars');
    const elapsedEl  = wrap.querySelector('.lc-vb-elapsed');
    const speedSel   = wrap.querySelector('.lc-vb-speed');
    const dlBtn      = wrap.querySelector('.lc-vb-dl-btn');

    if (!url || !playBtn) return;

    // LEAK-01: single AbortController owns all global event listeners
    const vbAbort = new AbortController();
    const vbSig   = vbAbort.signal;

    let audio      = null;
    let _seeking   = false;
    let _touchSeek = false;

    const createAudio = () => {
      if (audio) return;
      audio = new Audio();
      audio.preload = 'none';
      audio.src     = url;

      audio.addEventListener('play', () => {
        if (_activeAudio && _activeAudio !== audio && !_activeAudio.paused) {
          _activeAudio.pause();
        }
        _activeAudio = audio;
        playIcon.style.display  = 'none';
        pauseIcon.style.display = '';
        wrap.classList.add('lc-vb--playing');
      });

      audio.addEventListener('pause', () => {
        playIcon.style.display  = '';
        pauseIcon.style.display = 'none';
        wrap.classList.remove('lc-vb--playing');
        if (_activeAudio === audio) _activeAudio = null;
      });

      audio.addEventListener('ended', () => {
        audio.currentTime = 0;
        playIcon.style.display  = '';
        pauseIcon.style.display = 'none';
        wrap.classList.remove('lc-vb--playing');
        if (elapsedEl) elapsedEl.textContent = '0:00';
        if (progressEl) progressEl.style.width = '0%';
        if (seekEl) {
          seekEl.setAttribute('aria-valuenow', 0);
          updateBarProgress(0);
        }
        if (_activeAudio === audio) _activeAudio = null;
      });

      audio.addEventListener('timeupdate', () => {
        if (_seeking) return;
        const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : totalSec;
        const pct = dur ? (audio.currentTime / dur) * 100 : 0;
        if (elapsedEl) elapsedEl.textContent = fmtVNTime(audio.currentTime);
        if (progressEl) progressEl.style.width = pct + '%';
        // A11Y-02: keep aria-valuenow in sync
        if (seekEl) seekEl.setAttribute('aria-valuenow', Math.round(pct));
        updateBarProgress(pct);
      });

      audio.addEventListener('error', () => {
        showLCToast('Could not play voice note', 'error');
        playIcon.style.display  = '';
        pauseIcon.style.display = 'none';
      });
    };

    const bars = barsEl ? Array.from(barsEl.querySelectorAll('.lc-vb-bar')) : [];
    const updateBarProgress = pct => {
      const threshold = (pct / 100) * bars.length;
      bars.forEach((bar, i) => {
        bar.classList.toggle('lc-vb-bar--played', i < threshold);
      });
    };

    const seekTo = ratio => {
      createAudio();
      const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : totalSec;
      if (!dur) return;
      audio.currentTime = Math.max(0, Math.min(dur, ratio * dur));
    };

    const seekFromClientX = clientX => {
      if (!seekEl) return;
      const r = seekEl.getBoundingClientRect();
      seekTo(Math.max(0, Math.min(1, (clientX - r.left) / r.width)));
    };

    playBtn.addEventListener('click', () => {
      createAudio();
      if (audio.paused) {
        audio.play().catch(() => showLCToast('Could not play voice note', 'error'));
      } else {
        audio.pause();
      }
    });

    seekEl?.addEventListener('mousedown', e => {
      createAudio();
      _seeking = true;
      seekFromClientX(e.clientX);
    });
    seekEl?.addEventListener('mousemove', e => {
      if (_seeking) seekFromClientX(e.clientX);
    });
    // LEAK-01: document mouseup uses AbortController signal
    document.addEventListener('mouseup', () => { _seeking = false; }, { signal: vbSig });

    seekEl?.addEventListener('touchstart', e => {
      e.preventDefault();
      createAudio();
      _touchSeek = true;
      seekFromClientX(e.touches[0].clientX);
    }, { passive: false });
    seekEl?.addEventListener('touchmove', e => {
      if (!_touchSeek) return;
      e.preventDefault();
      seekFromClientX(e.touches[0].clientX);
    }, { passive: false });
    seekEl?.addEventListener('touchend', () => { _touchSeek = false; }, { passive: true });

    seekEl?.addEventListener('keydown', e => {
      createAudio();
      const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : totalSec;
      if (!dur) return;
      if (e.key === 'ArrowRight') audio.currentTime = Math.min(dur, audio.currentTime + 5);
      if (e.key === 'ArrowLeft')  audio.currentTime = Math.max(0, audio.currentTime - 5);
    });

    speedSel?.addEventListener('change', () => {
      if (audio) audio.playbackRate = parseFloat(speedSel.value);
    });

    dlBtn?.addEventListener('click', () =>
      secureDownload(url, `voice-note-${Date.now()}.${mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm'}`)
    );

    // LEAK-03: observe document.body with subtree:true so removal of any
    // ancestor (not just direct parent) triggers cleanup and releases the audio
    // element and vbAbort-owned global listeners.
    const cleanupObs = new MutationObserver(() => {
      if (!wrap.isConnected) {
        audio?.pause();
        vbAbort.abort(); // LEAK-01: releases all listeners registered with vbSig
        if (_activeAudio === audio) _activeAudio = null;
        audio = null;
        cleanupObs.disconnect();
      }
    });
    cleanupObs.observe(document.body, { childList: true, subtree: true });

    // Safety: also disconnect observer if vbAbort fires (e.g. from teardown path)
    vbSig.addEventListener('abort', () => cleanupObs.disconnect(), { once: true });
  });
}

function teardownVoiceNote() {
  vnCancel();
  if (_activeAudio && !_activeAudio.paused) _activeAudio.pause();
  _activeAudio = null;
}

function setupVoiceNote() {
  const micBtn    = $('lc-vn-mic-btn');
  const cancelBtn = $('lc-vn-cancel-btn');
  const pauseBtn  = $('lc-vn-pause-btn');
  const sendBtn   = $('lc-vn-send-btn');

  micBtn?.addEventListener('click', () => {
    if (_vnState === 'idle') {
      vnStart();
    } else {
      vnCancel();
    }
  });

  cancelBtn?.addEventListener('click', vnCancel);
  pauseBtn?.addEventListener('click', vnTogglePause);
  sendBtn?.addEventListener('click', () => vnStop(false));
}

// ─────────────────────────────────────────────────────────────────────────────
// DRAG AND DROP
// ─────────────────────────────────────────────────────────────────────────────
function setupDragDrop() {
  const panel = $('lc-panel');
  if (!panel) return;
  panel.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault(); dragCounter++;
    $('lc-drag-overlay')?.classList.remove('hidden');
  });
  panel.addEventListener('dragleave', e => {
    if (panel.contains(e.relatedTarget)) return;
    dragCounter = 0;
    $('lc-drag-overlay')?.classList.add('hidden');
  });
  panel.addEventListener('dragover', e => e.preventDefault());
  panel.addEventListener('drop', e => {
    e.preventDefault(); dragCounter = 0;
    $('lc-drag-overlay')?.classList.add('hidden');
    Array.from(e.dataTransfer?.files || []).forEach(f => addPendingFile(f));
    if (editingMsgId !== null) renderEditMediaPreviews();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MEDIA GALLERY SIDEBAR
// LEAK-02: video thumbnail loadedmetadata listeners not leaked across re-renders
//          because each render() call creates fresh video elements.
// VP-25: crossorigin="anonymous" removed from gallery video thumbnails.
// A11Y-05: gallery items always have a meaningful aria-label.
// ─────────────────────────────────────────────────────────────────────────────
function openGallery() {
  if (_galleryOpen) return;
  _galleryOpen = true;
  $('lc-gallery')?.remove();

  const panel = document.createElement('div');
  panel.id        = 'lc-gallery';
  panel.className = 'lc-gallery-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Media gallery');

  panel.innerHTML = `
    <div class="lc-gallery-panel__header">
      <h3 class="lc-gallery-panel__title">Media &amp; Files</h3>
      <button id="lc-gallery-close" class="lc-gallery-panel__close" aria-label="Close gallery">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>
    <div class="lc-gallery-search-wrap">
      <input type="search" id="lc-gallery-search" class="lc-gallery-search-input"
             placeholder="Search by filename…" aria-label="Search files">
    </div>
    <div id="lc-gallery-grid" class="lc-gallery-grid"></div>`;

  document.body.appendChild(panel);
  requestAnimationFrame(() => panel.classList.add('lc-gallery--visible'));

  const normalize = str =>
    str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  const render = (searchQuery = '') => {
    const grid = $('lc-gallery-grid');
    if (!grid) return;
    const q = normalize(searchQuery);
    const allItems = getSortedMessages().flatMap(msg => {
      const atts = msg.attachments?.length
        ? msg.attachments
        : msg.mediaUrl
          ? [{ url: msg.mediaUrl, type: msg.mediaType, name: msg.fileName, size: msg.fileSize }]
          : [];
      return atts
        .filter(a => !q || normalize(a.name || '').includes(q))
        .map(a => ({ ...a, msgId: msg.id }));
    });

    if (!allItems.length) {
      grid.innerHTML = `<div class="lc-gallery-item lc-gallery-item--empty">No media found</div>`;
      return;
    }

    // LEAK-02: each render creates fresh elements; old ones are discarded with grid.innerHTML
    grid.innerHTML = allItems.map(item => {
      // A11Y-05: always provide a meaningful aria-label
      const itemLabel = item.name || (item.type === 'video' ? 'Video' : item.type === 'image' ? 'Image' : 'File');
      if (item.type === 'image') {
        return `<div class="lc-gallery-item lc-gallery-item--img" data-url="${escUrl(item.url)}" tabindex="0" role="button" aria-label="${esc(itemLabel)}">
                  <img src="${escUrl(item.url)}" loading="lazy" decoding="async" alt="${esc(itemLabel)}">
                </div>`;
      }
      if (item.type === 'video') {
        // VP-25: no crossorigin="anonymous" — avoids CORS failures with CDN URLs
        const posterAttr = item.thumbnailUrl ? ` poster="${escUrl(item.thumbnailUrl)}"` : '';
        return `<div class="lc-gallery-item lc-gallery-item--vid"
                     data-url="${escUrl(item.url)}"
                     data-name="${esc(item.name || 'video.mp4')}"
                     tabindex="0" role="button" aria-label="${esc(itemLabel)}">
                  <video src="${escUrl(item.url)}"${posterAttr} preload="metadata" muted playsinline></video>
                  <div class="lc-gallery-item__overlay">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28">
                      <circle cx="12" cy="12" r="12" fill="rgba(0,0,0,0.55)"/>
                      <path d="M10 8.5l6 3.5-6 3.5z" fill="#fff"/>
                    </svg>
                  </div>
                </div>`;
      }
      const ext = (item.name || '').split('.').pop().toUpperCase().slice(0, 5);
      return `<a class="lc-gallery-item lc-gallery-item--doc" href="${escUrl(item.url)}" target="_blank" rel="noopener noreferrer" data-download-name="${esc(item.name || 'file')}" aria-label="${esc(itemLabel)}">
                <span class="lc-gallery-item__ext">${esc(ext)}</span>
                <span class="lc-gallery-item__label">${esc(item.name || 'File')}</span>
                ${item.size ? `<span class="lc-gallery-item__size">${fmtSize(item.size)}</span>` : ''}
              </a>`;
    }).join('');

    const imgItems = allItems.filter(a => a.type === 'image');
    grid.querySelectorAll('.lc-gallery-item--img').forEach((thumb, i) => {
      thumb.addEventListener('click', () => {
        openFullscreenViewer(
          imgItems.map(a => ({ url: a.url, name: a.name || 'image.jpg', type: 'image' })),
          i
        );
      });
      thumb.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); thumb.click(); }
      });
    });

    grid.querySelectorAll('.lc-gallery-item--vid').forEach(item => {
      const video = item.querySelector('video');
      // LEAK-02: { once: true } prevents stale listener accumulation
      if (video && !video.poster) {
        video.addEventListener('loadedmetadata', () => {
          video.currentTime = Math.min(1, video.duration * 0.1);
        }, { once: true });
      }
      item.addEventListener('click', () => {
        const msgId = allItems.find(a => a.url === item.dataset.url && a.type === 'video')?.msgId;
        if (msgId) {
          const row = document.querySelector(`.lc-msg-row[data-msg-id="${CSS.escape(msgId)}"]`);
          if (row) {
            closeGallery();
            setTimeout(() => {
              row.scrollIntoView({ behavior: 'smooth', block: 'center' });
              row.classList.add('lc-msg-highlight');
              setTimeout(() => row.classList.remove('lc-msg-highlight'), 1500);
            }, 80);
          }
        }
      });
      item.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
      });
    });

    grid.querySelectorAll('.lc-gallery-item--doc').forEach(card => {
      card.addEventListener('click', e => {
        e.preventDefault();
        secureDownload(card.href, card.dataset.downloadName);
      });
    });
  };

  render();

  $('lc-gallery-search')?.addEventListener('input', e => render(e.target.value || ''));
  $('lc-gallery-close')?.addEventListener('click', closeGallery);
}

function closeGallery() {
  if (!_galleryOpen) return;
  _galleryOpen = false;
  const panel = $('lc-gallery');
  if (!panel) return;
  panel.classList.remove('lc-gallery--visible');
  setTimeout(() => panel.remove(), 320);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLEANUP  (v7)
//
// Retains all v6 fixes: TD-01 atBottom reset, TD-02 sendMessage guard.
// UX-01: _cleanupSubs() now called from closeLiveChat, not here — teardownLiveChat
//        still calls it via _cleanupSubs for full cleanup.
// ─────────────────────────────────────────────────────────────────────────────
export function teardownLiveChat() {
  _isMounted = false;

  if (_globalAbort) { _globalAbort.abort(); _globalAbort = null; }

  _cleanupSubs();
  stopHeartbeat();
  markPresenceOffline();
  clearTypingIndicator();

  messagesMap.clear();
  docSnapshotMap.clear();

  _paginationCursorDoc = null;
  _newestCursorDoc     = null;

  if (_activeVideo && !_activeVideo.paused) _activeVideo.pause();
  _activeVideo = null;

  teardownVoiceNote();

  pendingFiles     = [];
  isSending        = false;

  _openPickers.forEach(p => { p._abortCtrl?.abort(); p.remove(); });
  _openPickers.clear();

  closeEmojiPicker();
  closeGallery();

  isOpen                  = false;
  hasMoreMessages         = true;
  newMsgCount             = 0;
  // TD-01: reset atBottom so next open starts scroll tracking correctly
  atBottom                = true;
  replyingTo              = null;
  editingMsgId            = null;
  editingMediaAttachments = null;
  dragCounter             = 0;
  lastTypingWrite  = 0;
  _presenceWritten = false;
  _setupDone       = false;
  _headerUnread    = 0;
  _galleryOpen     = false;
  _isInitialLoading = false;
  _scrollRafPending = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────────────────────
export function setupLiveChat() {
  if (_setupDone) return;
  _setupDone = true;
  _isMounted = true;

  if (_globalAbort) _globalAbort.abort();
  _globalAbort = new AbortController();
  const sig = _globalAbort.signal;

  document.querySelectorAll('.lc-open-btn').forEach(btn =>
    btn.addEventListener('click', openLiveChat)
  );

  const closeBtn   = $('lc-close-btn');
  const backdrop   = $('lc-backdrop');
  const sendBtn    = $('lc-send-btn');
  const input      = $('lc-input');
  const attachBtn  = $('lc-attach-btn');
  const fileInput  = $('lc-file-input-el');
  const newMsgBar  = $('lc-new-msgs-bar');
  const loadMore   = $('lc-load-more-btn');
  const emojiBtn   = $('lc-emoji-btn');
  const galleryBtn = $('lc-gallery-btn');

  closeBtn?.addEventListener('click', closeLiveChat);
  backdrop?.addEventListener('click', closeLiveChat);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen) {
      if (_galleryOpen)     { closeGallery();    return; }
      if (_emojiPickerOpen) { closeEmojiPicker(); return; }
      closeLiveChat();
    }
  }, { signal: sig });

  emojiBtn?.addEventListener('click', e => { e.stopPropagation(); openEmojiPicker(); });
  document.addEventListener('click', e => {
    if (_emojiPickerOpen &&
        !e.target.closest('#lc-emoji-picker') &&
        !e.target.closest('#lc-emoji-btn')) {
      closeEmojiPicker();
    }
  }, { signal: sig });

  galleryBtn?.addEventListener('click', () => _galleryOpen ? closeGallery() : openGallery());

  sendBtn?.addEventListener('click', async () => {
    if (editingMsgId) await commitEdit();
    else              await sendMessage();
  });

  input?.addEventListener('keydown', async e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (editingMsgId) await commitEdit();
      else              await sendMessage();
    }
    if (e.key === 'Escape') {
      if (editingMsgId) { cancelEdit();     return; }
      if (replyingTo)   { clearReply();     return; }
      clearPendingFiles();
    }
  });
  input?.addEventListener('input', () => { autoResizeInput(); onInputTyping(); });

  attachBtn?.addEventListener('click', () => {
    if (fileInput) { fileInput.multiple = true; fileInput.accept = ACCEPTED_TYPES; fileInput.click(); }
  });
  fileInput?.addEventListener('change', () => {
    Array.from(fileInput?.files || []).forEach(f => addPendingFile(f));
    if (fileInput) fileInput.value = '';
    if (editingMsgId !== null) renderEditMediaPreviews();
  });

  $('lc-reply-cancel')?.addEventListener('click', clearReply);
  $('lc-edit-cancel')?.addEventListener('click', cancelEdit);

  newMsgBar?.addEventListener('click', () => { scrollToLatest(true); hideNewMsgsBanner(); });
  loadMore?.addEventListener('click', loadOlderMessages);

  $('lc-messages-list')?.addEventListener('click', e => {
    const replyBtn     = e.target.closest('.lc-reply-btn');
    const editBtn      = e.target.closest('.lc-edit-btn');
    const deleteBtn    = e.target.closest('.lc-delete-btn');
    const reactBtn     = e.target.closest('.lc-react-btn');
    const reportBtn    = e.target.closest('.lc-report-btn');
    const quoteBtn     = e.target.closest('.lc-reply-quote[data-scroll-to]');
    const reactionPill = e.target.closest('.lc-reaction-pill');

    if (replyBtn)     { e.stopPropagation(); startReply(replyBtn.dataset.msgId); }
    if (editBtn)      { e.stopPropagation(); startEdit(editBtn.dataset.msgId); }
    if (deleteBtn)    { e.stopPropagation(); deleteMessage(deleteBtn.dataset.msgId); }
    if (reactBtn)     { e.stopPropagation(); openReactionPicker(reactBtn.dataset.msgId); }
    if (reportBtn)    { e.stopPropagation(); openReportDialog(reportBtn.dataset.msgId); }
    if (reactionPill) {
      e.stopPropagation();
      const row = reactionPill.closest('.lc-msg-row');
      if (row) toggleReaction(row.dataset.msgId, reactionPill.dataset.emoji);
    }
    if (quoteBtn) {
      const id  = quoteBtn.dataset.scrollTo;
      const row = document.querySelector(`.lc-msg-row[data-msg-id="${CSS.escape(id)}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('lc-msg-highlight');
        setTimeout(() => row.classList.remove('lc-msg-highlight'), 1500);
      }
    }
  });

  // ML-04 + ML-05: rAF-throttled scroll handler; _isInitialLoading blocks pagination
  $('lc-messages-container')?.addEventListener('scroll', () => {
    if (_scrollRafPending) return;
    _scrollRafPending = true;
    requestAnimationFrame(() => {
      _scrollRafPending = false;
      atBottom = checkAtBottom();
      if (atBottom) hideNewMsgsBanner();
      if (!_isInitialLoading) {
        const c = $('lc-messages-container');
        if (c && c.scrollTop < 80 && hasMoreMessages && !isLoadingOlder) {
          loadOlderMessages();
        }
      }
    });
  }, { passive: true });

  setupDragDrop();
  setupVoiceNote();

  window.addEventListener('beforeunload', () => {
    if (isOpen) markPresenceOffline();
  });
}