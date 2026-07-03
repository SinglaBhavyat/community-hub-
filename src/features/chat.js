import { db } from '../config/firebase.js';
import { currentUser } from '../store/db.js';
import { sanitize } from '../ui/templates.js';
import { uploadToCloudinary } from '../utils/storage.js';
import {
    collection, doc, setDoc, addDoc, query, orderBy, onSnapshot,
    serverTimestamp, getDocs, limit, where, deleteDoc, updateDoc,
    arrayUnion, arrayRemove, getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// ─────────────────────────────────────────────
// MODULE-LEVEL STATE
// ─────────────────────────────────────────────
let chatSub              = null;
let rootChatSub          = null;
let recentChatsSub       = null;
let presenceSub          = null;
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
let forwardingMsgId      = null;
let _totalUnread         = 0;   // FIX: track real total so _recomputeNavBadge doesn't parse DOM badges
let _hbInterval          = null;   // heartbeat interval ref for cleanup
let _activeAudio         = null;   // FIX: was window._waAudio — keep audio state at module scope

const TYPING_TTL_MS    = 6000;
const EMOJI_LIST       = ['😀','😂','😍','🥰','😎','🤔','😮','😢','😡','👍','❤️','🙏','🎉','🔥','✅','💯','🤣','😭','😊','🥺','🤩','😴','🤯','💀','👋','🤝','💪','👀','🫡','🫶'];
const REACTION_EMOJIS  = ['👍','❤️','😂','😮','😢','🙏'];
// FIX: was undefined — REACTION_EMOJIS_SET is used in buildMessageHTML
const REACTION_EMOJIS_SET = REACTION_EMOJIS;

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
            attempt++;
            if (attempt > MAX_UPLOAD_RETRIES) throw err;
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
    } catch {
        return file; // never block sending on a compression failure
    }
}

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
        el.type  = 'file';
        el.accept = accept;
        el.id    = id;
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

function unsubscribeRoomListeners() {
    chatSub?.();     chatSub     = null;
    rootChatSub?.(); rootChatSub = null;
    presenceSub?.(); presenceSub = null;
    clearTypingState();
}

function unsubscribeRecent() {
    recentChatsSub?.(); recentChatsSub = null;
}

function clearTypingState() {
    if (typingTimeout) { clearTimeout(typingTimeout); typingTimeout = null; }
    isCurrentlyTyping  = false;
    currentTypingLabel = null;
}

function writeTypingState(roomId, typing) {
    if (!roomId) return;
    setDoc(doc(db, `chats/${roomId}/typing`, currentUser.email), {
        typing, name: currentUser.name, updatedAt: serverTimestamp()
    }).catch(() => {});
}

export function teardownChat() {
    unsubscribeRoomListeners();
    unsubscribeRecent();
    stopRecording(true);
    if (_hbInterval) { clearInterval(_hbInterval); _hbInterval = null; }
    // FIX: stop any playing voice note audio on teardown
    if (_activeAudio && !_activeAudio.paused) { _activeAudio.pause(); }
    _activeAudio      = null;
    activeRoomId      = null;
    activeRoomDetails = null;
    replyingTo        = null;
    editingMsgId      = null;
    // FIX: invalidate contacts cache on teardown so a fresh mount picks up new users
    cachedUsersHTML   = null;
    cachedUsersData   = null;
    // FIX: remove injected hidden file inputs on teardown to prevent accumulation
    document.querySelectorAll('[data-chat-input="true"]').forEach(el => el.remove());
    delete window.startDirectChat;
    const chatContainer = document.getElementById('chat-messages');
    if (chatContainer) delete chatContainer.dataset.chatWired;
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
    if (!ts?.toDate) return '';
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
    lastMessagesSnapshot = [];
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
        const mine = users.includes(currentUser.email);
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
    const text  = replyData.imageUrl  ? '📷 Photo'
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
    return `<div class="wa-voice-note" data-voice-url="${msg.voiceUrl}">
        <button class="wa-voice-play-btn" data-voice-url="${msg.voiceUrl}">
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
    return `<a href="${msg.fileUrl}" target="_blank" rel="noopener" class="wa-file-attachment">
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
    const older     = messages[index + 1];
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
    if (msg.voiceUrl) {
        contentHTML = buildVoiceNoteHTML(msg, isMe);
    } else if (msg.imageUrl) {
        // Fix #9 (High): validate imageUrl through safeUrl() before injecting into src/data-full
        const _safeImg = safeUrl(msg.imageUrl) || encodeURI(msg.imageUrl);
        contentHTML = `<img src="${_safeImg}" class="wa-msg-image msg-image" data-full="${_safeImg}" loading="lazy" alt="Image">`;
    } else if (msg.fileUrl) {
        contentHTML = buildFileHTML(msg);
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
        textHTML = `<span class="wa-msg-text">${linkedText}</span>`;
        const firstUrl = extractFirstUrl(msg.text);
        if (firstUrl && !msg.imageUrl && !msg.fileUrl) {
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
    const menuHTML = (msg.isDeletedForEveryone || isPending) ? '' : `
        <div class="wa-msg-menu">
            <button class="wa-msg-menu-btn msg-menu-btn" data-msg-id="${msg.id}" aria-label="Message options">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
            </button>
            <div class="wa-msg-dropdown hidden msg-menu-dropdown">
                <div class="wa-emoji-bar">
                    ${REACTION_EMOJIS_SET.map(e =>
                        `<button class="wa-emoji-pick msg-react-btn" data-msg-id="${msg.id}" data-emoji="${e}">${e}</button>`
                    ).join('')}
                </div>
                <button class="wa-drop-item msg-reply-btn"
                    data-msg-id="${msg.id}"
                    data-sender="${sanitize(msg.senderName || '')}"
                    data-text="${sanitize(msg.text || '')}"
                    data-image="${msg.imageUrl || ''}"
                    data-voice="${msg.voiceUrl || ''}"
                    data-file="${msg.fileUrl || ''}"
                    data-filename="${sanitize(msg.fileName || '')}">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/></svg>
                    Reply
                </button>
                ${isMe && msg.text && !msg.imageUrl && !msg.voiceUrl && !msg.fileUrl ? `
                <button class="wa-drop-item msg-edit-btn" data-msg-id="${msg.id}" data-text="${sanitize(msg.text || '')}">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    Edit
                </button>` : ''}
                <button class="wa-drop-item msg-forward-btn" data-msg-id="${msg.id}">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 9l3 3-3 3m-4 0a9 9 0 110-6"/></svg>
                    Forward
                </button>
                <button class="wa-drop-item msg-star-btn" data-msg-id="${msg.id}">
                    <svg width="14" height="14" fill="${isStarred ? '#f59e0b' : 'none'}" stroke="${isStarred ? '#f59e0b' : 'currentColor'}" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>
                    ${isStarred ? 'Unstar' : 'Star'} message
                </button>
                ${isPinned ? '' : `<button class="wa-drop-item msg-pin-btn" data-msg-id="${msg.id}">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>
                    Pin message
                </button>`}
                <button class="wa-drop-item msg-copy-btn" data-msg-id="${msg.id}" data-text="${sanitize(msg.text || '')}">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                    Copy text
                </button>
                <button class="wa-drop-item msg-delete-me-btn" data-msg-id="${msg.id}">Delete for me</button>
                ${isMe ? `<button class="wa-drop-item wa-drop-item--danger msg-delete-everyone-btn" data-msg-id="${msg.id}">Delete for everyone</button>` : ''}
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
        body.dark-mode .wa-msg-dropdown { background: #1a1d35; border-color: rgba(255,255,255,.1); }
        body.dark-mode .wa-drop-item { color: var(--wa-text); }
        body.dark-mode .wa-drop-item:hover { background: rgba(255,255,255,.06); }
        body.dark-mode .wa-drop-item--danger { border-color: rgba(255,255,255,.08); }
        body.dark-mode .wa-file-attachment { background: rgba(255,255,255,.07); color: var(--wa-text); }
        body.dark-mode .wa-link-preview { background: rgba(255,255,255,.05); }
        body.dark-mode #chat-message-input { color: var(--wa-text) !important; }
        body.dark-mode .wa-input-wrap:focus-within { background: #1f2447; }
        body.dark-mode #send-msg-btn:disabled { background: #2a2d4a !important; }
        body.dark-mode .wa-header-dropdown { background: #1a1d35; border-color: rgba(255,255,255,.1); }
        body.dark-mode .wa-msg-menu-btn { background: #1a1d35; border-color: rgba(255,255,255,.1); }
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
        body.dark-mode .wa-welcome-enc { color: var(--wa-sub); }
        body.dark-mode .ch-profile-area:hover { background: rgba(255,255,255,.06); }
        body.dark-mode .wa-nav-btn:hover { background: rgba(255,255,255,.08); }
        body.dark-mode #wa-attach-progress { background: var(--wa-panel); border-color: var(--wa-border); }

        /* ═══ Chat page layout ═══ */
        #page-chat { padding-top: 20px !important; padding-bottom: 20px !important; }
        #page-chat .max-w-6xl { height: calc(100vh - 120px); min-height: 500px; }
        #page-chat > div > div {
            background: var(--wa-panel);
            border-radius: 20px;
            border: 1px solid var(--wa-border);
            box-shadow: var(--wa-shadow-lg);
            overflow: hidden;
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
        .wa-sidebar-name   { font-size: 14px; font-weight: 600; color: var(--wa-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
        .wa-sidebar-name--unread { color: #000; font-weight: 700; }
        .wa-sidebar-time   { font-size: 11px; color: var(--wa-sub); white-space: nowrap; flex-shrink: 0; }
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
            padding: 20px 16px 12px !important;
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
            max-width: 72%; margin-bottom: 2px;
            animation: waFadeIn .18s ease-out;
        }
        .wa-msg-row--me   { align-self: flex-end; flex-direction: row-reverse; }
        .wa-msg-row--them { align-self: flex-start; }
        .wa-msg-avatar    { width: 30px; height: 30px; flex-shrink: 0; }
        .wa-msg-avatar-gap { width: 30px; flex-shrink: 0; }
        .wa-msg-wrap      { position: relative; display: flex; flex-direction: column; }
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
        .wa-wave-bar   { width: 3px; border-radius: 2px; background: rgba(255,255,255,.6); flex-shrink: 0; }
        .wa-bubble--them .wa-wave-bar { background: #9ca3af; }
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
        .wa-msg-menu { position: absolute; top: 4px; z-index: 10; opacity: 0; transition: opacity .15s; }
        .wa-msg-row--me   .wa-msg-menu { right: calc(100% + 4px); }
        .wa-msg-row--them .wa-msg-menu { left: calc(100% + 4px); }
        .wa-msg-wrap:hover .wa-msg-menu { opacity: 1; }
        .wa-msg-menu-btn {
            width: 28px; height: 28px; border-radius: 8px; background: var(--wa-panel);
            border: 1px solid var(--wa-border); color: var(--wa-sub);
            display: flex; align-items: center; justify-content: center;
            cursor: pointer; transition: all .15s; box-shadow: var(--wa-shadow);
        }
        .wa-msg-menu-btn:hover { background: var(--wa-input-bg); color: var(--wa-text); }
        .wa-msg-dropdown {
            position: absolute; top: 32px; min-width: 210px;
            background: var(--wa-panel); border: 1px solid var(--wa-border);
            border-radius: 14px; box-shadow: var(--wa-shadow-lg); overflow: hidden; z-index: 60;
        }
        .wa-msg-row--me   .wa-msg-dropdown { right: 0; }
        .wa-msg-row--them .wa-msg-dropdown { left: 0; }
        .wa-emoji-bar  { display: flex; justify-content: space-between; padding: 8px 10px; border-bottom: 1px solid var(--wa-border); gap: 2px; }
        .wa-emoji-pick { font-size: 20px; background: none; border: none; cursor: pointer; transition: transform .15s; border-radius: 6px; padding: 3px 4px; line-height: 1; }
        .wa-emoji-pick:hover { transform: scale(1.4); background: var(--wa-input-bg); }
        .wa-drop-item {
            display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
            padding: 10px 16px; font-size: 13.5px; color: var(--wa-text);
            background: none; border: none; cursor: pointer; transition: background .1s;
        }
        .wa-drop-item:hover { background: var(--wa-input-bg); }
        .wa-drop-item--danger { color: var(--wa-danger) !important; border-top: 1px solid var(--wa-border); }

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

        /* ═══ Image lightbox ═══ */
        #wa-lightbox {
            position: fixed; inset: 0; z-index: 300; background: rgba(0,0,0,.92);
            display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 16px;
        }
        #wa-lightbox img { max-width: 90vw; max-height: 80vh; border-radius: 14px; object-fit: contain; }
        .wa-lb-close { position: absolute; top: 20px; right: 20px; background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.2); color: #fff; width: 40px; height: 40px; border-radius: 50%; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; transition: background .15s; }
        .wa-lb-close:hover { background: rgba(255,255,255,.22); }
        /* FIX: was <button> inside <a>; now use a proper <a> styled as button */
        .wa-lb-download { color: #fff; background: var(--wa-accent); border: none; padding: 10px 24px; border-radius: 10px; cursor: pointer; font-size: 14px; font-weight: 700; transition: background .15s; text-decoration: none; display: inline-block; }
        .wa-lb-download:hover { background: #4338ca; }

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
    document.head.appendChild(s);
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
    document.getElementById('wa-recording-bar')?.remove();
    const btn = document.getElementById('wa-mic-btn');
    if (btn) btn.classList.remove('recording');
    // FIX: always call .stop() so onstop fires in both cancel AND send paths.
    // Do NOT null out mediaRecorder here — onstop still needs it to release
    // stream tracks. onstop nulls it after it finishes.
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    } else {
        // Already stopped (e.g. stream lost), clean up immediately
        mediaRecorder = null;
    }
}

function stopAndSendRecording() {
    if (!isRecording || !mediaRecorder) return;
    recordingCancelled = false;
    stopRecording(false);
}

// ─────────────────────────────────────────────
// LIGHTBOX
// FIX: replaced <button> inside <a> with plain <a> styled as button
// ─────────────────────────────────────────────
function openLightbox(url) {
    // FIX (Security): use DOM APIs for src/href so no URL ends up injected via innerHTML
    const safe = safeUrl(url);
    if (!safe) return;
    document.getElementById('wa-lightbox')?.remove();
    const box = document.createElement('div');
    box.id = 'wa-lightbox';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'wa-lb-close';
    closeBtn.id = 'wa-lb-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '✕';

    const img = document.createElement('img');
    img.src = safe;  // assigned via property, not innerHTML
    img.alt = 'Full size image';

    const dlLink = document.createElement('a');
    dlLink.href = safe;  // assigned via property, not innerHTML
    dlLink.download = '';
    dlLink.target = '_blank';
    dlLink.rel = 'noopener noreferrer';
    dlLink.className = 'wa-lb-download';
    dlLink.textContent = '⬇ Download';

    box.appendChild(closeBtn);
    box.appendChild(img);
    box.appendChild(dlLink);
    document.body.appendChild(box);

    closeBtn.addEventListener('click', () => box.remove());
    box.addEventListener('click', e => { if (e.target === box) box.remove(); });
}

// ─────────────────────────────────────────────
// FORWARD MODAL — light theme
// ─────────────────────────────────────────────
async function openForwardModal(msgId) {
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
                ? c.name
                : (c.memberNames?.find(n => n !== currentUser.name) || 'Unknown');
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
                    await setDoc(doc(db, 'chats', toRoom), {
                        lastMessage: msg.text || (msg.imageUrl ? '📷 Photo' : '📎 File'),
                        lastSenderEmail: currentUser.email, lastUpdated: serverTimestamp()
                    }, { merge: true });
                    showToast('Message forwarded!', 'success');
                } catch { showToast('Failed to forward.', 'error'); }
                close();
            });
        });
    } catch { showToast('Failed to load conversations.', 'error'); close(); }
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
// TYPING SUBSCRIPTION (with server-side TTL awareness)
// ─────────────────────────────────────────────
function subscribeTypingIndicator(roomId, chatType) {
    presenceSub?.();
    const typingCol = collection(db, `chats/${roomId}/typing`);
    presenceSub = onSnapshot(typingCol, snap => {
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
                chatContainer.insertAdjacentHTML('beforeend', buildTypingIndicatorHTML(typingName));
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
    setDoc(doc(db, 'chats', roomId), {
        [`lastRead.${currentUser.email}`]: serverTimestamp(),
        [`unreadCount.${currentUser.email}`]: 0
    }, { merge: true }).catch(() => {});

    // Immediately reflect in the sidebar without waiting for the snapshot to round-trip
    document.querySelectorAll(`.wa-sidebar-item[data-email]`).forEach(item => {
        const itemRoomId = item.dataset.type === 'group'
            ? item.dataset.email
            : getPrivateRoomId(currentUser.email, item.dataset.email);
        if (itemRoomId !== roomId) return;
        item.querySelector('.wa-badge')?.remove();
        const nameEl    = item.querySelector('.wa-sidebar-name');
        const timeEl    = item.querySelector('.wa-sidebar-time');
        const previewEl = item.querySelector('.wa-sidebar-preview');
        nameEl?.classList.remove('wa-sidebar-name--unread');
        timeEl?.classList.remove('wa-sidebar-time--unread');
        previewEl?.classList.remove('wa-sidebar-preview--unread');
    });

    // Recompute the nav-level badge immediately (subtract this room's count)
    _recomputeNavBadge();
}
function _recomputeNavBadge() {
    // FIX: read data-count (real number) instead of parsing display text like '9+'
    let total = 0;
    document.querySelectorAll('.wa-badge[data-count]').forEach(badge => {
        const n = parseInt(badge.dataset.count, 10);
        if (!isNaN(n)) total += n;
    });
    _totalUnread = total;
    const navDot = document.getElementById('chat-nav-indicator');
    if (!navDot) return;
    navDot.classList.toggle('hidden', total === 0);
    navDot.textContent = total > 99 ? '99+' : total > 0 ? String(total) : '';
    navDot.classList.toggle('chat-nav-dot--count', total > 0);
}

function markMessagesSeenBy(roomId) {
    if (!roomId || !currentUser?.email) return;
    const unseen = lastMessagesSnapshot.filter(m =>
        m.senderEmail !== currentUser.email &&
        !m.seenBy?.includes(currentUser.email) &&
        !m.isDeletedForEveryone
    );
    unseen.forEach(m => {
        updateDoc(doc(db, `chats/${roomId}/messages`, m.id), {
            seenBy: arrayUnion(currentUser.email)
        }).catch(() => {});
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
        writeTypingState(activeRoomId, true);
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

    // FIX: lastMessagesSnapshot is newest-first (desc). The container uses flex-direction:column-reverse,
    // so we iterate oldest-first (reversed) and insert date dividers before each new date group.
    // This ensures dividers appear above the correct group in the rendered output.
    const msgs = [...lastMessagesSnapshot].reverse(); // oldest → newest
    let html     = '';
    let lastDate = '';
    msgs.forEach((msg, i) => {
        const dateKey = msg.createdAt?.toDate
            ? msg.createdAt.toDate().toDateString()
            : '';
        if (dateKey && dateKey !== lastDate) {
            lastDate = dateKey;
            const label = msg.createdAt?.toDate
                ? msg.createdAt.toDate().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
                : '';
            html += `<div class="wa-date-divider">${label}</div>`;
        }
        // buildMessageHTML expects the original desc-order array and the original index for consecutive-sender detection
        const origIndex = lastMessagesSnapshot.findIndex(m => m.id === msg.id);
        html += buildMessageHTML(msg, origIndex, lastMessagesSnapshot, chatType);
    });

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
    if (sidebarSearchInput) {
        sidebarSearchInput.addEventListener('input', e => {
            const q = e.target.value.toLowerCase().trim();
            document.querySelectorAll('.wa-sidebar-item').forEach(item => {
                const name = (item.dataset.name || '').toLowerCase();
                item.style.display = (!q || name.includes(q)) ? '' : 'none';
            });
        });
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
                        type: 'private', lastMessage: u.email, time: '',
                        online: isUserOnline(u.lastActive)
                    });
                }
            });
            cachedUsersData = users;
            cachedUsersHTML = html || '<p class="text-gray-400 text-sm text-center py-8">No contacts found.</p>';
            cachedUsersAt   = Date.now(); // FIX: record fetch time for TTL check
            usersListContent.innerHTML = cachedUsersHTML;
        } catch {
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
    window.addEventListener('beforeunload', () => { clearInterval(_hbInterval); }, { once: true });

    // ── Recent chats ────────────────────────────
    const loadRecentChats = () => {
        if (!currentUser) return;
        unsubscribeRecent();
        const q = query(
            collection(db, 'chats'),
            where('members', 'array-contains', currentUser.email)
        );
        recentChatsSub = onSnapshot(q, snap => {
            const chats = [];
            snap.forEach(d => chats.push({ id: d.id, ...d.data() }));
            chats.sort((a, b) => (b.lastUpdated?.toMillis() || 0) - (a.lastUpdated?.toMillis() || 0));

            if (!chats.length) {
                recentList.innerHTML = `
                    <div class="flex flex-col items-center justify-center py-16 px-4 text-center gap-3">
                        <div class="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center text-2xl">💬</div>
                        <p class="text-gray-700 text-sm font-medium">No conversations yet</p>
                        <p class="text-gray-400 text-xs">Start one from the Contacts tab</p>
                    </div>`;
                const navDot = document.getElementById('chat-nav-indicator');
                if (navDot) navDot.classList.add('hidden');
                return;
            }

            let html = '';
            let totalUnread = 0;
            chats.forEach(chat => {
                const isGroup    = chat.type === 'group';
                const email      = isGroup ? chat.id : (chat.members?.find(e => e !== currentUser.email) || '');
                const name       = isGroup
                    ? chat.name
                    : (chat.memberNames?.find(n => n && n !== currentUser.name) || email.split('@')[0] || 'Unknown');
                const isBlocked  = chat.blockedBy?.length > 0;
                const lastMessage = isBlocked ? '🔒 Chat Blocked' : (chat.lastMessage || 'New Chat');
                const time        = formatRelativeTime(chat.lastUpdated);
                const lastReadMs  = chat.lastRead?.[currentUser.email]?.toMillis?.() || 0;
                const updatedMs   = chat.lastUpdated?.toMillis?.() || 0;
                const isActiveRoom = chat.id === activeRoomId;
                // EXT: use per-user unreadCount when available, fall back to timestamp comparison
                const unreadFromCounter = chat.unreadCount?.[currentUser.email];
// If the room is currently open, clear any server counter that arrived in the snapshot
                // FIX: only write the clear if the counter is actually positive (avoids redundant writes on every snapshot)
                if (isActiveRoom && typeof unreadFromCounter === 'number' && unreadFromCounter > 0) {
                    setDoc(doc(db, 'chats', chat.id), {
                        [`unreadCount.${currentUser.email}`]: 0
                    }, { merge: true }).catch(() => {});
                }
                const unread = isActiveRoom ? 0
                    : (typeof unreadFromCounter === 'number'
                        ? unreadFromCounter
                        : (updatedMs > lastReadMs && chat.lastSenderEmail !== currentUser.email ? 1 : 0));
                const online      = !isGroup && cachedUsersData?.find(u => u.email === email)
                    ? isUserOnline(cachedUsersData.find(u => u.email === email).lastActive) : false;
                html += createSidebarItemHTML({ id: chat.id, email, name, type: chat.type, lastMessage, time, unread, online, isActive: isActiveRoom });
                totalUnread += unread;
            });
            recentList.innerHTML = html;

            // ── Nav indicator: show unread count badge ──
            _totalUnread = totalUnread; // FIX: keep module-level total in sync with snapshot
            const navDot = document.getElementById('chat-nav-indicator');
            if (navDot) {
                navDot.classList.toggle('hidden', totalUnread === 0);
                navDot.textContent = totalUnread > 99 ? '99+' : totalUnread > 0 ? String(totalUnread) : '';
                navDot.classList.toggle('chat-nav-dot--count', totalUnread > 0);
            }
        }, err => {
            console.error('[Chat] recent:', err);
            showToast('Lost connection to chat list.', 'error');
        });
    };

    document.querySelector('[data-target="page-chat"]')?.addEventListener('click', loadRecentChats);

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
        } catch {
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
                document.getElementById('btn-show-recent')?.click();
                loadRecentChats();
            } catch {
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
                    <input type="text" id="join-group-code-input" placeholder="e.g. ABC123XY" maxlength="12"
                        style="width:100%;background:var(--wa-input-bg);border:1.5px solid transparent;border-radius:12px;padding:12px 16px;font-size:15px;color:var(--wa-text);outline:none;letter-spacing:.1em;text-transform:uppercase;transition:border-color .15s"
                        oninput="this.value=this.value.toUpperCase()"
                        onfocus="this.style.borderColor='var(--wa-accent)'"
                        onblur="this.style.borderColor='transparent'">
                    <p id="join-group-error" style="color:var(--wa-danger);font-size:13px;display:none"></p>
                </div>
                <div style="padding:14px 16px;border-top:1px solid var(--wa-border);display:flex;justify-content:flex-end;gap:10px;background:var(--wa-panel)">
                    <button id="cancel-join-modal" style="font-size:14px;font-weight:500;color:var(--wa-sub);padding:8px 16px;border-radius:10px;background:none;border:none;cursor:pointer">Cancel</button>
                    <button id="confirm-join-group" style="font-size:14px;font-weight:600;color:#fff;background:var(--wa-accent);padding:8px 20px;border-radius:10px;border:none;cursor:pointer;transition:background .15s">Send Join Request</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        requestAnimationFrame(() => document.getElementById('join-group-card')?.style.setProperty('opacity','1') || (document.getElementById('join-group-card').style.opacity='1', document.getElementById('join-group-card').style.transform='scale(1)'));

        const closeJoin = () => modal.remove();
        modal.addEventListener('click', e => { if (e.target === modal) closeJoin(); });
        document.getElementById('close-join-modal').addEventListener('click', closeJoin);
        document.getElementById('cancel-join-modal').addEventListener('click', closeJoin);

        document.getElementById('confirm-join-group').addEventListener('click', async () => {
            const code = document.getElementById('join-group-code-input').value.trim().toUpperCase();
            const errEl = document.getElementById('join-group-error');
            if (!code) { errEl.textContent = 'Please enter an invite code.'; errEl.style.display='block'; return; }
            const btn = document.getElementById('confirm-join-group');
            btn.textContent = 'Searching…'; btn.disabled = true;
            errEl.style.display = 'none';
            try {
                const q = query(collection(db, 'chats'), where('inviteCode', '==', code), where('type', '==', 'group'));
                const snap = await getDocs(q);
                if (snap.empty) {
                    errEl.textContent = 'No group found with this code. Check and try again.';
                    errEl.style.display = 'block';
                    btn.textContent = 'Send Join Request'; btn.disabled = false;
                    return;
                }
                const groupDoc  = snap.docs[0];
                const groupData = groupDoc.data();
                const groupDocId = groupDoc.id;
                if (groupData.members?.includes(currentUser.email)) {
                    errEl.textContent = 'You are already a member of this group.';
                    errEl.style.display = 'block';
                    btn.textContent = 'Send Join Request'; btn.disabled = false;
                    return;
                }
                const pending   = groupData.pendingRequests || [];
                const dismissed = groupData.dismissedRequests || [];
                const dismissEntry = dismissed.find(r => r.email === currentUser.email);
                if (dismissEntry && dismissEntry.dismissedUntil > Date.now()) {
                    const hoursLeft = Math.ceil((dismissEntry.dismissedUntil - Date.now()) / 3600000);
                    errEl.textContent = `Your request was dismissed. You can try again in ${hoursLeft} hour(s).`;
                    errEl.style.display = 'block';
                    btn.textContent = 'Send Join Request'; btn.disabled = false;
                    return;
                }
                if (pending.some(r => r.email === currentUser.email)) {
                    errEl.textContent = 'Your join request is already pending approval.';
                    errEl.style.display = 'block';
                    btn.textContent = 'Send Join Request'; btn.disabled = false;
                    return;
                }
                // Remove from dismissed if re-applying after expiry
                const newDismissed = dismissed.filter(r => r.email !== currentUser.email);
                await updateDoc(doc(db, 'chats', groupDocId), {
                    pendingRequests: arrayUnion({ email: currentUser.email, name: currentUser.name, requestedAt: Date.now() }),
                    dismissedRequests: newDismissed
                });
                closeJoin();
                showToast('Join request sent! Waiting for admin approval.', 'success');
            } catch(err) {
                console.error('[Chat] join group error:', err);
                errEl.textContent = 'Something went wrong. Please try again.';
                errEl.style.display = 'block';
                btn.textContent = 'Send Join Request'; btn.disabled = false;
            }
        });
    });

    // ── Open chat room ───────────────────────────
    const openChatRoom = (targetEmail, targetName, chatType) => {
        // Fix #5 (High): always remove the previous dropdown listener before registering
        // a new one — prevents accumulation when openChatRoom is called via
        // window.startDirectChat or the ?joinGroup= URL flow (which skip sidebar cleanup).
        if (chatHeader._cleanupDropdown) {
            document.removeEventListener('click', chatHeader._cleanupDropdown);
            chatHeader._cleanupDropdown = null;
        }
        unsubscribeRoomListeners();
        closeSearchBar();
        stopRecording(true);
        document.getElementById('wa-reply-preview')?.remove();
        replyingTo   = null;
        editingMsgId = null;  // EXT: clear any in-progress edit when switching rooms
        // FIX: mutate both collections in place, never reassign
        pinnedMessages.splice(0, pinnedMessages.length);
        starredMessages.clear();

        activeRoomId      = chatType === 'group'
            ? targetEmail
            : getPrivateRoomId(currentUser.email, targetEmail);
        activeRoomDetails = { id: activeRoomId, type: chatType, targetEmail, targetName };

        if (chatType === 'private') {
            setDoc(doc(db, 'chats', activeRoomId), {
                type: 'private', members: [currentUser.email, targetEmail],
                memberNames: [currentUser.name, targetName], lastUpdated: serverTimestamp()
            }, { merge: true }).catch(() => showToast('Could not open chat.', 'error'));
        }

        markRoomRead(activeRoomId); // FIX: markRoomRead already calls _recomputeNavBadge — removed duplicate call
        subscribeTypingIndicator(activeRoomId, chatType);

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
        // Clean up listener when room changes (will be re-added on next openChatRoom)
        chatHeader._cleanupDropdown = closeDropdown;

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
        chatSub = onSnapshot(msgsQuery, snap => {
            if (snap.empty && !lastMessagesSnapshot.length) {
                chatContainer.innerHTML = `
                    <div class="w-full h-full flex items-center justify-center">
                        <div style="background:rgba(255,255,255,.9);border:1px solid var(--wa-border);padding:12px 20px;border-radius:12px;color:var(--wa-sub);font-size:13px;text-align:center">
                            🔒 End-to-end encrypted<br>
                            <span style="color:var(--wa-text);font-weight:500">Say hi to ${sanitize(targetName)}!</span>
                        </div>
                    </div>`;
                return;
            }
            lastMessagesSnapshot = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            // FIX: mutate starredMessages in place (never reassign); try/catch for private browsing
            starredMessages.clear();
            try {
                const savedStarred = JSON.parse(localStorage.getItem(`starred_${activeRoomId}`) || '[]');
                savedStarred.forEach(id => starredMessages.add(id));
            } catch { /* blocked in private browsing — leave set empty */ }
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
            document.querySelectorAll('.wa-sidebar-item--active').forEach(el =>
                el.classList.remove('wa-sidebar-item--active'));
            item.classList.add('wa-sidebar-item--active');
            // Clean up old dropdown listener
            if (chatHeader._cleanupDropdown) {
                document.removeEventListener('click', chatHeader._cleanupDropdown);
                chatHeader._cleanupDropdown = null;
            }
            openChatRoom(email, name, chatType);
            window.startDirectChat = (e2, n2) => openChatRoom(e2, n2, 'private');
        });
    };
    handleSidebarClick(recentList);
    handleSidebarClick(usersListContent);
    window.startDirectChat = (email, name) => openChatRoom(email, name, 'private');

    // ── Message click delegation ─────────────────
    chatContainer?.addEventListener('click', async e => {
        if (!e.target.closest('.wa-msg-menu')) {
            document.querySelectorAll('.wa-msg-dropdown').forEach(d => d.classList.add('hidden'));
        }

        // Menu toggle
        const menuBtn = e.target.closest('.msg-menu-btn');
        if (menuBtn) {
            e.stopPropagation();
            const dropdown = menuBtn.nextElementSibling;
            if (!dropdown) return;
            const wasHidden = dropdown.classList.contains('hidden');
            document.querySelectorAll('.wa-msg-dropdown').forEach(d => d.classList.add('hidden'));
            if (wasHidden) dropdown.classList.remove('hidden');
            return;
        }

        const reactPill = e.target.closest('.wa-reaction-pill');
        if (reactPill) { await toggleReaction(reactPill.dataset.msgId, reactPill.dataset.emoji); return; }

        const reactBtn = e.target.closest('.msg-react-btn');
        if (reactBtn) {
            document.querySelectorAll('.wa-msg-dropdown').forEach(d => d.classList.add('hidden'));
            await toggleReaction(reactBtn.dataset.msgId, reactBtn.dataset.emoji); return;
        }

        const retryBtn = e.target.closest('.msg-retry-btn,.wa-retry-btn');
        if (retryBtn && activeRoomId) { await retrySend(retryBtn.dataset.msgId); return; }

        const replyBtn = e.target.closest('.msg-reply-btn');
        if (replyBtn) {
            document.querySelectorAll('.wa-msg-dropdown').forEach(d => d.classList.add('hidden'));
            const msg = lastMessagesSnapshot.find(m => m.id === replyBtn.dataset.msgId);
            if (msg) {
                showReplyPreview(msg, chatHeader, input);
            } else {
                showReplyPreview({
                    id: replyBtn.dataset.msgId,
                    text: replyBtn.dataset.text || '',
                    senderName: replyBtn.dataset.sender || '',
                    senderEmail: '',
                    imageUrl: replyBtn.dataset.image || '',
                    voiceUrl: replyBtn.dataset.voice || '',
                    fileUrl: replyBtn.dataset.file  || '',
                    fileName: replyBtn.dataset.filename || ''
                }, chatHeader, input);
            }
            return;
        }

        // EXT: handle edit button
        const editBtn = e.target.closest('.msg-edit-btn');
        if (editBtn) {
            document.querySelectorAll('.wa-msg-dropdown').forEach(d => d.classList.add('hidden'));
            const msgId   = editBtn.dataset.msgId;
            const msgText = editBtn.dataset.text || '';
            // Show an "Editing" bar the same way showReplyPreview shows a reply bar
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
            return;
        }

        const fwdBtn = e.target.closest('.msg-forward-btn');
        if (fwdBtn) {
            document.querySelectorAll('.wa-msg-dropdown').forEach(d => d.classList.add('hidden'));
            await openForwardModal(fwdBtn.dataset.msgId); return;
        }

        const starBtn = e.target.closest('.msg-star-btn');
        if (starBtn) {
            document.querySelectorAll('.wa-msg-dropdown').forEach(d => d.classList.add('hidden'));
            const msgId = starBtn.dataset.msgId;
            if (starredMessages.has(msgId)) { starredMessages.delete(msgId); showToast('Unstarred.'); }
            else { starredMessages.add(msgId); showToast('Message starred. ⭐'); }
            try { localStorage.setItem(`starred_${activeRoomId}`, JSON.stringify([...starredMessages])); } catch {}
            renderMessages(); return;
        }

        const pinBtn = e.target.closest('.msg-pin-btn');
        if (pinBtn) {
            document.querySelectorAll('.wa-msg-dropdown').forEach(d => d.classList.add('hidden'));
            const msgId = pinBtn.dataset.msgId;
            // FIX: mutate in place
            const newPinned = [msgId, ...pinnedMessages.filter(id => id !== msgId)].slice(0, 3);
            pinnedMessages.splice(0, pinnedMessages.length, ...newPinned);
            renderPinnedBar(chatHeader);
            try { await updateDoc(doc(db, 'chats', activeRoomId), { pinnedMessages }); } catch {}
            showToast('Message pinned. 📌', 'success'); return;
        }

        const copyBtn = e.target.closest('.msg-copy-btn');
        if (copyBtn) {
            document.querySelectorAll('.wa-msg-dropdown').forEach(d => d.classList.add('hidden'));
            try { await navigator.clipboard.writeText(copyBtn.dataset.text); showToast('Copied.', 'success'); }
            catch { showToast('Copy failed.', 'error'); }
            return;
        }

        const delMeBtn = e.target.closest('.msg-delete-me-btn');
        if (delMeBtn && activeRoomId) {
            document.querySelectorAll('.wa-msg-dropdown').forEach(d => d.classList.add('hidden'));
            try {
                await updateDoc(doc(db, `chats/${activeRoomId}/messages`, delMeBtn.dataset.msgId), {
                    deletedFor: arrayUnion(currentUser.email)
                });
            } catch { showToast('Failed to delete.', 'error'); }
            return;
        }

        const delEveryoneBtn = e.target.closest('.msg-delete-everyone-btn');
        if (delEveryoneBtn && activeRoomId) {
            document.querySelectorAll('.wa-msg-dropdown').forEach(d => d.classList.add('hidden'));
            const ok = await showConfirm({
                title: 'Delete for everyone?',
                body: 'This message will be removed for all participants.',
                confirmLabel: 'Delete', tone: 'danger'
            });
            if (!ok) return;
            try {
                await updateDoc(doc(db, `chats/${activeRoomId}/messages`, delEveryoneBtn.dataset.msgId), {
                    isDeletedForEveryone: true, text: null, imageUrl: null, voiceUrl: null, fileUrl: null
                });
                // AFTER — bump all members EXCEPT the sender
                const roomDetails = activeRoomDetails;
                const roomMembers = roomDetails?.type === 'group'
                    ? [] // groups: let recipients track via lastRead diff (server-side rules or Cloud Functions handle per-member counters)
                    : [roomDetails?.targetEmail].filter(Boolean);

                // FIX: `roomId` was undefined here — use `activeRoomId`
                const _delRoomId = activeRoomId;
                const unreadBump = {};
                for (const e of roomMembers) {
                    if (e && e !== currentUser.email) {
                        const snap = await getDoc(doc(db, 'chats', _delRoomId)).catch(() => null);
                        unreadBump[`unreadCount.${e}`] = (snap?.data()?.unreadCount?.[e] || 0) + 1;
                    }
                }
                await setDoc(doc(db, 'chats', _delRoomId), {
                    lastMessage: '', lastSenderEmail: currentUser.email,
                    lastUpdated: serverTimestamp(),
                    [`unreadCount.${currentUser.email}`]: 0,
                    ...unreadBump
                }, { merge: true });
            } catch { showToast('Failed to delete.', 'error'); }
            return;
        }

        const imgEl = e.target.closest('.msg-image, .wa-msg-image');
        if (imgEl) { openLightbox(imgEl.dataset.full || imgEl.src); return; }

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
            // FIX: use module-level _activeAudio instead of window._waAudio
            if (_activeAudio && !_activeAudio.paused) {
                _activeAudio.pause();
                voicePlayBtn.innerHTML = `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
                return;
            }
            // Fix #4 (Critical): never fall back to raw url — if safeUrl rejects it, abort
            const _safeVoice = safeUrl(url);
            if (!_safeVoice) return;
            const audio    = new Audio(_safeVoice);
            _activeAudio   = audio;
            voicePlayBtn.innerHTML = `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
            audio.play().catch(() => {});
            audio.addEventListener('ended', () => {
                voicePlayBtn.innerHTML = `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
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
                await updateDoc(doc(db, 'chats', activeRoomId), { members: arrayRemove(currentUser.email) });
                await addDoc(collection(db, `chats/${activeRoomId}/messages`), {
                    text: `${currentUser.name} left the group.`,
                    senderEmail: 'system', senderName: 'System', createdAt: serverTimestamp()
                });
                resetChatPanel(chatHeader, chatContainer, input, sendBtn, attachBtn);
                showToast('You left the group.', 'success');
                document.getElementById('btn-show-recent')?.click();
            } catch { showToast('Failed to leave.', 'error'); }
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
            const ok = await showConfirm({
                title: 'Clear chat?',
                body: 'All messages will be cleared for you only.',
                confirmLabel: 'Clear', tone: 'danger'
            });
            if (!ok) return;
            try {
                const roomIdToClear = activeRoomId;
                const msgsSnap = await getDocs(collection(db, `chats/${roomIdToClear}/messages`));
                await Promise.all(msgsSnap.docs.map(d =>
                    updateDoc(d.ref, { deletedFor: arrayUnion(currentUser.email) })
                ));
                lastMessagesSnapshot = [];
                renderMessages();
                showToast('Chat cleared.', 'success');
            } catch { showToast('Failed to clear chat.', 'error'); }
            return;
        }

        if (e.target.id === 'chat-action-delete') {
            document.getElementById('chat-header-dropdown') &&
                (document.getElementById('chat-header-dropdown').style.display = 'none');
            const ok = await showConfirm({
                title: 'Delete chat?',
                body: 'All messages will be permanently removed. This cannot be undone.',
                confirmLabel: 'Delete', tone: 'danger'
            });
            if (!ok) return;
            try {
                const roomIdToDelete = activeRoomId;
                const msgsSnap       = await getDocs(collection(db, `chats/${roomIdToDelete}/messages`));
                // Batch deletions in groups of 400 to avoid memory spikes
                const chunks = [];
                let chunk    = [];
                msgsSnap.forEach(d => {
                    chunk.push(deleteDoc(d.ref));
                    if (chunk.length >= 400) { chunks.push(Promise.all(chunk)); chunk = []; }
                });
                if (chunk.length) chunks.push(Promise.all(chunk));
                await Promise.all(chunks);
                await deleteDoc(doc(db, 'chats', roomIdToDelete));
                resetChatPanel(chatHeader, chatContainer, input, sendBtn, attachBtn);
                showToast('Chat deleted.', 'success');
            } catch { showToast('Failed to delete chat.', 'error'); }
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
            } catch { showToast('Failed to update block status.', 'error'); }
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
        if (!text || !activeRoomId || !activeRoomDetails) return;
        const roomId  = activeRoomId;
        const tempId  = `pending_${Date.now()}_${optimisticCounter++}`;
        const replyTo = replyingTo ? { ...replyingTo } : null;

        const optimisticMsg = {
            id: tempId, text, senderEmail: currentUser.email, senderName: currentUser.name,
            createdAt: { toDate: () => new Date() }, _pending: true, replyTo
        };
        if (roomId === activeRoomId) {
            lastMessagesSnapshot = [optimisticMsg, ...lastMessagesSnapshot];
            renderMessages();
        }
        clearTypingState();
        writeTypingState(roomId, false);

        // FIX: clear replyingTo BEFORE async call so it's not attached twice on retry
        replyingTo = null;
        document.getElementById('wa-reply-preview')?.remove();

        try {
            const payload = {
                text, senderEmail: currentUser.email, senderName: currentUser.name,
                createdAt: serverTimestamp(), seenBy: []
            };
            if (replyTo) payload.replyTo = replyTo;
            await addDoc(collection(db, `chats/${roomId}/messages`), payload);
            // FIX: bump recipient unreadCount for private chats (was only resetting own counter)
            const _sendRoomDetails = activeRoomDetails;
            const _sendUpdate = {
                lastMessage: text, lastSenderEmail: currentUser.email,
                lastUpdated: serverTimestamp(),
                [`unreadCount.${currentUser.email}`]: 0
            };
            if (_sendRoomDetails?.type === 'private' && _sendRoomDetails?.targetEmail) {
                const _recip = _sendRoomDetails.targetEmail;
                const _rSnap = await getDoc(doc(db, 'chats', roomId)).catch(() => null);
                _sendUpdate[`unreadCount.${_recip}`] = (_rSnap?.data()?.unreadCount?.[_recip] || 0) + 1;
            }
            await setDoc(doc(db, 'chats', roomId), _sendUpdate, { merge: true });
            lastMessagesSnapshot = lastMessagesSnapshot.filter(m => m.id !== tempId);
            if (roomId === activeRoomId) renderMessages();
        } catch (err) {
            console.error('Send failed:', err);
            lastMessagesSnapshot = lastMessagesSnapshot.map(m =>
                m.id === tempId ? { ...m, _pending: false, _failed: true } : m);
            if (roomId === activeRoomId) renderMessages();
            showToast('Failed to send.', 'error');
        }
    }

    async function retrySend(tempId) {
        const t = lastMessagesSnapshot.find(m => m.id === tempId);
        if (!t) return;
        lastMessagesSnapshot = lastMessagesSnapshot.filter(m => m.id !== tempId);
        // FIX: restore replyTo from the failed message so it's preserved on retry
        if (t.replyTo) replyingTo = t.replyTo;
        await sendTextMessage(t.text);
    }

    // FIX: shared helper — was copy-pasted identically in both submit and keydown handlers
    async function commitInput() {
        const text = input.value.trim();
        if (!text) return;
        // EXT: if in edit mode, update the existing message instead of sending new
        if (editingMsgId) {
            const idToEdit = editingMsgId;
            editingMsgId   = null;
            document.getElementById('wa-reply-preview')?.remove();
            input.value        = '';
            input.style.height = 'auto';
            input.focus();
            try {
                await updateDoc(doc(db, `chats/${activeRoomId}/messages`, idToEdit), {
                    text, edited: true, editedAt: serverTimestamp()
                });
                showToast('Message edited.', 'success');
            } catch { showToast('Failed to edit message.', 'error'); }
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
                <span class="wa-attach-icon" style="background:rgba(16,185,129,.12)">🖼️</span> Photo
            </button>
            <button class="wa-attach-item" id="wa-attach-video-btn">
                <span class="wa-attach-icon" style="background:rgba(59,130,246,.12)">🎥</span> Video
            </button>
            <button class="wa-attach-item" id="wa-attach-file-btn">
                <span class="wa-attach-icon" style="background:rgba(168,85,247,.12)">📄</span> Document
            </button>`;
        const inputArea = input.closest('form') || input.parentElement;
        (inputArea?.parentElement || document.body).appendChild(menu);

        document.getElementById('wa-attach-image-btn').addEventListener('click', () => { imageAttachInput.click(); menu.remove(); });
        document.getElementById('wa-attach-video-btn').addEventListener('click', () => { videoAttachInput.click(); menu.remove(); });
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
    // FIX (Security): 50 MB client-side limit to prevent accidental/malicious huge uploads
    const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

    async function sendMediaFile(file) {
        if (!file || !activeRoomId) return;
        if (file.size > MAX_UPLOAD_BYTES) {
            showToast(`File too large (max 50 MB). Please choose a smaller file.`, 'error');
            return;
        }
        const roomId  = activeRoomId;
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
            let url;
            try {
                url = await uploadBytesWithRetry(fileToSend, 'chats', (pct, attempt) => {
                    setProgress(pct, attempt > 0 ? `Retrying… (attempt ${attempt + 1})` : `Uploading… ${pct}%`);
                }, fileToSend instanceof File ? fileToSend.name : `upload_${Date.now()}`);
            } catch (uploadErr) {
                throw uploadErr;
            }
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
            // FIX: bump recipient unreadCount for file/image/video sends too
            const _fileRoomDetails = activeRoomDetails;
            const _fileUpdate = {
                lastMessage: isImage ? '📷 Photo' : (isVideo ? '🎥 Video' : `📎 ${file.name}`),
                lastSenderEmail: currentUser.email, lastUpdated: serverTimestamp(),
                [`unreadCount.${currentUser.email}`]: 0
            };
            if (_fileRoomDetails?.type === 'private' && _fileRoomDetails?.targetEmail) {
                const _recip = _fileRoomDetails.targetEmail;
                const _rSnap = await getDoc(doc(db, 'chats', roomId)).catch(() => null);
                _fileUpdate[`unreadCount.${_recip}`] = (_rSnap?.data()?.unreadCount?.[_recip] || 0) + 1;
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

    imageAttachInput.addEventListener('change', async e => {
        if (e.target.files[0]) { await sendMediaFile(e.target.files[0]); imageAttachInput.value = ''; }
    });
    fileAttachInput.addEventListener('change', async e => {
        if (e.target.files[0]) { await sendMediaFile(e.target.files[0]); fileAttachInput.value = ''; }
    });
    videoAttachInput.addEventListener('change', async e => {
        if (e.target.files[0]) { await sendMediaFile(e.target.files[0]); videoAttachInput.value = ''; }
    });

    // Drag & drop
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
        const file = e.dataTransfer.files?.[0];
        if (file) await sendMediaFile(file);
    });

    // Paste image from clipboard
    input.addEventListener('paste', async e => {
        if (!activeRoomId) return;
        for (const item of (e.clipboardData?.items || [])) {
            if (item.type?.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) { e.preventDefault(); await sendMediaFile(file); break; }
            }
        }
    });

    // ── Voice recording ──────────────────────────
    async function startVoiceRecording() {
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
                <button class="wa-rec-cancel" id="wa-rec-cancel-btn">✕ Cancel</button>`;
            const inputArea = input.closest('form') || input.parentElement;
            inputArea?.parentElement?.insertBefore(bar, inputArea);

            let elapsed = 0;
            recordingTimer = setInterval(() => {
                elapsed++;
                const el = document.getElementById('wa-rec-timer');
                if (el) el.textContent = formatDuration(elapsed);
                if (elapsed >= 120) stopAndSendRecording();
            }, 1000);

            document.getElementById('wa-rec-cancel-btn')?.addEventListener('click', () => {
                stopRecording(true);
                stream.getTracks().forEach(t => t.stop());
            });

            // EXT: pause / resume recording
            document.getElementById('wa-rec-pause-btn')?.addEventListener('click', () => {
                const pauseBtn = document.getElementById('wa-rec-pause-btn');
                const dot      = document.querySelector('.wa-rec-dot');
                if (!mediaRecorder) return;
                if (mediaRecorder.state === 'recording') {
                    mediaRecorder.pause();
                    if (pauseBtn) pauseBtn.textContent = '▶';
                    if (dot)     dot.classList.add('paused');
                } else if (mediaRecorder.state === 'paused') {
                    mediaRecorder.resume();
                    if (pauseBtn) pauseBtn.textContent = '⏸';
                    if (dot)     dot.classList.remove('paused');
                }
            });

            mediaRecorder.onstop = async () => {
                stream.getTracks().forEach(t => t.stop());
                // FIX: check cancelled flag, not chunk length (chunks may have been pushed after clear)
                if (recordingCancelled || !audioChunks.length) {
                    audioChunks = [];
                    return;
                }
                // FIX: use the recorder's actual mimeType, not hardcoded ogg
                const recMime  = mediaRecorder?.mimeType || 'audio/webm';
                mediaRecorder  = null; // safe to null now — all data collected
                const blob     = new Blob(audioChunks, { type: recMime });
                const duration = Math.max(1, Math.round((Date.now() - recordingStartTime) / 1000));
                audioChunks    = [];
                const roomId   = activeRoomId;
                if (!roomId) return;
                try {
                    const url = await uploadAudioBlob(blob, recMime);
                    await addDoc(collection(db, `chats/${roomId}/messages`), {
                        voiceUrl: url, voiceDuration: duration,
                        senderEmail: currentUser.email, senderName: currentUser.name,
                        createdAt: serverTimestamp(), seenBy: [], text: ''
                    });
                    await setDoc(doc(db, 'chats', roomId), {
                        lastMessage: '🎤 Voice note', lastSenderEmail: currentUser.email, lastUpdated: serverTimestamp()
                    }, { merge: true });
                } catch (err) { console.error(err); showToast('Failed to send voice note.', 'error'); }
            };
        } catch (err) {
            console.error(err);
            showToast('Microphone access denied.', 'error');
        }
    }

    document.getElementById('wa-mic-btn')?.addEventListener('click', () => {
        if (!activeRoomId) return;
        if (isRecording) stopAndSendRecording();
        else startVoiceRecording();
    });

    // ── Reactions ────────────────────────────────
    async function toggleReaction(msgId, emoji) {
        if (!activeRoomId) return;
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
        } catch { showToast('Failed to react.', 'error'); }
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
        const close = () => modal.remove();
        modal.addEventListener('click', e => { if (e.target === modal) close(); });
        document.getElementById('close-members-modal').addEventListener('click', close);

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

        try {
            const snap = await getDoc(doc(db, 'chats', activeRoomId));
            if (!snap.exists()) { close(); return; }
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
                                close();
                            } catch { showToast('Failed to add member.', 'error'); }
                        });
                    });
                } catch { showToast('Failed to load users.', 'error'); }
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
                        close();
                        setTimeout(() => openMembersPanel(), 150);
                    } catch { showToast('Failed to update admin.', 'error'); }
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
                        close();
                    } catch { showToast('Failed to remove member.', 'error'); }
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
                        const name  = btn.dataset.name;
                        try {
                            await updateDoc(doc(db, 'chats', activeRoomId), {
                                members: arrayUnion(email),
                                memberNames: arrayUnion(name),
                                pendingRequests: (data.pendingRequests || []).filter(r => r.email !== email)
                            });
                            await addDoc(collection(db, `chats/${activeRoomId}/messages`), {
                                text: `${name || email} joined the group.`,
                                senderEmail: 'system', senderName: 'System', createdAt: serverTimestamp()
                            });
                            showToast(`${name || email} approved!`, 'success');
                            close();
                        } catch { showToast('Failed to approve.', 'error'); }
                    });
                });

                // Dismiss for 24h: add dismissedUntil timestamp, remove from pending
                document.querySelectorAll('.req-dismiss-btn').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const email = btn.dataset.email;
                        const dismissUntil = Date.now() + 24 * 60 * 60 * 1000;
                        try {
                            const newPending = (data.pendingRequests || []).filter(r => r.email !== email);
                            const dismissed  = [...(data.dismissedRequests || []).filter(r => r.email !== email),
                                               { email, dismissedUntil: dismissUntil }];
                            await updateDoc(doc(db, 'chats', activeRoomId), {
                                pendingRequests: newPending,
                                dismissedRequests: dismissed
                            });
                            showToast('Request dismissed for 24 hours.', 'info');
                            close();
                        } catch { showToast('Failed to dismiss.', 'error'); }
                    });
                });

                // Deny permanently
                document.querySelectorAll('.req-deny-btn').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const email = btn.dataset.email;
                        try {
                            await updateDoc(doc(db, 'chats', activeRoomId), {
                                pendingRequests: (data.pendingRequests || []).filter(r => r.email !== email)
                            });
                            showToast('Request denied.', 'info');
                            close();
                        } catch { showToast('Failed to deny.', 'error'); }
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
                catch { showToast('Copy failed.', 'error'); }
            });
            document.getElementById('copy-invite-link')?.addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(inviteLink); showToast('Link copied!', 'success'); }
                catch { showToast('Copy failed.', 'error'); }
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
                    close();
                    setTimeout(() => openMembersPanel(), 150);
                } catch { showToast('Failed to regenerate code.', 'error'); }
            });
        } catch (err) {
            console.error('[Chat] members panel:', err);
            document.getElementById('mem-tab-members').innerHTML =
                '<p style="color:var(--wa-danger);font-size:14px;text-align:center;padding:24px">Failed to load members.</p>';
        }
    }

    // ── Init sidebar ─────────────────────────────
    loadRecentChats();
}