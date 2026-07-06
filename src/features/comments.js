/**
 * comments.js — Full-featured comment system
 *
 * Fixes vs. original:
 *  - Edit comment: inline textarea replaces text, saves to Firestore, shows (edited) badge
 *  - Like comment/reply: optimistic toggle with Firestore arrayUnion/arrayRemove
 *  - Nested reply toggle: uses display flex/none (not hidden class) to match templates.js
 *  - Reply submit: reads btn.previousElementSibling reliably regardless of whitespace
 *  - Delete comment decrements commentCount correctly; delete reply uses recursive tree helper
 *  - authorPicture stored on comment/reply so avatars render in templates.js initialsAvatar
 *  - Timestamps stored as ISO strings AND as numeric ms for consistent timeAgo()
 *  - AI summariser: safe fallback + graceful error display
 *  - Reply-form dark-mode styles injected once
 *  - Comment submission clears input and shows toast
 *  - Like counts are always initialised (likes: 0, likedBy: [])
 *  - All async handlers are wrapped in try/catch with user-facing toasts
 *
 * New features added:
 *  - Reaction picker on comments (👍❤️😂😮😢)
 *  - Compact reaction summary row showing top reactions
 *  - Edit-in-place for own replies
 *  - "Load more" button if comment count > PAGE_SIZE
 *  - Keyboard shortcut: Ctrl/Cmd+Enter submits main comment
 *  - Character counter on comment textarea
 *  - Pin comment (admin only)
 */

import { db } from '../config/firebase.js';
import { currentUser } from '../store/db.js';
import { createPostCardHTML, createCommentHTML, showToast } from '../ui/templates.js';
import {
    collection, addDoc, onSnapshot, query, orderBy, limit,
    doc, getDoc, deleteDoc, updateDoc, increment,
    arrayUnion, arrayRemove, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { showPage } from '../ui/navigation.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const PAGE_SIZE     = 30;     // initial comments loaded
const COMMENT_MAX   = 1000;   // character limit per comment
const REPLY_MAX     = 500;
const REACTIONS     = ['👍', '❤️', '😂', '😮', '😢'];

// Gemini API — swap out key or model as needed
const API_KEY = 'YOUR_FIREBASE_API_KEY';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;

// ─── Module state ─────────────────────────────────────────────────────────────

let activeCommentsListener = null;
let currentPostId          = null;   // always in sync with commentsPage.dataset.currentPostId
let commentLimit           = PAGE_SIZE;

// ─── Style injection (once) ───────────────────────────────────────────────────

function injectCommentStyles() {
    if (document.getElementById('comments-module-styles')) return;
    const s = document.createElement('style');
    s.id = 'comments-module-styles';
    s.textContent = `
        /* ── Comment char counter ── */
        .cm-counter { font-size: 11px; color: #9ca3af; text-align: right; margin-top: 4px; }
        .cm-counter.warn { color: #f59e0b; }
        .cm-counter.over { color: #ef4444; }

        /* ── Edit textarea ── */
        .cm-edit-area {
            width: 100%; box-sizing: border-box;
            border: 1.5px solid #6366f1; border-radius: 8px;
            padding: 8px 10px; font-size: 14px; font-family: inherit;
            resize: vertical; outline: none;
            background: #fff; color: #111827;
            transition: border-color 0.15s;
        }
        body.dark-mode .cm-edit-area {
            background: #09090b; border-color: #4f46e5; color: #f4f4f5;
        }

        /* ── Reply form ── */
        .reply-form-container {
            display: none;
            margin-top: 8px;
            padding-left: 40px;
            gap: 6px;
            align-items: flex-start;
        }
        .reply-form-container.open { display: flex; }
        .reply-textarea {
            flex: 1;
            border-radius: 10px;
            padding: 8px 10px;
            font-size: 13px;
            border: 1.5px solid #e5e7eb;
            background: #fff;
            color: #111827;
            outline: none;
            resize: none;
            transition: border-color 0.15s;
            font-family: inherit;
        }
        .reply-textarea:focus { border-color: #6366f1; }
        body.dark-mode .reply-textarea {
            background: #09090b; border-color: #3f3f46; color: #f4f4f5;
        }
        .submit-reply-btn {
            background: #6366f1; color: #fff;
            padding: 7px 14px; border-radius: 8px;
            font-size: 13px; font-weight: 600;
            border: none; cursor: pointer; flex-shrink: 0;
            transition: background 0.15s, transform 0.1s;
        }
        .submit-reply-btn:hover { background: #4f46e5; }
        .submit-reply-btn:active { transform: scale(0.97); }
        .submit-reply-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        /* ── Like button ── */
        .like-comment-btn, .like-reply-btn {
            display: inline-flex; align-items: center; gap: 4px;
            background: none; border: none; cursor: pointer;
            font-size: 12px; font-weight: 600;
            color: #9ca3af; padding: 0; transition: color 0.15s, transform 0.15s;
        }
        .like-comment-btn.liked, .like-reply-btn.liked { color: #e11d48; }
        .like-comment-btn:hover, .like-reply-btn:hover { color: #e11d48; }
        .like-comment-btn:active, .like-reply-btn:active { transform: scale(1.25); }

        /* ── Reaction picker ── */
        .cm-reaction-picker {
            display: none; position: absolute; top: -44px; left: 0;
            background: #fff; border: 1px solid #e5e7eb;
            border-radius: 24px; padding: 4px 8px;
            box-shadow: 0 4px 16px rgba(0,0,0,0.12);
            gap: 4px; z-index: 50;
        }
        .cm-reaction-picker.open { display: flex; }
        body.dark-mode .cm-reaction-picker { background: #18181b; border-color: #27272a; }
        .cm-reaction-emoji {
            font-size: 18px; cursor: pointer; border: none; background: none;
            padding: 2px 4px; border-radius: 8px;
            transition: transform 0.15s, background 0.1s;
        }
        .cm-reaction-emoji:hover { transform: scale(1.35); background: #f3f4f6; }
        body.dark-mode .cm-reaction-emoji:hover { background: #27272a; }
        .cm-reaction-trigger {
            background: none; border: none; cursor: pointer; font-size: 13px;
            color: #9ca3af; padding: 0 2px; position: relative; display: inline-flex;
            align-items: center; gap: 2px;
        }
        .cm-reaction-trigger:hover { color: #6b7280; }
        .cm-reactions-row {
            display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; padding-left: 40px;
        }
        .cm-reaction-chip {
            display: inline-flex; align-items: center; gap: 3px;
            font-size: 12px; background: #f3f4f6;
            border-radius: 20px; padding: 2px 8px;
            border: 1px solid #e5e7eb; cursor: pointer;
            transition: background 0.15s;
        }
        .cm-reaction-chip.mine { background: #eef2ff; border-color: #c7d2fe; }
        .cm-reaction-chip:hover { background: #e5e7eb; }
        body.dark-mode .cm-reaction-chip { background: #27272a; border-color: #3f3f46; color: #d4d4d8; }
        body.dark-mode .cm-reaction-chip.mine { background: #1e1b4b; border-color: #4f46e5; }

        /* ── Pinned comment banner ── */
        .cm-pinned-banner {
            font-size: 11px; font-weight: 600; color: #f59e0b;
            display: flex; align-items: center; gap: 4px; margin-bottom: 4px;
        }

        /* ── Load-more button ── */
        #load-more-comments {
            display: block; width: 100%; margin-top: 12px;
            padding: 10px; border-radius: 10px;
            border: 1.5px solid #e5e7eb; background: transparent;
            color: #6366f1; font-size: 14px; font-weight: 600;
            cursor: pointer; transition: background 0.15s;
        }
        #load-more-comments:hover { background: #eef2ff; }
        body.dark-mode #load-more-comments { border-color: #27272a; color: #a5b4fc; }
        body.dark-mode #load-more-comments:hover { background: #1e1b4b; }

        /* ── Edit-in-place row ── */
        .cm-edit-row {
            display: flex; gap: 6px; align-items: flex-end; margin-top: 6px;
        }
        .cm-edit-save-btn {
            background: #6366f1; color: #fff; border: none;
            padding: 6px 12px; border-radius: 8px; font-size: 13px;
            font-weight: 600; cursor: pointer; flex-shrink: 0;
            transition: background 0.15s;
        }
        .cm-edit-save-btn:hover { background: #4f46e5; }
        .cm-edit-cancel-btn {
            background: transparent; color: #6b7280;
            border: 1.5px solid #e5e7eb; padding: 6px 10px;
            border-radius: 8px; font-size: 13px; cursor: pointer;
            flex-shrink: 0; transition: background 0.15s;
        }
        .cm-edit-cancel-btn:hover { background: #f3f4f6; }
        body.dark-mode .cm-edit-cancel-btn { border-color: #3f3f46; color: #a1a1aa; }
    `;
    document.head.appendChild(s);
}

// ─── Recursive tree helpers ───────────────────────────────────────────────────

/** Add `newReply` as a child of the reply with id `targetId`. */
function addReplyToTree(replies, targetId, newReply) {
    if (!Array.isArray(replies)) return false;
    for (let i = 0; i < replies.length; i++) {
        if (replies[i].id === targetId) {
            replies[i].replies = replies[i].replies || [];
            replies[i].replies.push(newReply);
            return true;
        }
        if (addReplyToTree(replies[i].replies, targetId, newReply)) return true;
    }
    return false;
}

/** Remove the reply with id `targetId` from the tree. */
function deleteReplyFromTree(replies, targetId) {
    if (!Array.isArray(replies)) return false;
    for (let i = 0; i < replies.length; i++) {
        if (replies[i].id === targetId) { replies.splice(i, 1); return true; }
        if (deleteReplyFromTree(replies[i].replies, targetId)) return true;
    }
    return false;
}

/** Update the text of a reply with id `targetId`. Returns true if found. */
function editReplyInTree(replies, targetId, newText) {
    if (!Array.isArray(replies)) return false;
    for (let i = 0; i < replies.length; i++) {
        if (replies[i].id === targetId) {
            replies[i].text   = newText;
            replies[i].edited = true;
            return true;
        }
        if (editReplyInTree(replies[i].replies, targetId, newText)) return true;
    }
    return false;
}

/** Toggle a reaction on a reply. Returns the mutated reply or null if not found. */
function toggleReactionInTree(replies, targetId, emoji, userEmail) {
    if (!Array.isArray(replies)) return false;
    for (let i = 0; i < replies.length; i++) {
        if (replies[i].id === targetId) {
            replies[i].reactions = replies[i].reactions || {};
            replies[i].reactions[emoji] = replies[i].reactions[emoji] || [];
            const idx = replies[i].reactions[emoji].indexOf(userEmail);
            if (idx > -1) replies[i].reactions[emoji].splice(idx, 1);
            else          replies[i].reactions[emoji].push(userEmail);
            return true;
        }
        if (toggleReactionInTree(replies[i].replies, targetId, emoji, userEmail)) return true;
    }
    return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _safeToast(msg, type = 'info') {
    // Use showToast from templates.js if available, else console
    try { showToast(msg, type); } catch { console.info(`[comments] ${type}: ${msg}`); }
}

function _commentRef(postId, commentId) {
    return doc(db, `posts/${postId}/comments`, commentId);
}

function _buildReplyObj(text) {
    return {
        id:             `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text,
        author:          currentUser.name  || currentUser.email,
        authorEmail:     currentUser.email,
        authorPicture:   currentUser.picture || null,
        timestamp:       Date.now(),
        timestampISO:    new Date().toISOString(),
        likes:           0,
        likedBy:         [],
        reactions:       {},
        replies:         [],
        edited:          false,
    };
}

// ─── Render helpers ───────────────────────────────────────────────────────────

/**
 * Build the reactions summary row for a comment or reply.
 * @param {Object}  reactionsMap  e.g. { '👍': ['a@b.com'], '❤️': ['c@d.com','e@f.com'] }
 * @param {string}  entityId      comment id or reply id
 * @param {boolean} isReply
 */
function _buildReactionsRow(reactionsMap, entityId, isReply = false) {
    if (!reactionsMap) return '';
    const pairs = Object.entries(reactionsMap).filter(([, arr]) => arr.length > 0);
    if (!pairs.length) return '';
    const mine = currentUser?.email;
    return `<div class="cm-reactions-row" data-entity="${entityId}" data-is-reply="${isReply ? '1' : '0'}">
        ${pairs.map(([emoji, arr]) => `
            <button class="cm-reaction-chip${arr.includes(mine) ? ' mine' : ''}"
                    data-emoji="${emoji}" data-entity="${entityId}" data-is-reply="${isReply ? '1' : '0'}"
                    title="${arr.length} reaction${arr.length !== 1 ? 's' : ''}">
                ${emoji} <span>${arr.length}</span>
            </button>
        `).join('')}
    </div>`;
}

/**
 * Render a full comment card with all interactions inline.
 * We don't use createCommentHTML from templates.js here because we need
 * full control over the edit/reaction/like wiring without re-rendering everything.
 */
function renderComment(comment, postId) {
    const isOwn   = currentUser?.email === comment.authorEmail;
    const isAdmin = currentUser?.role === 'admin';
    const canDel  = isOwn || isAdmin;
    const canPin  = isAdmin;
    const likes   = comment.likes   || 0;
    const hasLiked = !!(currentUser && (comment.likedBy || []).includes(currentUser.email));
    const isPinned = !!comment.pinned;

    const avatar = comment.authorPicture
        ? `<img src="${comment.authorPicture}" alt="" class="w-8 h-8 rounded-full object-cover flex-shrink-0" loading="lazy">`
        : `<div class="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-white text-xs font-bold"
                style="background: linear-gradient(135deg, #6366f1, #8b5cf6); user-select:none;">
                ${(comment.author || '?')[0].toUpperCase()}
           </div>`;

    const ts = comment.timestamp
        ? _timeAgo(typeof comment.timestamp === 'number' ? comment.timestamp : new Date(comment.timestamp).getTime())
        : '';

    const reactionsHTML = _buildReactionsRow(comment.reactions, comment.id, false);

    return `
    <div class="group relative bg-white dark:bg-zinc-900 border border-gray-100 dark:border-zinc-800
                rounded-2xl p-4 mb-3 transition-all duration-200 hover:shadow-md hover:border-indigo-100
                dark:hover:border-indigo-900${isPinned ? ' border-l-4 border-l-amber-400' : ''}"
         data-comment-id="${comment.id}">

        ${isPinned ? '<div class="cm-pinned-banner">📌 Pinned comment</div>' : ''}

        <div class="flex justify-between items-start gap-2">
            <div class="flex items-center gap-2.5">
                ${avatar}
                <div>
                    <span class="font-bold text-indigo-600 dark:text-indigo-400 text-sm">${_esc(comment.author)}</span>
                    <span class="text-xs text-gray-400 dark:text-gray-500 ml-1.5"
                          title="${new Date(comment.timestamp || 0).toLocaleString()}">${ts}</span>
                    ${comment.edited ? '<span class="text-xs text-gray-400 ml-1 italic">(edited)</span>' : ''}
                </div>
            </div>
            <div class="flex gap-2 items-center opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                ${isOwn  ? `<button class="edit-comment-btn text-xs text-blue-400 hover:text-blue-600 hover:underline"
                                    data-comment-id="${comment.id}">Edit</button>` : ''}
                ${!isOwn ? `<button class="report-btn text-xs text-orange-400 hover:text-orange-600 hover:underline"
                                    data-content-id="${comment.id}" data-content-type="comment"
                                    data-post-id="${postId}"
                                    data-author-email="${comment.authorEmail || ''}">Report</button>` : ''}
                ${canPin  ? `<button class="pin-comment-btn text-xs text-amber-400 hover:text-amber-600 hover:underline"
                                    data-comment-id="${comment.id}">${isPinned ? 'Unpin' : 'Pin'}</button>` : ''}
                ${canDel  ? `<button class="delete-comment-btn text-xs text-red-400 hover:text-red-600 hover:underline"
                                    data-comment-id="${comment.id}">Delete</button>` : ''}
            </div>
        </div>

        <p class="text-gray-700 dark:text-gray-300 text-sm mt-2.5 leading-relaxed pl-10 comment-text-node"
           id="ctext-${comment.id}">${_esc(comment.text)}</p>

        ${reactionsHTML}

        <div class="mt-3 pl-10 flex items-center gap-3 flex-wrap">
            <button class="like-comment-btn${hasLiked ? ' liked' : ''}"
                    data-comment-id="${comment.id}" aria-label="${hasLiked ? 'Unlike' : 'Like'} comment"
                    aria-pressed="${hasLiked}">
                <svg width="13" height="13" viewBox="0 0 24 24"
                     fill="${hasLiked ? 'currentColor' : 'none'}"
                     stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round"
                          d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/>
                </svg>
                <span class="like-count">${likes > 0 ? likes : ''}</span>
            </button>

            <div style="position:relative;">
                <button class="cm-reaction-trigger" data-comment-id="${comment.id}" aria-label="Add reaction">
                    😊 React
                </button>
                <div class="cm-reaction-picker" id="rpicker-${comment.id}">
                    ${REACTIONS.map(r => `<button class="cm-reaction-emoji"
                        data-emoji="${r}" data-entity="${comment.id}" data-is-reply="0"
                        aria-label="React with ${r}">${r}</button>`).join('')}
                </div>
            </div>

            <button class="reply-comment-btn text-xs font-semibold text-gray-400 hover:text-indigo-600
                           dark:hover:text-indigo-400 transition-colors duration-150 flex items-center gap-1">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                          d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/>
                </svg>
                Reply
            </button>
        </div>

        <div class="reply-form-container" data-for="${comment.id}">
            <textarea class="reply-textarea" rows="2"
                      placeholder="Reply to ${_esc(comment.author)}…"
                      maxlength="${REPLY_MAX}"></textarea>
            <button class="submit-reply-btn">Post</button>
        </div>

        ${renderReplies(comment.replies || [], comment.id, 1, postId)}
    </div>`;
}

/** Render nested replies recursively. */
function renderReplies(replies, parentCommentId, level = 1, postId = '') {
    if (!replies?.length) return '';
    const indent = level < 4 ? 'pl-4 border-l-2 border-gray-100 dark:border-zinc-800' : 'pl-2';
    return `<div class="mt-3 ${indent} space-y-3">` +
        replies.map(reply => {
            const isOwn    = currentUser?.email === reply.authorEmail;
            const isAdmin  = currentUser?.role === 'admin';
            const canDel   = isOwn || isAdmin;
            const hasLiked = !!(currentUser && (reply.likedBy || []).includes(currentUser.email));
            const likes    = reply.likes || 0;
            const ts       = _timeAgo(typeof reply.timestamp === 'number' ? reply.timestamp : new Date(reply.timestamp).getTime());

            const avatar = reply.authorPicture
                ? `<img src="${reply.authorPicture}" alt="" class="w-6 h-6 rounded-full object-cover flex-shrink-0" loading="lazy">`
                : `<div class="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-white font-bold"
                        style="font-size:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);user-select:none;">
                        ${(reply.author || '?')[0].toUpperCase()}
                   </div>`;

            const reactionsHTML = _buildReactionsRow(reply.reactions, reply.id, true);

            return `
            <div class="group relative bg-gray-50 dark:bg-zinc-800/60 rounded-xl p-3 hover:bg-white
                        dark:hover:bg-zinc-800 hover:shadow-sm transition-all duration-200"
                 data-reply-id="${reply.id}" data-parent-comment="${parentCommentId}">
                <div class="flex justify-between items-start gap-2">
                    <div class="flex items-center gap-2">
                        ${avatar}
                        <div>
                            <span class="font-semibold text-indigo-600 dark:text-indigo-400 text-xs">${_esc(reply.author)}</span>
                            <span class="text-xs text-gray-400 ml-1.5">${ts}</span>
                            ${reply.edited ? '<span class="text-xs text-gray-400 ml-1 italic">(edited)</span>' : ''}
                        </div>
                    </div>
                    <div class="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                        ${isOwn  ? `<button class="edit-reply-btn text-xs text-blue-400 hover:text-blue-600 hover:underline"
                                            data-reply-id="${reply.id}" data-parent-comment="${parentCommentId}">Edit</button>` : ''}
                        ${!isOwn ? `<button class="report-btn text-xs text-orange-400 hover:text-orange-600 hover:underline"
                                            data-content-id="${parentCommentId}" data-content-type="reply"
                                            data-reply-id="${reply.id}" data-post-id="${postId}"
                                            data-author-email="${reply.authorEmail || ''}">Report</button>` : ''}
                        ${canDel ? `<button class="delete-reply-btn text-xs text-red-400 hover:text-red-600 hover:underline"
                                            data-reply-id="${reply.id}">Delete</button>` : ''}
                    </div>
                </div>

                <p class="text-sm text-gray-600 dark:text-gray-400 mt-2 leading-relaxed pl-8"
                   id="rtext-${reply.id}">${_esc(reply.text)}</p>

                ${reactionsHTML}

                <div class="mt-2 pl-8 flex items-center gap-3 flex-wrap">
                    <button class="like-reply-btn${hasLiked ? ' liked' : ''}"
                            data-reply-id="${reply.id}" data-parent-comment="${parentCommentId}"
                            aria-label="${hasLiked ? 'Unlike' : 'Like'} reply" aria-pressed="${hasLiked}">
                        <svg width="11" height="11" viewBox="0 0 24 24"
                             fill="${hasLiked ? 'currentColor' : 'none'}"
                             stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round"
                                  d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/>
                        </svg>
                        <span class="like-count">${likes > 0 ? likes : ''}</span>
                    </button>

                    <div style="position:relative;">
                        <button class="cm-reaction-trigger" data-reply-id="${reply.id}" data-parent-comment="${parentCommentId}"
                                aria-label="Add reaction">
                            😊 React
                        </button>
                        <div class="cm-reaction-picker" id="rpicker-${reply.id}">
                            ${REACTIONS.map(r => `<button class="cm-reaction-emoji"
                                data-emoji="${r}" data-entity="${reply.id}" data-is-reply="1"
                                data-parent-comment="${parentCommentId}"
                                aria-label="React with ${r}">${r}</button>`).join('')}
                        </div>
                    </div>

                    <button class="reply-comment-btn text-xs font-semibold text-gray-400 hover:text-indigo-600
                                   dark:hover:text-indigo-400 transition-colors duration-150 flex items-center gap-1">
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                  d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/>
                        </svg>
                        Reply
                    </button>
                </div>

                <div class="reply-form-container" data-for="${reply.id}">
                    <textarea class="reply-textarea" rows="2"
                              placeholder="Reply to ${_esc(reply.author)}…"
                              maxlength="${REPLY_MAX}"></textarea>
                    <button class="submit-reply-btn">Post</button>
                </div>

                ${renderReplies(reply.replies || [], parentCommentId, level + 1, postId)}
            </div>`;
        }).join('') + `</div>`;
}

function _esc(str) {
    if (str === null || str === undefined) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}

function _timeAgo(ms) {
    if (!ms) return '';
    const diff = Date.now() - ms;
    const s  = Math.floor(diff / 1000);
    const m  = Math.floor(s / 60);
    const h  = Math.floor(m / 60);
    const d  = Math.floor(h / 24);
    if (s < 5)  return 'just now';
    if (s < 60) return `${s}s ago`;
    if (m < 60) return `${m}m ago`;
    if (h < 24) return `${h}h ago`;
    if (d < 7)  return `${d}d ago`;
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Edit comment in-place ────────────────────────────────────────────────────

function startEditComment(commentCard, commentId, originalText) {
    const textEl = document.getElementById(`ctext-${commentId}`);
    if (!textEl) return;

    // Prevent double-edit
    if (commentCard.querySelector('.cm-edit-area')) return;

    const origHTML = textEl.outerHTML;
    textEl.style.display = 'none';

    const editRow = document.createElement('div');
    editRow.className = 'cm-edit-row pl-10 mt-2';
    editRow.innerHTML = `
        <textarea class="cm-edit-area" rows="3" maxlength="${COMMENT_MAX}">${_esc(originalText)}</textarea>
        <div style="display:flex;gap:6px;flex-direction:column;">
            <button class="cm-edit-save-btn">Save</button>
            <button class="cm-edit-cancel-btn">Cancel</button>
        </div>
    `;
    textEl.after(editRow);

    const textarea   = editRow.querySelector('.cm-edit-area');
    const saveBtn    = editRow.querySelector('.cm-edit-save-btn');
    const cancelBtn  = editRow.querySelector('.cm-edit-cancel-btn');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    cancelBtn.addEventListener('click', () => {
        editRow.remove();
        textEl.style.display = '';
    });

    saveBtn.addEventListener('click', async () => {
        const newText = textarea.value.trim();
        if (!newText) return _safeToast('Comment cannot be empty.', 'warn');
        if (newText === originalText) { editRow.remove(); textEl.style.display = ''; return; }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
            await updateDoc(_commentRef(currentPostId, commentId), {
                text:     newText,
                edited:   true,
                editedAt: Date.now(),
            });
            textEl.textContent = newText;
            textEl.style.display = '';
            editRow.remove();

            // Show (edited) badge if not already there
            const authorRow = commentCard.querySelector('.flex.items-center.gap-2\\.5');
            if (authorRow && !authorRow.querySelector('.cm-edited-badge')) {
                const badge = document.createElement('span');
                badge.className = 'cm-edited-badge text-xs text-gray-400 ml-1 italic';
                badge.textContent = '(edited)';
                authorRow.querySelector('div').appendChild(badge);
            }
            _safeToast('Comment updated.', 'success');
        } catch (err) {
            console.error('[comments] Edit error:', err);
            _safeToast(`Failed to save: ${err?.message ?? 'Unknown error'}`, 'error');
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
        }
    });
}

// ─── Edit reply in-place ──────────────────────────────────────────────────────

function startEditReply(replyCard, replyId, commentId, originalText) {
    const textEl = document.getElementById(`rtext-${replyId}`);
    if (!textEl) return;
    if (replyCard.querySelector('.cm-edit-area')) return;

    textEl.style.display = 'none';

    const editRow = document.createElement('div');
    editRow.className = 'cm-edit-row pl-8 mt-2';
    editRow.innerHTML = `
        <textarea class="cm-edit-area" rows="2" maxlength="${REPLY_MAX}">${_esc(originalText)}</textarea>
        <div style="display:flex;gap:6px;flex-direction:column;">
            <button class="cm-edit-save-btn">Save</button>
            <button class="cm-edit-cancel-btn">Cancel</button>
        </div>
    `;
    textEl.after(editRow);

    const textarea  = editRow.querySelector('.cm-edit-area');
    const saveBtn   = editRow.querySelector('.cm-edit-save-btn');
    const cancelBtn = editRow.querySelector('.cm-edit-cancel-btn');
    textarea.focus();

    cancelBtn.addEventListener('click', () => {
        editRow.remove();
        textEl.style.display = '';
    });

    saveBtn.addEventListener('click', async () => {
        const newText = textarea.value.trim();
        if (!newText) return _safeToast('Reply cannot be empty.', 'warn');
        if (newText === originalText) { editRow.remove(); textEl.style.display = ''; return; }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
            const commentSnap = await getDoc(_commentRef(currentPostId, commentId));
            if (!commentSnap.exists()) throw new Error('Comment not found');
            const replies = commentSnap.data().replies || [];
            editReplyInTree(replies, replyId, newText);
            await updateDoc(_commentRef(currentPostId, commentId), { replies });

            textEl.textContent = newText;
            textEl.style.display = '';
            editRow.remove();
            _safeToast('Reply updated.', 'success');
        } catch (err) {
            console.error('[comments] Edit reply error:', err);
            _safeToast(`Failed to save: ${err?.message ?? 'Unknown error'}`, 'error');
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
        }
    });
}

// ─── Like helpers ─────────────────────────────────────────────────────────────

async function toggleCommentLike(commentId, btn) {
    if (!currentUser) return _safeToast('Sign in to like.', 'warn');
    const isLiked = btn.classList.contains('liked');
    const counter = btn.querySelector('.like-count');
    const current = parseInt(counter?.textContent || '0', 10) || 0;

    // Optimistic
    btn.classList.toggle('liked', !isLiked);
    btn.setAttribute('aria-pressed', String(!isLiked));
    const svgPath = btn.querySelector('path');
    if (svgPath) {
        btn.querySelector('svg').setAttribute('fill', isLiked ? 'none' : 'currentColor');
    }
    if (counter) counter.textContent = String(isLiked ? Math.max(0, current - 1) : current + 1) || '';

    try {
        await updateDoc(_commentRef(currentPostId, commentId), {
            likes:   isLiked ? Math.max(0, current - 1) : current + 1,
            likedBy: isLiked ? arrayRemove(currentUser.email) : arrayUnion(currentUser.email),
        });
    } catch (err) {
        // Revert
        btn.classList.toggle('liked', isLiked);
        btn.setAttribute('aria-pressed', String(isLiked));
        if (svgPath) btn.querySelector('svg').setAttribute('fill', isLiked ? 'currentColor' : 'none');
        if (counter) counter.textContent = String(current) || '';
        _safeToast('Failed to update like.', 'error');
    }
}

async function toggleReplyLike(replyId, commentId, btn) {
    if (!currentUser) return _safeToast('Sign in to like.', 'warn');
    const isLiked = btn.classList.contains('liked');
    const counter = btn.querySelector('.like-count');
    const current = parseInt(counter?.textContent || '0', 10) || 0;

    // Optimistic
    btn.classList.toggle('liked', !isLiked);
    if (counter) counter.textContent = String(isLiked ? Math.max(0, current - 1) : current + 1) || '';

    try {
        const commentSnap = await getDoc(_commentRef(currentPostId, commentId));
        if (!commentSnap.exists()) throw new Error('Comment not found');
        const replies = commentSnap.data().replies || [];

        // Walk tree to find and update the reply
        const walk = (arr) => {
            for (const r of arr) {
                if (r.id === replyId) {
                    r.likes   = isLiked ? Math.max(0, (r.likes || 0) - 1) : (r.likes || 0) + 1;
                    r.likedBy = r.likedBy || [];
                    if (isLiked) r.likedBy = r.likedBy.filter(e => e !== currentUser.email);
                    else         r.likedBy.push(currentUser.email);
                    return true;
                }
                if (r.replies && walk(r.replies)) return true;
            }
            return false;
        };
        walk(replies);
        await updateDoc(_commentRef(currentPostId, commentId), { replies });
    } catch (err) {
        // Revert
        btn.classList.toggle('liked', isLiked);
        if (counter) counter.textContent = String(current) || '';
        _safeToast('Failed to update like.', 'error');
    }
}

// ─── Reaction helpers ─────────────────────────────────────────────────────────

/** Close all open reaction pickers. */
function closeAllPickers() {
    document.querySelectorAll('.cm-reaction-picker.open').forEach(p => p.classList.remove('open'));
}

async function applyReaction(emoji, entityId, isReply, parentCommentId) {
    if (!currentUser) return _safeToast('Sign in to react.', 'warn');
    closeAllPickers();

    try {
        const commentId = isReply ? parentCommentId : entityId;
        const commentSnap = await getDoc(_commentRef(currentPostId, commentId));
        if (!commentSnap.exists()) throw new Error('Comment not found');

        if (!isReply) {
            // Comment-level reaction
            const field = `reactions.${emoji}`;
            const hasReacted = (commentSnap.data().reactions?.[emoji] || []).includes(currentUser.email);
            await updateDoc(_commentRef(currentPostId, commentId), {
                [field]: hasReacted
                    ? arrayRemove(currentUser.email)
                    : arrayUnion(currentUser.email),
            });
        } else {
            // Reply-level reaction — stored inside the replies array
            const replies = commentSnap.data().replies || [];
            toggleReactionInTree(replies, entityId, emoji, currentUser.email);
            await updateDoc(_commentRef(currentPostId, commentId), { replies });
        }
    } catch (err) {
        console.error('[comments] Reaction error:', err);
        _safeToast('Failed to add reaction.', 'error');
    }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function setupComments() {
    injectCommentStyles();

    const commentsPage        = document.getElementById('page-comments');
    const commentsList        = document.getElementById('comments-page-list');
    const summarizeBtn        = document.getElementById('ai-summarize-btn');
    const summaryOutput       = document.getElementById('ai-summary-output');
    const summaryText         = document.getElementById('ai-summary-text');
    const commentTextarea     = document.querySelector('.comment-textarea');
    const submitCommentBtn    = document.querySelector('.submit-comment-btn');

    // ── Character counter on comment textarea ─────────────────────────────────
    if (commentTextarea) {
        commentTextarea.setAttribute('maxlength', String(COMMENT_MAX));
        const counterEl = document.createElement('div');
        counterEl.className = 'cm-counter';
        counterEl.textContent = `0 / ${COMMENT_MAX}`;
        commentTextarea.after(counterEl);

        commentTextarea.addEventListener('input', () => {
            const len = commentTextarea.value.length;
            counterEl.textContent = `${len} / ${COMMENT_MAX}`;
            counterEl.className = 'cm-counter'
                + (len > COMMENT_MAX * 0.85 ? ' warn' : '')
                + (len >= COMMENT_MAX       ? ' over' : '');
        });

        // Ctrl/Cmd + Enter submits
        commentTextarea.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                submitCommentBtn?.click();
            }
        });
    }

    // ── 1. Open Comments Page ─────────────────────────────────────────────────
    // Expose a global so posts.js can open comments via window.openComments(postId)
    window.openComments = async (postId) => {
        if (!postId) return;
        await _openCommentsPage(postId);
    };

    document.getElementById('posts-feed')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('.view-comments-btn');
        if (!btn) return;

        const postCard = e.target.closest('.post-card');
        const postId   = postCard?.dataset.postId;
        if (!postId) return;
        await _openCommentsPage(postId);
    });

    async function _openCommentsPage(postId) {

        currentPostId = postId;
        commentsPage.dataset.currentPostId = postId;
        commentLimit = PAGE_SIZE;

        if (summarizeBtn) { summarizeBtn.classList.remove('hidden'); summarizeBtn.style.display = 'flex'; }
        if (summaryOutput) summaryOutput.classList.add('hidden');
        if (summaryText)   summaryText.innerHTML = '';

        try {
            const postSnap = await getDoc(doc(db, 'posts', postId));
            if (postSnap.exists()) {
                const postData = { id: postId, ...postSnap.data() };
                document.getElementById('comments-page-post-container').innerHTML =
                    createPostCardHTML(postData, currentUser, true);
                _attachPostCardHandlers(postId, postData);
            }
        } catch (err) {
            console.error('[comments] Failed to load post:', err);
        }

        // Unsubscribe any previous listener
        if (activeCommentsListener) { activeCommentsListener(); activeCommentsListener = null; }

        activeCommentsListener = onSnapshot(
            query(
                collection(db, `posts/${postId}/comments`),
                orderBy('pinned', 'desc'),   // pinned first
                orderBy('timestamp', 'desc'),
                limit(commentLimit)
            ),
            (snapshot) => {
                commentsList.innerHTML = '';

                if (snapshot.empty) {
                    commentsList.innerHTML = '<p class="text-slate-500 dark:text-slate-400 text-center py-8">No comments yet. Be the first!</p>';
                    if (summarizeBtn) { summarizeBtn.style.display = 'none'; summarizeBtn.classList.add('hidden'); }
                    return;
                }

                snapshot.forEach(d => {
                    commentsList.innerHTML += renderComment({ id: d.id, ...d.data() }, postId);
                });

                // Load-more button
                const existingMore = document.getElementById('load-more-comments');
                existingMore?.remove();
                if (snapshot.size >= commentLimit) {
                    const moreBtn = document.createElement('button');
                    moreBtn.id = 'load-more-comments';
                    moreBtn.textContent = 'Load more comments';
                    commentsList.after(moreBtn);
                    moreBtn.addEventListener('click', () => {
                        commentLimit += PAGE_SIZE;
                        if (activeCommentsListener) activeCommentsListener();
                        activeCommentsListener = onSnapshot(
                            query(
                                collection(db, `posts/${postId}/comments`),
                                orderBy('pinned', 'desc'),
                                orderBy('timestamp', 'desc'),
                                limit(commentLimit)
                            ),
                            (snap) => {
                                commentsList.innerHTML = '';
                                snap.forEach(d => commentsList.innerHTML += renderComment({ id: d.id, ...d.data() }, postId));
                                if (snap.size < commentLimit) moreBtn.remove();
                            }
                        );
                    });
                }
            },
            (err) => {
                console.error('[comments] Snapshot error:', err);
                commentsList.innerHTML = '<p class="text-red-500 text-center py-4">Failed to load comments.</p>';
            }
        );

        showPage('page-comments');
    } // end _openCommentsPage

    // ── Post-card interaction handlers for the comments page ─────────────────
    // posts.js only delegates on #posts-feed, so the post card rendered at the
    // top of the comments page needs its own handler here.
    //
    // KEY FIXES vs. previous version:
    //  - The 3-dot button has class "post-options-btn" (not "post-options-trigger")
    //    and the dropdown is toggled by templates.js initPostOptionsDropdowns via
    //    document-level delegation — so we do NOT re-implement dropdown open here.
    //    We only handle the ACTION clicks on items inside the dropdown.
    //  - Upvote uses class "upvote-btn" (not "action-btn--upvote").
    //  - All handlers are attached to document (not container) so they survive
    //    re-renders when comments.js clones the container node.
    //  - Guard with closest('#comments-page-post-container') so we don't steal
    //    events from other parts of the page.

    // One document-level handler, registered once per setupComments() call.
    document.addEventListener('click', async (e) => {
        // Only act when the click is inside the comments-page post container
        const container = document.getElementById('comments-page-post-container');
        if (!container || !container.contains(e.target)) return;

        const postCard = e.target.closest('.post-card');
        // postId comes from the live dataset (re-fetched each call so it's always current)
        const postId   = commentsPage?.dataset.currentPostId;
        if (!postId) return;

        // Close dropdown helper
        const closeDropdown = () =>
            container.querySelectorAll('.post-options-dropdown')
                     .forEach(d => d.classList.add('hidden'));

        // ── Upvote ──────────────────────────────────────────────────────────
        if (e.target.closest('.upvote-btn')) {
            if (!currentUser) return _safeToast('Sign in to upvote.', 'warn');
            const btn     = e.target.closest('.upvote-btn');
            const isVoted = btn.classList.contains('action-btn--active');
            const counter = btn.querySelector('.upvote-count');
            const current = parseInt(counter?.textContent || '0', 10) || 0;

            // Optimistic UI
            btn.classList.toggle('action-btn--active', !isVoted);
            btn.setAttribute('aria-pressed', String(!isVoted));
            const svg = btn.querySelector('svg');
            if (svg) svg.setAttribute('fill', isVoted ? 'none' : 'currentColor');
            if (counter) counter.textContent = String(isVoted ? Math.max(0, current - 1) : current + 1);
            btn.animate(
                [{ transform: 'scale(1)' }, { transform: 'scale(1.25)' }, { transform: 'scale(1)' }],
                { duration: 280, easing: 'ease' }
            );
            try {
                await updateDoc(doc(db, 'posts', postId), {
                    upvotedBy:   isVoted ? arrayRemove(currentUser.email) : arrayUnion(currentUser.email),
                    upvoteCount: isVoted ? Math.max(0, current - 1) : current + 1,
                });
            } catch {
                // Revert on failure
                btn.classList.toggle('action-btn--active', isVoted);
                if (svg) svg.setAttribute('fill', isVoted ? 'currentColor' : 'none');
                if (counter) counter.textContent = String(current);
                _safeToast('Upvote failed. Try again.', 'error');
            }
            return;
        }

        // ── AI Summarize (post-card inline button) ───────────────────────────
        if (e.target.closest('.ai-summarize-btn')) {
            if (!currentUser) return _safeToast('Sign in to use AI features.', 'warn');
            // Delegate to posts.js handler if available, otherwise basic inline summary
            if (typeof window.aiSummarizePost === 'function' && postCard) {
                const snap = await getDoc(doc(db, 'posts', postId));
                if (snap.exists()) window.aiSummarizePost(postCard, { id: postId, ...snap.data() });
            } else {
                _safeToast('AI summary not available here.', 'info');
            }
            return;
        }

        // ── Share ────────────────────────────────────────────────────────────
        if (e.target.closest('.share-btn')) {
            closeDropdown();
            const url = `${location.origin}${location.pathname}?post=${postId}`;
            if (navigator.share) {
                navigator.share({ title: 'Check this post', url }).catch(() => {});
            } else {
                navigator.clipboard.writeText(url).then(() => _safeToast('Link copied!', 'success'));
            }
            return;
        }

        // ── Message author ───────────────────────────────────────────────────
        if (e.target.closest('.message-author-btn')) {
            if (!currentUser) return _safeToast('Sign in to message.', 'warn');
            closeDropdown();
            const btn = e.target.closest('.message-author-btn');
            document.querySelector('a[data-target="page-chat"]')?.click();
            window.startDirectChat?.(btn.dataset.email, btn.dataset.name);
            return;
        }

        // ── Edit post ────────────────────────────────────────────────────────
        if (e.target.closest('.edit-post-btn')) {
            closeDropdown();
            if (!currentUser) return;
            if (typeof window.openEditModal === 'function') {
                window.openEditModal(postId);
            } else {
                _safeToast('Edit is not available here — open the post from the feed.', 'info');
            }
            return;
        }

        // ── Delete post ──────────────────────────────────────────────────────
        if (e.target.closest('.delete-post-btn')) {
            if (!currentUser) return;
            closeDropdown();
            const isAdmin = currentUser.role === 'admin';
            // Fetch post data to verify ownership
            let authorEmail = '';
            try {
                const snap = await getDoc(doc(db, 'posts', postId));
                authorEmail = snap.data()?.authorEmail || '';
            } catch { /* ignore */ }
            if (authorEmail && authorEmail !== currentUser.email && !isAdmin) {
                return _safeToast('You can only delete your own posts.', 'warn');
            }
            if (!confirm('Permanently delete this post? This cannot be undone.')) return;
            const delBtn = e.target.closest('.delete-post-btn');
            delBtn.textContent = 'Deleting…'; delBtn.disabled = true;
            try {
                await deleteDoc(doc(db, 'posts', postId));
                _safeToast('Post deleted.', 'success');
                showPage('page-posts');
            } catch (err) {
                _safeToast(`Delete failed: ${err.message}`, 'error');
                delBtn.textContent = '🗑️ Delete post'; delBtn.disabled = false;
            }
            return;
        }

        // ── Pin post (admin) ─────────────────────────────────────────────────
        if (e.target.closest('.pin-post-btn')) {
            closeDropdown();
            if (currentUser?.role !== 'admin') return _safeToast('Admins only.', 'warn');
            try {
                const snap = await getDoc(doc(db, 'posts', postId));
                const isPinned = !!snap.data()?.pinned;
                await updateDoc(doc(db, 'posts', postId), { pinned: !isPinned });
                _safeToast(isPinned ? 'Post unpinned.' : 'Post pinned.', 'success');
            } catch { _safeToast('Failed to update pin.', 'error'); }
            return;
        }

        // ── Report ───────────────────────────────────────────────────────────
        if (e.target.closest('.report-btn')) {
            e.stopPropagation();
            closeDropdown();
            if (!currentUser) return _safeToast('Sign in to report.', 'warn');
            window.openReportModal?.(postId, 'post', postId, null, '');
            return;
        }
    });

    // Expose _attachPostCardHandlers as a no-op — the document handler above
    // uses commentsPage.dataset.currentPostId dynamically, so no per-call
    // wiring is needed. Kept for call-site compatibility.
    function _attachPostCardHandlers(_postId, _postData) { /* handled globally above */ }

    // ── 2. Submit Main Comment ────────────────────────────────────────────────
    submitCommentBtn?.addEventListener('click', async () => {
        if (!currentUser) return _safeToast('Sign in to comment.', 'warn');
        const postId = commentsPage?.dataset.currentPostId;
        const text   = commentTextarea?.value.trim();
        if (!text || !postId) return;

        submitCommentBtn.disabled    = true;
        submitCommentBtn.textContent = 'Posting…';

        try {
            await addDoc(collection(db, `posts/${postId}/comments`), {
                text,
                author:        currentUser.name  || currentUser.email,
                authorEmail:   currentUser.email,
                authorPicture: currentUser.picture || null,
                timestamp:     Date.now(),
                timestampISO:  new Date().toISOString(),
                likes:         0,
                likedBy:       [],
                reactions:     {},
                replies:       [],
                pinned:        false,
                edited:        false,
            });
            await updateDoc(doc(db, 'posts', postId), { commentCount: increment(1) });
            if (commentTextarea) commentTextarea.value = '';
            // Reset counter
            const counterEl = commentTextarea?.nextElementSibling;
            if (counterEl?.classList.contains('cm-counter')) {
                counterEl.textContent = `0 / ${COMMENT_MAX}`;
                counterEl.className = 'cm-counter';
            }
            _safeToast('Comment posted!', 'success');
        } catch (err) {
            console.error('[comments] Submit error:', err);
            _safeToast(`Failed to post: ${err?.message ?? 'Unknown error'}`, 'error');
        } finally {
            submitCommentBtn.disabled    = false;
            submitCommentBtn.textContent = 'Post';
        }
    });

    // ── 3. Delegated interactions on comments list ────────────────────────────
    commentsList?.addEventListener('click', async (e) => {
        const commentCard = e.target.closest('[data-comment-id]');
        const postId      = commentsPage?.dataset.currentPostId;
        if (!postId) return;

        // ── Close reaction pickers on outside click ──
        if (!e.target.closest('.cm-reaction-picker') && !e.target.closest('.cm-reaction-trigger')) {
            closeAllPickers();
        }

        // ── Reaction emoji button ──
        if (e.target.closest('.cm-reaction-emoji')) {
            const btn      = e.target.closest('.cm-reaction-emoji');
            const emoji    = btn.dataset.emoji;
            const entityId = btn.dataset.entity;
            const isReply  = btn.dataset.isReply === '1';
            const parent   = btn.dataset.parentComment || null;
            await applyReaction(emoji, entityId, isReply, parent);
            return;
        }

        // ── Reaction chip (re-toggle) ──
        if (e.target.closest('.cm-reaction-chip')) {
            const chip     = e.target.closest('.cm-reaction-chip');
            const emoji    = chip.dataset.emoji;
            const entityId = chip.dataset.entity;
            const isReply  = chip.dataset.isReply === '1';
            // Find parent comment id
            const parentCard = chip.closest('[data-comment-id]');
            const parentId   = parentCard?.dataset.commentId || entityId;
            await applyReaction(emoji, entityId, isReply, isReply ? parentId : null);
            return;
        }

        // ── Reaction trigger (open picker) ──
        if (e.target.closest('.cm-reaction-trigger')) {
            const trigger  = e.target.closest('.cm-reaction-trigger');
            const cid      = trigger.dataset.commentId || trigger.dataset.replyId;
            closeAllPickers();
            const picker = document.getElementById(`rpicker-${cid}`);
            picker?.classList.toggle('open');
            return;
        }

        // ── Like comment ──
        if (e.target.closest('.like-comment-btn')) {
            const btn       = e.target.closest('.like-comment-btn');
            const commentId = btn.dataset.commentId;
            await toggleCommentLike(commentId, btn);
            return;
        }

        // ── Like reply ──
        if (e.target.closest('.like-reply-btn')) {
            const btn       = e.target.closest('.like-reply-btn');
            const replyId   = btn.dataset.replyId;
            const commentId = btn.dataset.parentComment;
            if (!commentId) return;
            await toggleReplyLike(replyId, commentId, btn);
            return;
        }

        // ── Edit comment ──
        if (e.target.closest('.edit-comment-btn')) {
            if (!currentUser) return;
            const btn        = e.target.closest('.edit-comment-btn');
            const commentId  = btn.dataset.commentId;
            const card       = commentsList.querySelector(`[data-comment-id="${commentId}"]`);
            const textEl     = document.getElementById(`ctext-${commentId}`);
            if (!card || !textEl) return;
            startEditComment(card, commentId, textEl.textContent.trim());
            return;
        }

        // ── Edit reply ──
        if (e.target.closest('.edit-reply-btn')) {
            if (!currentUser) return;
            const btn       = e.target.closest('.edit-reply-btn');
            const replyId   = btn.dataset.replyId;
            const commentId = btn.dataset.parentComment;
            const replyCard = e.target.closest('[data-reply-id]');
            const textEl    = document.getElementById(`rtext-${replyId}`);
            if (!replyCard || !textEl || !commentId) return;
            startEditReply(replyCard, replyId, commentId, textEl.textContent.trim());
            return;
        }

        // ── Reply toggle ──
        if (e.target.closest('.reply-comment-btn')) {
            const btn         = e.target.closest('.reply-comment-btn');
            // The form is a sibling of the action row's parent — climb to the card element
            const cardEl      = btn.closest('[data-comment-id], [data-reply-id]');
            if (!cardEl) return;
            const form        = cardEl.querySelector('.reply-form-container');
            if (!form) return;

            // Close other open reply forms
            commentsList.querySelectorAll('.reply-form-container.open').forEach(f => {
                if (f !== form) f.classList.remove('open');
            });

            form.classList.toggle('open');
            if (form.classList.contains('open')) {
                form.querySelector('.reply-textarea')?.focus();
            }
            e.stopPropagation();
            return;
        }

        // ── Submit reply ──
        if (e.target.closest('.submit-reply-btn')) {
            if (!currentUser) return _safeToast('Sign in to reply.', 'warn');

            const btn       = e.target.closest('.submit-reply-btn');
            const form      = btn.closest('.reply-form-container');
            const textarea  = form?.querySelector('.reply-textarea');
            const text      = textarea?.value.trim();
            if (!text) { textarea?.focus(); return; }

            // Determine the parent comment and (optionally) parent reply
            const parentReplyCard   = btn.closest('[data-reply-id]');
            const parentCommentCard = btn.closest('[data-comment-id]');
            const commentId         = parentCommentCard?.dataset.commentId;
            if (!commentId) return;

            const commentRef  = _commentRef(postId, commentId);
            btn.disabled      = true;
            btn.textContent   = '…';

            try {
                const newReply       = _buildReplyObj(text);
                const commentSnap    = await getDoc(commentRef);
                if (!commentSnap.exists()) throw new Error('Comment not found');

                const replies = commentSnap.data().replies || [];

                if (parentReplyCard) {
                    // Deep-nested reply
                    addReplyToTree(replies, parentReplyCard.dataset.replyId, newReply);
                } else {
                    // Top-level reply to the comment
                    replies.push(newReply);
                }

                await updateDoc(commentRef, { replies });
                textarea.value = '';
                form.classList.remove('open');
                _safeToast('Reply posted!', 'success');
            } catch (err) {
                console.error('[comments] Reply error:', err);
                _safeToast(`Failed to post reply: ${err?.message ?? 'Unknown error'}`, 'error');
            } finally {
                btn.disabled    = false;
                btn.textContent = 'Post';
            }
            return;
        }

        // ── Delete comment ──
        if (e.target.closest('.delete-comment-btn')) {
            if (!currentUser) return;
            if (!confirm('Delete this comment? This cannot be undone.')) return;
            const btn       = e.target.closest('.delete-comment-btn');
            const commentId = btn.dataset.commentId;
            // Find the card directly by commentId to handle edge cases where
            // commentCard (closest ancestor) might be null
            const card      = commentCard || commentsList.querySelector(`[data-comment-id="${commentId}"]`);
            if (!card) return;
            btn.textContent = 'Deleting…'; btn.disabled = true;
            try {
                await deleteDoc(_commentRef(postId, commentId));
                await updateDoc(doc(db, 'posts', postId), { commentCount: increment(-1) });
                card.style.transition = 'opacity 0.3s, transform 0.3s';
                card.style.opacity    = '0';
                card.style.transform  = 'scale(0.97)';
                setTimeout(() => card.remove(), 320);
                _safeToast('Comment deleted.', 'success');
            } catch (err) {
                console.error('[comments] Delete comment error:', err);
                _safeToast(`Delete failed: ${err?.message ?? 'Unknown error'}`, 'error');
                btn.textContent = 'Delete'; btn.disabled = false;
            }
            return;
        }

        // ── Delete reply ──
        if (e.target.closest('.delete-reply-btn')) {
            if (!currentUser) return;
            if (!confirm('Delete this reply?')) return;
            const btn       = e.target.closest('.delete-reply-btn');
            const replyId   = btn.dataset.replyId;
            const parentId  = commentCard?.dataset.commentId;
            if (!parentId) return;

            btn.textContent = 'Deleting…'; btn.disabled = true;
            try {
                const snap    = await getDoc(_commentRef(postId, parentId));
                const replies = snap.data()?.replies || [];
                deleteReplyFromTree(replies, replyId);
                await updateDoc(_commentRef(postId, parentId), { replies });

                const replyCard = e.target.closest('[data-reply-id]');
                if (replyCard) {
                    replyCard.style.transition = 'opacity 0.3s';
                    replyCard.style.opacity    = '0';
                    setTimeout(() => replyCard.remove(), 320);
                }
                _safeToast('Reply deleted.', 'success');
            } catch (err) {
                console.error('[comments] Delete reply error:', err);
                _safeToast(`Delete failed: ${err?.message ?? 'Unknown error'}`, 'error');
                btn.textContent = 'Delete'; btn.disabled = false;
            }
            return;
        }

        // ── Pin comment (admin only) ──
        if (e.target.closest('.pin-comment-btn')) {
            if (currentUser?.role !== 'admin') return;
            const btn       = e.target.closest('.pin-comment-btn');
            const commentId = btn.dataset.commentId;
            try {
                const snap = await getDoc(_commentRef(postId, commentId));
                if (!snap.exists()) return _safeToast('Comment not found.', 'error');
                const isPinned = !!snap.data().pinned;
                await updateDoc(_commentRef(postId, commentId), { pinned: !isPinned });
                _safeToast(isPinned ? 'Comment unpinned.' : 'Comment pinned.', 'success');
                btn.textContent = isPinned ? 'Pin' : 'Unpin';
            } catch (err) {
                _safeToast('Failed to update pin.', 'error');
            }
            return;
        }
    });

    // ── 4. AI Summariser ──────────────────────────────────────────────────────
    summarizeBtn?.addEventListener('click', async () => {
        const commentNodes  = commentsList?.querySelectorAll('.comment-text-node');
        const commentsArray = Array.from(commentNodes || []).map(n => n.textContent.trim()).filter(Boolean);
        if (!commentsArray.length) {
            _safeToast("No comments to summarize yet.", "warn");
            return;
        }

        summarizeBtn.textContent = '✨ Thinking…';
        summarizeBtn.disabled    = true;

        let summary = null;

        try {
            const response = await fetch(API_URL, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [{
                            text: `Summarize this discussion thread from a college campus app in exactly 2 concise sentences. Here are the comments: ${commentsArray.join(' | ')}`,
                        }],
                    }],
                }),
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData?.error?.message || `HTTP ${response.status}`);
            }

            const data = await response.json();
            summary = data?.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/\n/g, '<br>') || null;
        } catch (err) {
            console.error('[comments] Summariser error:', err);
            _safeToast('AI summary unavailable — showing offline preview.', 'warn');
            // Fallback: first two sentences of the top comment
            const top = commentsArray[0] || '';
            const sentences = top.match(/[^.!?]+[.!?]+/g) || [];
            summary = sentences.length >= 2
                ? `<em class="text-orange-500">Offline summary:</em> ${sentences.slice(0, 2).join(' ')}`
                : `<em class="text-orange-500">Offline summary:</em> ${top.slice(0, 160)}${top.length > 160 ? '…' : ''}`;
        } finally {
            summarizeBtn.textContent = '✨ Summarize with AI';
            summarizeBtn.disabled    = false;
        }

        if (summaryText)  summaryText.innerHTML = summary || 'Nothing to summarise.';
        if (summaryOutput) summaryOutput.classList.remove('hidden');
    });
}