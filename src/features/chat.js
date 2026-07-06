import { db, auth } from '../config/firebase.js';
import { currentUser } from '../store/db.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { sanitize } from '../ui/templates.js';
import { uploadToCloudinary } from '../utils/storage.js';
import { onPageVisit } from '../ui/navigation.js';
import {
    collection, doc, setDoc, addDoc, query, orderBy, onSnapshot,
    serverTimestamp, getDocs, limit, where, deleteDoc, updateDoc,
    arrayUnion, arrayRemove, getDoc, writeBatch, runTransaction, increment
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// ─────────────────────────────────────────────
// MODULE-LEVEL STATE
// ─────────────────────────────────────────────
let chatSub              = null;
let rootChatSub          = null;
let recentChatsSub       = null;
let presenceSub          = null;   // real-time presence (online/last-seen) listener
let typingSub            = null;   // real-time typing indicator listener (private from presenceSub)
let activeRoomId         = null;
let activeRoomDetails    = null;
let cachedUsersHTML      = null;
let cachedUsersData      = null;
let cachedUsersAt        = 0;    // FIX: timestamp of last contacts fetch; cache expires after TTL
const USERS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let lastMessagesSnapshot = [];
let typingTimeout        = null;
let isCurrentlyTyping    = false;
let currentTypingLabel   = null;
let searchActive         = false;
let searchQueryText      = '';
let replyingTo           = null;   // { id, text, senderName, senderEmail, imageUrl, voiceUrl, fileUrl, fileName } | null
let editingMsgId         = null;   // EXT: id of the message currently being edited, or null
let pinnedMessages       = [];     // mutable array of msg ids — never reassigned, use .splice() / push / filter
let starredMessages      = new Set();
let mediaRecorder        = null;
let audioChunks          = [];
let recordingStartTime   = null;
let recordingTimer       = null;
let isRecording          = false;
let recordingCancelled   = false;  // FIX: use flag instead of clearing audioChunks before stop fires
let emojiPickerVisible   = false;
// FIX Bug 9: removed forwardingMsgId — was never read; openForwardModal takes msgId as a direct parameter.
let _totalUnread         = 0;   // FIX: track real total so _recomputeNavBadge doesn't parse DOM badges
let _pendingReadRooms    = new Set(); // FIX: rooms where markRoomRead fired but server timestamp not yet resolved
let _roomUnreadMap      = new Map(); // FIX BUG 5: per-room unread counts from last snapshot, used by markRoomRead
let _hbInterval          = null;   // heartbeat interval ref for cleanup
let _activeAudio         = null;   // FIX: was window._waAudio — keep audio state at module scope
let _cleanupDropdown     = null;   // FIX #5: module-scope instead of DOM property
let _lastTypingWriteMs   = 0;      // FIX #10: throttle typing writes to Firestore
// FIX BUG-STARRED: dedicated real-time listener for the current user's starred messages,
// so reactions/read-receipts on the messages snapshot no longer re-fetch starred data.
let starredSub           = null;
// FIX BUG-GLOBAL: persistent auth + page-visit listeners must be registered exactly once
// per module lifetime.  teardownChat resets conversation state but must NOT reset this flag
// because those listeners survive across login/logout cycles by design.
let _globalListenersSetup = false;
// FIX PORTAL-LISTENER: Separate flag for the body-level portal click handler.
// _globalListenersSetup is set to true BEFORE we reach the portal-listener block
// inside setupChat(), so gating on !_globalListenersSetup caused the portal
// handler to never be registered. This flag is used exclusively for that handler.
let _portalListenerSetup = false;
// FIX DUPLICATE-LISTENER: The body-level portal click handler is registered once (guarded
// by _portalListenerSetup) and routes through this reference so it always calls the
// handleMessageAction from the CURRENT setupChat() closure, even after re-login.
let _globalPortalClickHandler = null;

// ── MODULE-LEVEL CONSTANTS ────────────────────────────────────────────────────
// MAX_UPLOAD_BYTES must be at module scope so it is accessible inside event
// handlers that are registered before setupChat()'s local scope is reached.
// (Using const inside setupChat() creates a temporal dead zone at the call sites
// inside handleMessageAction which are declared via async function expressions
// also inside setupChat() — JavaScript hoists the function declaration but NOT
// the const binding, so a reference at line 4683 would throw ReferenceError.)
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

// ── MULTI-ATTACHMENT COMPOSE QUEUE ──────────────────────────────────────────
// pendingAttachments holds files the user has selected but not yet sent.
// Each entry: { id, file, name, mime, size, type, previewUrl, uploadedUrl,
//               progress, error, compressing, uploadXhr }
// The compose tray renders from this array; clearComposeTray revokes blob URLs.
let pendingAttachments     = [];
let _attachIdCounter       = 0;

const TYPING_TTL_MS    = 6000;
const EMOJI_LIST       = ['😀','😂','😍','🥰','😎','🤔','😮','😢','😡','👍','❤️','🙏','🎉','🔥','✅','💯','🤣','😭','😊','🥺','🤩','😴','🤯','💀','👋','🤝','💪','👀','🫡','🫶'];
const REACTION_EMOJIS  = ['👍','❤️','😂','😮','😢','🙏'];
// REACTION_EMOJIS_SET removed — use REACTION_EMOJIS directly (they were the same reference)

// ─────────────────────────────────────────────
// STORAGE HELPERS  (FIX: properly await upload completion)
// EXT: uploads now retry with exponential backoff on transient failure,
//      and images are compressed client-side before upload.
//
// NOTE: this project's Firebase plan (Spark/free tier) doesn't support
// Cloud Storage at all — it requires the paid Blaze plan. All chat
// attachments (images, video, voice notes, files) go through Cloudinary
// instead, the same service Lost & Found photos already use, via
// uploadToCloudinary() in utils/storage.js.
// ─────────────────────────────────────────────

const MAX_UPLOAD_RETRIES  = 2;
const RETRY_BASE_DELAY_MS = 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// EXT: shared upload helper with retry/backoff + progress callback.
// onProgress(pct, attempt) is called as the upload advances; attempt > 0 means
// this is a retry following a transient failure. Retries are skipped for
// errors that are clearly not transient (e.g. a misconfigured Cloudinary
// preset) so a permanent failure surfaces immediately instead of stalling
// for several seconds first.
async function uploadBytesWithRetry(file, folder, onProgress, fileName) {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            return await uploadToCloudinary(file, folder, {
                fileName,
                onProgress: (pct) => onProgress?.(pct, attempt),
            });
        } catch (err) {
            // BUG FIX: was incrementing attempt BEFORE the > check, so retries were
            // capped at MAX_UPLOAD_RETRIES-1. Increment after the check so the full
            // MAX_UPLOAD_RETRIES attempts are actually performed.
            if (attempt >= MAX_UPLOAD_RETRIES) throw err;
            attempt++;
            onProgress?.(0, attempt);
            await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        }
    }
}

// EXT: downscale + re-encode images before upload (skips small files and GIFs
// so animations aren't flattened). Falls back to the original file on any error.
async function compressImageFile(file, maxDim = 1600, quality = 0.82) {
    if (!file?.type?.startsWith('image/') || file.type === 'image/gif') return file;
    if (file.size < 350 * 1024) return file; // already small — not worth recompressing
    try {
        const objUrl = URL.createObjectURL(file);
        const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload  = () => resolve(el);
            el.onerror = reject;
            el.src     = objUrl;
        });
        URL.revokeObjectURL(objUrl);

        let { naturalWidth: w, naturalHeight: h } = img;
        const scale = Math.min(maxDim / w, maxDim / h, 1);
        if (scale >= 1) return file; // already within bounds

        w = Math.round(w * scale);
        h = Math.round(h * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);

        const outType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        const blob = await new Promise(res => canvas.toBlob(res, outType, quality));
        if (!blob || blob.size >= file.size) return file;

        const ext = outType === 'image/png' ? 'png' : 'jpg';
        const baseName = (file.name || 'image').replace(/\.[^./\\]+$/, '');
        return new File([blob], `${baseName}.${ext}`, { type: outType });
    } catch (err) {
        console.warn('[Chat] Image compression failed, using original:', err);
        return file; // never block sending on a compression failure
    }
}

// NOTE: uploadFile is currently unused internally — sendMediaFile calls uploadBytesWithRetry
// directly. Kept in case an external module imports it in future.
async function uploadFile(file, folder = 'chats') {
    return uploadBytesWithRetry(file, folder, null, file.name);
}

async function uploadAudioBlob(blob, mimeType = '') {
    // FIX: derive file extension from actual mime type so Cloudinary
    // stores the file correctly (webm on Chrome, mp4 on Safari, etc.)
    const extMap = {
        'audio/webm': 'webm', 'audio/ogg': 'ogg',
        'audio/mp4': 'mp4',   'audio/mpeg': 'mp3',
    };
    const base = (mimeType || blob.type || '').split(';')[0].trim();
    const ext  = extMap[base] || 'webm';
    return uploadBytesWithRetry(blob, 'chats', null, `voice_${Date.now()}.${ext}`);
}

// ─────────────────────────────────────────────
// HIDDEN INPUT FACTORY
// FIX: each input is created once per session and reused; teardownChat removes them
// ─────────────────────────────────────────────
function getAttachInput(accept = 'image/*', id = 'chat-attach-input') {
    let el = document.getElementById(id);
    if (!el) {
        el = document.createElement('input');
        el.type     = 'file';
        el.accept   = accept;
        el.id       = id;
        el.multiple = true; // FIXED: allow selecting multiple files at once
        el.className = 'hidden';
        el.setAttribute('data-chat-input', 'true');
        document.body.appendChild(el);
    }
    return el;
}

// ─────────────────────────────────────────────
// TOAST SYSTEM
// ─────────────────────────────────────────────
function ensureToastHost() {
    let host = document.getElementById('chat-toast-host');
    if (!host) {
        host = document.createElement('div');
        host.id        = 'chat-toast-host';
        host.className = 'fixed bottom-6 right-6 z-[200] flex flex-col gap-2 items-end pointer-events-none';
        document.body.appendChild(host);
    }
    return host;
}

function showToast(message, type = 'info') {
    const host = ensureToastHost();
    const palettes = {
        info:    { bg: 'bg-white border-gray-200', dot: 'bg-indigo-500'  },
        success: { bg: 'bg-white border-green-200', dot: 'bg-green-500' },
        error:   { bg: 'bg-white border-red-200',   dot: 'bg-red-500'   },
        warning: { bg: 'bg-white border-amber-200',  dot: 'bg-amber-500' }
    };
    const p  = palettes[type] || palettes.info;
    const el = document.createElement('div');
    el.className = `pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl
                    border shadow-lg text-sm text-gray-800 font-medium
                    translate-y-3 opacity-0 transition-all duration-300 max-w-xs ${p.bg}`;
    el.innerHTML = `<span class="w-2 h-2 rounded-full flex-shrink-0 ${p.dot}"></span>
                    <span class="leading-snug">${sanitize(message)}</span>`;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.remove('translate-y-3', 'opacity-0'));
    setTimeout(() => { el.classList.add('opacity-0'); setTimeout(() => el.remove(), 300); }, 3200);
}

// ─────────────────────────────────────────────
// CONFIRM DIALOG
// FIX: keydown listener now always removed on backdrop-click path
// ─────────────────────────────────────────────
function showConfirm({ title, body, confirmLabel = 'Confirm', tone = 'default' }) {
    return new Promise(resolve => {
        document.getElementById('chat-confirm-modal')?.remove();
        const accent = tone === 'danger'
            ? 'bg-red-500 hover:bg-red-600'
            : 'bg-indigo-600 hover:bg-indigo-700';
        const modal = document.createElement('div');
        modal.id        = 'chat-confirm-modal';
        modal.className = 'fixed inset-0 z-[150] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4';
        modal.innerHTML = `
            <div class="bg-white border border-gray-200 rounded-2xl w-full max-w-sm shadow-2xl
                        overflow-hidden scale-95 opacity-0 transition-all duration-200" id="chat-confirm-card">
                <div class="p-5 border-b border-gray-100">
                    <h3 class="text-gray-900 font-bold text-base mb-1">${sanitize(title)}</h3>
                    <p class="text-gray-500 text-sm leading-relaxed">${sanitize(body)}</p>
                </div>
                <div class="px-5 py-4 flex justify-end gap-3 bg-gray-50">
                    <button id="chat-confirm-cancel"
                            class="px-5 py-2 rounded-lg text-gray-600 font-semibold hover:bg-gray-200 transition text-sm border border-gray-200">
                        Cancel
                    </button>
                    <button id="chat-confirm-ok"
                            class="px-5 py-2 rounded-lg text-white font-bold transition text-sm ${accent}">
                        ${sanitize(confirmLabel)}
                    </button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        requestAnimationFrame(() =>
            document.getElementById('chat-confirm-card')?.classList.remove('scale-95', 'opacity-0'));

        // FIX: always remove keydown listener regardless of how modal is closed
        const onKey = e => {
            if (e.key === 'Escape') { close(false); }
            if (e.key === 'Enter')  { close(true);  }
        };
        document.addEventListener('keydown', onKey);

        const close = r => {
            document.removeEventListener('keydown', onKey); // FIX: always cleaned up
            modal.remove();
            resolve(r);
        };
        modal.addEventListener('click', e => { if (e.target === modal) close(false); });
        document.getElementById('chat-confirm-cancel').addEventListener('click', () => close(false));
        document.getElementById('chat-confirm-ok').addEventListener('click', () => close(true));
    });
}

// ─────────────────────────────────────────────
// GENERAL HELPERS
// ─────────────────────────────────────────────
const getPrivateRoomId = (a, b) => [a, b].sort().join('_');

// FIX AUTH-GUARD: shared auth check for every action handler.
// Returns true if the current user is authenticated, shows an error toast and
// returns false otherwise. Callers should return immediately on false.
function requireAuth() {
    if (currentUser?.email) return true;
    showToast('You must be signed in to do that.', 'error');
    return false;
}

function unsubscribeRoomListeners() {
    chatSub?.();       chatSub     = null;
    rootChatSub?.();   rootChatSub = null;
    presenceSub?.();   presenceSub = null;
    typingSub?.();     typingSub   = null;
    // FIX BUG-STARRED: always tear down the starred listener when leaving a room so
    // it doesn't keep writing to a stale starredMessages Set for the old room.
    starredSub?.();    starredSub  = null;
    clearTypingState();
}

function unsubscribeRecent() {
    recentChatsSub?.(); recentChatsSub = null;
}

function clearTypingState() {
    if (typingTimeout) { clearTimeout(typingTimeout); typingTimeout = null; }
    isCurrentlyTyping  = false;
    currentTypingLabel = null; // unused — reserved for future multi-user typing display
}

function writeTypingState(roomId, typing) {
    // BUG FIX: currentUser may be null during teardown / beforeunload after logout.
    if (!roomId || !currentUser?.email) return;
    setDoc(doc(db, `chats/${roomId}/typing`, currentUser.email), {
        typing, name: currentUser.name, updatedAt: serverTimestamp()
    }).catch(() => {});
}

// FIX #10: Throttle typing=true writes to Firestore (max 1 per 2 s).
// typing=false always fires immediately so the indicator clears promptly.
const TYPING_WRITE_THROTTLE_MS = 2000;
function writeTypingStateThrottled(roomId, typing) {
    if (!typing) {
        _lastTypingWriteMs = 0;
        writeTypingState(roomId, false);
        return;
    }
    const now = Date.now();
    if (now - _lastTypingWriteMs < TYPING_WRITE_THROTTLE_MS) return;
    _lastTypingWriteMs = now;
    writeTypingState(roomId, true);
}

export function teardownChat() {
    unsubscribeRoomListeners();
    unsubscribeRecent();
    stopRecording(true);
    typingSub?.();     typingSub   = null;
    if (_hbInterval) { clearInterval(_hbInterval); _hbInterval = null; }
    // FIX BUG-DROPDOWN: remove the document-level click listener that closes the
    // header dropdown.  Previously teardownChat only nulled the reference without
    // removing the listener, leaving a dangling handler on document after logout.
    if (_cleanupDropdown) {
        document.removeEventListener('click', _cleanupDropdown);
        _cleanupDropdown = null;
    }
    // Stop any playing voice note audio on teardown
    if (_activeAudio && !_activeAudio.paused) { _activeAudio.pause(); }
    _activeAudio      = null;
    activeRoomId      = null;
    activeRoomDetails = null;
    replyingTo        = null;
    editingMsgId      = null;
    // Invalidate contacts cache so a fresh mount picks up new users
    cachedUsersHTML   = null;
    cachedUsersData   = null;
    cachedUsersAt     = 0;
    // FIX: reset unread counters and pending-read tracking so stale state from
    // a previous authenticated user cannot bleed into the next session after
    // sign-out / re-authentication or a fast user switch.
    _totalUnread      = 0;
    _pendingReadRooms.clear();
    _roomUnreadMap.clear();
    // FIX: clear message snapshot so previous user's messages never appear
    lastMessagesSnapshot.splice(0, lastMessagesSnapshot.length);
    // FIX: clear seenBy tracking set so previous user's read receipts cannot
    // bleed into the next session — _seenBySubmitted is module-level but was
    // never reset on logout, meaning re-login saw all old keys as "submitted"
    // and silently skipped marking new messages as seen.
    _seenBySubmitted.clear();
    // FIX: reset nav badge immediately so previous user's unread dot disappears
    const navDot = document.getElementById('chat-nav-indicator');
    if (navDot) { navDot.classList.add('hidden'); navDot.textContent = ''; }
    // Remove injected hidden file inputs on teardown to prevent accumulation
    document.querySelectorAll('[data-chat-input="true"]').forEach(el => el.remove());
    // Clear compose tray: revoke all blob preview URLs to free memory
    pendingAttachments.forEach(item => {
        if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
    });
    pendingAttachments = [];
    document.getElementById('wa-compose-tray')?.remove();

    // Clear any open per-attachment action strips (touch UX cleanup)
    document.querySelectorAll('.wa-att-item.wa-att-open').forEach(el => el.classList.remove('wa-att-open'));

    delete window.startDirectChat;
    const chatContainer = document.getElementById('chat-messages');
    if (chatContainer) delete chatContainer.dataset.chatWired;

    // MOBILE: reset to list view and remove injected back button
    _mobileShowList();
    document.getElementById('chat-mobile-back-btn')?.remove();
    // Clear any dangling conversation history state so back button
    // doesn't re-enter a closed conversation.
    if (history.state?.chatView === 'conversation') {
        history.replaceState(null, '');
    }
}

function formatRelativeTime(ts) {
    if (!ts?.toDate) return '';
    const date      = ts.toDate();
    const now       = new Date();
    const sameDay   = (a, b) =>
        a.getFullYear() === b.getFullYear() &&
        a.getMonth()    === b.getMonth()    &&
        a.getDate()     === b.getDate();
    if (sameDay(date, now)) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(date, yesterday)) return 'Yesterday';
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const ONLINE_THRESHOLD_MS = 90 * 1000;
function isUserOnline(ts) {
    if (!ts?.toDate) return false;
    return (Date.now() - ts.toDate().getTime()) < ONLINE_THRESHOLD_MS;
}

function formatLastSeen(ts) {
    // BUG FIX: return a readable fallback instead of blank when timestamp is missing.
    if (!ts?.toDate) return 'last seen a while ago';
    const diffMs = Date.now() - ts.toDate().getTime();
    const mins   = Math.floor(diffMs / 60000);
    if (mins < 1)  return 'last seen recently';
    if (mins < 60) return `last seen ${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `last seen ${hrs}h ago`;
    return `last seen ${Math.floor(hrs / 24)}d ago`;
}

function formatDuration(secs) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function getFileIcon(mimeType = '') {
    if (mimeType.startsWith('video/'))                          return '🎥';
    if (mimeType.startsWith('audio/'))                          return '🎵';
    if (mimeType.includes('pdf'))                               return '📄';
    if (mimeType.includes('zip') || mimeType.includes('rar'))  return '🗜️';
    if (mimeType.includes('word') || mimeType.includes('doc')) return '📝';
    if (mimeType.includes('sheet') || mimeType.includes('xls'))return '📊';
    return '📎';
}

function resetChatPanel(chatHeader, chatContainer, input, sendBtn, attachBtn) {
    unsubscribeRoomListeners();
    activeRoomId         = null;
    activeRoomDetails    = null;
    lastMessagesSnapshot.splice(0, lastMessagesSnapshot.length);
    searchActive         = false;
    searchQueryText      = '';
    replyingTo           = null;
    document.getElementById('chat-search-bar')?.remove();
    document.getElementById('wa-reply-preview')?.remove();
    document.getElementById('wa-pinned-bar')?.remove();

    chatHeader.innerHTML = `
        <div class="ch-inner">
            <div class="ch-avatar-wrap">
                <div class="ch-avatar-placeholder">
                    <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                    </svg>
                </div>
            </div>
            <span class="ch-select-label">Select a conversation</span>
        </div>`;

    chatContainer.innerHTML = `
        <div class="wa-welcome">
            <div class="wa-welcome-icon">
                <svg class="w-12 h-12" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                </svg>
            </div>
            <h2 class="wa-welcome-title">Community Messages</h2>
            <p class="wa-welcome-sub">Send and receive messages, voice notes, files, and more.</p>
            <div class="wa-welcome-enc">
                <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd"/>
                </svg>
                End-to-end encrypted
            </div>
        </div>`;

    input.disabled    = true;
    input.placeholder = 'Select a chat to start messaging';
    sendBtn.disabled  = true;
    if (attachBtn) attachBtn.disabled = true;

    // MOBILE: return to list view whenever the chat panel is reset
    // (e.g. leave group, delete chat). _mobileShowList is a no-op on desktop.
    _mobileShowList();
    document.getElementById('chat-mobile-back-btn')?.remove();
}

// ─────────────────────────────────────────────
// AVATAR HELPERS
// ─────────────────────────────────────────────
function getAvatarHue(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const hues = [197, 158, 271, 330, 36, 140, 14];
    return hues[Math.abs(hash) % hues.length];
}

function avatarGradient(name, type) {
    if (type === 'group') return 'background: linear-gradient(135deg, #6b4fbb 0%, #a855f7 100%)';
    const hue = getAvatarHue(name || '');
    return `background: linear-gradient(135deg, hsl(${hue},60%,35%) 0%, hsl(${hue},70%,55%) 100%)`;
}

function avatarEl(name, type, online, size = 40) {
    const initial = (name || '?').charAt(0).toUpperCase();
    const style   = avatarGradient(name, type);
    const dot     = online
        ? `<span style="position:absolute;bottom:-1px;right:-1px;width:11px;height:11px;
               border-radius:50%;background:#10b981;border:2px solid #fff"></span>`
        : '';
    return `
    <div style="position:relative;width:${size}px;height:${size}px;flex-shrink:0">
        <div style="${style};width:${size}px;height:${size}px;border-radius:50%;
             display:flex;align-items:center;justify-content:center;
             font-size:${Math.round(size * 0.38)}px;font-weight:700;color:#fff;
             letter-spacing:-0.5px;overflow:hidden">${sanitize(initial)}</div>
        ${dot}
    </div>`;
}

// ─────────────────────────────────────────────
// SIDEBAR ITEM
// ─────────────────────────────────────────────
function createSidebarItemHTML({ id, email, name, type, lastMessage, time, unread = 0, online = false, isActive = false }) {
    const safe      = sanitize(name || email?.split('@')[0] || 'Unknown');
    const dataEmail = type === 'group' ? id : email;
    const isBlocked = lastMessage === '🔒 Chat Blocked';
    return `
    <div class="wa-sidebar-item ${isActive ? 'wa-sidebar-item--active' : ''}"
         data-email="${dataEmail}" data-name="${safe}" data-type="${type}">
        <div class="wa-sidebar-avatar">${avatarEl(name, type, online, 46)}</div>
        <div class="wa-sidebar-body">
            <div class="wa-sidebar-top">
                <span class="wa-sidebar-name ${unread ? 'wa-sidebar-name--unread' : ''}">${safe}</span>
                <span class="wa-sidebar-time ${unread ? 'wa-sidebar-time--unread' : ''}">${time}</span>
            </div>
            <div class="wa-sidebar-bottom">
                <span class="wa-sidebar-preview ${isBlocked ? 'wa-blocked' : (unread ? 'wa-sidebar-preview--unread' : '')}">
                    ${sanitize(lastMessage)}
                </span>
                ${unread ? `<span class="wa-badge" data-count="${unread}">${unread > 99 ? '99+' : unread}</span>` : ''}
            </div>
        </div>
    </div>`;
}

// ─────────────────────────────────────────────
// MESSAGE HTML BUILDERS
// ─────────────────────────────────────────────
function buildReactionsHTML(reactions, msgId) {
    if (!reactions) return '';
    const entries = Object.entries(reactions).filter(([, u]) => u?.length > 0);
    if (!entries.length) return '';
    const pills = entries.map(([emoji, users]) => {
        // BUG FIX: users may be undefined/null from a partially-written Firestore doc.
        const mine = Array.isArray(users) && users.includes(currentUser.email);
        return `<button class="wa-reaction-pill ${mine ? 'wa-reaction-pill--mine' : ''}"
                        data-msg-id="${msgId}" data-emoji="${emoji}">
                    ${emoji} <span>${users.length}</span>
                </button>`;
    }).join('');
    return `<div class="wa-reactions">${pills}</div>`;
}

function highlightMatch(safeText, queryText) {
    if (!queryText?.trim()) return safeText;
    try {
        const escaped = queryText.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return safeText.replace(new RegExp(`(${escaped})`, 'ig'), '<mark class="wa-highlight">$1</mark>');
    } catch { return safeText; }
}

function msgTime(ts) {
    if (!ts?.toDate) return '';
    return ts.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function buildReadTicksHTML(msg, seenBy = []) {
    const isRead = seenBy.some(e => e !== currentUser.email);
    if (isRead) {
        return `<svg class="wa-ticks wa-ticks--read" viewBox="0 0 18 11" fill="none">
            <path d="M1 5.5L5 9.5L13 1.5" stroke="#4f46e5" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M5 5.5L9 9.5L17 1.5" stroke="#4f46e5" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
    }
    return `<svg class="wa-ticks wa-ticks--sent" viewBox="0 0 18 11" fill="none">
        <path d="M1 5.5L5 9.5L13 1.5" stroke="rgba(255,255,255,.6)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M5 5.5L9 9.5L17 1.5" stroke="rgba(255,255,255,.6)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
}

function buildReplyPreviewHTML(replyData) {
    if (!replyData) return '';
    const isMe  = replyData.senderEmail === currentUser.email;
    const label = isMe ? 'You' : sanitize(replyData.senderName || 'Someone');
    const _attCount = replyData.attachments?.length || 0;
    const _attFirst = _attCount ? replyData.attachments[0] : null;
    const text  = _attFirst?.type === 'image' ? `📷 Photo${_attCount > 1 ? ` ×${_attCount}` : ''}`
                : _attFirst?.type === 'video' ? '🎥 Video'
                : _attFirst?.type === 'audio' ? '🎤 Voice note'
                : _attFirst            ? `📎 ${sanitize(_attFirst.name || 'File')}`
                : replyData.imageUrl  ? '📷 Photo'
                : replyData.voiceUrl  ? '🎤 Voice note'
                : replyData.fileUrl   ? `📎 ${sanitize(replyData.fileName || 'File')}`
                : sanitize(replyData.text || '');
    return `<div class="wa-reply-bubble" data-reply-id="${replyData.id}">
        <div class="wa-reply-line"></div>
        <div class="wa-reply-content">
            <span class="wa-reply-name">${label}</span>
            <span class="wa-reply-text">${text}</span>
        </div>
    </div>`;
}

function buildVoiceNoteHTML(msg, isMe) {
    const dur = msg.voiceDuration ? formatDuration(msg.voiceDuration) : '0:00';
    let seed  = 0;
    for (let i = 0; i < (msg.id || '').length; i++) seed = (seed * 31 + msg.id.charCodeAt(i)) >>> 0;
    const pseudoRand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 0) / 4294967296; };
    const _safeVUrl = safeUrl(msg.voiceUrl || '') || '';
    return `<div class="wa-voice-note" data-voice-url="${_safeVUrl}">
        <button class="wa-voice-play-btn" data-voice-url="${_safeVUrl}">
            <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24" class="wa-play-icon">
                <path d="M8 5v14l11-7z"/>
            </svg>
        </button>
        <div class="wa-voice-waveform">
            ${Array.from({length: 20}, (_, i) => {
                const h = 4 + Math.sin(i * 0.9) * 8 + pseudoRand() * 6;
                return `<span class="wa-wave-bar" style="height:${Math.round(h)}px"></span>`;
            }).join('')}
        </div>
        <span class="wa-voice-duration">${dur}</span>
    </div>`;
}

function buildFileHTML(msg) {
    const icon = getFileIcon(msg.fileMime || '');
    const name = sanitize(msg.fileName || 'File');
    const size = msg.fileSize ? `${(msg.fileSize / 1024).toFixed(1)} KB` : '';
    // FIX: validate fileUrl through safeUrl() before inserting into href — same
    // protection applied to imageUrl/voiceUrl everywhere else in the file.
    const _safeFile = safeUrl(msg.fileUrl || '') || '#';
    return `<a href="${_safeFile}" target="_blank" rel="noopener noreferrer" class="wa-file-attachment">
        <span class="wa-file-icon">${icon}</span>
        <div class="wa-file-info">
            <span class="wa-file-name">${name}</span>
            ${size ? `<span class="wa-file-size">${size}</span>` : ''}
        </div>
        <svg class="wa-file-dl" width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
        </svg>
    </a>`;
}

// ─────────────────────────────────────────────
// MULTI-ATTACHMENT HTML BUILDERS
// Each attachment is rendered individually in a WhatsApp-style block.
// Supported types: image, video, audio, document.
// Backwards compat: legacy single-field messages still use the old builders.
// ─────────────────────────────────────────────

// Per-attachment action menu button — rendered over every attachment cell.
// data-msg-id and data-att-idx let the handler look up the exact attachment
// from lastMessagesSnapshot without any ambiguity.
function _buildAttMenuBtn(msgId, idx, isOwner) {
    // Owners get: Download · Reply · Forward · Replace · Delete
    // Others get: Download · Reply · Forward
    const ownerItems = isOwner ? `
        <button class="wa-att-menu-item att-replace-btn" data-msg-id="${msgId}" data-att-idx="${idx}">
            <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
            Replace
        </button>
        <button class="wa-att-menu-item att-delete-btn" data-msg-id="${msgId}" data-att-idx="${idx}">
            <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            Delete
        </button>` : '';
    return `
    <div class="wa-att-actions" data-msg-id="${msgId}" data-att-idx="${idx}">
        <button class="wa-att-menu-item att-download-btn" data-msg-id="${msgId}" data-att-idx="${idx}">
            <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            Download
        </button>
        <button class="wa-att-menu-item att-reply-btn" data-msg-id="${msgId}" data-att-idx="${idx}">
            <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/></svg>
            Reply
        </button>
        <button class="wa-att-menu-item att-forward-btn" data-msg-id="${msgId}" data-att-idx="${idx}">
            <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 9l3 3-3 3m-4 0a9 9 0 110-6"/></svg>
            Forward
        </button>
        ${ownerItems}
    </div>`;
}

// Resolve a single attachment object from the snapshot by msgId + attIdx.
// Returns null if the message or attachment index is not found.
function _resolveAttachment(msgId, attIdx) {
    const msg = lastMessagesSnapshot.find(m => m.id === msgId);
    if (!msg?.attachments) return null;
    const idx = parseInt(attIdx, 10);
    if (isNaN(idx) || idx < 0 || idx >= msg.attachments.length) return null;
    return { msg, att: msg.attachments[idx], idx };
}

function buildSingleAttachmentHTML(att, msgId, idx, isOwner = false) {
    const _url = safeUrl(att.url || '') || '';
    if (!_url) return '';

    // Every attachment gets the same wrapper that carries identity data and
    // reveals the per-attachment action strip on hover/focus.
    const wrapOpen  = `<div class="wa-att-item" data-msg-id="${msgId}" data-att-idx="${idx}">`;
    const wrapClose = `${_buildAttMenuBtn(msgId, idx, isOwner)}</div>`;

    if (att.type === 'image') {
        return `${wrapOpen}<div class="wa-att-image-wrap">
            <img src="${_url}" class="wa-att-image msg-image"
                 data-full="${_url}" data-att-idx="${idx}" data-msg-id="${msgId}"
                 loading="lazy" alt="${sanitize(att.name || 'Image')}"
                 decoding="async">
        </div>${wrapClose}`;
    }

    if (att.type === 'video') {
        return `${wrapOpen}<div class="wa-att-video-wrap" data-msg-id="${msgId}" data-att-idx="${idx}">
            <video class="wa-att-video" src="${_url}"
                   controls preload="metadata"
                   aria-label="${sanitize(att.name || 'Video')}"></video>
        </div>${wrapClose}`;
    }

    if (att.type === 'audio') {
        const durSec = att.duration || 0;
        const durStr = durSec ? formatDuration(durSec) : '0:00';
        let seed = 0;
        for (let i = 0; i < (_url).length; i++) seed = (seed * 31 + _url.charCodeAt(i)) >>> 0;
        const pr = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 0) / 4294967296; };
        const bars = Array.from({length: 20}, (_, i) => {
            const h = 4 + Math.sin(i * 0.9) * 8 + pr() * 6;
            return `<span class="wa-wave-bar" style="height:${Math.round(h)}px"></span>`;
        }).join('');
        return `${wrapOpen}<div class="wa-voice-note wa-att-audio" data-voice-url="${_url}">
            <button class="wa-voice-play-btn" data-voice-url="${_url}">
                <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24" class="wa-play-icon">
                    <path d="M8 5v14l11-7z"/>
                </svg>
            </button>
            <div class="wa-voice-waveform">${bars}</div>
            <span class="wa-voice-duration">${durStr}</span>
        </div>${wrapClose}`;
    }

    // Document / raw file
    const icon = getFileIcon(att.mime || '');
    const name = sanitize(att.name || 'File');
    const size = att.size ? `${(att.size / 1024).toFixed(1)} KB` : '';
    return `${wrapOpen}<a href="${_url}" target="_blank" rel="noopener noreferrer" class="wa-file-attachment wa-att-doc">
        <span class="wa-file-icon">${icon}</span>
        <div class="wa-file-info">
            <span class="wa-file-name">${name}</span>
            ${size ? `<span class="wa-file-size">${size}</span>` : ''}
        </div>
        <svg class="wa-file-dl" width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
        </svg>
    </a>${wrapClose}`;
}

// Render a multi-attachment block with WhatsApp-style grid layout.
// 1 image → full width; 2 → side-by-side; 3-4 → 2-col grid with aspect ratio;
// 5+ → mosaic with a "+N more" overlay on the 4th cell.
// Non-image types (video, audio, doc) are always full-width rows.
//
// FIXED: use the attachment's ORIGINAL index in `attachments[]` throughout —
// previously used attachments.indexOf(a) which is O(n²) and breaks when two
// attachments share the same object reference. Now we build (value, realIdx)
// pairs upfront so every call to buildSingleAttachmentHTML receives the correct
// index into the canonical array stored in lastMessagesSnapshot.
function buildAttachmentsHTML(attachments, msgId, isOwner = false) {
    if (!attachments?.length) return '';

    // Build (att, originalIndex) pairs for images and non-images separately
    const imagePairs    = [];
    const nonImagePairs = [];
    attachments.forEach((a, realIdx) => {
        if (a.type === 'image') imagePairs.push({ a, realIdx });
        else                    nonImagePairs.push({ a, realIdx });
    });

    let html = '<div class="wa-att-block">';

    // ── Image grid ──
    if (imagePairs.length === 1) {
        const { a, realIdx } = imagePairs[0];
        html += `<div class="wa-att-grid wa-att-grid--1">
            ${buildSingleAttachmentHTML(a, msgId, realIdx, isOwner)}
        </div>`;
    } else if (imagePairs.length === 2) {
        html += `<div class="wa-att-grid wa-att-grid--2">
            ${imagePairs.map(({ a, realIdx }) => buildSingleAttachmentHTML(a, msgId, realIdx, isOwner)).join('')}
        </div>`;
    } else if (imagePairs.length >= 3) {
        const visiblePairs = imagePairs.slice(0, 4);
        const extra        = imagePairs.length - 4; // may be negative (3 images → extra=-1 → no overlay)
        html += `<div class="wa-att-grid wa-att-grid--4">`;
        visiblePairs.forEach(({ a, realIdx }, i) => {
            if (i === 3 && extra > 0) {
                // "+N more" overlay on the 4th tile. Still a full att-item so it
                // supports the action strip (download/forward/delete).
                const _url = safeUrl(a.url || '') || '';
                html += `<div class="wa-att-item" data-msg-id="${msgId}" data-att-idx="${realIdx}">
                    <div class="wa-att-image-wrap wa-att-more-wrap">
                        <img src="${_url}" class="wa-att-image" loading="lazy" alt=""
                             data-full="${_url}" data-msg-id="${msgId}" data-att-idx="${realIdx}">
                        <div class="wa-att-more-overlay" data-msg-id="${msgId}" data-att-start-idx="${realIdx}" style="cursor:pointer">+${extra + 1}</div>
                    </div>
                    ${_buildAttMenuBtn(msgId, realIdx, isOwner)}
                </div>`;
            } else {
                html += buildSingleAttachmentHTML(a, msgId, realIdx, isOwner);
            }
        });
        html += '</div>';
    }

    // ── Non-image rows (video, audio, document) ──
    nonImagePairs.forEach(({ a, realIdx }) => {
        html += `<div class="wa-att-row">${buildSingleAttachmentHTML(a, msgId, realIdx, isOwner)}</div>`;
    });

    html += '</div>';
    return html;
}

const URL_REGEX = /https?:\/\/[^\s<>"]+/g;
function extractFirstUrl(text) {
    const m = text?.match(URL_REGEX);
    return m ? m[0] : null;
}

// FIX (Security): Sanitize URLs before inserting into href/src attributes.
// Rejects javascript:, data:, vbscript: and any other non-http(s) schemes.
function safeUrl(url) {
    if (typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) return '';
    return trimmed;
}

// FIX #14: CSS.escape polyfill for older WebViews
function cssEscape(str) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(str);
    // FIX: polyfill had double-escaped backslashes; corrected to single-escape each special char
    return str.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

function buildLinkPreviewHTML(url) {
    // FIX (Security): reject non-http(s) URLs before rendering preview
    const safe = safeUrl(url);
    if (!safe) return '';
    let hostname = safe;
    try { hostname = new URL(safe).hostname; } catch { return ''; }
    return `<div class="wa-link-preview">
        <span class="wa-link-domain">${sanitize(hostname)}</span>
        <span class="wa-link-url">${sanitize(safe)}</span>
    </div>`;
}

function buildMessageHTML(msg, index, messages, chatType) {
    // System messages
    if (msg.senderEmail === 'system') {
        return `<div class="wa-system-msg"><span>${sanitize(msg.text)}</span></div>`;
    }

    // Hidden for current user (delete-for-me)
    if (msg.deletedFor?.includes(currentUser.email)) return '';

    const isMe      = msg.senderEmail === currentUser.email;
    // FIX: skip messages hidden for current user (deletedFor) when finding the
    // "older" neighbour — otherwise avatar/tail renders incorrectly when a message
    // between two same-sender messages is deleted-for-me.
    let older = null;
    for (let _oi = index + 1; _oi < messages.length; _oi++) {
        const _cand = messages[_oi];
        if (_cand.deletedFor?.includes(currentUser.email)) continue;
        if (_cand.senderEmail === 'system') continue; // system msgs don't break sender runs
        older = _cand;
        break;
    }
    const isConsec  = older && older.senderEmail === msg.senderEmail;
    const isPending = msg._pending === true;
    const isFailed  = msg._failed  === true;
    const time      = msgTime(msg.createdAt) || 'Just now';
    const isStarred = starredMessages.has(msg.id);
    const isPinned  = pinnedMessages.includes(msg.id);

    if (msg.isDeletedForEveryone) {
        return `
        <div class="wa-msg-row ${isMe ? 'wa-msg-row--me' : 'wa-msg-row--them'}" data-msg-id="${msg.id}">
            <div class="wa-bubble wa-bubble--deleted ${isMe ? 'wa-bubble--me' : 'wa-bubble--them'}">
                <span class="wa-deleted-text">
                    <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="display:inline;vertical-align:middle;margin-right:4px">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/>
                    </svg>
                    ${isMe ? 'You deleted this message' : 'This message was deleted'}
                </span>
                <span class="wa-msg-meta">${time}</span>
            </div>
        </div>`;
    }

    const senderLabel = (!isMe && chatType === 'group' && !isConsec)
        ? `<span class="wa-sender-label" style="color:hsl(${getAvatarHue(msg.senderName)},70%,45%)">${sanitize(msg.senderName)}</span>`
        : '';

    const replyHTML = msg.replyTo ? buildReplyPreviewHTML(msg.replyTo) : '';

    let contentHTML = '';
    // NEW: multi-attachment array takes priority over legacy single-field media
    const _isOwner = msg.senderEmail === currentUser?.email;
    if (msg.attachments?.length) {
        contentHTML = buildAttachmentsHTML(msg.attachments, msg.id, _isOwner);
    } else if (msg.voiceUrl) {
        contentHTML = buildVoiceNoteHTML(msg, isMe);
    } else if (msg.imageUrl) {
        // Fix #9 (High): validate imageUrl through safeUrl() before injecting into src/data-full
        const _safeImg = safeUrl(msg.imageUrl) || encodeURI(msg.imageUrl);
        contentHTML = `<div class="wa-att-block"><div class="wa-att-grid wa-att-grid--1"><div class="wa-att-image-wrap"><img src="${_safeImg}" class="wa-att-image msg-image" data-full="${_safeImg}" loading="lazy" alt="Image"></div></div></div>`;
    } else if (msg.fileUrl && msg.fileMime?.startsWith('video/')) {
        // FIXED: render video files as an inline <video> player, not a raw file link
        const _safeVid = safeUrl(msg.fileUrl) || '';
        contentHTML = `<div class="wa-att-block"><div class="wa-att-row"><video class="wa-att-video" src="${_safeVid}" controls preload="metadata"></video></div></div>`;
    } else if (msg.fileUrl) {
        contentHTML = `<div class="wa-att-block"><div class="wa-att-row">${buildFileHTML(msg)}</div></div>`;
    }

    let textHTML = '';
    if (msg.text) {
        const rawSafe    = sanitize(msg.text);
        const displayed  = searchActive ? highlightMatch(rawSafe, searchQueryText) : rawSafe;
        // FIX (Security): safeUrl() rejects non-http(s) schemes before inserting into href
        const linkedText = displayed.replace(URL_REGEX, u => {
            const safe = safeUrl(u);
            if (!safe) return sanitize(u);
            return `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="wa-link">${sanitize(u)}</a>`;
        });
        // Use caption styling when media is present, plain text otherwise
        const hasMedia = !!(msg.attachments?.length || msg.imageUrl || msg.voiceUrl || msg.fileUrl);
        const textClass = hasMedia ? 'wa-att-caption' : 'wa-msg-text';
        textHTML = `<span class="${textClass}">${linkedText}</span>`;
        const firstUrl = extractFirstUrl(msg.text);
        if (firstUrl && !msg.attachments?.length && !msg.imageUrl && !msg.fileUrl) {
            textHTML += buildLinkPreviewHTML(firstUrl);
        }
    }

    // Ticks
    let ticksHTML = '';
    if (isMe && !isPending && !isFailed) {
        ticksHTML = buildReadTicksHTML(msg, msg.seenBy || []);
    } else if (isPending) {
        ticksHTML = `<svg class="wa-tick-single" viewBox="0 0 16 11" fill="none">
            <path d="M1 5.5L5 9.5L13 1.5" stroke="rgba(255,255,255,.5)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
    } else if (isFailed) {
        ticksHTML = `<button class="wa-retry-btn msg-retry-btn" data-msg-id="${msg.id}">Tap to retry</button>`;
    }

    // Context menu — no video/call options
    // The dropdown div is a TEMPLATE that MessageMenuController will detach from
    // the DOM and re-attach to <body> as a fixed-position portal when opened.
    // data-msg-id on the wrapper lets MessageMenuController find the right template.
    const menuUID = `menu-${msg.id}`; // unique ID so aria-controls works
    const menuHTML = (msg.isDeletedForEveryone || isPending) ? '' : `
        <div class="wa-msg-menu" data-open="false" data-msg-id="${msg.id}">
            <button
                class="wa-msg-menu-btn msg-menu-btn"
                data-msg-id="${msg.id}"
                aria-label="Message options"
                aria-haspopup="menu"
                aria-expanded="false"
                aria-controls="${menuUID}"
                tabindex="0"
            >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
            </button>
            <div
                id="${menuUID}"
                class="wa-msg-dropdown msg-menu-dropdown"
                role="menu"
                aria-label="Message actions"
                data-msg-id="${msg.id}"
                data-me="${isMe}"
            >
                <div class="wa-emoji-bar" role="group" aria-label="Quick reactions">
                    ${REACTION_EMOJIS.map(e =>
                        `<button class="wa-emoji-pick msg-react-btn" role="menuitem" data-msg-id="${msg.id}" data-emoji="${e}" aria-label="React with ${e}" tabindex="-1">${e}</button>`
                    ).join('')}
                </div>
                <div class="wa-msg-dropdown__scroll">
                <button class="wa-drop-item msg-reply-btn" role="menuitem" tabindex="-1"
                    data-msg-id="${msg.id}"
                    data-sender="${sanitize(msg.senderName || '')}"
                    data-text="${sanitize(msg.text || '')}"
                    data-image="${safeUrl(msg.imageUrl || '') || ''}"
                    data-voice="${safeUrl(msg.voiceUrl || '') || ''}"
                    data-file="${safeUrl(msg.fileUrl || '') || ''}"
                    data-filename="${sanitize(msg.fileName || '')}">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/></svg>
                    Reply
                </button>
                ${isMe && msg.text && !msg.imageUrl && !msg.voiceUrl && !msg.fileUrl ? `
                <button class="wa-drop-item msg-edit-btn" role="menuitem" tabindex="-1" data-msg-id="${msg.id}" data-text="${sanitize(msg.text || '')}">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    Edit
                </button>` : ''}
                ${isMe && (msg.imageUrl || (msg.fileUrl && !msg.voiceUrl)) ? `
                <button class="wa-drop-item msg-replace-media-btn" role="menuitem" tabindex="-1"
                    data-msg-id="${msg.id}"
                    data-has-image="${!!msg.imageUrl}"
                    data-file-mime="${sanitize(msg.fileMime || '')}">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
                    Replace media
                </button>` : ''}
                <button class="wa-drop-item msg-forward-btn" role="menuitem" tabindex="-1" data-msg-id="${msg.id}">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 9l3 3-3 3m-4 0a9 9 0 110-6"/></svg>
                    Forward
                </button>
                <button class="wa-drop-item msg-star-btn" role="menuitem" tabindex="-1" data-msg-id="${msg.id}" aria-pressed="${isStarred}">
                    <svg width="14" height="14" fill="${isStarred ? '#f59e0b' : 'none'}" stroke="${isStarred ? '#f59e0b' : 'currentColor'}" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>
                    ${isStarred ? 'Unstar' : 'Star'} message
                </button>
                ${isPinned
                    ? `<button class="wa-drop-item msg-unpin-btn" role="menuitem" tabindex="-1" data-msg-id="${msg.id}">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/><line x1="3" y1="3" x2="21" y2="21" stroke-linecap="round" stroke-width="2"/></svg>
                    Unpin message
                </button>`
                    : `<button class="wa-drop-item msg-pin-btn" role="menuitem" tabindex="-1" data-msg-id="${msg.id}">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>
                    Pin message
                </button>`}
                ${msg.text ? `<button class="wa-drop-item msg-copy-btn" role="menuitem" tabindex="-1" data-msg-id="${msg.id}" data-text="${sanitize(msg.text || '')}">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                    Copy text
                </button>` : ''}
                ${(msg.imageUrl || msg.fileUrl || msg.voiceUrl || msg.attachments?.length) ? `<button class="wa-drop-item msg-download-btn" role="menuitem" tabindex="-1"
                    data-msg-id="${msg.id}"
                    data-url="${safeUrl(msg.imageUrl || msg.fileUrl || msg.voiceUrl || '') || ''}"
                    data-filename="${sanitize(msg.fileName || (msg.imageUrl ? 'image' : msg.voiceUrl ? 'voice-note' : 'file'))}"
                    data-has-attachments="${!!(msg.attachments?.length)}">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                    Download${msg.attachments?.length > 1 ? ` (${msg.attachments.length})` : ''}
                </button>` : ''}
                ${!isMe ? `<button class="wa-drop-item msg-report-btn" role="menuitem" tabindex="-1" data-msg-id="${msg.id}">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
                    Report
                </button>` : ''}
                <button class="wa-drop-item msg-delete-me-btn" role="menuitem" tabindex="-1" data-msg-id="${msg.id}">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                    Delete for me
                </button>
                ${(() => {
                    // FIX: Limit "Delete for everyone" to messages sent within the last 60 minutes.
                    // After that window, it's unfair to silently erase a message others may have
                    // already read and acted on. Still show the button (greyed out with a tooltip)
                    // outside the window so users understand why it's unavailable.
                    if (!isMe) return '';
                    const sentMs   = msg.createdAt?.toDate?.()?.getTime?.() || Date.now();
                    const agoMs    = Date.now() - sentMs;
                    const withinWindow = agoMs < 60 * 60 * 1000; // 60 minutes
                    return withinWindow
                        ? `<button class="wa-drop-item wa-drop-item--danger msg-delete-everyone-btn" role="menuitem" tabindex="-1" data-msg-id="${msg.id}">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                    Delete for everyone
                </button>`
                        : `<button class="wa-drop-item wa-drop-item--danger" role="menuitem" tabindex="-1" disabled title="Can only delete for everyone within 60 minutes of sending" style="opacity:.45;cursor:not-allowed">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                    Delete for everyone <span style="font-size:10px;opacity:.7">(expired)</span>
                </button>`;
                })()}
                </div>
            </div>
        </div>`;

    const bubbleState   = isPending ? 'wa-bubble--pending' : (isFailed ? 'wa-bubble--failed' : '');
    const starredBadge  = isStarred ? `<span class="wa-starred-badge" title="Starred">⭐</span>` : '';

    return `
    <div class="wa-msg-row ${isMe ? 'wa-msg-row--me' : 'wa-msg-row--them'}" data-message-row data-msg-id="${msg.id}">
        ${!isMe && !isConsec
            ? `<div class="wa-msg-avatar">${avatarEl(msg.senderName, chatType, false, 30)}</div>`
            : '<div class="wa-msg-avatar-gap"></div>'}
        <div class="wa-msg-wrap">
            ${menuHTML}
            <div class="wa-bubble ${isMe ? 'wa-bubble--me' : 'wa-bubble--them'} ${bubbleState} ${!isConsec ? (isMe ? 'wa-bubble--tail-me' : 'wa-bubble--tail-them') : ''}">
                ${senderLabel}
                ${replyHTML}
                ${contentHTML}
                ${textHTML}
                <span class="wa-msg-meta">
                    ${msg.edited ? '<span class="wa-edited-tag">edited</span>' : ''}
                    ${starredBadge}
                    ${time}
                    ${isMe ? ticksHTML : ''}
                </span>
            </div>
            ${buildReactionsHTML(msg.reactions, msg.id)}
        </div>
    </div>`;
}

function buildTypingIndicatorHTML(name) {
    return `
    <div id="chat-typing-indicator" class="wa-msg-row wa-msg-row--them wa-typing-row">
        <div class="wa-bubble wa-bubble--them wa-bubble--tail-them" style="padding:10px 14px">
            <span class="wa-typing-label">${sanitize(name)} is typing</span>
            <span class="wa-typing-dots"><span></span><span></span><span></span></span>
        </div>
    </div>`;
}

// ─────────────────────────────────────────────
// PINNED BAR
// ─────────────────────────────────────────────
function renderPinnedBar(chatHeader) {
    document.getElementById('wa-pinned-bar')?.remove();
    if (!pinnedMessages.length) return;
    const msg = lastMessagesSnapshot.find(m => m.id === pinnedMessages[0]);
    if (!msg) return;
    const bar = document.createElement('div');
    bar.id = 'wa-pinned-bar';
    bar.innerHTML = `
        <div class="wa-pin-icon">📌</div>
        <div class="wa-pin-content">
            <span class="wa-pin-label">Pinned message</span>
            <span class="wa-pin-text">${sanitize(msg.text || (msg.imageUrl ? '📷 Photo' : (msg.voiceUrl ? '🎤 Voice' : '📎 File')))}</span>
        </div>
        <button class="wa-pin-close" id="wa-pin-close-btn" aria-label="Dismiss pinned">
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>`;
    chatHeader.insertAdjacentElement('afterend', bar);
    document.getElementById('wa-pin-close-btn')?.addEventListener('click', () => {
        // FIX: mutate in place, never reassign
        pinnedMessages.splice(0, pinnedMessages.length);
        bar.remove();
    });
}

// ─────────────────────────────────────────────
// STYLES — light, modern UI matching screenshot design
// ─────────────────────────────────────────────
function ensureChatStyles() {
    if (document.getElementById('chat-module-styles')) return;
    const s = document.createElement('style');
    s.id = 'chat-module-styles';
    s.textContent = `
        /* ═══ Design tokens ═══ */
        :root {
            --wa-bg:            #f0f2f5;
            --wa-panel:         #ffffff;
            --wa-sidebar:       #ffffff;
            --wa-header:        #ffffff;
            --wa-input-bg:      #f0f2f5;
            --wa-border:        #e8eaed;
            --wa-bubble-me:     #4f46e5;
            --wa-bubble-them:   #ffffff;
            --wa-text:          #111827;
            --wa-sub:           #6b7280;
            --wa-green:         #10b981;
            --wa-green-dim:     rgba(16,185,129,.1);
            --wa-accent:        #4f46e5;
            --wa-accent-dim:    rgba(79,70,229,.08);
            --wa-link:          #4f46e5;
            --wa-danger:        #ef4444;
            --wa-warn:          #f59e0b;
            --wa-radius:        16px;
            --wa-shadow:        0 2px 12px rgba(0,0,0,.07);
            --wa-shadow-lg:     0 8px 32px rgba(0,0,0,.10);
        }

        /* ═══ Dark mode tokens ═══ */
        body.dark-mode {
            --wa-bg:            #060710;
            --wa-panel:         #0c0e1e;
            --wa-sidebar:       #0c0e1e;
            --wa-header:        #11142a;
            --wa-input-bg:      #181c3a;
            --wa-border:        rgba(255,255,255,0.10);
            --wa-bubble-me:     #5b4fd8;
            --wa-bubble-them:   #181c3a;
            --wa-text:          #f3f4fc;
            --wa-sub:           #9aa1c9;
            --wa-green:         #2bd99f;
            --wa-green-dim:     rgba(43,217,159,.15);
            --wa-accent:        #7c5cff;
            --wa-accent-dim:    rgba(124,92,255,.15);
            --wa-link:          #20d8e0;
            --wa-danger:        #ff5c7a;
            --wa-warn:          #ffb454;
            --wa-shadow:        0 2px 12px rgba(0,0,0,.45);
            --wa-shadow-lg:     0 8px 32px rgba(0,0,0,.65);
        }

        body.dark-mode #page-chat > div > div { border-color: rgba(255,255,255,.08) !important; }
        body.dark-mode .wa-search-bar input:focus { background: #1f2447; }
        body.dark-mode .wa-search-bar input { color: var(--wa-text); }
        body.dark-mode .wa-tab-btn:hover { background: rgba(255,255,255,.08); }
        body.dark-mode #new-group-name:focus { background: #181c3a; }
        body.dark-mode #new-group-name { color: var(--wa-text); background: var(--wa-input-bg); }
        body.dark-mode .group-member-row:hover { background: rgba(124,92,255,.12); }
        body.dark-mode .wa-sidebar-item:hover { background: rgba(124,92,255,.10) !important; }
        body.dark-mode .wa-bubble--them { box-shadow: none; color: var(--wa-text); }
        body.dark-mode .wa-bubble--me .wa-msg-text { color: #fff; }
        body.dark-mode .chat-module-toast .bg-white { background: var(--wa-panel) !important; border-color: var(--wa-border) !important; color: var(--wa-text) !important; }
        body.dark-mode #wa-pinned-bar { background: #1a1733; border-color: rgba(255,255,255,.08); }
        body.dark-mode .wa-pin-label { color: #a5b4fc; }
        body.dark-mode .wa-pin-text { color: #c7d2fe; }
        body.dark-mode .wa-pin-close { color: #a5b4fc; }
        body.dark-mode .wa-pin-close:hover { background: rgba(124,92,255,.2); }
        body.dark-mode .wa-system-msg span { background: rgba(255,255,255,.07); color: var(--wa-sub); border-color: var(--wa-border); }
        body.dark-mode .wa-reaction-pill { background: var(--wa-panel); border-color: var(--wa-border); color: var(--wa-text); }
        body.dark-mode .wa-msg-dropdown { background: #1a1d35; border-color: rgba(255,255,255,.1); box-shadow: 0 10px 48px rgba(0,0,0,.55), 0 2px 10px rgba(0,0,0,.35); }
        body.dark-mode .wa-msg-dropdown__scroll { scrollbar-color: rgba(255,255,255,.15) transparent; }
        body.dark-mode .wa-drop-item { color: var(--wa-text); }
        body.dark-mode .wa-drop-item:hover { background: rgba(255,255,255,.06); }
        body.dark-mode .wa-drop-item--focused { background: rgba(124,92,255,.18) !important; color: #a78bfa !important; }
        body.dark-mode .wa-drop-item--danger { border-color: rgba(255,255,255,.08); }
        body.dark-mode .wa-drop-item--danger:hover { background: rgba(255,92,122,.10) !important; }
        body.dark-mode .wa-emoji-bar { border-color: rgba(255,255,255,.08); }
        body.dark-mode .wa-file-attachment { background: rgba(255,255,255,.07); color: var(--wa-text); }
        body.dark-mode .wa-link-preview { background: rgba(255,255,255,.05); }
        body.dark-mode #chat-message-input { color: var(--wa-text) !important; }
        body.dark-mode .wa-input-wrap:focus-within { background: #1f2447; }
        body.dark-mode #send-msg-btn:disabled { background: #2a2d4a !important; }
        body.dark-mode .wa-header-dropdown { background: #1a1d35; border-color: rgba(255,255,255,.1); }
        body.dark-mode .wa-msg-menu-btn { background: #1a1d35; border-color: rgba(255,255,255,.1); }
        body.dark-mode .wa-msg-menu-btn[aria-expanded="true"] { background: rgba(124,92,255,.2); border-color: var(--wa-accent); color: var(--wa-accent); }
        body.dark-mode #wa-recording-bar { background: var(--wa-panel); border-color: var(--wa-border); }
        body.dark-mode .wa-rec-timer { color: var(--wa-text); }
        body.dark-mode #chat-search-bar { background: var(--wa-panel); border-color: var(--wa-border); }
        body.dark-mode #chat-search-input { background: var(--wa-input-bg); color: var(--wa-text); border-color: transparent; }
        body.dark-mode #chat-search-input:focus { background: #1f2447; border-color: var(--wa-accent); }
        body.dark-mode #wa-reply-preview { background: var(--wa-panel); border-color: var(--wa-border); }
        body.dark-mode .wa-rp-text { color: var(--wa-sub); }
        body.dark-mode #advanced-group-card,
        body.dark-mode #chat-members-card,
        body.dark-mode #wa-forward-card,
        body.dark-mode #wa-starred-card { background: var(--wa-panel); border-color: var(--wa-border); }
        body.dark-mode .group-modal-title,
        body.dark-mode .members-title,
        body.dark-mode .wa-fwd-title,
        body.dark-mode .wa-starred-title { color: var(--wa-text); }
        body.dark-mode .group-member-name,
        body.dark-mode .member-name,
        body.dark-mode .wa-starred-item-text { color: var(--wa-text); }
        body.dark-mode .group-member-email,
        body.dark-mode .member-admin-badge { color: var(--wa-sub); }
        body.dark-mode .member-item:hover { background: rgba(124,92,255,.1); }
        body.dark-mode #chat-members-modal,
        body.dark-mode #advanced-group-modal,
        body.dark-mode #wa-forward-modal,
        body.dark-mode #wa-starred-modal,
        body.dark-mode #join-group-modal,
        body.dark-mode #chat-confirm-modal { background: rgba(0,0,0,.65); }
        body.dark-mode #chat-confirm-card { background: var(--wa-panel) !important; border-color: var(--wa-border) !important; }
        body.dark-mode #chat-confirm-card h3 { color: var(--wa-text); }
        body.dark-mode #chat-confirm-card p { color: var(--wa-sub); }
        body.dark-mode #chat-confirm-cancel { background: rgba(255,255,255,.06); border-color: var(--wa-border); color: var(--wa-text); }
        body.dark-mode .wa-attach-item { color: var(--wa-text); }
        body.dark-mode .wa-attach-item:hover { background: rgba(255,255,255,.06); }
        body.dark-mode #wa-attach-menu { background: #1a1d35; border-color: rgba(255,255,255,.1); }
        body.dark-mode #wa-emoji-picker { background: #1a1d35; border-color: rgba(255,255,255,.1); }
        body.dark-mode .wa-ep-btn:hover { background: rgba(255,255,255,.08); }
        body.dark-mode .wa-reply-bubble { background: rgba(255,255,255,.1); }
        body.dark-mode .wa-bubble--them .wa-reply-bubble { background: rgba(255,255,255,.08); }
        body.dark-mode #chat-messages::-webkit-scrollbar-thumb { background: rgba(255,255,255,.15); }
        body.dark-mode .wa-highlight { background: #78350f; color: #fef3c7; }
        body.dark-mode .wa-welcome-icon { background: var(--wa-panel); border-color: var(--wa-border); }
        body.dark-mode .wa-welcome-title { color: var(--wa-text); }
        /* Replace-media item is styled identically to the Edit item — accent colour, upload icon */
        .msg-replace-media-btn { color: var(--wa-accent) !important; }
        body.dark-mode .msg-replace-media-btn { color: var(--wa-accent) !important; }
        body.dark-mode .wa-welcome-enc { color: var(--wa-sub); }
        body.dark-mode .ch-profile-area:hover { background: rgba(255,255,255,.06); }
        body.dark-mode .wa-nav-btn:hover { background: rgba(255,255,255,.08); }
        body.dark-mode #wa-attach-progress { background: var(--wa-panel); border-color: var(--wa-border); }
        /* ═══ Per-attachment item wrapper & action overlay ═══ */
        /* FIXED: display:contents broke grid layout — absolute-positioned children had
           no positioned ancestor, overlays rendered in wrong place, and grid cells
           collapsed. Use display:block everywhere; the grid item IS the wrapper. */
        .wa-att-item {
            position: relative;
            display: block;
            /* Clip children (img hover scale) without hiding the action overlay.
               The overlay is inside .wa-att-item so it IS clipped correctly. */
            overflow: hidden;
            border-radius: 10px;
        }
        /* Grid cells — fill their cell completely */
        .wa-att-grid > .wa-att-item {
            display: block;
            position: relative;
            overflow: hidden;
            border-radius: 0; /* grid clips via parent border-radius */
        }
        /* Ensure inner wrap fills the item */
        .wa-att-item > .wa-att-image-wrap,
        .wa-att-item > .wa-att-video-wrap {
            width: 100%; height: 100%;
            border-radius: 0;
        }

        /* Action strip — hidden by default, revealed on hover / focus-within */
        .wa-att-actions {
            position: absolute;
            bottom: 0; left: 0; right: 0;
            display: flex;
            align-items: center;
            gap: 2px;
            padding: 5px 6px;
            background: linear-gradient(to top, rgba(0,0,0,.72) 0%, transparent 100%);
            opacity: 0;
            pointer-events: none;
            transition: opacity .18s;
            border-radius: 0 0 10px 10px;
            z-index: 4;
            flex-wrap: wrap;
        }
        /* For document/audio rows the overlay sits at the right edge */
        .wa-att-row .wa-att-actions {
            top: 0; bottom: 0; right: 0; left: auto;
            flex-direction: column;
            justify-content: center;
            padding: 6px 4px;
            background: linear-gradient(to left, rgba(0,0,0,.6) 0%, transparent 100%);
            border-radius: 0 10px 10px 0;
        }
        .wa-att-item:hover  > .wa-att-actions,
        .wa-att-item:focus-within > .wa-att-actions {
            opacity: 1;
            pointer-events: auto;
        }
        /* Touch: tap the item to toggle (JS adds .wa-att-open) */
        .wa-att-item.wa-att-open > .wa-att-actions {
            opacity: 1;
            pointer-events: auto;
        }

        .wa-att-menu-item {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 8px;
            border: none;
            border-radius: 6px;
            background: rgba(255,255,255,.18);
            color: #fff;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            white-space: nowrap;
            backdrop-filter: blur(4px);
            transition: background .12s;
            line-height: 1;
        }
        .wa-att-menu-item:hover { background: rgba(255,255,255,.32); }
        .att-delete-btn { background: rgba(239,68,68,.55); }
        .att-delete-btn:hover  { background: rgba(239,68,68,.8); }
        body.dark-mode .wa-att-menu-item { background: rgba(255,255,255,.15); }
        body.dark-mode .wa-att-menu-item:hover { background: rgba(255,255,255,.28); }

        /* ═══ Multi-attachment block ═══ */
        .wa-att-block {
            display: flex; flex-direction: column; gap: 4px;
            /* FIXED: removed max-width:280px — was capping the grid narrower than
               the bubble, causing images to render smaller than necessary.
               The bubble itself (max-width:72% of viewport) provides the outer bound. */
            width: 100%;
            /* isolation:isolate so stacking contexts inside (overlays, z-index)
               don't leak outside the attachment block */
            isolation: isolate;
        }
        .wa-att-row { width: 100%; }

        /* Image grid layouts */
        .wa-att-grid {
            display: grid; gap: 3px;
            /* FIXED: removed overflow:hidden — the action overlay is position:absolute
               inside .wa-att-item. overflow:hidden on the grid clipped those overlays.
               Instead we clip the rounded corners via the outer .wa-att-block. */
            border-radius: 12px; overflow: hidden;
            width: 100%;
        }
        .wa-att-grid--1 { grid-template-columns: 1fr; max-width: 260px; }
        .wa-att-grid--2 { grid-template-columns: 1fr 1fr; }
        .wa-att-grid--4 { grid-template-columns: 1fr 1fr; }

        /* Rounded corners on grid edge cells */
        .wa-att-grid--1 > .wa-att-item:first-child  { border-radius: 12px; }
        .wa-att-grid--2 > .wa-att-item:first-child  { border-radius: 12px 0 0 12px; }
        .wa-att-grid--2 > .wa-att-item:last-child   { border-radius: 0 12px 12px 0; }
        .wa-att-grid--4 > .wa-att-item:nth-child(1) { border-radius: 12px 0 0 0; }
        .wa-att-grid--4 > .wa-att-item:nth-child(2) { border-radius: 0 12px 0 0; }
        .wa-att-grid--4 > .wa-att-item:nth-child(3) { border-radius: 0 0 0 12px; }
        .wa-att-grid--4 > .wa-att-item:nth-child(4) { border-radius: 0 0 12px 0; }

        .wa-att-image-wrap {
            position: relative; overflow: hidden;
            background: var(--wa-input-bg);
            width: 100%; height: 100%;
        }
        /* Single image: aspect ratio preserved with max dimensions */
        .wa-att-grid--1 > .wa-att-item { aspect-ratio: unset; }
        .wa-att-grid--1 .wa-att-image-wrap { aspect-ratio: unset; }
        .wa-att-grid--2 > .wa-att-item { aspect-ratio: 1; }
        .wa-att-grid--4 > .wa-att-item { aspect-ratio: 1; }

        .wa-att-image {
            width: 100%; height: 100%;
            object-fit: cover; display: block;
            cursor: zoom-in; transition: transform .18s;
        }
        .wa-att-image:hover { transform: scale(1.04); }
        /* Single image: contain so portrait/landscape show in full */
        .wa-att-grid--1 .wa-att-image {
            max-height: 300px; object-fit: contain;
            background: var(--wa-input-bg);
        }

        /* +N overlay on mosaic last tile */
        .wa-att-more-wrap { position: relative; }
        .wa-att-more-overlay {
            position: absolute; inset: 0;
            background: rgba(0,0,0,.55);
            display: flex; align-items: center; justify-content: center;
            font-size: 22px; font-weight: 800; color: #fff;
            letter-spacing: -0.5px;
        }

        /* Video attachment */
        .wa-att-video-wrap {
            border-radius: 12px; overflow: hidden;
            background: #000; max-width: 260px;
        }
        .wa-att-video {
            width: 100%; max-height: 200px;
            display: block; border-radius: 12px;
        }

        /* Caption text — sits below the media block */
        .wa-att-caption {
            font-size: 14px; color: var(--wa-msg-text, #111);
            line-height: 1.45; margin-top: 4px;
            white-space: pre-wrap; word-break: break-word;
        }
        .wa-bubble--me .wa-att-caption { color: rgba(255,255,255,.95); }

        /* Tighter bubble padding when the bubble contains only media */
        .wa-bubble:has(.wa-att-block:first-child):not(:has(.wa-msg-text)) {
            padding: 4px;
        }
        /* Keep meta row (timestamp/ticks) spaced from media */
        .wa-bubble:has(.wa-att-block) .wa-msg-meta {
            margin-top: 4px; padding: 0 4px 2px;
        }

        /* ═══ Compose Tray ═══ */
        #wa-compose-tray {
            background: var(--wa-panel); border-top: 1px solid var(--wa-border);
            padding: 10px 12px 8px;
            display: flex; flex-direction: column; gap: 8px;
            flex-shrink: 0; position: relative;
        }
        .wa-ct-header {
            display: flex; align-items: center; justify-content: space-between;
            font-size: 12px; font-weight: 700; color: var(--wa-sub);
            text-transform: uppercase; letter-spacing: .05em;
        }
        .wa-ct-clear {
            background: none; border: none; color: var(--wa-sub);
            cursor: pointer; font-size: 11px; padding: 2px 6px;
            border-radius: 6px; transition: background .1s, color .1s;
        }
        .wa-ct-clear:hover { background: var(--wa-input-bg); color: var(--wa-danger); }
        .wa-ct-thumbs {
            display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px;
        }
        .wa-ct-thumbs::-webkit-scrollbar { height: 3px; }
        .wa-ct-thumbs::-webkit-scrollbar-thumb { background: var(--wa-border); border-radius: 3px; }

        .wa-ct-thumb {
            position: relative; flex-shrink: 0;
            width: 72px; height: 72px; border-radius: 10px;
            overflow: hidden; background: var(--wa-input-bg);
            border: 1.5px solid var(--wa-border);
        }
        .wa-ct-thumb-img {
            width: 100%; height: 100%; object-fit: cover; display: block;
        }
        .wa-ct-thumb-doc {
            width: 100%; height: 100%; display: flex; flex-direction: column;
            align-items: center; justify-content: center; gap: 4px;
            font-size: 11px; color: var(--wa-sub); text-align: center;
            padding: 4px; overflow: hidden;
        }
        .wa-ct-thumb-doc span:first-child { font-size: 22px; }
        .wa-ct-thumb-doc span:last-child {
            white-space: nowrap; overflow: hidden;
            text-overflow: ellipsis; max-width: 100%;
        }
        .wa-ct-thumb-video-icon {
            position: absolute; inset: 0; display: flex;
            align-items: center; justify-content: center;
            background: rgba(0,0,0,.35);
        }
        .wa-ct-remove {
            position: absolute; top: 3px; right: 3px;
            width: 18px; height: 18px; border-radius: 50%;
            background: rgba(0,0,0,.55); border: none; color: #fff;
            font-size: 11px; cursor: pointer; display: flex;
            align-items: center; justify-content: center;
            line-height: 1; transition: background .1s;
        }
        .wa-ct-remove:hover { background: var(--wa-danger); }
        .wa-ct-progress-ring {
            position: absolute; inset: 0; display: flex;
            align-items: center; justify-content: center;
            background: rgba(0,0,0,.45); border-radius: 10px;
            font-size: 11px; font-weight: 700; color: #fff;
        }
        .wa-ct-error-badge {
            position: absolute; bottom: 3px; left: 3px;
            width: 16px; height: 16px; border-radius: 50%;
            background: var(--wa-danger); color: #fff;
            font-size: 10px; font-weight: 700;
            display: flex; align-items: center; justify-content: center;
        }
        .wa-ct-add-more {
            flex-shrink: 0; width: 72px; height: 72px;
            border-radius: 10px; border: 1.5px dashed var(--wa-border);
            background: var(--wa-input-bg); color: var(--wa-sub);
            font-size: 24px; cursor: pointer; display: flex;
            align-items: center; justify-content: center;
            transition: background .1s, color .1s, border-color .1s;
        }
        .wa-ct-add-more:hover {
            background: var(--wa-accent-dim); color: var(--wa-accent);
            border-color: var(--wa-accent);
        }
        .wa-ct-send-hint {
            font-size: 11px; color: var(--wa-sub);
            text-align: center; padding-bottom: 2px;
        }
        .wa-ct-caption-hint {
            font-size: 12px; color: var(--wa-sub);
        }
        body.dark-mode #wa-compose-tray { background: var(--wa-panel); border-color: var(--wa-border); }
        body.dark-mode .wa-ct-thumb { background: #1a1d35; border-color: var(--wa-border); }

        /* ═══ Chat page layout ═══ */
        #page-chat { padding-top: 20px !important; padding-bottom: 20px !important; }
        #page-chat .max-w-6xl { height: calc(100vh - 120px); min-height: 500px; }
        #page-chat > div > div {
            background: var(--wa-panel);
            border-radius: 20px;
            border: 1px solid var(--wa-border);
            box-shadow: var(--wa-shadow-lg);
            overflow: clip; /* FIX Bug 1: was overflow:hidden which clipped absolutely-positioned dropdowns (forward/delete/pin). overflow:clip preserves the border-radius crop on layout content without creating a new clipping rect for absolute descendants. */
            height: 100%;
            display: flex;
        }

        /* ═══ Sidebar ═══ */
        #page-chat .sm\\:w-80 {
            background: var(--wa-sidebar) !important;
            border-right: 1px solid var(--wa-border) !important;
            display: flex !important;
            flex-direction: column !important;
        }

        /* Sidebar top bar */
        #page-chat .sm\\:w-80 > div:first-child {
            background: var(--wa-header) !important;
            border-bottom: 1px solid var(--wa-border) !important;
            padding: 16px !important;
        }

        /* ═══ Sidebar search ═══ */
        .wa-search-bar {
            position: relative;
            margin-top: 10px;
        }
        .wa-search-bar input {
            width: 100%;
            padding: 8px 14px 8px 36px;
            border-radius: 20px;
            border: none;
            background: var(--wa-input-bg);
            font-size: 13.5px;
            color: var(--wa-text);
            outline: none;
            transition: background .15s;
        }
        .wa-search-bar input:focus { background: #e8eaed; }
        .wa-search-bar input::placeholder { color: #9ca3af; }
        .wa-search-bar svg {
            position: absolute; left: 11px; top: 50%;
            transform: translateY(-50%);
            color: var(--wa-sub); pointer-events: none;
            width: 16px; height: 16px;
        }

        /* ═══ Sidebar tab buttons ═══ */
        .wa-tab-bar {
            display: flex;
            align-items: center;
            gap: 2px;
            background: var(--wa-input-bg);
            border-radius: 10px;
            padding: 3px;
        }
        .wa-tab-btn {
            display: flex; align-items: center; justify-content: center;
            width: 32px; height: 32px; border-radius: 8px;
            border: none; background: none; cursor: pointer;
            color: var(--wa-sub); transition: background .15s, color .15s;
        }
        .wa-tab-btn:hover { background: #e0e0e0; color: var(--wa-text); }
        .wa-tab-btn--active { background: var(--wa-panel) !important; color: var(--wa-accent) !important; box-shadow: 0 1px 3px rgba(0,0,0,.1); }

        /* ═══ Sidebar list ═══ */
        #sidebar-lists-container {
            padding: 0 !important;
            overflow-y: auto;
            flex: 1;
        }
        #sidebar-lists-container::-webkit-scrollbar { width: 3px; }
        #sidebar-lists-container::-webkit-scrollbar-thumb { background: var(--wa-border); border-radius: 3px; }

        .wa-sidebar-item {
            display: flex; align-items: center; gap: 13px;
            padding: 11px 16px; cursor: pointer;
            border-bottom: 1px solid var(--wa-border);
            transition: background .1s; user-select: none; position: relative;
            background: var(--wa-panel);
        }
        .wa-sidebar-item:hover { background: #f9fafb; }
        .wa-sidebar-item--active {
            background: var(--wa-accent-dim) !important;
            border-left: 3px solid var(--wa-accent);
            padding-left: 13px;
        }
        .wa-sidebar-avatar { flex-shrink: 0; }
        .wa-sidebar-body   { flex: 1; min-width: 0; }
        .wa-sidebar-top    { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 3px; }
        /* FIX Bug 6: was max-width:160px which hard-truncated names at ~20 chars even on
           wide screens where space was available. flex:1 + min-width:0 lets the name fill
           remaining space and only ellipsis when the timestamp actually needs room. */
        .wa-sidebar-name   { font-size: 14px; font-weight: 600; color: var(--wa-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
        .wa-sidebar-name--unread { color: #000; font-weight: 700; }
        .wa-sidebar-time   { font-size: 11px; color: var(--wa-sub); white-space: nowrap; flex-shrink: 0; margin-left: 6px; }
        .wa-sidebar-time--unread { color: var(--wa-accent); font-weight: 600; }
        .wa-sidebar-bottom { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
        .wa-sidebar-preview { font-size: 13px; color: var(--wa-sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
        .wa-sidebar-preview--unread { color: var(--wa-text); font-weight: 500; }
        .wa-blocked { color: var(--wa-warn) !important; }
        .wa-badge {
            flex-shrink: 0; min-width: 20px; height: 20px; padding: 0 5px;
            border-radius: 10px; background: var(--wa-accent); color: #fff;
            font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center;
        }

        /* ═══ Chat panel ═══ */
        #chat-window {
            flex: 1 !important;
            display: flex !important;
            flex-direction: column !important;
            background: var(--wa-bg) !important;
            overflow: hidden;
        }

        /* ═══ Chat header ═══ */
        #chat-header {
            background: var(--wa-header) !important;
            border-bottom: 1px solid var(--wa-border) !important;
            padding: 0 !important;
            height: 62px !important;
            flex-shrink: 0 !important;
        }
        .ch-inner {
            display: flex; align-items: center; justify-content: space-between;
            width: 100%; height: 100%; padding: 0 12px 0 16px;
        }
        .ch-avatar-placeholder {
            width: 40px; height: 40px; border-radius: 50%;
            background: var(--wa-input-bg);
            display: flex; align-items: center; justify-content: center;
            color: var(--wa-sub);
        }
        .ch-select-label {
            font-size: 15px; font-weight: 600; color: var(--wa-text);
            margin-left: 12px;
        }

        /* Header left section (clickable for profile) */
        .ch-profile-area {
            display: flex; align-items: center; gap: 12px;
            cursor: pointer; padding: 6px 8px; border-radius: 10px;
            flex: 1; min-width: 0; transition: background .15s;
        }
        .ch-profile-area:hover { background: var(--wa-input-bg); }
        .ch-name {
            font-size: 15px; font-weight: 700; color: var(--wa-text);
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .ch-status {
            font-size: 12px; margin-top: 1px;
        }
        .ch-status--online { color: var(--wa-green); }
        .ch-status--offline { color: var(--wa-sub); }

        .ch-actions { display: flex; align-items: center; gap: 3px; flex-shrink: 0; }
        .wa-nav-btn {
            width: 36px; height: 36px; border-radius: 10px; border: none;
            background: transparent; color: var(--wa-sub);
            display: flex; align-items: center; justify-content: center;
            cursor: pointer; transition: background .15s, color .15s;
        }
        .wa-nav-btn:hover { background: var(--wa-input-bg); color: var(--wa-text); }
        .wa-nav-btn--active { color: var(--wa-accent) !important; background: var(--wa-accent-dim) !important; }

        /* ═══ Header dropdown ═══ */
        .wa-header-dropdown {
            position: absolute; right: 0; top: 42px; min-width: 210px;
            background: var(--wa-panel); border: 1px solid var(--wa-border); border-radius: 14px;
            box-shadow: var(--wa-shadow-lg); overflow: hidden; z-index: 50;
        }

        /* ═══ Pinned bar ═══ */
        #wa-pinned-bar {
            background: #fffbeb; border-bottom: 1px solid #fde68a;
            padding: 8px 16px; display: flex; align-items: center; gap: 10px; cursor: pointer;
            flex-shrink: 0;
        }
        .wa-pin-icon  { font-size: 13px; flex-shrink: 0; }
        .wa-pin-content { flex: 1; min-width: 0; }
        .wa-pin-label { display: block; font-size: 10.5px; color: #92400e; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 1px; }
        .wa-pin-text  { display: block; font-size: 13px; color: #78350f; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .wa-pin-close { background: none; border: none; color: #92400e; cursor: pointer; padding: 4px; border-radius: 6px; transition: background .1s; display: flex; align-items: center; }
        .wa-pin-close:hover { background: #fde68a; }

        /* ═══ Message area ═══ */
        #chat-messages {
            display: flex !important;
            flex-direction: column-reverse;
            overflow-y: auto;
            /* overflow-x must remain visible (or unset) so the absolutely-positioned
               .wa-msg-menu trigger buttons — which sit OUTSIDE the bubble via
               right/left: calc(100% + 8px) — are never clipped horizontally.
               overflow-y:auto on a flex container does NOT create a clipping rect
               for position:absolute children whose containing block is an in-flow
               ancestor (the spec only clips content that overflows the scroll port).
               The trigger buttons are still contained by .wa-msg-wrap which is
               position:relative, so they will never scroll the container. */
            overflow-x: visible;
            padding: 20px 24px 12px !important;
            background: var(--wa-bg) !important;
            flex: 1 !important;
            space-y: 0 !important;
        }
        #chat-messages::-webkit-scrollbar { width: 4px; }
        #chat-messages::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 4px; }

        .wa-welcome {
            width: 100%; height: 100%;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            gap: 12px; text-align: center; padding: 24px;
        }
        .wa-welcome-icon {
            width: 88px; height: 88px; border-radius: 50%;
            background: var(--wa-panel); border: 1px solid var(--wa-border);
            display: flex; align-items: center; justify-content: center;
            color: var(--wa-accent); margin-bottom: 8px;
        }
        .wa-welcome-title { font-size: 22px; font-weight: 700; color: var(--wa-text); }
        .wa-welcome-sub   { font-size: 13px; color: var(--wa-sub); max-width: 280px; line-height: 1.5; }
        .wa-welcome-enc   { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--wa-sub); margin-top: 8px; }

        /* ═══ Message rows ═══ */
        .wa-msg-row {
            display: flex; align-items: flex-end; gap: 6px;
            /* 72% max-width keeps bubbles from touching edges.
               The trigger button sits OUTSIDE the row's flex layout
               (position:absolute on .wa-msg-wrap) so it adds no width. */
            max-width: 72%; margin-bottom: 2px;
            animation: waFadeIn .18s ease-out;
            /* overflow:visible so the absolutely-positioned .wa-msg-menu
               trigger is never clipped when it extends beyond the row's box */
            overflow: visible;
        }
        .wa-msg-row--me   { align-self: flex-end; flex-direction: row-reverse; }
        .wa-msg-row--them { align-self: flex-start; }
        .wa-msg-avatar    { width: 30px; height: 30px; flex-shrink: 0; }
        .wa-msg-avatar-gap { width: 30px; flex-shrink: 0; }
        /* position:relative creates the containing block for .wa-msg-menu.
           overflow:visible is intentional — the trigger must never be clipped. */
        .wa-msg-wrap      { position: relative; display: flex; flex-direction: column; overflow: visible; }
        .wa-msg-row--me  .wa-msg-wrap { align-items: flex-end; }
        .wa-msg-row--them .wa-msg-wrap { align-items: flex-start; }

        @keyframes waFadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }

        /* ═══ Bubbles ═══ */
        .wa-bubble {
            padding: 8px 12px;
            border-radius: var(--wa-radius);
            position: relative;
            max-width: 100%;
            word-break: break-word;
        }
        .wa-bubble--me    { background: var(--wa-accent); color: #fff; border-bottom-right-radius: 4px; }
        .wa-bubble--them  { background: var(--wa-panel); color: var(--wa-text); border-bottom-left-radius: 4px; box-shadow: 0 1px 4px rgba(0,0,0,.07); }
        .wa-bubble--tail-me   { border-bottom-right-radius: 4px; }
        .wa-bubble--tail-them { border-bottom-left-radius: 4px; }
        .wa-bubble--pending   { opacity: 0.7; }
        .wa-bubble--failed    { border: 1.5px solid var(--wa-danger) !important; }
        .wa-bubble--deleted   { opacity: 0.65; font-style: italic; }

        .wa-msg-text  { font-size: 14px; line-height: 1.5; display: block; white-space: pre-wrap; }
        .wa-sender-label { display: block; font-size: 12px; font-weight: 700; margin-bottom: 3px; }

        .wa-msg-meta {
            display: flex; align-items: center; justify-content: flex-end;
            gap: 4px; margin-top: 3px;
            font-size: 10.5px; opacity: 0.75;
            line-height: 1;
        }
        .wa-bubble--me   .wa-msg-meta { color: rgba(255,255,255,.8); }
        .wa-bubble--them .wa-msg-meta { color: var(--wa-sub); }
        .wa-edited-tag { font-style: italic; opacity: .8; }
        .wa-deleted-text { font-size: 13.5px; color: var(--wa-sub); display: flex; align-items: center; gap: 4px; }
        .wa-bubble--me .wa-deleted-text { color: rgba(255,255,255,.7); }

        /* ═══ Ticks ═══ */
        .wa-ticks       { width: 18px; height: 11px; display: inline-flex; flex-shrink: 0; }
        .wa-tick-single { width: 14px; height: 11px; display: inline-flex; flex-shrink: 0; }
        .wa-starred-badge { font-size: 11px; }
        .wa-retry-btn { font-size: 11px; background: rgba(239,68,68,.15); color: var(--wa-danger); border: 1px solid var(--wa-danger); border-radius: 6px; padding: 2px 7px; cursor: pointer; }

        /* ═══ Reply bubble ═══ */
        .wa-reply-bubble {
            display: flex; gap: 0; border-radius: 8px; overflow: hidden;
            margin-bottom: 6px; cursor: pointer;
            background: rgba(0,0,0,.07);
        }
        .wa-bubble--me .wa-reply-bubble { background: rgba(255,255,255,.18); }
        .wa-reply-line    { width: 3px; background: var(--wa-accent); flex-shrink: 0; }
        .wa-bubble--me .wa-reply-line { background: rgba(255,255,255,.8); }
        .wa-reply-content { padding: 5px 8px; min-width: 0; }
        .wa-reply-name    { display: block; font-size: 11.5px; font-weight: 700; color: var(--wa-accent); margin-bottom: 2px; }
        .wa-bubble--me .wa-reply-name { color: rgba(255,255,255,.85); }
        .wa-reply-text    { display: block; font-size: 12.5px; color: var(--wa-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
        .wa-bubble--me .wa-reply-text { color: rgba(255,255,255,.8); }

        /* ═══ Image ═══ */
        .wa-msg-image {
            max-width: 260px; max-height: 200px; border-radius: 10px;
            cursor: zoom-in; display: block; object-fit: cover;
        }

        /* ═══ File attachment ═══ */
        .wa-file-attachment {
            display: flex; align-items: center; gap: 10px; padding: 8px 12px;
            background: rgba(0,0,0,.06); border-radius: 10px; text-decoration: none;
            color: var(--wa-text); min-width: 180px; max-width: 260px;
        }
        .wa-bubble--me .wa-file-attachment { background: rgba(255,255,255,.15); color: #fff; }
        .wa-file-icon  { font-size: 24px; flex-shrink: 0; }
        .wa-file-info  { flex: 1; min-width: 0; }
        .wa-file-name  { display: block; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .wa-file-size  { display: block; font-size: 11px; opacity: .65; margin-top: 2px; }
        .wa-file-dl    { flex-shrink: 0; opacity: .55; }
        .wa-file-attachment:hover .wa-file-dl { opacity: 1; }

        /* ═══ Voice note ═══ */
        .wa-voice-note {
            display: flex; align-items: center; gap: 10px;
            min-width: 180px; max-width: 260px; padding: 2px 0;
        }
        .wa-voice-play-btn {
            width: 36px; height: 36px; border-radius: 50%; border: none;
            background: rgba(255,255,255,.25); color: #fff; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            transition: background .15s; flex-shrink: 0;
        }
        .wa-bubble--them .wa-voice-play-btn { background: var(--wa-accent-dim); color: var(--wa-accent); }
        .wa-voice-play-btn:hover { background: rgba(255,255,255,.4); }
        .wa-bubble--them .wa-voice-play-btn:hover { background: rgba(79,70,229,.18); }
        .wa-voice-waveform { display: flex; align-items: center; gap: 2px; flex: 1; height: 24px; }
        .wa-wave-bar   { width: 3px; border-radius: 2px; background: rgba(255,255,255,.6); flex-shrink: 0; transition: background .15s, transform .15s; }
        .wa-bubble--them .wa-wave-bar { background: #9ca3af; }
        /* Waveform animation while playing */
        .wa-voice-note.playing .wa-wave-bar { background: rgba(255,255,255,1); animation: waWavePlay .7s ease-in-out infinite alternate; }
        .wa-bubble--them .wa-voice-note.playing .wa-wave-bar { background: var(--wa-accent); }
        .wa-voice-note.playing .wa-wave-bar:nth-child(2n)   { animation-delay: .1s; }
        .wa-voice-note.playing .wa-wave-bar:nth-child(3n)   { animation-delay: .2s; }
        .wa-voice-note.playing .wa-wave-bar:nth-child(4n)   { animation-delay: .3s; }
        .wa-voice-note.playing .wa-wave-bar:nth-child(5n)   { animation-delay: .15s; }
        @keyframes waWavePlay { from { transform: scaleY(.5); } to { transform: scaleY(1.35); } }
        .wa-voice-duration { font-size: 11.5px; color: rgba(255,255,255,.75); white-space: nowrap; flex-shrink: 0; }
        .wa-bubble--them .wa-voice-duration { color: var(--wa-sub); }

        /* ═══ Link preview ═══ */
        .wa-link-preview {
            margin-top: 6px; border-radius: 8px; overflow: hidden;
            border-left: 3px solid rgba(255,255,255,.5);
            padding: 6px 8px; background: rgba(0,0,0,.08);
        }
        .wa-bubble--them .wa-link-preview { border-left-color: var(--wa-accent); background: var(--wa-input-bg); }
        .wa-link-domain { display: block; font-size: 12px; font-weight: 600; }
        .wa-bubble--me .wa-link-domain { color: rgba(255,255,255,.85); }
        .wa-bubble--them .wa-link-domain { color: var(--wa-accent); }
        .wa-link-url    { display: block; font-size: 11px; opacity: .65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .wa-link { color: inherit; text-decoration: underline; }

        /* ═══ Reactions ═══ */
        .wa-reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
        .wa-reaction-pill {
            display: flex; align-items: center; gap: 4px; padding: 3px 8px;
            border-radius: 14px; border: 1px solid var(--wa-border);
            background: var(--wa-panel); color: var(--wa-text);
            font-size: 13px; cursor: pointer; transition: all .15s;
            box-shadow: 0 1px 3px rgba(0,0,0,.06);
        }
        .wa-reaction-pill:hover { border-color: var(--wa-accent); }
        .wa-reaction-pill--mine { border-color: var(--wa-accent); background: var(--wa-accent-dim); }
        .wa-reaction-pill span  { font-size: 11px; font-weight: 700; color: var(--wa-sub); }

        /* ═══ Message context menu ═══ */
        /*
         * ARCHITECTURE: The trigger button (.wa-msg-menu / .wa-msg-menu-btn) lives
         * inside .wa-msg-wrap (position:relative) as a sibling of .wa-bubble, so
         * hover detection via CSS works naturally without any overflow issue.
         * The dropdown (.wa-msg-dropdown) is PORTALED to <body> at open time via
         * MessageMenuController so it escapes every stacking context, overflow:hidden/
         * clip/auto ancestor, and CSS transform containing block. JS writes
         * position:fixed + viewport-aware coords. This section styles only the
         * trigger wrapper and the portal panel itself.
         *
         * KEY OVERFLOW FIX: .wa-msg-row max-width:72% + position:relative on
         * .wa-msg-wrap means the absolute-positioned trigger sits OUTSIDE the
         * bubble width but INSIDE the row. #chat-messages has overflow-y:auto
         * which does NOT clip horizontal overflow of child elements whose containing
         * block is an in-flow ancestor (per CSS spec). The trigger is safe.
         * The dropdown is on <body> with position:fixed — it is NEVER clipped.
         */

        /* ── Trigger wrapper (stays in DOM tree, positioned relative to .wa-msg-wrap) ── */
        .wa-msg-menu {
            position: absolute;
            top: 6px;
            z-index: 20;           /* above bubble content, below portaled dropdown */
            opacity: 0;
            pointer-events: none;
            transition: opacity .15s ease, transform .15s ease;
            transform: scale(0.82);
            /* Prevent the trigger from creating a new stacking context that
               could interfere with sibling z-index ordering */
            isolation: isolate;
        }
        /* FIX: place trigger OUTSIDE the bubble on each side so it never overlaps text */
        .wa-msg-row--me   .wa-msg-menu { right: calc(100% + 8px); left: auto; }
        .wa-msg-row--them .wa-msg-menu { left: calc(100% + 8px); right: auto; }

        /* Show on hover, focus-within, or when dropdown is open */
        .wa-msg-wrap:hover .wa-msg-menu,
        .wa-msg-wrap:focus-within .wa-msg-menu,
        .wa-msg-menu[data-open="true"] {
            opacity: 1;
            pointer-events: auto;
            transform: scale(1);
        }

        /* Touch: always visible so it can be tapped */
        @media (hover: none) {
            .wa-msg-menu {
                opacity: 1;
                pointer-events: auto;
                transform: scale(1);
            }
        }

        /* ── Trigger button ── */
        .wa-msg-menu-btn {
            width: 32px; height: 32px; border-radius: 10px;
            background: var(--wa-panel);
            border: 1px solid var(--wa-border);
            color: var(--wa-sub);
            display: flex; align-items: center; justify-content: center;
            cursor: pointer;
            transition: background .15s, color .15s, border-color .15s, box-shadow .15s;
            box-shadow: 0 1px 6px rgba(0,0,0,.10);
            -webkit-tap-highlight-color: transparent;
            touch-action: manipulation;
            /* Ensure it never triggers a transform that would make descendants
               use this as a containing block for position:fixed */
        }
        .wa-msg-menu-btn:hover { background: var(--wa-input-bg); color: var(--wa-text); box-shadow: 0 2px 10px rgba(0,0,0,.13); }
        .wa-msg-menu-btn:focus-visible {
            outline: 2px solid var(--wa-accent);
            outline-offset: 2px;
        }
        .wa-msg-menu-btn[aria-expanded="true"] {
            background: var(--wa-accent-dim);
            color: var(--wa-accent);
            border-color: var(--wa-accent);
            box-shadow: 0 0 0 3px rgba(79,70,229,.12);
        }

        /* ── Portal dropdown (appended to <body>, position:fixed written by JS) ── */
        /*
         * CRITICAL: This element lives on <body> when open — NEVER inside any
         * scroll container, transformed ancestor, or overflow:hidden/clip element.
         * position:fixed coords are set by positionDropdown() which does full
         * viewport-edge collision detection (below-right → below-left → above-right
         * → above-left). overflow:hidden on the PANEL (not visible) lets border-
         * radius clip the emoji row while the JS-controlled maxHeight + overflow-y:auto
         * handles tall menus on small screens without any outer clipping.
         */
        .wa-msg-dropdown {
            position: fixed;           /* always fixed — never absolute */
            min-width: 230px;
            max-width: min(92vw, 288px);
            background: var(--wa-panel);
            border: 1px solid var(--wa-border);
            border-radius: 18px;
            box-shadow:
                0 10px 48px rgba(0,0,0,.16),
                0 2px 10px rgba(0,0,0,.09),
                0 0 0 0.5px rgba(0,0,0,.04);
            /* overflow:hidden clips rounded corners on the emoji row;
               individual items use border-radius on their own hover states.
               The panel itself never clips — maxHeight + overflow-y:auto handles overflow. */
            overflow: hidden;
            z-index: 99999;            /* above modals (400), lightboxes, toasts (500) */
            /* Entry state — JS adds .wa-msg-dropdown--open to animate in */
            opacity: 0;
            transform: scale(0.90) translateY(-8px);
            transform-origin: top center;
            transition:
                opacity .16s cubic-bezier(0.4, 0, 0.2, 1),
                transform .16s cubic-bezier(0.4, 0, 0.2, 1);
            pointer-events: none;
            will-change: opacity, transform;
            /* Ensure this never clips its own scrollable inner content */
            display: flex;
            flex-direction: column;
        }
        .wa-msg-dropdown--open {
            opacity: 1;
            transform: scale(1) translateY(0);
            pointer-events: auto;
        }
        /* Direction modifier classes set by positionDropdown() */
        .wa-msg-dropdown--below { transform-origin: top center; }
        .wa-msg-dropdown--above {
            transform-origin: bottom center;
            transform: scale(0.90) translateY(8px);
        }
        .wa-msg-dropdown--above.wa-msg-dropdown--open { transform: scale(1) translateY(0); }
        /* Left/right alignment for transform-origin */
        .wa-msg-dropdown--align-left  { transform-origin: top left; }
        .wa-msg-dropdown--align-right { transform-origin: top right; }
        .wa-msg-dropdown--above.wa-msg-dropdown--align-left  { transform-origin: bottom left; }
        .wa-msg-dropdown--above.wa-msg-dropdown--align-right { transform-origin: bottom right; }

        /* Scrollable inner list — keeps emoji row pinned at top */
        .wa-msg-dropdown__scroll {
            overflow-y: auto;
            overflow-x: hidden;
            overscroll-behavior: contain;
            /* scrollbar styling */
            scrollbar-width: thin;
            scrollbar-color: var(--wa-border) transparent;
        }
        .wa-msg-dropdown__scroll::-webkit-scrollbar { width: 4px; }
        .wa-msg-dropdown__scroll::-webkit-scrollbar-thumb { background: var(--wa-border); border-radius: 2px; }

        /* Reduced-motion: fade only, no scale/translate */
        @media (prefers-reduced-motion: reduce) {
            .wa-msg-dropdown,
            .wa-msg-dropdown--above,
            .wa-msg-dropdown--above.wa-msg-dropdown--open {
                transition: opacity .1s linear;
                transform: none !important;
            }
        }

        /* ── Inner sections ── */
        .wa-emoji-bar {
            display: flex; justify-content: space-between;
            padding: 9px 10px 8px; border-bottom: 1px solid var(--wa-border);
            gap: 2px;
            /* Border-radius is handled by the panel's overflow:hidden at 18px.
               No need for overflow:hidden here — emoji scale transforms would
               be clipped. The panel clips everything at its own border edge. */
            flex-shrink: 0; /* never shrink when menu is height-constrained */
        }
        .wa-emoji-pick {
            font-size: 21px; background: none; border: none; cursor: pointer;
            transition: transform .15s, background .12s;
            border-radius: 8px; padding: 4px 5px; line-height: 1;
            -webkit-tap-highlight-color: transparent;
            touch-action: manipulation;
            min-width: 36px; text-align: center;
        }
        .wa-emoji-pick:hover  { transform: scale(1.45); background: var(--wa-input-bg); }
        .wa-emoji-pick:focus-visible { outline: 2px solid var(--wa-accent); outline-offset: 2px; border-radius: 6px; }

        /* Action items */
        .wa-drop-item {
            display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
            padding: 10px 16px; font-size: 13.5px; color: var(--wa-text);
            background: none; border: none; cursor: pointer;
            transition: background .1s;
            -webkit-tap-highlight-color: transparent;
            touch-action: manipulation;
            /* Ensure icons and text align even when icon is absent */
            min-height: 40px;
        }
        .wa-drop-item:hover       { background: var(--wa-input-bg); }
        .wa-drop-item:focus-visible {
            outline: none;
            background: var(--wa-accent-dim);
            color: var(--wa-accent);
        }
        /* Keyboard-focused item — controlled by JS via .wa-drop-item--focused */
        .wa-drop-item--focused {
            background: var(--wa-accent-dim) !important;
            color: var(--wa-accent) !important;
        }
        .wa-drop-item--danger {
            color: var(--wa-danger) !important;
            border-top: 1px solid var(--wa-border);
        }
        .wa-drop-item--danger:hover { background: rgba(239,68,68,.06) !important; }
        .wa-drop-item svg { flex-shrink: 0; opacity: 0.75; }
        .wa-drop-item:hover svg, .wa-drop-item--focused svg { opacity: 1; }

        /* Last item rounded corners */
        .wa-drop-item:last-child { border-radius: 0 0 16px 16px; }

        /* ═══ System messages ═══ */
        .wa-system-msg { display: flex; justify-content: center; margin: 14px 0; }
        .wa-system-msg span {
            background: rgba(255,255,255,.9); color: var(--wa-sub); font-size: 12px;
            padding: 5px 14px; border-radius: 20px; border: 1px solid var(--wa-border);
            letter-spacing: .01em; font-weight: 500; box-shadow: var(--wa-shadow);
        }

        /* ═══ Date divider ═══ */
        .wa-date-divider {
            display: flex; align-items: center; gap: 12px; margin: 14px 0 8px;
            color: var(--wa-sub); font-size: 11.5px; letter-spacing: .03em; font-weight: 600;
        }
        .wa-date-divider::before,
        .wa-date-divider::after { content: ''; flex: 1; height: 1px; background: var(--wa-border); }

        /* ═══ Typing indicator ═══ */
        .wa-typing-row { align-items: flex-end; margin-bottom: 4px; }
        .wa-typing-label { font-size: 12px; color: var(--wa-sub); display: block; margin-bottom: 4px; }
        .wa-typing-dots { display: inline-flex; gap: 3px; align-items: center; }
        .wa-typing-dots span { width: 6px; height: 6px; border-radius: 50%; background: #9ca3af; display: block; animation: waBounce 1.1s ease-in-out infinite; }
        .wa-typing-dots span:nth-child(2) { animation-delay: .18s; }
        .wa-typing-dots span:nth-child(3) { animation-delay: .36s; }
        @keyframes waBounce { 0%,60%,100% { transform: translateY(0); opacity: .4; } 30% { transform: translateY(-5px); opacity: 1; } }

        /* ═══ Search bar (in-chat) ═══ */
        #chat-search-bar {
            background: var(--wa-panel); border-bottom: 1px solid var(--wa-border);
            padding: 8px 14px; display: flex; align-items: center; gap: 10px; flex-shrink: 0;
        }
        #chat-search-input {
            flex: 1; background: var(--wa-input-bg); border: 1.5px solid transparent;
            outline: none; color: var(--wa-text); font-size: 14px;
            padding: 8px 14px; border-radius: 10px; transition: border-color .15s;
        }
        #chat-search-input:focus { border-color: var(--wa-accent); background: #fff; }
        #chat-search-input::placeholder { color: #9ca3af; }
        .wa-highlight { background: #fef3c7; color: #92400e; border-radius: 3px; padding: 0 2px; }

        /* ═══ Reply preview bar (above input) ═══ */
        #wa-reply-preview {
            background: var(--wa-panel); border-top: 1px solid var(--wa-border);
            padding: 8px 14px; display: flex; align-items: center; gap: 10px; flex-shrink: 0;
        }
        #wa-reply-preview .wa-rp-line { width: 3px; height: 36px; border-radius: 2px; background: var(--wa-accent); flex-shrink: 0; }
        #wa-reply-preview .wa-rp-content { flex: 1; min-width: 0; }
        #wa-reply-preview .wa-rp-name { font-size: 12px; font-weight: 700; color: var(--wa-accent); display: block; margin-bottom: 2px; }
        #wa-reply-preview .wa-rp-text { font-size: 13px; color: var(--wa-sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #wa-reply-close { background: none; border: none; cursor: pointer; color: var(--wa-sub); padding: 4px; border-radius: 6px; transition: background .1s; display: flex; align-items: center; }
        #wa-reply-close:hover { background: var(--wa-input-bg); color: var(--wa-text); }

        /* ═══ Input bar ═══ */
        #chat-message-form {
            display: flex !important;
            align-items: flex-end !important;
            gap: 8px !important;
            background: var(--wa-panel) !important;
            border: none !important;
            border-radius: 0 !important;
            padding: 10px 12px !important;
        }

        /* Input area wrapper (so we get emoji + text together) */
        .wa-input-wrap {
            flex: 1; display: flex; align-items: flex-end;
            background: var(--wa-input-bg); border: 1.5px solid transparent;
            border-radius: 24px; overflow: hidden; transition: border-color .15s;
        }
        .wa-input-wrap:focus-within { border-color: var(--wa-accent); background: #fff; }

        #chat-message-input {
            flex: 1 !important;
            background: transparent !important;
            border: none !important;
            border-radius: 0 !important;
            color: var(--wa-text) !important;
            font-size: 14.5px !important;
            padding: 10px 12px !important;
            resize: none !important;
            max-height: 120px; overflow-y: auto;
            outline: none !important;
            line-height: 1.5;
        }
        #chat-message-input::placeholder { color: #9ca3af !important; }

        #chat-emoji-btn {
            color: var(--wa-sub); background: none; border: none;
            cursor: pointer; padding: 8px 10px; display: flex; align-items: center;
            justify-content: center; flex-shrink: 0; transition: color .15s;
        }
        #chat-emoji-btn:hover { color: var(--wa-accent); }

        #chat-attachment-btn {
            color: var(--wa-sub) !important; background: none !important;
            border: none !important; cursor: pointer !important;
            padding: 0 !important; width: 40px; height: 40px;
            border-radius: 50% !important; display: flex !important;
            align-items: center !important; justify-content: center !important;
            flex-shrink: 0; transition: background .15s, color .15s !important;
        }
        #chat-attachment-btn:hover:not(:disabled) { background: var(--wa-input-bg) !important; color: var(--wa-accent) !important; }
        #chat-attachment-btn:disabled { opacity: 0.45 !important; cursor: not-allowed !important; }

        #send-msg-btn {
            background: var(--wa-accent) !important;
            border-radius: 50% !important;
            width: 42px !important; height: 42px !important;
            display: flex !important; align-items: center !important;
            justify-content: center !important; flex-shrink: 0;
            transition: background .15s, transform .1s !important;
            border: none !important;
        }
        #send-msg-btn:hover:not(:disabled) { background: #4338ca !important; transform: scale(1.05) !important; }
        #send-msg-btn:disabled { background: #e5e7eb !important; }

        /* Mic button */
        #wa-mic-btn {
            width: 42px; height: 42px; border-radius: 50%; border: none;
            background: var(--wa-input-bg); color: var(--wa-sub);
            display: flex; align-items: center; justify-content: center;
            cursor: pointer; transition: all .15s; flex-shrink: 0;
        }
        #wa-mic-btn:hover { background: #e5e7eb; color: var(--wa-text); }
        #wa-mic-btn.recording { background: var(--wa-danger); color: #fff; animation: waPulse 1s ease-in-out infinite; }
        @keyframes waPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,.35); } 50% { box-shadow: 0 0 0 8px rgba(239,68,68,0); } }

        #wa-recording-bar {
            background: var(--wa-panel); border-top: 1px solid var(--wa-border);
            padding: 9px 16px; display: flex; align-items: center; gap: 12px; flex-shrink: 0;
        }
        .wa-rec-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--wa-danger); animation: waPulse 1s ease-in-out infinite; flex-shrink: 0; }
        .wa-rec-timer { font-size: 14px; color: var(--wa-text); font-variant-numeric: tabular-nums; font-weight: 700; }
        .wa-rec-cancel { background: none; border: none; color: var(--wa-sub); cursor: pointer; font-size: 13px; padding: 5px 12px; border-radius: 8px; transition: background .1s, color .1s; margin-left: auto; }
        .wa-rec-cancel:hover { background: var(--wa-input-bg); color: var(--wa-danger); }
        .wa-rec-send {
            background: var(--wa-accent); border: none; color: #fff; cursor: pointer;
            width: 36px; height: 36px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center; flex-shrink: 0;
            transition: background .15s, transform .1s; box-shadow: 0 2px 6px rgba(79,70,229,.35);
        }
        .wa-rec-send:hover { background: var(--wa-accent-dark, #4338ca); transform: scale(1.07); }
        .wa-rec-pause {
            background: var(--wa-input-bg); border: none; color: var(--wa-text);
            cursor: pointer; font-size: 14px; width: 30px; height: 30px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center; flex-shrink: 0;
            transition: background .1s, color .1s;
        }
        .wa-rec-pause:hover { background: var(--wa-accent-dim); color: var(--wa-accent); }
        .wa-rec-dot.paused { animation: none; opacity: .5; }

        /* ═══ Attach menu ═══ */
        #wa-attach-menu {
            position: absolute; bottom: 70px; left: 50px;
            background: var(--wa-panel); border: 1px solid var(--wa-border); border-radius: 16px;
            box-shadow: var(--wa-shadow-lg); padding: 6px; z-index: 60;
            display: flex; flex-direction: column; gap: 1px; min-width: 165px;
        }
        .wa-attach-item {
            display: flex; align-items: center; gap: 10px; padding: 10px 14px;
            background: none; border: none; color: var(--wa-text); cursor: pointer;
            border-radius: 11px; font-size: 14px; transition: background .1s;
        }
        .wa-attach-item:hover { background: var(--wa-input-bg); }
        .wa-attach-icon { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; }

        /* ═══ Emoji picker ═══ */
        #wa-emoji-picker {
            position: absolute; bottom: 70px; left: 10px;
            background: var(--wa-panel); border: 1px solid var(--wa-border); border-radius: 16px;
            box-shadow: var(--wa-shadow-lg); padding: 12px; z-index: 60;
            display: grid; grid-template-columns: repeat(8, 32px); gap: 4px;
            max-height: 200px; overflow-y: auto;
        }
        .wa-ep-btn { font-size: 20px; background: none; border: none; cursor: pointer; border-radius: 8px; padding: 3px; transition: background .1s; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; }
        .wa-ep-btn:hover { background: var(--wa-input-bg); }

        /* ═══ Gallery lightbox — full CSS injected lazily by openGallery() ═══ */
        /* z-index stub so any early #wa-lightbox reference still stacks correctly */
        #wa-lightbox { z-index: 9999; }

        /* ═══ Forward modal ═══ */
        #wa-forward-modal { position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,.45); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; }
        #wa-forward-card { background: var(--wa-panel); border: 1px solid var(--wa-border); border-radius: 20px; width: 100%; max-width: 380px; max-height: 80vh; overflow: hidden; display: flex; flex-direction: column; box-shadow: var(--wa-shadow-lg); }
        #wa-forward-card .wa-fwd-header { padding: 14px 16px; border-bottom: 1px solid var(--wa-border); display: flex; justify-content: space-between; align-items: center; }
        #wa-forward-card .wa-fwd-title { color: var(--wa-text); font-weight: 600; font-size: 15px; }
        #wa-fwd-close { background: none; border: none; color: var(--wa-sub); cursor: pointer; padding: 4px; font-size: 18px; }

        /* ═══ Starred panel ═══ */
        #wa-starred-modal { position: fixed; inset: 0; z-index: 150; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.45); backdrop-filter: blur(4px); }
        #wa-starred-card { background: var(--wa-panel); border: 1px solid var(--wa-border); border-radius: 20px; width: 100%; max-width: 400px; max-height: 80vh; overflow: hidden; display: flex; flex-direction: column; box-shadow: var(--wa-shadow-lg); }
        .wa-starred-header { padding: 14px 16px; border-bottom: 1px solid var(--wa-border); display: flex; justify-content: space-between; align-items: center; }
        .wa-starred-title { color: var(--wa-text); font-weight: 600; font-size: 15px; }
        #wa-starred-close { background: none; border: none; color: var(--wa-sub); cursor: pointer; padding: 4px; font-size: 18px; }
        .wa-starred-item { padding: 12px 16px; border-bottom: 1px solid var(--wa-border); display: flex; gap: 10px; align-items: flex-start; }
        .wa-starred-item-name { color: var(--wa-accent); font-size: 12px; font-weight: 600; margin-bottom: 2px; }
        .wa-starred-item-text { color: var(--wa-text); font-size: 14px; }
        .wa-starred-empty { text-align: center; color: var(--wa-sub); padding: 40px 20px; font-size: 14px; }

        /* ═══ Members modal ═══ */
        #chat-members-modal { position: fixed; inset: 0; z-index: 150; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.45); backdrop-filter: blur(4px); padding: 16px; }
        #chat-members-card { background: var(--wa-panel); border: 1px solid var(--wa-border); border-radius: 20px; width: 100%; max-width: 380px; max-height: 80vh; overflow: hidden; display: flex; flex-direction: column; box-shadow: var(--wa-shadow-lg); }
        .members-header { padding: 14px 16px; border-bottom: 1px solid var(--wa-border); display: flex; justify-content: space-between; align-items: center; }
        .members-title { color: var(--wa-text); font-weight: 600; font-size: 15px; }
        #close-members-modal { background: none; border: none; color: var(--wa-sub); cursor: pointer; padding: 4px; font-size: 18px; }
        #chat-members-list { overflow-y: auto; flex: 1; padding: 4px; }
        .member-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-radius: 10px; transition: background .1s; }
        .member-item:hover { background: var(--wa-input-bg); }
        .member-info { display: flex; align-items: center; gap: 10px; }
        .member-name { color: var(--wa-text); font-size: 14px; font-weight: 500; }
        .member-admin-badge { color: var(--wa-accent); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
        .member-remove-btn { font-size: 12px; color: var(--wa-danger); font-weight: 600; padding: 4px 10px; border: 1px solid transparent; border-radius: 8px; background: none; cursor: pointer; transition: background .1s, border-color .1s; }
        .member-remove-btn:hover { background: rgba(239,68,68,.08); border-color: var(--wa-danger); }

        /* ═══ Group modal ═══ */
        #advanced-group-modal { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.5); backdrop-filter: blur(4px); padding: 16px; }
        #advanced-group-card { background: var(--wa-panel); border: 1px solid var(--wa-border); border-radius: 20px; width: 100%; max-width: 440px; max-height: 85vh; overflow: hidden; display: flex; flex-direction: column; box-shadow: var(--wa-shadow-lg); }
        .group-modal-header { padding: 16px; border-bottom: 1px solid var(--wa-border); display: flex; align-items: center; justify-content: space-between; }
        .group-modal-title { font-size: 16px; font-weight: 700; color: var(--wa-text); }
        #close-group-modal,#cancel-group-modal { background: none; border: none; cursor: pointer; color: var(--wa-sub); transition: color .15s; }
        #close-group-modal { font-size: 18px; padding: 4px; }
        #close-group-modal:hover,#cancel-group-modal:hover { color: var(--wa-text); }
        .group-modal-body { padding: 16px; overflow-y: auto; flex: 1; }
        #new-group-name { width: 100%; background: var(--wa-input-bg); border: 1.5px solid transparent; border-radius: 12px; padding: 10px 14px; font-size: 14px; color: var(--wa-text); outline: none; transition: border-color .15s; }
        #new-group-name:focus { border-color: var(--wa-accent); background: #fff; }
        #new-group-name::placeholder { color: #9ca3af; }
        .group-contacts-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--wa-sub); margin: 14px 0 8px; }
        #group-member-list { border-radius: 12px; overflow: hidden; border: 1px solid var(--wa-border); }
        .group-member-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--wa-border); cursor: pointer; transition: background .1s; }
        .group-member-row:last-child { border-bottom: none; }
        .group-member-row:hover { background: var(--wa-input-bg); }
        .group-member-row label { display: flex; align-items: center; gap: 10px; width: 100%; cursor: pointer; }
        .group-member-info { flex: 1; min-width: 0; }
        .group-member-name { font-size: 14px; font-weight: 500; color: var(--wa-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .group-member-email { font-size: 12px; color: var(--wa-sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .group-member-checkbox { width: 18px; height: 18px; accent-color: var(--wa-accent); cursor: pointer; flex-shrink: 0; }
        .group-modal-footer { padding: 14px 16px; border-top: 1px solid var(--wa-border); display: flex; justify-content: flex-end; gap: 10px; background: var(--wa-panel); }
        #cancel-group-modal { font-size: 14px; font-weight: 500; color: var(--wa-sub); padding: 8px 16px; border-radius: 10px; }
        #confirm-create-group { font-size: 14px; font-weight: 600; color: #fff; background: var(--wa-accent); padding: 8px 20px; border-radius: 10px; border: none; cursor: pointer; transition: background .15s; }
        #confirm-create-group:hover:not(:disabled) { background: #4338ca; }
        #confirm-create-group:disabled { background: #e5e7eb; color: #9ca3af; cursor: not-allowed; }

        /* ═══ Drag-over ═══ */
        #chat-messages.wa-drag-over { outline: 2px dashed var(--wa-accent) !important; outline-offset: -12px; }

        /* ═══ Contact list items ═══ */
        .chat-contact {
            display: flex !important; align-items: center !important; gap: 12px !important;
            padding: 10px 14px !important; margin-bottom: 0 !important;
            border-bottom: 1px solid var(--wa-border) !important;
            background: var(--wa-panel) !important; cursor: pointer; transition: background .1s;
        }
        .chat-contact:hover { background: #f9fafb !important; }

        /* ═══ Accessibility ═══ */
        @media (prefers-reduced-motion: reduce) {
            .wa-msg-row, .wa-typing-dots span, #wa-mic-btn.recording { animation: none !important; }
        }
    `;
    // ═══ MOBILE-FIRST RESPONSIVE CHAT ═══════════════════════════════
    // On narrow viewports the sidebar and conversation panel stack as
    // two exclusive "views" that slide in/out. The CSS uses a
    // data-mobile-view attribute on the #page-chat wrapper to control
    // which panel is visible. JS drives the attribute; CSS is purely
    // presentational. This keeps all logic in one place and avoids
    // fighting Tailwind's sm: breakpoints.
    //
    // Breakpoint: < 640px (sm) — matches Tailwind's "sm" prefix.
    // Above 640px: classic side-by-side layout restored.
    const mobileCss = document.createElement('style');
    mobileCss.id = 'chat-mobile-styles';
    mobileCss.textContent = `
        /* ─── Mobile layout foundation ─── */
        @media (max-width: 639px) {
            /* Override page padding so chat fills screen edge-to-edge */
            #page-chat {
                padding-top: 8px !important;
                padding-bottom: 8px !important;
                padding-left: 0 !important;
                padding-right: 0 !important;
            }
            #page-chat .max-w-6xl {
                height: calc(100dvh - 120px);
                min-height: 0;
                padding: 0;
            }
            /* The outer card: remove rounded corners and shadow on mobile so
               it feels like a native full-screen shell */
            #page-chat > div > div {
                border-radius: 12px !important;
                box-shadow: var(--wa-shadow) !important;
                overflow: hidden !important;
                /* Switch from flex-row to a stacked single-panel layout */
                display: block !important;
                position: relative;
            }

            /* ─── Sidebar panel ─── */
            #page-chat .sm\\:w-80 {
                position: absolute !important;
                inset: 0 !important;
                width: 100% !important;
                height: 100% !important;
                z-index: 10;
                /* Slide-in/out via translateX */
                transform: translateX(0);
                transition: transform 280ms cubic-bezier(0.4, 0, 0.2, 1),
                            visibility 0ms linear 0ms;
                visibility: visible;
                will-change: transform;
                /* Contain inner scroll */
                overflow: hidden;
                display: flex !important;
                flex-direction: column !important;
            }

            /* When conversation is active, slide sidebar out to the left */
            #page-chat[data-mobile-view="conversation"] .sm\\:w-80 {
                transform: translateX(-100%);
                visibility: hidden;
                transition: transform 280ms cubic-bezier(0.4, 0, 0.2, 1),
                            visibility 0ms linear 280ms;
                pointer-events: none;
            }

            /* ─── Chat window panel ─── */
            #chat-window {
                position: absolute !important;
                inset: 0 !important;
                width: 100% !important;
                height: 100% !important;
                z-index: 20;
                display: flex !important;
                flex-direction: column !important;
                /* Start off-screen to the right */
                transform: translateX(100%);
                transition: transform 280ms cubic-bezier(0.4, 0, 0.2, 1),
                            visibility 0ms linear 0ms;
                visibility: hidden;
                will-change: transform;
                pointer-events: none;
            }

            /* When conversation is active, slide chat window in from the right */
            #page-chat[data-mobile-view="conversation"] #chat-window {
                transform: translateX(0);
                visibility: visible;
                pointer-events: auto;
                transition: transform 280ms cubic-bezier(0.4, 0, 0.2, 1),
                            visibility 0ms linear 0ms;
            }

            /* ─── Back button (mobile only) ─── */
            #chat-mobile-back-btn {
                display: flex !important;
                align-items: center;
                justify-content: center;
                width: 36px; height: 36px;
                border-radius: 10px;
                border: none;
                background: transparent;
                color: var(--wa-sub);
                cursor: pointer;
                flex-shrink: 0;
                transition: background 0.15s, color 0.15s;
                -webkit-tap-highlight-color: transparent;
                touch-action: manipulation;
                margin-right: 4px;
            }
            #chat-mobile-back-btn:active {
                background: var(--wa-input-bg);
                color: var(--wa-text);
            }

            /* ─── Message area fills available height on mobile ─── */
            #chat-messages {
                padding: 12px 12px 8px !important;
                /* Use dynamic viewport height to account for iOS keyboard */
                flex: 1 1 0% !important;
                min-height: 0 !important;
            }

            /* ─── Input bar: prevent zoom on iOS by ensuring font ≥ 16px ─── */
            #chat-message-input {
                font-size: 16px !important;
            }

            /* ─── Reduce message bubble width on narrow screens ─── */
            .wa-msg-row {
                max-width: 88% !important;
            }

            /* ─── Sidebar items: slightly more touch-friendly ─── */
            .wa-sidebar-item {
                padding: 13px 14px !important;
            }

            /* ─── Attach menu: anchor to bottom of viewport on mobile ─── */
            #wa-attach-menu {
                position: fixed !important;
                bottom: 80px !important;
                left: 12px !important;
                right: 12px !important;
                min-width: 0 !important;
            }

            /* ─── Emoji picker: full-width on mobile ─── */
            #wa-emoji-picker {
                position: fixed !important;
                bottom: 80px !important;
                left: 8px !important;
                right: 8px !important;
                grid-template-columns: repeat(8, 1fr) !important;
                max-height: 180px !important;
                overflow-y: auto !important;
            }

            /* ─── Message context menu: max-width on very narrow screens ─── */
            .wa-msg-dropdown {
                max-width: min(96vw, 288px) !important;
            }

            /* ─── Upload progress: fixed on mobile ─── */
            #wa-attach-progress {
                position: fixed !important;
                bottom: 80px !important;
                left: 12px !important;
                right: 12px !important;
                transform: none !important;
            }

            /* ─── Recording bar: make it larger for touch ─── */
            #wa-recording-bar {
                padding: 12px 14px !important;
            }

            /* ─── Modals: full screen on very small devices ─── */
            #advanced-group-modal > div,
            #chat-members-modal > div,
            #wa-forward-modal > div,
            #wa-starred-modal > div {
                max-width: 100% !important;
                max-height: 92dvh !important;
                border-radius: 16px 16px 0 0 !important;
                position: fixed !important;
                bottom: 0 !important;
                left: 0 !important;
                right: 0 !important;
                top: auto !important;
            }
            #advanced-group-modal,
            #chat-members-modal,
            #wa-forward-modal,
            #wa-starred-modal {
                align-items: flex-end !important;
            }

            /* ─── Message menu trigger: slightly bigger touch target ─── */
            .wa-msg-menu-btn {
                width: 36px !important;
                height: 36px !important;
            }

            /* Ensure active sidebar item unread badges don't overflow */
            .wa-badge { font-size: 10px !important; min-width: 18px !important; height: 18px !important; }
        }

        /* ─── Tablet: 640-767px — side-by-side but narrower sidebar ─── */
        @media (min-width: 640px) and (max-width: 767px) {
            #page-chat .sm\\:w-80 {
                width: 260px !important;
                min-width: 200px;
            }
            #page-chat > div > div { border-radius: 14px !important; }

            /* Hide mobile back button on tablet+ */
            #chat-mobile-back-btn { display: none !important; }
        }

        /* ─── Desktop: 768px+ — back button never shown ─── */
        @media (min-width: 768px) {
            #chat-mobile-back-btn { display: none !important; }

            /* Restore full side-by-side layout */
            #page-chat .sm\\:w-80 {
                position: relative !important;
                transform: none !important;
                visibility: visible !important;
                pointer-events: auto !important;
                width: 320px !important;
            }
            #chat-window {
                position: relative !important;
                transform: none !important;
                visibility: visible !important;
                pointer-events: auto !important;
            }
        }

        /* ─── Safe area insets for PWA / iOS notch ─── */
        @supports (padding-bottom: env(safe-area-inset-bottom)) {
            @media (max-width: 639px) {
                #chat-message-form {
                    padding-bottom: calc(10px + env(safe-area-inset-bottom)) !important;
                }
            }
        }

        /* ─── Orientation change: recalculate heights instantly ─── */
        @media (orientation: landscape) and (max-width: 900px) {
            #page-chat .max-w-6xl {
                height: calc(100dvh - 80px) !important;
            }
            #chat-messages {
                padding: 8px 12px 4px !important;
            }
        }

        /* ─── Reduced motion: skip slide animation, fade instead ─── */
        @media (prefers-reduced-motion: reduce) {
            #page-chat .sm\\:w-80,
            #chat-window {
                transition: opacity 0.15s linear, visibility 0ms linear 0ms !important;
                transform: none !important;
            }
            #page-chat[data-mobile-view="conversation"] .sm\\:w-80 {
                opacity: 0 !important;
                transition: opacity 0.15s linear, visibility 0ms linear 0.15s !important;
            }
            #page-chat[data-mobile-view="conversation"] #chat-window {
                opacity: 1 !important;
            }
        }
    `;
    // Only inject once
    if (!document.getElementById('chat-mobile-styles')) {
        document.head.appendChild(mobileCss);
    }

    document.head.appendChild(s);
}

// ─────────────────────────────────────────────
// MOBILE NAV STATE HELPERS
// ─────────────────────────────────────────────

// Returns true when the viewport is in "mobile single-panel" mode (< 640 px).
// Uses visualViewport.width when available (more accurate on iOS Safari with
// keyboard open or pinch-zoom) and falls back to window.innerWidth.
function _isMobileLayout() {
    const w = (window.visualViewport?.width ?? window.innerWidth);
    return w < 640;
}

// The chat container wrapper that carries data-mobile-view.
// IMPORTANT: This MUST return #page-chat itself because the CSS mobile styles
// are written as `#page-chat[data-mobile-view="conversation"] .sm\:w-80` etc.
// Setting the attribute on any child element breaks all CSS selectors.
function _getChatWrapper() {
    return document.getElementById('page-chat') || null;
}

// Show the conversation panel on mobile, pushing history so Back works.
// Only sets the attribute when on mobile; desktop callers guard with _isMobileLayout().
function _mobileShowConversation() {
    const wrapper = _getChatWrapper();
    if (!wrapper) return;
    // Safety: don't set the attribute if the chat page is currently hidden,
    // as it would persist and confuse the layout when the page becomes visible.
    // The onPageVisit handler will set it correctly when the user navigates to chat.
    if (wrapper.classList.contains('hidden')) return;
    wrapper.setAttribute('data-mobile-view', 'conversation');
    // Push a history entry so the browser Back button returns to the list.
    // Use replaceState if we're already in conversation state (e.g. switching rooms)
    // to avoid stacking duplicate entries.
    if (history.state?.chatView !== 'conversation') {
        history.pushState({ chatView: 'conversation' }, '');
    }
    // Scroll the message list to the bottom (newest message) after paint
    requestAnimationFrame(() => {
        const msgs = document.getElementById('chat-messages');
        if (msgs) msgs.scrollTop = 0; // column-reverse: 0 = bottom
    });
}

// Show the sidebar list on mobile (go "back" to the list)
function _mobileShowList() {
    const wrapper = _getChatWrapper();
    if (!wrapper) return;
    wrapper.removeAttribute('data-mobile-view');
    // Restore focus to the sidebar so keyboard users land somewhere sensible
    // The sidebar has classes "w-full sm:w-80 ..."
    const sidebar = document.querySelector('#page-chat .sm\\:w-80, #page-chat [class*="sm:w-80"]');
    if (sidebar) {
        const firstItem = sidebar.querySelector('.wa-sidebar-item, .chat-contact');
        firstItem?.focus({ preventScroll: true });
    }
}

// Inject the mobile back button into the chat header (called once per openChatRoom).
// The button is always injected (CSS hides it on ≥640px via media query) so that:
//  • It's immediately visible on mobile without requiring JS to re-check width.
//  • Orientation changes from portrait→landscape→portrait don't lose the button.
// We always remove the old button first so switching rooms never leaves a stale one.
function _ensureMobileBackButton(chatHeader, onBack) {
    // Always remove any stale back button from previous room
    document.getElementById('chat-mobile-back-btn')?.remove();

    const btn = document.createElement('button');
    btn.id = 'chat-mobile-back-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Back to chat list');
    btn.setAttribute('title', 'Back');
    btn.innerHTML = `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M15 19l-7-7 7-7"/>
    </svg>`;
    // Insert as the very first child of the .ch-inner div inside the header
    const chInner = chatHeader.querySelector('.ch-inner');
    if (chInner) {
        chInner.insertBefore(btn, chInner.firstChild);
    } else {
        chatHeader.insertBefore(btn, chatHeader.firstChild);
    }
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onBack();
    }, { passive: false });
}

// ─────────────────────────────────────────────
// RECORDING HELPERS
// FIX: use recordingCancelled flag so chunks aren't cleared before onstop fires
// ─────────────────────────────────────────────
function stopRecording(cancel = false) {
    if (!isRecording) return;
    isRecording        = false;
    recordingCancelled = cancel;
    clearInterval(recordingTimer);
    recordingTimer = null; // FIX: null after clear, consistent with _hbInterval pattern
    document.getElementById('wa-recording-bar')?.remove();
    const btn = document.getElementById('wa-mic-btn');
    if (btn) btn.classList.remove('recording');
    // FIX (voice): request final data flush before stopping so no chunk is dropped
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        if (!cancel && mediaRecorder.state === 'recording') {
            try { mediaRecorder.requestData(); } catch (_e) { /* ignore */ }
        }
        mediaRecorder.stop();
    } else {
        mediaRecorder = null;
    }
}

function stopAndSendRecording() {
    if (!isRecording || !mediaRecorder) return;
    recordingCancelled = false;
    stopRecording(false);
}

// ─────────────────────────────────────────────
// GALLERY LIGHTBOX
// Full-screen viewer with prev/next navigation, zoom (images), custom
// video player, and download. Supports both multi-attachment messages
// (all attachments browseable) and legacy single-image messages.
//
// openGallery(items, startIndex)
//   items: [{ url, type, name }]  — type: 'image'|'video'|'audio'|'document'
//   startIndex: which item to show first
//
// openLightbox(url) — backwards-compatible shim for legacy .msg-image clicks
// ─────────────────────────────────────────────

function openGallery(items, startIndex = 0) {
    if (!items?.length) return;
    // Validate + filter to viewable items (image / video); others just download
    const viewable = items.filter(it => {
        const safe = safeUrl(it.url || '');
        return safe && (it.type === 'image' || it.type === 'video');
    });
    if (!viewable.length) return;

    // Clamp startIndex to viewable array
    let idx = Math.max(0, Math.min(startIndex, viewable.length - 1));

    document.getElementById('wa-lightbox')?.remove();

    // ── Inject gallery CSS once ──
    if (!document.getElementById('wa-gallery-styles')) {
        const gs = document.createElement('style');
        gs.id = 'wa-gallery-styles';
        gs.textContent = `
        #wa-lightbox {
            position: fixed; inset: 0; z-index: 9999;
            background: rgba(0,0,0,.93);
            display: flex; flex-direction: column;
            align-items: center; justify-content: center;
            animation: walbIn .18s ease-out;
        }
        @keyframes walbIn { from { opacity:0; } to { opacity:1; } }
        #wa-lightbox .wa-lb-toolbar {
            position: absolute; top: 0; left: 0; right: 0;
            display: flex; align-items: center; justify-content: space-between;
            padding: 12px 16px; gap: 12px;
            background: linear-gradient(to bottom, rgba(0,0,0,.7) 0%, transparent 100%);
            z-index: 2;
        }
        #wa-lightbox .wa-lb-counter {
            color: rgba(255,255,255,.8); font-size: 13px; font-weight: 600;
            letter-spacing: .04em; flex-shrink: 0;
        }
        #wa-lightbox .wa-lb-filename {
            flex: 1; color: rgba(255,255,255,.7); font-size: 13px;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            text-align: center;
        }
        #wa-lightbox .wa-lb-actions {
            display: flex; gap: 6px; flex-shrink: 0;
        }
        #wa-lightbox .wa-lb-btn {
            width: 36px; height: 36px; border-radius: 50%;
            border: none; cursor: pointer;
            background: rgba(255,255,255,.14); color: #fff;
            display: flex; align-items: center; justify-content: center;
            transition: background .15s; font-size: 16px;
        }
        #wa-lightbox .wa-lb-btn:hover { background: rgba(255,255,255,.28); }
        #wa-lightbox .wa-lb-btn:disabled { opacity: .3; cursor: default; }
        #wa-lightbox .wa-lb-media-wrap {
            flex: 1; display: flex; align-items: center; justify-content: center;
            width: 100%; max-width: 1280px; padding: 64px 60px 64px;
            position: relative; overflow: hidden;
        }
        #wa-lightbox .wa-lb-img {
            max-width: 100%; max-height: 100%;
            object-fit: contain; border-radius: 6px;
            cursor: zoom-in; user-select: none;
            transition: transform .2s, opacity .15s;
        }
        #wa-lightbox .wa-lb-img.zoomed { cursor: zoom-out; }
        #wa-lightbox .wa-lb-video {
            max-width: 100%; max-height: 100%;
            border-radius: 6px;
        }
        #wa-lightbox .wa-lb-nav {
            position: absolute; top: 50%; transform: translateY(-50%);
            width: 44px; height: 44px; border-radius: 50%;
            border: none; cursor: pointer;
            background: rgba(255,255,255,.15); color: #fff;
            display: flex; align-items: center; justify-content: center;
            transition: background .15s; z-index: 3;
            font-size: 22px; font-weight: 300;
        }
        #wa-lightbox .wa-lb-nav:hover { background: rgba(255,255,255,.3); }
        #wa-lightbox .wa-lb-nav:disabled { opacity: .2; cursor: default; }
        #wa-lightbox .wa-lb-prev { left: 10px; }
        #wa-lightbox .wa-lb-next { right: 10px; }
        #wa-lightbox .wa-lb-dots {
            position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%);
            display: flex; gap: 6px; z-index: 2;
        }
        #wa-lightbox .wa-lb-dot {
            width: 7px; height: 7px; border-radius: 50%;
            background: rgba(255,255,255,.35); transition: background .15s;
        }
        #wa-lightbox .wa-lb-dot.active { background: #fff; }
        @media (max-width: 600px) {
            #wa-lightbox .wa-lb-media-wrap { padding: 56px 40px 56px; }
            #wa-lightbox .wa-lb-nav { width: 36px; height: 36px; font-size: 18px; }
        }`;
        document.head.appendChild(gs);
    }

    const box = document.createElement('div');
    box.id = 'wa-lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Media viewer');
    document.body.appendChild(box);

    // Prevent body scroll
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    let _zoomed    = false;
    let _zoomScale = 1;

    function renderSlide() {
        const item = viewable[idx];
        const safe = safeUrl(item.url);

        box.innerHTML = `
        <div class="wa-lb-toolbar">
            <span class="wa-lb-counter">${viewable.length > 1 ? `${idx + 1} / ${viewable.length}` : ''}</span>
            <span class="wa-lb-filename">${sanitize(item.name || '')}</span>
            <div class="wa-lb-actions">
                <a class="wa-lb-btn" id="wa-lb-download" title="Download" download
                   href="${safe}" target="_blank" rel="noopener noreferrer"
                   style="text-decoration:none">
                    <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                </a>
                <button class="wa-lb-btn" id="wa-lb-close" title="Close" aria-label="Close">
                    <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
            </div>
        </div>
        <div class="wa-lb-media-wrap" id="wa-lb-media-wrap">
            ${viewable.length > 1
                ? `<button class="wa-lb-nav wa-lb-prev" id="wa-lb-prev" aria-label="Previous"${idx === 0 ? ' disabled' : ''}>&#8249;</button>
                   <button class="wa-lb-nav wa-lb-next" id="wa-lb-next" aria-label="Next"${idx === viewable.length - 1 ? ' disabled' : ''}>&#8250;</button>`
                : ''}
            ${item.type === 'video'
                ? `<video class="wa-lb-video" src="${safe}" controls autoplay playsinline preload="metadata"></video>`
                : `<img class="wa-lb-img" id="wa-lb-img" src="${safe}" alt="${sanitize(item.name || 'Image')}" draggable="false">`}
            ${viewable.length > 1
                ? `<div class="wa-lb-dots">${viewable.map((_, i) =>
                    `<div class="wa-lb-dot${i === idx ? ' active' : ''}"></div>`).join('')}</div>`
                : ''}
        </div>`;

        _zoomed = false; _zoomScale = 1;

        // Wire close
        document.getElementById('wa-lb-close')?.addEventListener('click', closeLightbox);

        // Wire prev/next
        document.getElementById('wa-lb-prev')?.addEventListener('click', e => { e.stopPropagation(); if (idx > 0) { idx--; renderSlide(); } });
        document.getElementById('wa-lb-next')?.addEventListener('click', e => { e.stopPropagation(); if (idx < viewable.length - 1) { idx++; renderSlide(); } });

        // Image zoom toggle
        const imgEl = document.getElementById('wa-lb-img');
        if (imgEl) {
            imgEl.addEventListener('click', e => {
                e.stopPropagation();
                _zoomed = !_zoomed;
                _zoomScale = _zoomed ? 2.2 : 1;
                imgEl.style.transform = `scale(${_zoomScale})`;
                imgEl.classList.toggle('zoomed', _zoomed);
            });
        }

        // Background click closes (but not when zoomed into image)
        box.addEventListener('click', e => {
            if (e.target === box || e.target.id === 'wa-lb-media-wrap') {
                if (_zoomed) { _zoomed = false; _zoomScale = 1; const el = document.getElementById('wa-lb-img'); if (el) { el.style.transform = ''; el.classList.remove('zoomed'); } }
                else closeLightbox();
            }
        }, { once: false });
    }

    function closeLightbox() {
        box.remove();
        document.body.style.overflow = prevOverflow;
        document.removeEventListener('keydown', _onKey);
    }

    function _onKey(e) {
        if (!document.getElementById('wa-lightbox')) { document.removeEventListener('keydown', _onKey); return; }
        if (e.key === 'Escape')     { closeLightbox(); }
        if (e.key === 'ArrowLeft'  && idx > 0)                    { idx--; renderSlide(); }
        if (e.key === 'ArrowRight' && idx < viewable.length - 1)  { idx++; renderSlide(); }
    }
    document.addEventListener('keydown', _onKey);

    // Touch swipe support
    let _touchX = null;
    box.addEventListener('touchstart', e => { _touchX = e.touches[0].clientX; }, { passive: true });
    box.addEventListener('touchend', e => {
        if (_touchX === null) return;
        const dx = e.changedTouches[0].clientX - _touchX;
        _touchX = null;
        if (Math.abs(dx) < 40) return;
        if (dx < 0 && idx < viewable.length - 1) { idx++; renderSlide(); }
        if (dx > 0 && idx > 0)                   { idx--; renderSlide(); }
    }, { passive: true });

    renderSlide();
}

// Legacy shim: single image lightbox → gallery with one item
function openLightbox(url, name = '') {
    const safe = safeUrl(url);
    if (!safe) return;
    openGallery([{ url: safe, type: 'image', name }], 0);
}

// ─────────────────────────────────────────────
// FORWARD MODAL — light theme
// ─────────────────────────────────────────────
// Forward a single attachment from a multi-attachment message.
// Creates a new message in the target room containing only the selected file,
// preserving the forwarded:true flag so recipients see the forward indicator.
async function openForwardSingleAttachment(sourceMsg, att) {
    if (!requireAuth()) return;
    document.getElementById('wa-forward-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'wa-forward-modal';
    const typeIcon = att.type === 'image' ? '📷' : att.type === 'video' ? '🎥' : att.type === 'audio' ? '🎤' : '📎';
    modal.innerHTML = `
        <div id="wa-forward-card">
            <div class="wa-fwd-header">
                <span class="wa-fwd-title">Forward ${typeIcon} ${sanitize(att.name || 'attachment')} to…</span>
                <button id="wa-fwd-close" style="background:none;border:none;cursor:pointer;color:var(--wa-sub);font-size:18px;padding:4px" aria-label="Close">✕</button>
            </div>
            <div id="wa-fwd-list" style="overflow-y:auto;flex:1;padding:8px 0">
                <div style="text-align:center;color:var(--wa-sub);padding:20px;font-size:14px">Loading…</div>
            </div>
        </div>`;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.getElementById('wa-fwd-close').addEventListener('click', close);

    try {
        const snap  = await getDocs(query(collection(db, 'chats'), where('members', 'array-contains', currentUser.email)));
        const chats = [];
        snap.forEach(d => { if (d.id !== activeRoomId) chats.push({ id: d.id, ...d.data() }); });
        let html = '';
        chats.forEach(c => {
            const name = c.type === 'group'
                ? sanitize(c.name || '')
                : sanitize(c.memberNames?.find(n => n !== currentUser.name) || 'Unknown');
            html += `<div class="wa-sidebar-item" data-fwd-room="${c.id}">
                ${avatarEl(name, c.type || 'private', false, 40)}
                <span style="color:var(--wa-text);font-size:14px;font-weight:500">${sanitize(name)}</span>
            </div>`;
        });
        document.getElementById('wa-fwd-list').innerHTML =
            html || '<div style="text-align:center;color:var(--wa-sub);padding:20px;font-size:14px">No other conversations</div>';

        document.querySelectorAll('[data-fwd-room]').forEach(el => {
            el.addEventListener('click', async () => {
                const toRoom = el.dataset.fwdRoom;
                try {
                    // Forward as a single-attachment message
                    const payload = {
                        senderEmail: currentUser.email, senderName: currentUser.name,
                        createdAt:   serverTimestamp(), seenBy: [],
                        text:        '',
                        forwarded:   true,
                        attachments: [{
                            url:  att.url,
                            type: att.type,
                            mime: att.mime || '',
                            name: att.name || '',
                            size: att.size || 0,
                        }],
                    };
                    const _rSnap  = await getDoc(doc(db, 'chats', toRoom)).catch(() => null);
                    const _rData  = _rSnap?.data();
                    const _rMembers = _rData?.members || [];
                    const _lastMsg  = `${typeIcon} ${att.name || 'Attachment'}`;
                    const _update   = {
                        lastMessage: _lastMsg, lastSenderEmail: currentUser.email,
                        lastUpdated: serverTimestamp(),
                        [`unreadCount.${currentUser.email}`]: 0,
                    };
                    if (_rData?.type === 'private') {
                        const _recip = _rMembers.find(e => e !== currentUser.email);
                        if (_recip) _update[`unreadCount.${_recip}`] = increment(1);
                    } else if (_rData?.type === 'group') {
                        for (const _gm of _rMembers) {
                            if (_gm && _gm !== currentUser.email) _update[`unreadCount.${_gm}`] = increment(1);
                        }
                    }
                    const _batch = writeBatch(db);
                    const _mRef  = doc(collection(db, `chats/${toRoom}/messages`));
                    _batch.set(_mRef, payload);
                    _batch.set(doc(db, 'chats', toRoom), _update, { merge: true });
                    await _batch.commit();
                    showToast('Attachment forwarded!', 'success');
                } catch (err) { console.error('[Chat] fwd-att error:', err); showToast('Failed to forward.', 'error'); }
                close();
            });
        });
    } catch (err) { console.error('[Chat] fwd-att-list error:', err); close(); showToast('Could not load conversations.', 'error'); }
}

async function openForwardModal(msgId) {
    // FIX AUTH-GUARD: verify auth before opening forward modal
    if (!requireAuth()) return;
    document.getElementById('wa-forward-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'wa-forward-modal';
    modal.innerHTML = `
        <div id="wa-forward-card">
            <div class="wa-fwd-header">
                <span class="wa-fwd-title">Forward to…</span>
                <button id="wa-fwd-close" class="" aria-label="Close">✕</button>
            </div>
            <div id="wa-fwd-list" style="overflow-y:auto;flex:1;padding:8px 0">
                <div style="text-align:center;color:var(--wa-sub);padding:20px;font-size:14px">Loading…</div>
            </div>
        </div>`;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.getElementById('wa-fwd-close').addEventListener('click', close);
    document.getElementById('wa-fwd-close').style.cssText = 'background:none;border:none;cursor:pointer;color:var(--wa-sub);font-size:18px;padding:4px';

    const msg = lastMessagesSnapshot.find(m => m.id === msgId);
    if (!msg) { close(); return; }

    try {
        const snap  = await getDocs(query(collection(db, 'chats'), where('members', 'array-contains', currentUser.email)));
        const chats = [];
        snap.forEach(d => { if (d.id !== activeRoomId) chats.push({ id: d.id, ...d.data() }); });

        let html = '';
        chats.forEach(c => {
            const isGroup = c.type === 'group';
            const name    = isGroup
                ? sanitize(c.name || '')
                : sanitize(c.memberNames?.find(n => n !== currentUser.name) || 'Unknown'); // FIX #2: sanitize before innerHTML
            html += `<div class="wa-sidebar-item" data-fwd-room="${c.id}">
                ${avatarEl(name, c.type || 'private', false, 40)}
                <span style="color:var(--wa-text);font-size:14px;font-weight:500">${sanitize(name)}</span>
            </div>`;
        });

        document.getElementById('wa-fwd-list').innerHTML =
            html || '<div style="text-align:center;color:var(--wa-sub);padding:20px;font-size:14px">No other conversations</div>';

        document.querySelectorAll('[data-fwd-room]').forEach(el => {
            el.addEventListener('click', async () => {
                const toRoom = el.dataset.fwdRoom;
                try {
                    const payload = {
                        senderEmail: currentUser.email, senderName: currentUser.name,
                        createdAt: serverTimestamp(), seenBy: [], text: msg.text || '',
                        forwarded: true
                    };
                    if (msg.imageUrl)  payload.imageUrl  = msg.imageUrl;
                    if (msg.voiceUrl)  { payload.voiceUrl = msg.voiceUrl; payload.voiceDuration = msg.voiceDuration || 0; }
                    if (msg.fileUrl)   { payload.fileUrl  = msg.fileUrl;  payload.fileName = msg.fileName; payload.fileMime = msg.fileMime; }
                    await addDoc(collection(db, `chats/${toRoom}/messages`), payload);
                    // FIX #15: getDoc instead of unsupported where('__name__')
                    const _fwdTargetSnap = await getDoc(doc(db, 'chats', toRoom)).catch(() => null);
                    const _fwdTargetData = _fwdTargetSnap?.data();
                    const _fwdUpdate = {
                        lastMessage: msg.text || (msg.imageUrl ? '📷 Photo' : '📎 File'),
                        lastSenderEmail: currentUser.email, lastUpdated: serverTimestamp(),
                        [`unreadCount.${currentUser.email}`]: 0
                    };
                    const _fwdMembers = _fwdTargetData?.members || [];
                    if (_fwdTargetData?.type === 'private') {
                        const _fwdRecip = _fwdMembers.find(e => e !== currentUser.email);
                        if (_fwdRecip) {
                            _fwdUpdate[`unreadCount.${_fwdRecip}`] = increment(1);
                        }
                    } else if (_fwdTargetData?.type === 'group') {
                        // FIX #3: bump all group members except sender
                        for (const _gm of _fwdMembers) {
                            if (_gm && _gm !== currentUser.email) {
                                _fwdUpdate[`unreadCount.${_gm}`] = increment(1);
                            }
                        }
                    }
                    await setDoc(doc(db, 'chats', toRoom), _fwdUpdate, { merge: true });
                    showToast('Message forwarded!', 'success');
                } catch (err) { console.error('[Chat] forward error:', err); showToast('Failed to forward.', 'error'); }
                close();
            });
        });
    } catch (err) { console.error('[Chat] load-conversations error:', err); showToast('Failed to load conversations.', 'error'); close(); }
}

// ─────────────────────────────────────────────
// STARRED MESSAGES PANEL — light theme
// ─────────────────────────────────────────────
function openStarredPanel() {
    document.getElementById('wa-starred-modal')?.remove();
    const modal   = document.createElement('div');
    modal.id      = 'wa-starred-modal';
    const starred = lastMessagesSnapshot.filter(m => starredMessages.has(m.id));
    let innerHTML  = '';
    if (!starred.length) {
        innerHTML = `<div class="wa-starred-empty">No starred messages in this chat</div>`;
    } else {
        starred.forEach(m => {
            const isMe = m.senderEmail === currentUser.email;
            const name = isMe ? 'You' : sanitize(m.senderName || '');
            const text = m.text     ? sanitize(m.text)
                       : m.imageUrl ? '📷 Photo'
                       : m.voiceUrl ? '🎤 Voice note'
                       : '📎 File';
            innerHTML += `<div class="wa-starred-item">
                <span style="font-size:16px">⭐</span>
                <div>
                    <div class="wa-starred-item-name">${name}</div>
                    <div class="wa-starred-item-text">${text}</div>
                </div>
            </div>`;
        });
    }
    modal.innerHTML = `
        <div id="wa-starred-card">
            <div class="wa-starred-header">
                <span class="wa-starred-title">⭐ Starred Messages</span>
                <button id="wa-starred-close" aria-label="Close">✕</button>
            </div>
            <div style="overflow-y:auto;flex:1">${innerHTML}</div>
        </div>`;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.getElementById('wa-starred-close').addEventListener('click', close);
}

// ─────────────────────────────────────────────
// STARRED MESSAGES SUBSCRIPTION
// FIX BUG-STARRED: Previously the messages onSnapshot callback called getDoc() for
// the starred document on EVERY snapshot event (reactions, read-receipts, edits all
// trigger a new snapshot).  That is O(snapshots) extra Firestore reads per room open.
// Now a single onSnapshot listener tracks the starred document reactively: it fires
// only when the user actually stars/unstars a message, keeping starredMessages in sync
// without any redundant reads inside the messages listener.
// ─────────────────────────────────────────────
function subscribeStarred(roomId) {
    starredSub?.(); starredSub = null;
    if (!roomId || !currentUser?.email) return;
    const starredRef = doc(db, `chats/${roomId}/starred`, currentUser.email);
    starredSub = onSnapshot(starredRef, snap => {
        starredMessages.clear();
        if (snap.exists()) {
            const ids = snap.data().ids || [];
            ids.forEach(id => {
                if (typeof id === 'string' && id.length > 0 && id.length < 200 && !/[\s/]/.test(id)) {
                    starredMessages.add(id);
                }
            });
        }
        // Re-render so star badges are always accurate without an extra read.
        renderMessages();
    }, () => {
        // Non-fatal: starred fetch failed — leave starredMessages as-is.
    });
}

// ─────────────────────────────────────────────
// TYPING SUBSCRIPTION (with server-side TTL awareness)
// ─────────────────────────────────────────────
function subscribeTypingIndicator(roomId, chatType) {
    // BUG FIX: unsubscribe existing listener before creating a new one
    typingSub?.(); typingSub = null;
    const typingCol = collection(db, `chats/${roomId}/typing`);
    typingSub = onSnapshot(typingCol, snap => {
        let typingName = null;
        const now      = Date.now();
        snap.forEach(d => {
            const data = d.data();
            if (d.id === currentUser.email) return;
            if (!data.typing) return;
            // Treat as stale if no update in TYPING_TTL_MS (server-side not enforced, so we do it client-side)
            const updatedMs = data.updatedAt?.toMillis?.() || 0;
            if (now - updatedMs > TYPING_TTL_MS) return;
            typingName = data.name || d.id;
        });

        const existing = document.getElementById('chat-typing-indicator');
        const chatContainer = document.getElementById('chat-messages');
        if (!chatContainer) return;

        if (typingName) {
            if (!existing) {
                // FIX Bug 3: chat-messages uses flex-direction:column-reverse.
                // 'beforeend' puts the element at the DOM end → visually at the TOP.
                // 'afterbegin' puts it at the DOM start → visually at the BOTTOM, below the newest message.
                chatContainer.insertAdjacentHTML('afterbegin', buildTypingIndicatorHTML(typingName));
            } else {
                const label = existing.querySelector('.wa-typing-label');
                if (label) label.textContent = `${typingName} is typing`;
            }
        } else if (existing) {
            existing.remove();
        }
    }, () => {});
}

// ─────────────────────────────────────────────
// MARK ROOM READ
// ─────────────────────────────────────────────
function markRoomRead(roomId) {
    if (!roomId || !currentUser?.email) return;
    // FIX: mark pending immediately so snapshot re-renders don't restore the badge
    // before the serverTimestamp() resolves from null → real value
    _pendingReadRooms.add(roomId);
    setDoc(doc(db, 'chats', roomId), {
        [`lastRead.${currentUser.email}`]: serverTimestamp(),
        [`unreadCount.${currentUser.email}`]: 0
    }, { merge: true }).then(() => {
        _pendingReadRooms.delete(roomId);
    }).catch(() => {
        _pendingReadRooms.delete(roomId);
    });

    // FIX BUG 5: read cleared count from _roomUnreadMap (set by the snapshot)
    // instead of scraping the DOM. The DOM may be filtered, hidden, or not yet
    // rendered — making DOM-based clearedCount unreliable and leaving the nav
    // badge non-zero even after the room is opened.
    const clearedCount = _roomUnreadMap.get(roomId) || 0;
    _roomUnreadMap.set(roomId, 0); // zero it immediately

    // Also clear the visual badge in the DOM if the item is currently visible.
    document.querySelectorAll(`.wa-sidebar-item[data-email]`).forEach(item => {
        const itemRoomId = item.dataset.type === 'group'
            ? item.dataset.email
            : getPrivateRoomId(currentUser.email, item.dataset.email);
        if (itemRoomId !== roomId) return;
        item.querySelector('.wa-badge[data-count]')?.remove();
        item.querySelector('.wa-sidebar-name')?.classList.remove('wa-sidebar-name--unread');
        item.querySelector('.wa-sidebar-time')?.classList.remove('wa-sidebar-time--unread');
        item.querySelector('.wa-sidebar-preview')?.classList.remove('wa-sidebar-preview--unread');
    });

    // Recompute the nav-level badge immediately (subtract this room's count)
    _totalUnread = Math.max(0, _totalUnread - clearedCount);
    _recomputeNavBadge();
}
function _recomputeNavBadge() {
    // Use the module-level _totalUnread counter (kept in sync by loadRecentChats
    // snapshot and decremented in markRoomRead) instead of re-summing DOM badges.
    // Re-reading the DOM here is unreliable because markRoomRead may have already
    // removed the badge node for the just-opened room before this function runs.
    // FIX: if no authenticated user exists, force total to 0 so a signed-out
    // state never shows a stale unread indicator from the previous session.
    const total = currentUser ? _totalUnread : 0;
    const navDot = document.getElementById('chat-nav-indicator');
    if (!navDot) return;
    if (total === 0) {
        // FIX Bug 5: explicitly reset pill shape and content when total hits zero.
        // Relying solely on classList.toggle left chat-nav-dot--count in place if the
        // element was briefly un-hidden (e.g. CSS transition race), showing an empty pill.
        navDot.classList.add('hidden');
        navDot.classList.remove('chat-nav-dot--count');
        navDot.textContent = '';
    } else {
        navDot.classList.remove('hidden');
        navDot.classList.toggle('chat-nav-dot--count', true);
        navDot.textContent = total > 99 ? '99+' : String(total);
    }
}

// FIX Bug 1: track message IDs for which we've already fired a seenBy write this
// session so each updateDoc is sent at most once per room-open, not once per snapshot.
// The Set is keyed by "roomId:msgId" so switching rooms resets nothing incorrectly.
const _seenBySubmitted = new Set();

function markMessagesSeenBy(roomId) {
    if (!roomId || !currentUser?.email) return;
    const unseen = lastMessagesSnapshot.filter(m =>
        m.senderEmail !== currentUser.email &&
        m.senderEmail !== 'system' &&   // FIX: system messages have no seenBy — skip them
        !m.seenBy?.includes(currentUser.email) &&
        !m.isDeletedForEveryone &&
        !m._pending && !m._failed &&
        // FIX Bug 1: skip if we've already submitted the write for this message
        !_seenBySubmitted.has(`${roomId}:${m.id}`)
    );
    // FIX: skip the whole write loop if there's nothing to mark (saves Firestore reads on every snapshot)
    if (!unseen.length) return;
    unseen.forEach(m => {
        const key = `${roomId}:${m.id}`;
        _seenBySubmitted.add(key); // mark before the write so concurrent snapshots don't re-submit
        updateDoc(doc(db, `chats/${roomId}/messages`, m.id), {
            seenBy: arrayUnion(currentUser.email)
        }).catch(() => {
            _seenBySubmitted.delete(key); // allow retry on transient failure
        });
    });
}

// ─────────────────────────────────────────────
// SEARCH BAR
// ─────────────────────────────────────────────
function openSearchBar(chatHeader) {
    if (document.getElementById('chat-search-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'chat-search-bar';
    bar.innerHTML = `
        <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="flex-shrink:0;color:var(--wa-sub)">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"/>
        </svg>
        <input id="chat-search-input" placeholder="Search in conversation…" aria-label="Search messages">
        <button id="chat-search-close" style="background:none;border:none;cursor:pointer;color:var(--wa-sub);font-size:18px;padding:4px;border-radius:6px" aria-label="Close search">✕</button>`;
    chatHeader.insertAdjacentElement('afterend', bar);
    document.getElementById('chat-search-input')?.focus();
    document.getElementById('chat-search-input')?.addEventListener('input', e => {
        searchQueryText = e.target.value;
        searchActive    = !!searchQueryText.trim();
        renderMessages();
    });
    document.getElementById('chat-search-close')?.addEventListener('click', closeSearchBar);
}

function closeSearchBar() {
    document.getElementById('chat-search-bar')?.remove();
    searchActive    = false;
    searchQueryText = '';
    renderMessages();
}

// ─────────────────────────────────────────────
// REPLY PREVIEW BAR
// ─────────────────────────────────────────────
function showReplyPreview(msg, chatHeader, input) {
    document.getElementById('wa-reply-preview')?.remove();
    replyingTo = {
        id: msg.id, text: msg.text || '', senderName: msg.senderName,
        senderEmail: msg.senderEmail, imageUrl: msg.imageUrl || '',
        voiceUrl: msg.voiceUrl || '', fileUrl: msg.fileUrl || '', fileName: msg.fileName || ''
    };
    const isMe  = msg.senderEmail === currentUser.email;
    const label = isMe ? 'You' : sanitize(msg.senderName || 'Someone');
    const text  = msg.imageUrl  ? '📷 Photo'
                : msg.voiceUrl  ? '🎤 Voice note'
                : msg.fileUrl   ? `📎 ${sanitize(msg.fileName || 'File')}`
                : sanitize(msg.text || '');
    const bar = document.createElement('div');
    bar.id = 'wa-reply-preview';
    bar.innerHTML = `
        <div class="wa-rp-line"></div>
        <div class="wa-rp-content">
            <span class="wa-rp-name">↩ Replying to ${label}</span>
            <span class="wa-rp-text">${text}</span>
        </div>
        <button id="wa-reply-close" aria-label="Cancel reply">
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>`;
    // Insert before the form
    const form = document.getElementById('chat-message-form');
    form?.parentElement?.insertBefore(bar, form);
    document.getElementById('wa-reply-close')?.addEventListener('click', () => {
        replyingTo = null;
        bar.remove();
    });
    input.focus();
}

// ─────────────────────────────────────────────
// EMOJI PICKER
// ─────────────────────────────────────────────
function toggleEmojiPicker(input) {
    const existing = document.getElementById('wa-emoji-picker');
    if (existing) { existing.remove(); emojiPickerVisible = false; return; }
    const picker = document.createElement('div');
    picker.id = 'wa-emoji-picker';
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', 'Emoji picker');
    picker.innerHTML = EMOJI_LIST.map(e =>
        `<button class="wa-ep-btn" aria-label="${e}">${e}</button>`
    ).join('');
    const inputArea = input.closest('form') || input.parentElement;
    (inputArea?.parentElement || document.body).appendChild(picker);
    emojiPickerVisible = true;
    picker.querySelectorAll('.wa-ep-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const pos = input.selectionStart ?? input.value.length;
            input.value = input.value.slice(0, pos) + btn.textContent + input.value.slice(pos);
            input.dispatchEvent(new Event('input'));
            input.selectionStart = input.selectionEnd = pos + btn.textContent.length;
            input.focus();
        });
    });
    setTimeout(() => {
        document.addEventListener('click', function hide(e) {
            if (!picker.contains(e.target)) {
                picker.remove();
                emojiPickerVisible = false;
                document.removeEventListener('click', hide);
            }
        });
    }, 0);
}

// ─────────────────────────────────────────────
// TYPING HANDLER
// ─────────────────────────────────────────────
function handleInputTyping() {
    if (!activeRoomId) return;
    if (!isCurrentlyTyping) {
        isCurrentlyTyping = true;
        writeTypingStateThrottled(activeRoomId, true);
    }
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        isCurrentlyTyping = false;
        writeTypingState(activeRoomId, false);
    }, TYPING_TTL_MS);
}

// ─────────────────────────────────────────────
// RENDER MESSAGES
// ─────────────────────────────────────────────
function renderMessages() {
    const chatContainer = document.getElementById('chat-messages');
    if (!chatContainer || !activeRoomDetails) return;
    const chatType = activeRoomDetails.type;
    if (!lastMessagesSnapshot.length) {
        chatContainer.innerHTML = `
            <div class="w-full h-full flex items-center justify-center">
                <div style="background:rgba(255,255,255,.9);border:1px solid var(--wa-border);padding:10px 20px;border-radius:12px;color:var(--wa-sub);font-size:13px;text-align:center">
                    🔒 End-to-end encrypted<br>
                    <span style="color:var(--wa-text);font-weight:500">Say hi to ${sanitize(activeRoomDetails.targetName)}!</span>
                </div>
            </div>`;
        return;
    }

    // lastMessagesSnapshot is newest-first (desc from Firestore).
    // #chat-messages uses flex-direction:column-reverse, so the FIRST DOM child
    // renders at the BOTTOM of the viewport. Iterating newest→oldest places the
    // newest message at the bottom (correct chat behaviour).
    //
    // Date dividers: when iterating newest→oldest, emit the divider AFTER the
    // last message of each day group (i.e. when the date changes or we reach the
    // end of the list). In the DOM the divider sits after the group, but
    // column-reverse flips it visually ABOVE the group — exactly where it belongs.
    const msgs = lastMessagesSnapshot; // newest → oldest (no copy needed)
    let html = '';

    for (let i = 0; i < msgs.length; i++) {
        const msg     = msgs[i];
        const dateKey = msg.createdAt?.toDate ? msg.createdAt.toDate().toDateString() : '';

        // buildMessageHTML receives index i which is the position in the
        // newest-first array — used internally to find the "older" neighbour
        // via index+1, which is correct for newest-first ordering.
        html += buildMessageHTML(msg, i, msgs, chatType);

        // After writing this message, check whether the next one belongs to a
        // different day (or this is the last message). If so, close the current
        // day group with its divider. column-reverse will render this divider
        // visually ABOVE the group it follows in the DOM.
        const nextMsg     = msgs[i + 1];
        const nextDateKey = nextMsg?.createdAt?.toDate ? nextMsg.createdAt.toDate().toDateString() : null;

        if (dateKey && dateKey !== nextDateKey) {
            const label = msg.createdAt?.toDate
                ? msg.createdAt.toDate().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
                : '';
            if (label) html += `<div class="wa-date-divider">${label}</div>`;
        }
    }

    chatContainer.innerHTML = html;
}

// ─────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────
export function setupChat() {
    ensureChatStyles();

    const recentList         = document.getElementById('chat-recent-list');
    const usersListContainer = document.getElementById('chat-users-list');
    const usersListContent   = document.getElementById('chat-users-list-content');
    const input              = document.getElementById('chat-message-input');
    const sendBtn            = document.getElementById('send-msg-btn');
    const attachBtn          = document.getElementById('chat-attachment-btn');
    const chatContainer      = document.getElementById('chat-messages');
    const chatHeader         = document.getElementById('chat-header');
    const imageAttachInput   = getAttachInput('image/*', 'chat-attach-image-input');
    const fileAttachInput    = getAttachInput('*/*', 'chat-attach-file-input');
    const videoAttachInput   = getAttachInput('video/*', 'chat-attach-video-input');

    if (!chatContainer || !chatHeader || !input || !sendBtn) {
        console.error('[Chat] Required DOM elements not found.');
        return;
    }
    if (chatContainer.dataset.chatWired === 'true') return;
    chatContainer.dataset.chatWired = 'true';

    input.disabled   = true;
    sendBtn.disabled = true;
    if (attachBtn) attachBtn.disabled = true;

    // Auto-grow textarea
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    // ── Sidebar search filter ──────────────────
    const sidebarSearchInput = document.getElementById('sidebar-search-input');
    // FIX: extract filter logic so it can be re-applied after recentList re-renders
    function _applyContactFilter() {
        const q = (sidebarSearchInput?.value || '').toLowerCase().trim();
        // FIX: when query is cleared, un-hide all items that were hidden by a
        // previous filter — previously the early return left them hidden forever.
        document.querySelectorAll('.wa-sidebar-item').forEach(item => {
            item.style.display = (!q || (item.dataset.name || '').toLowerCase().includes(q)) ? '' : 'none';
        });
    }
    if (sidebarSearchInput) {
        sidebarSearchInput.addEventListener('input', () => _applyContactFilter());
    }

    // ── Tab toggle ──────────────────────────────
    const toggleTabs = (activeBtnId, inactiveBtnId, showEl, hideEl) => {
        const ab = document.getElementById(activeBtnId);
        const ib = document.getElementById(inactiveBtnId);
        if (!ab || !ib) return;
        ab.classList.add('wa-tab-btn--active');
        ib.classList.remove('wa-tab-btn--active');
        hideEl?.classList.add('hidden');
        showEl?.classList.remove('hidden');
    };

    document.getElementById('btn-show-recent')?.addEventListener('click', () =>
        toggleTabs('btn-show-recent', 'btn-show-users', recentList, usersListContainer));

    document.getElementById('btn-show-users')?.addEventListener('click', async () => {
        toggleTabs('btn-show-users', 'btn-show-recent', usersListContainer, recentList);
        // FIX: use cached data only if within TTL; otherwise re-fetch so new users appear
        if (cachedUsersHTML && (Date.now() - cachedUsersAt) < USERS_CACHE_TTL_MS) {
            usersListContent.innerHTML = cachedUsersHTML;
            return;
        }
        usersListContent.innerHTML = `<div class="flex justify-center py-10 text-sm text-gray-500">Loading contacts…</div>`;
        try {
            const snap = await getDocs(collection(db, 'users'));
            let html = '', users = [];
            snap.forEach(d => {
                const u = d.data();
                if (u.email !== currentUser.email) {
                    users.push(u);
                    html += createSidebarItemHTML({
                        id: u.email, email: u.email, name: u.name,
                        // FIX: was u.email — showed the raw email as a chat preview subtitle,
                        // confusing for new users. Use a neutral placeholder instead.
                        type: 'private', lastMessage: 'Tap to start a conversation', time: '',
                        online: isUserOnline(u.lastActive)
                    });
                }
            });
            cachedUsersData = users;
            cachedUsersHTML = html || '<p class="text-gray-400 text-sm text-center py-8">No contacts found.</p>';
            cachedUsersAt   = Date.now(); // FIX: record fetch time for TTL check
            usersListContent.innerHTML = cachedUsersHTML;
        } catch (err) {
            console.error('[Chat] load-contacts error:', err);
            usersListContent.innerHTML = '<p class="text-red-400 text-sm text-center py-8">Failed to load contacts.</p>';
            showToast('Could not load contacts.', 'error');
        }
    });

    // ── Presence heartbeat ──────────────────────
    const writeHeartbeat = () => {
        if (!currentUser?.email) return;
        updateDoc(doc(db, 'users', currentUser.email), { lastActive: serverTimestamp() }).catch(() => {});
    };
    writeHeartbeat();
    _hbInterval = setInterval(writeHeartbeat, 45000);
    window.addEventListener('beforeunload', () => {
        clearInterval(_hbInterval);
        _hbInterval = null; // FIX #20: keep state consistent
        // FIX: clear typing state on tab close so the indicator doesn't stay visible for TYPING_TTL_MS
        if (isCurrentlyTyping && activeRoomId) {
            writeTypingState(activeRoomId, false);
            isCurrentlyTyping = false;
        }
    }, { once: true });

    // ── Recent chats ────────────────────────────
    // Track which user's recent-chats subscription is currently live.
    let _recentSubOwner = null; // email of the user whose sub is active

    const loadRecentChats = () => {
        // Guard: currentUser is populated asynchronously from store/db.js.
        // If it isn't ready yet we return false so the caller can retry.
        if (!currentUser) return false;
        // Guard: recentList may be null if setupChat() ran before the DOM was
        // fully rendered (e.g. the chat page is lazily injected).
        if (!recentList) return false;
        // FIX BUG 1+4: skip re-subscribe if a live subscription already exists
        // for THIS user — avoids blank-list flash on every page-chat visit.
        // Only re-subscribe when: no sub exists, or it belongs to a different user.
        const _ownerEmail = currentUser.email;
        if (recentChatsSub && _recentSubOwner === _ownerEmail) return true;
        _recentSubOwner = _ownerEmail;
        unsubscribeRecent();

        // FIX: if the composite index (members ARRAY_CONTAINS + lastUpdated DESC) isn't
        // ready yet, Firestore returns a 'failed-precondition' / index-required error and
        // kills the listener — the recent list goes blank permanently.
        // Solution: try the ordered query first; on index error fall back to the simpler
        // unordered query and sort client-side, so the list always works.
        // Deploy firestore.indexes.json to build the index (takes ~1-2 min on first deploy).
        const _buildRecentQuery = (withOrder) => withOrder
            ? query(collection(db, 'chats'), where('members', 'array-contains', _ownerEmail), orderBy('lastUpdated', 'desc'))
            : query(collection(db, 'chats'), where('members', 'array-contains', _ownerEmail));

        const _attachRecentListener = (withOrder) => {
            recentChatsSub?.();
            recentChatsSub = onSnapshot(_buildRecentQuery(withOrder), snap => {
            // FIX: discard snapshot if no user is signed in or if the user changed
            // between when this listener was registered and when the snapshot arrived.
            // Prevents "Unable to load chat list" ghost data from showing post-logout
            // and cross-user leakage on fast account switches.
            if (!currentUser || currentUser.email !== _ownerEmail) return;
            const chats = [];
            snap.forEach(d => chats.push({ id: d.id, ...d.data() }));
            // Secondary client-side sort as a safety net (already ordered by server).
            chats.sort((a, b) => (b.lastUpdated?.toMillis() || 0) - (a.lastUpdated?.toMillis() || 0));

            if (!chats.length) {
                recentList.innerHTML = `
                    <div class="flex flex-col items-center justify-center py-16 px-4 text-center gap-3">
                        <div class="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center text-2xl">💬</div>
                        <p class="text-gray-700 text-sm font-medium">No conversations yet</p>
                        <p class="text-gray-400 text-xs">Start one from the Contacts tab</p>
                    </div>`;
                // FIX BUG 3: reset _totalUnread and go through _recomputeNavBadge so
                // the pill class and text are also cleared — not just the hidden class.
                _totalUnread = 0;
                _recomputeNavBadge();
                return;
            }

            let html = '';
            let totalUnread = 0;
            chats.forEach(chat => {
                const isGroup    = chat.type === 'group';
                const email      = isGroup ? chat.id : (chat.members?.find(e => e !== currentUser.email) || '');
                const name       = isGroup
                    ? chat.name
                    // Prefer an authoritative name lookup by email from the contacts cache.
                    // The memberNames array uses display names as keys, which breaks silently
                    // when two users share the same name — email is the stable identity.
                    : (cachedUsersData?.find(u => u.email === email)?.name
                        || chat.memberNames?.find(n => n && n !== currentUser.name)
                        || email.split('@')[0]
                        || 'Unknown');
                const isBlocked  = chat.blockedBy?.length > 0;
                const lastMessage = isBlocked ? '🔒 Chat Blocked' : (chat.lastMessage || 'New Chat');
                const time        = formatRelativeTime(chat.lastUpdated);
                const lastReadMs  = chat.lastRead?.[currentUser.email]?.toMillis?.() || 0;
                const updatedMs   = chat.lastUpdated?.toMillis?.() || 0;
                const isActiveRoom = chat.id === activeRoomId;
                // FIX: also suppress badge for rooms where markRoomRead fired but the
                // serverTimestamp() hasn't resolved yet (arrives as null → lastReadMs=0 → stale unread shown)
                const isPendingRead = _pendingReadRooms.has(chat.id);
                const unreadFromCounter = chat.unreadCount?.[currentUser.email];
                // If the room is currently open (or pending read), clear any stale server counter
                if ((isActiveRoom || isPendingRead) && typeof unreadFromCounter === 'number' && unreadFromCounter > 0) {
                    setDoc(doc(db, 'chats', chat.id), {
                        [`unreadCount.${currentUser.email}`]: 0
                    }, { merge: true }).catch(() => {});
                }
                // FIX: also treat missing lastSenderEmail (new chat doc with no messages yet)
                // as "no unread" — previously `undefined !== currentUser.email` was true,
                // giving the opener a phantom unread badge on their own new chat.
                const unread = (isActiveRoom || isPendingRead) ? 0
                    : (typeof unreadFromCounter === 'number'
                        ? unreadFromCounter
                        : (updatedMs > lastReadMs && chat.lastSenderEmail && chat.lastSenderEmail !== currentUser.email ? 1 : 0));
                const online      = !isGroup && cachedUsersData?.find(u => u.email === email)
                    ? isUserOnline(cachedUsersData.find(u => u.email === email).lastActive) : false;

                // FIX: surface pending join requests to admins directly in the sidebar
                // so they don't have to open the members panel to discover them.
                // Show a "🔔 N requests" preview on the group's sidebar item when the
                // current user is an admin and there are pending requests waiting.
                const admins = isGroup ? (chat.admins || [chat.admin].filter(Boolean)) : [];
                const isMeGroupAdmin = isGroup && admins.includes(currentUser.email);
                const pendingCount = isMeGroupAdmin ? (chat.pendingRequests?.length || 0) : 0;
                const effectiveLastMessage = (pendingCount > 0 && !isActiveRoom)
                    ? `🔔 ${pendingCount} join request${pendingCount > 1 ? 's' : ''} pending`
                    : lastMessage;
                const effectiveUnread = pendingCount > 0 ? Math.max(unread, pendingCount) : unread;

                html += createSidebarItemHTML({ id: chat.id, email, name, type: chat.type, lastMessage: effectiveLastMessage, time, unread: effectiveUnread, online, isActive: isActiveRoom });
                // FIX BUG 5: record per-room unread in Map so markRoomRead can look up
                // the count without parsing the DOM (DOM may be filtered/hidden/empty).
                _roomUnreadMap.set(chat.id, effectiveUnread);
                // Use effectiveUnread (not unread) so the module-level total stays in sync.
                // FIX Bug 4: exclude pending-read rooms from the total so a racing snapshot
                // (arriving before the serverTimestamp() resolves) doesn't re-add this room's
                // count and cause the nav indicator to flicker back on after opening a chat.
                if (!isActiveRoom && !isPendingRead) {
                    totalUnread += effectiveUnread;
                }
            });
            recentList.innerHTML = html;
            // FIX: re-apply active search filter after sidebar re-render
            _applyContactFilter();

            // ── Nav indicator: show unread count badge ──
            _totalUnread = totalUnread; // FIX: keep module-level total in sync with snapshot
            _recomputeNavBadge(); // FIX Bug 5: centralise all nav-dot updates through
            // _recomputeNavBadge so the explicit zero-reset (remove pill class, clear text)
            // is always applied consistently — avoids the empty-pill flash on toggle.
        }, err => {
            // FIX: if Firestore rejects because the composite index doesn't exist yet,
            // fall back to the unordered query and sort client-side. This is a one-time
            // degraded mode; once the index builds, reload will use the fast path.
            const isIndexError = err?.code === 'failed-precondition' ||
                (err?.message || '').toLowerCase().includes('index');
            if (withOrder && isIndexError) {
                console.warn('[Chat] recent: composite index not ready, falling back to client-side sort. Deploy firestore.indexes.json to fix.');
                _attachRecentListener(false); // retry without orderBy
                return;
            }
            console.error('[Chat] recent:', err);
            // FIX BUG-DEAD-SUB: On a permanent (non-index) Firestore error the SDK stops
            // delivering snapshots and the listener is effectively dead.  If we leave
            // recentChatsSub non-null and _recentSubOwner set, subsequent calls to
            // loadRecentChats() will hit the early-return guard and never re-subscribe,
            // leaving the sidebar frozen with stale data indefinitely.
            // Clearing both variables lets the next loadRecentChats() call (triggered by
            // the next page visit, auth change, or onPageVisit callback) re-establish the
            // listener cleanly.
            recentChatsSub  = null;
            _recentSubOwner = null;
            // FIX "Unable to load chat list": show inline error state in the sidebar
            // so the user has a clear visual cue instead of just a transient toast
            // that disappears. Also offer a retry button.
            if (recentList && currentUser) {
                recentList.innerHTML = `
                    <div class="flex flex-col items-center justify-center py-16 px-4 text-center gap-3">
                        <div class="w-14 h-14 rounded-full bg-red-50 flex items-center justify-center text-2xl">⚠️</div>
                        <p class="text-gray-700 text-sm font-semibold">Unable to load chat list</p>
                        <p class="text-gray-400 text-xs leading-relaxed">Check your connection or try again</p>
                        <button id="chat-list-retry-btn"
                            class="mt-1 px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700 transition">
                            Retry
                        </button>
                    </div>`;
                document.getElementById('chat-list-retry-btn')?.addEventListener('click', () => {
                    recentList.innerHTML = `<div class="flex justify-center py-10 text-sm text-gray-400">Reconnecting…</div>`;
                    // Clear state so loadRecentChats re-subscribes
                    recentChatsSub  = null;
                    _recentSubOwner = null;
                    setTimeout(() => loadRecentChats(), 300);
                });
            }
            showToast('Lost connection to chat list.', 'error');
        });
        };
        _attachRecentListener(true); // start with the indexed (ordered) query
    };

    // Gate ALL Firestore subscriptions behind Firebase Auth being confirmed.
    // The old retry-loop checked `currentUser` (a local store value) which can be
    // truthy from a cached profile before Firebase has validated the JWT server-side.
    // Firing listeners before auth resolves causes every rule's isSignedIn() check
    // to see request.auth == null → permission-denied on every collection.
    // onAuthStateChanged fires exactly once with the resolved user (or null) and
    // is the canonical way to know the token is ready.
    //
    // FIX BUG-GLOBAL: teardownChat() clears the chatWired flag so the DOM can be
    // re-wired after a logout/re-login cycle. But this means setupChat() can be called
    // more than once in a page session. The global listeners below (persistent auth
    // observer + onPageVisit) must NOT be re-registered on subsequent calls — each
    // extra registration stacks another duplicate listener that fires alongside all
    // previous ones, causing double sign-out teardowns, double nav-badge updates, and
    // double loadRecentChats() calls (which opens a second live Firestore subscription).
    // Guard with _globalListenersSetup, which is never reset by teardownChat().
    if (!_globalListenersSetup) {
        _globalListenersSetup = true;

        // One-shot auth check: confirms Firebase JWT is valid before the first
        // Firestore listener opens.  Self-unsubscribes immediately after firing.
        const _unsubAuth = onAuthStateChanged(auth, firebaseUser => {
            _unsubAuth(); // one-shot — stop listening after first resolution
            if (!firebaseUser) return; // not signed in; nothing to load
            // Now auth is confirmed — safe to open Firestore listeners.
            if (loadRecentChats() === false) {
                // DOM may not be ready yet (chat page lazily injected); retry briefly.
                let _rcRetries = 0;
                const _rcRetryId = setInterval(() => {
                    _rcRetries++;
                    if (loadRecentChats() !== false || _rcRetries > 50) {
                        clearInterval(_rcRetryId);
                    }
                }, 200);
            }
        });

        // Persistent auth observer: tears down state on sign-out and re-subscribes on
        // sign-in (including account switches within the same page session).
        // FIX: Listen for Firebase Auth sign-out (or user switch) so all Firestore
        // listeners, counters, and cached state are torn down the instant the user
        // signs out. Without this, the previous user's recent-chats subscription
        // keeps running after sign-out and their unread badge remains visible.
        onAuthStateChanged(auth, firebaseUser => {
            if (!firebaseUser) {
                // User signed out — immediately tear down all listeners and reset state.
                // FIX: also stop the presence heartbeat so we don't write to Firestore
                // as a null user after sign-out.
                if (_hbInterval) { clearInterval(_hbInterval); _hbInterval = null; }
                // FIX: clear any in-flight typing write
                if (isCurrentlyTyping && activeRoomId) {
                    writeTypingState(activeRoomId, false);
                    isCurrentlyTyping = false;
                }
                unsubscribeRoomListeners();
                unsubscribeRecent();
                _recentSubOwner   = null; // FIX BUG 2: clear owner so next sign-in re-subscribes
                _totalUnread      = 0;
                _pendingReadRooms.clear();
                _roomUnreadMap.clear();
                lastMessagesSnapshot.splice(0, lastMessagesSnapshot.length);
                _seenBySubmitted.clear(); // FIX: prevent cross-session read-receipt leakage
                activeRoomId      = null;
                activeRoomDetails = null;
                cachedUsersHTML   = null;
                cachedUsersData   = null;
                cachedUsersAt     = 0;
                _recomputeNavBadge();
            } else {
                // FIX BUG 2: on sign-in (including account switch), immediately start
                // the recent-chats subscription so the nav badge updates even before
                // the user navigates to page-chat. currentUser may lag behind firebaseUser
                // by one microtask (auth.js sets it asynchronously), so retry briefly.
                let _signInRetries = 0;
                const _signInRetryId = setInterval(() => {
                    _signInRetries++;
                    if (loadRecentChats() !== false || _signInRetries > 30) {
                        clearInterval(_signInRetryId);
                    }
                }, 200);
            }
        });

        // FIX: Use onPageVisit so recent chats are ALWAYS refreshed every time the
        // user navigates to the Chat section — not only when recentChatsSub is null.
        // The old click-listener only restarted the subscription if it had been torn
        // down, meaning stale data could linger indefinitely within a session.
        // onPageVisit fires for every visit (including subsequent ones), ensuring the
        // listener is always re-attached with the current user's email-scoped query.
        onPageVisit('page-chat', () => {
            if (!currentUser) return;
            // Always re-subscribe to guarantee the list is fresh for this user.
            loadRecentChats();

            // MOBILE: when navigating to the chat page decide which panel to show.
            // _getChatWrapper() now returns #page-chat itself, so we check mobile
            // layout before touching the attribute to avoid breaking desktop layout.
            if (_isMobileLayout()) {
                const wrapper = _getChatWrapper();
                if (wrapper) {
                    if (!activeRoomId) {
                        // No active room — always show the list so user can pick a chat.
                        wrapper.removeAttribute('data-mobile-view');
                    } else {
                        // Active room — restore conversation view (user just switched
                        // tabs or navigated away and back; don't lose their place).
                        wrapper.setAttribute('data-mobile-view', 'conversation');
                        requestAnimationFrame(() => {
                            const msgs = document.getElementById('chat-messages');
                            if (msgs) msgs.scrollTop = 0;
                        });
                    }
                }
            } else {
                // Desktop/tablet: always remove mobile attribute to ensure
                // side-by-side layout is not broken by a stale attribute.
                const wrapper = _getChatWrapper();
                if (wrapper) wrapper.removeAttribute('data-mobile-view');
            }
        });

        // ── MOBILE: popstate — handle browser/gesture Back ──────────────
        // When the user taps Back on mobile (or swipes on iOS), the browser
        // fires popstate. We intercept it to go from conversation → list
        // instead of leaving the page entirely.
        // Guard: only register once (alongside other global listeners).
        window.addEventListener('popstate', (e) => {
            // Only intercept if chat page is currently visible
            const pageChat = document.getElementById('page-chat');
            if (!pageChat || pageChat.classList.contains('hidden')) return;

            if (!_isMobileLayout()) return; // desktop: let default behaviour run

            const wrapper = _getChatWrapper();
            if (!wrapper) return;

            if (wrapper.getAttribute('data-mobile-view') === 'conversation') {
                // User pressed Back while in conversation view — go to list.
                // Prevent the page itself from navigating backwards.
                e.preventDefault?.();
                _mobileShowList();
                // Push a neutral state so the next Back press doesn't loop
                // back into conversation view.
                history.pushState(null, '');
            }
        });

        // ── MOBILE: orientation/resize — re-evaluate layout state ───────
        // When the device rotates, viewport width can cross the 640 px
        // breakpoint. We need to:
        //   • On crossing into desktop: remove data-mobile-view so the
        //     side-by-side layout is restored (CSS handles the rest).
        //   • On crossing into mobile: if a room is active, re-enter
        //     conversation view so the message panel is visible.
        // Use visualViewport if available so the breakpoint detection is consistent
        // with _isMobileLayout() on iOS Safari.
        let _prevWasDesktop = !_isMobileLayout();
        const _onViewportChange = () => {
            const nowDesktop = !_isMobileLayout();
            if (nowDesktop === _prevWasDesktop) return; // no breakpoint crossed
            _prevWasDesktop = nowDesktop;

            const wrapper = _getChatWrapper();
            if (!wrapper) return;

            if (nowDesktop) {
                // Switched to desktop: remove mobile-view so both panels show
                wrapper.removeAttribute('data-mobile-view');
                // Also clean up any conversation-state history entry to avoid
                // spurious popstate fires later.
                if (history.state?.chatView === 'conversation') {
                    history.replaceState(null, '');
                }
            } else {
                // Switched to mobile: if a room is open, show conversation view
                if (activeRoomId) {
                    _mobileShowConversation();
                }
            }
        };

        // ResizeObserver is more reliable than 'resize' on iOS Safari
        if (typeof ResizeObserver !== 'undefined') {
            const _chatResizeObs = new ResizeObserver(_onViewportChange);
            const _chatRoot = document.getElementById('page-chat') || document.body;
            _chatResizeObs.observe(_chatRoot);
        } else {
            window.addEventListener('resize', _onViewportChange, { passive: true });
        }
        // Also catch orientation changes on Android WebView
        screen.orientation?.addEventListener?.('change', _onViewportChange);
        window.addEventListener('orientationchange', _onViewportChange, { passive: true });

    } // end _globalListenersSetup guard

    // ── Handle ?joinGroup= deep-link ────────────
    // FIX: the invite link generator builds ?joinGroup=<code> URLs but there
    // was no corresponding handler to read this on page load — clicking a
    // shared invite link did nothing. Now we read the param, strip it from the
    // URL, and auto-open the join modal pre-filled with the code.
    (function handleJoinGroupParam() {
        const params = new URLSearchParams(window.location.search);
        const code   = params.get('joinGroup');
        if (!code) return;
        // Clean the param from the URL bar without reloading the page
        params.delete('joinGroup');
        const cleanUrl = [
            window.location.pathname,
            params.toString() ? '?' + params.toString() : '',
            window.location.hash
        ].join('');
        history.replaceState(null, '', cleanUrl);
        // Open the join modal with the code pre-filled
        document.getElementById('btn-join-group')?.click();
        // Wait one tick for the modal DOM to be created, then fill the input
        requestAnimationFrame(() => {
            const input = document.getElementById('join-group-code-input');
            if (input) {
                input.value = code.trim().toUpperCase().slice(0, 10);
                input.dispatchEvent(new Event('input')); // trigger uppercase normalisation
            }
        });
    })();

    // ── Group creation modal (light theme) ─────
    document.getElementById('btn-create-group')?.addEventListener('click', async () => {
        if (document.getElementById('advanced-group-modal')) return;
        const modal = document.createElement('div');
        modal.id = 'advanced-group-modal';
        modal.innerHTML = `
            <div id="advanced-group-card" style="opacity:0;transform:scale(.95);transition:all .2s">
                <div class="group-modal-header">
                    <span class="group-modal-title">New Group Chat</span>
                    <button id="close-group-modal" aria-label="Close">✕</button>
                </div>
                <div class="group-modal-body">
                    <input type="text" id="new-group-name" placeholder="Group name (required)" maxlength="60">
                    <p class="group-contacts-label">Add participants</p>
                    <div id="group-member-list">
                        <div class="text-center text-gray-400 text-sm py-6">Loading…</div>
                    </div>
                </div>
                <div class="group-modal-footer">
                    <button id="cancel-group-modal">Cancel</button>
                    <button id="confirm-create-group">Create Group</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        requestAnimationFrame(() => {
            const card = document.getElementById('advanced-group-card');
            if (card) { card.style.opacity = '1'; card.style.transform = 'scale(1)'; }
        });

        const closeModal = () => modal.remove();
        modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
        document.getElementById('close-group-modal').addEventListener('click', closeModal);
        document.getElementById('cancel-group-modal').addEventListener('click', closeModal);

        try {
            const snap = await getDocs(collection(db, 'users'));
            let html   = '';
            snap.forEach(d => {
                const u = d.data();
                if (u.email !== currentUser.email) {
                    html += `
                    <div class="group-member-row">
                        <label>
                            ${avatarEl(u.name, 'private', false, 36)}
                            <div class="group-member-info">
                                <p class="group-member-name">${sanitize(u.name)}</p>
                                <p class="group-member-email">${sanitize(u.email)}</p>
                            </div>
                            <input type="checkbox" value="${u.email}" data-name="${sanitize(u.name)}" class="group-member-checkbox">
                        </label>
                    </div>`;
                }
            });
            document.getElementById('group-member-list').innerHTML =
                html || '<p class="text-gray-400 text-sm text-center py-4">No contacts available.</p>';
        } catch (err) {
            console.error('[Chat] load-group-contacts error:', err);
            document.getElementById('group-member-list').innerHTML =
                '<p class="text-red-400 text-sm text-center py-4">Failed to load contacts.</p>';
        }

        document.getElementById('confirm-create-group').addEventListener('click', async () => {
            const groupName  = document.getElementById('new-group-name').value.trim();
            const checkboxes = [...document.querySelectorAll('.group-member-checkbox:checked')];
            if (!groupName)         return showToast('Please enter a group name.', 'error');
            if (!checkboxes.length) return showToast('Select at least one member.', 'error');
            const members     = [currentUser.email, ...checkboxes.map(cb => cb.value)];
            const memberNames = [currentUser.name,  ...checkboxes.map(cb => cb.dataset.name)];
            const btn         = document.getElementById('confirm-create-group');
            btn.textContent   = 'Creating…';
            btn.disabled      = true;
            const groupId     = `group_${Date.now()}`;
            // Fix #3 (Critical): use CSPRNG instead of Math.random()
            const _icAlpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            const _icBytes = new Uint8Array(10);
            crypto.getRandomValues(_icBytes);
            const inviteCode  = Array.from(_icBytes, b => _icAlpha[b % _icAlpha.length]).join('');
            try {
                await setDoc(doc(db, 'chats', groupId), {
                    type: 'group', name: groupName, members, memberNames,
                    admin: currentUser.email, admins: [currentUser.email],
                    // FIX: createdBy is required by the Firestore delete rule
                    // (only creator or admin can delete a group room).
                    // Was missing — group creator could never delete their own group.
                    createdBy: currentUser.email,
                    inviteCode, pendingRequests: [],
                    lastMessage: 'Group created',
                    lastSenderEmail: currentUser.email, lastUpdated: serverTimestamp()
                });
                await addDoc(collection(db, `chats/${groupId}/messages`), {
                    text: `${currentUser.name} created the group "${groupName}"`,
                    senderEmail: 'system', senderName: 'System', createdAt: serverTimestamp()
                });
                closeModal();
                showToast(`"${groupName}" created. Invite code: ${inviteCode}`, 'success');
                // FIX: removed redundant loadRecentChats() — the onSnapshot listener already picks
                // up the new group doc automatically. Extra call creates a second listener.
                document.getElementById('btn-show-recent')?.click();
            } catch (err) {
                console.error('[Chat] create-group error:', err);
                showToast('Failed to create group.', 'error');
                btn.textContent = 'Create Group';
                btn.disabled    = false;
            }
        });
    });

    // ── Join Group via Invite Code ───────────────
    document.getElementById('btn-join-group')?.addEventListener('click', async () => {
        if (document.getElementById('join-group-modal')) return;
        const modal = document.createElement('div');
        modal.id = 'join-group-modal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);backdrop-filter:blur(4px);padding:16px';
        modal.innerHTML = `
            <div id="join-group-card" style="background:var(--wa-panel);border:1px solid var(--wa-border);border-radius:20px;width:100%;max-width:400px;overflow:hidden;box-shadow:var(--wa-shadow-lg);opacity:0;transform:scale(.95);transition:all .2s">
                <div style="padding:16px;border-bottom:1px solid var(--wa-border);display:flex;align-items:center;justify-content:space-between">
                    <span style="font-size:16px;font-weight:700;color:var(--wa-text)">🔗 Join a Group</span>
                    <button id="close-join-modal" style="background:none;border:none;cursor:pointer;color:var(--wa-sub);font-size:18px;padding:4px">✕</button>
                </div>
                <div style="padding:20px;display:flex;flex-direction:column;gap:14px">
                    <p style="font-size:13px;color:var(--wa-sub)">Enter the group invite code shared by the group admin.</p>
                    <input type="text" id="join-group-code-input" placeholder="e.g. ABC123WXYZ" maxlength="10"
                        style="width:100%;background:var(--wa-input-bg);border:1.5px solid transparent;border-radius:12px;padding:12px 16px;font-size:15px;color:var(--wa-text);outline:none;letter-spacing:.1em;text-transform:uppercase;transition:border-color .15s">
                    <p id="join-group-error" style="color:var(--wa-danger);font-size:13px;display:none"></p>
                </div>
                <div style="padding:14px 16px;border-top:1px solid var(--wa-border);display:flex;justify-content:flex-end;gap:10px;background:var(--wa-panel)">
                    <button id="cancel-join-modal" style="font-size:14px;font-weight:500;color:var(--wa-sub);padding:8px 16px;border-radius:10px;background:none;border:none;cursor:pointer">Cancel</button>
                    <button id="confirm-join-group" style="font-size:14px;font-weight:600;color:#fff;background:var(--wa-accent);padding:8px 20px;border-radius:10px;border:none;cursor:pointer;transition:background .15s">Send Join Request</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        requestAnimationFrame(() => {
            const card = document.getElementById('join-group-card');
            if (card) { card.style.opacity = '1'; card.style.transform = 'scale(1)'; }
        });

        const closeJoin = () => modal.remove();
        modal.addEventListener('click', e => { if (e.target === modal) closeJoin(); });
        document.getElementById('close-join-modal').addEventListener('click', closeJoin);
        document.getElementById('cancel-join-modal').addEventListener('click', closeJoin);
        // FIX #18: replace inline oninput/onfocus/onblur with addEventListener
        const _joinInput = document.getElementById('join-group-code-input');
        if (_joinInput) {
            _joinInput.addEventListener('input', () => { _joinInput.value = _joinInput.value.toUpperCase(); });
            _joinInput.addEventListener('focus', () => { _joinInput.style.borderColor = 'var(--wa-accent)'; });
            _joinInput.addEventListener('blur',  () => { _joinInput.style.borderColor = 'transparent'; });
            // FIX: pressing Enter should submit — without this users had to click the button
            _joinInput.addEventListener('keydown', e => {
                if (e.key === 'Enter') document.getElementById('confirm-join-group')?.click();
            });
            // Auto-focus so the user can start typing immediately
            _joinInput.focus();
        }

        document.getElementById('confirm-join-group').addEventListener('click', async () => {
            const code  = document.getElementById('join-group-code-input').value.trim().toUpperCase();
            const errEl = document.getElementById('join-group-error');
            const btn   = document.getElementById('confirm-join-group');

            // FIX: validate code length matches generated length (10 chars, A-Z0-9)
            if (!code) {
                errEl.textContent = 'Please enter an invite code.';
                errEl.style.display = 'block'; return;
            }
            if (!/^[A-Z0-9]{10}$/.test(code)) {
                errEl.textContent = 'Invite codes are 10 characters (letters and numbers only).';
                errEl.style.display = 'block'; return;
            }

            btn.textContent = 'Searching…'; btn.disabled = true;
            errEl.style.display = 'none';
            try {
                // Step 1: look up the group by invite code.
                // FIX: must include where('type','==','group') so Firestore's query
                // security validator can confirm every returned document satisfies the
                // read rule (type=='group' → readable by any signed-in user). Without
                // this second constraint, Firestore rejects the whole query with
                // permission-denied because private chat docs in the same collection
                // would fail the rule.
                // REQUIRED INDEX: chats — inviteCode ASC, type ASC (create in Firebase Console
                // or add to firestore.indexes.json: collection=chats, fields=[inviteCode ASC, type ASC])
                const q    = query(collection(db, 'chats'), where('inviteCode', '==', code), where('type', '==', 'group'));
                const snap = await getDocs(q);
                const groupDoc = snap.docs[0] ?? null;
                if (!groupDoc) {
                    errEl.textContent = 'No group found with that code. Double-check and try again.';
                    errEl.style.display = 'block';
                    btn.textContent = 'Send Join Request'; btn.disabled = false;
                    return;
                }

                // Step 2: use a transaction so the membership/pending checks and
                // the write are atomic — prevents race conditions where two users
                // submit at the same moment, or an admin approves while the user
                // is mid-submit, leading to duplicate pendingRequests entries.
                const groupRef = doc(db, 'chats', groupDoc.id);
                let alreadyMember  = false;
                let alreadyPending = false;
                let dismissedHours = 0;

                await runTransaction(db, async tx => {
                    const fresh   = await tx.get(groupRef);
                    if (!fresh.exists()) throw new Error('group_deleted');
                    const d       = fresh.data();

                    // FIX: re-check inviteCode inside the transaction — if an admin
                    // regenerated the code between the getDocs and now, the old code
                    // should be rejected rather than silently adding to the wrong group.
                    if (d.inviteCode !== code) throw new Error('code_rotated');

                    const members   = d.members   || [];
                    const pending   = d.pendingRequests   || [];
                    const dismissed = d.dismissedRequests || [];

                    if (members.includes(currentUser.email)) {
                        alreadyMember = true; return; // abort write, not an error
                    }
                    if (pending.some(r => r.email === currentUser.email)) {
                        alreadyPending = true; return;
                    }

                    const dismissEntry = dismissed.find(r => r.email === currentUser.email);
                    if (dismissEntry && dismissEntry.dismissedUntil > Date.now()) {
                        dismissedHours = Math.ceil((dismissEntry.dismissedUntil - Date.now()) / 3600000);
                        return; // abort write
                    }

                    // All checks passed — write the pending request.
                    const payload = {
                        pendingRequests: arrayUnion({
                            email: currentUser.email,
                            name:  currentUser.name,
                            requestedAt: Date.now()
                        })
                    };
                    // Also clean up any expired dismiss entry for this user.
                    if (dismissEntry) payload.dismissedRequests = arrayRemove(dismissEntry);
                    tx.update(groupRef, payload);                });

                if (alreadyMember) {
                    errEl.textContent = 'You are already a member of this group.';
                    errEl.style.display = 'block';
                    btn.textContent = 'Send Join Request'; btn.disabled = false;
                    return;
                }
                if (alreadyPending) {
                    errEl.textContent = 'Your join request is already pending approval.';
                    errEl.style.display = 'block';
                    btn.textContent = 'Send Join Request'; btn.disabled = false;
                    return;
                }
                if (dismissedHours > 0) {
                    errEl.textContent = `Your request was dismissed. Try again in ${dismissedHours} hour(s).`;
                    errEl.style.display = 'block';
                    btn.textContent = 'Send Join Request'; btn.disabled = false;
                    return;
                }

                // FIX: post a system message into the group so admins who are actively
                // in the chat see a real-time notification. The sidebar badge (added above)
                // covers admins who aren't currently in the chat.
                // Non-members can write system messages per the create rule (senderEmail=='system').
                await addDoc(collection(db, `chats/${groupDoc.id}/messages`), {
                    text: `📩 ${currentUser.name} requested to join the group. Open Members → Requests to review.`,
                    senderEmail: 'system', senderName: 'System', createdAt: serverTimestamp()
                }).catch(() => {}); // non-fatal — don't block the join flow if this fails

                closeJoin();
                showToast('Join request sent! Waiting for admin approval.', 'success');
            } catch (err) {
                console.error('[Chat] join group error:', err);
                const msg = err.message === 'group_deleted' ? 'This group no longer exists.'
                          : err.message === 'code_rotated'  ? 'This invite code has been rotated. Ask the admin for the new code.'
                          : 'Something went wrong. Please try again.';
                errEl.textContent = msg;
                errEl.style.display = 'block';
                btn.textContent = 'Send Join Request'; btn.disabled = false;
            }
        });
    });

    // ── Open chat room ───────────────────────────
    const openChatRoom = async (targetEmail, targetName, chatType) => {
        // FIX AUTH-GUARD: bail immediately if called without a signed-in user.
        // This can happen during the brief window after sign-out fires but before
        // the auth state observer has cleared the chat panel from the UI.
        if (!currentUser?.email) {
            console.warn('[Chat] openChatRoom called without authenticated user — ignoring.');
            return;
        }
        // FIX #5: use module-scope _cleanupDropdown instead of DOM property
        if (_cleanupDropdown) {
            document.removeEventListener('click', _cleanupDropdown);
            _cleanupDropdown = null;
        }
        unsubscribeRoomListeners();
        closeSearchBar();
        stopRecording(true);
        document.getElementById('wa-reply-preview')?.remove();
        replyingTo   = null;
        editingMsgId = null;  // EXT: clear any in-progress edit when switching rooms
        // Clear compose tray (revoke blob URLs) when switching rooms
        if (typeof teardownComposeTray === 'function') teardownComposeTray();
        else {
            pendingAttachments.forEach(item => {
                if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
            });
            pendingAttachments = [];
            document.getElementById('wa-compose-tray')?.remove();
        }
        // FIX: mutate both collections in place, never reassign
        pinnedMessages.splice(0, pinnedMessages.length);
        starredMessages.clear();

        activeRoomId      = chatType === 'group'
            ? targetEmail
            : getPrivateRoomId(currentUser.email, targetEmail);
        activeRoomDetails = { id: activeRoomId, type: chatType, targetEmail, targetName };
        // FIX Bug 1: clear the seenBy-submitted set when entering a new room so the
        // new room's messages are marked seen correctly on first snapshot.
        _seenBySubmitted.clear();

        if (chatType === 'private') {
            // FIX: await the setDoc before any Firestore listeners open.
            // The messages sub-collection rule calls isChatMember() which does
            // get(chats/{chatId}) — if that doc doesn't exist yet (first time
            // these two users chat), isChatMember() returns false → permission-denied.
            // Awaiting here ensures the parent chat doc is committed before the
            // snapshot listeners below try to read it.
            try {
                await setDoc(doc(db, 'chats', activeRoomId), {
                    type: 'private', members: [currentUser.email, targetEmail],
                    memberNames: [currentUser.name, targetName], lastUpdated: serverTimestamp()
                }, { merge: true });
            } catch (err) {
                console.error('[Chat] open-chat error:', err);
                showToast('Could not open chat.', 'error');
                return;
            }
        }

        markRoomRead(activeRoomId); // FIX: markRoomRead already calls _recomputeNavBadge — removed duplicate call
        subscribeTypingIndicator(activeRoomId, chatType);
        // FIX BUG-STARRED: start the dedicated starred listener immediately on room open so
        // the first renderMessages() call in the messages snapshot already has the correct
        // starred set — eliminates the per-snapshot getDoc that previously fired for every
        // reaction, read receipt, or edit event.
        subscribeStarred(activeRoomId);

        const targetUserDoc = chatType === 'private'
            ? cachedUsersData?.find(u => u.email === targetEmail)
            : null;
        const online = targetUserDoc ? isUserOnline(targetUserDoc.lastActive) : false;

        const statusHTML = chatType === 'group'
            ? `<span class="ch-status ch-status--offline">Group chat</span>`
            : online
                ? `<span class="ch-status ch-status--online">● Online</span>`
                : `<span class="ch-status ch-status--offline">${formatLastSeen(targetUserDoc?.lastActive)}</span>`;

        const dropdownViewAction = chatType === 'group'
            ? `<button id="chat-action-view-members" class="wa-drop-item">👥 View Members</button>`
            : `<button id="chat-action-view" class="wa-drop-item">👤 View Profile</button>`;
        const dropdownBlockAction = chatType === 'private'
            ? `<button id="chat-action-block" data-blocked="false" class="wa-drop-item" style="color:#f97316">🚫 Block</button>`
            : '';
        const dropdownLeaveAction = chatType === 'group'
            ? `<button id="chat-action-leave" class="wa-drop-item wa-drop-item--danger">🚪 Leave Group</button>`
            : '';
        const dropdownClearAction  = `<button id="chat-action-clear" class="wa-drop-item" style="color:#f97316">🧹 Clear Chat</button>`;
        const dropdownDeleteAction = chatType !== 'group'
            ? `<button id="chat-action-delete" class="wa-drop-item wa-drop-item--danger">🗑️ Delete Chat</button>`
            : '';

        const headerClickId = chatType === 'group' ? 'chat-action-view-members-btn' : 'chat-header-profile-btn';

        chatHeader.innerHTML = `
            <div class="ch-inner">
                <div id="${headerClickId}" class="ch-profile-area">
                    ${avatarEl(targetName, chatType, online, 40)}
                    <div style="min-width:0;flex:1">
                        <p class="ch-name">${sanitize(targetName)}</p>
                        ${statusHTML}
                    </div>
                </div>
                <div class="ch-actions">
                    <button id="chat-action-search-btn" title="Search messages" class="wa-nav-btn" aria-label="Search">
                        <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"/></svg>
                    </button>
                    <button id="chat-action-starred-btn" title="Starred messages" class="wa-nav-btn" aria-label="Starred messages" style="font-size:16px">⭐</button>
                    <div style="position:relative">
                        <button id="chat-header-menu-btn" title="More options" class="wa-nav-btn" aria-label="More options">
                            <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
                        </button>
                        <div id="chat-header-dropdown" class="wa-header-dropdown" style="display:none">
                            ${dropdownViewAction}
                            ${dropdownBlockAction}
                            ${dropdownClearAction}
                            ${dropdownLeaveAction}
                            ${dropdownDeleteAction}
                        </div>
                    </div>
                </div>
            </div>`;

        document.getElementById('chat-action-search-btn')?.addEventListener('click', () => openSearchBar(chatHeader));
        document.getElementById('chat-action-starred-btn')?.addEventListener('click', openStarredPanel);

        const headerMenuBtn  = document.getElementById('chat-header-menu-btn');
        const headerDropdown = document.getElementById('chat-header-dropdown');
        headerMenuBtn?.addEventListener('click', e => {
            e.stopPropagation();
            const isOpen = headerDropdown.style.display !== 'none';
            headerDropdown.style.display = isOpen ? 'none' : 'block';
        });
        // Close dropdown on outside click
        const closeDropdown = () => { if (headerDropdown) headerDropdown.style.display = 'none'; };
        document.addEventListener('click', closeDropdown);
        // FIX #5: store at module scope so it survives header innerHTML rewrites
        _cleanupDropdown = closeDropdown;

        // ── MOBILE: inject back button + slide to conversation view ──────
        // _ensureMobileBackButton is a no-op on desktop (>= 640 px).
        // The callback navigates back to the list and handles history state.
        _ensureMobileBackButton(chatHeader, () => {
            // If history has a conversation state on top, go back naturally so
            // the popstate handler fires (keeps history clean). Otherwise just
            // toggle the view directly.
            if (history.state?.chatView === 'conversation') {
                history.back();
            } else {
                _mobileShowList();
            }
        });

        // Transition to conversation view on mobile.  On desktop this is a
        // no-op because the sidebar and window are always visible side-by-side.
        if (_isMobileLayout()) {
            _mobileShowConversation();
        }

        // Scroll to newest message immediately after transition
        requestAnimationFrame(() => {
            const msgs = document.getElementById('chat-messages');
            if (msgs) msgs.scrollTop = 0; // column-reverse: 0 = bottom
        });

        // Root listener
        rootChatSub = onSnapshot(doc(db, 'chats', activeRoomId), docSnap => {
            if (chatType === 'group' &&
                (!docSnap.exists() || !docSnap.data().members?.includes(currentUser.email))) {
                chatContainer.innerHTML = `
                    <div class="w-full h-full flex items-center justify-center">
                        <p class="text-gray-400 text-sm">You are no longer in this group.</p>
                    </div>`;
                input.disabled = true;
                sendBtn.disabled = true;
                if (attachBtn) attachBtn.disabled = true;
                return;
            }
            if (!docSnap.exists()) return;
            const data = docSnap.data();
            if (data.pinnedMessages) {
                // FIX: mutate in place
                pinnedMessages.splice(0, pinnedMessages.length, ...data.pinnedMessages);
                renderPinnedBar(chatHeader);
            }
            const blocked  = data.blockedBy?.length > 0;
            const blockBtn = document.getElementById('chat-action-block');
            if (blocked) {
                input.disabled    = true;
                input.placeholder = '🔒 This chat is blocked.';
                sendBtn.disabled  = true;
                if (attachBtn) attachBtn.disabled = true;
                if (blockBtn) {
                    if (data.blockedBy.includes(currentUser.email)) {
                        blockBtn.dataset.blocked = 'true';
                        blockBtn.textContent     = '✅ Unblock';
                        blockBtn.style.color     = '#10b981';
                    } else {
                        blockBtn.classList.add('hidden');
                    }
                }
            } else {
                input.disabled    = false;
                input.placeholder = 'Type a message';
                sendBtn.disabled  = false;
                if (attachBtn) attachBtn.disabled = false;
                if (blockBtn) {
                    blockBtn.dataset.blocked = 'false';
                    blockBtn.textContent     = '🚫 Block';
                    blockBtn.style.color     = '#f97316';
                    blockBtn.classList.remove('hidden');
                }
            }
        }, err => { console.error('[Chat] root:', err); showToast('Connection error.', 'error'); });

        // Messages listener
        const msgsQuery = query(
            collection(db, `chats/${activeRoomId}/messages`),
            orderBy('createdAt', 'desc'),
            limit(100)
        );
        // Real-time presence listener for private chat header status.
        // Updates the online/last-seen indicator without requiring a page reload.
        // presenceSub is now dedicated to presence only; typingSub handles typing.
        // Both are torn down by unsubscribeRoomListeners() when changing rooms.
        presenceSub?.();
        presenceSub = null;
        if (chatType === 'private' && targetEmail) {
            const _presenceRef = doc(db, 'users', targetEmail);
            presenceSub = onSnapshot(_presenceRef, userSnap => {
                if (!userSnap.exists()) return;
                const ud = userSnap.data();
                const isOnline = isUserOnline(ud.lastActive);
                const statusEl = chatHeader.querySelector('.ch-status');
                if (statusEl) {
                    statusEl.className = isOnline ? 'ch-status ch-status--online' : 'ch-status ch-status--offline';
                    statusEl.textContent = isOnline ? '● Online' : formatLastSeen(ud.lastActive);
                }
            }, () => {}); // non-fatal: ignore errors on presence reads
        }

        chatSub = onSnapshot(msgsQuery, snap => {
            // FIX: always merge in-flight optimistic messages back — they have no Firestore doc yet
            // so they won't appear in snap.docs. Without this, sending a message wipes the
            // optimistic bubble the moment the first snapshot fires (which is before addDoc resolves).
            const pending = lastMessagesSnapshot.filter(m => m._pending || m._failed);
            const fromFirestore = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            // FIX: snap.empty guard was `&& !lastMessagesSnapshot.length` — wrong when all messages
            // are deleted after room was open; show empty state whenever Firestore returns nothing
            // AND there are no pending optimistic messages in flight.
            if (snap.empty && !pending.length) {
                lastMessagesSnapshot.splice(0, lastMessagesSnapshot.length); // already in-place
                chatContainer.innerHTML = `
                    <div class="w-full h-full flex items-center justify-center">
                        <div style="background:rgba(255,255,255,.9);border:1px solid var(--wa-border);padding:12px 20px;border-radius:12px;color:var(--wa-sub);font-size:13px;text-align:center">
                            🔒 End-to-end encrypted<br>
                            <span style="color:var(--wa-text);font-weight:500">Say hi to ${sanitize(targetName)}!</span>
                        </div>
                    </div>`;
                return;
            }
            // FIX #1: splice in-place so external references to the array stay valid
            lastMessagesSnapshot.splice(0, lastMessagesSnapshot.length, ...pending, ...fromFirestore);
            // FIX BUG-STARRED: starred messages are now kept up-to-date by a dedicated
            // onSnapshot listener (subscribeStarred), so renderMessages() can be called
            // directly here — no getDoc needed on every message snapshot.  This eliminates
            // O(snapshot) Firestore reads that previously fired for every reaction, read
            // receipt, and edit event inside the active room.
            renderMessages();
            markMessagesSeenBy(activeRoomId);
        }, err => { console.error('[Chat] messages:', err); showToast('Error loading messages.', 'error'); });
    };

    // ── Sidebar click ────────────────────────────
    const handleSidebarClick = container => {
        container?.addEventListener('click', e => {
            const item = e.target.closest('.wa-sidebar-item, .chat-contact');
            if (!item) return;
            const email    = item.dataset.email;
            const name     = item.dataset.name;
            const chatType = item.dataset.type || 'private';
            if (!email || !name) return;
            // BUG FIX: prevent opening a private chat with yourself — a members array
            // with two identical emails creates an ambiguous room that breaks read-receipts.
            if (chatType === 'private' && email === currentUser?.email) return;
            document.querySelectorAll('.wa-sidebar-item--active').forEach(el =>
                el.classList.remove('wa-sidebar-item--active'));
            item.classList.add('wa-sidebar-item--active');
            // FIX #5: clean up module-scope dropdown listener
            if (_cleanupDropdown) {
                document.removeEventListener('click', _cleanupDropdown);
                _cleanupDropdown = null;
            }
            openChatRoom(email, name, chatType);
            window.startDirectChat = (e2, n2) => openChatRoom(e2, n2, 'private');
        });
    };
    handleSidebarClick(recentList);
    handleSidebarClick(usersListContent);
    window.startDirectChat = (email, name) => openChatRoom(email, name, 'private');

    // ══════════════════════════════════════════════════════════════════
    // MESSAGE MENU CONTROLLER
    // ══════════════════════════════════════════════════════════════════
    //
    // Architecture:
    //   1. Each message renders a .wa-msg-menu trigger + .wa-msg-dropdown template
    //      inside the bubble's DOM tree (so hover detection works naturally).
    //   2. When the menu is opened, the DROPDOWN IS PORTALED to <body> with
    //      position:fixed so it can never be clipped by:
    //        • overflow:hidden / overflow:clip on #page-chat wrapper
    //        • overflow-y:auto on #chat-messages scroll container
    //        • CSS transforms on ancestor elements (transform creates a new
    //          containing block for fixed descendants — we break out entirely)
    //   3. Viewport-aware placement: tries below-right first, then below-left,
    //      then above-right, then above-left, choosing whichever fits.
    //   4. On resize / scroll, live repositions the open dropdown.
    //   5. Keyboard navigation: ArrowDown/Up move focus, Enter/Space activate,
    //      Escape/Tab close.  Home/End jump to first/last item.
    //   6. Touch: standard click/touchend (300 ms delay avoided via touch-action).
    //   7. Click-outside: one document pointerdown listener, removed on close.
    //   8. Escape key: global keydown listener, removed on close.
    //
    const MessageMenuController = (() => {
        let _portalEl   = null;  // the currently-open dropdown (on <body>)
        let _triggerBtn = null;  // the button that opened it
        let _templateEl = null;  // the original dropdown template in the bubble DOM
        let _focusIdx   = -1;    // current keyboard focus index (-1 = none)
        let _items      = [];    // focusable items inside the open dropdown
        let _rafId      = null;  // requestAnimationFrame for repositioning

        // ── Measure & position ───────────────────────────────────────────
        function positionDropdown(btn, portal) {
            const MARGIN  = 10;  // min gap from viewport edge (px)
            const GAP     = 8;   // gap between button and dropdown (px)
            const btnRect = btn.getBoundingClientRect();
            const vpW     = window.innerWidth;
            const vpH     = window.innerHeight;

            // Use real measured dimensions; portal is already in DOM (opacity:0)
            // so offsetWidth/Height are accurate. Fall back to CSS min-width only.
            const dropW = Math.min(
                Math.max(portal.offsetWidth, 230),
                vpW - MARGIN * 2
            );
            // Measure the scroll content's natural height, not the constrained height
            const scrollEl = portal.querySelector('.wa-msg-dropdown__scroll');
            const innerH = scrollEl
                ? portal.querySelector('.wa-emoji-bar')?.offsetHeight + scrollEl.scrollHeight
                : portal.scrollHeight;
            const dropH = Math.max(innerH || 0, 60); // at least 60px to avoid flicker

            // ── Vertical placement ──
            const spaceBelow = vpH - btnRect.bottom - GAP - MARGIN;
            const spaceAbove = btnRect.top - GAP - MARGIN;
            const canFitBelow = dropH <= spaceBelow;
            const canFitAbove = dropH <= spaceAbove;

            let top, openAbove;
            if (canFitBelow) {
                top = btnRect.bottom + GAP;
                openAbove = false;
            } else if (canFitAbove) {
                top = btnRect.top - GAP - dropH;
                openAbove = true;
            } else {
                // Neither fits — open toward the side with more room, constrain height
                if (spaceBelow >= spaceAbove) {
                    top = btnRect.bottom + GAP;
                    openAbove = false;
                } else {
                    top = MARGIN;
                    openAbove = true;
                }
            }

            // Clamp vertically
            top = Math.max(MARGIN, Math.min(top, vpH - MARGIN - dropH));

            // ── Horizontal placement ──
            // Prefer alignment direction based on which side of screen button is on
            const btnMidX = btnRect.left + btnRect.width / 2;
            const preferAlignRight = btnMidX > vpW / 2;
            let left;
            if (preferAlignRight) {
                // Right-align dropdown to button's right edge
                left = btnRect.right - dropW;
            } else {
                // Left-align dropdown to button's left edge
                left = btnRect.left;
            }
            // Clamp horizontally
            left = Math.max(MARGIN, Math.min(left, vpW - dropW - MARGIN));

            // ── Apply direction classes ──
            portal.classList.toggle('wa-msg-dropdown--above', openAbove);
            portal.classList.toggle('wa-msg-dropdown--below', !openAbove);
            portal.classList.toggle('wa-msg-dropdown--align-right', preferAlignRight);
            portal.classList.toggle('wa-msg-dropdown--align-left', !preferAlignRight);

            // ── Apply geometry ──
            // Compute available height for the scrollable section
            const emojiBarH = portal.querySelector('.wa-emoji-bar')?.offsetHeight ?? 56;
            const maxDropH  = (openAbove ? spaceAbove : spaceBelow) + GAP;
            const clampedH  = Math.min(dropH, Math.max(maxDropH, emojiBarH + 80), vpH - MARGIN * 2);

            portal.style.top   = `${Math.round(top)}px`;
            portal.style.left  = `${Math.round(left)}px`;
            portal.style.width = `${Math.round(dropW)}px`;
            // Let the scroll section handle overflow — remove any inline maxHeight/overflowY
            // set by previous calls; CSS flex + scroll section handles it
            portal.style.maxHeight = `${Math.round(clampedH)}px`;
            // The panel uses overflow:hidden (border-radius clipping), the scroll
            // section uses overflow-y:auto. Never set overflowY on the portal itself.
            portal.style.removeProperty('overflow-y');
            // Set max-height on the scroll section so items are scrollable when needed
            if (scrollEl) {
                scrollEl.style.maxHeight = `${Math.round(clampedH - emojiBarH)}px`;
            }
        }

        function _scheduleReposition() {
            if (!_portalEl || !_triggerBtn) return;
            if (_rafId) cancelAnimationFrame(_rafId);
            _rafId = requestAnimationFrame(() => positionDropdown(_triggerBtn, _portalEl));
        }

        // ── Keyboard navigation ──────────────────────────────────────────
        function _getItems() {
            if (!_portalEl) return [];
            // Query items in DOM order: emoji picks first, then action items in scroll section
            return [..._portalEl.querySelectorAll(
                '.wa-emoji-pick:not([disabled]), .wa-drop-item:not([disabled])'
            )];
        }

        function _setFocus(idx) {
            _items.forEach((el, i) => {
                el.classList.toggle('wa-drop-item--focused', i === idx);
                el.setAttribute('tabindex', i === idx ? '0' : '-1');
            });
            if (idx >= 0 && idx < _items.length) {
                _items[idx].focus({ preventScroll: true });
            }
            _focusIdx = idx;
        }

        function _onKeydown(e) {
            if (!_portalEl) return;
            switch (e.key) {
                case 'Escape':
                case 'Tab':
                    e.preventDefault();
                    close(true); // return focus to trigger
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    _items = _getItems();
                    _setFocus(Math.min(_focusIdx + 1, _items.length - 1));
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    _items = _getItems();
                    _setFocus(Math.max(_focusIdx - 1, 0));
                    break;
                case 'Home':
                    e.preventDefault();
                    _items = _getItems();
                    _setFocus(0);
                    break;
                case 'End':
                    e.preventDefault();
                    _items = _getItems();
                    _setFocus(_items.length - 1);
                    break;
                case 'Enter':
                case ' ':
                    if (_focusIdx >= 0 && _items[_focusIdx]) {
                        e.preventDefault();
                        _items[_focusIdx].click();
                    }
                    break;
            }
        }

        // ── Outside click / touch ────────────────────────────────────────
        function _onOutsidePointer(e) {
            if (!_portalEl) return;
            if (_portalEl.contains(e.target)) return;
            if (_triggerBtn && _triggerBtn.contains(e.target)) return;
            close(false);
        }

        // ── Open ─────────────────────────────────────────────────────────
        function open(btn) {
            // Find the dropdown template in the same .wa-msg-menu container
            const menuWrap = btn.closest('.wa-msg-menu');
            if (!menuWrap) return;
            const template = menuWrap.querySelector('.wa-msg-dropdown');
            if (!template) return;

            // If the same menu is already open, close it (toggle)
            if (_portalEl && _triggerBtn === btn) { close(false); return; }

            // Close any previously open menu first
            if (_portalEl) close(false);

            // Clone the dropdown and portal it to <body>
            const portal = template.cloneNode(true);
            portal.style.position = 'fixed';   // CRITICAL: fixed, not absolute
            document.body.appendChild(portal);

            _portalEl   = portal;
            _triggerBtn = btn;
            _templateEl = template;
            _focusIdx   = -1;
            _items      = [];

            // Update trigger button ARIA state
            btn.setAttribute('aria-expanded', 'true');
            menuWrap.setAttribute('data-open', 'true');

            // Measure & position BEFORE animation (avoid FOUC).
            // Portal is in DOM with CSS opacity:0 (from base class), so layout
            // is available but nothing is visible to the user yet.
            // frame 1: force layout/measure → positionDropdown reads real dims
            // frame 2: apply open class → CSS transition fires
            requestAnimationFrame(() => {
                positionDropdown(btn, portal);
                // eslint-disable-next-line no-unused-expressions
                portal.offsetHeight; // force reflow before transition
                requestAnimationFrame(() => {
                    portal.classList.add('wa-msg-dropdown--open');
                });
            });

            // Attach global listeners
            document.addEventListener('keydown',      _onKeydown,        { capture: true });
            document.addEventListener('pointerdown',  _onOutsidePointer, { capture: true });
            window.addEventListener('scroll',         _scheduleReposition, { passive: true, capture: true });
            window.addEventListener('resize',         _scheduleReposition, { passive: true });
        }

        // ── Close ─────────────────────────────────────────────────────────
        function close(returnFocus = false) {
            if (!_portalEl) return;

            // Animate out
            const dying = _portalEl;
            dying.classList.remove('wa-msg-dropdown--open');
            // Remove from DOM after transition ends. Guard against double-fire
            // (transitionend fires per-property; setTimeout is the safety net).
            let cleaned = false;
            const cleanup = () => {
                if (cleaned) return;
                cleaned = true;
                dying.remove();
            };
            // Only listen for opacity transition to avoid multi-fire (one event per property)
            dying.addEventListener('transitionend', (e) => {
                if (e.propertyName === 'opacity') cleanup();
            }, { once: true });
            setTimeout(cleanup, 280); // fallback if transition never fires

            // Reset trigger state
            if (_triggerBtn) {
                _triggerBtn.setAttribute('aria-expanded', 'false');
                const menuWrap = _triggerBtn.closest('.wa-msg-menu');
                if (menuWrap) menuWrap.setAttribute('data-open', 'false');
                if (returnFocus) _triggerBtn.focus({ preventScroll: true });
            }

            // Remove global listeners
            document.removeEventListener('keydown',      _onKeydown,        { capture: true });
            document.removeEventListener('pointerdown',  _onOutsidePointer, { capture: true });
            window.removeEventListener('scroll',         _scheduleReposition, { capture: true });
            window.removeEventListener('resize',         _scheduleReposition);
            if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }

            _portalEl   = null;
            _triggerBtn = null;
            _templateEl = null;
            _focusIdx   = -1;
            _items      = [];
        }

        // ── Touch long-press support ─────────────────────────────────────
        // On touch devices where hover is unavailable, a long-press (500 ms) on
        // a message bubble opens its action menu without requiring a visible button.
        // This supplements the always-visible trigger button on touch devices.
        let _lpTimer  = null;
        let _lpTarget = null;

        function _onTouchStart(e) {
            const wrap = e.target.closest('.wa-msg-wrap');
            if (!wrap) return;
            // Don't intercept taps on interactive elements inside the bubble
            if (e.target.closest('button, a, input, textarea, .wa-msg-menu')) return;
            const btn = wrap.querySelector('.wa-msg-menu-btn');
            if (!btn) return;
            _lpTarget = btn;
            _lpTimer  = setTimeout(() => {
                if (_lpTarget) {
                    // Provide haptic feedback where available
                    if (navigator.vibrate) navigator.vibrate(40);
                    open(_lpTarget);
                }
                _lpTimer  = null;
                _lpTarget = null;
            }, 500);
        }

        function _onTouchEnd() {
            if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
            _lpTarget = null;
        }

        // ── Public API ───────────────────────────────────────────────────
        return { open, close, isOpen: () => !!_portalEl, onTouchStart: _onTouchStart, onTouchEnd: _onTouchEnd };
    })();

    // Expose close as closeAllDropdowns so existing call-sites work unchanged
    function closeAllDropdowns() { MessageMenuController.close(false); }

    // ── Shared message action handler ─────────────────────────────────────────
    // Used by BOTH chatContainer delegation AND the body-level portal delegation.
    // Returns true if the event was handled (caller should return/stop), false otherwise.
    async function handleMessageAction(e) {
        // Menu trigger button — open/toggle the portal menu
        const menuBtn = e.target.closest('.msg-menu-btn');
        if (menuBtn) {
            e.stopPropagation();
            MessageMenuController.open(menuBtn);
            return true;
        }

        const reactPill = e.target.closest('.wa-reaction-pill');
        if (reactPill) { await toggleReaction(reactPill.dataset.msgId, reactPill.dataset.emoji); return true; }

        const reactBtn = e.target.closest('.msg-react-btn');
        if (reactBtn) {
            closeAllDropdowns();
            await toggleReaction(reactBtn.dataset.msgId, reactBtn.dataset.emoji); return true;
        }

        const retryBtn = e.target.closest('.msg-retry-btn,.wa-retry-btn');
        if (retryBtn && activeRoomId) { await retrySend(retryBtn.dataset.msgId); return true; }

        const replyBtn = e.target.closest('.msg-reply-btn');
        if (replyBtn) {
            closeAllDropdowns();
            const msg = lastMessagesSnapshot.find(m => m.id === replyBtn.dataset.msgId);
            if (msg) {
                showReplyPreview(msg, chatHeader, input);
            } else {
                showReplyPreview({
                    id: replyBtn.dataset.msgId,
                    text: replyBtn.dataset.text || '',
                    senderName: replyBtn.dataset.sender || '',
                    senderEmail: '',
                    imageUrl: safeUrl(replyBtn.dataset.image || '') || '',
                    voiceUrl: safeUrl(replyBtn.dataset.voice || '') || '',
                    fileUrl:  safeUrl(replyBtn.dataset.file  || '') || '',
                    fileName: replyBtn.dataset.filename || ''
                }, chatHeader, input);
            }
            return true;
        }

        const editBtn = e.target.closest('.msg-edit-btn');
        if (editBtn) {
            closeAllDropdowns();
            const msgId   = editBtn.dataset.msgId;
            const msgText = editBtn.dataset.text || '';
            document.getElementById('wa-reply-preview')?.remove();
            const bar = document.createElement('div');
            bar.id = 'wa-reply-preview';
            bar.innerHTML = `
                <div class="wa-rp-line" style="background:var(--wa-warn)"></div>
                <div class="wa-rp-content">
                    <span class="wa-rp-name" style="color:var(--wa-warn)">✏️ Editing message</span>
                    <span class="wa-rp-text">${sanitize(msgText).substring(0, 80)}</span>
                </div>
                <button id="wa-reply-close" aria-label="Cancel edit">
                    <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>`;
            const form = document.getElementById('chat-message-form');
            form?.parentElement?.insertBefore(bar, form);
            document.getElementById('wa-reply-close')?.addEventListener('click', () => {
                editingMsgId  = null;
                bar.remove();
                input.value = '';
                input.style.height = 'auto';
            });
            editingMsgId  = msgId;
            input.value   = msgText;
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
            input.focus();
            return true;
        }

        const fwdBtn = e.target.closest('.msg-forward-btn');
        if (fwdBtn) {
            closeAllDropdowns();
            if (!requireAuth()) return true;
            await openForwardModal(fwdBtn.dataset.msgId); return true;
        }

        // FIX: Replace media — allows a message owner to swap the attached image,
        // video, or file for a new one. The Firestore doc is updated atomically;
        // the old Cloudinary asset URL is written to _deletedMediaUrls so a Cloud
        // Function can clean it up. Voice notes are intentionally excluded (audio
        // replacement produces confusing UX; users should delete and re-record).
        const replaceMediaBtn = e.target.closest('.msg-replace-media-btn');
        if (replaceMediaBtn) {
            closeAllDropdowns();
            if (!requireAuth()) return true;
            const replaceMsgId = replaceMediaBtn.dataset.msgId;
            const msgToReplace = lastMessagesSnapshot.find(m => m.id === replaceMsgId);
            if (!msgToReplace || msgToReplace.senderEmail !== currentUser.email) {
                showToast('You can only replace your own media.', 'error');
                return true;
            }
            // Derive the accept filter from the existing attachment type so the OS
            // file picker shows only compatible formats.
            const hasImage   = replaceMediaBtn.dataset.hasImage === 'true';
            const oldMime    = replaceMediaBtn.dataset.fileMime || '';
            const acceptType = hasImage ? 'image/*'
                             : oldMime.startsWith('video/') ? 'video/*'
                             : '*/*';

            const replaceInput = getAttachInput(acceptType, 'chat-replace-media-input');
            replaceInput.value = '';

            // Use a one-shot change handler to avoid stacking listeners
            const onReplaceChange = async (evt) => {
                replaceInput.removeEventListener('change', onReplaceChange);
                const newFile = evt.target.files?.[0];
                replaceInput.value = '';
                if (!newFile || !activeRoomId) return;
                if (newFile.size > MAX_UPLOAD_BYTES) {
                    showToast(`File too large (max 50 MB).`, 'error');
                    return;
                }
                // Disable UI during upload
                const savedPH = input.placeholder;
                input.placeholder = 'Uploading replacement…';
                input.disabled    = true;
                sendBtn.disabled  = true;
                if (attachBtn) attachBtn.disabled = true;
                try {
                    const fileToSend = newFile.type?.startsWith('image/')
                        ? await compressImageFile(newFile)
                        : newFile;
                    const newUrl = await uploadBytesWithRetry(
                        fileToSend, 'chats', null,
                        fileToSend.name || `replace_${Date.now()}`
                    );
                    // Build update: null out the old field, set the new one, mark as edited
                    const replaceUpdate = { edited: true, editedAt: serverTimestamp() };
                    // Collect old URL for orphan cleanup
                    const oldUrl = msgToReplace.imageUrl || msgToReplace.fileUrl;
                    if (oldUrl) replaceUpdate._deletedMediaUrls = [oldUrl];

                    if (hasImage) {
                        replaceUpdate.imageUrl = newUrl;
                    } else {
                        replaceUpdate.fileUrl  = newUrl;
                        replaceUpdate.fileName = newFile.name;
                        replaceUpdate.fileMime = newFile.type;
                        replaceUpdate.fileSize = newFile.size;
                    }
                    await updateDoc(
                        doc(db, `chats/${activeRoomId}/messages`, replaceMsgId),
                        replaceUpdate
                    );
                    showToast('Media replaced successfully!', 'success');
                } catch (err) {
                    console.error('[Chat] replace-media error:', err);
                    showToast('Failed to replace media.', 'error');
                } finally {
                    input.placeholder = savedPH;
                    input.disabled    = false;
                    sendBtn.disabled  = false;
                    if (attachBtn) attachBtn.disabled = false;
                }
            };
            replaceInput.addEventListener('change', onReplaceChange);
            replaceInput.click();
            return true;
        }

        const starBtn = e.target.closest('.msg-star-btn');
        if (starBtn) {
            closeAllDropdowns();
            if (!requireAuth()) return true;
            const msgId = starBtn.dataset.msgId;
            if (starredMessages.has(msgId)) { starredMessages.delete(msgId); showToast('Unstarred.'); }
            else { starredMessages.add(msgId); showToast('Message starred. ⭐'); }
            if (activeRoomId) {
                setDoc(doc(db, `chats/${activeRoomId}/starred`, currentUser.email), {
                    ids: [...starredMessages], updatedAt: serverTimestamp()
                }, { merge: true }).catch(() => {});
            }
            renderMessages(); return true;
        }

        const pinBtn = e.target.closest('.msg-pin-btn');
        if (pinBtn) {
            closeAllDropdowns();
            if (!requireAuth()) return true;
            const msgId = pinBtn.dataset.msgId;
            const newPinned = [msgId, ...pinnedMessages.filter(id => id !== msgId)].slice(0, 3);
            pinnedMessages.splice(0, pinnedMessages.length, ...newPinned);
            renderPinnedBar(chatHeader);
            try { await updateDoc(doc(db, 'chats', activeRoomId), { pinnedMessages }); } catch (err) { console.warn('[Chat] pin-sync error:', err); }
            showToast('Message pinned. 📌', 'success'); return true;
        }

        // FIX UI: Unpin button — removes the message from the pinned list
        const unpinBtn = e.target.closest('.msg-unpin-btn');
        if (unpinBtn) {
            closeAllDropdowns();
            if (!requireAuth()) return true;
            const msgId = unpinBtn.dataset.msgId;
            const newPinned = pinnedMessages.filter(id => id !== msgId);
            pinnedMessages.splice(0, pinnedMessages.length, ...newPinned);
            renderPinnedBar(chatHeader);
            try { await updateDoc(doc(db, 'chats', activeRoomId), { pinnedMessages }); } catch (err) { console.warn('[Chat] pin-sync error:', err); }
            showToast('Message unpinned.', 'info'); return true;
        }

        const copyBtn = e.target.closest('.msg-copy-btn');
        if (copyBtn) {
            closeAllDropdowns();
            // FIX: data-text is HTML-escaped for safe insertion — unescape back to raw text
            // for clipboard so the user gets plain text, not &amp;, &#39; etc.
            const rawText = copyBtn.dataset.text
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&#39;/g, "'").replace(/&quot;/g, '"');
            // FIX: use the raw message text from the snapshot when available — more reliable
            // than the data attribute which may truncate very long messages.
            const msgId  = copyBtn.dataset.msgId;
            const snapMsg = lastMessagesSnapshot.find(m => m.id === msgId);
            const textToCopy = snapMsg?.text ?? rawText;
            try {
                // navigator.clipboard requires HTTPS or localhost; fall back to execCommand on HTTP
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(textToCopy);
                } else {
                    const ta = document.createElement('textarea');
                    ta.value = textToCopy;
                    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    ta.remove();
                }
                showToast('Copied.', 'success');
            } catch (err) { console.error('[Chat] copy error:', err); showToast('Copy failed.', 'error'); }
            return true;
        }

        // Download button — saves image/file/voice attachment(s) to device.
        // BUG FIX: Previously only read data-url (one legacy URL) and ignored
        // msg.attachments[] entirely, so multi-attachment messages either showed
        // no download button or silently downloaded nothing.
        // FIX: when data-has-attachments is true, look up the message snapshot and
        // download every attachment in sequence; fall back to the single legacy URL
        // for backwards-compatible single-file messages.
        const downloadBtn = e.target.closest('.msg-download-btn');
        if (downloadBtn) {
            closeAllDropdowns();
            const msgId          = downloadBtn.dataset.msgId;
            const hasAttachments = downloadBtn.dataset.hasAttachments === 'true';

            // Helper: fetch one URL and trigger a browser Save dialog.
            // Falls back to window.open if cross-origin fetch is blocked.
            const downloadOne = async (url, filename) => {
                const safe = safeUrl(url);
                if (!safe) { console.warn('[Chat] skipping unsafe URL:', url); return; }
                try {
                    const resp = await fetch(safe);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const blob   = await resp.blob();
                    const objUrl = URL.createObjectURL(blob);
                    const a      = document.createElement('a');
                    a.href     = objUrl;
                    a.download = filename || 'download';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
                } catch (err) {
                    console.warn('[Chat] download-blob error (falling back to new tab):', err);
                    window.open(safe, '_blank', 'noopener,noreferrer');
                }
            };

            if (hasAttachments) {
                // Multi-attachment message: download each attachment file.
                const snapMsg = lastMessagesSnapshot.find(m => m.id === msgId);
                const atts    = snapMsg?.attachments;
                if (!atts?.length) {
                    showToast('No files found on this message.', 'error');
                    return true;
                }
                const count = atts.length;
                showToast(`Downloading ${count} file${count > 1 ? 's' : ''}…`, 'info');
                for (let i = 0; i < atts.length; i++) {
                    const att      = atts[i];
                    const attUrl   = safeUrl(att.url || '');
                    if (!attUrl) continue;
                    const attName  = att.name || `file_${i + 1}`;
                    await downloadOne(attUrl, attName);
                    // Small delay between sequential downloads so browsers don't block them.
                    if (i < atts.length - 1) await new Promise(r => setTimeout(r, 400));
                }
                showToast(`${count} file${count > 1 ? 's' : ''} downloaded.`, 'success');
            } else {
                // Legacy single-field message (imageUrl / fileUrl / voiceUrl).
                const url      = safeUrl(downloadBtn.dataset.url);
                const filename = downloadBtn.dataset.filename || 'download';
                if (!url) { showToast('No valid file to download.', 'error'); return true; }
                showToast('Preparing download…', 'info');
                await downloadOne(url, filename);
                showToast('Download started.', 'success');
            }
            return true;
        }

        // ══════════════════════════════════════════════════════════════════
        // PER-ATTACHMENT ACTIONS
        // Every handler resolves the exact attachment from lastMessagesSnapshot
        // via msgId + attIdx so there is zero ambiguity even after edits/deletes.
        // ══════════════════════════════════════════════════════════════════════

        // ── Touch toggle: tap an attachment to reveal/hide its action strip ──
        // On pointer devices the CSS :hover handles this; on touch we need a tap.
        const attItem = e.target.closest('.wa-att-item');
        if (attItem && e.pointerType === 'touch' && !e.target.closest('.wa-att-actions')) {
            // Toggle .wa-att-open on this item; close all others in the same message
            const isOpen = attItem.classList.contains('wa-att-open');
            const row    = attItem.closest('[data-message-row]');
            row?.querySelectorAll('.wa-att-item.wa-att-open').forEach(el => el.classList.remove('wa-att-open'));
            if (!isOpen) attItem.classList.add('wa-att-open');
            return true;
        }

        // ── Download single attachment ────────────────────────────────────────
        const attDownBtn = e.target.closest('.att-download-btn');
        if (attDownBtn) {
            const resolved = _resolveAttachment(attDownBtn.dataset.msgId, attDownBtn.dataset.attIdx);
            if (!resolved) { showToast('Attachment not found.', 'error'); return true; }
            const { att } = resolved;
            const url  = safeUrl(att.url || '');
            if (!url) { showToast('Invalid attachment URL.', 'error'); return true; }
            showToast('Downloading…', 'info');
            try {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error('fetch failed');
                const blob   = await resp.blob();
                const objUrl = URL.createObjectURL(blob);
                const a      = document.createElement('a');
                a.href     = objUrl;
                a.download = att.name || 'attachment';
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
                showToast('Download started.', 'success');
            } catch (_err) {
                window.open(url, '_blank', 'noopener,noreferrer');
            }
            return true;
        }

        // ── Reply to single attachment ────────────────────────────────────────
        // The reply preview shows the specific attachment thumbnail/icon, not the
        // whole message, so the recipient context is always unambiguous.
        const attReplyBtn = e.target.closest('.att-reply-btn');
        if (attReplyBtn) {
            const resolved = _resolveAttachment(attReplyBtn.dataset.msgId, attReplyBtn.dataset.attIdx);
            if (!resolved) return true;
            const { msg: rMsg, att: rAtt, idx: rIdx } = resolved;
            const isMe   = rMsg.senderEmail === currentUser.email;
            // Build a synthetic replyTo that points to the specific attachment.
            // attIdx is stored so the reply bubble renderer can highlight the right cell.
            replyingTo = {
                id:          rMsg.id,
                senderName:  rMsg.senderName || '',
                senderEmail: rMsg.senderEmail || '',
                text:        rAtt.name || '',
                // Populate the media preview fields depending on attachment type:
                imageUrl:    rAtt.type === 'image' ? rAtt.url : '',
                voiceUrl:    rAtt.type === 'audio' ? rAtt.url : '',
                fileUrl:     (rAtt.type === 'document' || rAtt.type === 'video') ? rAtt.url : '',
                fileName:    rAtt.name || '',
                _attIdx:     rIdx,   // kept for future per-attachment scroll-to
                attachments: rMsg.attachments,
            };
            // Show the reply preview bar above the compose form
            document.getElementById('wa-reply-preview')?.remove();
            const isMe2   = rMsg.senderEmail === currentUser.email;
            const label   = isMe2 ? 'You' : sanitize(rMsg.senderName || 'Someone');
            const typeIcon = rAtt.type === 'image' ? '📷' : rAtt.type === 'video' ? '🎥' : rAtt.type === 'audio' ? '🎤' : '📎';
            const preview  = `${typeIcon} ${sanitize(rAtt.name || 'Attachment')}`;
            const bar = document.createElement('div');
            bar.id = 'wa-reply-preview';
            bar.innerHTML = `
                <div class="wa-rp-line"></div>
                <div class="wa-rp-content">
                    <span class="wa-rp-name">${label}</span>
                    <span class="wa-rp-text">${preview}</span>
                </div>
                <button id="wa-reply-close" aria-label="Cancel reply">
                    <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>`;
            const form = document.getElementById('chat-message-form');
            form?.parentElement?.insertBefore(bar, form);
            document.getElementById('wa-reply-close')?.addEventListener('click', () => {
                replyingTo = null; bar.remove();
            });
            input.focus();
            return true;
        }

        // ── Forward single attachment ─────────────────────────────────────────
        // Opens the forward modal pre-scoped to this specific attachment only.
        const attFwdBtn = e.target.closest('.att-forward-btn');
        if (attFwdBtn) {
            if (!requireAuth()) return true;
            const resolved = _resolveAttachment(attFwdBtn.dataset.msgId, attFwdBtn.dataset.attIdx);
            if (!resolved) return true;
            const { msg: fMsg, att: fAtt } = resolved;
            // Build a synthetic single-attachment message for the forward modal.
            // We pass a fabricated message object so openForwardModal's existing logic
            // copies exactly this attachment — no changes needed inside that function.
            await openForwardSingleAttachment(fMsg, fAtt);
            return true;
        }

        // ── Replace single attachment (owner only) ────────────────────────────
        const attReplaceBtn = e.target.closest('.att-replace-btn');
        if (attReplaceBtn) {
            if (!requireAuth()) return true;
            const resolved = _resolveAttachment(attReplaceBtn.dataset.msgId, attReplaceBtn.dataset.attIdx);
            if (!resolved) { showToast('Attachment not found.', 'error'); return true; }
            const { msg: repMsg, att: repAtt, idx: repIdx } = resolved;

            if (repMsg.senderEmail !== currentUser.email) {
                showToast('You can only replace your own attachments.', 'error'); return true;
            }

            // Derive accept filter from the existing attachment type
            const acceptFilter = repAtt.type === 'image'    ? 'image/*'
                               : repAtt.type === 'video'    ? 'video/*'
                               : repAtt.type === 'audio'    ? 'audio/*'
                               : '*/*';
            const repInput = getAttachInput(acceptFilter, 'chat-att-replace-input');
            repInput.value = '';

            const onRepChange = async (evt) => {
                repInput.removeEventListener('change', onRepChange);
                const newFile = evt.target.files?.[0];
                repInput.value = '';
                if (!newFile || !activeRoomId) return;
                if (newFile.size > MAX_UPLOAD_BYTES) { showToast('File too large (max 50 MB).', 'error'); return; }

                const savedPH = input.placeholder;
                input.placeholder = 'Uploading replacement…';
                input.disabled = true; sendBtn.disabled = true;
                if (attachBtn) attachBtn.disabled = true;
                try {
                    const toSend  = newFile.type?.startsWith('image/') ? await compressImageFile(newFile) : newFile;
                    const newUrl  = await uploadBytesWithRetry(toSend, 'chats', null, toSend.name || `att_replace_${Date.now()}`);

                    // Build the updated attachments array — only the target index changes.
                    // Use runTransaction to guarantee we read the latest array, splice the
                    // one entry, and write back atomically, eliminating any race condition
                    // where two simultaneous replacements on the same message corrupt the array.
                    const msgRef = doc(db, `chats/${activeRoomId}/messages`, repMsg.id);
                    await runTransaction(db, async tx => {
                        const snap = await tx.get(msgRef);
                        if (!snap.exists()) throw new Error('msg_gone');
                        const d    = snap.data();
                        if (d.senderEmail !== currentUser.email) throw new Error('not_owner');
                        const atts = [...(d.attachments || [])];
                        if (repIdx >= atts.length) throw new Error('idx_oob');

                        const oldUrl = atts[repIdx].url;
                        atts[repIdx] = {
                            ...atts[repIdx],
                            url:  newUrl,
                            name: newFile.name,
                            mime: newFile.type,
                            size: newFile.size,
                        };
                        const update = {
                            attachments: atts,
                            edited:      true,
                            editedAt:    serverTimestamp(),
                        };
                        // Queue old Cloudinary asset for server-side cleanup
                        if (oldUrl) update._deletedMediaUrls = arrayUnion(oldUrl);
                        tx.update(msgRef, update);
                    });
                    showToast('Attachment replaced.', 'success');
                } catch (err) {
                    console.error('[Chat] att-replace error:', err);
                    showToast(err.message === 'not_owner' ? 'Permission denied.' : 'Failed to replace.', 'error');
                } finally {
                    input.placeholder = savedPH;
                    input.disabled = false; sendBtn.disabled = false;
                    if (attachBtn) attachBtn.disabled = false;
                }
            };
            repInput.addEventListener('change', onRepChange);
            repInput.click();
            return true;
        }

        // ── Delete single attachment (owner only) ─────────────────────────────
        // Removes the attachment from the attachments[] array and queues its
        // Cloudinary URL for server-side deletion. If it was the last attachment,
        // the message text is preserved (or the whole message soft-deleted if empty too).
        const attDelBtn = e.target.closest('.att-delete-btn');
        if (attDelBtn) {
            if (!requireAuth()) return true;
            const resolved = _resolveAttachment(attDelBtn.dataset.msgId, attDelBtn.dataset.attIdx);
            if (!resolved) { showToast('Attachment not found.', 'error'); return true; }
            const { msg: dMsg, att: dAtt, idx: dIdx } = resolved;

            if (dMsg.senderEmail !== currentUser.email) {
                showToast('You can only delete your own attachments.', 'error'); return true;
            }

            const isLastAtt   = dMsg.attachments.length === 1;
            const hasText     = !!(dMsg.text?.trim());
            const confirmBody = isLastAtt && !hasText
                ? 'This is the only attachment. The entire message will be deleted for everyone.'
                : isLastAtt
                    ? 'This is the only attachment. The message text will remain.'
                    : 'Only this file will be removed. Other attachments and the message text will remain.';

            const ok = await showConfirm({
                title: 'Delete this attachment?',
                body:  confirmBody,
                confirmLabel: 'Delete',
                tone: 'danger',
            });
            if (!ok) return true;

            try {
                const msgRef = doc(db, `chats/${activeRoomId}/messages`, dMsg.id);
                await runTransaction(db, async tx => {
                    const snap = await tx.get(msgRef);
                    if (!snap.exists()) throw new Error('msg_gone');
                    const d    = snap.data();
                    if (d.senderEmail !== currentUser.email) throw new Error('not_owner');
                    const atts = [...(d.attachments || [])];
                    if (dIdx >= atts.length) throw new Error('idx_oob');

                    const removedUrl = atts[dIdx].url;
                    atts.splice(dIdx, 1);

                    const update = { editedAt: serverTimestamp() };
                    if (removedUrl) update._deletedMediaUrls = arrayUnion(removedUrl);

                    if (atts.length === 0 && !d.text?.trim()) {
                        // No content left — soft-delete the whole message for everyone
                        update.isDeletedForEveryone = true;
                        update.attachments = [];
                        update.text = null;
                    } else {
                        update.attachments = atts;
                        update.edited = true;
                    }
                    tx.update(msgRef, update);
                });
                showToast(isLastAtt && !hasText ? 'Message deleted.' : 'Attachment removed.', 'success');
            } catch (err) {
                console.error('[Chat] att-delete error:', err);
                showToast(err.message === 'not_owner' ? 'Permission denied.' : 'Failed to delete attachment.', 'error');
            }
            return true;
        }

        const reportBtn = e.target.closest('.msg-report-btn');
        if (reportBtn) {
            closeAllDropdowns();
            if (!requireAuth()) return true;
            const msgId = reportBtn.dataset.msgId;
            const ok = await showConfirm({
                title: 'Report this message?',
                body: 'This message will be flagged for review. The sender will not be notified.',
                confirmLabel: 'Report', tone: 'danger'
            });
            if (ok && activeRoomId) {
                try {
                    // FIX SCHEMA: Firestore rule checks request.resource.data.reporterEmail
                    // and status == 'pending'. The old payload used 'reportedBy' (no status)
                    // → permission-denied on every report submit. Align with the rule schema.
                    await addDoc(collection(db, 'reports'), {
                        msgId,
                        roomId:        activeRoomId,
                        reporterEmail: currentUser.email,  // field the rule checks
                        reportedAt:    serverTimestamp(),
                        status:        'pending'           // required by create rule
                    });
                    showToast('Message reported.', 'success');
                } catch (err) { console.error('[Chat] report error:', err); showToast('Report failed.', 'error'); }
            }
            return true;
        }

        const delMeBtn = e.target.closest('.msg-delete-me-btn');
        if (delMeBtn && activeRoomId) {
            // FIX #2: Capture msgId and roomId BEFORE closeAllDropdowns() removes
            // the portal element from the DOM. The element reference stays valid in
            // memory but reading from a detached node is fragile — capture early.
            const _delMeMsgId  = delMeBtn.dataset.msgId;
            const _delMeRoomId = activeRoomId;
            closeAllDropdowns();
            // FIX AUTH-GUARD: verify authentication before writing
            if (!requireAuth()) return true;
            // FIX #2: Confirm before deleting so users don't lose messages accidentally.
            // "Delete for me" is irreversible from their perspective even though the data
            // remains visible to others — a confirmation prevents accidental taps.
            const ok = await showConfirm({
                title: 'Delete for me?',
                body: 'This message will be removed from your view. Other participants will still see it.',
                confirmLabel: 'Delete',
                tone: 'danger'
            });
            if (!ok) return true;
            try {
                await updateDoc(doc(db, `chats/${_delMeRoomId}/messages`, _delMeMsgId), {
                    deletedFor: arrayUnion(currentUser.email)
                });
            } catch (err) {
                // FIX #6: Log actual error so permission-denied / network issues are visible in devtools.
                console.error('[Chat] delete-for-me error:', err);
                showToast('Failed to delete.', 'error');
            }
            return true;
        }

        const delEveryoneBtn = e.target.closest('.msg-delete-everyone-btn');
        if (delEveryoneBtn && activeRoomId) {
            // FIX #3: Capture all required data BEFORE closeAllDropdowns() removes the
            // portal from the DOM. The dataset is still readable on detached nodes, but
            // capturing early is safer and makes the intent explicit.
            const msgId          = delEveryoneBtn.dataset.msgId;
            const capturedRoomId = activeRoomId;    // snapshot before any async
            const roomDetails    = activeRoomDetails; // snapshot before any async

            closeAllDropdowns();

            // FIX AUTH-GUARD + OWNERSHIP: verify auth and that this message belongs to
            // the current user. The button is rendered only for isMe messages, but a
            // direct DOM manipulation or race could trigger this handler for another
            // user's message. The Firestore rule also enforces this, but client-side
            // verification provides defense-in-depth and a better UX error message.
            if (!requireAuth()) return true;

            const msgToDelete = lastMessagesSnapshot.find(m => m.id === msgId);
            if (!msgToDelete || msgToDelete.senderEmail !== currentUser.email) {
                showToast('You can only delete your own messages.', 'error');
                return true;
            }

            // FIX #4: Re-validate the 60-minute window at handler time, not just at
            // render time. The dropdown template bakes the IIFE result in at render
            // time, so a message rendered while inside the window still shows an
            // enabled button even after 60 minutes have elapsed without re-render.
            // This handler-level check is the authoritative gate.
            const sentMs = msgToDelete.createdAt?.toDate?.()?.getTime?.() || Date.now();
            if (Date.now() - sentMs >= 60 * 60 * 1000) {
                showToast('You can only delete for everyone within 60 minutes of sending.', 'error');
                return true;
            }

            const ok = await showConfirm({
                title: 'Delete for everyone?',
                body: 'This message will be removed for all participants and cannot be undone.',
                confirmLabel: 'Delete', tone: 'danger'
            });
            if (!ok) return true;

            try {
                // FIX ORPHANED-ASSETS: collect media URLs before nulling so a future
                // Cloud Function (triggered on _deletedMediaUrls writes) can clean them
                // from Cloudinary. Client-side deletion is impossible — Cloudinary's
                // destroy API requires a signed request using the API secret which must
                // never be exposed in browser code.
                // Collect ALL media URLs (legacy fields + multi-attachment array)
                // so the Cloud Function cleanup queue is exhaustive.
                const orphanedUrls = [
                    msgToDelete.imageUrl,
                    msgToDelete.voiceUrl,
                    msgToDelete.fileUrl,
                    ...(msgToDelete.attachments || []).map(a => a.url).filter(Boolean),
                ].filter(Boolean);

                const deleteUpdate = {
                    isDeletedForEveryone: true,
                    text: null, imageUrl: null, voiceUrl: null, fileUrl: null,
                    fileName: null, fileMime: null, fileSize: null,
                    attachments: [],   // clear multi-attachment array too
                };
                if (orphanedUrls.length) {
                    deleteUpdate._deletedMediaUrls = orphanedUrls;
                }

                // FIX #5: Use writeBatch so the message update and the room metadata
                // update are committed atomically. Previously two sequential `await`
                // calls meant: if the first succeeded but the second failed, the message
                // was marked deleted but the room sidebar showed stale last-message text,
                // and the catch block fired "Failed to delete." even though the message
                // WAS actually deleted — a misleading error that confused users into
                // thinking deletion had failed entirely.
                const batch = writeBatch(db);

                batch.update(
                    doc(db, `chats/${capturedRoomId}/messages`, msgId),
                    deleteUpdate
                );

                // Bump unread for recipients so they see the deletion event
                const roomMembers = roomDetails?.type === 'group'
                    ? []   // group: skip unread bump on deletion (avoid noise)
                    : [roomDetails?.targetEmail].filter(Boolean);
                const unreadBump = {};
                for (const em of roomMembers) {
                    if (em && em !== currentUser.email) {
                        unreadBump[`unreadCount.${em}`] = increment(1);
                    }
                }
                batch.set(doc(db, 'chats', capturedRoomId), {
                    lastMessage: '', lastSenderEmail: currentUser.email,
                    lastUpdated: serverTimestamp(),
                    [`unreadCount.${currentUser.email}`]: 0,
                    ...unreadBump
                }, { merge: true });

                await batch.commit();
            } catch (err) {
                // FIX #6: Log actual error so permission-denied / network issues are
                // visible in devtools. The original `catch {}` silently swallowed
                // everything, making it impossible to diagnose why deletion failed.
                console.error('[Chat] delete-for-everyone error:', err);
                showToast('Failed to delete.', 'error');
            }
            return true;
        }

        return false; // event not handled
    }

    // FIX DUPLICATE-LISTENER: point the module-level reference at THIS session's
    // handleMessageAction so the once-registered body listener always dispatches
    // through the correct closure (e.g. the right activeRoomId, currentUser, etc.).
    _globalPortalClickHandler = handleMessageAction;

    // ── Touch long-press for message menus ───────────────────────────────────
    // Attach to chatContainer so it only fires inside the message list.
    chatContainer?.addEventListener('touchstart', MessageMenuController.onTouchStart, { passive: true });
    chatContainer?.addEventListener('touchend',   MessageMenuController.onTouchEnd,   { passive: true });
    chatContainer?.addEventListener('touchmove',  MessageMenuController.onTouchEnd,   { passive: true });
    chatContainer?.addEventListener('touchcancel',MessageMenuController.onTouchEnd,   { passive: true });

    // ── Body-level delegation for PORTALED dropdown items ─────────────────────
    // When MessageMenuController portals a dropdown to <body>, its items are no
    // longer inside #chat-messages, so chatContainer's click listener never fires.
    // This body listener catches those clicks.
    //
    // FIX PORTAL-LISTENER: Previously guarded by _globalListenersSetup, which is
    // set to true EARLIER in the same setupChat() call (for the auth observers).
    // By the time we reached this block, the flag was already true → the body
    // listener was NEVER registered and all portaled dropdown actions (delete,
    // star, pin, forward, etc.) silently did nothing.
    // Now uses _portalListenerSetup which is only flipped here, ensuring the
    // handler is registered exactly once across all setupChat() calls.
    if (!_portalListenerSetup) {
        _portalListenerSetup = true;
        document.body.addEventListener('click', async e => {
            // Only handle clicks that came from inside a portaled .wa-msg-dropdown
            if (!e.target.closest('.wa-msg-dropdown')) return;
            // Route through the module-level handler reference so the correct
            // setupChat() closure (for the current session) always handles the event.
            if (typeof _globalPortalClickHandler === 'function') {
                await _globalPortalClickHandler(e);
            }
        });
    }

    // ── Message click delegation (inside #chat-messages) ──────────────────────
    // NOTE: Portal (body-level) item clicks are handled by the body listener above.
    chatContainer?.addEventListener('click', async e => {
        // Any click outside a menu trigger/portal closes the menu
        if (!e.target.closest('.wa-msg-menu') && !e.target.closest('.wa-msg-dropdown')) {
            closeAllDropdowns();
        }
        // Close any open per-attachment action strips when tapping outside an attachment
        if (!e.target.closest('.wa-att-item')) {
            document.querySelectorAll('.wa-att-item.wa-att-open').forEach(el => el.classList.remove('wa-att-open'));
        }

        // Delegate to shared handler — returns true if handled
        if (await handleMessageAction(e)) return;

        // ── Non-menu interactions that only exist in the chat scroll area ──

        // ── Gallery / lightbox open ────────────────────────────────────────────
        // Clicking a .wa-att-image, a video thumbnail, or the +N overlay opens the
        // full-screen gallery with ALL attachments from that message at the right position.
        // Clicks inside the action strip (.wa-att-actions) are excluded.
        const _galleryTrigger = e.target.closest('.wa-att-image, .wa-att-more-overlay, .wa-att-video-wrap');
        if (_galleryTrigger && !e.target.closest('.wa-att-actions') && !e.target.closest('video')) {
            // For video wraps, don't steal clicks on the native video controls
            if (_galleryTrigger.classList.contains('wa-att-video-wrap') && e.target.tagName === 'VIDEO') {
                // Let the browser handle native video control clicks
            } else {
                const msgId  = _galleryTrigger.dataset.msgId
                            || _galleryTrigger.closest('[data-msg-id]')?.dataset.msgId;
                const attIdx = parseInt(
                    _galleryTrigger.dataset.attIdx
                    ?? _galleryTrigger.dataset.attStartIdx
                    ?? _galleryTrigger.closest('[data-att-idx]')?.dataset.attIdx
                    ?? '-1',
                    10
                );
                const snapMsg = msgId ? lastMessagesSnapshot.find(m => m.id === msgId) : null;

                if (snapMsg?.attachments?.length) {
                    // Build gallery items from the message's full attachments array
                    const galleryItems = snapMsg.attachments.map(a => ({
                        url:  safeUrl(a.url || '') || '',
                        type: a.type || 'image',
                        name: a.name || '',
                    })).filter(it => it.url);
                    openGallery(galleryItems, Math.max(0, attIdx));
                } else {
                    // Legacy single-image or unknown — fall back to simple lightbox
                    const url = _galleryTrigger.dataset.full
                             || (_galleryTrigger.tagName === 'IMG' ? _galleryTrigger.src : '')
                             || '';
                    if (url) openLightbox(url);
                }
                return;
            }
        }

        // Legacy .msg-image click (non-attachment images, e.g. old imageUrl field)
        const imgEl = e.target.closest('.msg-image, .wa-msg-image');
        if (imgEl && !e.target.closest('.wa-att-image')) { openLightbox(imgEl.dataset.full || imgEl.src); return; }

        const replyBubble = e.target.closest('.wa-reply-bubble');
        if (replyBubble) {
            const id        = replyBubble.dataset.replyId;
            const targetRow = chatContainer.querySelector(`[data-msg-id="${id}"]`);
            if (targetRow) {
                targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
                targetRow.style.background = 'rgba(79,70,229,.12)';
                setTimeout(() => { targetRow.style.background = ''; }, 1200);
            }
            return;
        }

        const voicePlayBtn = e.target.closest('.wa-voice-play-btn');
        if (voicePlayBtn) {
            const url = voicePlayBtn.dataset.voiceUrl;
            if (!url) return;

            const PLAY_ICON  = `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
            const PAUSE_ICON = `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;

            // FIX: if something is already playing, stop it and reset ITS button (not the clicked one)
            if (_activeAudio && !_activeAudio.paused) {
                // Find the button that owns the currently playing audio and reset it
                const playingUrl = _activeAudio._voiceUrl;
                if (playingUrl) {
                    document.querySelectorAll(`.wa-voice-play-btn[data-voice-url="${cssEscape(playingUrl)}"]`)
                        .forEach(b => { b.innerHTML = PLAY_ICON; });
                    // Remove playing class from the previously-active voice note container
                    document.querySelectorAll(`.wa-voice-note[data-voice-url="${cssEscape(playingUrl)}"]`)
                        .forEach(n => { n.classList.remove('playing'); });
                }
                _activeAudio.pause();
                _activeAudio = null;
                // If user clicked the SAME button that was playing, just stop — don't restart
                if (playingUrl === url) return;
            }

            const _safeVoice = safeUrl(url);
            if (!_safeVoice) return;

            const audio      = new Audio(_safeVoice);
            audio._voiceUrl  = url; // FIX: tag audio with its source URL so we can reset the right button
            _activeAudio     = audio;
            voicePlayBtn.innerHTML = PAUSE_ICON;

            // Mark the voice-note container as playing so CSS waveform animation fires
            const voiceNote  = voicePlayBtn.closest('.wa-voice-note');
            const durSpan    = voiceNote?.querySelector('.wa-voice-duration');
            const totalDur   = durSpan ? durSpan.textContent : '';
            if (voiceNote) voiceNote.classList.add('playing');

            // FIX: handle load/play errors — reset button, remove playing class, clear ref
            const resetBtn = () => {
                voicePlayBtn.innerHTML = PLAY_ICON;
                if (voiceNote) voiceNote.classList.remove('playing');
                if (durSpan && totalDur) durSpan.textContent = totalDur; // restore original duration
                if (_activeAudio === audio) _activeAudio = null; // FIX: null out on end/error
            };

            // Live elapsed time counter during playback
            audio.addEventListener('timeupdate', () => {
                if (!durSpan) return;
                const elapsed = Math.floor(audio.currentTime);
                durSpan.textContent = formatDuration(elapsed);
            });

            audio.addEventListener('ended', resetBtn);
            audio.addEventListener('error', () => {
                resetBtn();
                showToast('Could not play voice note.', 'error');
            });
            audio.play().catch(() => {
                resetBtn();
                showToast('Could not play voice note.', 'error');
            });
            return;
        }
    });

    // ── Header action delegation ─────────────────
    chatHeader?.addEventListener('click', async e => {
        if (!activeRoomId || !activeRoomDetails) return;

        if (e.target.id === 'chat-action-leave') {
            document.getElementById('chat-header-dropdown') &&
                (document.getElementById('chat-header-dropdown').style.display = 'none');
            const ok = await showConfirm({
                title: 'Leave group?',
                body: `You'll stop receiving messages from ${activeRoomDetails.targetName}.`,
                confirmLabel: 'Leave', tone: 'danger'
            });
            if (!ok) return;
            try {
                // FIX: write the system message BEFORE removing from members.
                // The messages rule calls isChatMember() — if we remove from members first,
                // the addDoc fires when the user is no longer a member → permission-denied,
                // the catch block fires, and the UI shows "Failed to leave" even though the
                // updateDoc already succeeded and the user actually did leave.
                // Writing the message first (while still a member) avoids this race.
                await addDoc(collection(db, `chats/${activeRoomId}/messages`), {
                    text: `${currentUser.name} left the group.`,
                    senderEmail: 'system', senderName: 'System', createdAt: serverTimestamp()
                });
                // Also remove from memberNames and admins so no orphaned data remains.
                await updateDoc(doc(db, 'chats', activeRoomId), {
                    members:     arrayRemove(currentUser.email),
                    memberNames: arrayRemove(currentUser.name),
                    admins:      arrayRemove(currentUser.email),
                });
                resetChatPanel(chatHeader, chatContainer, input, sendBtn, attachBtn);
                showToast('You left the group.', 'success');
                document.getElementById('btn-show-recent')?.click();
            } catch (err) { console.error('[Chat] leave-group error:', err); showToast('Failed to leave.', 'error'); }
            return;
        }

        if ((e.target.id === 'chat-action-view-members' ||
             e.target.closest('#chat-action-view-members-btn')) &&
             activeRoomDetails.type === 'group') {
            document.getElementById('chat-header-dropdown') &&
                (document.getElementById('chat-header-dropdown').style.display = 'none');
            await openMembersPanel(); return;
        }

        if (e.target.id === 'chat-action-clear') {
            document.getElementById('chat-header-dropdown') &&
                (document.getElementById('chat-header-dropdown').style.display = 'none');
            if (!requireAuth()) return;
            const ok = await showConfirm({
                title: 'Clear chat?',
                body: 'All messages will be cleared for you only.',
                confirmLabel: 'Clear', tone: 'danger'
            });
            if (!ok) return;
            try {
                const roomIdToClear = activeRoomId;
                const msgsSnap = await getDocs(collection(db, `chats/${roomIdToClear}/messages`));
                // FIX #8: use writeBatch instead of parallel updateDoc calls
                const _clearDocs = msgsSnap.docs;
                const BATCH_SIZE = 499;
                for (let _bi = 0; _bi < _clearDocs.length; _bi += BATCH_SIZE) {
                    const _wb = writeBatch(db);
                    _clearDocs.slice(_bi, _bi + BATCH_SIZE).forEach(d =>
                        _wb.update(d.ref, { deletedFor: arrayUnion(currentUser.email) })
                    );
                    await _wb.commit();
                }
                lastMessagesSnapshot.splice(0, lastMessagesSnapshot.length);
                renderMessages();
                showToast('Chat cleared.', 'success');
            } catch (err) { console.error('[Chat] clear-chat error:', err); showToast('Failed to clear chat.', 'error'); }
            return;
        }

        if (e.target.id === 'chat-action-delete') {
            document.getElementById('chat-header-dropdown') &&
                (document.getElementById('chat-header-dropdown').style.display = 'none');
            if (!requireAuth()) return;
            const ok = await showConfirm({
                title: 'Delete chat?',
                body: 'All messages will be permanently removed. This cannot be undone.',
                confirmLabel: 'Delete', tone: 'danger'
            });
            if (!ok) return;
            try {
                const roomIdToDelete = activeRoomId;
                const msgsSnap = await getDocs(collection(db, `chats/${roomIdToDelete}/messages`));
                // FIX #8: use writeBatch (max 499 ops) so Firestore rate-limits properly
                const _delDocs = msgsSnap.docs;
                const BATCH_SIZE = 499;
                for (let _bi = 0; _bi < _delDocs.length; _bi += BATCH_SIZE) {
                    const _wb = writeBatch(db);
                    _delDocs.slice(_bi, _bi + BATCH_SIZE).forEach(d => _wb.delete(d.ref));
                    await _wb.commit();
                }
                await deleteDoc(doc(db, 'chats', roomIdToDelete));
                resetChatPanel(chatHeader, chatContainer, input, sendBtn, attachBtn);
                showToast('Chat deleted.', 'success');
            } catch (err) { console.error('[Chat] delete-chat error:', err); showToast('Failed to delete chat.', 'error'); }
            return;
        }

        if (e.target.id === 'chat-action-block') {
            document.getElementById('chat-header-dropdown') &&
                (document.getElementById('chat-header-dropdown').style.display = 'none');
            const isUnblocking = e.target.dataset.blocked === 'true';
            if (!isUnblocking) {
                const ok = await showConfirm({
                    title: 'Block user?',
                    body: `${activeRoomDetails.targetName} won't be able to message you.`,
                    confirmLabel: 'Block', tone: 'danger'
                });
                if (!ok) return;
            }
            try {
                await updateDoc(doc(db, 'chats', activeRoomId), {
                    blockedBy: isUnblocking ? arrayRemove(currentUser.email) : arrayUnion(currentUser.email)
                });
                showToast(isUnblocking ? 'User unblocked.' : 'User blocked.', 'success');
            } catch (err) { console.error('[Chat] block-status error:', err); showToast('Failed to update block status.', 'error'); }
            return;
        }

        const isViewProfile = e.target.id === 'chat-action-view' ||
                              e.target.closest('#chat-header-profile-btn');
        if (isViewProfile && activeRoomDetails.type === 'private') {
            document.getElementById('chat-header-dropdown') &&
                (document.getElementById('chat-header-dropdown').style.display = 'none');
            try {
                const q    = query(collection(db, 'users'), where('email', '==', activeRoomDetails.targetEmail));
                const snap = await getDocs(q);
                if (snap.empty) { showToast('User not found.', 'error'); return; }
                const userData = snap.docs[0].data();
                const setField = (id, v, fb = '') => { const el = document.getElementById(id); if (el) el.textContent = v || fb; };
                const showHide = (id, v, fn) => {
                    const el = document.getElementById(id);
                    if (!el) return;
                    if (v) { el.classList.remove('hidden'); fn(el, v); } else el.classList.add('hidden');
                };
                setField('user-profile-page-name', userData.name, 'Unknown');
                setField('user-profile-page-username', userData.email, '');
                const avatarEl2 = document.getElementById('user-profile-page-avatar');
                if (avatarEl2) {
                    avatarEl2.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:2.5rem;font-weight:700;color:#fff">
                        ${(userData.name || 'U').charAt(0).toUpperCase()}</div>`;
                }
                showHide('user-profile-page-major', userData.major, (el, v) => {
                    const span = el.querySelector('.val');
                    if (span) span.textContent = v;
                });
                showHide('user-profile-page-year', userData.gradYear, (el, v) => {
                    const span = el.querySelector('.val');
                    if (span) span.textContent = v;
                });
                showHide('user-profile-page-bio', userData.bio, (el, v) => { el.textContent = v; });
                const postsFeed = document.getElementById('user-profile-posts-feed');
                if (postsFeed) postsFeed.innerHTML = '<p class="text-slate-500 text-sm">Loading posts…</p>';
                const { showPage } = await import('../ui/navigation.js');
                showPage('page-user-profile');
                const postsSnap = await getDocs(query(
                    collection(db, 'posts'),
                    where('authorEmail', '==', userData.email),
                    orderBy('timestamp', 'desc'),
                    limit(10)
                ));
                if (postsFeed) {
                    if (postsSnap.empty) {
                        postsFeed.innerHTML = '<p class="text-slate-500 text-sm">No posts yet.</p>';
                    } else {
                        const { createPostCardHTML } = await import('../ui/templates.js');
                        postsFeed.innerHTML = '';
                        postsSnap.forEach(d => {
                            postsFeed.innerHTML += createPostCardHTML({ id: d.id, ...d.data() }, currentUser);
                        });
                    }
                }
            } catch (err) { console.error(err); showToast('Failed to load profile.', 'error'); }
            return;
        }
    });

    // ── Send text message ─────────────────────────
    let optimisticCounter = 0;

    async function sendTextMessage(text) {
        if (!text || !activeRoomId || !activeRoomDetails || !currentUser?.email) return;
        const roomId      = activeRoomId;
        // FIX: snapshot all room context before the first await — if the user switches
        // rooms mid-send, activeRoomId/activeRoomDetails will have changed by the time
        // the await resolves, causing the unread bump to target the wrong chat.
        const _roomType   = activeRoomDetails.type;
        const _recipEmail = activeRoomDetails.targetEmail;
        const tempId  = `pending_${Date.now()}_${optimisticCounter++}`;
        const replyTo = replyingTo ? { ...replyingTo } : null;

        const optimisticMsg = {
            id: tempId, text, senderEmail: currentUser.email, senderName: currentUser.name,
            createdAt: { toDate: () => new Date() }, _pending: true, replyTo
        };
        // FIX #7: clear replyingTo BEFORE any await so a room-switch mid-send
        // can't clobber the new room's reply state
        replyingTo = null;
        document.getElementById('wa-reply-preview')?.remove();

        if (roomId === activeRoomId) {
            // FIX #1: unshift in-place rather than reassigning the array
            lastMessagesSnapshot.unshift(optimisticMsg);
            renderMessages();
        }
        clearTypingState();
        writeTypingState(roomId, false);

        try {
            const payload = {
                text, senderEmail: currentUser.email, senderName: currentUser.name,
                createdAt: serverTimestamp(), seenBy: []
            };
            if (replyTo) payload.replyTo = replyTo;

            // FIX ATOMIC-TEXT: use writeBatch so message + room metadata land together.
            // The old sequential addDoc → setDoc had a window where the Firestore listener
            // would see the new message but the room doc still showed the old lastMessage —
            // causing a momentary sidebar flash with stale preview text.
            const _sendUpdate = {
                lastMessage: text, lastSenderEmail: currentUser.email,
                lastUpdated: serverTimestamp(),
                [`unreadCount.${currentUser.email}`]: 0
            };
            // FIX Bug 4: build the entire unread update before opening the batch.
            if (_roomType === 'private' && _recipEmail) {
                _sendUpdate[`unreadCount.${_recipEmail}`] = increment(1);
            } else if (_roomType === 'group') {
                const _rSnap = await getDoc(doc(db, 'chats', roomId)).catch(() => null);
                const _groupMembers = _rSnap?.data()?.members || [];
                for (const _gm of _groupMembers) {
                    if (_gm && _gm !== currentUser.email) {
                        _sendUpdate[`unreadCount.${_gm}`] = increment(1);
                    }
                }
            }

            // Atomic write: message doc + room metadata in one batch
            const _txBatch = writeBatch(db);
            const _msgRef  = doc(collection(db, `chats/${roomId}/messages`));
            _txBatch.set(_msgRef, payload);
            _txBatch.set(doc(db, 'chats', roomId), _sendUpdate, { merge: true });
            await _txBatch.commit();

            // FIX #1: mutate in-place; also handles the case where
            // the Firestore snapshot already removed the temp entry
            const _si = lastMessagesSnapshot.findIndex(m => m.id === tempId);
            if (_si !== -1) lastMessagesSnapshot.splice(_si, 1);
            if (roomId === activeRoomId) renderMessages();
        } catch (err) {
            console.error('Send failed:', err);
            // FIX #1+#6: mutate in-place; if user switched rooms the entry
            // won't be found — no-op is correct (old room's list was reset)
            const _fi = lastMessagesSnapshot.findIndex(m => m.id === tempId);
            if (_fi !== -1) {
                lastMessagesSnapshot[_fi] = { ...lastMessagesSnapshot[_fi], _pending: false, _failed: true };
            }
            if (roomId === activeRoomId) renderMessages();
            showToast('Failed to send.', 'error');
        }
    }

    async function retrySend(tempId) {
        // FIX AUTH-GUARD: user may have signed out while message was in failed state
        if (!requireAuth()) return;
        const t = lastMessagesSnapshot.find(m => m.id === tempId);
        if (!t) return;
        // FIX #1: mutate in-place
        const _ri = lastMessagesSnapshot.findIndex(m => m.id === tempId);
        if (_ri !== -1) lastMessagesSnapshot.splice(_ri, 1);
        // FIX: restore replyTo from the failed message so it's preserved on retry
        if (t.replyTo) replyingTo = t.replyTo;
        await sendTextMessage(t.text);
    }

    // FIX: shared helper — was copy-pasted identically in both submit and keydown handlers
    async function commitInput() {
        const text = input.value.trim();

        // ── NEW: if compose tray has attachments, send them (with optional caption) ──
        if (pendingAttachments.length) {
            if (!editingMsgId) { // don't mix edit-mode with attachment send
                await sendComposedMessage(text);
                return;
            }
        }

        if (!text) return;
        // EXT: if in edit mode, update the existing message instead of sending new
        if (editingMsgId) {
            const idToEdit = editingMsgId;
            // FIX AUTH-GUARD + OWNERSHIP: verify auth and message ownership before sending
            // the edit. editingMsgId is set via the dropdown button which checks isMe at
            // render time, but a room-switch or re-render between click and commit could
            // leave a stale editingMsgId pointing at a different user's message.
            if (!requireAuth()) {
                editingMsgId = null;
                document.getElementById('wa-reply-preview')?.remove();
                input.value = ''; input.style.height = 'auto';
                return;
            }
            const msgToEdit = lastMessagesSnapshot.find(m => m.id === idToEdit);
            if (!msgToEdit || msgToEdit.senderEmail !== currentUser.email) {
                showToast('You can only edit your own messages.', 'error');
                editingMsgId = null;
                document.getElementById('wa-reply-preview')?.remove();
                input.value = ''; input.style.height = 'auto';
                return;
            }
            editingMsgId   = null;
            document.getElementById('wa-reply-preview')?.remove();
            input.value        = '';
            input.style.height = 'auto';
            input.focus();
            try {
                // FIX: guard activeRoomId — could be null if user navigated away during edit
                if (!activeRoomId) { showToast('Chat closed — edit cancelled.', 'warning'); return; }
                await updateDoc(doc(db, `chats/${activeRoomId}/messages`, idToEdit), {
                    text, edited: true, editedAt: serverTimestamp()
                });
                showToast('Message edited.', 'success');
            } catch (err) { console.error('[Chat] edit-message error:', err); showToast('Failed to edit message.', 'error'); }
            return;
        }
        if (!activeRoomId) return;
        input.value = '';
        input.style.height = 'auto';
        input.focus();
        sendTextMessage(text);
    }

    // Send on form submit
    document.getElementById('chat-message-form')?.addEventListener('submit', async e => {
        e.preventDefault();
        await commitInput();
    });

    // Enter = send/edit, Shift+Enter = newline
    input.addEventListener('keydown', async e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            await commitInput();
        }
    });

    input.addEventListener('input', handleInputTyping);

    // Emoji button
    document.getElementById('chat-emoji-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        toggleEmojiPicker(input);
    });

    // Attach button
    attachBtn?.addEventListener('click', e => {
        if (!activeRoomId) return;
        e.stopPropagation();
        openAttachMenu();
    });

    // ── Attach menu ──────────────────────────────
    function openAttachMenu() {
        const existing = document.getElementById('wa-attach-menu');
        if (existing) { existing.remove(); return; }
        const menu = document.createElement('div');
        menu.id = 'wa-attach-menu';
        menu.innerHTML = `
            <button class="wa-attach-item" id="wa-attach-image-btn">
                <span class="wa-attach-icon" style="background:rgba(16,185,129,.12)">🖼️</span>
                <span>Photo / Image</span>
            </button>
            <button class="wa-attach-item" id="wa-attach-video-btn">
                <span class="wa-attach-icon" style="background:rgba(59,130,246,.12)">🎥</span>
                <span>Video</span>
            </button>
            <button class="wa-attach-item" id="wa-attach-audio-btn">
                <span class="wa-attach-icon" style="background:rgba(245,158,11,.12)">🎵</span>
                <span>Audio file</span>
            </button>
            <button class="wa-attach-item" id="wa-attach-file-btn">
                <span class="wa-attach-icon" style="background:rgba(168,85,247,.12)">📄</span>
                <span>Document</span>
            </button>
            <p style="font-size:11px;color:var(--wa-sub);padding:6px 14px 4px;margin:0">
                Select multiple files — they'll send together
            </p>`;
        const inputArea = input.closest('form') || input.parentElement;
        (inputArea?.parentElement || document.body).appendChild(menu);

        // Lazily create the audio input (same pattern as other inputs)
        const audioAttachInput = getAttachInput('audio/*', 'chat-attach-audio-input');
        audioAttachInput.addEventListener('change', async e => {
            const files = Array.from(e.target.files || []);
            if (files.length) { await addFilesToCompose(files); audioAttachInput.value = ''; }
        });

        document.getElementById('wa-attach-image-btn').addEventListener('click', () => { imageAttachInput.click(); menu.remove(); });
        document.getElementById('wa-attach-video-btn').addEventListener('click', () => { videoAttachInput.click(); menu.remove(); });
        document.getElementById('wa-attach-audio-btn').addEventListener('click', () => { audioAttachInput.click(); menu.remove(); });
        document.getElementById('wa-attach-file-btn').addEventListener('click', () => { fileAttachInput.click(); menu.remove(); });

        setTimeout(() => {
            document.addEventListener('click', function hideMenu(e) {
                if (!menu.contains(e.target) && !attachBtn?.contains(e.target)) {
                    menu.remove();
                    document.removeEventListener('click', hideMenu);
                }
            });
        }, 0);
    }

    // ── File upload ──────────────────────────────
    // MAX_UPLOAD_BYTES is declared at module scope (above) so it is accessible
    // from handleMessageAction (replace-media handler) without a TDZ error.

    // FIXED: sendMediaFile is intentionally single-file; multi-file callers use sendFilesSequentially.
    // Progress bar is re-created per file so sequential uploads each show their own progress.
    async function sendMediaFile(file) {
        // FIX AUTH-GUARD: re-verify auth at send time — token may have expired since the
        // attach button was clicked (e.g. long compression step on a large image).
        if (!file || !activeRoomId || !requireAuth()) return;
        if (file.size > MAX_UPLOAD_BYTES) {
            showToast(`"${file.name}" is too large (max 50 MB).`, 'error');
            return;
        }
        const roomId      = activeRoomId;
        // FIX: snapshot room context before upload await — prevents room-switch race
        const _fileRoomType = activeRoomDetails?.type;
        const _fileRecip    = activeRoomDetails?.targetEmail;
        const isImage = file.type?.startsWith('image/');
        const isVideo = file.type?.startsWith('video/');
        const savedPH = input.placeholder;

        // EXT: compress images client-side before upload
        const fileToSend = isImage ? await compressImageFile(file) : file;

        // Show upload progress bar
        document.getElementById('wa-attach-progress')?.remove();
        const progressBar = document.createElement('div');
        progressBar.id = 'wa-attach-progress';
        progressBar.style.cssText = 'position:absolute;bottom:70px;left:50%;transform:translateX(-50%);background:var(--wa-panel);border:1px solid var(--wa-border);border-radius:14px;padding:12px 18px;display:flex;flex-direction:column;gap:8px;min-width:240px;box-shadow:var(--wa-shadow-lg);z-index:80;';
        progressBar.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:20px">${isImage ? '🖼️' : isVideo ? '🎥' : '📄'}</span>
                <div style="flex:1;min-width:0">
                    <p style="font-size:13px;font-weight:600;color:var(--wa-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${file.name}</p>
                    <p style="font-size:11px;color:var(--wa-sub);margin-top:2px" id="wa-upload-status">Preparing…</p>
                </div>
            </div>
            <div style="height:4px;border-radius:4px;background:var(--wa-input-bg);overflow:hidden">
                <div id="wa-upload-bar" style="height:100%;width:0%;background:var(--wa-accent);border-radius:4px;transition:width .2s ease"></div>
            </div>`;
        const inputForm = input.closest('form') || input.parentElement;
        (inputForm?.parentElement || document.body).appendChild(progressBar);

        const setProgress = (pct, label) => {
            const bar = document.getElementById('wa-upload-bar');
            const st  = document.getElementById('wa-upload-status');
            if (bar) bar.style.width = pct + '%';
            if (st)  st.textContent  = label;
        };

        input.placeholder = 'Uploading…';
        input.disabled    = true;
        sendBtn.disabled  = true;
        if (attachBtn) attachBtn.disabled = true;
        try {
            // All media goes through Cloudinary (Firebase Spark plan has no Storage).
            // uploadBytesWithRetry wraps uploadToCloudinary with retry + progress.
            // FIX: removed redundant inner try/catch that only re-threw — outer catch handles it
            const url = await uploadBytesWithRetry(fileToSend, 'chats', (pct, attempt) => {
                setProgress(pct, attempt > 0 ? `Retrying… (attempt ${attempt + 1})` : `Uploading… ${pct}%`);
            }, fileToSend instanceof File ? fileToSend.name : `upload_${Date.now()}`);
            setProgress(100, 'Done');

            const payload = {
                senderEmail: currentUser.email, senderName: currentUser.name,
                createdAt: serverTimestamp(), seenBy: [], text: ''
            };
            if (replyingTo) {
                payload.replyTo = { ...replyingTo };
                replyingTo = null;
                document.getElementById('wa-reply-preview')?.remove();
            }
            if (isImage)       payload.imageUrl  = url;
            else if (isVideo)  { payload.fileUrl = url; payload.fileName = file.name; payload.fileMime = file.type; }
            else               { payload.fileUrl = url; payload.fileName = file.name; payload.fileMime = file.type; payload.fileSize = fileToSend.size; }

            await addDoc(collection(db, `chats/${roomId}/messages`), payload);
            // FIX: use pre-captured _fileRoomType/_fileRecip (not live activeRoomDetails — could have changed during upload)
            const _fileUpdate = {
                lastMessage: isImage ? '📷 Photo' : (isVideo ? '🎥 Video' : `📎 ${file.name}`),
                lastSenderEmail: currentUser.email, lastUpdated: serverTimestamp(),
                [`unreadCount.${currentUser.email}`]: 0
            };
            // FIX BUG-ATOMIC-MEDIA: use server-side increment() instead of (current + 1).
            // The old pattern read the doc, added 1 client-side, then wrote back — two
            // concurrent uploads from different devices would both read 0 and both write 1,
            // effectively capping the counter at 1 regardless of how many messages were sent.
            // increment() is atomic on the Firestore server and handles all concurrency correctly.
            if (_fileRoomType === 'private' && _fileRecip) {
                // Private: no getDoc needed — recipient is already known from pre-captured context.
                _fileUpdate[`unreadCount.${_fileRecip}`] = increment(1);
            } else if (_fileRoomType === 'group') {
                // Group: still need a getDoc to enumerate members, but counts use increment().
                const _rSnap = await getDoc(doc(db, 'chats', roomId)).catch(() => null);
                const _groupMembers = (_rSnap?.data()?.members) || [];
                for (const _gm of _groupMembers) {
                    if (_gm && _gm !== currentUser.email) {
                        _fileUpdate[`unreadCount.${_gm}`] = increment(1);
                    }
                }
            }
            await setDoc(doc(db, 'chats', roomId), _fileUpdate, { merge: true });
            showToast(isImage ? 'Photo sent!' : isVideo ? 'Video sent!' : 'File sent!', 'success');
        } catch (err) {
            console.error('[Chat] upload error:', err);
            showToast('Failed to upload file. Please try again.', 'error');
        } finally {
            document.getElementById('wa-attach-progress')?.remove();
            input.placeholder = savedPH;
            input.disabled    = false;
            sendBtn.disabled  = false;
            if (attachBtn) attachBtn.disabled = false;
            input.focus();
        }
    }

    // ── COMPOSE TRAY SYSTEM ─────────────────────────────────────────────────────
    // Files are queued here before sending. The tray shows previews, per-file
    // progress, and lets the user add/remove attachments before committing.
    // A caption can be typed in the normal input while the tray is open.
    // All uploads happen in parallel; sendComposedMessage waits for them all,
    // then writes one Firestore document with an `attachments[]` array.
    // ───────────────────────────────────────────────────────────────────────────

    function _classifyFile(file) {
        if (file.type?.startsWith('image/')) return 'image';
        if (file.type?.startsWith('video/')) return 'video';
        if (file.type?.startsWith('audio/')) return 'audio';
        return 'document';
    }

    // Render (or update) the compose tray DOM above the message form.
    function renderComposeTray() {
        const form = document.getElementById('chat-message-form');
        if (!form) return;
        let tray = document.getElementById('wa-compose-tray');

        if (!pendingAttachments.length) {
            tray?.remove();
            input.placeholder = input._savedPlaceholder || 'Type a message…';
            return;
        }

        if (!tray) {
            tray = document.createElement('div');
            tray.id = 'wa-compose-tray';
            form.parentElement?.insertBefore(tray, form);
        }

        const thumbsHTML = pendingAttachments.map(item => {
            let thumbContent = '';
            if (item.type === 'image' && item.previewUrl) {
                thumbContent = `<img class="wa-ct-thumb-img" src="${item.previewUrl}" alt="">`;
            } else if (item.type === 'video' && item.previewUrl) {
                thumbContent = `<img class="wa-ct-thumb-img" src="${item.previewUrl}" alt="">
                    <div class="wa-ct-thumb-video-icon">
                        <svg width="22" height="22" fill="#fff" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                    </div>`;
            } else {
                const icon = item.type === 'audio' ? '🎵'
                           : item.type === 'video' ? '🎥'
                           : getFileIcon(item.mime || '');
                thumbContent = `<div class="wa-ct-thumb-doc">
                    <span>${icon}</span>
                    <span>${sanitize(item.name || 'File')}</span>
                </div>`;
            }

            let overlay = '';
            if (item.compressing) {
                overlay = `<div class="wa-ct-progress-ring">⚙️</div>`;
            } else if (item.uploadedUrl) {
                // uploaded — no overlay
            } else if (item.error) {
                overlay = `<div class="wa-ct-error-badge" title="${sanitize(item.error)}">!</div>`;
            } else if (typeof item.progress === 'number') {
                overlay = `<div class="wa-ct-progress-ring">${item.progress}%</div>`;
            }

            return `<div class="wa-ct-thumb" data-att-id="${item.id}">
                ${thumbContent}
                ${overlay}
                <button class="wa-ct-remove" data-remove-id="${item.id}" aria-label="Remove">✕</button>
            </div>`;
        }).join('');

        tray.innerHTML = `
            <div class="wa-ct-header">
                <span>${pendingAttachments.length} attachment${pendingAttachments.length > 1 ? 's' : ''} selected</span>
                <button class="wa-ct-clear" id="wa-ct-clear-all">Clear all</button>
            </div>
            <div class="wa-ct-thumbs" id="wa-ct-thumbs-row">
                ${thumbsHTML}
                <button class="wa-ct-add-more" id="wa-ct-add-more-btn" title="Add more files">+</button>
            </div>
            <p class="wa-ct-caption-hint">Add a caption (optional) and press Send ↑</p>`;

        // Wire up remove buttons
        tray.querySelectorAll('.wa-ct-remove').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                removeFromCompose(btn.dataset.removeId);
            });
        });

        document.getElementById('wa-ct-clear-all')?.addEventListener('click', () => clearComposeTray());

        document.getElementById('wa-ct-add-more-btn')?.addEventListener('click', () => {
            // BUG FIX: was hardcoded to imageAttachInput — prevented adding non-image files
            // when using "Add more". Open fileAttachInput (accepts all types) instead.
            fileAttachInput.click();
        });

        // Update input placeholder to hint at caption
        input._savedPlaceholder = input._savedPlaceholder || 'Type a message…';
        input.placeholder = 'Add a caption… (optional)';
    }

    function removeFromCompose(id) {
        const idx = pendingAttachments.findIndex(a => a.id === id);
        if (idx === -1) return;
        const item = pendingAttachments[idx];
        if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
        pendingAttachments.splice(idx, 1);
        renderComposeTray();
    }

    function clearComposeTray() {
        // BUG FIX: was `pendingAttachments = []`, which breaks closures that captured
        // the original array reference (e.g. sendComposedMessage's _traySnapshot restore).
        // Mutate in-place with splice() so all references stay valid.
        pendingAttachments.forEach(item => {
            if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
        });
        pendingAttachments.splice(0, pendingAttachments.length);
        renderComposeTray();
    }

    // Upload a single pending attachment in the background, updating progress.
    async function uploadPendingAttachment(item) {
        if (!item || item.uploadedUrl) return; // already uploaded
        try {
            // Compress images before upload
            if (item.type === 'image') {
                item.compressing = true;
                renderComposeTray();
                item.file = await compressImageFile(item.file);
                item.compressing = false;
            }
            item.progress = 0;
            renderComposeTray();
            const url = await uploadBytesWithRetry(item.file, 'chats',
                (pct, attempt) => {
                    item.progress = pct;
                    if (attempt > 0) item.retrying = attempt;
                    renderComposeTray();
                },
                item.name
            );
            item.uploadedUrl = url;
            item.progress   = 100;
            item.error      = null;
        } catch (err) {
            item.error    = err?.message || 'Upload failed';
            item.progress = null;
        }
        renderComposeTray();
    }

    // Add files to the compose queue and start background uploads.
    async function addFilesToCompose(files) {
        if (!files?.length || !activeRoomId) return;
        for (const file of files) {
            if (file.size > MAX_UPLOAD_BYTES) { showToast(`"${file.name}" is too large (max 50 MB).`, 'error'); continue; }
            const type = _classifyFile(file);
            let previewUrl = null;
            if (type === 'image') {
                previewUrl = URL.createObjectURL(file);
            } else if (type === 'video') {
                // Generate thumbnail from first frame
                try { previewUrl = await getVideoThumbnail(file) || null; } catch { previewUrl = null; }
            }
            const item = {
                id: String(++_attachIdCounter), file, name: file.name,
                mime: file.type, size: file.size, type,
                previewUrl, uploadedUrl: null, progress: null, error: null, compressing: false
            };
            pendingAttachments.push(item);
            // Start upload immediately in background — don't await
            uploadPendingAttachment(item).catch(() => {});
        }
        renderComposeTray();
        input.focus();
    }

    // Import getVideoThumbnail from storage.js (used for compose previews)
    let _getVideoThumbnailFn = null;
    import('../utils/storage.js').then(m => { _getVideoThumbnailFn = m.getVideoThumbnail; }).catch(() => {});
    function getVideoThumbnail(file) {
        return _getVideoThumbnailFn ? _getVideoThumbnailFn(file) : Promise.resolve(null);
    }

    // ── Send composed message (text + attachments[]) ──────────────────────────
    // Waits for any still-uploading items to finish, then sends a single message
    // document containing all attachments and an optional caption.
    async function sendComposedMessage(caption) {
        if (!pendingAttachments.length || !activeRoomId || !requireAuth()) return;

        // Snapshot room context before any await (race-condition guard)
        const roomId      = activeRoomId;
        const _roomType   = activeRoomDetails?.type;
        const _recipEmail = activeRoomDetails?.targetEmail;

        // Disable UI while sending
        input.disabled   = true;
        sendBtn.disabled = true;
        if (attachBtn) attachBtn.disabled = true;

        // Wait for any in-flight uploads to finish (or fail)
        const MAX_WAIT_MS = 90_000;
        const started     = Date.now();
        while (pendingAttachments.some(a => !a.uploadedUrl && !a.error)) {
            if (Date.now() - started > MAX_WAIT_MS) { showToast('Upload timed out. Please retry.', 'error'); break; }
            await sleep(250);
        }

        // Collect successful uploads; warn on failures
        const failed   = pendingAttachments.filter(a => a.error);
        const uploaded = pendingAttachments.filter(a => a.uploadedUrl);
        if (failed.length) {
            showToast(`${failed.length} file(s) failed to upload — sending the rest.`, 'warning');
        }
        if (!uploaded.length) {
            showToast('All uploads failed. Please try again.', 'error');
            input.disabled = false; sendBtn.disabled = false;
            if (attachBtn) attachBtn.disabled = false;
            return;
        }

        // Build attachments array
        const attachments = uploaded.map(a => ({
            url:  a.uploadedUrl,
            type: a.type,
            mime: a.mime  || '',
            name: a.name  || '',
            size: a.size  || 0,
        }));

        // Clear compose tray immediately (optimistic)
        const _traySnapshot = [...pendingAttachments];
        clearComposeTray();

        // Clear caption input
        const captionText = caption?.trim() || '';
        input.value       = '';
        input.style.height = 'auto';

        // Clear typing state
        clearTypingState();
        writeTypingState(roomId, false);

        // Clear reply if set
        const replyTo = replyingTo ? { ...replyingTo } : null;
        replyingTo    = null;
        document.getElementById('wa-reply-preview')?.remove();

        // Optimistic bubble
        const tempId = `pending_${Date.now()}_${optimisticCounter++}`;
        const optMsg = {
            id: tempId, text: captionText, attachments,
            senderEmail: currentUser.email, senderName: currentUser.name,
            createdAt: { toDate: () => new Date() }, _pending: true, replyTo
        };
        if (roomId === activeRoomId) {
            lastMessagesSnapshot.unshift(optMsg);
            renderMessages();
        }

        try {
            // ── Compose the Firestore payload ──
            const msgPayload = {
                senderEmail: currentUser.email, senderName: currentUser.name,
                createdAt: serverTimestamp(), seenBy: [],
                attachments,
                text: captionText,  // caption (may be empty)
            };
            if (replyTo) msgPayload.replyTo = replyTo;

            // ── Compute unread update ──
            const _roomUpdate = {
                lastMessage: captionText || (attachments[0]?.type === 'image' ? '📷 Photo'
                           : attachments[0]?.type === 'video' ? '🎥 Video'
                           : attachments[0]?.type === 'audio' ? '🎤 Voice'
                           : `📎 ${attachments[0]?.name || 'File'}`),
                lastSenderEmail: currentUser.email,
                lastUpdated:     serverTimestamp(),
                [`unreadCount.${currentUser.email}`]: 0,
            };
            if (_roomType === 'private' && _recipEmail) {
                _roomUpdate[`unreadCount.${_recipEmail}`] = increment(1);
            } else if (_roomType === 'group') {
                const _rSnap = await getDoc(doc(db, 'chats', roomId)).catch(() => null);
                for (const _gm of (_rSnap?.data()?.members || [])) {
                    if (_gm && _gm !== currentUser.email) {
                        _roomUpdate[`unreadCount.${_gm}`] = increment(1);
                    }
                }
            }

            // ── Atomic batch: message + room metadata ──
            const _batch = writeBatch(db);
            const _msgRef = doc(collection(db, `chats/${roomId}/messages`));
            _batch.set(_msgRef, msgPayload);
            _batch.set(doc(db, 'chats', roomId), _roomUpdate, { merge: true });
            await _batch.commit();

            // Remove optimistic entry; real snapshot will add it back
            const _si = lastMessagesSnapshot.findIndex(m => m.id === tempId);
            if (_si !== -1) lastMessagesSnapshot.splice(_si, 1);
            if (roomId === activeRoomId) renderMessages();

            const attLabel = attachments.length === 1
                ? (attachments[0].type === 'image' ? 'Photo' : attachments[0].type === 'video' ? 'Video' : 'File')
                : `${attachments.length} files`;
            showToast(`${attLabel} sent!`, 'success');
        } catch (err) {
            console.error('[Chat] sendComposedMessage error:', err);
            // Mark optimistic entry as failed
            const _fi = lastMessagesSnapshot.findIndex(m => m.id === tempId);
            if (_fi !== -1) {
                lastMessagesSnapshot[_fi] = { ...lastMessagesSnapshot[_fi], _pending: false, _failed: true };
            }
            if (roomId === activeRoomId) renderMessages();
            showToast('Failed to send. Please try again.', 'error');
            // Re-populate tray so user can retry
            _traySnapshot.forEach(item => { if (!pendingAttachments.find(a => a.id === item.id)) pendingAttachments.push(item); });
            renderComposeTray();
        } finally {
            input.disabled   = false;
            sendBtn.disabled = false;
            if (attachBtn) attachBtn.disabled = false;
            input.focus();
        }
    }

    // Teardown helper: clears compose tray when switching rooms or logging out
    function teardownComposeTray() {
        clearComposeTray();
    }

    // Wire input handlers to use addFilesToCompose (compose-then-send flow)
    imageAttachInput.addEventListener('change', async e => {
        const files = Array.from(e.target.files || []);
        if (files.length) { await addFilesToCompose(files); imageAttachInput.value = ''; }
    });
    fileAttachInput.addEventListener('change', async e => {
        const files = Array.from(e.target.files || []);
        if (files.length) { await addFilesToCompose(files); fileAttachInput.value = ''; }
    });
    videoAttachInput.addEventListener('change', async e => {
        const files = Array.from(e.target.files || []);
        if (files.length) { await addFilesToCompose(files); videoAttachInput.value = ''; }
    });

    // Drag & drop — add to compose tray
    chatContainer?.addEventListener('dragover', e => {
        if (!activeRoomId) return;
        e.preventDefault();
        chatContainer.classList.add('wa-drag-over');
    });
    chatContainer?.addEventListener('dragleave', () => chatContainer.classList.remove('wa-drag-over'));
    chatContainer?.addEventListener('drop', async e => {
        e.preventDefault();
        chatContainer.classList.remove('wa-drag-over');
        if (!activeRoomId) return;
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length) await addFilesToCompose(files);
    });

    // Paste image(s) from clipboard — add to compose tray
    input.addEventListener('paste', async e => {
        if (!activeRoomId) return;
        const imageFiles = [];
        for (const item of (e.clipboardData?.items || [])) {
            if (item.type?.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) imageFiles.push(file);
            }
        }
        if (imageFiles.length) {
            e.preventDefault();
            await addFilesToCompose(imageFiles);
        }
    });

    // ── Voice recording ──────────────────────────
    async function startVoiceRecording() {
        // FIX AUTH-GUARD: bail early if no authenticated user
        if (!requireAuth()) return;
        if (isRecording) { stopAndSendRecording(); return; }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // FIX: pick a mime type the browser actually supports.
            // audio/ogg;codecs=opus works on Chrome/Firefox but NOT Safari/iOS.
            // webm/opus is supported on Chrome/Edge; mp4/aac works on Safari.
            const preferredTypes = [
                'audio/webm;codecs=opus',
                'audio/webm',
                'audio/ogg;codecs=opus',
                'audio/mp4',
            ];
            const mimeType = preferredTypes.find(t => MediaRecorder.isTypeSupported(t)) || '';
            mediaRecorder      = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
            audioChunks        = [];
            isRecording        = true;
            recordingCancelled = false;
            recordingStartTime = Date.now();

            mediaRecorder.ondataavailable = e => {
                if (e.data && e.data.size > 0 && !recordingCancelled) audioChunks.push(e.data);
            };
            mediaRecorder.start(100);

            const micBtn = document.getElementById('wa-mic-btn');
            micBtn?.classList.add('recording');

            document.getElementById('wa-recording-bar')?.remove();
            const bar = document.createElement('div');
            bar.id = 'wa-recording-bar';
            bar.innerHTML = `
                <div class="wa-rec-dot"></div>
                <span class="wa-rec-timer" id="wa-rec-timer">0:00</span>
                <span style="color:var(--wa-sub);font-size:13px;margin-left:4px">Recording…</span>
                <button type="button" class="wa-rec-pause" id="wa-rec-pause-btn" aria-label="Pause recording">⏸</button>
                <button class="wa-rec-cancel" id="wa-rec-cancel-btn">✕ Cancel</button>
                <button class="wa-rec-send" id="wa-rec-send-btn" aria-label="Send voice note">
                    <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                </button>`;
            const inputArea = input.closest('form') || input.parentElement;
            inputArea?.parentElement?.insertBefore(bar, inputArea);

            let elapsed = 0;
            let _pausedMs = 0;      // FIX: accumulate paused time so duration is accurate
            let _pauseStart = null; // FIX: timestamp when pause began
            // FIX: guard against stale interval if re-entered (belt-and-suspenders)
            if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
            recordingTimer = setInterval(() => {
                // FIX: skip tick while MediaRecorder is paused so display matches audio length
                if (mediaRecorder && mediaRecorder.state === 'paused') return;
                elapsed++;
                const el = document.getElementById('wa-rec-timer');
                if (el) el.textContent = formatDuration(elapsed);
                if (elapsed >= 120) stopAndSendRecording(); // 2-min cap
            }, 1000);

            document.getElementById('wa-rec-cancel-btn')?.addEventListener('click', () => {
                stopRecording(true);
                stream.getTracks().forEach(t => t.stop());
            });

            document.getElementById('wa-rec-send-btn')?.addEventListener('click', () => {
                stopAndSendRecording();
            });

            // EXT: pause / resume recording
            document.getElementById('wa-rec-pause-btn')?.addEventListener('click', () => {
                const pauseBtn = document.getElementById('wa-rec-pause-btn');
                const dot      = document.querySelector('.wa-rec-dot');
                if (!mediaRecorder) return;
                if (mediaRecorder.state === 'recording') {
                    mediaRecorder.pause();
                    _pauseStart = Date.now(); // FIX: record when pause began
                    if (pauseBtn) pauseBtn.textContent = '▶';
                    if (dot)     dot.classList.add('paused');
                } else if (mediaRecorder.state === 'paused') {
                    mediaRecorder.resume();
                    if (_pauseStart) { _pausedMs += Date.now() - _pauseStart; _pauseStart = null; } // FIX: accumulate
                    if (pauseBtn) pauseBtn.textContent = '⏸';
                    if (dot)     dot.classList.remove('paused');
                }
            });

            // FIX: snapshot room context HERE (before recording starts) so onstop
            // can't be affected by a room switch that happens while recording.
            const _voiceRoomId      = activeRoomId;
            const _voiceRoomType    = activeRoomDetails?.type;
            const _voiceRecip       = activeRoomDetails?.targetEmail;
            // FIX: capture mimeType now — by the time onstop fires we null mediaRecorder
            const _capturedMime     = mediaRecorder.mimeType || mimeType || 'audio/webm';

            mediaRecorder.onstop = async () => {
                // FIX: collect all remaining data BEFORE stopping tracks — some browsers
                // flush a final chunk only after requestData(), stopping tracks early can drop it.
                // Tracks are stopped here (not at the top) so the final chunk isn't cut off.
                if (recordingCancelled || !audioChunks.length) {
                    audioChunks = [];
                    stream.getTracks().forEach(t => t.stop());
                    return;
                }
                // FIX (voice): discard suspiciously tiny blobs (silence or mic error)
                const _totalSize = audioChunks.reduce((n, c) => n + c.size, 0);
                if (_totalSize < 100) {
                    audioChunks = [];
                    stream.getTracks().forEach(t => t.stop());
                    showToast('Voice note was too short.', 'warning');
                    return;
                }
                // FIX: use _capturedMime — mediaRecorder is nulled below before we'd read .mimeType
                const blob     = new Blob(audioChunks, { type: _capturedMime });
                // FIX: subtract accumulated paused time so voiceDuration matches actual audio
                if (_pauseStart) { _pausedMs += Date.now() - _pauseStart; _pauseStart = null; }
                const duration = Math.max(1, Math.round((Date.now() - recordingStartTime - _pausedMs) / 1000));
                audioChunks    = [];
                mediaRecorder  = null; // safe to null now — blob assembled, mimeType already captured
                stream.getTracks().forEach(t => t.stop()); // FIX: stop tracks after blob is assembled
                if (!_voiceRoomId) return;

                // Optimistic: show a pending voice bubble immediately while uploading
                const _voiceTempId = `pending_voice_${Date.now()}_${optimisticCounter++}`;
                const _optimisticVoice = {
                    id: _voiceTempId,
                    voiceUrl: '', voiceDuration: duration,
                    senderEmail: currentUser.email, senderName: currentUser.name,
                    createdAt: { toDate: () => new Date() }, _pending: true, text: ''
                };
                if (_voiceRoomId === activeRoomId) {
                    // FIX #1: unshift in-place
                    lastMessagesSnapshot.unshift(_optimisticVoice);
                    renderMessages();
                }

                try {
                    const url = await uploadAudioBlob(blob, _capturedMime);
                    await addDoc(collection(db, `chats/${_voiceRoomId}/messages`), {
                        voiceUrl: url, voiceDuration: duration,
                        senderEmail: currentUser.email, senderName: currentUser.name,
                        createdAt: serverTimestamp(), seenBy: [], text: ''
                    });
                    // FIX #1: remove in-place
                    const _vsi = lastMessagesSnapshot.findIndex(m => m.id === _voiceTempId);
                    if (_vsi !== -1) lastMessagesSnapshot.splice(_vsi, 1);
                    if (_voiceRoomId === activeRoomId) renderMessages();
                    // FIX: bump recipient unread + reset own — uses pre-captured room context
                    const _voiceUpdate = {
                        lastMessage: '🎤 Voice note', lastSenderEmail: currentUser.email,
                        lastUpdated: serverTimestamp(),
                        [`unreadCount.${currentUser.email}`]: 0
                    };
                    // FIX BUG-ATOMIC-VOICE: same race-condition fix as sendMediaFile — use
                    // server-side increment() so concurrent voice sends from multiple devices
                    // can't clobber each other's unread counter.
                    if (_voiceRoomType === 'private' && _voiceRecip) {
                        // Private: recipient known from pre-captured context — no getDoc needed.
                        _voiceUpdate[`unreadCount.${_voiceRecip}`] = increment(1);
                    } else if (_voiceRoomType === 'group') {
                        // Group: need member list, but counts use increment().
                        const _vSnap = await getDoc(doc(db, 'chats', _voiceRoomId)).catch(() => null);
                        const _vGroupMembers = (_vSnap?.data()?.members) || [];
                        for (const _gm of _vGroupMembers) {
                            if (_gm && _gm !== currentUser.email) {
                                _voiceUpdate[`unreadCount.${_gm}`] = increment(1);
                            }
                        }
                    }
                    await setDoc(doc(db, 'chats', _voiceRoomId), _voiceUpdate, { merge: true });
                } catch (err) {
                    console.error(err);
                    // Mark optimistic bubble as failed so user sees a retry affordance
                    // FIX #1: mutate in-place
                    const _vfi = lastMessagesSnapshot.findIndex(m => m.id === _voiceTempId);
                    if (_vfi !== -1) lastMessagesSnapshot[_vfi] = { ...lastMessagesSnapshot[_vfi], _pending: false, _failed: true };
                    if (_voiceRoomId === activeRoomId) renderMessages();
                    showToast('Failed to send voice note.', 'error');
                }
            };
        } catch (err) {
            console.error(err);
            showToast('Microphone access denied.', 'error');
        }
    }

    document.getElementById('wa-mic-btn')?.addEventListener('click', () => {
        if (!activeRoomId || !requireAuth()) return;
        if (isRecording) stopAndSendRecording();
        else startVoiceRecording();
    });

    // ── Reactions ────────────────────────────────
    async function toggleReaction(msgId, emoji) {
        if (!activeRoomId || !requireAuth()) return;
        const ref = doc(db, `chats/${activeRoomId}/messages`, msgId);
        try {
            const snap = await getDoc(ref);
            if (!snap.exists()) return;
            const reactions = snap.data().reactions || {};
            const already   = reactions[emoji]?.includes(currentUser.email);
            await updateDoc(ref, {
                [`reactions.${emoji}`]: already
                    ? arrayRemove(currentUser.email)
                    : arrayUnion(currentUser.email)
            });
        } catch (err) { console.error('[Chat] react error:', err); showToast('Failed to react.', 'error'); }
    }

    // ── Members panel (multi-admin, add member, pending requests, invite link) ──
    async function openMembersPanel() {
        if (!activeRoomId || activeRoomDetails?.type !== 'group') return;
        document.getElementById('chat-members-modal')?.remove();

        const modal = document.createElement('div');
        modal.id = 'chat-members-modal';
        modal.innerHTML = `
            <div id="chat-members-card" style="max-width:440px">
                <div class="members-header">
                    <span class="members-title">👥 Group Info</span>
                    <button id="close-members-modal" aria-label="Close" style="background:none;border:none;cursor:pointer;color:var(--wa-sub);font-size:18px;padding:4px">✕</button>
                </div>
                <div style="display:flex;border-bottom:1px solid var(--wa-border)">
                    <button class="mem-tab-btn mem-tab--active" data-tab="members" style="flex:1;padding:10px;background:none;border:none;border-bottom:2px solid var(--wa-accent);color:var(--wa-accent);font-weight:600;font-size:13px;cursor:pointer">Members</button>
                    <button class="mem-tab-btn" data-tab="pending" style="flex:1;padding:10px;background:none;border:none;border-bottom:2px solid transparent;color:var(--wa-sub);font-size:13px;cursor:pointer">Requests <span id="pending-count-badge"></span></button>
                    <button class="mem-tab-btn" data-tab="invite" style="flex:1;padding:10px;background:none;border:none;border-bottom:2px solid transparent;color:var(--wa-sub);font-size:13px;cursor:pointer">Invite</button>
                </div>
                <div id="mem-tab-members" style="overflow-y:auto;flex:1;padding:4px">
                    <div style="text-align:center;color:var(--wa-sub);font-size:14px;padding:24px">Loading…</div>
                </div>
                <div id="mem-tab-pending" style="overflow-y:auto;flex:1;padding:4px;display:none">
                    <div style="text-align:center;color:var(--wa-sub);font-size:14px;padding:24px">Loading…</div>
                </div>
                <div id="mem-tab-invite" style="overflow-y:auto;flex:1;padding:16px;display:none;flex-direction:column;gap:14px"></div>
            </div>`;
        document.body.appendChild(modal);
        // FIX: define close2 first so it is the only listener ever attached —
        // the old pattern attached 'close' then tried to remove it via a fresh
        // arrow function (which never matched), leaving the original leaking.
        let _membersPanelSub = null;
        const close2 = () => { _membersPanelSub?.(); modal.remove(); };
        modal.addEventListener('click', e => { if (e.target === modal) close2(); });
        document.getElementById('close-members-modal').addEventListener('click', close2);

        // Tab switching
        modal.querySelectorAll('.mem-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                modal.querySelectorAll('.mem-tab-btn').forEach(b => {
                    b.style.borderBottomColor = 'transparent';
                    b.style.color = 'var(--wa-sub)';
                    b.style.fontWeight = '';
                });
                btn.style.borderBottomColor = 'var(--wa-accent)';
                btn.style.color = 'var(--wa-accent)';
                btn.style.fontWeight = '600';
                ['members','pending','invite'].forEach(t => {
                    const el = document.getElementById(`mem-tab-${t}`);
                    if (el) el.style.display = btn.dataset.tab === t ? (t === 'invite' ? 'flex' : 'block') : 'none';
                });
            });
        });

        // FIX #9: use onSnapshot so the panel reflects concurrent admin changes
        try {
            _membersPanelSub = onSnapshot(doc(db, 'chats', activeRoomId), (snap) => {
            if (!snap.exists()) { close2(); return; }
            const data        = snap.data();
            const members     = data.members || [];
            const memberNames = data.memberNames || [];
            const admins      = data.admins || [data.admin].filter(Boolean);
            const isMeAdmin   = admins.includes(currentUser.email);
            const pending     = data.pendingRequests || [];
            const inviteCode  = data.inviteCode || '';

            // Badge
            const badge = document.getElementById('pending-count-badge');
            if (badge && pending.length && isMeAdmin) badge.textContent = ` (${pending.length})`;

            // ── MEMBERS TAB ──
            let membersHTML = '';
            if (isMeAdmin) {
                membersHTML += `<div style="padding:10px 12px">
                    <button id="mem-add-user-btn" style="width:100%;padding:9px 14px;border-radius:10px;background:var(--wa-accent-dim);border:1.5px dashed var(--wa-accent);color:var(--wa-accent);font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px;justify-content:center">
                        <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                        Add Member
                    </button>
                </div>`;
            }
            membersHTML += members.map((email, i) => {
                const name         = memberNames[i] || email.split('@')[0];
                const isThisAdmin  = admins.includes(email);
                const isMe         = email === currentUser.email;
                const canManage    = isMeAdmin && !isMe;
                const adminToggle  = canManage
                    ? `<button class="mem-admin-toggle" data-email="${email}" data-is-admin="${isThisAdmin}" style="font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--wa-accent);background:${isThisAdmin ? 'var(--wa-accent)' : 'transparent'};color:${isThisAdmin ? '#fff' : 'var(--wa-accent)'};cursor:pointer;margin-right:6px">${isThisAdmin ? '★ Admin' : 'Make Admin'}</button>`
                    : '';
                // FIX: was a shadowing arrow-function that always resolved to truthy; use the outer canManage boolean directly.
                return `
                <div class="member-item" data-email="${email}">
                    <div class="member-info">
                        ${avatarEl(name, 'group', false, 36)}
                        <div>
                            <p class="member-name">${sanitize(name)}${isMe ? ' <span style="font-size:11px;color:var(--wa-sub)">(you)</span>' : ''}</p>
                            ${isThisAdmin ? '<p class="member-admin-badge">★ Admin</p>' : ''}
                        </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:4px">
                        ${adminToggle}
                        ${canManage ? `<button class="member-remove-btn" data-email="${email}" data-name="${sanitize(name)}" style="font-size:12px;color:var(--wa-danger);font-weight:600;padding:4px 10px;border:1px solid transparent;border-radius:8px;background:none;cursor:pointer">Remove</button>` : ''}
                    </div>
                </div>`;
            }).join('');
            document.getElementById('mem-tab-members').innerHTML = membersHTML;

            // Add member flow
            document.getElementById('mem-add-user-btn')?.addEventListener('click', async () => {
                // Load all users not already in group
                try {
                    const usersSnap = await getDocs(collection(db, 'users'));
                    const eligible  = [];
                    usersSnap.forEach(d => {
                        const u = d.data();
                        if (u.email && !members.includes(u.email)) eligible.push(u);
                    });
                    if (!eligible.length) { showToast('No users to add.', 'info'); return; }
                    const addModal = document.createElement('div');
                    addModal.id = 'mem-add-modal';
                    addModal.style.cssText = 'position:fixed;inset:0;z-index:210;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);backdrop-filter:blur(4px);padding:16px';
                    addModal.innerHTML = `
                        <div style="background:var(--wa-panel);border:1px solid var(--wa-border);border-radius:20px;width:100%;max-width:380px;max-height:80vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:var(--wa-shadow-lg)">
                            <div style="padding:14px 16px;border-bottom:1px solid var(--wa-border);display:flex;justify-content:space-between;align-items:center">
                                <span style="font-weight:700;color:var(--wa-text);font-size:15px">Add Member</span>
                                <button id="close-add-modal" style="background:none;border:none;cursor:pointer;color:var(--wa-sub);font-size:18px;padding:4px">✕</button>
                            </div>
                            <div style="overflow-y:auto;flex:1;padding:6px">
                                ${eligible.map(u => `
                                <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;cursor:pointer;transition:background .1s" class="add-user-row" data-email="${u.email}" data-name="${sanitize(u.name || '')}">
                                    ${avatarEl(u.name, 'private', false, 36)}
                                    <div>
                                        <p style="font-size:14px;font-weight:500;color:var(--wa-text)">${sanitize(u.name || u.email)}</p>
                                        <p style="font-size:12px;color:var(--wa-sub)">${sanitize(u.email)}</p>
                                    </div>
                                </div>`).join('')}
                            </div>
                        </div>`;
                    document.body.appendChild(addModal);
                    const closeAdd = () => addModal.remove();
                    addModal.addEventListener('click', e => { if (e.target === addModal) closeAdd(); });
                    document.getElementById('close-add-modal').addEventListener('click', closeAdd);
                    addModal.querySelectorAll('.add-user-row').forEach(row => {
                        row.addEventListener('mouseenter', () => row.style.background = 'var(--wa-input-bg)');
                        row.addEventListener('mouseleave', () => row.style.background = '');
                        row.addEventListener('click', async () => {
                            const newEmail = row.dataset.email;
                            const newName  = row.dataset.name;
                            try {
                                await updateDoc(doc(db, 'chats', activeRoomId), {
                                    members: arrayUnion(newEmail),
                                    memberNames: arrayUnion(newName)
                                });
                                await addDoc(collection(db, `chats/${activeRoomId}/messages`), {
                                    text: `${currentUser.name} added ${newName} to the group.`,
                                    senderEmail: 'system', senderName: 'System', createdAt: serverTimestamp()
                                });
                                showToast(`${newName} added to group!`, 'success');
                                closeAdd();
                                close2();
                            } catch (err) { console.error('[Chat] add-member error:', err); showToast('Failed to add member.', 'error'); }
                        });
                    });
                } catch (err) { console.error('[Chat] load-users error:', err); showToast('Failed to load users.', 'error'); }
            });

            // Admin toggle buttons
            document.querySelectorAll('.mem-admin-toggle').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const targetEmail  = btn.dataset.email;
                    const wasAdmin     = btn.dataset.isAdmin === 'true';
                    const ok = await showConfirm({
                        title: wasAdmin ? 'Remove admin?' : 'Make admin?',
                        body: wasAdmin
                            ? `${targetEmail} will lose admin privileges.`
                            : `${targetEmail} will become a group admin.`,
                        confirmLabel: wasAdmin ? 'Remove Admin' : 'Make Admin'
                    });
                    if (!ok) return;
                    try {
                        await updateDoc(doc(db, 'chats', activeRoomId), {
                            admins: wasAdmin ? arrayRemove(targetEmail) : arrayUnion(targetEmail)
                        });
                        showToast(wasAdmin ? 'Admin removed.' : 'Admin added!', 'success');
                        close2();
                        setTimeout(() => openMembersPanel(), 150);
                    } catch (err) { console.error('[Chat] update-admin error:', err); showToast('Failed to update admin.', 'error'); }
                });
            });

            // Remove buttons
            document.querySelectorAll('.member-remove-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const targetEmail = btn.dataset.email;
                    const targetName  = btn.dataset.name;
                    const ok = await showConfirm({
                        title: 'Remove member?',
                        body: `Remove ${targetName} from this group?`,
                        confirmLabel: 'Remove', tone: 'danger'
                    });
                    if (!ok) return;
                    try {
                        const idx = members.indexOf(targetEmail);
                        await updateDoc(doc(db, 'chats', activeRoomId), {
                            members: arrayRemove(targetEmail),
                            memberNames: arrayRemove(memberNames[idx] || ''),
                            admins: arrayRemove(targetEmail)
                        });
                        await addDoc(collection(db, `chats/${activeRoomId}/messages`), {
                            text: `${currentUser.name} removed ${targetName} from the group.`,
                            senderEmail: 'system', senderName: 'System', createdAt: serverTimestamp()
                        });
                        showToast('Member removed.', 'success');
                        close2();
                    } catch (err) { console.error('[Chat] remove-member error:', err); showToast('Failed to remove member.', 'error'); }
                });
            });

            // ── PENDING REQUESTS TAB ──
            const pendingContainer = document.getElementById('mem-tab-pending');
            if (!pending.length) {
                pendingContainer.innerHTML = `<div style="text-align:center;color:var(--wa-sub);font-size:14px;padding:32px 20px">
                    <div style="font-size:32px;margin-bottom:8px">📭</div>
                    No pending join requests
                </div>`;
            } else if (!isMeAdmin) {
                pendingContainer.innerHTML = `<div style="text-align:center;color:var(--wa-sub);font-size:14px;padding:32px 20px">Only admins can manage requests.</div>`;
            } else {
                pendingContainer.innerHTML = pending.map(req => `
                    <div class="member-item" style="align-items:flex-start;flex-direction:column;gap:10px;padding:14px 16px">
                        <div style="display:flex;align-items:center;gap:10px;width:100%">
                            ${avatarEl(req.name || req.email, 'private', false, 38)}
                            <div style="flex:1;min-width:0">
                                <p style="font-size:14px;font-weight:600;color:var(--wa-text)">${sanitize(req.name || req.email)}</p>
                                <p style="font-size:12px;color:var(--wa-sub)">${sanitize(req.email)}</p>
                                <p style="font-size:11px;color:var(--wa-sub);margin-top:2px">Requested ${req.requestedAt ? new Date(req.requestedAt).toLocaleDateString() : 'recently'}</p>
                            </div>
                        </div>
                        <div style="display:flex;gap:8px;width:100%">
                            <button class="req-approve-btn" data-email="${req.email}" data-name="${sanitize(req.name || '')}"
                                style="flex:1;padding:8px;border-radius:10px;background:var(--wa-green);border:none;color:#fff;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s">
                                ✓ Allow
                            </button>
                            <button class="req-dismiss-btn" data-email="${req.email}"
                                style="flex:1;padding:8px;border-radius:10px;background:var(--wa-input-bg);border:1px solid var(--wa-border);color:var(--wa-text);font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s">
                                Dismiss 24h
                            </button>
                            <button class="req-deny-btn" data-email="${req.email}"
                                style="padding:8px 14px;border-radius:10px;background:rgba(239,68,68,.1);border:1px solid var(--wa-danger);color:var(--wa-danger);font-size:13px;font-weight:600;cursor:pointer">
                                ✕
                            </button>
                        </div>
                    </div>`).join('');

                // Approve: add to members permanently
                document.querySelectorAll('.req-approve-btn').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const email = btn.dataset.email;
                        try {
                            // FIX: read reqObj fresh inside a transaction so we use the
                            // exact object Firestore has (including requestedAt), not a
                            // stale snapshot from when the panel was rendered.
                            // Also fixes: btn.dataset.name was HTML-sanitised so it could
                            // differ from the raw stored name, causing arrayRemove to fail
                            // (object equality requires every field to match exactly).
                            const roomRef = doc(db, 'chats', activeRoomId);
                            let rawName   = email; // fallback
                            await runTransaction(db, async tx => {
                                const snap = await tx.get(roomRef);
                                if (!snap.exists()) throw new Error('room_gone');
                                const d      = snap.data();
                                const reqObj = (d.pendingRequests || []).find(r => r.email === email);
                                if (!reqObj) return; // already approved/denied by another admin — no-op
                                rawName = reqObj.name || email;
                                const payload = {
                                    members:     arrayUnion(email),
                                    memberNames: arrayUnion(rawName),
                                    pendingRequests: arrayRemove(reqObj),
                                };
                                tx.update(roomRef, payload);
                            });
                            await addDoc(collection(db, `chats/${activeRoomId}/messages`), {
                                text: `${rawName} joined the group.`,
                                senderEmail: 'system', senderName: 'System', createdAt: serverTimestamp()
                            });
                            showToast(`${rawName} approved!`, 'success');
                            close2();
                        } catch (err) { console.error('[Chat] approve-request error:', err); showToast('Failed to approve.', 'error'); }
                    });
                });

                // Dismiss for 24h: move from pendingRequests to dismissedRequests
                document.querySelectorAll('.req-dismiss-btn').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const email        = btn.dataset.email;
                        const dismissUntil = Date.now() + 24 * 60 * 60 * 1000;
                        try {
                            // FIX: was two separate updateDoc calls (remove then add) which
                            // opened a window for a concurrent write to corrupt the array.
                            // Use a transaction to read fresh objects and write atomically.
                            const roomRef = doc(db, 'chats', activeRoomId);
                            await runTransaction(db, async tx => {
                                const snap = await tx.get(roomRef);
                                if (!snap.exists()) throw new Error('room_gone');
                                const d            = snap.data();
                                const pendingObj   = (d.pendingRequests   || []).find(r => r.email === email);
                                const dismissedObj = (d.dismissedRequests || []).find(r => r.email === email);
                                const dismissEntry = { email, dismissedUntil };
                                const payload = { dismissedRequests: arrayUnion(dismissEntry) };
                                // Remove stale entries atomically in the same write
                                if (pendingObj)   payload.pendingRequests   = arrayRemove(pendingObj);
                                if (dismissedObj) payload.dismissedRequests = arrayRemove(dismissedObj);
                                tx.update(roomRef, payload);
                            });
                            showToast('Request dismissed for 24 hours.', 'info');
                            close2();
                        } catch (err) { console.error('[Chat] dismiss-request error:', err); showToast('Failed to dismiss.', 'error'); }
                    });
                });

                // Deny permanently
                document.querySelectorAll('.req-deny-btn').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const email = btn.dataset.email;
                        try {
                            // FIX: read the request object fresh inside a transaction
                            // so arrayRemove receives the exact stored object.
                            const roomRef = doc(db, 'chats', activeRoomId);
                            await runTransaction(db, async tx => {
                                const snap    = await tx.get(roomRef);
                                if (!snap.exists()) return; // room gone — no-op
                                const denyObj = (snap.data().pendingRequests || []).find(r => r.email === email);
                                if (denyObj) tx.update(roomRef, { pendingRequests: arrayRemove(denyObj) });
                            });
                            showToast('Request denied.', 'info');
                            close2();
                        } catch (err) { console.error('[Chat] deny-request error:', err); showToast('Failed to deny.', 'error'); }
                    });
                });
            }

            // ── INVITE TAB ──
            const inviteContainer = document.getElementById('mem-tab-invite');
            inviteContainer.style.flexDirection = 'column';
            inviteContainer.style.gap = '14px';
            // FIX (Security): sanitize inviteCode before inserting into innerHTML;
            // inviteLink uses encodeURIComponent so the code can't break out of the query string
            const safeInviteCode = sanitize(inviteCode);
            const inviteLink = `${window.location.origin}${window.location.pathname}?joinGroup=${encodeURIComponent(inviteCode)}`;
            const safeInviteLink = sanitize(inviteLink);
            inviteContainer.innerHTML = `
                <div style="background:var(--wa-input-bg);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:10px">
                    <p style="font-size:12px;font-weight:700;color:var(--wa-sub);text-transform:uppercase;letter-spacing:.06em">Group Invite Code</p>
                    <div style="display:flex;align-items:center;gap:10px;background:var(--wa-panel);border:1.5px solid var(--wa-border);border-radius:10px;padding:10px 14px">
                        <span id="invite-code-display" style="font-size:22px;font-weight:800;color:var(--wa-accent);letter-spacing:.2em;flex:1">${safeInviteCode}</span>
                        <button id="copy-invite-code" style="background:var(--wa-accent);border:none;color:#fff;font-size:12px;font-weight:700;padding:6px 12px;border-radius:8px;cursor:pointer">Copy</button>
                    </div>
                    <p style="font-size:12px;color:var(--wa-sub)">Share this code so others can request to join. Admins approve each request.</p>
                </div>
                <div style="background:var(--wa-input-bg);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:10px">
                    <p style="font-size:12px;font-weight:700;color:var(--wa-sub);text-transform:uppercase;letter-spacing:.06em">Invite Link</p>
                    <div style="display:flex;align-items:center;gap:10px;background:var(--wa-panel);border:1.5px solid var(--wa-border);border-radius:10px;padding:10px 14px;overflow:hidden">
                        <span style="font-size:12px;color:var(--wa-sub);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${safeInviteLink}</span>
                        <button id="copy-invite-link" style="background:var(--wa-accent);border:none;color:#fff;font-size:12px;font-weight:700;padding:6px 12px;border-radius:8px;cursor:pointer;flex-shrink:0">Copy</button>
                    </div>
                </div>
                ${isMeAdmin ? `<button id="regen-invite-code" style="padding:10px;border-radius:10px;background:var(--wa-input-bg);border:1px solid var(--wa-border);color:var(--wa-sub);font-size:13px;cursor:pointer;transition:background .15s">🔄 Generate New Invite Code</button>` : ''}`;

            document.getElementById('copy-invite-code')?.addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(inviteCode); showToast('Code copied!', 'success'); }
                catch (err) { console.error('[Chat] copy error:', err); showToast('Copy failed.', 'error'); }
            });
            document.getElementById('copy-invite-link')?.addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(inviteLink); showToast('Link copied!', 'success'); }
                catch (err) { console.error('[Chat] copy-invite-link error:', err); showToast('Copy failed.', 'error'); }
            });
            document.getElementById('regen-invite-code')?.addEventListener('click', async () => {
                const ok = await showConfirm({
                    title: 'Regenerate invite code?',
                    body: 'The old code will stop working immediately.',
                    confirmLabel: 'Regenerate'
                });
                if (!ok) return;
                // Fix #3 (Critical): CSPRNG for invite code regeneration
                const _reAlpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
                const _reBytes = new Uint8Array(10);
                crypto.getRandomValues(_reBytes);
                const newCode = Array.from(_reBytes, b => _reAlpha[b % _reAlpha.length]).join('');
                try {
                    await updateDoc(doc(db, 'chats', activeRoomId), { inviteCode: newCode });
                    showToast('New invite code generated!', 'success');
                    close2();
                    setTimeout(() => openMembersPanel(), 150);
                } catch (err) { console.error('[Chat] regen-code error:', err); showToast('Failed to regenerate code.', 'error'); }
            });
            }, err => {
                console.error('[Chat] members panel:', err);
                const el = document.getElementById('mem-tab-members');
                if (el) el.innerHTML = '<p style="color:var(--wa-danger);font-size:14px;text-align:center;padding:24px">Failed to load members.</p>';
            });
        } catch (err) {
            console.error('[Chat] members panel setup:', err);
            document.getElementById('mem-tab-members').innerHTML =
                '<p style="color:var(--wa-danger);font-size:14px;text-align:center;padding:24px">Failed to load members.</p>';
        }
    }

}