// ============================================================
// liveChat.js — Global Real-Time Community Chat  (v5 COMPREHENSIVE REFACTOR)
// ============================================================
//
// AUDIT SUMMARY (v5) — all previously documented v3 fixes retained.
// New issues found and resolved in this revision:
//
// MESSAGE LOADING / PAGINATION
//   ML-01  subscribeToMessages had no _isMounted guard after the async
//          getDocs call.  If teardownLiveChat() was called while the
//          initial fetch was in-flight (rapid open/close), the old listener
//          would still render and attach a real-time subscription on a
//          dismounted component.  Fixed: _isMounted checked post-await;
//          sentinel cleared and function returns early if unmounted.
//   ML-02  _paginationCursorDoc was computed by scanning messagesMap
//          (O(n) walk) on every loadOlderMessages call.  Fixed: cursor is
//          cached at module level, set once during Phase 1 and updated
//          incrementally after each pagination batch.
//   ML-03  _newestCursorDoc was computed correctly but only used locally
//          inside subscribeToMessages.  Promoted to module level so it
//          survives the async boundary and is available for diagnostic
//          logging without re-scanning.
//   ML-04  The scroll handler called loadOlderMessages() synchronously on
//          every scroll event when scrollTop < 80, including during the
//          programmatic scrollToLatest() call that fires immediately after
//          renderAllMessages().  Race: list was not yet scrolled before the
//          event fired, so scrollTop could briefly be 0.  Fixed: 
//          _isInitialLoading flag blocks the scroll->pagination path until
//          the initial render + scroll is fully committed.
//   ML-05  Scroll handler fired on every pixel of scroll with no throttle.
//          Fixed: gated behind a single requestAnimationFrame per frame via
//          _scrollRafPending flag.
//   ML-06  appendNewMessagesToDom called initMediaInDOM(list) which
//          rescanned the ENTIRE message list on every new message.  Fixed:
//          new nodes are tracked before and after the fragment append so
//          initMediaInDOM is scoped to only the new rows.
//   ML-07  Phase 2 modified/removed events from the realtime listener only
//          covered messages that arrived after the initial load.  Messages
//          from Phase 1 (initial getDocs batch) that were soft-deleted or
//          edited by their author would not reflect in the DOM in real-time
//          for already-open clients.  Added documentation comment explaining
//          the accepted trade-off (fewer Firestore reads vs. real-time edits
//          of paginated history); patchMsgInDOM now also preserves video
//          playback state across DOM replacements (video position, volume,
//          muted, playback rate) so edit patches do not reset player state.
//
// VIDEO PLAYER (v5 — complete replacement)
//   VP-14  No mechanism to pause a playing video when another started.
//          Multiple videos could play simultaneously, causing audio chaos.
//          Fixed: module-level _activeVideo tracker; every play event
//          pauses the previous active video and updates the tracker.
//   VP-15  Videos loaded eagerly with preload="metadata" regardless of
//          whether they were in the viewport.  On a long chat history with
//          many video attachments this wasted bandwidth and stalled the
//          connection.  Fixed: HTML emits preload="none"; IntersectionObserver
//          in initVideoPlayers upgrades to preload="metadata" when the
//          player enters the viewport (rootMargin 200px lookahead).
//   VP-16  No poster / thumbnail support.  Videos appeared as a black
//          rectangle until metadata loaded.  Fixed: buildMediaHTML reads
//          att.thumbnailUrl and writes data-poster on the wrap; initVideo-
//          Players reads data-poster and sets video.poster accordingly.
//   VP-17  No replay affordance when a video ended.  The play icon reverted
//          to a play triangle but there was no visual hint that replay was
//          available and no way to restart without seeking.  Fixed: a
//          dedicated .lc-vp-replay overlay appears on 'ended'; clicking it
//          seeks to 0 and replays.
//   VP-18  Fullscreen used wrap.requestFullscreen() only — no vendor-prefix
//          support and no fallback for iOS Safari which prohibits fullscreen
//          on arbitrary elements but does support it on <video>.  Fixed:
//          vendor-prefixed requestFullscreen / webkitRequestFullscreen chain,
//          with an iOS fallback that requests fullscreen on the <video> element
//          itself via video.webkitEnterFullscreen.
//   VP-19  fullscreenchange listener was only on 'fullscreenchange'; on older
//          WebKit (Safari, iOS Chrome) the event is 'webkitfullscreenchange'.
//          Fixed: both event names registered on the same handler.
//   VP-20  Double-tap on video did not play/pause on touch devices; the
//          single-tap 'click' event fires too slowly after a pan gesture.
//          Fixed: touchend double-tap (< 300 ms interval) toggles play.
//   VP-21  Number keys 1–9 seek to 10–90% of duration (YouTube-style).
//          Added to the keyboard shortcut handler.
//   VP-22  On orientation change the fullscreen icon and controls layout
//          were not updated.  Fixed: orientationchange listener syncs
//          fullscreen icon state; lc-vp-controls--landscape class adjusts
//          control layout in CSS.
//   VP-23  patchMsgInDOM replaced the entire message row (including any
//          video element), losing playback position, volume, and muted state.
//          Fixed: video state captured before DOM replacement and restored
//          in loadedmetadata on the new element.
//   VP-24  IntersectionObserver (VP-15) was not cleaned up when the wrap
//          left the DOM.  Fixed: observer disconnected inside vpAbort signal
//          listener (same AbortController pattern as other listeners).
//
// FIRESTORE / PAGINATION
//   FP-01  getOldestDocSnapshot() linearly scanned messagesMap (O(n)) on
//          every paginate call.  Now only used as a fallback; primary path
//          reads _paginationCursorDoc (O(1)).
//   FP-02  _paginationCursorDoc was not reset in teardownLiveChat(), leaving
//          a stale cursor that could cause incorrect pagination on the NEXT
//          open of the same chat session.  Fixed: reset in teardown.
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
// Firebase Storage imports removed — voice notes now upload via Cloudinary (VN-06)

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

// Pagination cursors (ML-02, ML-03, FP-01, FP-02)
let _paginationCursorDoc = null;  // cached oldest doc; updated after each page load
let _newestCursorDoc     = null;  // newest doc from initial load; anchor for Phase 2

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

// ML-04: blocks scroll→pagination during initial render + programmatic scroll
let _isInitialLoading = false;
// ML-05: rAF gate for scroll handler
let _scrollRafPending = false;
// VP-14: tracks the currently playing video to pause it when another starts
let _activeVideo = null;

// ─── Voice Note State ──────────────────────────────────────────────────────────
// VN-01: All voice recording state isolated to prevent interference with other features
let _vnMediaRecorder    = null;   // active MediaRecorder instance
let _vnStream           = null;   // microphone MediaStream
let _vnChunks           = [];     // recorded audio Blob chunks
let _vnStartTime        = 0;      // recording start timestamp (ms)
let _vnPauseOffset      = 0;      // accumulated paused duration (ms)
let _vnPauseStart       = 0;      // when current pause began
let _vnTimerInterval    = null;   // setInterval handle for recording timer UI
let _vnAnalyser         = null;   // Web Audio API AnalyserNode
let _vnAudioCtx         = null;   // AudioContext for waveform
let _vnAnimFrame        = null;   // requestAnimationFrame handle for waveform
let _vnState            = 'idle'; // 'idle' | 'requesting' | 'recording' | 'paused' | 'uploading'
let _vnMaxDuration      = 300;    // max recording seconds (5 min)
let _vnBars             = [];     // cached waveform bar elements
let _activeAudio        = null;   // currently playing voice note <audio> element (AP-01: prevent simultaneous playback)

let messagesMap = new Map();

const $ = id => document.getElementById(id);
const esc = sanitize;

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
    return `<img src="${esc(photoUrl)}" class="${cls}" alt="${esc(name)}"
              onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
            <div class="${cls} lc-avatar--initials" style="background:${color};display:none">${avatarInitials(name)}</div>`;
  }
  return `<div class="${cls} lc-avatar--initials" style="background:${color}">${avatarInitials(name)}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORT DE-DUP KEY (RP-01: safe, short, stable)
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
// IMAGE COMPRESSION (PF-03: await img.decode())
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
// CUSTOM VIDEO PLAYER  (v5 — comprehensive rewrite)
//
// New in v5 (all previous v4 fixes retained):
//   VP-14  _activeVideo tracker: play event pauses previous active video.
//   VP-15  IntersectionObserver lazy-load: preload="none" in HTML; upgraded
//          to preload="metadata" when wrap enters viewport (+200px margin).
//   VP-16  Poster image: wrap data-poster → video.poster for thumbnail.
//   VP-17  Replay overlay: appears on 'ended'; click seeks to 0 + replays.
//   VP-18  iOS fullscreen: webkitEnterFullscreen fallback on <video> element.
//   VP-19  webkitfullscreenchange: vendor-prefixed event registered.
//   VP-20  Double-tap touch: toggles play/pause (< 300 ms tap interval).
//   VP-21  Number key seek: 1–9 jumps to 10%–90% of video duration.
//   VP-22  orientationchange: syncs fullscreen icon; adds landscape class.
//   VP-23  Video playback state preserved across patchMsgInDOM replacements.
//   VP-24  IntersectionObserver torn down via vpAbort signal listener.
// ─────────────────────────────────────────────────────────────────────────────
function initVideoPlayers(container = document) {
  // PF-02: scoped query — never searches the whole document
  container.querySelectorAll('.lc-media-video-wrap:not([data-player-init])').forEach(wrap => {
    wrap.dataset.playerInit = '1';
    const video = wrap.querySelector('video');
    if (!video) return;

    // VP-12: make the wrap focusable for keyboard shortcuts
    wrap.setAttribute('tabindex', '-1');

    // VP-16: poster thumbnail support
    const posterUrl = wrap.dataset.poster;
    if (posterUrl) video.poster = posterUrl;

    // VP-15: lazy loading — IntersectionObserver is set up below inside vpAbort
    // scope (VP-24) so it is always cleaned up. The duplicate observer that
    // previously appeared here (without cleanup) has been removed.

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

    // VP-01: spinner — starts hidden (.hidden class); shown on 'waiting'
    const spinner = document.createElement('div');
    spinner.className = 'lc-vp-spinner hidden';
    spinner.setAttribute('aria-hidden', 'true');

    // VP-17: replay overlay — shown on 'ended'
    const replayOverlay = document.createElement('div');
    replayOverlay.className = 'lc-vp-replay hidden';
    replayOverlay.setAttribute('aria-label', 'Replay');
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

    // VP-03: single AbortController for every document/window-level listener
    const vpAbort = new AbortController();
    const vpSig   = vpAbort.signal;

    // VP-24: tear down IntersectionObserver when player is destroyed
    // (re-create observer here so we have vpSig in scope)
    if ('IntersectionObserver' in window) {
      const lazyIO = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting && video.preload === 'none') {
          video.preload = 'metadata';
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

    const togglePlay = () =>
      video.paused ? video.play().catch(() => {}) : video.pause();

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

    // VP-10: syncMuteIcons considers both .muted flag and volume === 0
    const syncMuteIcons = () => {
      const isMuted = video.muted || video.volume === 0;
      iconVol.style.display   = isMuted ? 'none'   : 'inline';
      iconMuted.style.display = isMuted ? 'inline' : 'none';
      muteBtn.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');
      volSlider.value = video.muted ? 0 : video.volume;
    };

    // ── Fullscreen helpers (VP-18, VP-19) ────────────────────────────────────
    const requestFs = el =>
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch(() => {
        // VP-18: iOS Safari fallback — request fullscreen on the <video> element
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

    // ── Seek helpers (shared by mouse and touch) ──────────────────────────────
    const seekFromClientX = clientX => {
      const r     = progressWrap.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      if (isFinite(video.duration) && video.duration > 0) {
        video.currentTime = ratio * video.duration;
      }
    };

    // Mouse seek
    let seeking = false;
    progressWrap.addEventListener('mousedown', e => {
      seeking = true;
      seekFromClientX(e.clientX);
    });
    document.addEventListener('mousemove', e => {
      if (seeking) seekFromClientX(e.clientX);
    }, { signal: vpSig });
    document.addEventListener('mouseup', () => { seeking = false; }, { signal: vpSig });

    // VP-06: Touch seek — non-passive so we can prevent page scroll while seeking
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

    // Arrow-key seek on the progress bar (accessibility)
    progressWrap.addEventListener('keydown', e => {
      if (!isFinite(video.duration)) return;
      if (e.key === 'ArrowRight') video.currentTime = Math.min(video.duration, video.currentTime + 5);
      if (e.key === 'ArrowLeft')  video.currentTime = Math.max(0, video.currentTime - 5);
    });

    // ── Play / Pause ──────────────────────────────────────────────────────────
    playBtn.addEventListener('click', togglePlay);

    // VP-05: click anywhere on the video surface to play / pause
    video.addEventListener('click', togglePlay);

    // VP-14: pause-other-videos — module-level _activeVideo tracker
    video.addEventListener('play', () => {
      if (_activeVideo && _activeVideo !== video && !_activeVideo.paused) {
        _activeVideo.pause();
      }
      _activeVideo = video;
      replayOverlay.classList.add('hidden');
      updatePlayIcon();
    });

    video.addEventListener('pause',          updatePlayIcon);
    video.addEventListener('timeupdate',     () => { updateProgress(); updateBuffer(); });
    video.addEventListener('loadedmetadata', updateProgress);
    video.addEventListener('durationchange', updateProgress);
    video.addEventListener('progress',       updateBuffer);
    // VP-01: spinner toggle via .hidden class
    video.addEventListener('waiting',  () => spinner.classList.remove('hidden'));
    video.addEventListener('canplay',  () => spinner.classList.add('hidden'));
    video.addEventListener('playing',  () => spinner.classList.add('hidden'));

    // VP-17: replay overlay on ended
    video.addEventListener('ended', () => {
      replayOverlay.classList.remove('hidden');
      if (_activeVideo === video) _activeVideo = null;
      updatePlayIcon();
    });
    replayOverlay.addEventListener('click', () => {
      replayOverlay.classList.add('hidden');
      video.currentTime = 0;
      video.play().catch(() => {});
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
      const v     = parseFloat(volSlider.value);
      video.volume = v;
      video.muted  = v === 0;
      syncMuteIcons();
    });

    // VP-08: keep icons/slider in sync when volume changes from any source
    video.addEventListener('volumechange', syncMuteIcons);

    speedSel.addEventListener('change', () => {
      video.playbackRate = parseFloat(speedSel.value);
    });

    // ── Picture in Picture (VP-04) ────────────────────────────────────────────
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

    // ── Fullscreen (VP-03, VP-18, VP-19) ─────────────────────────────────────
    fsBtn.addEventListener('click', () => {
      isInFs() ? exitFs() : requestFs(wrap);
    });
    // VP-19: both standard and webkit fullscreen change events
    document.addEventListener('fullscreenchange',       syncFsState, { signal: vpSig });
    document.addEventListener('webkitfullscreenchange', syncFsState, { signal: vpSig });

    // VP-22: orientation change — sync fullscreen state
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

    // ── Keyboard shortcuts on the wrap (VP-11, VP-21) ────────────────────────
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
        // VP-21: number keys 1–9 seek to 10%–90%
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

    // VP-20: double-tap to play/pause on mobile touch devices
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

    // ── Initialise UI state ───────────────────────────────────────────────────
    syncMuteIcons();
    updatePlayIcon();
    updateProgress();

    // ── Cleanup when wrap leaves DOM (VP-13: observe the wrap's parent) ───────
    const cleanupObserver = new MutationObserver(() => {
      if (!wrap.isConnected) {
        // VP-14: release global active video reference
        if (_activeVideo === video) _activeVideo = null;
        vpAbort.abort();
        cleanupObserver.disconnect();
      }
    });
    if (wrap.parentNode) {
      cleanupObserver.observe(wrap.parentNode, { childList: true });
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
// FV-01: fixed simultaneous touch-end guard.
// FV-03: resize listener resets pan on orientation change.
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

  // FV-03: reset pan on resize when not zoomed
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

  // Mouse pan
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

  // Touch: pinch-zoom + swipe
  const stage = backdrop.querySelector('.lc-fv-stage');
  let lastPinchDist = null, swipeStartX = null;
  stage.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastPinchDist = Math.hypot(dx, dy);
      swipeStartX = null; // FV-01: cancel swipe when pinch starts
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
    // FV-01: only trigger swipe if we haven't been pinching
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
// MR-01: slide aspect ratio derived from natural image dimensions after load.
// MR-02: all videos rendered inside .lc-media-video-wrap with custom player.
// VP-15: videos use preload="none" — upgraded lazily by IntersectionObserver.
// VP-16: data-poster written from att.thumbnailUrl if present.
// ─────────────────────────────────────────────────────────────────────────────
function buildMediaHTML(msg) {
  // VN-08: voice notes render as a dedicated bubble, not standard media
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
          <img src="${esc(att.url)}"
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
      // MR-02 + VP-15 + VP-16: video with lazy loading and optional poster
      const posterAttr = att.thumbnailUrl
        ? ` data-poster="${esc(att.thumbnailUrl)}"`
        : '';
      // lc-slide--loaded stops the shimmer animation immediately for video slides
      // (there is no onload event to do this the way image slides use it).
      return `<div class="lc-gallery-slide lc-slide--loaded" data-slide="${i}">
        <div class="lc-media-video-wrap" data-file-name="${esc(att.name || 'video.mp4')}"${posterAttr}>
          <video src="${esc(att.url)}"
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
      ? `<button class="lc-gallery-nav lc-gallery-nav--prev" disabled aria-label="Previous">
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
      ? `<span class="lc-gallery-counter" id="${esc(galleryId)}-counter">1/${visuals.length}</span>`
      : '';

    html += `<div class="lc-media-gallery${isSingle ? ' lc-media-gallery--single' : ''}"
                  id="${esc(galleryId)}" data-current="0" data-count="${visuals.length}">
               <div class="lc-gallery-track" id="${esc(galleryId)}-track">${slides}</div>
               ${nav}${dots}${counter}
             </div>`;
  }

  docs.forEach(att => {
    const fname = att.name || 'File';
    const size  = att.size ? fmtSize(att.size) : '';
    const ext   = (fname.split('.').pop() || '').toUpperCase().slice(0, 5);
    html += `<a href="${esc(att.url)}" target="_blank" rel="noopener noreferrer"
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
// GC-01: startIdx from data-gallery-idx, not URL comparison.
// GC-03: touchmove non-passive for proper swipe.
// ─────────────────────────────────────────────────────────────────────────────
function initGalleryCarousels(container = document) {
  // PF-02: scoped
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

    // GC-03: non-passive touchmove for swipe with 40px threshold
    let touchStartX = null;
    gallery.addEventListener('touchstart', e => {
      if (e.touches.length === 1) touchStartX = e.touches[0].clientX;
    }, { passive: true });
    gallery.addEventListener('touchmove', e => {
      // allow natural scroll if vertical
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

  // GC-01: image click → viewer using data-gallery-idx, not URL matching
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

// Doc card click → secure blob download
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
// ─────────────────────────────────────────────────────────────────────────────
function buildReactionsHTML(reactions = {}) {
  const entries = Object.entries(reactions);
  if (!entries.length) return '';
  const myEmail = currentUser?.email || '';
  const pills = entries.map(([emoji, users]) => {
    const mine = users.includes(myEmail);
    return `<button class="lc-reaction-pill${mine ? ' lc-reaction-pill--mine' : ''}"
               data-emoji="${esc(emoji)}" title="${users.length} reaction${users.length !== 1 ? 's' : ''}">
              ${emoji} <span>${users.length}</span>
            </button>`;
  }).join('');
  return `<div class="lc-reactions">${pills}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE HTML RENDERING
// MR-06: meta row always last; timestamp never overlaps media.
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
    ? `<button class="lc-reply-quote" data-scroll-to="${esc(msg.replyTo.id)}">
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

  // Voice notes have no editable content — hide edit button for them
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
// VP-23: preserves video playback state (time, volume, muted, rate) across DOM
// replacement so edits/reaction updates do not reset an in-progress playback.
// ML-07: note — messages from Phase 1 (initial getDocs batch) are NOT covered
// by the realtime listener modifications path, so this function is only called
// for messages that arrived via Phase 2 (new messages that were subsequently
// edited or soft-deleted while the chat is open).
// ─────────────────────────────────────────────────────────────────────────────
function patchMsgInDOM(msg) {
  const el = document.querySelector(`.lc-msg-row[data-msg-id="${CSS.escape(msg.id)}"]`);
  if (!el) return; // not rendered yet or already removed — skip

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
        if (!state.paused) v.play().catch(() => {});
      };
      // Restore immediately if metadata is already available, otherwise wait
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
// APPEND NEW MESSAGES (RC-02: correct last-sep lookup)
// ML-06: initMediaInDOM scoped to only the new rows, not the entire list.
// ─────────────────────────────────────────────────────────────────────────────
function appendNewMessagesToDom(addedCount) {
  const list = $('lc-messages-list');
  if (!list) return;
  const sorted = getSortedMessages();
  if (!sorted.length) return;

  const fragment = document.createDocumentFragment();
  const tmp      = document.createElement('div');

  // RC-02: find the last rendered date separator
  const seps = [...list.querySelectorAll('.lc-date-sep[data-date]')];
  let lastDate = seps.length ? seps[seps.length - 1].dataset.date : '';

  const newMsgs = sorted.slice(-addedCount);
  const newNodeRefs = []; // ML-06: collect new element references for scoped init

  for (const msg of newMsgs) {
    if (list.querySelector(`.lc-msg-row[data-msg-id="${CSS.escape(msg.id)}"]`)) continue;

    const d = fmtDate(msg.timestamp);
    if (d && d !== lastDate) {
      tmp.innerHTML = dateSepHTML(msg.timestamp);
      const sep = tmp.firstElementChild;
      if (sep) { sep.dataset.date = d; fragment.appendChild(sep); }
      lastDate = d;
    }
    tmp.innerHTML = renderMsgHTML(msg);
    const msgEl = tmp.firstElementChild;
    if (msgEl) {
      newNodeRefs.push(msgEl);
      fragment.appendChild(msgEl);
    }
  }

  list.appendChild(fragment);

  // ML-06: init media only on the new rows — avoids rescanning the entire list
  // (elements with data-player-init / data-carousel-init would be skipped by the
  // guards anyway, but avoiding the full querySelectorAll on large lists is faster)
  for (const el of newNodeRefs) {
    initMediaInDOM(el);
  }
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
// OPEN / CLOSE
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
  if (!liveChatSub) subscribeToMessages();
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
  // Cancel any in-progress edit or reply so the UI is clean on the next open
  if (editingMsgId) cancelEdit();
  if (replyingTo)   clearReply();
}

// ─────────────────────────────────────────────────────────────────────────────
// REAL-TIME SUBSCRIPTION  (two-phase, v5)
//
// Phase 1 — getDocs (one-time read, no persistent listener):
//   Fetches the latest PAGE_SIZE messages ordered by timestamp desc.
//   Populates messagesMap / docSnapshotMap and renders the initial view.
//   _newestCursorDoc = docs[0] (newest in desc = anchor for Phase 2).
//   _paginationCursorDoc = docs[last] (oldest in initial batch = pagination
//   cursor for loading older messages; cached at module level for O(1) access).
//
// Phase 2 — onSnapshot (real-time, new messages only):
//   Uses `orderBy asc, startAfter(_newestCursorDoc)` so it ONLY fires for
//   messages sent AFTER the initial window.  modified/removed events also
//   fire here for messages that arrived via Phase 2 (i.e., recently sent
//   messages edited by their author while the chat is open).
//
//   KNOWN TRADE-OFF (ML-07): Messages from Phase 1 (the initial getDocs batch)
//   that are edited or soft-deleted by their author will NOT reflect real-time
//   in the DOM for clients that were already viewing the chat.  They will be
//   correct on the next chat open.  This is the accepted trade-off of the
//   two-phase approach (fewer Firestore reads vs. live updates for history).
//   If your app requires real-time edits on all messages, replace Phase 2 with
//   a single unbounded listener that skips `added` events for ids already in
//   messagesMap, and update `_paginationCursorDoc` lazily.
//
// Guards (ML-01):
//   _isMounted is checked after the async getDocs returns.  If the component
//   was unmounted during the fetch (rapid open/close), we abort cleanly without
//   rendering or subscribing on an unmounted component.
//   liveChatSub is set to a no-op sentinel immediately so concurrent calls
//   to openLiveChat() during the async getDocs cannot double-init.
// ─────────────────────────────────────────────────────────────────────────────
async function subscribeToMessages() {
  if (liveChatSub) { liveChatSub(); liveChatSub = null; }

  // Sentinel: prevents re-entry while the async getDocs is in flight.
  liveChatSub = () => {};

  messagesMap.clear();
  docSnapshotMap.clear();
  hasMoreMessages      = true;
  isLoadingOlder       = false;
  newMsgCount          = 0;
  _paginationCursorDoc = null;   // ML-02, FP-02: reset cached cursors
  _newestCursorDoc     = null;

  // ML-04: block scroll → pagination during initial render
  _isInitialLoading = true;

  // ── Phase 1: one-time initial load ────────────────────────────────────────
  try {
    const initSnap = await getDocs(query(
      collection(db, 'global_chat'),
      orderBy('timestamp', 'desc'),
      limit(PAGE_SIZE),
    ));

    // ML-01: bail if component was unmounted while fetch was in-flight
    if (!_isMounted) {
      liveChatSub = null;
      _isInitialLoading = false;
      return;
    }

    if (initSnap.docs.length < PAGE_SIZE) hasMoreMessages = false;

    initSnap.docs.forEach((d, i) => {
      messagesMap.set(d.id, { id: d.id, ...d.data() });
      docSnapshotMap.set(d.id, d);
      if (i === 0) _newestCursorDoc = d;              // first doc in desc = newest (ML-03)
    });

    // ML-02: cache oldest doc for O(1) pagination cursor access
    if (initSnap.docs.length > 0) {
      _paginationCursorDoc = initSnap.docs[initSnap.docs.length - 1]; // last in desc = oldest
    }

  } catch (err) {
    console.error('[LiveChat] initial load failed:', err);
    if (!_isMounted) { liveChatSub = null; _isInitialLoading = false; return; }
    // Let phase 2 still subscribe so new messages arrive even if Phase 1 failed.
  }

  renderAllMessages(true);

  // ML-04: release initial-loading lock after the programmatic scroll commits
  requestAnimationFrame(() => {
    requestAnimationFrame(() => { _isInitialLoading = false; });
  });

  // ── Phase 2: real-time listener for NEW messages only ────────────────────
  const realtimeQ = _newestCursorDoc
    ? query(
        collection(db, 'global_chat'),
        orderBy('timestamp', 'asc'),
        startAfter(_newestCursorDoc),
      )
    : query(
        collection(db, 'global_chat'),
        orderBy('timestamp', 'asc'),
      );

  const unsub = onSnapshot(
    realtimeQ,
    { includeMetadataChanges: false },
    snap => {
      if (!snap.docChanges().length) return;

      let addedCount = 0;
      const wasAtBottom = checkAtBottom();

      snap.docChanges().forEach(change => {
        const id  = change.doc.id;
        const msg = { id, ...change.doc.data() };

        if (change.type === 'added') {
          // Guard against extremely rare duplicate (e.g. cursor boundary overlap).
          if (!messagesMap.has(id)) {
            messagesMap.set(id, msg);
            docSnapshotMap.set(id, change.doc);
            addedCount++;
          }
        } else if (change.type === 'modified') {
          // Edit or soft-delete of a recently sent message (from Phase 2 window).
          messagesMap.set(id, msg);
          docSnapshotMap.set(id, change.doc);
          patchMsgInDOM(msg);
        } else if (change.type === 'removed') {
          // Hard-delete by admin — real removal, not windowing artifact.
          // (No limit() on Phase 2 query means windowing 'removed' cannot happen.)
          messagesMap.delete(id);
          docSnapshotMap.delete(id);
          // FP-02 edge case: if the removed doc happened to be the pagination
          // cursor, recompute it from the map (fallback to O(n) scan, rare path).
          if (_paginationCursorDoc?.id === id) {
            _paginationCursorDoc = getOldestDocSnapshot();
          }
          document.querySelector(`.lc-msg-row[data-msg-id="${CSS.escape(id)}"]`)?.remove();
        }
      });

      if (addedCount > 0) {
        appendNewMessagesToDom(addedCount);
        if (wasAtBottom) {
          scrollToLatest(true);
        } else {
          newMsgCount += addedCount;
          showNewMsgsBanner(newMsgCount);
          setHeaderBadge(_headerUnread + addedCount);
        }
      }
    },
    err => console.error('[LiveChat] subscription error:', err),
  );

  // Replace sentinel with the real unsubscriber.
  liveChatSub = unsub;
}

// ─────────────────────────────────────────────────────────────────────────────
// OLDEST DOC CURSOR (fallback O(n) scan — primary path now uses _paginationCursorDoc)
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
// PAGINATION  (v5 — cursor-based, O(1) cursor access)
//
// Uses _paginationCursorDoc (cached at module level) as the Firestore cursor
// instead of scanning messagesMap.  Updated after each successful page load to
// point at the oldest doc in the newly fetched batch (FP-01).
//
// Design notes:
//   • Only triggered by explicit user action: "Load older messages" button click
//     or scroll to the top of the list (scroll handler in setupLiveChat).
//   • Never fires during initial render (_isInitialLoading guard in scroll handler).
//   • Scroll position is preserved by measuring scrollHeight delta.
//   • Date-separator deduplication: if the bottom of the new batch shares a
//     date with the existing top separator, the duplicate is removed.
//   • The cursor is NOT affected by real-time additions (those have newer
//     timestamps) or by edits (Firestore serverTimestamp only set on create),
//     keeping the cursor stable across all normal realtime activity.
// ─────────────────────────────────────────────────────────────────────────────
async function loadOlderMessages() {
  if (isLoadingOlder || !hasMoreMessages) return;

  // ML-02: use cached cursor (O(1)) with fallback to O(n) scan
  const cursor = _paginationCursorDoc ?? getOldestDocSnapshot();
  if (!cursor) { hasMoreMessages = false; updateLoadMoreBtn(); return; }

  isLoadingOlder = true;
  const btn = $('lc-load-more-btn');
  if (btn) { btn.textContent = 'Loading…'; btn.disabled = true; }

  const container   = $('lc-messages-container');
  const list        = $('lc-messages-list');
  const prevScrollH = container?.scrollHeight ?? 0;

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

      // Collect genuinely new docs (guard against re-fetch of known messages).
      const olderMsgs = [];
      snap.docs.forEach(d => {
        if (!messagesMap.has(d.id)) {
          const msg = { id: d.id, ...d.data() };
          messagesMap.set(d.id, msg);
          docSnapshotMap.set(d.id, d);
          olderMsgs.push(msg);
        }
      });

      // ML-02: update pagination cursor to the oldest doc in this batch
      // snap.docs is ordered desc; last item = oldest in this batch.
      if (snap.docs.length > 0) {
        _paginationCursorDoc = snap.docs[snap.docs.length - 1];
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

        list.prepend(fragment);

        // Scope media init to only the new rows (ML-06 pattern)
        for (const el of newNodeRefs) {
          initMediaInDOM(el);
        }

        // Restore scroll position: compensate for height gained at the top.
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
// REACTIONS
// ─────────────────────────────────────────────────────────────────────────────
async function toggleReaction(msgId, emoji) {
  if (!currentUser?.email) return;
  const msg = messagesMap.get(msgId);
  if (!msg || msg.isDeleted) return;
  const myEmail   = currentUser.email;
  const reactions = { ...(msg.reactions || {}) };
  const users     = reactions[emoji] ? [...reactions[emoji]] : [];
  const idx       = users.indexOf(myEmail);
  if (idx === -1) { users.push(myEmail); }
  else            { users.splice(idx, 1); }
  if (users.length === 0) delete reactions[emoji];
  else                    reactions[emoji] = users;
  try {
    await updateDoc(doc(db, 'global_chat', msgId), { reactions });
  } catch (err) {
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
        return;
      }
    }

    const snapshotReply = replyingTo ? { ...replyingTo } : null;
    clearReply();
    const first = attachments[0] ?? null;

    await addDoc(collection(db, 'global_chat'), {
      type:         null,            // null for regular messages; 'voice' for voice notes
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
    isSending = false;
    if (sendBtn) sendBtn.disabled = false;
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
      ? `<img class="lc-fp-img" src="${esc(att.url)}" alt="${esc(att.name || 'image')}">`
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
    // VN-09: voice notes on Cloudinary are not deleted client-side; voiceUrl is
    // simply nulled here. Server-side cleanup can be handled via Cloud Function.
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
// VOICE NOTE ENGINE  (v1 — production-ready)
//
// Architecture:
//   VN-01  All state isolated in _vn* module variables; no coupling to text-send path.
//   VN-02  MediaRecorder preferred codec: audio/webm;codecs=opus → audio/ogg;codecs=opus → audio/mp4 (iOS).
//   VN-03  AudioContext + AnalyserNode draws a real-time waveform from microphone input.
//   VN-04  Recording timer runs at 100 ms precision; auto-stops at _vnMaxDuration.
//   VN-05  Pause/resume implemented via MediaRecorder.pause() / .resume() with
//          offset tracking so the displayed time is accurate across pauses.
//   VN-06  Upload via Cloudinary (uploadToCloudinary) with real-time XHR progress.
//   VN-07  Firestore message document stores { type:'voice', voiceUrl, voiceDuration, voiceMime }.
//   VN-08  Voice bubble renders a custom HTML audio player: waveform seek bar,
//          play/pause, elapsed/total time, playback speed selector, download button.
//   AP-01  _activeAudio tracker pauses any playing voice note when another starts
//          (mirrors VP-14 pattern for videos).
//   VN-09  teardownVoiceNote() called in teardownLiveChat() to release resources.
//   VN-10  Mic permission error shown as a friendly toast; recording state reset cleanly.
//   VN-11  All voice note action buttons (reply, react, report, delete) wired in
//          the standard message-actions row — no special-casing needed.
// ─────────────────────────────────────────────────────────────────────────────

// ── Codec negotiation (VN-02) ─────────────────────────────────────────────────
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

// ── Format seconds as m:ss ─────────────────────────────────────────────────────
function fmtVNTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m  = Math.floor(sec / 60);
  const s  = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ── Elapsed recording time (ms), accounting for pauses ────────────────────────
function vnElapsed() {
  if (_vnState === 'recording') return Date.now() - _vnStartTime - _vnPauseOffset;
  if (_vnState === 'paused')    return _vnPauseStart - _vnStartTime - _vnPauseOffset;
  return 0;
}

// ── Update the recording timer display ────────────────────────────────────────
function vnUpdateTimer() {
  const el = $('lc-vn-timer');
  if (!el) return;
  const sec = Math.round(vnElapsed() / 1000);
  el.textContent = fmtVNTime(sec);
  // Flash red at 10 s before limit
  el.classList.toggle('lc-vn-timer--warn', sec >= _vnMaxDuration - 10);
  if (sec >= _vnMaxDuration) vnStop(true);
}

// ── Start waveform animation (VN-03) ──────────────────────────────────────────
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
      if (_vnState !== 'recording') {
        // freeze bars while paused
        _vnAnimFrame = requestAnimationFrame(draw);
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
    // AudioContext unavailable (e.g. very old browsers) — waveform stays static
  }
}

// ── Stop waveform animation ────────────────────────────────────────────────────
function vnStopWaveform() {
  if (_vnAnimFrame) { cancelAnimationFrame(_vnAnimFrame); _vnAnimFrame = null; }
  try { _vnAudioCtx?.close(); } catch { /* ignore */ }
  _vnAudioCtx = null;
  _vnAnalyser = null;
  _vnBars = [];
}

// ── Show / hide voice UI ───────────────────────────────────────────────────────
function vnShowUI(show) {
  const voicePanel = $('lc-vn-panel');
  const inputArea  = $('lc-input-area-inner');
  if (voicePanel) voicePanel.classList.toggle('hidden', !show);
  if (inputArea)  inputArea.classList.toggle('hidden', show);
}

// ── Update mic button appearance ───────────────────────────────────────────────
function vnSyncMicBtn() {
  const btn = $('lc-vn-mic-btn');
  if (!btn) return;
  btn.classList.toggle('lc-vn-mic-btn--recording', _vnState === 'recording' || _vnState === 'paused');
  btn.setAttribute('aria-label', _vnState === 'idle' ? 'Record voice note' : 'Cancel recording');
}

// ── Request microphone and start recording ─────────────────────────────────────
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
      _vnMediaRecorder = new MediaRecorder(stream); // fallback: let browser choose codec
    }

    _vnMediaRecorder.addEventListener('dataavailable', e => {
      if (e.data?.size > 0) _vnChunks.push(e.data);
    });

    _vnMediaRecorder.addEventListener('stop', () => {
      // Triggered by vnStop(); data is assembled there.
    });

    _vnMediaRecorder.start(200); // collect chunks every 200 ms for progress
  } catch (err) {
    // MediaRecorder construction or start() failed — clean up mic stream and reset
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

// ── Pause / resume recording (VN-05) ──────────────────────────────────────────
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
  }
}

// ── Cancel recording ───────────────────────────────────────────────────────────
function vnCancel() {
  if (_vnState === 'idle' || _vnState === 'uploading') return; // uploading: let the XHR finish
  _vnMediaRecorder?.stop();
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

// ── Stop recording and initiate upload (VN-06) ───────────────────────────────
function vnStop(autoStop = false) {
  if (_vnState !== 'recording' && _vnState !== 'paused') return;

  const durationMs = vnElapsed();
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

  // Guard: recorder must exist (it always should given the state check above, but be safe)
  if (!_vnMediaRecorder) {
    _vnState = 'idle';
    vnShowUI(false);
    vnSyncMicBtn();
    return;
  }

  // Collect remaining data then stop
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

// ── Upload to Cloudinary and write Firestore doc (VN-06, VN-07) ───────────────
async function vnUploadAndSend(blob, durationSec, mimeType, ext) {
  if (!currentUser?.email) return;

  // Show upload progress UI
  showUploadProgress(0);
  const progressLabel = $('lc-upload-label');
  if (progressLabel) progressLabel.textContent = 'Uploading voice note…';

  const fileName = `voice_${Date.now()}${ext}`;
  // Wrap blob in a File so uploadToCloudinary gets a proper name and type
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
    // No client-side cleanup needed — Cloudinary manages orphaned uploads
  }
}

// VN-09: vnDeleteStorageFile removed — voice notes are now stored on Cloudinary.
// Cloudinary URLs are simply nulled in Firestore on delete; server-side cleanup
// can be handled via Cloudinary's dashboard or a Cloud Function if needed.

// ── Build voice bubble HTML (VN-08) ───────────────────────────────────────────
function buildVoiceBubbleHTML(msg) {
  const totalSec  = msg.voiceDuration || 0;
  const totalFmt  = fmtVNTime(totalSec);
  const barCount  = 28;
  const bars      = Array.from({ length: barCount }, (_, i) => {
    // Static decorative waveform height pattern (sinusoidal)
    const h = Math.round(20 + 55 * Math.abs(Math.sin((i / barCount) * Math.PI * 3.5 + 0.5)));
    return `<div class="lc-vb-bar" style="height:${h}%"></div>`;
  }).join('');

  return `
    <div class="lc-voice-bubble" data-msg-id="${esc(msg.id)}"
         data-voice-url="${esc(msg.voiceUrl || '')}"
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
        <div class="lc-vb-wave-seek" role="slider"
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

// ── Initialize all voice bubbles in a container (VN-08) ───────────────────────
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

    let audio      = null;
    let _seeking   = false;
    let _touchSeek = false;

    const createAudio = () => {
      if (audio) return;
      audio = new Audio();
      audio.preload = 'none';
      audio.src     = url;

      // AP-01: pause any other playing voice note when this one starts
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
        if (seekEl) seekEl.setAttribute('aria-valuenow', Math.round(pct));
        updateBarProgress(pct);
      });

      audio.addEventListener('error', () => {
        showLCToast('Could not play voice note', 'error');
        playIcon.style.display  = '';
        pauseIcon.style.display = 'none';
      });
    };

    // Bar highlight: darken bars left of playhead
    const bars = barsEl ? Array.from(barsEl.querySelectorAll('.lc-vb-bar')) : [];
    const updateBarProgress = pct => {
      const threshold = (pct / 100) * bars.length;
      bars.forEach((bar, i) => {
        bar.classList.toggle('lc-vb-bar--played', i < threshold);
      });
    };

    // Seek helpers
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

    // Play / pause toggle
    playBtn.addEventListener('click', () => {
      createAudio();
      if (audio.paused) {
        audio.play().catch(() => showLCToast('Could not play voice note', 'error'));
      } else {
        audio.pause();
      }
    });

    // Mouse seek on waveform
    seekEl?.addEventListener('mousedown', e => {
      createAudio();
      _seeking = true;
      seekFromClientX(e.clientX);
    });
    seekEl?.addEventListener('mousemove', e => {
      if (_seeking) seekFromClientX(e.clientX);
    });
    const onMouseUp = () => { _seeking = false; };
    document.addEventListener('mouseup', onMouseUp);

    // Touch seek on waveform
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

    // Arrow-key seek (accessibility)
    seekEl?.addEventListener('keydown', e => {
      createAudio();
      const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : totalSec;
      if (!dur) return;
      if (e.key === 'ArrowRight') audio.currentTime = Math.min(dur, audio.currentTime + 5);
      if (e.key === 'ArrowLeft')  audio.currentTime = Math.max(0, audio.currentTime - 5);
    });

    // Playback speed
    speedSel?.addEventListener('change', () => {
      if (audio) audio.playbackRate = parseFloat(speedSel.value);
    });

    // Download
    dlBtn?.addEventListener('click', () => secureDownload(url, `voice-note-${Date.now()}.${mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm'}`));

    // Cleanup when element leaves DOM
    const cleanupObs = new MutationObserver(() => {
      if (!wrap.isConnected) {
        audio?.pause();
        document.removeEventListener('mouseup', onMouseUp);
        if (_activeAudio === audio) _activeAudio = null;
        audio = null;
        cleanupObs.disconnect();
      }
    });
    if (wrap.parentNode) cleanupObs.observe(wrap.parentNode, { childList: true });
  });
}

// ── Teardown voice note resources (VN-09) ─────────────────────────────────────
function teardownVoiceNote() {
  vnCancel();
  if (_activeAudio && !_activeAudio.paused) _activeAudio.pause();
  _activeAudio = null;
}

// ── Setup mic button and recording UI (called in setupLiveChat) ───────────────
function setupVoiceNote() {
  const micBtn   = $('lc-vn-mic-btn');
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
// MR-05: uses .lc-gallery-panel class with position:fixed.
// GC-04: emits .lc-gallery-item with correct sub-classes.
// GC-05: diacritic-stripped search.
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

    grid.innerHTML = allItems.map(item => {
      if (item.type === 'image') {
        return `<div class="lc-gallery-item lc-gallery-item--img" data-url="${esc(item.url)}" tabindex="0" role="button" aria-label="${esc(item.name || 'Image')}">
                  <img src="${esc(item.url)}" loading="lazy" decoding="async" alt="${esc(item.name || 'Image')}">
                </div>`;
      }
      if (item.type === 'video') {
        // Use thumbnailUrl as poster for instant preview; if none, use a
        // seeked-frame trick via JS after render (see wiring below).
        const posterAttr = item.thumbnailUrl ? ` poster="${esc(item.thumbnailUrl)}"` : '';
        return `<div class="lc-gallery-item lc-gallery-item--vid"
                     data-url="${esc(item.url)}"
                     data-name="${esc(item.name || 'video.mp4')}"
                     tabindex="0" role="button" aria-label="${esc(item.name || 'Video')}">
                  <video src="${esc(item.url)}"${posterAttr} preload="metadata" muted playsinline crossorigin="anonymous"></video>
                  <div class="lc-gallery-item__overlay">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28">
                      <circle cx="12" cy="12" r="12" fill="rgba(0,0,0,0.55)"/>
                      <path d="M10 8.5l6 3.5-6 3.5z" fill="#fff"/>
                    </svg>
                  </div>
                </div>`;
      }
      const ext = (item.name || '').split('.').pop().toUpperCase().slice(0, 5);
      return `<a class="lc-gallery-item lc-gallery-item--doc" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" data-download-name="${esc(item.name || 'file')}">
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

    // Wire video gallery items: click scrolls chat to that message & opens viewer
    grid.querySelectorAll('.lc-gallery-item--vid').forEach(item => {
      const video = item.querySelector('video');
      // Seeked-frame thumbnail: if no poster, seek to 1s so the browser
      // decodes a frame and paints it into the video element as a thumbnail.
      if (video && !video.poster) {
        video.addEventListener('loadedmetadata', () => {
          video.currentTime = Math.min(1, video.duration * 0.1);
        }, { once: true });
      }
      item.addEventListener('click', () => {
        // Scroll chat to the message containing this video
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
// CLEANUP
// ─────────────────────────────────────────────────────────────────────────────
export function teardownLiveChat() {
  _isMounted = false;

  if (_globalAbort) { _globalAbort.abort(); _globalAbort = null; }

  liveChatSub?.(); liveChatSub = null;
  presenceSub?.(); presenceSub = null;
  typingSub?.();   typingSub   = null;
  stopHeartbeat();
  markPresenceOffline();
  clearTypingIndicator();

  messagesMap.clear();
  docSnapshotMap.clear();

  // FP-02: reset cached cursors so next open starts fresh
  _paginationCursorDoc = null;
  _newestCursorDoc     = null;

  // VP-14: release active video reference
  if (_activeVideo && !_activeVideo.paused) _activeVideo.pause();
  _activeVideo = null;

  // VN-09: tear down voice note recording and playback
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

  const closeBtn  = $('lc-close-btn');
  const backdrop  = $('lc-backdrop');
  const sendBtn   = $('lc-send-btn');
  const input     = $('lc-input');
  const attachBtn = $('lc-attach-btn');
  const fileInput = $('lc-file-input-el');
  const newMsgBar = $('lc-new-msgs-bar');
  const loadMore  = $('lc-load-more-btn');
  const emojiBtn  = $('lc-emoji-btn');
  const galleryBtn = $('lc-gallery-btn');

  closeBtn?.addEventListener('click', closeLiveChat);
  backdrop?.addEventListener('click', closeLiveChat);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen) {
      if (_galleryOpen)    { closeGallery(); return; }
      if (_emojiPickerOpen){ closeEmojiPicker(); return; }
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
      if (editingMsgId) { cancelEdit();   return; }
      if (replyingTo)   { clearReply();   return; }
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

    if (replyBtn)      { e.stopPropagation(); startReply(replyBtn.dataset.msgId); }
    if (editBtn)       { e.stopPropagation(); startEdit(editBtn.dataset.msgId); }
    if (deleteBtn)     { e.stopPropagation(); deleteMessage(deleteBtn.dataset.msgId); }
    if (reactBtn)      { e.stopPropagation(); openReactionPicker(reactBtn.dataset.msgId); }
    if (reportBtn)     { e.stopPropagation(); openReportDialog(reportBtn.dataset.msgId); }
    if (reactionPill)  {
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

  // ML-04: _isInitialLoading blocks pagination during initial render.
  // ML-05: rAF throttle ensures the handler fires at most once per animation frame.
  $('lc-messages-container')?.addEventListener('scroll', () => {
    if (_scrollRafPending) return;
    _scrollRafPending = true;
    requestAnimationFrame(() => {
      _scrollRafPending = false;
      atBottom = checkAtBottom();
      if (atBottom) hideNewMsgsBanner();
      // Trigger pagination when user scrolls to top — but never during the
      // initial programmatic scroll or while a load is already in progress.
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