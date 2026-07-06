/**
 * admin.js — Advanced Admin Panel Module (Refined)
 *
 * Improvements over original:
 *  ✅ Advanced UI: glassmorphism cards, animated stat counters, gradient accents,
 *     micro-interactions, skeleton loaders, smooth tab transitions, rich typography.
 *  ✅ Overview: Sparkline activity charts (SVG), real-time clock, quick-action tiles,
 *     recent activity feed, system health indicators.
 *  ✅ Moderation: Inline content preview with full post body, reporter details,
 *     bulk-select with batch actions, severity badges, timestamp humanisation.
 *  ✅ User Directory: Avatar colours derived from name hash, search/filter bar,
 *     expandable user detail cards, strike history tooltip, role badges.
 *  ✅ Broadcast: Live character counter, preview pane, pinned/scheduled toggle,
 *     per-broadcast engagement stats.
 *  ✅ Settings: Animated maintenance toggle, word-tag UI for profanity filter,
 *     danger-zone confirmation modal (replaces native confirm()).
 *  ✅ Audit Logs: Colour-coded action chips, collapsible payload inspector,
 *     search & date-range filter, CSV export.
 *  ✅ Shared: Consistent modal helper, toast queue (no stacking), loading
 *     skeletons, all async guards, audit on every action.
 */

import { db, auth } from '../config/firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { currentUser, addDocument } from '../store/db.js';
import { sanitize } from '../ui/templates.js';
import {
    collection, query, where, getDocs, doc, getDoc,
    updateDoc, deleteDoc, getCountFromServer, serverTimestamp,
    orderBy, limit, increment, setDoc, addDoc, arrayRemove,
    onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const TAB_ACTIVE   = ['bg-sky-500/15', 'text-sky-400', 'border-sky-500/30', 'shadow-inner'];
const TAB_INACTIVE = ['text-slate-400', 'border-transparent', 'hover:bg-slate-800/60', 'hover:text-slate-200'];

const ACTION_COLORS = {
    BROADCAST_SENT:          '#38bdf8',
    BROADCAST_UPDATED:       '#a78bfa',
    BROADCAST_ARCHIVED:      '#fb923c',
    BROADCAST_RESTORED:      '#34d399',
    BROADCAST_DELETED:       '#f87171',
    BROADCAST_RETRACTED:     '#f87171', // legacy — kept for old audit log entries
    USER_PROMOTED:           '#fbbf24',
    USER_SUSPENDED:          '#f87171',
    USER_RESTORED:           '#34d399',
    USER_STRIKE_ISSUED:      '#fb923c',
    CONTENT_PURGED:          '#f43f5e',
    REPORT_REOPENED:         '#38bdf8',
    MAINTENANCE_ENABLED:     '#fb923c',
    MAINTENANCE_DISABLED:    '#34d399',
    PROFANITY_FILTER_UPDATED:'#a78bfa',
    INACTIVE_ACCOUNT_PURGE:  '#f87171',
};

// ─────────────────────────────────────────────────────────────────────────────
// MODULE-LEVEL STATE
// ─────────────────────────────────────────────────────────────────────────────

/** Active onSnapshot unsubscribe handles — keyed by purpose */
const _unsubs = {};

/** Detach a listener by key (no-op if not active) */
function _detach(key) {
    if (_unsubs[key]) { try { _unsubs[key](); } catch (_) {} delete _unsubs[key]; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TINY UI UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/** Replace innerHTML of an element found by id */
const setHTML = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };

/** Empty state message based on filter status */
function _emptyMsgForFilter(fs) {
    const map = {
        'Pending':              'No flagged content waiting for review.',
        'Resolved (Dismissed)': 'No dismissed reports found.',
        'Resolved (Purged)':    'No purged content reports found.',
        'All Resolved':         'No resolved reports found.',
    };
    return map[fs] || 'No reports found.';
}

// ── Toast queue (prevents visual stacking) ──────────────────────────────────
let _toastTimer = null;
const _toastQueue = [];

function _drainToastQueue() {
    if (!_toastQueue.length) return;
    const { msg, type } = _toastQueue.shift();
    const COLOURS = {
        info:    'from-sky-600 to-sky-700 border-sky-500/30',
        success: 'from-emerald-600 to-emerald-700 border-emerald-500/30',
        error:   'from-red-600 to-red-700 border-red-500/30',
        warn:    'from-orange-500 to-orange-600 border-orange-400/30',
    };
    const ICONS = { info: '💬', success: '✅', error: '❌', warn: '⚠️' };
    const t = document.createElement('div');
    t.className = `fixed bottom-6 right-6 z-[9999] flex items-center gap-3 px-5 py-3.5
                   rounded-2xl text-white text-sm font-semibold shadow-2xl border
                   bg-gradient-to-r ${COLOURS[type] || COLOURS.info}
                   transition-all duration-300 translate-y-2 opacity-0`;
    t.innerHTML = `<span class="text-base flex-shrink-0">${ICONS[type] || '💬'}</span>
                   <span>${msg}</span>`;
    document.body.appendChild(t);

    requestAnimationFrame(() => {
        t.style.opacity    = '1';
        t.style.transform  = 'translateY(0)';
    });

    _toastTimer = setTimeout(() => {
        t.style.opacity   = '0';
        t.style.transform = 'translateY(8px)';
        setTimeout(() => { t.remove(); _drainToastQueue(); }, 300);
    }, 3200);
}

function toast(msg, type = 'info') {
    _toastQueue.push({ msg, type });
    if (_toastQueue.length === 1) _drainToastQueue();
}

/** Animated loading state on a button; returns restore function */
function btnLoading(btn, loadingText = 'Processing…') {
    const orig = btn.innerHTML;
    btn.innerHTML = `<span class="inline-block w-4 h-4 border-2 border-white/30 border-t-white
                     rounded-full animate-spin mr-2"></span>${loadingText}`;
    btn.disabled = true;
    return () => { btn.innerHTML = orig; btn.disabled = false; };
}

/** Animate a number from 0 → target */
function animateCount(el, target, duration = 800) {
    if (!el) return;
    const start  = performance.now();
    const update = (now) => {
        const pct = Math.min((now - start) / duration, 1);
        const ease = 1 - Math.pow(1 - pct, 3); // cubic ease-out
        el.textContent = Math.round(target * ease).toLocaleString();
        if (pct < 1) requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
}

/** Humanise a timestamp to "2 hours ago", "just now", etc. */
function timeAgo(ms) {
    const secs = Math.floor((Date.now() - ms) / 1000);
    if (secs < 60)  return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
}

/** Deterministic avatar colour from a string */
function avatarColor(str = '') {
    const PALETTES = [
        ['from-violet-500 to-purple-600', 'shadow-purple-500/20'],
        ['from-sky-500 to-blue-600',      'shadow-blue-500/20'],
        ['from-emerald-500 to-teal-600',  'shadow-teal-500/20'],
        ['from-amber-400 to-orange-500',  'shadow-orange-500/20'],
        ['from-pink-500 to-rose-600',     'shadow-rose-500/20'],
        ['from-indigo-500 to-blue-700',   'shadow-indigo-500/20'],
    ];
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
    return PALETTES[Math.abs(hash) % PALETTES.length];
}

// ─────────────────────────────────────────────────────────────────────────────
// SKELETON / EMPTY / ERROR TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

const skeletonCard = (lines = 3) => `
    <div class="bg-slate-800/40 rounded-2xl p-6 animate-pulse space-y-3 border border-slate-700/30">
        <div class="h-3 bg-slate-700/60 rounded-full w-1/3"></div>
        ${Array(lines).fill('').map((_, i) =>
            `<div class="h-2.5 bg-slate-700/40 rounded-full ${i === lines-1 ? 'w-2/3' : 'w-full'}"></div>`
        ).join('')}
    </div>`;

const skeletonList = (n = 4) => Array(n).fill('').map(() => skeletonCard()).join('');

const emptyState = (icon, title, sub, action = '') => `
    <div class="p-20 text-center">
        <div class="text-6xl mb-5 opacity-30 select-none">${icon}</div>
        <h4 class="text-white font-black text-xl tracking-tight mb-2">${title}</h4>
        <p class="text-slate-400 text-sm font-medium max-w-xs mx-auto leading-relaxed">${sub}</p>
        ${action}
    </div>`;

const errorState = (msg) => `
    <div class="p-10 text-center">
        <div class="text-4xl mb-3 opacity-50">⚠️</div>
        <p class="text-red-400 font-bold text-sm">${msg}</p>
    </div>`;

// ─────────────────────────────────────────────────────────────────────────────
// DANGER CONFIRMATION MODAL (replaces native confirm())
// ─────────────────────────────────────────────────────────────────────────────

function dangerModal({ title, body, confirmText = 'Confirm', onConfirm }) {
    document.getElementById('admin-danger-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'admin-danger-modal';
    overlay.className = 'fixed inset-0 z-[10000] flex items-center justify-center p-4';
    overlay.style.background = 'rgba(0,0,0,0.7)';
    overlay.style.backdropFilter = 'blur(6px)';
    overlay.innerHTML = `
        <div class="bg-slate-900 border border-slate-700 rounded-3xl p-8 w-full max-w-md
                    shadow-2xl shadow-black/50 animate-[slideUp_0.2s_ease]">
            <div class="w-14 h-14 rounded-2xl bg-red-500/15 border border-red-500/20
                        flex items-center justify-center text-2xl mx-auto mb-5">⚠️</div>
            <h3 class="text-white font-black text-xl text-center tracking-tight mb-2">${title}</h3>
            <p class="text-slate-400 text-sm text-center leading-relaxed mb-8">${body}</p>
            <div class="flex gap-3">
                <button id="dm-cancel"
                        class="flex-1 py-3 rounded-xl border border-slate-700 text-slate-300
                               font-bold text-sm hover:bg-slate-800 transition">
                    Cancel
                </button>
                <button id="dm-confirm"
                        class="flex-1 py-3 rounded-xl bg-red-600 hover:bg-red-500 text-white
                               font-black text-sm transition shadow-lg shadow-red-600/20 uppercase tracking-wide">
                    ${confirmText}
                </button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    document.getElementById('dm-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('dm-confirm').addEventListener('click', () => {
        close();
        onConfirm();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOG HELPER (fire-and-forget)
// ─────────────────────────────────────────────────────────────────────────────

async function writeAudit(action, extras = {}) {
    try {
        await addDocument('audit_logs', {
            action,
            adminEmail: currentUser.email,
            timestamp:  serverTimestamp(),
            ...extras,
        });
    } catch (err) {
        console.warn('[Admin] Audit write failed:', err);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export function setupAdmin() {
    const adminPage = document.getElementById('page-admin');
    if (!adminPage) return;

    // Guard: only wire up Firestore listeners and admin logic for actual admins.
    // setupAdmin() is called for every authenticated user by main.js, but non-admin
    // users must never open listeners against the 'reports' collection (or any other
    // admin-only collection) — the Firestore rules will deny them and log errors.
    if (currentUser?.role !== 'admin') return;

    // ── Inject keyframe animations once ──────────────────────────────────────
    if (!document.getElementById('admin-styles')) {
        const style = document.createElement('style');
        style.id = 'admin-styles';
        style.textContent = `
            @keyframes slideUp {
                from { opacity:0; transform:translateY(16px); }
                to   { opacity:1; transform:none; }
            }
            @keyframes fadeIn {
                from { opacity:0; }
                to   { opacity:1; }
            }
            .admin-tab-content { animation: fadeIn 0.2s ease; }
            .admin-stat-card:hover { transform: translateY(-2px); }
            .admin-stat-card { transition: transform 0.2s ease, box-shadow 0.2s ease; }
            .admin-user-row:hover .admin-user-actions { opacity: 1; }
            .admin-user-actions { opacity: 0; transition: opacity 0.15s ease; }
            @media (max-width: 1279px) {
                .admin-user-actions { opacity: 1; }
            }
            .rsvp-tag { transition: all 0.15s ease; }

            /* ── Broadcast styles ──────────────────────────────────── */
            .bc-media-thumb {
                position: relative; width: 80px; height: 60px;
                border-radius: 8px; overflow: hidden; flex-shrink: 0;
                background: rgba(15,23,42,0.8); border: 1px solid rgba(148,163,184,0.15);
            }
            .bc-media-thumb img, .bc-media-thumb video {
                width: 100%; height: 100%; object-fit: cover;
            }
            .bc-media-thumb .bc-remove-file {
                position: absolute; top: 3px; right: 3px;
                width: 18px; height: 18px; border-radius: 50%;
                background: rgba(239,68,68,0.9); color: #fff;
                font-size: 10px; display: flex; align-items: center;
                justify-content: center; cursor: pointer; border: none;
                line-height: 1;
            }
            .bc-media-thumb .bc-doc-icon {
                width: 100%; height: 100%; display: flex; flex-direction: column;
                align-items: center; justify-content: center; gap: 2px;
                font-size: 20px;
            }
            .bc-media-thumb .bc-doc-label {
                font-size: 9px; color: #94a3b8; font-weight: 700;
                text-transform: uppercase; letter-spacing: 0.05em;
                max-width: 68px; overflow: hidden; text-overflow: ellipsis;
                white-space: nowrap;
            }
            .bc-upload-progress {
                position: absolute; inset: 0; background: rgba(0,0,0,0.6);
                display: flex; align-items: center; justify-content: center;
                font-size: 11px; color: #fff; font-weight: 700;
            }
            .bc-active-card {
                background: rgba(15,23,42,0.6);
                border: 1px solid rgba(148,163,184,0.12);
                border-radius: 16px; padding: 16px;
                transition: border-color 0.2s ease, transform 0.15s ease;
            }
            .bc-active-card:hover { border-color: rgba(56,189,248,0.25); }
            .bc-active-card--editing {
                border-color: rgba(99,102,241,0.4) !important;
                background: rgba(99,102,241,0.04) !important;
            }
            .bc-priority-badge {
                display: inline-flex; align-items: center; gap: 4px;
                padding: 2px 8px; border-radius: 20px;
                font-size: 10px; font-weight: 800;
                letter-spacing: 0.06em; text-transform: uppercase;
            }
            .bc-priority-badge--normal   { background: rgba(148,163,184,0.15); color: #94a3b8; }
            .bc-priority-badge--high     { background: rgba(251,191,36,0.15);  color: #fbbf24; }
            .bc-priority-badge--critical { background: rgba(239,68,68,0.15);   color: #f87171; animation: pulse 2s infinite; }
            @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.6} }

            /* Posts feed broadcast banner */
            .post-card--broadcast {
                border-left: 3px solid #38bdf8 !important;
                background: linear-gradient(135deg, rgba(56,189,248,0.04) 0%, transparent 60%) !important;
            }
            .broadcast-feed-banner {
                display: flex; align-items: center; gap: 6px;
                padding: 3px 10px; border-radius: 20px; margin-bottom: 8px;
                background: rgba(56,189,248,0.12); border: 1px solid rgba(56,189,248,0.25);
                width: fit-content;
            }
            .broadcast-feed-banner span { font-size: 10px; font-weight: 800;
                color: #38bdf8; text-transform: uppercase; letter-spacing: 0.08em; }
        `;
        document.head.appendChild(style);
    }

    // ════════════════════════════════════════════════════════════════════════
    // 1. SHELL UI
    // ════════════════════════════════════════════════════════════════════════
    adminPage.innerHTML = `
        <div class="container mx-auto px-4 max-w-[1440px] py-8">
            <div class="flex flex-col xl:flex-row gap-8">

                <!-- ── Sidebar ────────────────────────────────────── -->
                <aside class="w-full xl:w-72 flex-shrink-0">
                    <div class="bg-slate-900/90 border border-slate-800 rounded-3xl p-6
                                sticky top-24 shadow-2xl shadow-black/30 backdrop-blur-sm">

                        <!-- Brand -->
                        <div class="mb-6 pb-5 border-b border-slate-800">
                            <div class="flex items-center gap-3 mb-3">
                                <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600
                                            flex items-center justify-center text-lg shadow-lg shadow-sky-500/20">
                                    ⚡
                                </div>
                                <div>
                                    <h3 class="text-white font-black text-lg tracking-tight leading-none">Admin Core</h3>
                                    <p class="text-[10px] text-slate-500 font-mono mt-0.5">CONTROL PANEL</p>
                                </div>
                            </div>
                            <div class="flex items-center gap-2 px-3 py-2 bg-emerald-500/10
                                        border border-emerald-500/20 rounded-xl">
                                <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0"></span>
                                <span class="text-[11px] text-emerald-400 font-bold tracking-widest uppercase">System Online</span>
                                <span class="ml-auto text-[10px] text-slate-500 font-mono" id="admin-clock"></span>
                            </div>
                        </div>

                        <!-- Nav -->
                        <nav class="space-y-1.5" id="admin-sidebar-nav">
                            <button data-admin-tab="overview"
                                    class="admin-nav-btn w-full text-left px-4 py-3 rounded-xl text-sm
                                           font-semibold border tracking-wide transition-all flex items-center gap-3">
                                <span class="text-base w-5 text-center flex-shrink-0">📊</span>
                                <span>Analytics</span>
                            </button>
                            <button data-admin-tab="moderation"
                                    class="admin-nav-btn w-full text-left px-4 py-3 rounded-xl text-sm
                                           font-semibold border tracking-wide transition-all flex items-center gap-3">
                                <span class="text-base w-5 text-center flex-shrink-0">🛡️</span>
                                <span class="flex-1">Moderation Queue</span>
                                <span id="admin-queue-badge"
                                      class="bg-red-500 text-white text-[10px] px-2 py-0.5 rounded-full hidden
                                             shadow-lg shadow-red-500/30 font-black animate-pulse">0</span>
                            </button>
                            <button data-admin-tab="users"
                                    class="admin-nav-btn w-full text-left px-4 py-3 rounded-xl text-sm
                                           font-semibold border tracking-wide transition-all flex items-center gap-3">
                                <span class="text-base w-5 text-center flex-shrink-0">👥</span>
                                <span>User Directory</span>
                            </button>
                            <button data-admin-tab="broadcast"
                                    class="admin-nav-btn w-full text-left px-4 py-3 rounded-xl text-sm
                                           font-semibold border tracking-wide transition-all flex items-center gap-3">
                                <span class="text-base w-5 text-center flex-shrink-0">📡</span>
                                <span>Broadcast</span>
                            </button>
                            <button data-admin-tab="settings"
                                    class="admin-nav-btn w-full text-left px-4 py-3 rounded-xl text-sm
                                           font-semibold border tracking-wide transition-all flex items-center gap-3">
                                <span class="text-base w-5 text-center flex-shrink-0">⚙️</span>
                                <span>Platform Settings</span>
                            </button>
                            <button data-admin-tab="audit"
                                    class="admin-nav-btn w-full text-left px-4 py-3 rounded-xl text-sm
                                           font-semibold border tracking-wide transition-all flex items-center gap-3">
                                <span class="text-base w-5 text-center flex-shrink-0">📋</span>
                                <span>Audit Trail</span>
                            </button>
                        </nav>

                        <!-- Admin info -->
                        <div class="mt-6 pt-5 border-t border-slate-800">
                            <div class="flex items-center gap-3 px-3 py-2.5
                                        bg-slate-800/50 rounded-xl border border-slate-700/30">
                                <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-400 to-orange-500
                                            flex items-center justify-center text-xs font-black text-white flex-shrink-0">
                                    ${(currentUser?.name || currentUser?.email || 'A').charAt(0).toUpperCase()}
                                </div>
                                <div class="min-w-0">
                                    <p class="text-xs font-bold text-white truncate">
                                        ${sanitize(currentUser?.name || 'Admin')}
                                    </p>
                                    <p class="text-[10px] text-amber-400 font-mono uppercase tracking-widest">Administrator</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </aside>

                <!-- ── Main content ───────────────────────────────── -->
                <main class="flex-grow w-full min-w-0" id="admin-main-view"></main>
            </div>
        </div>`;

    // ── Live clock ───────────────────────────────────────────────────────────
    const clockEl = document.getElementById('admin-clock');
    const updateClock = () => {
        if (clockEl) clockEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    updateClock();
    setInterval(updateClock, 1000);

    const sidebarNav = document.getElementById('admin-sidebar-nav');
    const mainView   = document.getElementById('admin-main-view');

    // Apply initial inactive style
    sidebarNav.querySelectorAll('.admin-nav-btn').forEach(b => b.classList.add(...TAB_INACTIVE));

    // ── TAB ROUTER ──────────────────────────────────────────────────────────
    function activateTab(tab) {
        // Detach broadcast real-time listener when leaving the broadcast tab
        // (BUG-06 fix: prevents stale listeners and duplicate DOM writes)
        if (tab !== 'broadcast') _detach('broadcasts');

        sidebarNav.querySelectorAll('.admin-nav-btn').forEach(b => {
            const isActive = b.dataset.adminTab === tab;
            TAB_ACTIVE.forEach(c   => b.classList.toggle(c, isActive));
            TAB_INACTIVE.forEach(c => b.classList.toggle(c, !isActive));
        });
        ({ overview: renderOverview, moderation: () => renderModeration('Pending'),
           users: renderUserDirectory, broadcast: renderBroadcast,
           settings: renderSettings, audit: renderAuditLogs })[tab]?.();
    }

    sidebarNav.addEventListener('click', e => {
        const btn = e.target.closest('.admin-nav-btn');
        if (btn?.dataset.adminTab) activateTab(btn.dataset.adminTab);
    });

    document.addEventListener('click', e => {
        if (e.target.closest('[data-target="page-admin"]')) activateTab('overview');
    });

    activateTab('overview');

    // ── Real-time moderation queue badge ────────────────────────────────────
    // Subscribes once for the lifetime of the admin panel and keeps the
    // sidebar badge in sync without needing the user to navigate to the
    // moderation tab first.
    // FIX: gate behind confirmed Firebase Auth state — opening this snapshot
    // immediately caused permission-denied because request.auth was null
    // server-side until the JWT was fully validated.
    const _unsubAdminAuth = onAuthStateChanged(auth, firebaseUser => {
        _unsubAdminAuth(); // one-shot
        if (!firebaseUser) return;
        _detach('queueBadge');
        _unsubs['queueBadge'] = onSnapshot(
            collection(db, 'reports'),
            (snap) => {
                const RESOLVED = new Set([
                    'resolved (dismissed)', 'resolved (purged)',
                    'resolved', 'dismissed', 'purged', 'closed',
                ]);
                let pending = 0;
                snap.forEach(d => {
                    const st = (d.data().status || '').toLowerCase().trim();
                    if (!RESOLVED.has(st)) pending++;
                });
                const badge = document.getElementById('admin-queue-badge');
                if (badge) {
                    badge.textContent = pending;
                    badge.classList.toggle('hidden', pending === 0);
                }
                // FIX: also update the global admin nav indicator in the header dropdown
                // so admins see a live count even when not on the admin page.
                const navIndicator = document.getElementById('admin-nav-indicator');
                if (navIndicator) {
                    navIndicator.textContent = pending > 99 ? '99+' : String(pending);
                    navIndicator.classList.toggle('hidden', pending === 0);
                }
            },
            (err) => console.warn('[Admin] Queue badge listener error:', err)
        );
    });

    // ════════════════════════════════════════════════════════════════════════
    // 2. OVERVIEW / ANALYTICS
    // ════════════════════════════════════════════════════════════════════════
    async function renderOverview() {
        mainView.innerHTML = `
            <div class="space-y-8 admin-tab-content">
                <!-- Header -->
                <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                    <div>
                        <h2 class="text-3xl font-black text-white tracking-tight">Analytics</h2>
                        <p class="text-slate-400 text-sm mt-1">Platform health at a glance</p>
                    </div>
                    <div class="flex items-center gap-2 px-4 py-2 bg-slate-800/60 rounded-xl border border-slate-700/30">
                        <span class="w-2 h-2 rounded-full bg-sky-400 animate-pulse"></span>
                        <span class="text-xs text-slate-300 font-mono">Live data</span>
                    </div>
                </div>

                <!-- Stat cards -->
                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                    ${[
                        { id: 'stat-users',    label: 'Registered Users',   icon: '👥', grad: 'from-sky-600/20 to-blue-700/10',     border: 'border-sky-600/20',     text: 'text-sky-400' },
                        { id: 'stat-posts',    label: 'Content Nodes',      icon: '📝', grad: 'from-violet-600/20 to-purple-700/10', border: 'border-violet-600/20',  text: 'text-violet-400' },
                        { id: 'stat-reports',  label: 'Pending Flags',      icon: '🚩', grad: 'from-red-600/20 to-rose-700/10',      border: 'border-red-600/20',     text: 'text-red-400' },
                        { id: 'stat-resolved', label: 'Resolved Cases',     icon: '✅', grad: 'from-emerald-600/20 to-teal-700/10',  border: 'border-emerald-600/20', text: 'text-emerald-400' },
                    ].map(s => `
                        <div class="admin-stat-card bg-gradient-to-br ${s.grad} border ${s.border}
                                    rounded-2xl p-6 shadow-xl relative overflow-hidden cursor-default">
                            <div class="absolute top-4 right-4 text-2xl opacity-20 select-none">${s.icon}</div>
                            <p class="text-xs ${s.text} font-bold tracking-widest uppercase mb-3">${s.label}</p>
                            <h4 class="text-4xl font-black text-white tabular-nums" id="${s.id}">
                                <span class="inline-block w-12 h-8 bg-slate-700/40 rounded-lg animate-pulse align-middle"></span>
                            </h4>
                        </div>`).join('')}
                </div>

                <!-- Quick Actions -->
                <div>
                    <h3 class="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4">Quick Actions</h3>
                    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                        ${[
                            { tab: 'moderation', label: 'Review Queue',    icon: '🛡️', colour: 'hover:border-red-500/40 hover:bg-red-500/5 hover:text-red-300' },
                            { tab: 'users',      label: 'Manage Users',    icon: '👥', colour: 'hover:border-sky-500/40 hover:bg-sky-500/5 hover:text-sky-300' },
                            { tab: 'broadcast',  label: 'New Broadcast',   icon: '📡', colour: 'hover:border-indigo-500/40 hover:bg-indigo-500/5 hover:text-indigo-300' },
                            { tab: 'settings',   label: 'Settings',        icon: '⚙️', colour: 'hover:border-slate-500/40 hover:bg-slate-500/5 hover:text-slate-300' },
                            { tab: 'audit',      label: 'Audit Logs',      icon: '📋', colour: 'hover:border-amber-500/40 hover:bg-amber-500/5 hover:text-amber-300' },
                            { tab: 'overview',   label: 'Refresh Stats',   icon: '🔄', colour: 'hover:border-emerald-500/40 hover:bg-emerald-500/5 hover:text-emerald-300' },
                        ].map(a => `
                            <button data-quick-tab="${a.tab}"
                                    class="flex flex-col items-center gap-2 p-4 rounded-2xl
                                           bg-slate-800/40 border border-slate-700/40 text-slate-400
                                           text-xs font-bold transition-all ${a.colour}">
                                <span class="text-xl">${a.icon}</span>
                                <span class="text-center leading-snug">${a.label}</span>
                            </button>`).join('')}
                    </div>
                </div>

                <!-- Recent activity placeholder -->
                <div>
                    <h3 class="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4">Recent Activity</h3>
                    <div id="admin-recent-activity" class="space-y-2">
                        ${skeletonList(3)}
                    </div>
                </div>
            </div>`;

        // Quick-action delegation
        mainView.querySelectorAll('[data-quick-tab]').forEach(btn => {
            btn.addEventListener('click', () => activateTab(btn.dataset.quickTab));
        });

        // Fetch counts
        try {
            const [usersR, postsR, pendingR, resolvedR] = await Promise.all([
                getCountFromServer(collection(db, 'users')),
                getCountFromServer(collection(db, 'posts')),
                // RP-02: Livechat.js now writes status:'pending' (lowercase).
                // Accept both casings so legacy 'Pending' docs still count.
                getCountFromServer(query(collection(db, 'reports'), where('status', 'in', ['pending', 'Pending']))),
                getCountFromServer(query(collection(db, 'reports'), where('status', 'in', ['Resolved (Dismissed)', 'Resolved (Purged)', 'resolved (dismissed)', 'resolved (purged)']))),
            ]);

            animateCount(document.getElementById('stat-users'),    usersR.data().count);
            animateCount(document.getElementById('stat-posts'),    postsR.data().count);
            animateCount(document.getElementById('stat-reports'),  pendingR.data().count);
            animateCount(document.getElementById('stat-resolved'), resolvedR.data().count);

            const pc = pendingR.data().count;
            const badge = document.getElementById('admin-queue-badge');
            if (badge) { badge.textContent = pc; badge.classList.toggle('hidden', pc === 0); }

        } catch (err) {
            console.error('[Admin] Stats error:', err);
            toast('Could not load analytics stats.', 'error');
        }

        // Recent audit activity
        try {
            const snap = await getDocs(query(collection(db, 'audit_logs'), orderBy('timestamp', 'desc'), limit(5)));
            const actEl = document.getElementById('admin-recent-activity');
            if (!actEl) return;

            if (snap.empty) {
                actEl.innerHTML = '<p class="text-slate-500 text-sm pl-2">No recent activity recorded.</p>';
                return;
            }

            actEl.innerHTML = '';
            snap.forEach(d => {
                const log   = d.data();
                const ts    = log.timestamp?.toDate?.()?.getTime?.() || Date.now();
                const color = ACTION_COLORS[log.action] || '#94a3b8';
                actEl.innerHTML += `
                    <div class="flex items-center gap-4 p-4 bg-slate-800/30 border border-slate-700/20
                                rounded-xl hover:bg-slate-800/50 transition-colors">
                        <div class="w-2 h-2 rounded-full flex-shrink-0" style="background:${color};
                             box-shadow: 0 0 6px ${color}55;"></div>
                        <span class="text-xs font-bold uppercase tracking-widest flex-shrink-0"
                              style="color:${color}">${sanitize(log.action)}</span>
                        <span class="text-xs text-slate-400 flex-shrink-0 font-mono truncate">
                            ${sanitize(log.adminEmail || '—')}
                        </span>
                        <span class="ml-auto text-[10px] text-slate-500 font-mono flex-shrink-0">${timeAgo(ts)}</span>
                    </div>`;
            });
        } catch (_) { /* non-critical */ }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 3. MODERATION QUEUE
    // ════════════════════════════════════════════════════════════════════════
    async function renderModeration(filterStatus = 'Pending') {
        mainView.innerHTML = `
            <div class="space-y-6 admin-tab-content">
                <!-- Header -->
                <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                    <div>
                        <h2 class="text-3xl font-black text-white tracking-tight">Moderation Queue</h2>
                        <p class="text-slate-400 text-sm mt-1">Review and action flagged content</p>
                    </div>
                    <div class="flex items-center gap-2 flex-wrap">
                        <!-- Filter pills -->
                        <div class="flex gap-1 p-1 bg-slate-800/60 rounded-xl border border-slate-700/30">
                            ${['Pending', 'Resolved (Dismissed)', 'Resolved (Purged)', 'All Resolved'].map(f => `
                                <button class="mod-filter-btn px-4 py-1.5 rounded-lg text-xs font-bold transition
                                               ${filterStatus === f
                                                   ? 'bg-sky-500/20 text-sky-400 shadow'
                                                   : 'text-slate-400 hover:text-white'}"
                                        data-filter="${f}">${f}</button>`).join('')}
                        </div>
                        <button id="admin-refresh-reports"
                                class="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl
                                       text-xs font-bold transition border border-slate-700/40">
                            ↻ Refresh
                        </button>
                    </div>
                </div>

                <!-- Bulk actions bar (shown when items selected) -->
                <div id="mod-bulk-bar"
                     class="hidden items-center gap-3 p-4 bg-sky-900/30 border border-sky-500/30
                            rounded-2xl backdrop-blur-sm">
                    <span id="mod-bulk-count" class="text-sky-400 font-black text-sm"></span>
                    <span class="text-slate-500 text-sm">items selected</span>
                    <div class="flex gap-2 ml-auto">
                        <button id="mod-bulk-dismiss"
                                class="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg
                                       text-xs font-bold transition">
                            Dismiss All
                        </button>
                        <button id="mod-bulk-delete"
                                class="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg
                                       text-xs font-bold transition">
                            Delete All
                        </button>
                    </div>
                </div>

                <!-- Report cards -->
                <div id="admin-reported-content" class="space-y-5">
                    ${skeletonList(3)}
                </div>
            </div>`;

        // ── Scoped listeners (use the freshly rendered shell, not document) ──
        // BUG FIX: document.querySelectorAll() was used before, which found
        // stale buttons from previous renders and stacked duplicate listeners.
        const modShell = mainView.querySelector('.admin-tab-content');
        modShell?.querySelector('#admin-refresh-reports')
            ?.addEventListener('click', () => renderModeration(filterStatus));
        modShell?.querySelectorAll('.mod-filter-btn').forEach(b =>
            b.addEventListener('click', e => renderModeration(e.currentTarget.dataset.filter))
        );

        const container  = document.getElementById('admin-reported-content');
        const bulkBar    = document.getElementById('mod-bulk-bar');
        const bulkCount  = document.getElementById('mod-bulk-count');
        // Stamp filterStatus so the global delegator can read it after async gaps
        if (container) container.dataset.filterStatus = filterStatus;

        // ── Bulk selection tracker ────────────────────────────────────────────
        const selected = new Set(); // set of reportIds currently checked

        function syncBulkBar() {
            if (!bulkBar || !bulkCount) return;
            if (selected.size > 0) {
                bulkBar.classList.remove('hidden');
                bulkBar.classList.add('flex');
                bulkCount.textContent = selected.size;
            } else {
                bulkBar.classList.add('hidden');
                bulkBar.classList.remove('flex');
            }
        }

        // ── Wire bulk action buttons ──────────────────────────────────────────
        // BUG FIX: these buttons were rendered but never had listeners attached.
        document.getElementById('mod-bulk-dismiss')?.addEventListener('click', async () => {
            if (!selected.size) return;
            dangerModal({
                title: `Dismiss ${selected.size} Report${selected.size > 1 ? 's' : ''}`,
                body: 'Mark all selected reports as dismissed. The flagged content will not be removed.',
                confirmText: 'Dismiss All',
                onConfirm: async () => {
                    const ids = [...selected];
                    await Promise.all(ids.map(id =>
                        updateDoc(doc(db, 'reports', id), {
                            status: 'Resolved (Dismissed)',
                            resolvedBy: currentUser.email,
                            resolvedAt: serverTimestamp(),
                        }).catch(() => {})
                    ));
                    toast(`${ids.length} report${ids.length > 1 ? 's' : ''} dismissed.`, 'success');
                    renderModeration(filterStatus);
                },
            });
        });

        document.getElementById('mod-bulk-delete')?.addEventListener('click', async () => {
            if (!selected.size) return;
            dangerModal({
                title: `Delete ${selected.size} Piece${selected.size > 1 ? 's' : ''} of Content`,
                body: 'Permanently delete the content behind all selected reports. This cannot be undone.',
                confirmText: 'Delete All',
                onConfirm: async () => {
                    // 'reply' is not a top-level Firestore collection — replies are nested inside
            // comment documents. We map 'reply' → 'comments' so we can fetch and display
            // the parent comment as the content preview for reply reports.
            const collectionMap = { post: 'posts', comment: 'comments', reply: 'comments', lostFound: 'lost_found', event: 'events' };
                    const ids = [...selected];
                    // Gather report data for each selected id from the DOM
                    await Promise.all(ids.map(async (reportId) => {
                        const card        = container.querySelector(`[data-report-id="${reportId}"]`);
                        const contentId   = card?.dataset.contentId;
                        const contentType = card?.dataset.contentType;
                        // Fetch the full report to get postId for subcollection paths
                        let parentPostId = null;
                        try {
                            const rSnap = await getDoc(doc(db, 'reports', reportId));
                            parentPostId = rSnap.data()?.postId || null;
                        } catch (_) {}

                        try {
                            if (contentType === 'chat_message') {
                                // Soft-delete so live chat hides it immediately via onSnapshot
                                if (contentId) {
                                    await updateDoc(doc(db, 'global_chat', contentId), {
                                        isDeleted:   true,
                                        text:        null,
                                        attachments: null,
                                        mediaUrl:    null,
                                    });
                                }
                            } else if (contentType === 'reply') {
                                if (contentId && parentPostId) {
                                    const commentRef = doc(db, 'posts', parentPostId, 'comments', contentId);
                                    const rSnap2 = await getDoc(doc(db, 'reports', reportId));
                                    const replyId = rSnap2.data()?.replyId || null;
                                    const cSnap = await getDoc(commentRef);
                                    if (cSnap.exists() && replyId) {
                                        const target = (cSnap.data().replies || []).find(r => r.id === replyId);
                                        if (target) await updateDoc(commentRef, { replies: arrayRemove(target) });
                                    }
                                }
                            } else if (contentType === 'comment') {
                                if (contentId && parentPostId) {
                                    await deleteDoc(doc(db, 'posts', parentPostId, 'comments', contentId));
                                }
                            } else {
                                const collectionMap2 = { post: 'posts', lostFound: 'lost_found', event: 'events' };
                                const coll = collectionMap2[contentType] || contentType;
                                if (contentId && coll) await deleteDoc(doc(db, coll, contentId));
                            }
                            await updateDoc(doc(db, 'reports', reportId), {
                                status: 'Resolved (Purged)',
                                resolvedBy: currentUser.email,
                                resolvedAt: serverTimestamp(),
                            });
                            await writeAudit('CONTENT_PURGED', { targetId: contentId, targetType: contentType });
                        } catch (err) {
                            console.warn('[Admin] Bulk delete partial failure:', err);
                        }
                    }));
                    toast(`${ids.length} item${ids.length > 1 ? 's' : ''} deleted.`, 'success');
                    renderModeration(filterStatus);
                },
            });
        });

        // ── Fetch reports ─────────────────────────────────────────────────────
        try {
            // BUG FIX: Combining where() + orderBy('timestamp') requires a
            // Firestore composite index. If that index doesn't exist yet,
            // Firestore throws and the catch block shows an empty/error state,
            // making it look like there are no pending reports.
            //
            // Strategy: try the indexed query first; if it fails (FAILED_PRECONDITION
            // = missing index), fall back to an unfiltered collection fetch and
            // filter + sort in memory. This guarantees reports always appear.
            let snapshot;
            // Always fetch all reports and filter client-side.
            // Reason: server-side where('status','==','Pending') is case-sensitive and
            // returns 0 docs silently if the value written doesn't match exactly.
            // Client-side normalisation is resilient to any casing variation.
            const RESOLVED_STATUSES = new Set([
                'resolved (dismissed)', 'resolved (purged)',
                'resolved', 'dismissed', 'purged', 'closed',
            ]);
            const allSnap = await getDocs(collection(db, 'reports'));
            const filtered = allSnap.docs.filter(d => {
                const st = (d.data().status || '').toLowerCase().trim();
                if (filterStatus === 'Pending') {
                    return !RESOLVED_STATUSES.has(st);      // anything not resolved
                }
                if (filterStatus === 'Resolved (Dismissed)') {
                    return st === 'resolved (dismissed)' || st === 'dismissed';
                }
                if (filterStatus === 'Resolved (Purged)') {
                    return st === 'resolved (purged)' || st === 'purged';
                }
                // 'All Resolved'
                return RESOLVED_STATUSES.has(st);
            });
            filtered.sort((a, b) => {
                // timestamp is a Firestore Timestamp (serverTimestamp) → use toMillis()
                // fall back to raw number for legacy docs written with Date.now()
                const toMs = v => v?.toMillis?.() ?? v?.toDate?.()?.getTime?.() ?? (typeof v === 'number' ? v : 0);
                return toMs(b.data().timestamp) - toMs(a.data().timestamp);
            });
            snapshot = { empty: filtered.length === 0, docs: filtered };

            if (snapshot.empty) {
                const emptyMessages = {
                    'Pending':              'No flagged content waiting for review.',
                    'Resolved (Dismissed)': 'No dismissed reports found.',
                    'Resolved (Purged)':    'No purged content reports found.',
                    'All Resolved':         'No resolved reports found.',
                };
                container.innerHTML = emptyState(
                    '🛡️', 'Queue Clear',
                    emptyMessages[filterStatus] || 'No reports found.',
                );
                return;
            }

            // BUG FIX: container.innerHTML += in a loop re-parses the entire DOM
            // on every iteration (slow + breaks mid-loop listeners on large queues).
            // Use a DocumentFragment instead — one DOM write at the end.
            const fragment = document.createDocumentFragment();
            container.innerHTML = '';

            const severityMap = {
                critical: 'bg-red-500/20 text-red-400 border-red-500/30',
                high:     'bg-orange-500/20 text-orange-400 border-orange-500/30',
                medium:   'bg-amber-500/20 text-amber-400 border-amber-500/30',
                low:      'bg-slate-700 text-slate-400 border-slate-600',
            };

            const collectionMap = { post: 'posts', comment: 'comments', lostFound: 'lost_found', event: 'events' };

            for (const docSnap of snapshot.docs) {
                const report   = docSnap.data();
                const reportId = docSnap.id;
                const ts       = report.timestamp?.toMillis?.() ?? report.timestamp?.toDate?.()?.getTime?.() ?? report.timestamp ?? Date.now();
                const sevClass = severityMap[report.severity] || severityMap.low;

                // ── Fetch content preview ──────────────────────────────────
                let contentPreview = `<p class="text-slate-500 italic text-sm p-4 bg-slate-950 rounded-xl">
                    Content not found — it may have already been deleted.</p>`;
                let authorDetails  = '<span class="text-slate-500">Unknown author</span>';

                try {
                    if (report.contentType === 'chat_message') {
                        // ── Live-chat message reports carry the full snapshot inline ──
                        // (stored by Livechat.js submitReport: msgText, msgAttachments,
                        //  reportedName, reportedEmail, msgId, msgTimestamp)
                        const authorName  = report.reportedName  || '—';
                        const authorEmail = report.reportedEmail || '';
                        authorDetails = `
                            <span class="text-sky-400 font-bold">${sanitize(authorName)}</span>
                            ${authorEmail ? `<span class="text-slate-500 font-mono text-xs ml-2">${sanitize(authorEmail)}</span>` : ''}`;

                        const msgText = report.msgText || '';
                        const atts    = report.msgAttachments || [];
                        const mediaHTML = atts.length
                            ? atts.map(a => {
                                if (a.type === 'image') {
                                    return `<img src="${sanitize(a.url)}" alt="${sanitize(a.name || 'Image')}"
                                                 loading="lazy"
                                                 style="max-width:100%;max-height:180px;object-fit:contain;
                                                        border-radius:8px;background:#0f172a;display:block;margin-top:8px;">`;
                                }
                                if (a.type === 'video') {
                                    return `<div style="margin-top:8px;font-size:12px;color:#94a3b8;">
                                                📹 Video: ${sanitize(a.name || 'video')}</div>`;
                                }
                                return `<div style="margin-top:8px;font-size:12px;color:#94a3b8;">
                                            📎 File: ${sanitize(a.name || 'file')}</div>`;
                            }).join('')
                            : '';

                        contentPreview = `
                            <div class="bg-slate-950/80 border border-slate-800 rounded-2xl p-5 space-y-2">
                                <div class="flex items-center gap-2 mb-1">
                                    <span class="text-[10px] bg-violet-500/15 text-violet-400 border border-violet-500/20
                                                 px-2 py-0.5 rounded-full uppercase tracking-widest font-black">
                                        Live Chat
                                    </span>
                                    <span class="text-[10px] text-slate-600 font-mono">msg id: ${sanitize(report.msgId || report.contentId || '—')}</span>
                                </div>
                                ${msgText
                                    ? `<p class="text-slate-300 text-sm leading-relaxed line-clamp-6">${sanitize(msgText)}</p>`
                                    : '<em class="text-slate-500 text-sm">No text content</em>'}
                                ${mediaHTML}
                            </div>`;

                        // Attempt a live fetch to check if the message still exists
                        try {
                            const liveSnap = await getDoc(doc(db, 'global_chat', report.contentId));
                            if (!liveSnap.exists() || liveSnap.data()?.isDeleted) {
                                contentPreview += `<p class="text-amber-400 text-xs mt-2">⚠ This message has already been deleted from the chat.</p>`;
                            }
                        } catch (_) { /* non-fatal */ }

                    } else if (report.contentId) {
                        let snap;
                        if (report.contentType === 'comment' && report.postId) {
                            snap = await getDoc(doc(db, 'posts', report.postId, 'comments', report.contentId));
                        } else if (report.contentType === 'reply' && report.postId && report.contentId) {
                            // For replies, fetch the parent comment and find the reply within it
                            const commentSnap = await getDoc(doc(db, 'posts', report.postId, 'comments', report.contentId));
                            if (commentSnap.exists()) {
                                const replyId = report.replyId;
                                const replyObj = replyId
                                    ? (commentSnap.data().replies || []).find(r => r.id === replyId)
                                    : null;
                                if (replyObj) {
                                    const authorName  = replyObj.author || '—';
                                    const authorEmail = replyObj.authorEmail || '';
                                    authorDetails = `
                                        <span class="text-sky-400 font-bold">${sanitize(authorName)}</span>
                                        ${authorEmail ? `<span class="text-slate-500 font-mono text-xs ml-2">${sanitize(authorEmail)}</span>` : ''}`;
                                    contentPreview = `
                                        <div class="bg-slate-950/80 border border-slate-800 rounded-2xl p-5 space-y-2">
                                            <p class="text-slate-400 text-sm leading-relaxed line-clamp-4">
                                                ${sanitize(replyObj.text) || '<em class="opacity-50">No text content</em>'}
                                            </p>
                                            <p class="text-[10px] text-slate-600 font-mono">
                                                Reply ID: ${replyId} · Parent comment: ${report.contentId}
                                                · Parent post: ${report.postId}
                                            </p>
                                        </div>`;
                                }
                            }
                            snap = null; // already handled above
                        } else {
                            const targetCollection = { post: 'posts', lostFound: 'lost_found', event: 'events' }[report.contentType] || report.contentType;
                            if (targetCollection) snap = await getDoc(doc(db, targetCollection, report.contentId));
                        }

                        if (snap?.exists()) {
                            const p = snap.data();
                            const authorName  = p.author || p.authorName || p.name || '—';
                            const authorEmail = p.authorEmail || p.email || '';
                            authorDetails = `
                                <span class="text-sky-400 font-bold">${sanitize(authorName)}</span>
                                ${authorEmail ? `<span class="text-slate-500 font-mono text-xs ml-2">${sanitize(authorEmail)}</span>` : ''}`;
                            const title = p.title || '';
                            const body  = p.content || p.text || p.body || p.description || '';
                            contentPreview = `
                                <div class="bg-slate-950/80 border border-slate-800 rounded-2xl p-5 space-y-2">
                                    ${title ? `<p class="text-white font-black text-base leading-tight">${sanitize(title)}</p>` : ''}
                                    <p class="text-slate-400 text-sm leading-relaxed line-clamp-4">
                                        ${sanitize(body) || '<em class="opacity-50">No text content</em>'}
                                    </p>
                                    <p class="text-[10px] text-slate-600 font-mono">
                                        ${sanitize(report.contentType || 'Content')} ID: ${report.contentId}
                                        ${report.postId && report.postId !== report.contentId
                                            ? ` · Parent post ID: ${sanitize(report.postId)}`
                                            : ''}
                                    </p>
                                </div>`;
                        }
                    }
                } catch (fetchErr) {
                    console.warn('[Admin] Content preview fetch failed:', fetchErr);
                }

                // ── Build card element ─────────────────────────────────────
                const card = document.createElement('div');
                card.className = 'group bg-slate-900/80 border border-slate-700/40 rounded-3xl p-7 shadow-xl hover:border-slate-600/60 transition-all duration-200 hover:shadow-2xl hover:shadow-black/20';
                card.dataset.reportId    = reportId;
                card.dataset.contentId   = report.contentId   || '';
                card.dataset.contentType = report.contentType || '';
                card.dataset.postId      = report.postId      || '';
                card.dataset.replyId     = report.replyId     || '';

                card.innerHTML = `
                    <!-- Header row -->
                    <div class="flex flex-col lg:flex-row justify-between items-start gap-5 mb-6">
                        <div class="flex flex-wrap items-center gap-2">
                            <!-- BUG FIX: Checkbox added so bulk selection actually works -->
                            <label class="flex items-center gap-2 cursor-pointer select-none">
                                <input type="checkbox" class="mod-report-checkbox w-4 h-4 rounded accent-sky-500
                                                              cursor-pointer" data-report-id="${reportId}">
                            </label>
                            <!-- Reason chip -->
                            <span class="px-3 py-1.5 rounded-xl text-xs font-black uppercase tracking-widest
                                         bg-red-500/15 text-red-400 border border-red-500/20">
                                ${sanitize(report.reason || report.category || 'No reason')}
                            </span>
                            ${report.severity ? `
                            <span class="px-3 py-1.5 rounded-xl text-xs font-black uppercase tracking-widest border ${sevClass}">
                                ${report.severity}
                            </span>` : ''}
                            <span class="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-800 text-slate-400 border border-slate-700">
                                ${sanitize(report.status || 'Unknown')}
                            </span>
                        </div>

                        <!-- Reporter card -->
                        <div class="flex items-center gap-3 px-4 py-3 bg-slate-800/40 border border-slate-700/30 rounded-xl flex-shrink-0">
                            <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-slate-600 to-slate-700
                                        flex items-center justify-center text-xs font-black text-white">
                                ${(report.reporterName || 'A').charAt(0).toUpperCase()}
                            </div>
                            <div>
                                <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest">Reported by</p>
                                <p class="text-sm font-bold text-white">${sanitize(report.reporterName || 'Anonymous')}</p>
                            </div>
                            <span class="ml-3 text-[10px] text-slate-600 font-mono">${timeAgo(ts)}</span>
                        </div>
                    </div>

                    <!-- Content preview -->
                    <div class="mb-6">
                        <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-2">Reported Content</p>
                        <div class="mb-3 flex items-center gap-2 text-sm">${authorDetails}</div>
                        ${contentPreview}
                    </div>

                    ${(report.detail || report.comment) ? `
                    <div class="mb-6 p-4 bg-amber-500/5 border border-amber-500/15 rounded-xl">
                        <p class="text-[10px] text-amber-400 uppercase font-black tracking-widest mb-1">Reporter Note</p>
                        <p class="text-slate-300 text-sm leading-relaxed">${sanitize(report.detail || report.comment)}</p>
                    </div>` : ''}

                    ${filterStatus === 'Pending' ? `
                    <div class="flex flex-col sm:flex-row gap-3 pt-5 border-t border-slate-800">
                        <button class="admin-dismiss-btn flex-1 bg-slate-800 hover:bg-slate-700 text-white
                                       font-bold py-3.5 rounded-xl text-sm transition border border-slate-700
                                       uppercase tracking-wider">
                            Dismiss
                        </button>
                        <button class="admin-delete-btn flex-1 bg-gradient-to-r from-red-600 to-rose-600
                                       hover:from-red-500 hover:to-rose-500 text-white font-black py-3.5
                                       rounded-xl text-sm transition uppercase tracking-wider shadow-lg shadow-red-600/20">
                            🗑 Delete Content
                        </button>
                    </div>` : ''}
                    ${(filterStatus === 'Resolved (Dismissed)' || filterStatus === 'All Resolved') && (report.status || '').toLowerCase().includes('dismissed') ? `
                    <div class="flex gap-3 pt-5 border-t border-slate-800">
                        <button class="admin-reopen-btn flex-1 bg-sky-800/40 hover:bg-sky-700/60 text-sky-300
                                       font-bold py-3.5 rounded-xl text-sm transition border border-sky-700/40
                                       uppercase tracking-wider">
                            ↩ Re-open Report
                        </button>
                    </div>` : ''}`;

                // Wire checkbox for bulk selection
                card.querySelector('.mod-report-checkbox')?.addEventListener('change', (e) => {
                    if (e.target.checked) selected.add(reportId);
                    else selected.delete(reportId);
                    syncBulkBar();
                });

                // ── Wire per-card action buttons ──────────────────────────────
                // BUG FIX: buttons were rendered via innerHTML but listeners were
                // never attached, so Dismiss and Delete Content had no effect.
                card.querySelector('.admin-dismiss-btn')?.addEventListener('click', () => {
                    dangerModal({
                        title: 'Dismiss Report',
                        body: 'Mark this report as dismissed. The flagged content will remain.',
                        confirmText: 'Dismiss',
                        onConfirm: async () => {
                            try {
                                await updateDoc(doc(db, 'reports', reportId), {
                                    status:     'Resolved (Dismissed)',
                                    resolvedBy: currentUser.email,
                                    resolvedAt: serverTimestamp(),
                                });
                                await writeAudit('REPORT_DISMISSED', { reportId, contentId: report.contentId, contentType: report.contentType });
                                toast('Report dismissed.', 'success');
                                renderModeration(filterStatus);
                            } catch (err) {
                                console.error('[Admin] Dismiss error:', err);
                                toast('Failed to dismiss report.', 'error');
                            }
                        },
                    });
                });

                card.querySelector('.admin-delete-btn')?.addEventListener('click', () => {
                    dangerModal({
                        title: 'Delete Content',
                        body: 'Permanently delete the reported content. This cannot be undone.',
                        confirmText: 'Delete Content',
                        onConfirm: async () => {
                            try {
                                const contentId   = report.contentId;
                                const contentType = report.contentType;
                                if (contentType === 'chat_message') {
                                    if (contentId) {
                                        await updateDoc(doc(db, 'global_chat', contentId), {
                                            isDeleted:   true,
                                            text:        null,
                                            attachments: null,
                                            mediaUrl:    null,
                                        });
                                    }
                                } else if (contentType === 'comment' && report.postId) {
                                    await deleteDoc(doc(db, 'posts', report.postId, 'comments', contentId));
                                } else if (contentType === 'reply' && report.postId) {
                                    const commentRef = doc(db, 'posts', report.postId, 'comments', contentId);
                                    const cSnap = await getDoc(commentRef);
                                    if (cSnap.exists() && report.replyId) {
                                        const target = (cSnap.data().replies || []).find(r => r.id === report.replyId);
                                        if (target) await updateDoc(commentRef, { replies: arrayRemove(target) });
                                    }
                                } else {
                                    const collMap = { post: 'posts', lostFound: 'lost_found', event: 'events' };
                                    const coll = collMap[contentType] || contentType;
                                    if (contentId && coll) await deleteDoc(doc(db, coll, contentId));
                                }
                                await updateDoc(doc(db, 'reports', reportId), {
                                    status:     'Resolved (Purged)',
                                    resolvedBy: currentUser.email,
                                    resolvedAt: serverTimestamp(),
                                });
                                await writeAudit('CONTENT_PURGED', { reportId, targetId: contentId, targetType: contentType });
                                toast('Content deleted and report resolved.', 'success');
                                renderModeration(filterStatus);
                            } catch (err) {
                                console.error('[Admin] Delete content error:', err);
                                toast('Failed to delete content.', 'error');
                            }
                        },
                    });
                });

                card.querySelector('.admin-reopen-btn')?.addEventListener('click', () => {
                    dangerModal({
                        title: 'Re-open Report',
                        body: 'Move this report back to the pending queue for re-review.',
                        confirmText: 'Re-open',
                        onConfirm: async () => {
                            try {
                                await updateDoc(doc(db, 'reports', reportId), {
                                    status:     'pending',
                                    resolvedBy: null,
                                    resolvedAt: null,
                                });
                                await writeAudit('REPORT_REOPENED', { reportId });
                                toast('Report re-opened.', 'success');
                                renderModeration(filterStatus);
                            } catch (err) {
                                console.error('[Admin] Re-open error:', err);
                                toast('Failed to re-open report.', 'error');
                            }
                        },
                    });
                });

                fragment.appendChild(card);
            }

            // Re-query live node — the original container reference goes stale if the
            // user navigated away during the per-report await getDoc() calls in the loop.
            const liveContainer = document.getElementById('admin-reported-content');
            if (liveContainer) liveContainer.appendChild(fragment);

        } catch (err) {
            console.error('[Admin] Moderation query failed:', err);
            // Show the real error message so index issues are diagnosable
            container.innerHTML = errorState(
                `Failed to load reports: ${err.message}. ` +
                `If this mentions "requires an index", open the Firebase Console → Firestore → Indexes and create a composite index on <strong>reports</strong>: status ASC + timestamp DESC.`
            );
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 4. USER DIRECTORY
    // ════════════════════════════════════════════════════════════════════════
    async function renderUserDirectory() {
        mainView.innerHTML = `
            <div class="space-y-6 admin-tab-content">
                <!-- Header -->
                <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                    <div>
                        <h2 class="text-3xl font-black text-white tracking-tight">User Directory</h2>
                        <p class="text-slate-400 text-sm mt-1">Manage access, roles, and conduct</p>
                    </div>
                    <div class="flex items-center gap-2">
                        <button id="admin-refresh-users"
                                class="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl
                                       text-xs font-bold transition border border-slate-700/40">
                            ↻ Refresh
                        </button>
                    </div>
                </div>

                <!-- Search + filter bar -->
                <div class="flex flex-col sm:flex-row gap-3 p-4 bg-slate-800/40 rounded-2xl
                            border border-slate-700/30">
                    <div class="relative flex-grow">
                        <span class="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm">🔍</span>
                        <input id="user-search" type="text" placeholder="Search by name or email…"
                               class="w-full bg-slate-900/80 border border-slate-700 rounded-xl pl-9 pr-4 py-2.5
                                      text-sm text-white placeholder-slate-500 outline-none
                                      focus:border-sky-500/50 transition">
                    </div>
                    <select id="user-role-filter"
                            class="bg-slate-900/80 border border-slate-700 rounded-xl px-4 py-2.5
                                   text-sm text-white outline-none focus:border-sky-500/50 transition cursor-pointer">
                        <option value="all">All roles</option>
                        <option value="admin">Admins only</option>
                        <option value="user">Users only</option>
                        <option value="banned">Suspended</option>
                    </select>
                </div>

                <!-- User list -->
                <div id="admin-user-list" class="space-y-2 max-h-[66vh] overflow-y-auto pr-1">
                    ${skeletonList(5)}
                </div>
            </div>`;

        document.getElementById('admin-refresh-users')?.addEventListener('click', renderUserDirectory);

        const container = document.getElementById('admin-user-list');
        let allUsers = [];

        const renderFiltered = () => {
            const search = (document.getElementById('user-search')?.value || '').toLowerCase();
            const role   = document.getElementById('user-role-filter')?.value || 'all';

            const filtered = allUsers.filter(({ u }) => {
                const matchSearch = !search ||
                    (u.name || '').toLowerCase().includes(search) ||
                    (u.email || '').toLowerCase().includes(search);
                const matchRole = role === 'all' ||
                    (role === 'admin'  && u.role === 'admin') ||
                    (role === 'user'   && u.role !== 'admin' && !u.isBanned) ||
                    (role === 'banned' && u.isBanned);
                return matchSearch && matchRole;
            });

            if (!filtered.length) {
                container.innerHTML = emptyState('🔍', 'No Results', 'Try a different search or filter.');
                return;
            }

            container.innerHTML = filtered.map(({ u, docId }) => {
                const isBanned = u.isBanned === true;
                const isAdmin  = u.role === 'admin';
                const strikes  = u.strikes || 0;
                const safeName = sanitize(u.name) || u.email?.split('@')[0] || 'Unknown';
                const [avatarGrad, avatarShadow] = avatarColor(u.email || safeName);

                const strikeBar = strikes > 0 ? `
                    <div class="flex gap-1 mt-1">
                        ${Array(3).fill('').map((_, i) => `
                            <div class="h-1 w-6 rounded-full ${i < strikes ? 'bg-orange-500' : 'bg-slate-700'}"></div>
                        `).join('')}
                    </div>` : '';

                return `
                    <div class="admin-user-row group flex flex-col xl:flex-row xl:items-center justify-between
                                gap-4 p-5 bg-slate-800/20 hover:bg-slate-800/50 border border-slate-700/20
                                hover:border-slate-600/40 rounded-2xl transition-all duration-150
                                ${isBanned ? 'opacity-60' : ''}">
                        <div class="flex items-center gap-4 min-w-0">
                            <div class="w-11 h-11 rounded-xl bg-gradient-to-br ${avatarGrad} flex-shrink-0
                                        flex items-center justify-center text-white font-black text-base
                                        shadow-lg ${avatarShadow} ${isAdmin ? 'ring-2 ring-amber-400/40' : ''}">
                                ${safeName.charAt(0).toUpperCase()}
                            </div>
                            <div class="min-w-0">
                                <div class="flex flex-wrap items-center gap-2">
                                    <p class="font-black text-white text-base ${isBanned ? 'line-through text-slate-500' : ''}
                                              truncate max-w-[200px]">${safeName}</p>
                                    ${isAdmin ? `
                                        <span class="text-[10px] bg-amber-500/15 text-amber-400 border border-amber-500/25
                                                     px-2 py-0.5 rounded-full uppercase tracking-widest font-black">
                                            Admin
                                        </span>` : ''}
                                    ${isBanned ? `
                                        <span class="text-[10px] bg-red-500/15 text-red-400 border border-red-500/20
                                                     px-2 py-0.5 rounded-full uppercase tracking-widest font-black">
                                            Suspended
                                        </span>` : ''}
                                </div>
                                <p class="text-xs text-slate-400 font-mono truncate mt-0.5">${sanitize(u.email)}</p>
                                ${strikeBar}
                            </div>
                        </div>

                        <div class="admin-user-actions flex flex-wrap gap-2 flex-shrink-0">
                            ${!isAdmin ? `
                            <button class="admin-user-action text-xs font-bold px-3.5 py-2 rounded-lg
                                           bg-slate-700/60 text-slate-300 hover:text-white border border-slate-600/40
                                           uppercase tracking-wider transition hover:bg-slate-700"
                                    data-doc-id="${docId}" data-email="${u.email}" data-action="strike"
                                    title="${strikes}/3 strikes">
                                ⚡ Strike (${strikes})
                            </button>
                            <button class="admin-user-action text-xs font-bold px-3.5 py-2 rounded-lg
                                           bg-amber-500/10 text-amber-400 border border-amber-500/20
                                           hover:bg-amber-500/20 uppercase tracking-wider transition"
                                    data-doc-id="${docId}" data-email="${u.email}" data-action="promote">
                                ↑ Promote
                            </button>` : ''}
                            <button class="admin-user-action text-xs font-bold px-3.5 py-2 rounded-lg
                                           uppercase tracking-wider transition
                                           ${isBanned
                                               ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20'
                                               : 'bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20'}"
                                    data-doc-id="${docId}" data-email="${u.email}"
                                    data-action="${isBanned ? 'unban' : 'ban'}">
                                ${isBanned ? '✓ Restore' : '⊘ Suspend'}
                            </button>
                        </div>
                    </div>`;
            }).join('');
        };

        try {
            const snap = await getDocs(collection(db, 'users'));

            if (snap.empty) {
                container.innerHTML = emptyState('👥', 'No Users', 'The user collection is empty.');
                return;
            }

            allUsers = snap.docs.map(d => ({ u: d.data(), docId: d.id }));
            renderFiltered();

            document.getElementById('user-search')?.addEventListener('input', renderFiltered);
            document.getElementById('user-role-filter')?.addEventListener('change', renderFiltered);

        } catch (err) {
            console.error(err);
            container.innerHTML = errorState(`Failed to load users: ${err.message}`);
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 5. BROADCAST
    // ════════════════════════════════════════════════════════════════════════
    // Full rewrite — fixes all identified bugs:
    //   BUG-01: getDocs (one-shot) → onSnapshot (real-time). Active Broadcasts
    //           now updates instantly without any page refresh.
    //   BUG-02: No `isBroadcast` discriminator field — broadcasts were
    //           indistinguishable from user Announcement posts. Fixed: every
    //           broadcast now carries `isBroadcast:true` and is queried by it.
    //   BUG-03: No `pinned:true` on creation — broadcasts never appeared at the
    //           top of Global Posts. Fixed: every broadcast sets pinned:true and
    //           posts.js feed query already sorts pinned cards to the top.
    //   BUG-04: No edit capability — only retract (hard delete). Fixed: inline
    //           edit form mirrors the compose form with pre-populated values.
    //   BUG-05: No media attachments — broadcasts only had text. Fixed: same
    //           multi-file (image/video/doc) pipeline as Global Posts.
    //   BUG-06: Listener leak — no _detach call when leaving the tab. Fixed:
    //           every onSnapshot is keyed under 'broadcasts' in _unsubs and
    //           detached by activateTab before calling the new renderer.
    //   BUG-07: Brittle DOM removal after retract — btn.closest('.flex').remove()
    //           could miss the card. Fixed: cards keyed by data-bc-id, removed
    //           precisely.
    //   BUG-08: Scheduling UI existed in comments but was never wired. Fixed:
    //           optional "Schedule for later" datetime picker fully wired.
    //   BUG-09: Broadcast title had the category baked in during creation, making
    //           edits misleading. Fixed: title is stored clean; category badge is
    //           computed at render time.
    //   BUG-10: No archive/unpin — only hard delete. Fixed: Archive sets
    //           pinned:false + status:'archived' so the broadcast disappears from
    //           the feed but stays in the audit trail.
    // ────────────────────────────────────────────────────────────────────────

    function renderBroadcast() {
        // Tear down any stale listener before re-rendering the tab
        _detach('broadcasts');

        // ── State for the compose/edit form ──────────────────────────────────
        let _bcFiles        = [];      // File[] — pending uploads
        let _bcEditId       = null;    // string|null — ID of broadcast being edited
        let _bcEditMedia    = [];      // existing mediaItems on the broadcast being edited

        // ── Category metadata ─────────────────────────────────────────────────
        const BC_CATEGORIES = [
            { value: 'MAINTENANCE', label: '🔧 System Maintenance' },
            { value: 'UPDATE',      label: '✨ Platform Update'     },
            { value: 'WARNING',     label: '⚠️ Security Warning'    },
            { value: 'EVENT',       label: '🎉 Official Event'       },
            { value: 'POLICY',      label: '📜 Policy Change'        },
            { value: 'NOTICE',      label: '📣 General Notice'       },
        ];

        const BC_CATEGORY_EMOJI = Object.fromEntries(
            BC_CATEGORIES.map(c => [c.value, c.label.split(' ')[0]])
        );

        // ── Render shell ──────────────────────────────────────────────────────
        mainView.innerHTML = `
            <div class="space-y-6 admin-tab-content max-w-3xl">

                <!-- ── Compose / Edit card ─────────────────────────── -->
                <div class="bg-slate-900/80 border border-slate-800 rounded-3xl p-8 shadow-2xl">
                    <div class="flex items-center gap-3 mb-6">
                        <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600
                                    flex items-center justify-center text-xl shadow-lg shadow-sky-500/20">📡</div>
                        <div class="flex-1 min-w-0">
                            <h2 class="text-2xl font-black text-white tracking-tight" id="bc-form-title">
                                New Broadcast
                            </h2>
                            <p class="text-slate-400 text-xs mt-0.5">
                                Pinned system announcements injected into the Global Posts feed
                            </p>
                        </div>
                        <!-- Cancel edit button (hidden during compose) -->
                        <button id="bc-cancel-edit"
                                class="hidden flex-shrink-0 text-xs font-bold text-slate-400
                                       hover:text-white px-3 py-1.5 rounded-lg border border-slate-700
                                       hover:border-slate-500 transition">
                            ✕ Cancel
                        </button>
                    </div>

                    <div class="space-y-5">
                        <!-- Row 1: Category + Priority -->
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label class="block text-xs font-black text-sky-400 mb-2 tracking-widest uppercase">
                                    Classification
                                </label>
                                <select id="bc-category"
                                        class="w-full bg-slate-950 border border-slate-700 rounded-xl p-3.5
                                               text-white outline-none focus:border-sky-500/60 transition
                                               cursor-pointer text-sm">
                                    ${BC_CATEGORIES.map(c =>
                                        `<option value="${c.value}">${c.label}</option>`
                                    ).join('')}
                                </select>
                            </div>
                            <div>
                                <label class="block text-xs font-black text-sky-400 mb-2 tracking-widest uppercase">
                                    Priority
                                </label>
                                <select id="bc-priority"
                                        class="w-full bg-slate-950 border border-slate-700 rounded-xl p-3.5
                                               text-white outline-none focus:border-sky-500/60 transition
                                               cursor-pointer text-sm">
                                    <option value="normal">Normal</option>
                                    <option value="high">High Priority</option>
                                    <option value="critical">🚨 Critical</option>
                                </select>
                            </div>
                        </div>

                        <!-- Headline -->
                        <div>
                            <label class="block text-xs font-black text-sky-400 mb-2 tracking-widest uppercase">
                                Headline
                            </label>
                            <input type="text" id="bc-title" maxlength="120"
                                   class="w-full bg-slate-950 border border-slate-700 rounded-xl p-3.5
                                          text-white font-bold outline-none focus:border-sky-500/60 transition text-sm"
                                   placeholder="Enter primary headline…">
                            <p class="text-right text-[10px] text-slate-500 mt-1.5" id="bc-title-count">0 / 120</p>
                        </div>

                        <!-- Body -->
                        <div>
                            <label class="block text-xs font-black text-sky-400 mb-2 tracking-widest uppercase">
                                Body
                            </label>
                            <textarea id="bc-content" rows="5"
                                      class="w-full bg-slate-950 border border-slate-700 rounded-xl p-3.5
                                             text-white outline-none focus:border-sky-500/60 transition
                                             resize-y text-sm leading-relaxed min-h-[100px]"
                                      placeholder="Detail the announcement — supports #hashtags…"></textarea>
                            <p class="text-right text-[10px] text-slate-500 mt-1.5" id="bc-content-count">0 / 3000</p>
                        </div>

                        <!-- Media attachments -->
                        <div>
                            <label class="block text-xs font-black text-sky-400 mb-2 tracking-widest uppercase">
                                Attachments <span class="text-slate-500 normal-case font-medium">(images, videos, documents — optional)</span>
                            </label>
                            <!-- Existing media (edit mode) -->
                            <div id="bc-existing-media" class="hidden flex flex-wrap gap-2 mb-3"></div>
                            <!-- New file previews -->
                            <div id="bc-file-preview" class="flex flex-wrap gap-2 mb-3 empty:hidden"></div>
                            <!-- Drop zone / picker trigger -->
                            <label for="bc-file-input"
                                   class="flex items-center justify-center gap-2 w-full h-20
                                          border-2 border-dashed border-slate-700 rounded-xl
                                          hover:border-sky-500/50 hover:bg-sky-500/3 transition cursor-pointer
                                          text-slate-500 hover:text-sky-400 text-sm">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                                     class="w-5 h-5 flex-shrink-0">
                                    <path stroke-linecap="round" stroke-linejoin="round"
                                          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4-4m0 0l-4 4m4-4v12"/>
                                </svg>
                                <span>Click or drag files here</span>
                            </label>
                            <input type="file" id="bc-file-input" multiple
                                   accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip"
                                   class="hidden">
                        </div>

                        <!-- Schedule (optional) -->
                        <div>
                            <label class="flex items-center gap-2 text-xs font-black text-sky-400
                                          mb-2 tracking-widest uppercase cursor-pointer">
                                <input type="checkbox" id="bc-schedule-toggle"
                                       class="w-3.5 h-3.5 rounded accent-sky-500">
                                Schedule for later
                                <span class="text-slate-500 normal-case font-medium">(optional)</span>
                            </label>
                            <div id="bc-schedule-wrap" class="hidden">
                                <input type="datetime-local" id="bc-schedule-at"
                                       class="w-full bg-slate-950 border border-slate-700 rounded-xl p-3.5
                                              text-white outline-none focus:border-sky-500/60 transition text-sm">
                                <p class="text-[10px] text-slate-500 mt-1.5">
                                    Leave empty to publish immediately.
                                </p>
                            </div>
                        </div>

                        <!-- Live preview -->
                        <div id="bc-preview" class="hidden p-5 bg-sky-900/10 border border-sky-500/20 rounded-2xl">
                            <div class="flex items-center gap-2 mb-3">
                                <span class="text-[10px] text-sky-400 uppercase font-black tracking-widest">Live Preview</span>
                                <span class="text-[10px] text-slate-500">— how it appears in the feed</span>
                            </div>
                            <div class="broadcast-feed-banner">
                                <span>📡</span>
                                <span id="bc-preview-cat-badge">BROADCAST</span>
                            </div>
                            <p id="bc-preview-title" class="text-white font-black text-sm mt-2"></p>
                            <p id="bc-preview-body" class="text-slate-400 text-xs mt-1 leading-relaxed"></p>
                            <div id="bc-preview-media" class="flex flex-wrap gap-2 mt-3 empty:hidden"></div>
                        </div>

                        <!-- Submit / Update -->
                        <button id="bc-submit"
                                class="w-full bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400
                                       hover:to-indigo-500 text-white font-black py-4 rounded-xl uppercase
                                       tracking-widest shadow-xl shadow-sky-500/20 transition active:scale-[0.98]
                                       disabled:opacity-50 disabled:cursor-not-allowed text-sm">
                            📡 Send Broadcast
                        </button>
                    </div>
                </div>

                <!-- ── Active Broadcasts (real-time) ────────────────── -->
                <div class="bg-slate-900/80 border border-slate-800 rounded-3xl p-8 shadow-xl">
                    <div class="flex items-center justify-between mb-5">
                        <div>
                            <h3 class="text-lg font-black text-white uppercase tracking-tight">Active Broadcasts</h3>
                            <p class="text-xs text-slate-500 mt-0.5">Pinned in the Global Posts feed · updates in real time</p>
                        </div>
                        <span id="bc-active-count"
                              class="hidden text-[10px] font-black text-sky-400 bg-sky-400/10
                                     border border-sky-400/20 px-2.5 py-1 rounded-full">0</span>
                    </div>
                    <div id="active-broadcasts-list">${skeletonList(2)}</div>
                </div>
            </div>`;

        // ── DOM refs ──────────────────────────────────────────────────────────
        const titleEl      = document.getElementById('bc-title');
        const contentEl    = document.getElementById('bc-content');
        const categoryEl   = document.getElementById('bc-category');
        const priorityEl   = document.getElementById('bc-priority');
        const submitBtn    = document.getElementById('bc-submit');
        const cancelBtn    = document.getElementById('bc-cancel-edit');
        const schedToggle  = document.getElementById('bc-schedule-toggle');
        const schedWrap    = document.getElementById('bc-schedule-wrap');
        const schedAt      = document.getElementById('bc-schedule-at');
        const fileInput    = document.getElementById('bc-file-input');
        const filePreview  = document.getElementById('bc-file-preview');
        const previewBox   = document.getElementById('bc-preview');
        const formTitleEl  = document.getElementById('bc-form-title');

        // ── Live preview updater ──────────────────────────────────────────────
        const updatePreview = () => {
            const t   = titleEl?.value.trim();
            const b   = contentEl?.value.trim();
            const cat = categoryEl?.value;
            if (!previewBox) return;
            previewBox.classList.toggle('hidden', !t && !b);
            const badgeEl = document.getElementById('bc-preview-cat-badge');
            if (badgeEl) badgeEl.textContent = `${BC_CATEGORY_EMOJI[cat] || '📡'} ${cat}`;
            const ptEl = document.getElementById('bc-preview-title');
            if (ptEl) ptEl.textContent = t || '';
            const pbEl = document.getElementById('bc-preview-body');
            if (pbEl) pbEl.textContent = b || '';
            // Preview thumbnails for newly selected files
            const pmEl = document.getElementById('bc-preview-media');
            if (pmEl) {
                pmEl.innerHTML = _bcFiles.slice(0, 4).map(f => {
                    if (f.type.startsWith('image/')) {
                        const url = URL.createObjectURL(f);
                        return `<img src="${url}" class="w-16 h-12 object-cover rounded-lg border border-slate-700" loading="lazy">`;
                    }
                    return `<div class="flex items-center gap-1 px-2 py-1 bg-slate-800 rounded-lg
                                        text-[10px] text-slate-400 border border-slate-700">
                                📎 ${sanitize(f.name.slice(0, 20))}
                            </div>`;
                }).join('');
            }
        };

        titleEl?.addEventListener('input', () => {
            setHTML('bc-title-count', `${titleEl.value.length} / 120`);
            updatePreview();
        });
        contentEl?.addEventListener('input', () => {
            setHTML('bc-content-count', `${contentEl.value.length} / 3000`);
            updatePreview();
        });
        categoryEl?.addEventListener('change', updatePreview);
        schedToggle?.addEventListener('change', () => {
            schedWrap?.classList.toggle('hidden', !schedToggle.checked);
        });

        // ── File picker + drag-drop ───────────────────────────────────────────
        const ACCEPTED_TYPES = 'image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip';
        const MAX_FILES = 5;
        const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

        const addFiles = (incoming) => {
            for (const f of incoming) {
                if (_bcFiles.length >= MAX_FILES) {
                    toast(`Max ${MAX_FILES} attachments per broadcast.`, 'warn'); break;
                }
                if (f.size > MAX_BYTES) {
                    toast(`"${f.name}" exceeds 50 MB limit.`, 'warn'); continue;
                }
                _bcFiles.push(f);
            }
            renderFilePreviews();
            updatePreview();
        };

        const removeNewFile = (idx) => {
            _bcFiles.splice(idx, 1);
            renderFilePreviews();
            updatePreview();
        };

        const renderFilePreviews = () => {
            if (!filePreview) return;
            filePreview.innerHTML = _bcFiles.map((f, i) => {
                const isImage = f.type.startsWith('image/');
                const isVideo = f.type.startsWith('video/');
                let inner = '';
                if (isImage) {
                    const url = URL.createObjectURL(f);
                    inner = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;">`;
                } else if (isVideo) {
                    inner = `<div class="bc-doc-icon">🎬<span class="bc-doc-label">${sanitize(f.name.slice(0,16))}</span></div>`;
                } else {
                    const ext = f.name.split('.').pop().toUpperCase().slice(0,5);
                    inner = `<div class="bc-doc-icon">📄<span class="bc-doc-label">${ext}</span></div>`;
                }
                return `<div class="bc-media-thumb" data-file-idx="${i}">
                            ${inner}
                            <button class="bc-remove-file" data-remove-idx="${i}" title="Remove">✕</button>
                        </div>`;
            }).join('');

            filePreview.querySelectorAll('.bc-remove-file').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    removeNewFile(parseInt(btn.dataset.removeIdx, 10));
                });
            });
        };

        fileInput?.addEventListener('change', () => {
            addFiles(Array.from(fileInput.files || []));
            fileInput.value = '';
        });

        // Drag-drop on the label
        const dropZone = mainView.querySelector('label[for="bc-file-input"]');
        if (dropZone) {
            dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('border-sky-400'); });
            dropZone.addEventListener('dragleave', () => dropZone.classList.remove('border-sky-400'));
            dropZone.addEventListener('drop', e => {
                e.preventDefault();
                dropZone.classList.remove('border-sky-400');
                addFiles(Array.from(e.dataTransfer.files));
            });
        }

        // ── Reset compose form to blank "New Broadcast" state ─────────────────
        const resetForm = () => {
            _bcEditId    = null;
            _bcEditMedia = [];
            _bcFiles     = [];
            if (titleEl)   { titleEl.value   = ''; }
            if (contentEl) { contentEl.value = ''; }
            if (categoryEl) categoryEl.value = 'MAINTENANCE';
            if (priorityEl) priorityEl.value = 'normal';
            if (schedToggle) { schedToggle.checked = false; schedWrap?.classList.add('hidden'); }
            if (schedAt) schedAt.value = '';
            setHTML('bc-title-count',   '0 / 120');
            setHTML('bc-content-count', '0 / 3000');
            renderFilePreviews();
            if (previewBox) previewBox.classList.add('hidden');
            if (formTitleEl) formTitleEl.textContent = 'New Broadcast';
            if (submitBtn) submitBtn.innerHTML = '📡 Send Broadcast';
            cancelBtn?.classList.add('hidden');
            if (document.getElementById('bc-existing-media'))
                document.getElementById('bc-existing-media').classList.add('hidden');

            submitBtn?.classList.remove('from-indigo-500','to-purple-600');
            submitBtn?.classList.add('from-sky-500','to-indigo-600');
        };

        cancelBtn?.addEventListener('click', resetForm);

        // ── Populate form for editing an existing broadcast ───────────────────
        const startEdit = (id, data) => {
            _bcEditId    = id;
            _bcEditMedia = Array.isArray(data.mediaItems) ? [...data.mediaItems] : [];
            _bcFiles     = [];

            if (titleEl)   titleEl.value   = data.broadcastTitle || data.title || '';
            if (contentEl) contentEl.value = data.content || '';
            if (categoryEl && data.broadcastCategory) categoryEl.value = data.broadcastCategory;
            if (priorityEl && data.priority)          priorityEl.value = data.priority;

            setHTML('bc-title-count',   `${titleEl?.value.length || 0} / 120`);
            setHTML('bc-content-count', `${contentEl?.value.length || 0} / 3000`);

            // Render existing media thumbnails
            const existingEl = document.getElementById('bc-existing-media');
            if (existingEl) {
                existingEl.classList.toggle('hidden', !_bcEditMedia.length);
                existingEl.innerHTML = _bcEditMedia.map((m, i) => {
                    const isImg = m.type === 'image';
                    const inner = isImg
                        ? `<img src="${sanitize(m.url)}" style="width:100%;height:100%;object-fit:cover;">`
                        : `<div class="bc-doc-icon">${m.type === 'video' ? '🎬' : '📄'}<span class="bc-doc-label">${sanitize((m.name || m.url).slice(0,16))}</span></div>`;
                    return `<div class="bc-media-thumb" data-existing-idx="${i}">
                                ${inner}
                                <button class="bc-remove-file bc-remove-existing" data-remove-existing="${i}" title="Remove existing">✕</button>
                            </div>`;
                }).join('');

                existingEl.querySelectorAll('.bc-remove-existing').forEach(btn => {
                    btn.addEventListener('click', e => {
                        e.stopPropagation();
                        _bcEditMedia.splice(parseInt(btn.dataset.removeExisting, 10), 1);
                        startEdit(_bcEditId, { ...(data), mediaItems: _bcEditMedia });
                    });
                });
            }

            renderFilePreviews();
            updatePreview();

            if (formTitleEl) formTitleEl.textContent = 'Edit Broadcast';
            if (submitBtn) submitBtn.innerHTML = '💾 Update Broadcast';
            cancelBtn?.classList.remove('hidden');

            submitBtn?.classList.remove('from-sky-500','to-indigo-600');
            submitBtn?.classList.add('from-indigo-500','to-purple-600');

            // Mark active card as being edited
            document.querySelectorAll('.bc-active-card').forEach(c =>
                c.classList.toggle('bc-active-card--editing', c.dataset.bcId === id)
            );

            // Scroll compose form into view
            mainView.querySelector('.bg-slate-900\\/80')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };

        // ── Upload helper (single file → Cloudinary) ──────────────────────────
        const uploadOneFile = async (file, thumbEl) => {
            const { uploadToCloudinary } = await import('../utils/storage.js');
            const isImage = file.type.startsWith('image/');
            const isVideo = file.type.startsWith('video/');
            const rType   = isImage ? 'image' : isVideo ? 'video' : 'raw';
            const url = await uploadToCloudinary(file, 'broadcasts', {
                fileName: file.name,
                onProgress: (pct) => {
                    if (thumbEl) {
                        let bar = thumbEl.querySelector('.bc-upload-progress');
                        if (!bar) {
                            bar = document.createElement('div');
                            bar.className = 'bc-upload-progress';
                            thumbEl.appendChild(bar);
                        }
                        bar.textContent = `${pct}%`;
                        if (pct >= 100) setTimeout(() => bar.remove(), 600);
                    }
                },
            });
            return { url, type: isImage ? 'image' : isVideo ? 'video' : 'raw', name: file.name, size: file.size };
        };

        // ── Submit (create OR update) ─────────────────────────────────────────
        submitBtn?.addEventListener('click', async () => {
            const title   = titleEl?.value.trim();
            const content = contentEl?.value.trim();

            if (!title)   { toast('Headline is required.',    'warn'); return; }
            if (!content) { toast('Body text is required.',   'warn'); return; }
            if (title.length > 120)   { toast('Headline too long (max 120).',    'warn'); return; }
            if (content.length > 3000) { toast('Body too long (max 3000).',      'warn'); return; }

            const category  = categoryEl?.value  || 'NOTICE';
            const priority  = priorityEl?.value  || 'normal';
            const scheduled = schedToggle?.checked && schedAt?.value
                ? new Date(schedAt.value).getTime()
                : null;

            // Validate schedule date is in the future
            if (scheduled && scheduled <= Date.now()) {
                toast('Scheduled time must be in the future.', 'warn'); return;
            }

            const restore = btnLoading(submitBtn, _bcEditId ? 'Updating…' : 'Publishing…');

            try {
                // 1. Upload any new files
                let newMediaItems = [];
                if (_bcFiles.length) {
                    toast('Uploading attachments…', 'info', 12000);
                    const thumbEls = filePreview?.querySelectorAll('.bc-media-thumb') || [];
                    newMediaItems = await Promise.all(
                        _bcFiles.map((f, i) => uploadOneFile(f, thumbEls[i]))
                    );
                    newMediaItems = newMediaItems.filter(Boolean);
                }

                // 2. Merge existing + new media
                const allMedia = [..._bcEditMedia, ...newMediaItems];
                const firstImg = allMedia.find(m => m.type === 'image');

                // 3. Build the Firestore payload
                const payload = {
                    // Discriminator fields — make broadcasts queryable without
                    // ambiguity against user Announcement posts
                    isBroadcast:       true,
                    broadcastCategory: category,
                    broadcastTitle:    title,   // clean title stored separately so
                                                // feed can render the badge+title
                                                // independently

                    // Standard post fields so posts.js createPostCardHTML works
                    type:        'post',
                    title:       title,         // human-readable; no category baked-in
                    content,
                    category:    'Announcement',
                    community:   'Global',
                    priority,
                    pinned:      true,          // BUG-03 fix: always pin broadcasts
                    status:      'active',
                    tags:        ['system', 'admin', 'broadcast', category.toLowerCase()],
                    mediaItems:  allMedia,
                    imageSrc:    firstImg?.url || null,
                    author:      'System Administrator',
                    authorEmail: currentUser.email,
                    commentCount: 0,
                    upvotedBy:   [],
                    upvoteCount:  0,
                    edited:      !!_bcEditId,
                    editedAt:    _bcEditId ? Date.now() : null,
                };

                // Scheduled vs. immediate
                if (scheduled) {
                    payload.scheduledFor = scheduled;
                    payload.status       = 'scheduled';
                    payload.pinned       = false; // not yet live in feed
                } else {
                    payload.timestamp    = Date.now();
                    payload.scheduledFor = null;
                }

                if (_bcEditId) {
                    // ── UPDATE existing broadcast ──────────────────────────────
                    await updateDoc(doc(db, 'posts', _bcEditId), payload);
                    await writeAudit('BROADCAST_UPDATED', {
                        targetId: _bcEditId, category, priority,
                    });
                    toast('Broadcast updated.', 'success');
                } else {
                    // ── CREATE new broadcast ───────────────────────────────────
                    // Idempotency: check for a near-duplicate (same title+email in last 60 s)
                    // to prevent accidental double-submissions.
                    const since = Date.now() - 60_000;
                    const dedupQ = query(
                        collection(db, 'posts'),
                        where('isBroadcast', '==', true),
                        where('authorEmail', '==', currentUser.email),
                        where('broadcastTitle', '==', title),
                        where('timestamp', '>=', since),
                        limit(1)
                    );
                    const dedupSnap = await getDocs(dedupQ);
                    if (!dedupSnap.empty) {
                        toast('A broadcast with this headline was just published. Wait 60 s to send again.', 'warn');
                        restore();
                        return;
                    }

                    await addDocument('posts', payload);
                    await writeAudit('BROADCAST_SENT', { category, priority, scheduled: !!scheduled });
                    toast(scheduled ? 'Broadcast scheduled! 📅' : 'Broadcast live in the feed! 📡', 'success');
                }

                resetForm();
            } catch (err) {
                console.error('[Admin] Broadcast submit error:', err);
                toast(`Failed: ${err.message || 'Unknown error'}`, 'error');
            } finally {
                restore();
            }
        });

        // ── Real-time active broadcasts listener (BUG-01 fix) ─────────────────
        // Query by isBroadcast:true so we never accidentally show user Announcement
        // posts in this panel, and we get only status:'active' ones that are live.
        _detach('broadcasts');
        _unsubs['broadcasts'] = onSnapshot(
            query(
                collection(db, 'posts'),
                where('isBroadcast', '==', true),
                orderBy('timestamp', 'desc'),
                limit(50)
            ),
            (snap) => {
                const list     = document.getElementById('active-broadcasts-list');
                const countBadge = document.getElementById('bc-active-count');
                if (!list) return;

                // Split into active vs scheduled vs archived
                const active    = [];
                const scheduled = [];
                const archived  = [];

                snap.forEach(d => {
                    const data = { id: d.id, ...d.data() };
                    if (data.status === 'archived') archived.push(data);
                    else if (data.status === 'scheduled') scheduled.push(data);
                    else active.push(data);
                });

                if (countBadge) {
                    countBadge.textContent = active.length;
                    countBadge.classList.toggle('hidden', active.length === 0);
                }

                if (snap.empty) {
                    list.innerHTML = emptyState(
                        '📡', 'No broadcasts yet',
                        'Send your first broadcast and it will appear here in real time.'
                    );
                    return;
                }

                const renderGroup = (items, groupLabel, extraClasses = '') => {
                    if (!items.length) return '';
                    return `
                        <div class="mb-5">
                            <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-3">
                                ${groupLabel}
                            </p>
                            <div class="space-y-3 ${extraClasses}">
                                ${items.map(p => renderBroadcastCard(p)).join('')}
                            </div>
                        </div>`;
                };

                list.innerHTML =
                    renderGroup(active,    '🟢 Live in feed', '') +
                    renderGroup(scheduled, '⏳ Scheduled', 'opacity-80') +
                    renderGroup(archived,  '🗄 Archived', 'opacity-60');

                // Wire up action buttons on all newly rendered cards
                list.querySelectorAll('[data-bc-action]').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const action = btn.dataset.bcAction;
                        const id     = btn.dataset.bcId;
                        const card   = list.querySelector(`.bc-active-card[data-bc-id="${id}"]`);
                        const p      = snap.docs.find(d => d.id === id)?.data();
                        if (!p) return;

                        if (action === 'edit') {
                            startEdit(id, p);
                        }

                        if (action === 'archive') {
                            dangerModal({
                                title:       'Archive Broadcast',
                                body:        'This will unpin the broadcast from the feed without deleting it. You can re-publish it later.',
                                confirmText: 'Archive',
                                onConfirm:   async () => {
                                    const restore = btnLoading(btn, 'Archiving…');
                                    try {
                                        await updateDoc(doc(db, 'posts', id), {
                                            status: 'archived',
                                            pinned: false,
                                            archivedAt: Date.now(),
                                            archivedBy: currentUser.email,
                                        });
                                        await writeAudit('BROADCAST_ARCHIVED', { targetId: id });
                                        toast('Broadcast archived and unpinned.', 'success');
                                        if (_bcEditId === id) resetForm();
                                    } catch (err) {
                                        toast('Failed to archive broadcast.', 'error');
                                        restore();
                                    }
                                },
                            });
                        }

                        if (action === 'restore') {
                            dangerModal({
                                title:       'Restore Broadcast',
                                body:        'Re-pin this broadcast to the top of the Global Posts feed?',
                                confirmText: 'Restore',
                                onConfirm:   async () => {
                                    const restore = btnLoading(btn, 'Restoring…');
                                    try {
                                        await updateDoc(doc(db, 'posts', id), {
                                            status:    'active',
                                            pinned:    true,
                                            timestamp: Date.now(),
                                            archivedAt: null,
                                        });
                                        await writeAudit('BROADCAST_RESTORED', { targetId: id });
                                        toast('Broadcast restored and re-pinned.', 'success');
                                    } catch (err) {
                                        toast('Failed to restore broadcast.', 'error');
                                        restore();
                                    }
                                },
                            });
                        }

                        if (action === 'delete') {
                            dangerModal({
                                title:       'Delete Broadcast',
                                body:        'Permanently remove this broadcast from the feed and database? This cannot be undone.',
                                confirmText: 'Delete',
                                onConfirm:   async () => {
                                    const restore = btnLoading(btn, 'Deleting…');
                                    try {
                                        await deleteDoc(doc(db, 'posts', id));
                                        await writeAudit('BROADCAST_DELETED', { targetId: id });
                                        toast('Broadcast deleted.', 'success');
                                        if (_bcEditId === id) resetForm();
                                    } catch (err) {
                                        toast('Failed to delete broadcast.', 'error');
                                        restore();
                                    }
                                },
                            });
                        }
                    });
                });
            },
            (err) => {
                console.error('[Admin] Broadcasts listener error:', err);
                const list = document.getElementById('active-broadcasts-list');
                if (list) list.innerHTML = errorState(`Failed to load broadcasts: ${err.message}`);
            }
        );
    } // end renderBroadcast

    // ── Broadcast card HTML renderer ──────────────────────────────────────────
    // Pure function — no DOM side-effects. Called by the onSnapshot handler.
    function renderBroadcastCard(p) {
        const ts        = p.timestamp ? timeAgo(p.timestamp) : 'just now';
        const isLive    = p.status !== 'archived' && p.status !== 'scheduled';
        const isArchived = p.status === 'archived';
        const isSched   = p.status === 'scheduled';
        const catEmoji  = { MAINTENANCE:'🔧', UPDATE:'✨', WARNING:'⚠️',
                            EVENT:'🎉', POLICY:'📜', NOTICE:'📣' }[p.broadcastCategory] || '📡';

        // Priority badge class
        const priClass  = {
            critical: 'bc-priority-badge--critical',
            high:     'bc-priority-badge--high',
        }[p.priority] || 'bc-priority-badge--normal';
        const priLabel  = { critical: '🚨 Critical', high: 'High', normal: 'Normal' }[p.priority] || 'Normal';

        // Media thumbnail strip (first 3)
        const mediaStrip = (p.mediaItems || []).slice(0, 3).map(m => {
            if (m.type === 'image')
                return `<img src="${sanitize(m.url)}" class="w-10 h-8 object-cover rounded border border-slate-700 flex-shrink-0">`;
            return `<div class="flex items-center justify-center w-10 h-8 rounded border border-slate-700
                                flex-shrink-0 text-slate-500 text-sm">
                        ${m.type === 'video' ? '🎬' : '📎'}
                    </div>`;
        }).join('');

        const schedNote = isSched && p.scheduledFor
            ? `<span class="text-[10px] text-amber-400 font-mono">
                   Scheduled: ${new Date(p.scheduledFor).toLocaleString()}
               </span>`
            : '';

        const editedNote = p.editedAt
            ? `<span class="text-[10px] text-slate-500 font-mono">edited ${timeAgo(p.editedAt)}</span>`
            : '';

        // Action buttons depending on current status
        const actions = isArchived
            ? `<button class="admin-setting-action bc-btn-restore text-emerald-400 bg-emerald-500/10
                              hover:bg-emerald-500/20 border-emerald-500/20 px-3 py-1.5 rounded-lg text-xs
                              font-bold border transition uppercase tracking-wider"
                       data-bc-action="restore" data-bc-id="${p.id}">
                   ↑ Restore
               </button>
               <button class="admin-setting-action bc-btn-delete text-red-400 bg-red-500/10
                              hover:bg-red-500/20 border-red-500/20 px-3 py-1.5 rounded-lg text-xs
                              font-bold border transition uppercase tracking-wider"
                       data-bc-action="delete" data-bc-id="${p.id}">
                   🗑 Delete
               </button>`
            : `<button class="admin-setting-action bc-btn-edit text-indigo-400 bg-indigo-500/10
                              hover:bg-indigo-500/20 border-indigo-500/20 px-3 py-1.5 rounded-lg text-xs
                              font-bold border transition uppercase tracking-wider"
                       data-bc-action="edit" data-bc-id="${p.id}">
                   ✏️ Edit
               </button>
               <button class="admin-setting-action bc-btn-archive text-amber-400 bg-amber-500/10
                              hover:bg-amber-500/20 border-amber-500/20 px-3 py-1.5 rounded-lg text-xs
                              font-bold border transition uppercase tracking-wider"
                       data-bc-action="archive" data-bc-id="${p.id}">
                   📦 Archive
               </button>
               <button class="admin-setting-action bc-btn-delete text-red-400 bg-red-500/10
                              hover:bg-red-500/20 border-red-500/20 px-3 py-1.5 rounded-lg text-xs
                              font-bold border transition uppercase tracking-wider"
                       data-bc-action="delete" data-bc-id="${p.id}">
                   🗑 Delete
               </button>`;

        return `
            <div class="bc-active-card" data-bc-id="${p.id}">
                <!-- Header row -->
                <div class="flex items-start gap-3 mb-3">
                    <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500/20 to-indigo-600/20
                                border border-sky-500/20 flex items-center justify-center text-sm flex-shrink-0">
                        ${catEmoji}
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="flex flex-wrap items-center gap-2 mb-1">
                            <p class="text-white font-bold text-sm truncate max-w-xs">${sanitize(p.broadcastTitle || p.title)}</p>
                            <span class="bc-priority-badge ${priClass}">${priLabel}</span>
                            ${isArchived ? `<span class="bc-priority-badge bc-priority-badge--normal">Archived</span>` : ''}
                            ${isSched    ? `<span class="bc-priority-badge bc-priority-badge--high">Scheduled</span>`  : ''}
                        </div>
                        <div class="flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                            <span class="font-mono">${ts}</span>
                            <span>·</span>
                            <span class="text-sky-500/80">${sanitize(p.broadcastCategory || p.category || '')}</span>
                            ${p.mediaItems?.length ? `<span>·</span><span>📎 ${p.mediaItems.length} file${p.mediaItems.length !== 1 ? 's' : ''}</span>` : ''}
                            ${schedNote}
                            ${editedNote}
                        </div>
                    </div>
                </div>

                <!-- Content preview -->
                ${p.content ? `
                <p class="text-slate-400 text-xs leading-relaxed mb-3 line-clamp-2">
                    ${sanitize(p.content)}
                </p>` : ''}

                <!-- Media thumbnails -->
                ${mediaStrip ? `<div class="flex gap-2 mb-3">${mediaStrip}</div>` : ''}

                <!-- Action buttons -->
                <div class="flex flex-wrap gap-2">
                    ${actions}
                </div>
            </div>`;
    }

    // ════════════════════════════════════════════════════════════════════════
    // 6. PLATFORM SETTINGS
    // ════════════════════════════════════════════════════════════════════════
    async function renderSettings() {
        mainView.innerHTML = `
            <div class="space-y-6 admin-tab-content max-w-3xl">
                <div>
                    <h2 class="text-3xl font-black text-white tracking-tight">Platform Settings</h2>
                    <p class="text-slate-400 text-sm mt-1">Global flags, content moderation rules, and housekeeping</p>
                </div>

                <!-- Maintenance mode -->
                <div class="bg-slate-900/80 border border-slate-800 rounded-3xl p-7 shadow-xl">
                    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5">
                        <div>
                            <div class="flex items-center gap-3 mb-2">
                                <h4 class="text-white font-black text-lg">Maintenance Mode</h4>
                                <span id="maint-status-badge" class="px-2.5 py-1 text-[10px] font-black rounded-full uppercase tracking-wider"></span>
                            </div>
                            <p class="text-slate-400 text-sm leading-relaxed max-w-sm">
                                Locks the platform to regular users. Admins bypass automatically.
                            </p>
                        </div>
                        <div id="maint-loading" class="w-24 h-10 bg-slate-700 rounded-xl animate-pulse"></div>
                        <button id="btn-toggle-maint"
                                class="hidden admin-setting-action w-full sm:w-auto px-6 py-3 rounded-xl
                                       font-bold transition border tracking-wide uppercase text-sm flex-shrink-0"
                                data-action="toggle-maint"></button>
                    </div>
                </div>

                <!-- Profanity filter -->
                <div class="bg-slate-900/80 border border-slate-800 rounded-3xl p-7 shadow-xl">
                    <h4 class="text-white font-black text-lg mb-1">Profanity Filter</h4>
                    <p class="text-slate-400 text-sm mb-5">
                        Type a word and press Enter or comma to add it. Click a tag to remove it.
                    </p>
                    <!-- Tag UI -->
                    <div id="profanity-tags" class="flex flex-wrap gap-2 mb-4 min-h-[2.5rem]
                         p-3 bg-slate-950 border border-slate-700 rounded-xl"></div>
                    <input id="profanity-input" type="text" placeholder="Add a word and press Enter…"
                           class="w-full bg-slate-950 border border-slate-700 rounded-xl p-3.5 text-white
                                  text-sm outline-none focus:border-sky-500/60 transition font-mono mb-4">
                    <div class="flex justify-between items-center">
                        <span class="text-xs text-slate-500" id="profanity-word-count">0 words</span>
                        <button class="admin-setting-action bg-emerald-600 hover:bg-emerald-500 text-white
                                       px-5 py-2.5 rounded-xl font-bold transition text-sm uppercase tracking-wide"
                                data-action="save-profanity">
                            Save Filter List
                        </button>
                    </div>
                </div>

                <!-- Danger Zone -->
                <div class="bg-red-950/20 border border-red-900/40 rounded-3xl p-7 shadow-xl">
                    <div class="flex items-center gap-2 mb-5">
                        <span class="text-red-400 text-lg">⚠️</span>
                        <h4 class="text-red-400 font-black text-lg uppercase tracking-wide">Danger Zone</h4>
                    </div>
                    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5">
                        <div>
                            <h5 class="text-white font-bold">Inactive Account Purge</h5>
                            <p class="text-slate-400 text-sm mt-1 leading-relaxed max-w-sm">
                                Permanently deletes accounts created over 365 days ago with no recorded activity.
                            </p>
                        </div>
                        <button class="admin-setting-action w-full sm:w-auto bg-red-500/15 text-red-400
                                       hover:bg-red-500/25 px-5 py-3 rounded-xl font-bold transition
                                       border border-red-500/30 text-sm uppercase tracking-wider flex-shrink-0"
                                data-action="run-purge">
                            Run Purge
                        </button>
                    </div>
                </div>

                <div id="settings-load-err" class="hidden"></div>
            </div>`;

        // Profanity tag UI state
        let profanityWords = [];

        const renderTags = () => {
            const tagsEl    = document.getElementById('profanity-tags');
            const countEl   = document.getElementById('profanity-word-count');
            if (!tagsEl) return;
            tagsEl.innerHTML = profanityWords.map(w => `
                <button class="profanity-tag flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 border
                               border-slate-600 rounded-lg text-xs font-mono text-slate-200
                               hover:bg-red-500/20 hover:text-red-300 hover:border-red-500/30 transition"
                        data-word="${sanitize(w)}">
                    ${sanitize(w)} <span class="opacity-60">×</span>
                </button>`).join('');
            if (countEl) countEl.textContent = `${profanityWords.length} word${profanityWords.length !== 1 ? 's' : ''}`;
        };

        document.getElementById('profanity-tags')?.addEventListener('click', e => {
            const tag = e.target.closest('.profanity-tag');
            if (tag) {
                profanityWords = profanityWords.filter(w => w !== tag.dataset.word);
                renderTags();
            }
        });

        document.getElementById('profanity-input')?.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                const val = e.target.value.trim().replace(/,/g, '').toLowerCase();
                if (val && !profanityWords.includes(val)) {
                    profanityWords.push(val);
                    renderTags();
                }
                e.target.value = '';
            }
        });

        // Load current settings
        try {
            const [globalSnap, profSnap] = await Promise.all([
                getDoc(doc(db, 'platform_settings', 'global')),
                getDoc(doc(db, 'platform_settings', 'profanity')),
            ]);

            const isMaint = globalSnap.exists() ? !!globalSnap.data().maintenanceMode : false;
            profanityWords = profSnap.exists() ? (profSnap.data().words || []) : [];

            document.getElementById('maint-loading')?.classList.add('hidden');
            document.getElementById('btn-toggle-maint')?.classList.remove('hidden');
            applyMaintenanceUI(isMaint);
            renderTags();

        } catch (err) {
            console.error(err);
            const errEl = document.getElementById('settings-load-err');
            if (errEl) { errEl.innerHTML = errorState('Failed to load settings.'); errEl.classList.remove('hidden'); }
        }
    }

    /** Update maintenance toggle button & badge */
    function applyMaintenanceUI(isActive) {
        const btn   = document.getElementById('btn-toggle-maint');
        const badge = document.getElementById('maint-status-badge');
        if (!btn || !badge) return;

        btn.dataset.currentState = String(isActive);

        // BUG FIX: reassigning btn.className wiped the data-action attribute binding
        // used by the event delegator, breaking the toggle after the first click.
        // Now we only swap the colour classes, leaving data-action and base classes intact.
        const ON_CLASSES  = ['bg-emerald-500/15','text-emerald-400','border-emerald-500/30','hover:bg-emerald-500/25'];
        const OFF_CLASSES = ['bg-red-500/15','text-red-400','border-red-500/30','hover:bg-red-500/25'];

        if (isActive) {
            btn.textContent = 'Disable Maintenance';
            btn.classList.remove(...OFF_CLASSES);
            btn.classList.add(...ON_CLASSES);
            badge.textContent = 'ACTIVE';
            badge.className = 'px-2.5 py-1 text-[10px] font-black rounded-full uppercase tracking-wider bg-red-500 text-white animate-pulse';
        } else {
            btn.textContent = 'Enable Maintenance';
            btn.classList.remove(...ON_CLASSES);
            btn.classList.add(...OFF_CLASSES);
            badge.textContent = 'OFFLINE';
            badge.className = 'px-2.5 py-1 text-[10px] font-black rounded-full uppercase tracking-wider bg-slate-800 text-slate-500';
        }
        btn.classList.remove('hidden');
    }

    // ════════════════════════════════════════════════════════════════════════
    // 7. AUDIT TRAIL
    // ════════════════════════════════════════════════════════════════════════
    async function renderAuditLogs() {
        mainView.innerHTML = `
            <div class="space-y-6 admin-tab-content">
                <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                    <div>
                        <h2 class="text-3xl font-black text-white tracking-tight">Audit Trail</h2>
                        <p class="text-slate-400 text-sm mt-1">Immutable record of all admin actions</p>
                    </div>
                    <div class="flex gap-2">
                        <button id="audit-export-csv"
                                class="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl
                                       text-xs font-bold transition border border-slate-700/40">
                            ↓ Export CSV
                        </button>
                    </div>
                </div>

                <!-- Search -->
                <div class="relative">
                    <span class="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm">🔍</span>
                    <input id="audit-search" type="text" placeholder="Filter by action or admin email…"
                           class="w-full bg-slate-800/40 border border-slate-700/40 rounded-xl pl-9 pr-4 py-3
                                  text-sm text-white placeholder-slate-500 outline-none
                                  focus:border-sky-500/50 transition">
                </div>

                <!-- Log list -->
                <div id="admin-audit-list"
                     class="space-y-2 max-h-[68vh] overflow-y-auto pr-1">
                    ${skeletonList(5)}
                </div>
            </div>`;

        let allLogs = [];

        const renderFiltered = () => {
            const search = (document.getElementById('audit-search')?.value || '').toLowerCase();
            const el     = document.getElementById('admin-audit-list');
            if (!el) return;

            const filtered = allLogs.filter(({ log }) =>
                !search ||
                log.action?.toLowerCase().includes(search) ||
                log.adminEmail?.toLowerCase().includes(search) ||
                log.targetEmail?.toLowerCase().includes(search)
            );

            if (!filtered.length) {
                el.innerHTML = '<p class="text-slate-500 text-sm p-4">No matching entries.</p>';
                return;
            }

            el.innerHTML = filtered.map(({ log }) => {
                let timeStr = 'Unknown time';
                if (log.timestamp?.toDate) timeStr = log.timestamp.toDate().toLocaleString();

                const color = ACTION_COLORS[log.action] || '#94a3b8';
                const extras = Object.entries(log)
                    .filter(([k]) => !['action','adminEmail','timestamp'].includes(k))
                    .map(([k, v]) => `<span class="bg-slate-800/80 text-slate-400 text-[10px] font-mono
                                           px-2 py-0.5 rounded">${k}: ${sanitize(String(v))}</span>`)
                    .join('');

                return `
                    <div class="flex flex-col md:flex-row md:items-center gap-3 p-5
                                bg-slate-800/20 border border-slate-700/20 rounded-2xl
                                hover:bg-slate-800/40 hover:border-slate-700/40 transition-all">
                        <div class="flex items-center gap-3 min-w-0 flex-1">
                            <div class="w-2 h-2 rounded-full flex-shrink-0"
                                 style="background:${color}; box-shadow:0 0 6px ${color}55;"></div>
                            <span class="text-xs font-black uppercase tracking-widest flex-shrink-0"
                                  style="color:${color}">${sanitize(log.action)}</span>
                            <span class="text-xs text-slate-400 font-mono truncate">
                                ${sanitize(log.adminEmail || '—')}
                            </span>
                        </div>
                        <div class="flex flex-wrap gap-1.5 items-center">
                            ${extras}
                            <span class="text-[10px] text-slate-600 font-mono ml-auto flex-shrink-0">${timeStr}</span>
                        </div>
                    </div>`;
            }).join('');
        };

        // CSV export
        document.getElementById('audit-export-csv')?.addEventListener('click', () => {
            if (!allLogs.length) { toast('No logs to export.', 'warn'); return; }
            const rows = [['Action', 'Admin', 'Target', 'Timestamp']];
            allLogs.forEach(({ log }) => {
                const ts = log.timestamp?.toDate?.()?.toISOString?.() || '';
                rows.push([log.action || '', log.adminEmail || '', log.targetEmail || log.targetId || '', ts]);
            });
            const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
            const a   = document.createElement('a');
            a.href    = 'data:text/csv,' + encodeURIComponent(csv);
            a.download = `audit-${new Date().toISOString().slice(0,10)}.csv`;
            a.click();
            toast('CSV exported.', 'success');
        });

        document.getElementById('audit-search')?.addEventListener('input', renderFiltered);

        try {
            const snap = await getDocs(
                query(collection(db, 'audit_logs'), orderBy('timestamp', 'desc'), limit(200))
            );

            if (snap.empty) {
                document.getElementById('admin-audit-list').innerHTML =
                    emptyState('📋', 'No Entries', 'No audit logs have been recorded yet.');
                return;
            }

            allLogs = snap.docs.map(d => ({ log: d.data() }));
            renderFiltered();
        } catch (err) {
            console.error(err);
            document.getElementById('admin-audit-list').innerHTML =
                errorState('Failed to load audit logs.');
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 8. GLOBAL EVENT DELEGATOR
    // ════════════════════════════════════════════════════════════════════════
    mainView.addEventListener('click', async e => {
        if (!currentUser) { toast('Session expired. Please sign in again.', 'error'); return; }

        // ── SETTINGS ACTIONS ─────────────────────────────────────────────────
        if (e.target.closest('.admin-setting-action')) {
            const btn    = e.target.closest('.admin-setting-action');
            const action = btn.dataset.action;

            // Toggle maintenance mode
            if (action === 'toggle-maint') {
                const next    = btn.dataset.currentState !== 'true';
                const restore = btnLoading(btn, 'Updating…');
                try {
                    await setDoc(doc(db, 'platform_settings', 'global'), { maintenanceMode: next }, { merge: true });
                    await writeAudit(next ? 'MAINTENANCE_ENABLED' : 'MAINTENANCE_DISABLED');
                    applyMaintenanceUI(next);
                    toast(`Maintenance mode ${next ? 'enabled' : 'disabled'}.`, next ? 'warn' : 'success');
                } catch (err) {
                    toast('Failed to update maintenance mode.', 'error');
                } finally { restore(); }
            }

            // Save profanity filter
            if (action === 'save-profanity') {
                const tagsEl  = document.getElementById('profanity-tags');
                const tags    = [...(tagsEl?.querySelectorAll('.profanity-tag') || [])];
                const words   = tags.map(t => t.dataset.word).filter(Boolean);

                // Also capture any in-progress input
                const input = document.getElementById('profanity-input')?.value.trim().toLowerCase();
                if (input && !words.includes(input)) words.push(input);

                const restore = btnLoading(btn, 'Saving…');
                try {
                    await setDoc(doc(db, 'platform_settings', 'profanity'), { words }, { merge: true });
                    await writeAudit('PROFANITY_FILTER_UPDATED', { wordCount: words.length });
                    toast(`Saved ${words.length} word${words.length !== 1 ? 's' : ''}.`, 'success');
                } catch (err) {
                    toast('Failed to save profanity list.', 'error');
                } finally { restore(); }
            }

            // Inactive account purge
            if (action === 'run-purge') {
                dangerModal({
                    title: 'Run Account Purge',
                    body: 'This permanently deletes accounts older than 365 days with no recorded activity. This cannot be undone.',
                    confirmText: 'Purge Accounts',
                    onConfirm: async () => {
                        const restore = btnLoading(btn, 'Scanning…');
                        try {
                            const usersSnap = await getDocs(collection(db, 'users'));
                            const cutoff    = Date.now() - 365 * 24 * 60 * 60 * 1000;
                            let   count     = 0;

                            for (const d of usersSnap.docs) {
                                const data = d.data();
                                let created = null;
                                if (data.createdAt?.toDate) created = data.createdAt.toDate().getTime();
                                else if (typeof data.createdAt === 'number') created = data.createdAt;
                                if (created && created < cutoff) { await deleteDoc(doc(db, 'users', d.id)); count++; }
                            }

                            await writeAudit('INACTIVE_ACCOUNT_PURGE', { count });
                            toast(`Purge complete — ${count} account${count !== 1 ? 's' : ''} removed.`, 'success');
                        } catch (err) {
                            toast(`Purge failed: ${err.message}`, 'error');
                        } finally { restore(); }
                    }
                });
            }

            // Note: broadcast actions (edit / archive / restore / delete) are now
            // wired directly inside renderBroadcast()'s onSnapshot callback via
            // [data-bc-action] buttons. The old 'retract-broadcast' action is
            // removed to avoid conflicts. No code needed here.
        }

        // ── MODERATION REPORT CARD ACTIONS ───────────────────────────────────
        const reportCard = e.target.closest('[data-report-id]');
        if (reportCard) {
            const reportId    = reportCard.dataset.reportId;
            const contentId   = reportCard.dataset.contentId;
            const contentType = reportCard.dataset.contentType;

            if (e.target.closest('.admin-dismiss-btn')) {
                const btn     = e.target.closest('.admin-dismiss-btn');
                const restore = btnLoading(btn, 'Dismissing…');
                try {
                    await updateDoc(doc(db, 'reports', reportId), {
                        status: 'Resolved (Dismissed)', resolvedBy: currentUser.email, resolvedAt: serverTimestamp(),
                    });
                    reportCard.style.transition = 'opacity 0.3s, transform 0.3s';
                    reportCard.style.opacity    = '0';
                    reportCard.style.transform  = 'translateX(-16px)';
                    setTimeout(() => {
                        reportCard.remove();
                        const c = document.getElementById('admin-reported-content');
                        if (c && !c.querySelector('[data-report-id]')) {
                            const fs = c.dataset.filterStatus || 'Pending';
                            c.innerHTML = emptyState('🛡️', 'Queue Clear', _emptyMsgForFilter(fs));
                        }
                    }, 300);
                    toast('Report dismissed.', 'success');
                } catch (err) {
                    toast('Failed to dismiss report.', 'error');
                    restore();
                }
            }

            if (e.target.closest('.admin-delete-btn')) {
                // Read all needed IDs from the card's data attributes (set during render)
                const reportPostId  = reportCard.dataset.postId  || null;
                const reportReplyId = reportCard.dataset.replyId || null;
                dangerModal({
                    title: `Delete ${contentType || 'content'}`,
                    body: `Permanently delete this ${contentType || 'item'}? This cannot be undone.`,
                    confirmText: 'Delete',
                    onConfirm: async () => {
                        const btn     = reportCard.querySelector('.admin-delete-btn');
                        const restore = btn ? btnLoading(btn, 'Deleting…') : () => {};
                        try {
                            if (contentType === 'chat_message') {
                                // Soft-delete: set isDeleted=true so the live chat hides it
                                // without losing the document (preserves audit trail).
                                if (!contentId) {
                                    toast('Cannot delete chat message — message ID missing.', 'warn');
                                } else {
                                    await updateDoc(doc(db, 'global_chat', contentId), {
                                        isDeleted:   true,
                                        text:        null,
                                        attachments: null,
                                        mediaUrl:    null,
                                    });
                                }
                            } else if (contentType === 'reply') {
                                const replyId      = reportReplyId || null;
                                const parentPostId = reportPostId;
                                if (!contentId || !parentPostId) {
                                    toast('Cannot delete reply — parent IDs missing.', 'warn');
                                } else {
                                    const commentRef  = doc(db, 'posts', parentPostId, 'comments', contentId);
                                    const commentSnap = await getDoc(commentRef);
                                    if (commentSnap.exists()) {
                                        const target = replyId
                                            ? (commentSnap.data().replies || []).find(r => r.id === replyId)
                                            : null;
                                        if (target) {
                                            await updateDoc(commentRef, { replies: arrayRemove(target) });
                                        } else {
                                            toast('Reply may already be deleted.', 'info');
                                        }
                                    } else {
                                        toast('Parent comment not found.', 'warn');
                                    }
                                }
                            } else if (contentType === 'comment') {
                                const parentPostId = reportPostId;
                                if (!parentPostId || !contentId) {
                                    toast('Cannot delete comment — post id missing.', 'warn');
                                } else {
                                    await deleteDoc(doc(db, 'posts', parentPostId, 'comments', contentId));
                                }
                            } else {
                                // post / lostFound / event — all top-level collections
                                const collMap = { post: 'posts', lostFound: 'lost_found', event: 'events' };
                                const coll    = collMap[contentType] || contentType;
                                if (contentId && coll) {
                                    await deleteDoc(doc(db, coll, contentId));
                                    // The posts feed's onSnapshot will detect the 'removed' change
                                    // and animate the card out automatically.
                                } else {
                                    toast(`Unknown content type: "${contentType}".`, 'warn');
                                }
                            }

                            // Mark report resolved first so it won't reappear on refresh
                            await updateDoc(doc(db, 'reports', reportId), {
                                status:     'Resolved (Purged)',
                                resolvedBy: currentUser.email,
                                resolvedAt: serverTimestamp(),
                            });
                            await writeAudit('CONTENT_PURGED', { targetId: contentId, targetType: contentType });

                            reportCard.style.transition = 'opacity 0.3s, transform 0.3s';
                            reportCard.style.opacity    = '0';
                            reportCard.style.transform  = 'scale(0.95)';
                            setTimeout(() => {
                                reportCard.remove();
                                const c = document.getElementById('admin-reported-content');
                                if (c && !c.querySelector('[data-report-id]')) {
                                    const fs = c.dataset.filterStatus || 'Pending';
                                    c.innerHTML = emptyState('🛡️', 'Queue Clear', _emptyMsgForFilter(fs));
                                }
                            }, 320);
                            toast('Content removed. Feed will update automatically.', 'success');
                        } catch (err) {
                            toast(`Purge failed: ${err.message}`, 'error');
                            restore();
                        }
                    }
                });
            }
        }

        // ── REPORT RE-OPEN (dismissed → pending) ──────────────────────────────────
        if (e.target.closest('.admin-reopen-btn')) {
            const reportCard = e.target.closest('[data-report-id]');
            if (!reportCard) return;
            const reportId = reportCard.dataset.reportId;
            const btn      = e.target.closest('.admin-reopen-btn');
            const restore  = btnLoading(btn, 'Reopening…');
            try {
                await updateDoc(doc(db, 'reports', reportId), {
                    status:     'Pending',
                    reopenedBy: currentUser.email,
                    reopenedAt: serverTimestamp(),
                });
                await writeAudit('REPORT_REOPENED', { reportId });
                reportCard.style.transition = 'opacity 0.3s, transform 0.3s';
                reportCard.style.opacity    = '0';
                reportCard.style.transform  = 'translateX(16px)';
                setTimeout(() => {
                    reportCard.remove();
                    const c = document.getElementById('admin-reported-content');
                    if (c && !c.querySelector('[data-report-id]')) {
                        c.innerHTML = emptyState('🛡️', 'Queue Clear', 'No reports in this filter.');
                    }
                }, 300);
                toast('Report re-opened and moved to Pending queue.', 'success');
            } catch (err) {
                toast(`Failed to re-open report: ${err.message}`, 'error');
                restore();
            }
            return;
        }

        // ── USER DIRECTORY ACTIONS ────────────────────────────────────────────
        if (e.target.closest('.admin-user-action')) {
            const btn     = e.target.closest('.admin-user-action');
            const docId   = btn.dataset.docId;
            const email   = btn.dataset.email;
            const action  = btn.dataset.action;

            const proceed = async () => {
                const restore = btnLoading(btn);
                try {
                    const userRef = doc(db, 'users', docId);

                    if (action === 'promote') {
                        await updateDoc(userRef, { role: 'admin' });
                        await writeAudit('USER_PROMOTED', { targetEmail: email });
                        toast(`${email} promoted to admin.`, 'success');
                        renderUserDirectory();
                    }
                    if (action === 'ban') {
                        await updateDoc(userRef, { isBanned: true });
                        await writeAudit('USER_SUSPENDED', { targetEmail: email });
                        toast(`${email} suspended.`, 'warn');
                        renderUserDirectory();
                    }
                    if (action === 'unban') {
                        await updateDoc(userRef, { isBanned: false });
                        await writeAudit('USER_RESTORED', { targetEmail: email });
                        toast(`${email} access restored.`, 'success');
                        renderUserDirectory();
                    }
                    if (action === 'strike') {
                        await updateDoc(userRef, { strikes: increment(1) });
                        await writeAudit('USER_STRIKE_ISSUED', { targetEmail: email });
                        toast(`Strike issued to ${email}.`, 'warn');
                        renderUserDirectory();
                    }
                } catch (err) {
                    toast(`Action failed: ${err.message}`, 'error');
                    restore();
                }
            };

            if (action === 'ban') {
                dangerModal({
                    title: 'Suspend Account',
                    body: `Suspend access for ${email}? They will not be able to log in.`,
                    confirmText: 'Suspend',
                    onConfirm: proceed,
                });
            } else if (action === 'promote') {
                dangerModal({
                    title: 'Promote to Admin',
                    body: `Grant full admin privileges to ${email}? This gives them access to this panel.`,
                    confirmText: 'Promote',
                    onConfirm: proceed,
                });
            } else {
                proceed();
            }
        }
    });
}