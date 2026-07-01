import { db } from '../config/firebase.js';
import { currentUser, setCurrentUser, getUserFromDB, saveUserToDB } from '../store/db.js';
import { sanitize } from '../ui/templates.js';
import { uploadToCloudinary } from '../utils/storage.js';
import {
    collection, doc, setDoc, addDoc, query, orderBy, onSnapshot,
    serverTimestamp, getDocs, limit, where, deleteDoc, updateDoc,
    arrayUnion, arrayRemove, getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { auth, googleProvider } from '../config/firebase.js';
import {
    onAuthStateChanged, signInWithPopup, signOut
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { updateAuthUI } from '../ui/navigation.js';

// ============================================================
//  AUTH SETUP — Google login, sign-out, onAuthStateChanged
// ============================================================
export function setupAuth() {
    // Google sign-in button
    const googleBtn = document.getElementById('google-login-btn');
    const loginError = document.getElementById('login-error');
    const logoutBtn = document.getElementById('logout-btn');

    if (googleBtn) {
        googleBtn.addEventListener('click', async () => {
            googleBtn.disabled = true;
            if (loginError) loginError.classList.add('hidden');
            try {
                await signInWithPopup(auth, googleProvider);
            } catch (err) {
                console.error('Login error:', err);
                if (loginError) {
                    loginError.textContent = 'Sign-in failed. Please try again.';
                    loginError.classList.remove('hidden');
                }
            } finally {
                googleBtn.disabled = false;
            }
        });
    }

    // Sign-out button
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            try {
                await signOut(auth);
            } catch (err) {
                console.error('Logout error:', err);
            }
        });
    }

    // React to auth state changes
    onAuthStateChanged(auth, async (firebaseUser) => {
        if (firebaseUser) {
            // Load or create user record in Firestore
            let userData = await getUserFromDB(firebaseUser.email);
            if (!userData) {
                userData = {
                    email: firebaseUser.email,
                    name: firebaseUser.displayName || firebaseUser.email.split('@')[0],
                    picture: firebaseUser.photoURL || '',
                    role: 'member',
                    savedPosts: [],
                    following: [],
                    followers: [],
                    joinedAt: Date.now(),
                };
                await saveUserToDB(firebaseUser.email, userData);
            }
            setCurrentUser(userData);
        } else {
            setCurrentUser(null);
        }
        updateAuthUI();
    });
}

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
let _hbInterval          = null;   // heartbeat interval ref for cleanup

// EXT: viewport-based pagination state for messages.
// We keep ONE realtime onSnapshot listener per room, but cap it with a
// growing `limit(messagesLimit)`. Initial load only fetches enough to fill
// the viewport; scrolling toward older messages bumps the limit and
// re-subscribes (Firestore serves the now-cached docs + a small number of
// new ones, which is far cheaper than ever loading the full thread).
const INITIAL_MSG_LIMIT  = 30;   // enough to fill a typical viewport without overscrolling
const MSG_PAGE_SIZE      = 30;
let messagesLimit        = INITIAL_MSG_LIMIT;
let isLoadingOlder        = false;
let hasMoreOlderMessages  = true;
let pendingScrollRestore  = null; // {height, top} captured right before a "load older" resubscribe

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

async function uploadAudioBlob(blob) {
    const ext = blob?.type?.includes('mp4') ? 'm4a'
        : blob?.type?.includes('ogg') ? 'ogg'
        : 'webm';
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
