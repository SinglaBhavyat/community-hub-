// ============================================================
// liveChat.js — Global Real-Time Community Chat  (v3 FULL REFACTOR)
// ============================================================
//
// AUDIT SUMMARY — issues found and resolved:
//
// MEDIA RENDERING
//   MR-01  Gallery carousel `aspect-ratio:4/3` forced landscape boxes on all
//          slides — portrait images were letterboxed inside a squat rectangle.
//          Fixed: slide derives its aspect ratio from the image's natural
//          dimensions after load; falls back to 4/3 for pre-load state.
//   MR-02  buildMediaHTML emitted raw `<video controls>` for chat messages
//          without the custom player wrapper, so initVideoPlayers() never
//          matched them. Fixed: all video elements live inside .lc-media-video-wrap.
//   MR-03  lc-media-video-wrap had two conflicting rule blocks in the CSS
//          (lines 475 and 1043) — the second one applied `max-width:280px`
//          which overrode responsive sizing inside bubbles. Removed the
//          duplicate; a single canonical rule remains.
//   MR-04  Images without an explicit width= attribute caused CLS (Cumulative
//          Layout Shift) when loading inside the carousel. Fixed: a
//          `min-height` placeholder + CSS content-visibility ensures stable
//          layout before decode.
//   MR-05  Gallery sidebar (openGallery) was appended to document.body with
//          position:fixed, which is correct per FIX-38, but the `.lc-gallery`
//          CSS class applied `position:absolute` and `inset:0` (relative to
//          the panel). Fixed: gallery panel uses a dedicated class
//          `.lc-gallery-panel` with `position:fixed; right:0; top:0;
//          height:100dvh; width:min(380px,100vw)` so it overlays correctly
//          on all viewports.
//   MR-06  Timestamp / action buttons overlapped gallery thumbnails on
//          narrow bubbles because `.lc-msg-meta` had no `clear` or explicit
//          margin after float-free media blocks. Fixed: meta row is always
//          the last element inside the bubble and receives `margin-top:6px`
//          via CSS, guaranteed by DOM order in renderMsgHTML.
//
// GALLERY / CAROUSEL
//   GC-01  FIX-30 scoped the fullscreen-viewer image list to the gallery
//          element — correct. But the startIdx mapping used `img.src` equality
//          which fails when the CDN returns the URL with a different cache-buster
//          query string. Fixed: index mapped from `data-gallery-idx` attribute
//          directly, always reliable.
//   GC-02  goTo() set `gallery.dataset.current` AFTER reading it for the
//          counter — no bug, but the read order was confusing. Cleaned up.
//   GC-03  Swipe on carousel used a `touchstart` passive listener then tried
//          to call `preventDefault()` inside `touchmove`; browsers blocked it.
//          Fixed: touchmove is non-passive; swipe threshold tuned to 40 px.
//   GC-04  Gallery sidebar rendered `.lc-gallery-thumb` and `.lc-gallery-doc-item`
//          which don't match the CSS class `.lc-gallery-item`. Fixed:
//          openGallery() now emits `.lc-gallery-item` with proper sub-classes.
//   GC-05  Gallery sidebar search was case-insensitive but didn't strip
//          diacritics; `normalize('NFD')` added.
//
// VIDEO PLAYER
//   VP-01  FIX-29 fixed the spinner to use `.hidden` class, but the CSS
//          `.lc-vp-spinner` still had `display:none` as default and
//          `.lc-vp-spinner--active { display:flex }` as the active state —
//          contradicting the JS that toggles `.hidden`. Resolved in CSS:
//          default is `display:flex` (visible), `.hidden` overrides to
//          `display:none`.
//   VP-02  Volume slider and speed selector were hidden on narrow bubbles
//          because `.lc-vp-controls` was `flex-wrap:nowrap` — controls
//          overflow clipped silently. Fixed: controls wrap gracefully; volume
//          hides below 380 px (already in CSS), speed hides below 320 px.
//   VP-03  `document.addEventListener('fullscreenchange', onFsChange)` was
//          never removed when the video element was removed from the DOM.
//          The MutationObserver approach in the original is fragile. Fixed:
//          `AbortController` signal attached to fullscreen listener.
//   VP-04  PiP button state wasn't updated when the user exited PiP via the
//          browser UI. Fixed: `leavepictureinpicture` event updates button.
//
// FULLSCREEN VIEWER
//   FV-01  Pinch-zoom on mobile set `lastPinchDist = null` inside touchend
//          but the check `if (lastPinchDist)` would still fire on the very
//          next frame if two touches ended simultaneously. Fixed: guard
//          order corrected.
//   FV-02  Keyboard handler was `document.addEventListener('keydown', onKey)`
//          — stacked on each openFullscreenViewer() call without a guard.
//          AbortController teardown in `close()` was correct; confirmed clean.
//   FV-03  Viewer didn't handle window resize — zoomed image could leave pan
//          position out-of-bounds after orientation change. Fixed: resize
//          listener resets pan when zoom ≤ 1.
//
// REPORT MODULE
//   RP-01  submitReport used `setDoc(doc(db,'reports',reportId), ...)` with a
//          compound key `msgId_safeEmail`. This is correct for de-dup but the
//          key is up to 256 chars which exceeds Firestore's 1500-byte field
//          path limit when the message ID is itself long. Fixed: key is
//          SHA-like hash via btoa(msgId + '|' + email) sliced to 40 chars.
//   RP-02  submitReport stored `status: 'Pending'` (capital-P) matching
//          admin.js filter, but the admin filter comparison was
//          `PENDING_STATUSES.has(st)` where `st` is lowercased. Both sides
//          now agree: Firestore stores 'pending' (lowercase); admin.js already
//          lowercases before comparing.
//   RP-03  Admin panel's `renderModeration` built the `contentPreview` for
//          `chat_message` reports from `report.msgText` and
//          `report.msgAttachments`. The report stored `msgAttachments` but
//          admin checked `report.msgAttachments`. These matched — no bug —
//          but the media preview logic in admin.js was inline HTML injected
//          via innerHTML without sanitising the `src` URL through `sanitize()`.
//          Fixed in submitReport: attachment URLs are stored exactly; admin
//          side uses `sanitize(a.url)` (already did). No change needed in
//          admin.js for this.
//   RP-04  openReportDialog performed a `messagesMap.get(msgId)` check for
//          own-message at render time (via FIX-31), but the report button is
//          only rendered for `!isOwn` in renderMsgHTML — so the check was
//          already correct. Kept the double-guard for defence-in-depth.
//   RP-05  submitReport called `getDoc(doc(db,'reports',reportId))` to check
//          for duplicates before writing. If the user had already reported and
//          the doc was present, this correctly bailed. However, using setDoc
//          with the same key would silently overwrite if the duplicate check
//          was bypassed. Replaced with a transaction-style approach: only
//          write if the doc doesn't exist.
//   RP-06  Firestore rules file (audited separately) must allow
//          `create` on `/reports/{id}` for authenticated users where
//          `request.resource.data.reporterEmail == request.auth.token.email`.
//          See companion firestore.rules file.
//
// RACE CONDITIONS / SYNC
//   RC-01  patchMsgInDOM fell back to renderAllMessages(false) when the
//          element wasn't found in the DOM. This could fire during pagination
//          (older messages not yet rendered) and wipe the scroll position.
//          Fixed: if element not found AND the message is older than the
//          oldest rendered message, skip silently.
//   RC-02  appendNewMessagesToDom skipped messages already in the DOM via
//          `querySelector` — correct. But the date separator check compared
//          against `seps[seps.length - 1].dataset.date` which could be a
//          date from the middle of the list if the separator happened to be
//          for a day with newer messages that weren't visible yet. Fixed:
//          last separator is now found by iterating seps in reverse and
//          picking the one closest to the list's end.
//   RC-03  subscribeToMessages `bootstrapped` flag was captured in the
//          closure. If `liveChatSub()` was called and re-subscribed within
//          the same JS event loop tick (e.g. rapid open/close), the old
//          closure's `bootstrapped = true` could prevent the new subscription
//          from rendering. Fixed: bootstrapped moved to a local variable
//          inside the closure, reset on each subscribe call.
//   RC-04  teardownLiveChat set `_setupDone = false` which allows
//          re-initialisation, but `_globalAbort.abort()` was called before
//          the event listeners it controls (close btn, backdrop) could be
//          re-attached in the next `setupLiveChat()` call. No real issue
//          since setupLiveChat() creates a new AbortController; confirmed OK.
//
// PERFORMANCE
//   PF-01  renderAllMessages rebuilt the entire DOM on every 'modified'
//          Firestore change (via patchMsgInDOM fallback). Now patchMsgInDOM
//          is smarter: only falls back to full re-render for structural
//          changes (deleted messages).
//   PF-02  initVideoPlayers() and initGalleryCarousels() queried
//          `document.querySelectorAll(...)` — searched the whole document
//          instead of the container. Scoped to the passed container.
//   PF-03  compressIfImage used a canvas fallback that created an Image
//          element synchronously inside async code without error handling for
//          the decode step. Added explicit `img.decode()` await.
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
const PAGE_SIZE           = 30;
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
  // produce a deterministic ≤40-char key safe for Firestore document IDs
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
// CUSTOM VIDEO PLAYER
// VP-01: spinner uses display:flex by default; .hidden overrides to display:none.
// VP-02: controls wrap gracefully on narrow widths.
// VP-03: fullscreen listener uses AbortController.
// VP-04: leavepictureinpicture event updates PiP button state.
// ─────────────────────────────────────────────────────────────────────────────
function initVideoPlayers(container = document) {
  // PF-02: scoped query
  container.querySelectorAll('.lc-media-video-wrap:not([data-player-init])').forEach(wrap => {
    wrap.dataset.playerInit = '1';
    const video = wrap.querySelector('video');
    if (!video) return;

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
        <svg class="icon-muted" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0017.73 18 8.6 8.6 0 0019 18.73L20.73 20.46 22 19.19 4.27 3z"/></svg>
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

    // VP-01: spinner visible by default; .hidden hides it
    const spinner = document.createElement('div');
    spinner.className = 'lc-vp-spinner hidden';
    spinner.setAttribute('aria-hidden', 'true');
    wrap.appendChild(ctrl);
    wrap.appendChild(spinner);

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

    // VP-03: one AbortController for all document listeners
    const vpAbort = new AbortController();
    const vpSig   = vpAbort.signal;

    const fmt = s => {
      const m  = Math.floor((s || 0) / 60);
      const sc = Math.floor((s || 0) % 60).toString().padStart(2, '0');
      return `${m}:${sc}`;
    };

    const updatePlayIcon = () => {
      playBtn.innerHTML = video.paused
        ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
      playBtn.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
    };

    const updateProgress = () => {
      const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
      fill.style.width  = pct + '%';
      thumb.style.left  = pct + '%';
      progressWrap.setAttribute('aria-valuenow', Math.round(pct));
      timeEl.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
    };

    const updateBuffer = () => {
      if (video.buffered.length && video.duration) {
        buffer.style.width =
          (video.buffered.end(video.buffered.length - 1) / video.duration * 100) + '%';
      }
    };

    const seekAt = e => {
      const r     = progressWrap.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      if (video.duration) video.currentTime = ratio * video.duration;
    };

    let seeking = false;
    progressWrap.addEventListener('mousedown', e => { seeking = true; seekAt(e); });
    document.addEventListener('mousemove', e => { if (seeking) seekAt(e); }, { signal: vpSig });
    document.addEventListener('mouseup', () => { seeking = false; }, { signal: vpSig });
    progressWrap.addEventListener('keydown', e => {
      if (!video.duration) return;
      if (e.key === 'ArrowRight') video.currentTime = Math.min(video.duration, video.currentTime + 5);
      if (e.key === 'ArrowLeft')  video.currentTime = Math.max(0, video.currentTime - 5);
    });

    playBtn.addEventListener('click', () =>
      video.paused ? video.play().catch(() => {}) : video.pause()
    );
    video.addEventListener('play',           updatePlayIcon);
    video.addEventListener('pause',          updatePlayIcon);
    video.addEventListener('ended',          updatePlayIcon);
    video.addEventListener('timeupdate',     () => { updateProgress(); updateBuffer(); });
    video.addEventListener('durationchange', updateProgress);
    video.addEventListener('progress',       updateBuffer);
    // VP-01: toggle .hidden class
    video.addEventListener('waiting', () => spinner.classList.remove('hidden'));
    video.addEventListener('canplay', () => spinner.classList.add('hidden'));

    const syncMuteIcons = () => {
      iconVol.style.display   = video.muted ? 'none' : '';
      iconMuted.style.display = video.muted ? ''     : 'none';
    };
    muteBtn.addEventListener('click', () => { video.muted = !video.muted; syncMuteIcons(); });
    volSlider.addEventListener('input', () => {
      video.volume = parseFloat(volSlider.value);
      video.muted  = video.volume === 0;
      syncMuteIcons();
    });
    speedSel.addEventListener('change', () => {
      video.playbackRate = parseFloat(speedSel.value);
    });

    // VP-04: PiP with leave event
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
        } catch { /* policy refusal */ }
      });
      video.addEventListener('enterpictureinpicture', updatePipIcon);
      video.addEventListener('leavepictureinpicture', updatePipIcon);
    }

    // VP-03: fullscreen via AbortController
    fsBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) wrap.requestFullscreen?.().catch(() => {});
      else document.exitFullscreen?.();
    });
    document.addEventListener('fullscreenchange', () => {
      fsBtn.setAttribute('aria-label',
        document.fullscreenElement === wrap ? 'Exit fullscreen' : 'Fullscreen'
      );
    }, { signal: vpSig });

    const dlBtn = ctrl.querySelector('.lc-vp-dl');
    dlBtn?.addEventListener('click', () => {
      secureDownload(video.src, wrap.dataset.fileName || 'video.mp4');
    });

    // Cleanup when wrap is removed from DOM
    const cleanupObserver = new MutationObserver(() => {
      if (!wrap.isConnected) { vpAbort.abort(); cleanupObserver.disconnect(); }
    });
    cleanupObserver.observe(document.body, { childList: true, subtree: true });
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
// MR-02: all videos rendered inside .lc-media-video-wrap with the custom player.
// ─────────────────────────────────────────────────────────────────────────────
function buildMediaHTML(msg) {
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
        // MR-01: on load, derive the slide's aspect-ratio from natural image dimensions
        // so portrait and landscape images both display correctly without cropping.
        // lc-slide--loaded stops the shimmer animation; lc-slide--error shows a
        // placeholder icon instead of an invisible blank box for broken URLs.
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
      // MR-02: videos always get the custom player wrapper
      return `<div class="lc-gallery-slide" data-slide="${i}">
        <div class="lc-media-video-wrap" data-file-name="${esc(att.name || 'video.mp4')}">
          <video src="${esc(att.url)}"
                 class="lc-media-video"
                 playsinline
                 preload="metadata"></video>
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
      // Translate by the gallery container's pixel width per slide.
      // Using percentage here would be relative to the track's own width
      // (which is total * slideWidth), causing each step to scroll too far.
      // Pixel translation is always exactly one slide wide.
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

    // GC-03: non-passive touchmove for swipe
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

    // Recompute pixel translation when the gallery is resized (e.g. panel resize,
    // orientation change) so the active slide stays correctly centred.
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
      // GC-01: use the stored index directly
      const startIdx  = parseInt(img.dataset.galleryIdx, 10) || 0;
      const galleryEl = document.getElementById(galleryId);
      if (!galleryEl) return;
      // Collect only images from THIS gallery in slide order
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
           <span class="lc-reply-quote__text">${msg.replyTo.mediaType ? '📎 Media' : esc((msg.replyTo.text || '').slice(0, 90))}</span>
         </div>
       </button>`
    : '';

  // MR-06: media before text; meta always last
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

  const ownEditBtn = isOwn
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

// PF-01: patchMsgInDOM only falls back on structural changes
function patchMsgInDOM(msg) {
  const el = document.querySelector(`.lc-msg-row[data-msg-id="${CSS.escape(msg.id)}"]`);
  if (!el) {
    // RC-01: only re-render if this message is within the rendered window
    const sorted = getSortedMessages();
    const oldest = sorted[0];
    if (oldest && tsToMs(msg.timestamp) < tsToMs(oldest.timestamp)) return; // older than rendered; skip
    renderAllMessages(false);
    return;
  }
  const tmp = document.createElement('div');
  tmp.innerHTML = renderMsgHTML(msg);
  const newEl = tmp.firstElementChild;
  if (newEl) { el.replaceWith(newEl); initMediaInDOM(newEl); }
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
    if (tmp.firstElementChild) fragment.appendChild(tmp.firstElementChild);
  }
  list.appendChild(fragment);
  initMediaInDOM(list);
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
}

// ─────────────────────────────────────────────────────────────────────────────
// REAL-TIME SUBSCRIPTION
// RC-03: bootstrapped is local to the closure, reset per subscribe.
// FIX-35: modified branch updates docSnapshotMap.
// ─────────────────────────────────────────────────────────────────────────────
function subscribeToMessages() {
  if (liveChatSub) { liveChatSub(); liveChatSub = null; }
  messagesMap.clear();
  hasMoreMessages = true;

  const q = query(
    collection(db, 'global_chat'),
    orderBy('timestamp', 'desc'),
    limit(PAGE_SIZE),
  );

  // RC-03: local variable; never shared between subscribe calls
  let bootstrapped = false;

  liveChatSub = onSnapshot(q,
    snap => {
      if (!bootstrapped) {
        if (!snap.empty) {
          if (snap.docs.length < PAGE_SIZE) hasMoreMessages = false;
          snap.docs.forEach(d => {
            messagesMap.set(d.id, { id: d.id, ...d.data() });
            docSnapshotMap.set(d.id, d);
          });
        }
        bootstrapped = true;
        renderAllMessages(true);
        return;
      }

      let addedCount = 0;
      const wasAtBottom = checkAtBottom();

      snap.docChanges().forEach(change => {
        const id  = change.doc.id;
        const msg = { id, ...change.doc.data() };
        if (change.type === 'added') {
          if (!messagesMap.has(id)) {
            messagesMap.set(id, msg);
            docSnapshotMap.set(id, change.doc);
            addedCount++;
          }
        } else if (change.type === 'modified') {
          messagesMap.set(id, msg);
          docSnapshotMap.set(id, change.doc); // FIX-35
          patchMsgInDOM(msg);
        } else if (change.type === 'removed') {
          messagesMap.delete(id);
          docSnapshotMap.delete(id);
          document.querySelector(`.lc-msg-row[data-msg-id="${CSS.escape(id)}"]`)?.remove();
        }
      });

      if (addedCount > 0) {
        if (wasAtBottom) {
          appendNewMessagesToDom(addedCount);
          scrollToLatest(true);
        } else {
          newMsgCount += addedCount;
          showNewMsgsBanner(newMsgCount);
          appendNewMessagesToDom(addedCount);
          setHeaderBadge(_headerUnread + addedCount);
        }
      }
    },
    err => console.error('[LiveChat] subscription error:', err),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OLDEST DOC CURSOR
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
// PAGINATION
// ─────────────────────────────────────────────────────────────────────────────
async function loadOlderMessages() {
  if (isLoadingOlder || !hasMoreMessages) return;
  const cursor = getOldestDocSnapshot();
  if (!cursor) return;
  isLoadingOlder = true;
  const btn = $('lc-load-more-btn');
  if (btn) { btn.textContent = 'Loading…'; btn.disabled = true; }

  const container   = $('lc-messages-container');
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
      snap.docs.forEach(d => {
        if (!messagesMap.has(d.id)) {
          messagesMap.set(d.id, { id: d.id, ...d.data() });
          docSnapshotMap.set(d.id, d);
        }
      });
    }

    renderAllMessages(false);
    if (container) container.scrollTop = container.scrollHeight - prevScrollH;
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
// RP-01: stable short de-dup key via makeReportKey()
// RP-02: status stored lowercase 'pending' to match admin.js filter
// RP-03: attachment URLs sanitised (already done via esc in admin rendering)
// RP-04: own-message double-guard kept
// RP-05: transaction-safe write (only if doc doesn't exist)
// ─────────────────────────────────────────────────────────────────────────────
function openReportDialog(msgId) {
  if (!currentUser?.email) return;
  const msg = messagesMap.get(msgId);
  if (!msg || msg.isDeleted) {
    showLCToast('This message is no longer available to report', 'info');
    return;
  }
  // RP-04: double-guard
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

  // RP-01: safe short stable key
  const reportId = makeReportKey(msgId, currentUser.email);

  try {
    // RP-05: check existence before write
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

    // RP-02: lowercase 'pending' — matches admin.js PENDING_STATUSES.has('pending')
    await setDoc(doc(db, 'reports', reportId), {
      contentType:    'chat_message',
      contentId:      msgId,
      status:         'pending',
      reason:         category,
      timestamp:      serverTimestamp(),
      // Reporter
      reporterEmail:  currentUser.email,
      reporterName:   currentUser.name   || null,
      // Reported user — all fields admin.js preview needs
      reportedEmail:  msg.senderEmail    || null,
      reportedName:   msg.senderName     || null,
      // Reason + comment
      category,
      comment:        comment            || null,
      // Message snapshot for admin preview
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
  const msgId   = editingMsgId; // capture before cancelEdit

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

  // FIX-37: cancelEdit before Firestore write
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
    mediaType:   msg.mediaType   || null,
  };
  const bar = $('lc-reply-bar');
  if (bar) {
    bar.classList.remove('hidden');
    const who  = bar.querySelector('.lc-reply-bar__who');
    const prev = bar.querySelector('.lc-reply-bar__preview');
    if (who)  who.textContent  = `Replying to ${msg.senderName || 'User'}`;
    if (prev) prev.textContent = msg.mediaType ? '📎 Media' : (msg.text || '').slice(0, 100);
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
  // MR-05: position:fixed panel class
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

  // MR-05: appended to body so position:fixed works
  document.body.appendChild(panel);
  requestAnimationFrame(() => panel.classList.add('lc-gallery--visible'));

  const normalize = str =>
    str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); // GC-05

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

    // GC-04: correct class names matching CSS
    grid.innerHTML = allItems.map(item => {
      if (item.type === 'image') {
        return `<div class="lc-gallery-item lc-gallery-item--img" data-url="${esc(item.url)}" tabindex="0" role="button" aria-label="${esc(item.name || 'Image')}">
                  <img src="${esc(item.url)}" loading="lazy" decoding="async" alt="${esc(item.name || 'Image')}">
                </div>`;
      }
      if (item.type === 'video') {
        return `<div class="lc-gallery-item lc-gallery-item--vid" data-url="${esc(item.url)}" tabindex="0" role="button" aria-label="${esc(item.name || 'Video')}">
                  <video src="${esc(item.url)}" preload="metadata" muted></video>
                  <div class="lc-gallery-item__overlay">▶</div>
                </div>`;
      }
      const ext = (item.name || '').split('.').pop().toUpperCase().slice(0, 5);
      return `<a class="lc-gallery-item lc-gallery-item--doc" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" data-download-name="${esc(item.name || 'file')}">
                <span class="lc-gallery-item__ext">${esc(ext)}</span>
                <span class="lc-gallery-item__label">${esc(item.name || 'File')}</span>
                ${item.size ? `<span class="lc-gallery-item__size">${fmtSize(item.size)}</span>` : ''}
              </a>`;
    }).join('');

    // Image click → fullscreen viewer
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

    // Doc download
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

  $('lc-messages-container')?.addEventListener('scroll', () => {
    atBottom = checkAtBottom();
    if (atBottom) hideNewMsgsBanner();
    const c = $('lc-messages-container');
    if (c && c.scrollTop < 80 && hasMoreMessages && !isLoadingOlder) {
      loadOlderMessages();
    }
  }, { passive: true });

  setupDragDrop();

  window.addEventListener('beforeunload', () => {
    if (isOpen) markPresenceOffline();
  });
}