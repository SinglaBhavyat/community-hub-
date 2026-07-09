// ============================================================
// templates.js — Advanced Post Card & Comment UI (v3)
// ============================================================

// All imports must be at the top of an ES module — no mid-file imports allowed.
import { db } from '../config/firebase.js';
import {
    doc as _doc, updateDoc as _updateDoc,
    arrayUnion as _arrayUnion, arrayRemove as _arrayRemove,
    collection, addDoc, serverTimestamp as _serverTimestamp,
    getDocs, query, where,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { currentUser } from '../store/db.js';

// Aliases kept for backward-compat within this file
const _db          = db;
// getCurrentUser() is intentionally not aliased here — currentUser is a live module
// export that is mutated by auth.js after login. Always call getCurrentUser() to
// get the live value rather than caching it at import time.
function getCurrentUser() { return currentUser; }

export const sanitize = (str) => {
    if (str === null || str === undefined) return '';
    const temp = document.createElement('div');
    temp.textContent = String(str);
    return temp.innerHTML;
};

// ---- Time formatting with live refresh support ----
export function timeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const s  = Math.floor(diff / 1000);
    const m  = Math.floor(s / 60);
    const h  = Math.floor(m / 60);
    const d  = Math.floor(h / 24);
    const w  = Math.floor(d / 7);
    if (s < 5)   return 'just now';
    if (s < 60)  return `${s}s ago`;
    if (m < 60)  return `${m}m ago`;
    if (h < 24)  return `${h}h ago`;
    if (d < 7)   return `${d}d ago`;
    if (w < 4)   return `${w}w ago`;
    return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---- Reading time estimator ----
function readingTime(content = '') {
    const words = content.trim().split(/\s+/).length;
    const mins  = Math.max(1, Math.ceil(words / 200));
    return `${mins} min read`;
}

// ---- Category badge ----
const CATEGORY_META = {
    'General':      { cls: 'bg-slate-100 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300',       icon: '💬' },
    'Need Advice':  { cls: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',   icon: '🤔' },
    'Discussion':   { cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',           icon: '🗣️' },
    'Recruitment':  { cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300', icon: '💼' },
    'Achievements': { cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',       icon: '🏆' },
    'Assisting':    { cls: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',           icon: '🤝' },
    'Advertisement':{ cls: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',           icon: '📢' },
};

function categoryBadge(cat) {
    if (!cat) return '';
    const meta = CATEGORY_META[cat] || { cls: 'bg-gray-100 text-gray-600', icon: '•' };
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${meta.cls}">
        <span class="leading-none">${meta.icon}</span>${sanitize(cat)}
    </span>`;
}

function communityBadge(community) {
    if (!community || community === 'Global') return '';
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
        <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM4.332 8.027a6.012 6.012 0 011.912-2.706C6.512 5.73 6.974 6 7.5 6A1.5 1.5 0 019 7.5V8a2 2 0 004 0 2 2 0 011.523-1.943A5.977 5.977 0 0116 10c0 .34-.028.675-.083 1H15a2 2 0 00-2 2v2.197A5.973 5.973 0 0110 16v-2a2 2 0 00-2-2 2 2 0 01-2-2 2 2 0 00-1.668-1.973z" clip-rule="evenodd"/></svg>
        ${sanitize(community)}
    </span>`;
}

// ---- Hashtag & mention rendering ----
function renderHashtags(content) {
    return sanitize(content)
        .replace(/#(\w+)/g,
            '<a class="text-indigo-500 font-medium cursor-pointer hover:text-indigo-700 hover:underline transition-colors duration-150 hashtag-link" data-tag="$1">#$1</a>'
        )
        .replace(/@(\w+)/g,
            '<span class="text-blue-500 font-medium cursor-pointer hover:underline mention-link" data-mention="$1">@$1</span>'
        );
}

// ---- Avatar ----
function initialsAvatar(name, size = 8, picture = null) {
    if (picture) {
        return `<img src="${sanitize(picture)}" alt="${sanitize(name)}" class="w-${size} h-${size} rounded-full object-cover flex-shrink-0 ring-2 ring-white dark:ring-zinc-800 shadow-sm">`;
    }
    const initials = (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    // Deterministic color from name
    const hue = [...(name || 'X')].reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
    return `<div class="w-${size} h-${size} rounded-full flex items-center justify-center text-white font-bold flex-shrink-0 ring-2 ring-white dark:ring-zinc-800 shadow-sm select-none"
                 style="background: linear-gradient(135deg, hsl(${hue},65%,55%), hsl(${(hue+40)%360},70%,45%)); font-size:${size <= 7 ? '0.6rem' : '0.75rem'}">
        ${initials}
    </div>`;
}

// ---- Skeleton ----
export function createSkeletonCard() {
    return `
    <div class="post-card animate-pulse" aria-hidden="true">
        <div class="flex items-center gap-3 mb-4">
            <div class="w-10 h-10 rounded-full skeleton"></div>
            <div class="flex-1 space-y-2">
                <div class="h-3 skeleton rounded-full w-36"></div>
                <div class="h-2 skeleton rounded-full w-24"></div>
            </div>
            <div class="h-6 skeleton rounded-full w-14"></div>
        </div>
        <div class="h-5 skeleton rounded-full w-3/4 mb-3"></div>
        <div class="h-3 skeleton rounded-full w-full mb-2"></div>
        <div class="h-3 skeleton rounded-full w-5/6 mb-2"></div>
        <div class="h-3 skeleton rounded-full w-4/6 mb-5"></div>
        <div class="h-px skeleton rounded mb-4"></div>
        <div class="flex gap-2">
            <div class="h-8 skeleton rounded-full w-16"></div>
            <div class="h-8 skeleton rounded-full w-16"></div>
            <div class="h-8 skeleton rounded-full w-16"></div>
        </div>
    </div>`;
}

// ---- Reaction counts helper ----
function reactionDisplay(reactions = {}) {
    if (!reactions || typeof reactions !== 'object') return '';
    const pairs = Object.entries(reactions).filter(([, v]) => v > 0);
    if (!pairs.length) return '';
    return pairs.slice(0, 3).map(([emoji, count]) =>
        `<span class="inline-flex items-center gap-0.5 text-xs text-gray-500">${emoji} ${count}</span>`
    ).join('');
}

// ============================================================
//  MAIN POST CARD
// ============================================================
export function createPostCardHTML(post, currentUser, isDetailed = false) {
    const isOwn     = !!(currentUser && post.authorEmail === currentUser.email);
    const isAdmin   = !!(currentUser && currentUser.role === 'admin');
    const canDelete = isOwn || isAdmin;
    const canPin    = isAdmin;

    // BUG-FIX-UPVOTE-COUNT: use upvoteCount (atomic server counter) for display,
    // falling back to upvotedBy.length only if upvoteCount isn't written yet.
    // upvotedBy.length diverges when concurrent writes update the counter atomically
    // but the array snapshot lags, or when older posts never had upvoteCount set.
    const upvotes     = (typeof post.upvoteCount === 'number') ? post.upvoteCount : (Array.isArray(post.upvotedBy) ? post.upvotedBy.length : 0);
    const hasVoted    = !!(currentUser && post.upvotedBy?.includes(currentUser.email));
    const isBookmarked= !!(currentUser && currentUser.savedPosts?.includes(post.id));
    const totalComments = typeof post.commentCount === 'number' ? post.commentCount : 0;
    const isPinned    = !!post.pinned;
    const isVerified  = !!post.authorVerified;
    const views       = post.viewCount || 0;

    // ---- Type badge ----
    const TYPE_CONFIG = {
        event: {
            badge: `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>Event
            </span>`,
        },
        study: {
            badge: `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>Study
            </span>`,
        },
        'lost-found': {
            badge: `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300">
                🔍 Lost & Found
            </span>`,
        },
    };
    const typeBadge = TYPE_CONFIG[post.type]?.badge || '';

    // ---- Pinned banner ----
    const pinnedBanner = isPinned ? `
        <div class="flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400 mb-3 -mt-1">
            <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path d="M5.5 2a1.5 1.5 0 000 3h.75v4.75L3.8 13H16.2l-2.45-3.25V5h.75a1.5 1.5 0 000-3h-9zM9 15a1 1 0 102 0H9z"/></svg>
            Pinned post
        </div>` : '';

    // ---- Study group block ----
    let studyGroupHTML = '';
    if (post.type === 'study') {
        const isMember   = post.studyMembers?.includes(currentUser?.email);
        const memberCount= post.studyMembers?.length || 0;
        const capacity   = post.capacity || null;
        const isFull     = capacity && memberCount >= capacity;

        studyGroupHTML = `
        <div class="mt-4 rounded-2xl border overflow-hidden transition-all duration-300"
             style="background: rgba(99,102,241,0.05); border-color: rgba(99,102,241,0.18);">
            <div class="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div class="space-y-2">
                    <p class="font-semibold text-indigo-600 dark:text-indigo-400 text-sm flex items-center gap-1.5">
                        <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>
                        ${sanitize(post.course)}
                    </p>
                    <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                        <span class="flex items-center gap-1">📅 ${sanitize(post.eventDate)} · ${sanitize(post.eventTime)}</span>
                        <span class="flex items-center gap-1">📍 ${sanitize(post.eventLocation)}</span>
                        <span class="flex items-center gap-1">👥 ${memberCount}${capacity ? `/${capacity}` : ''} member${memberCount !== 1 ? 's' : ''}</span>
                    </div>
                    ${capacity ? `
                    <div class="w-full bg-gray-200 dark:bg-zinc-700 rounded-full h-1.5 mt-1">
                        <div class="h-1.5 rounded-full transition-all duration-500 ${isFull ? 'bg-red-400' : 'bg-indigo-500'}"
                             style="width:${Math.min(100, Math.round(memberCount/capacity*100))}%"></div>
                    </div>` : ''}
                </div>
                <button class="join-study-btn flex-shrink-0 px-5 py-2 rounded-full text-sm font-semibold transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-1 ${
                    isMember ? 'bg-indigo-500 text-white cursor-default' :
                    isFull   ? 'bg-gray-200 text-gray-400 cursor-not-allowed dark:bg-zinc-700 dark:text-zinc-500' :
                               'bg-white border border-indigo-300 text-indigo-600 hover:bg-indigo-500 hover:text-white hover:border-transparent hover:shadow-lg dark:bg-zinc-800 dark:border-indigo-700 dark:text-indigo-400 dark:hover:bg-indigo-600 dark:hover:text-white'
                }" ${(isMember || isFull) ? 'disabled' : ''}>
                    ${isMember ? '✓ Joined' : isFull ? 'Full' : 'Join Group'}
                </button>
            </div>
        </div>`;
    }

    // ---- Poll block ----
    let pollHTML = '';
    if (post.poll && Array.isArray(post.poll.options)) {
        const totalVotes = post.poll.options.reduce((acc, opt) => acc + (opt.votes?.length || 0), 0);
        const userVoted  = !!(currentUser && post.poll.options.some(opt => opt.votes?.includes(currentUser.email)));
        const pollEnded  = post.poll.endsAt && Date.now() > post.poll.endsAt;
        const question   = post.poll.question ? `<p class="font-semibold text-gray-800 dark:text-gray-200 text-sm mb-3">${sanitize(post.poll.question)}</p>` : '';

        pollHTML = `
        <div class="mt-4 p-4 rounded-2xl border border-gray-200 dark:border-zinc-700 space-y-2 bg-gray-50 dark:bg-zinc-800/50">
            <div class="flex items-center justify-between mb-1">
                <p class="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
                    ${pollEnded ? '🔒 Closed' : '📊 Poll'} · ${totalVotes} vote${totalVotes !== 1 ? 's' : ''}
                </p>
                ${post.poll.endsAt && !pollEnded ? `<p class="text-xs text-gray-400 dark:text-gray-500">Ends ${new Date(post.poll.endsAt).toLocaleDateString(undefined, { month:'short', day:'numeric' })}</p>` : ''}
            </div>
            ${question}
            ${post.poll.options.map((opt, i) => {
                const pct      = totalVotes > 0 ? Math.round((opt.votes?.length || 0) / totalVotes * 100) : 0;
                const isChosen = !!(currentUser && opt.votes?.includes(currentUser.email));
                if (userVoted || pollEnded) {
                    return `
                    <div class="relative rounded-xl overflow-hidden h-11 cursor-default" title="${opt.votes?.length || 0} vote${opt.votes?.length !== 1 ? 's' : ''}">
                        <div class="absolute inset-0 rounded-xl transition-all duration-700 ease-out ${isChosen ? 'bg-indigo-500' : 'bg-gray-200 dark:bg-zinc-700'}" style="width:${pct}%;min-width:${pct > 0 ? '2rem' : '0'}"></div>
                        <div class="relative flex justify-between items-center h-full px-3">
                            <span class="text-sm font-medium truncate mr-2 ${isChosen ? 'text-white' : 'text-gray-700 dark:text-gray-300'}">${sanitize(opt.text)}${isChosen ? ' ✓' : ''}</span>
                            <span class="text-xs font-bold flex-shrink-0 ${isChosen ? 'text-white' : 'text-gray-500 dark:text-gray-400'}">${pct}%</span>
                        </div>
                    </div>`;
                }
                return `
                <button data-poll-index="${i}"
                        class="poll-vote-btn w-full text-left h-11 px-4 rounded-xl text-sm font-medium border border-gray-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-gray-700 dark:text-gray-300 hover:border-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 hover:text-indigo-700 dark:hover:text-indigo-400 transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-indigo-400">
                    ${sanitize(opt.text)}
                </button>`;
            }).join('')}
        </div>`;
    }

    // ---- Event block ----
    let eventHTML = '';
    if (post.type === 'event') {
        const going    = post.attendance?.going?.length    || 0;
        const maybe    = post.attendance?.maybe?.length   || 0;
        const notGoing = post.attendance?.notGoing?.length || 0;
        const isGoing  = !!(post.attendance?.going?.includes(currentUser?.email));
        const isMaybe  = !!(post.attendance?.maybe?.includes(currentUser?.email));
        const isNotGoing = !!(post.attendance?.notGoing?.includes(currentUser?.email));
        const total    = going + maybe + notGoing;

        eventHTML = `
        <div class="mt-4 rounded-2xl border overflow-hidden transition-all duration-300"
             style="background: rgba(249,115,22,0.04); border-color: rgba(249,115,22,0.2);">
            <div class="px-4 pt-3 pb-2">
                <div class="flex flex-wrap gap-x-5 gap-y-1 text-sm mb-3">
                    <span class="flex items-center gap-1.5 text-orange-600 dark:text-orange-400 font-semibold">
                        📅 ${sanitize(post.eventDate)} · ${sanitize(post.eventTime)}
                    </span>
                    <span class="flex items-center gap-1.5 text-gray-500 dark:text-gray-400">
                        📍 ${sanitize(post.eventLocation)}
                    </span>
                </div>
                ${total > 0 ? `
                <div class="flex items-center gap-1 mb-3 text-xs text-gray-400 dark:text-gray-500">
                    <span class="font-semibold text-emerald-600 dark:text-emerald-400"><span class="rsvp-going-count">${going}</span> going</span>
                    <span>·</span>
                    <span><span class="rsvp-maybe-count">${maybe}</span> maybe</span>
                    <span>·</span>
                    <span><span class="rsvp-not-going-count">${notGoing}</span> not going</span>
                </div>` : `
                <div class="flex items-center gap-1 mb-3 text-xs text-gray-400 dark:text-gray-500">
                    <span class="font-semibold text-emerald-600 dark:text-emerald-400"><span class="rsvp-going-count">0</span> going</span>
                    <span>·</span>
                    <span><span class="rsvp-maybe-count">0</span> maybe</span>
                    <span>·</span>
                    <span><span class="rsvp-not-going-count">0</span> not going</span>
                </div>`}
                <div class="flex gap-2">
                    <button class="rsvp-btn rsvp-going flex-1 py-2 rounded-xl text-sm font-semibold border transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-emerald-400 ${isGoing
                        ? 'bg-emerald-500 text-white border-emerald-500 shadow-md rsvp-active'
                        : 'border-gray-300 dark:border-zinc-600 text-gray-600 dark:text-gray-400 hover:border-emerald-400 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 bg-white dark:bg-zinc-800'}">
                        ✓ Going
                    </button>
                    <button class="rsvp-btn rsvp-maybe flex-1 py-2 rounded-xl text-sm font-semibold border transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-amber-400 ${isMaybe
                        ? 'bg-amber-400 text-white border-amber-400 shadow-md rsvp-active'
                        : 'border-gray-300 dark:border-zinc-600 text-gray-600 dark:text-gray-400 hover:border-amber-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 bg-white dark:bg-zinc-800'}">
                        ? Maybe
                    </button>
                    <button class="rsvp-btn rsvp-not-going flex-1 py-2 rounded-xl text-sm font-semibold border transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-red-400 ${isNotGoing
                        ? 'bg-red-400 text-white border-red-400 shadow-md rsvp-active'
                        : 'border-gray-300 dark:border-zinc-600 text-gray-600 dark:text-gray-400 hover:border-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 bg-white dark:bg-zinc-800'}">
                        ✕ Not Going
                    </button>
                </div>
            </div>
        </div>`;
    }

    // ---- Lost & Found block ----
    let lostFoundHTML = '';
    if (post.type === 'lost-found') {
        const resolved = !!post.resolved;
        lostFoundHTML = `
        <div class="mt-3 flex items-center gap-2">
            <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${resolved
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'}">
                ${resolved ? '✓ Resolved' : '🔍 Active'}
            </span>
            ${post.itemCategory ? `<span class="text-xs text-gray-400 dark:text-gray-500">• ${sanitize(post.itemCategory)}</span>` : ''}
            ${isOwn && !resolved ? `<button class="mark-resolved-btn text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:underline ml-auto transition-colors">Mark Resolved</button>` : ''}
        </div>`;
    }

    // ---- Media (carousel + video player, matching posts.js logic) ----
    const mediaItems = post.mediaItems?.length
        ? post.mediaItems
        : (post.imageSrc ? [{ url: post.imageSrc, type: 'image' }] : []);

    let imageHTML = '';
    if (mediaItems.length === 1 && mediaItems[0].type === 'image') {
        // Single image — open native full-screen via lightbox stored on element
        const escapedUrl = sanitize(mediaItems[0].url);
        imageHTML = `
        <div class="mt-4 rounded-2xl overflow-hidden border border-gray-200 dark:border-zinc-700 cursor-zoom-in group
                    post-single-image-wrap"
             role="img" aria-label="Post image"
             data-img-src="${escapedUrl}">
            <img src="${escapedUrl}" alt="Post image" loading="lazy"
                 class="w-full object-cover max-h-96 transition-all duration-500 ease-in-out hover:brightness-95">
        </div>`;
    } else if (mediaItems.length === 1 && mediaItems[0].type === 'video') {
        // Single video — full player
        imageHTML = `
        <div class="mt-4 rounded-2xl overflow-hidden border border-gray-200 dark:border-zinc-700">
            <div class="vid-wrapper" style="height:300px;">
                <video src="${sanitize(mediaItems[0].url)}" preload="metadata" playsinline muted
                       style="width:100%;height:100%;object-fit:cover;display:block;"></video>
            </div>
        </div>`;
    } else if (mediaItems.length > 1) {
        // Multi-media carousel
        const carId = 'car-' + post.id;
        const count  = mediaItems.length;
        const slides = mediaItems.map((m, i) => {
            if (m.type === 'video') {
                return `<div class="carousel-slide" data-index="${i}">
                    <div class="vid-wrapper">
                        <video src="${sanitize(m.url)}" preload="metadata" playsinline muted
                               style="width:100%;height:100%;object-fit:cover;display:block;"></video>
                    </div>
                </div>`;
            }
            return `<div class="carousel-slide media-cell--image" data-index="${i}"
                         data-media-items='${JSON.stringify(mediaItems)}' data-media-index="${i}"
                         style="cursor:zoom-in;">
                <img src="${sanitize(m.url)}" alt="Media ${i + 1}" loading="lazy"
                     style="width:100%;height:100%;object-fit:cover;display:block;" />
            </div>`;
        }).join('');
        const dots = count > 1
            ? `<div class="carousel-dots">${mediaItems.map((_, i) =>
                `<span class="carousel-dot ${i === 0 ? 'carousel-dot--active' : ''}" data-dot="${i}"></span>`
              ).join('')}</div>` : '';
        imageHTML = `
        <div class="post-carousel mt-4" id="${carId}" data-current="0" data-count="${count}"
             data-post-id="${post.id}">
            <div class="carousel-track">${slides}</div>
            ${count > 1 ? `
                <button class="carousel-arrow carousel-prev" aria-label="Previous">‹</button>
                <button class="carousel-arrow carousel-next" aria-label="Next">›</button>
                <span class="carousel-counter">1 / ${count}</span>` : ''}
            ${dots}
        </div>`;
    }

    // ---- Tags ----
    const tagsHTML = post.tags?.length
        ? `<div class="flex flex-wrap gap-1.5 mt-3">
            ${post.tags.map(t => `<a class="text-indigo-500 dark:text-indigo-400 text-xs font-medium cursor-pointer hover:text-indigo-700 dark:hover:text-indigo-300 hover:underline hashtag-link" data-tag="${sanitize(t)}">#${sanitize(t)}</a>`).join('')}
          </div>`
        : '';

    // ---- Options dropdown ----
    // Items are injected DYNAMICALLY when the dropdown opens (in initPostOptionsDropdowns)
    // so they always reflect the current auth state, not the state at render time.
    const authorOptions = `
        <div class="relative ml-auto flex-shrink-0">
            <button class="post-options-btn p-1.5 rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-700 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-gray-300"
                    aria-label="Post options" aria-haspopup="true">
                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z"/>
                </svg>
            </button>
            <div class="post-options-dropdown hidden absolute right-0 mt-1.5 w-48 bg-white dark:bg-zinc-800 rounded-2xl shadow-xl border border-gray-100 dark:border-zinc-700 z-30 py-1.5 overflow-hidden"
                 data-post-id="${post.id}"
                 data-author-email="${sanitize(post.authorEmail)}"
                 data-author-name="${sanitize(post.author || '')}"
                 data-pinned="${isPinned ? '1' : '0'}">
                <!-- items injected dynamically on open -->
            </div>
        </div>`;

    // ---- Action bar ----
    const actionBar = `
    <div class="flex items-center justify-between mt-5 pt-4 border-t border-gray-100 dark:border-zinc-800">
        <div class="flex items-center gap-0.5">
            <button class="upvote-btn group/up flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-indigo-300
                ${hasVoted
                    ? 'bg-indigo-50 text-indigo-600 border border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400 dark:border-indigo-800'
                    : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-zinc-800 border border-transparent'}"
                    aria-label="${hasVoted ? 'Remove upvote' : 'Upvote'}" aria-pressed="${hasVoted}">
                <svg class="w-4 h-4 transition-transform duration-200 ${hasVoted ? 'scale-110' : 'group-hover/up:-translate-y-0.5'}"
                     fill="${hasVoted ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"/>
                </svg>
                <span class="upvote-count tabular-nums">${upvotes}</span>
            </button>

            ${!isDetailed ? `
            <button class="view-comments-btn group/cm flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-zinc-800 border border-transparent transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-gray-300"
                    aria-label="${totalComments} comments">
                <svg class="w-4 h-4 transition-transform duration-200 group-hover/cm:scale-110" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
                </svg>
                <span class="tabular-nums">${totalComments}</span>
            </button>` : ''}

            <button class="ai-summarize-btn group/ai flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-gray-500 dark:text-gray-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 hover:text-purple-600 dark:hover:text-purple-400 border border-transparent transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-purple-300"
                    data-post-id="${post.id}" title="AI Summary" aria-label="Generate AI summary">
                <svg class="w-4 h-4 transition-all duration-200 group-hover/ai:scale-110" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
                </svg>
                <span class="ai-btn-label hidden sm:inline">AI</span>
            </button>

            ${views > 0 ? `
            <span class="hidden sm:flex items-center gap-1 px-2 py-1 text-xs text-gray-400 dark:text-gray-500" title="${views} views">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                ${views >= 1000 ? `${(views/1000).toFixed(1)}k` : views}
            </span>` : ''}
        </div>

        <div class="flex items-center gap-1">
            <span class="hidden sm:inline text-xs text-gray-400 dark:text-gray-500 mr-1">${readingTime(post.content)}</span>
            <button class="bookmark-btn p-2 rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-amber-300 ${isBookmarked
                ? 'text-amber-500 bg-amber-50 dark:bg-amber-900/20'
                : 'text-gray-400 dark:text-gray-500 hover:text-amber-500 dark:hover:text-amber-400 hover:bg-gray-100 dark:hover:bg-zinc-800'}"
                    data-post-id="${post.id}" title="${isBookmarked ? 'Remove bookmark' : 'Bookmark'}" aria-label="${isBookmarked ? 'Remove bookmark' : 'Bookmark post'}" aria-pressed="${isBookmarked}">
                <svg class="w-4 h-4" fill="${isBookmarked ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-5-7 5V5z"/>
                </svg>
            </button>
            <button class="share-btn p-2 rounded-xl text-gray-400 dark:text-gray-500 hover:text-indigo-500 dark:hover:text-indigo-400 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                    data-post-id="${post.id}" title="Share" aria-label="Share post">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/>
                </svg>
            </button>
        </div>
    </div>`;

    return `
    <article class="post-card group relative" data-post-id="${post.id}"
             style="animation: cardEntrance 0.35s cubic-bezier(0.25,0.46,0.45,0.94) both"
             aria-label="Post by ${sanitize(post.author)}">
        ${pinnedBanner}

        <!-- Author row -->
        <div class="flex items-start gap-3 mb-3">
            <button class="view-user-profile-btn flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-indigo-400 rounded-full" data-user-email="${sanitize(post.authorEmail)}" aria-label="View ${sanitize(post.author)}'s profile">
                ${initialsAvatar(post.author, 10, post.authorPicture)}
            </button>
            <div class="flex-1 min-w-0">
                <div class="flex flex-wrap items-center gap-1.5">
                    <button class="view-user-profile-btn font-bold text-gray-900 dark:text-gray-100 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors duration-150 text-sm focus:outline-none" data-user-email="${sanitize(post.authorEmail)}">
                        ${sanitize(post.author)}
                    </button>
                    ${isVerified ? `<svg class="w-3.5 h-3.5 text-blue-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>` : ''}
                    ${typeBadge}
                    ${categoryBadge(post.category)}
                    ${communityBadge(post.community)}
                </div>
                <p class="text-xs text-gray-400 dark:text-gray-500 mt-0.5" title="${new Date(post.timestamp).toLocaleString()}">${timeAgo(post.timestamp)}</p>
            </div>
            ${authorOptions}
        </div>

        <!-- Title & Content -->
        ${post.title ? `<h3 class="text-base font-bold text-gray-900 dark:text-gray-100 mb-2 leading-snug">${sanitize(post.title)}</h3>` : ''}
        <div class="text-gray-600 dark:text-gray-400 text-sm leading-relaxed whitespace-pre-wrap post-content">${renderHashtags(post.content)}</div>

        ${tagsHTML}
        ${studyGroupHTML}
        ${pollHTML}
        ${eventHTML}
        ${lostFoundHTML}
        ${imageHTML}

        <div class="ai-summary-container hidden mt-4 rounded-2xl border overflow-hidden"
             style="background: linear-gradient(135deg, rgba(139,92,246,0.06) 0%, rgba(59,130,246,0.06) 100%); border-color: rgba(139,92,246,0.18);">
            <div class="px-4 py-3">
                <div class="flex items-center gap-2 mb-2">
                    <div class="w-5 h-5 rounded-lg bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center flex-shrink-0 shadow-sm">
                        <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
                    </div>
                    <span class="text-xs font-bold text-purple-600 dark:text-purple-400 uppercase tracking-widest">AI Summary</span>
                </div>
                <p class="ai-summary-text text-sm text-gray-600 dark:text-gray-400 leading-relaxed"></p>
            </div>
        </div>

        ${actionBar}
    </article>`;
}

// ============================================================
//  AI SUMMARIZE
// ============================================================
const GEMINI_API_KEY = 'AQ.Ab8RN6KFuYw_tfXqVS-QU05FFeChuogxdIU11OiffxsXhz_a9w';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent`;

async function geminiSummarize(prompt) {
    const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 120, temperature: 0.4 },
        }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

function localSummary(post) {
    const raw = (post.content || '').trim();
    const sentences = raw.match(/[^.!?\n]+[.!?]+/g) || [];
    if (sentences.length >= 2) return sentences.slice(0, 2).join(' ').trim();
    if (raw.length > 20) return raw.slice(0, 220).trim() + (raw.length > 220 ? '…' : '');
    return null;
}

export async function handleAiSummarize(postCard, post) {
    const btn       = postCard.querySelector('.ai-summarize-btn');
    const container = postCard.querySelector('.ai-summary-container');
    const textEl    = postCard.querySelector('.ai-summary-text');
    if (!btn || !container || !textEl) return;

    if (!container.classList.contains('hidden')) {
        container.classList.add('hidden');
        btn.classList.remove('text-purple-600', 'bg-purple-50', 'dark:text-purple-400', 'dark:bg-purple-900/20');
        return;
    }

    container.classList.remove('hidden');
    btn.classList.add('text-purple-600', 'bg-purple-50', 'dark:text-purple-400', 'dark:bg-purple-900/20');
    textEl.innerHTML = `
        <span class="inline-flex items-center gap-2 text-purple-400 dark:text-purple-500">
            <span class="flex gap-1">
                <span class="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce"></span>
                <span class="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce" style="animation-delay:.15s"></span>
                <span class="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce" style="animation-delay:.3s"></span>
            </span>
            <span class="text-xs">Summarizing…</span>
        </span>`;

    const prompt = `Summarize this campus community post in 2–3 concise, neutral sentences.\n\nTitle: "${post.title || '(untitled)'}".\nContent: "${(post.content || '').slice(0, 1500)}".\nType: ${post.type || 'general'}. Community: ${post.community || 'Global'}.`;

    let summary = null;
    try {
        summary = await geminiSummarize(prompt);
    } catch (e) { console.warn('Gemini summarize failed, using local.', e.message); }

    if (!summary) summary = localSummary(post);

    if (summary) {
        textEl.style.opacity = '0';
        setTimeout(() => {
            textEl.textContent = summary;
            textEl.style.transition = 'opacity 0.35s ease';
            textEl.style.opacity = '1';
        }, 120);
    } else {
        textEl.innerHTML = `<span class="text-gray-400 text-xs italic">No summary available.</span>`;
    }
}

// ============================================================
//  SHARE
// ============================================================
export function handleShare(postId) {
    const url = `${location.origin}${location.pathname}?post=${postId}`;
    if (navigator.share) {
        navigator.share({ url }).catch(() => {});
    } else if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => showToast('🔗 Link copied!'));
    }
}

export function showToast(message, type = 'default', duration = 2400) {
    const colours = {
        default: 'bg-gray-900 text-white',
        success: 'bg-emerald-600 text-white',
        error:   'bg-red-600 text-white',
        warning: 'bg-amber-500 text-white',
    };
    const el = document.createElement('div');
    el.textContent = message;
    el.className = `fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] px-5 py-2.5 rounded-full text-sm font-semibold shadow-xl ${colours[type] || colours.default} pointer-events-none`;
    el.style.cssText = 'animation: toastIn 0.3s cubic-bezier(0.34,1.56,0.64,1) both';
    document.body.appendChild(el);
    setTimeout(() => {
        el.style.animation = 'toastOut 0.25s ease forwards';
        setTimeout(() => el.remove(), 280);
    }, duration);
}

// ============================================================
//  POST OPTIONS DROPDOWN
// ============================================================
export function initPostOptionsDropdowns() {
    document.addEventListener('click', (e) => {
        // ── Close on outside click ──────────────────────────────────────────
        if (!e.target.closest('.post-options-btn') && !e.target.closest('.post-options-dropdown')) {
            document.querySelectorAll('.post-options-dropdown').forEach(d => d.classList.add('hidden'));
            return;
        }

        const btn = e.target.closest('.post-options-btn');
        if (!btn) return;

        // posts.js attaches its own handler to the three feed containers and
        // handles BOTH .post-options-trigger AND .post-options-btn clicks.
        // If this click is inside one of those feeds, let posts.js handle it
        // exclusively to prevent a double-open/close race.
        const feedIds = ['posts-feed', 'bookmarked-posts-feed', 'my-posts-feed'];
        if (feedIds.some(id => btn.closest(`#${id}`))) return;

        const dropdown = btn.nextElementSibling;
        if (!dropdown) return;

        // Close all others
        document.querySelectorAll('.post-options-dropdown').forEach(d => {
            if (d !== dropdown) d.classList.add('hidden');
        });

        const isAlreadyOpen = !dropdown.classList.contains('hidden');
        if (isAlreadyOpen) {
            dropdown.classList.add('hidden');
            return;
        }

        // ── Build items fresh from CURRENT auth state ──────────────────────
        const postId      = dropdown.dataset.postId      || '';
        const authorEmail = dropdown.dataset.authorEmail  || '';
        const authorName  = dropdown.dataset.authorName   || '';
        const isPinned    = dropdown.dataset.pinned === '1';
        const isOwner     = !!(currentUser && currentUser.email === authorEmail);
        const isAdminUser = !!(currentUser && currentUser.role === 'admin');

        const itemCls  = 'w-full text-left px-4 py-2.5 text-sm flex items-center gap-2.5 transition-colors cursor-pointer';
        const normCls  = `${itemCls} text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-700/60`;
        const redCls   = `${itemCls} text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20`;
        const amberCls = `${itemCls} text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20`;
        const orngCls  = `${itemCls} text-orange-500 hover:bg-orange-50 dark:hover:bg-orange-900/20`;

        const shareIcon = `<svg class="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>`;
        const delIcon  = `<svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>`;
        const editIcon = `<svg class="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>`;
        const pinIcon  = `<svg class="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path d="M5.5 2a1.5 1.5 0 000 3h.75v4.75L3.8 13H16.2l-2.45-3.25V5h.75a1.5 1.5 0 000-3h-9zM9 15a1 1 0 102 0H9z"/></svg>`;
        const msgIcon  = `<svg class="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>`;
        const rptIcon  = `<svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2zm9-13.5V9"/></svg>`;

        if (isOwner) {
            dropdown.innerHTML = `
                <button class="edit-post-btn ${normCls}" data-post-id="${postId}">${editIcon} Edit post</button>
                <button class="share-btn ${normCls}" data-post-id="${postId}">${shareIcon} Share</button>
                <hr class="my-1 border-gray-100 dark:border-zinc-700">
                <button class="delete-post-btn ${redCls}" data-post-id="${postId}">${delIcon} Delete post</button>`;
        } else if (isAdminUser) {
            dropdown.innerHTML = `
                <button class="share-btn ${normCls}" data-post-id="${postId}">${shareIcon} Share</button>
                <button class="pin-post-btn ${amberCls}" data-post-id="${postId}">${pinIcon} ${isPinned ? 'Unpin post' : 'Pin post'}</button>
                <hr class="my-1 border-gray-100 dark:border-zinc-700">
                <button class="delete-post-btn ${redCls}" data-post-id="${postId}">${delIcon} Delete (Admin)</button>`;
        } else {
            const firstName = authorName.split(' ')[0] || 'author';
            dropdown.innerHTML = `
                <button class="message-author-btn ${normCls}" data-email="${authorEmail}" data-name="${authorName}">${msgIcon} Message ${firstName}</button>
                <button class="share-btn ${normCls}" data-post-id="${postId}">${shareIcon} Share</button>
                <button class="report-btn ${orngCls}" data-content-id="${postId}" data-content-type="post" data-content-author-email="${authorEmail}">${rptIcon} Report</button>`;
        }
        // ──────────────────────────────────────────────────────────────────

        dropdown.classList.remove('hidden');
    });

    // ── Reply form toggle ────────────────────────────────────────────────────
    // The reply-comment-btn in a COMMENT card lives inside a wrapper div
    // (div.mt-3.pl-10.flex) that has NO data attribute, so closest('[data-comment-id]')
    // correctly jumps to the outer comment card. The reply form is a direct child of
    // that card, so querySelector('.reply-form-container') finds it.
    //
    // The reply-comment-btn inside a REPLY card is a direct child of [data-reply-id],
    // so closest('[data-reply-id]') finds its own card, and the form is also a direct
    // child of that card.
    //
    // We use querySelector (not :scope >) so it works at both nesting levels.
    document.addEventListener('click', (e) => {
        const replyBtn = e.target.closest('.reply-comment-btn');
        if (!replyBtn) return;

        const card = replyBtn.closest('[data-comment-id], [data-reply-id]');
        if (!card) return;

        // Close all other open reply forms first
        document.querySelectorAll('.reply-form-container').forEach(f => {
            if (f !== card.querySelector('.reply-form-container')) {
                f.style.display = 'none';
            }
        });

        const form = card.querySelector('.reply-form-container');
        if (!form) return;

        const isVisible = form.style.display === 'flex';
        form.style.display = isVisible ? 'none' : 'flex';
        if (!isVisible) {
            form.querySelector('.reply-textarea')?.focus();
        }
        e.stopPropagation();
    });

    // ── Submit reply ─────────────────────────────────────────────────────────
    // NOTE: Reply submission is fully handled by comments.js (setupComments).
    // comments.js uses event delegation on commentsList and writes to the correct
    // subcollection path: posts/{postId}/comments/{commentId}.replies
    // The old handler here wrote to a wrong top-level 'comments' collection and
    // is removed to prevent double-posting bugs.
}

// ============================================================
//  REPLIES RENDERER (recursive, dark-mode aware)
// ============================================================
function renderReplies(replies, currentUser, level = 1, parentCommentId = null) {
    if (!replies?.length) return '';
    const pad = level < 4 ? 'pl-4 border-l-2 border-gray-100 dark:border-zinc-800' : 'pl-2 border-l border-gray-100 dark:border-zinc-800';

    return `<div class="mt-3 ${pad} space-y-3">` +
        replies.map(reply => {
            const isOwnReply  = !!(currentUser && reply.authorEmail === currentUser.email);
            const canDelReply = isOwnReply || currentUser?.role === 'admin';

            return `
            <div class="group relative bg-gray-50 dark:bg-zinc-800/60 rounded-2xl p-3 transition-all duration-200 hover:bg-white dark:hover:bg-zinc-800 hover:shadow-sm" data-reply-id="${reply.id}">
                <div class="flex justify-between items-start gap-2">
                    <div class="flex items-center gap-2">
                        ${initialsAvatar(reply.author, 6, reply.authorPicture)}
                        <div>
                            <span class="font-semibold text-indigo-600 dark:text-indigo-400 text-xs">${sanitize(reply.author)}</span>
                            <span class="text-xs text-gray-400 dark:text-gray-500 ml-1.5">${timeAgo(reply.timestamp)}</span>
                        </div>
                    </div>
                    <div class="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                        ${!isOwnReply ? `<button class="report-btn text-xs text-orange-400 hover:text-orange-600 hover:underline" data-content-id="${parentCommentId || reply.id}" data-content-type="reply" data-reply-id="${reply.id}">Report</button>` : ''}
                        ${canDelReply ? `<button class="delete-reply-btn text-xs text-red-400 hover:text-red-600 hover:underline" data-reply-id="${reply.id}">Delete</button>` : ''}
                    </div>
                </div>
                <p class="text-sm text-gray-600 dark:text-gray-400 mt-2 leading-relaxed pl-8">${sanitize(reply.text)}</p>
                <button class="reply-comment-btn mt-2 ml-8 text-xs font-semibold text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors duration-150 flex items-center gap-1 focus:outline-none">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/></svg>
                    Reply
                </button>
                <div class="reply-form-container" style="display:none;margin-top:0.5rem;margin-left:2rem;gap:0.5rem;align-items:flex-start;">
                    <textarea class="reply-textarea" style="flex:1;border-radius:0.75rem;padding:0.5rem;font-size:0.75rem;border:1.5px solid #e5e7eb;background:#fff;color:#1f2937;outline:none;resize:none;transition:border-color 0.15s;font-family:inherit;" rows="2" placeholder="Reply to ${sanitize(reply.author)}…"></textarea>
                    <button class="submit-reply-btn" style="background:#6366f1;color:#fff;padding:0.375rem 0.75rem;border-radius:0.75rem;font-size:0.75rem;font-weight:600;border:none;cursor:pointer;flex-shrink:0;">Post</button>
                </div>
                ${renderReplies(reply.replies, currentUser, level + 1, parentCommentId)}
            </div>`;
        }).join('') + `</div>`;
}

// ============================================================
//  COMMENT CARD
// ============================================================
export function createCommentHTML(comment, currentUser) {
    const isOwn   = !!(currentUser && comment.authorEmail === currentUser.email);
    const isAdmin = !!(currentUser && currentUser.role === 'admin');
    const canDel  = isOwn || isAdmin;
    const likes   = comment.likes || 0;
    const hasLiked= !!(currentUser && comment.likedBy?.includes(currentUser.email));

    return `
    <div class="group relative bg-white dark:bg-zinc-900 border border-gray-100 dark:border-zinc-800 rounded-2xl p-4 mb-3 transition-all duration-200 hover:shadow-md hover:border-indigo-100 dark:hover:border-indigo-900" data-comment-id="${comment.id}">
        <div class="flex justify-between items-start gap-2">
            <div class="flex items-center gap-2.5">
                ${initialsAvatar(comment.author, 8, comment.authorPicture)}
                <div>
                    <span class="font-bold text-indigo-600 dark:text-indigo-400 text-sm">${sanitize(comment.author)}</span>
                    <span class="text-xs text-gray-400 dark:text-gray-500 ml-1.5" title="${new Date(comment.timestamp).toLocaleString()}">${timeAgo(comment.timestamp)}</span>
                    ${comment.edited ? `<span class="text-xs text-gray-400 dark:text-gray-600 ml-1 italic">(edited)</span>` : ''}
                </div>
            </div>
            <div class="flex gap-2 items-center opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                ${!isOwn ? `<button class="report-btn text-xs text-orange-400 hover:text-orange-600 hover:underline" data-content-id="${comment.id}" data-content-type="comment">Report</button>` : ''}
                ${isOwn  ? `<button class="edit-comment-btn text-xs text-blue-400 hover:text-blue-600 hover:underline" data-comment-id="${comment.id}">Edit</button>` : ''}
                ${canDel ? `<button class="delete-comment-btn text-xs text-red-400 hover:text-red-600 hover:underline" data-comment-id="${comment.id}">Delete</button>` : ''}
            </div>
        </div>

        <p class="text-gray-700 dark:text-gray-300 text-sm mt-2.5 leading-relaxed pl-10 comment-text-node">${sanitize(comment.text)}</p>

        <div class="mt-3 pl-10 flex items-center gap-3">
            <button class="like-comment-btn flex items-center gap-1 text-xs font-semibold transition-colors duration-150 focus:outline-none ${hasLiked ? 'text-rose-500' : 'text-gray-400 hover:text-rose-500'}"
                    data-comment-id="${comment.id}" aria-label="${hasLiked ? 'Unlike' : 'Like'} comment">
                <svg class="w-3.5 h-3.5" fill="${hasLiked ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/>
                </svg>
                ${likes > 0 ? `<span class="tabular-nums">${likes}</span>` : ''}
            </button>
            <button class="reply-comment-btn text-xs font-semibold text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors duration-150 flex items-center gap-1 focus:outline-none">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/></svg>
                Reply
            </button>
        </div>

        <div class="reply-form-container" style="display:none;margin-top:0.75rem;padding-left:2.5rem;gap:0.5rem;align-items:flex-start;">
            <textarea class="reply-textarea" style="flex:1;border-radius:0.75rem;padding:0.625rem;font-size:0.875rem;border:1.5px solid #e5e7eb;background:#fff;color:#1f2937;outline:none;resize:none;transition:border-color 0.15s;font-family:inherit;" rows="2" placeholder="Write a reply…"></textarea>
            <button class="submit-reply-btn" style="background:#6366f1;color:#fff;padding:0.5rem 1rem;border-radius:0.75rem;font-size:0.875rem;font-weight:600;border:none;cursor:pointer;flex-shrink:0;transition:background 0.15s;">Post</button>
        </div>

        ${renderReplies(comment.replies, currentUser, 1, comment.id)}
    </div>`;
}
// ============================================================
//  REPORT MODAL  —  window.openReportModal(contentId, contentType, postId, replyId)
//
//  Called by posts.js and comments.js whenever a report-btn is clicked.
//
//  contentId        = Firestore doc id of the reported item
//                     For replies: the parent comment doc id (replies are nested)
//  contentType      = 'post' | 'comment' | 'reply'
//  postId           = parent post id (required for comment/reply; equals contentId for posts)
//  replyId          = reply's own id (only set when contentType === 'reply')
//  contentAuthorEmail = (optional) email of the content author for self-report prevention
//
//  Duplicate prevention uses a deterministic Firestore document ID so no
//  composite index is required and writes are idempotent.
//
//  Writes to Firestore 'reports' collection.  Fields written here must
//  exactly match what admin.js reads in renderModeration().
// ============================================================
// NOTE: db, collection, addDoc, _serverTimestamp, currentUser, getDocs, query, where
// are already imported at the top of this file — no re-import needed here.
// We also need doc, setDoc, getDoc, and increment for the new logic.

(function registerReportModal() {
    // Lazily import the extra Firestore functions we need.
    // They share the same SDK URL already imported at the top of the file,
    // so the browser will serve them from the module cache — no extra network hit.
    let _fsExtras = null;
    async function _getFirestoreExtras() {
        if (_fsExtras) return _fsExtras;
        const { doc, setDoc, getDoc, increment } =
            await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
        _fsExtras = { doc, setDoc, getDoc, increment };
        return _fsExtras;
    }

    let _overlay = null;

    function getOrBuildOverlay() {
        if (_overlay && document.body.contains(_overlay)) return _overlay;

        const overlay = document.createElement('div');
        overlay.id = 'report-modal-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'report-modal-title');
        overlay.style.cssText = [
            'display:none',
            'position:fixed',
            'inset:0',
            'z-index:10000',
            'background:rgba(0,0,0,0.6)',
            'backdrop-filter:blur(4px)',
            'align-items:center',
            'justify-content:center',
            'padding:16px',
        ].join(';');

        overlay.innerHTML = `
<style>
#report-modal-box {
    background:#fff; border-radius:20px; padding:28px;
    width:min(460px,100%); max-height:90vh; overflow-y:auto;
    box-shadow:0 24px 64px rgba(0,0,0,0.25);
    display:flex; flex-direction:column; gap:18px;
    animation:reportIn .22s cubic-bezier(.34,1.56,.64,1) both;
}
@keyframes reportIn { from{opacity:0;transform:scale(.93) translateY(10px)} to{opacity:1;transform:none} }
body.dark-mode #report-modal-box { background:#1c1c1f; }
body.dark-mode #report-modal-box label { color:#a1a1aa; }
body.dark-mode #report-modal-box h3  { color:#f4f4f5; }
body.dark-mode #report-modal-box p   { color:#a1a1aa; }
body.dark-mode #report-reason-select,
body.dark-mode #report-detail-input  { background:#27272a; border-color:#3f3f46; color:#f4f4f5; }
</style>
<div id="report-modal-box">
    <div style="display:flex;align-items:center;gap:12px;">
        <div style="width:40px;height:40px;border-radius:12px;background:#fff3ed;
                    display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">
            🚩
        </div>
        <div style="flex:1;">
            <h3 id="report-modal-title" style="margin:0;font-size:17px;font-weight:700;color:#111;">
                Report Content
            </h3>
            <p style="margin:2px 0 0;font-size:13px;color:#9ca3af;">
                Help us keep the community safe
            </p>
        </div>
        <button id="report-modal-close"
            style="background:none;border:none;font-size:24px;color:#9ca3af;
                   cursor:pointer;line-height:1;padding:4px;flex-shrink:0;"
            aria-label="Close report modal">×</button>
    </div>

    <div style="display:flex;flex-direction:column;gap:6px;">
        <label for="report-reason-select"
               style="font-size:13px;font-weight:600;color:#374151;">
            Reason <span style="color:#ef4444;">*</span>
        </label>
        <select id="report-reason-select"
            style="padding:10px 12px;border:1.5px solid #e5e7eb;border-radius:10px;
                   font-size:14px;background:#fff;cursor:pointer;outline:none;
                   transition:border-color .15s;">
            <option value="">— Select a reason —</option>
            <option value="Spam">Spam or self-promotion</option>
            <option value="Harassment">Harassment or bullying</option>
            <option value="Hate Speech">Hate speech or discrimination</option>
            <option value="Misinformation">Misinformation or false content</option>
            <option value="Inappropriate Content">Inappropriate or adult content</option>
            <option value="Violence">Violence or dangerous content</option>
            <option value="Intellectual Property">Copyright or IP violation</option>
            <option value="Other">Other</option>
        </select>
    </div>

    <div style="display:flex;flex-direction:column;gap:6px;">
        <label for="report-detail-input"
               style="font-size:13px;font-weight:600;color:#374151;">
            Additional details
            <span style="color:#9ca3af;font-weight:400;">(optional)</span>
        </label>
        <textarea id="report-detail-input" rows="3" maxlength="500"
            placeholder="Describe the issue in more detail…"
            style="padding:10px 12px;border:1.5px solid #e5e7eb;border-radius:10px;
                   font-size:14px;resize:vertical;font-family:inherit;outline:none;
                   transition:border-color .15s;"></textarea>
    </div>

    <p id="report-modal-error"
       style="display:none;color:#ef4444;font-size:13px;margin:0;padding:10px 12px;
              background:#fef2f2;border-radius:8px;border:1px solid #fecaca;"></p>

    <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button id="report-modal-cancel"
            style="padding:10px 20px;border-radius:10px;border:1.5px solid #e5e7eb;
                   background:#fff;font-size:14px;cursor:pointer;font-weight:500;
                   color:#374151;transition:background .15s;">
            Cancel
        </button>
        <button id="report-modal-submit"
            style="padding:10px 22px;border-radius:10px;border:none;
                   background:#f97316;color:#fff;font-size:14px;font-weight:600;
                   cursor:pointer;transition:background .15s,opacity .15s;
                   display:flex;align-items:center;gap:8px;">
            Submit report
        </button>
    </div>
</div>`;

        document.body.appendChild(overlay);

        const closeModal = () => {
            overlay.style.display = 'none';
            const sel = document.getElementById('report-reason-select');
            const det = document.getElementById('report-detail-input');
            const err = document.getElementById('report-modal-error');
            const btn = document.getElementById('report-modal-submit');
            if (sel) sel.value = '';
            if (det) det.value = '';
            if (err) { err.style.display = 'none'; err.textContent = ''; }
            if (btn) { btn.textContent = 'Submit report'; btn.disabled = false; }
        };

        document.getElementById('report-modal-close').addEventListener('click', closeModal);
        document.getElementById('report-modal-cancel').addEventListener('click', closeModal);
        overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && overlay.style.display !== 'none') closeModal();
        });

        _overlay = overlay;
        return overlay;
    }

    /**
     * Generate a deterministic, URL-safe Firestore document ID for a report.
     * Encodes: reporterEmail + contentId + replyId (optional)
     * This prevents duplicate reports from the same user for the same content
     * WITHOUT requiring a composite index — a single getDoc() on the known ID suffices.
     */
    function _makeReportId(reporterEmail, contentId, replyId) {
        const raw = `${reporterEmail}::${contentId}::${replyId || 'null'}`;
        // Base64 → strip non-alphanumeric → cap at 128 chars (Firestore ID limit: 1500 bytes)
        try {
            return btoa(unescape(encodeURIComponent(raw)))
                .replace(/[^A-Za-z0-9]/g, '_')
                .slice(0, 128);
        } catch {
            // Fallback: simple hash
            let h = 0;
            for (let i = 0; i < raw.length; i++) h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
            return `report_${Math.abs(h).toString(36)}_${Date.now().toString(36)}`;
        }
    }

    /**
     * Determine the Firestore collection and document reference for the reported content
     * so we can increment its reportCount field.
     */
    function _getContentRef(fsDoc, contentType, contentId, postId) {
        try {
            if (contentType === 'post')       return fsDoc(db, 'posts',      contentId);
            if (contentType === 'lostFound')  return fsDoc(db, 'lost_found', contentId);
            if (contentType === 'event')      return fsDoc(db, 'events',     contentId);
            if (contentType === 'comment' && postId)
                return fsDoc(db, 'posts', postId, 'comments', contentId);
            // For 'reply', increment the parent comment's reportCount
            if (contentType === 'reply' && postId)
                return fsDoc(db, 'posts', postId, 'comments', contentId);
        } catch {}
        return null;
    }

    /**
     * Open the report modal.
     *
     * @param {string}  contentId          - Firestore doc id of the reported item.
     *                                       For replies: the parent comment doc id.
     * @param {string}  contentType        - 'post' | 'comment' | 'reply' | 'lostFound' | 'event'
     * @param {string}  [postId]           - Parent post id. Always pass for comments/replies.
     * @param {string}  [replyId]          - The reply's own id (only when contentType === 'reply').
     * @param {string}  [contentAuthorEmail] - Email of the content author (for self-report check).
     */
    window.openReportModal = function openReportModal(
        contentId, contentType, postId, replyId, contentAuthorEmail
    ) {
        // ── Guard: must be signed in ──────────────────────────────────────
        if (!currentUser) {
            showToast('Sign in to report content.', 'warning');
            return;
        }

        // ── Guard: self-report prevention ─────────────────────────────────
        // The report buttons are already hidden for own content in the UI,
        // but we add a server-side-style defence here as well.
        if (contentAuthorEmail && currentUser.email === contentAuthorEmail) {
            showToast("You can't report your own content.", 'warning');
            return;
        }

        const overlay = getOrBuildOverlay();

        // Clone submit button to remove any stale listener from a previous open
        const oldBtn   = document.getElementById('report-modal-submit');
        const freshBtn = oldBtn.cloneNode(true);
        oldBtn.replaceWith(freshBtn);

        // Show
        overlay.style.display = 'flex';
        requestAnimationFrame(() => {
            document.getElementById('report-reason-select')?.focus();
        });

        freshBtn.addEventListener('click', async () => {
            const reason = (document.getElementById('report-reason-select')?.value || '').trim();
            const detail = (document.getElementById('report-detail-input')?.value  || '').trim();
            const errEl  = document.getElementById('report-modal-error');

            if (!reason) {
                if (errEl) {
                    errEl.textContent   = 'Please select a reason before submitting.';
                    errEl.style.display = 'block';
                }
                return;
            }
            if (errEl) errEl.style.display = 'none';

            freshBtn.disabled  = true;
            freshBtn.innerHTML = `<span style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:-2px;margin-right:6px;"></span>Submitting…`;

            try {
                const { doc: fsDoc, setDoc, getDoc, increment } = await _getFirestoreExtras();

                // ── DUPLICATE PREVENTION ──────────────────────────────────
                // We use a deterministic document ID (reporter + content + reply)
                // so a single getDoc() suffices — no composite index required.
                //
                // The getDoc is wrapped in try/catch because Firestore denies
                // reads on non-existent documents if rules evaluate resource.data
                // (null) before the doc is created. If the read is denied we skip
                // the duplicate check and fall through to the write — setDoc with
                // a deterministic ID is idempotent so true duplicates are still
                // prevented at the database level.
                const reportDocId = _makeReportId(currentUser.email, contentId, replyId);
                const reportRef   = fsDoc(db, 'reports', reportDocId);

                let existingSnap = null;
                try {
                    existingSnap = await getDoc(reportRef);
                } catch (readErr) {
                    console.warn('[ReportModal] Duplicate-check read denied, proceeding to write:', readErr.code);
                }

                if (existingSnap?.exists()) {
                    const existingStatus = (existingSnap.data().status || '').toLowerCase();
                    if (existingStatus === 'pending') {
                        overlay.style.display = 'none';
                        showToast('You have already reported this content.', 'info');
                        return;
                    }
                    // If previously resolved/dismissed: allow re-reporting (overwrite below)
                }

                // ── WRITE REPORT ──────────────────────────────────────────
                //
                // Field contract — every field here is consumed by admin.js:
                //   contentId      → collectionMap lookup for content preview
                //   contentType    → 'post' | 'comment' | 'reply' | 'lostFound' | 'event'
                //   postId         → parent post id (comment/reply navigation)
                //   replyId        → the reply's own id (contentType === 'reply')
                //   reason         → shown as reason chip
                //   detail         → shown as reporter note
                //   status         → must be exactly 'Pending' (admin filters on this)
                //   reporterName   → shown in "Reported by" card
                //   reporterEmail  → used in duplicate check
                //   timestamp      → Firestore serverTimestamp; admin reads .toMillis()
                //   reportedAt     → numeric ms (fallback for offline/legacy reads)
                await setDoc(reportRef, {
                    contentId,
                    contentType,
                    postId:        postId  || contentId,  // fallback for top-level posts
                    replyId:       replyId || null,
                    reason,
                    detail:        detail || '',
                    status:        'Pending',
                    reporterName:  currentUser.name  || currentUser.email,
                    reporterEmail: currentUser.email,
                    timestamp:     _serverTimestamp(),
                    reportedAt:    Date.now(),              // numeric fallback
                });

                // ── INCREMENT reportCount on the content doc ──────────────
                // Fire-and-forget — not critical, best effort.
                try {
                    const contentRef = _getContentRef(fsDoc, contentType, contentId, postId);
                    if (contentRef) {
                        // Use updateDoc (not setDoc) so we don't overwrite the document;
                        // ignore errors silently (doc may not exist anymore).
                        const { updateDoc: _upd } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
                        await _upd(contentRef, { reportCount: increment(1) });
                    }
                } catch (_) { /* non-critical */ }

                overlay.style.display = 'none';
                document.getElementById('report-reason-select').value = '';
                document.getElementById('report-detail-input').value  = '';
                showToast('Report submitted — thank you.', 'success');

            } catch (err) {
                console.error('[ReportModal] Firestore write failed:', err);
                const errEl2 = document.getElementById('report-modal-error');
                if (errEl2) {
                    errEl2.textContent   = 'Failed to submit — please try again.';
                    errEl2.style.display = 'block';
                }
                freshBtn.disabled    = false;
                freshBtn.textContent = 'Submit report';
            }
        });
    };
})();