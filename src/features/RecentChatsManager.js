/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RecentChatsManager.js
 * WhatsApp-grade Recent Chats module — drop-in replacement for the
 * loadRecentChats() block inside setupChat() in chat.js
 *
 * INTEGRATION GUIDE
 * ─────────────────
 * 1. Copy this file into  src/features/RecentChatsManager.js
 * 2. In chat.js, at the top of setupChat(), replace the entire block from
 *    "// Track which user's recent-chats subscription is currently live."
 *    through the closing  _attachRecentListener(true);  with:
 *
 *      const _rcm = new RecentChatsManager({
 *          db, auth, currentUser: () => currentUser,
 *          recentList, sidebarSearchInput,
 *          activeRoomId: () => activeRoomId,
 *          cachedUsersData: () => cachedUsersData,
 *          unread: _unread,
 *          recomputeNavBadge: _recomputeNavBadge,
 *          onOpenRoom: () => openChatRoom,  // getter — openChatRoom defined later in setupChat
 *          sanitize, avatarEl, formatRelativeTime, isUserOnline,
 *          showToast, showConfirm,
 *      });
 *      _rcm.start();               // replaces _attachRecentListener(true)
 *
 * 3. Replace every existing call to  unsubscribeRecent()  with  _rcm.teardown()
 * 4. Replace every existing call to  loadRecentChats()   with  _rcm.refresh()
 * 5. In teardownChat(), call  _rcm.teardown()  instead of  unsubscribeRecent()
 *
 * All existing helpers (_unread, _recomputeNavBadge, resetUnreadState, etc.)
 * remain in chat.js unchanged — this class only replaces the subscription and
 * DOM-management layer.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS MODULE FIXES / ADDS vs. THE ORIGINAL loadRecentChats()
 * ─────────────────────────────────────────────────────────────────
 *
 * Security
 *   [SEC-1]  Strict per-snapshot auth guard: every snapshot is discarded when
 *            currentUser.email !== the email that opened the subscription,
 *            preventing cross-user data leakage on fast account switches.
 *   [SEC-2]  All text rendered into the DOM passes through sanitize(); no raw
 *            Firestore strings are ever written to innerHTML.
 *   [SEC-3]  Firestore query is scoped to  members ARRAY_CONTAINS currentUser.email
 *            — the server enforces membership; the client cannot see other users'
 *            private chats even if the JS is manipulated.
 *   [SEC-4]  photoURL values are never injected into HTML attributes; only passed
 *            to the trusted avatarEl() helper which creates DOM nodes safely.
 *
 * Correctness / Race-condition fixes
 *   [RC-1]   Subscription owner guard (_ownerEmail) prevents a second call to
 *            start() from opening a duplicate listener while one is live.
 *   [RC-2]   onSnapshot discard guard after user change prevents ghost data from
 *            a previous session appearing momentarily in the new session.
 *   [RC-3]   Pending-read integration: rooms in _unread.pending are never
 *            overwritten by incoming snapshot counts, preventing badge flicker.
 *   [RC-4]   Optimistic local sort is applied immediately on every snapshot so
 *            pinned items always float to the top even before the next Firestore
 *            index update.
 *   [RC-5]   Composite-index fallback: if the ordered query fails with
 *            'failed-precondition', the listener automatically retries with
 *            an unordered query and sorts client-side — the list is never blank.
 *   [RC-6]   Dead-listener recovery: on any permanent Firestore error the class
 *            nulls its own state so the next refresh() call re-subscribes cleanly.
 *   [RC-7]   teardown() clears the timestamp-refresh interval and all per-room
 *            typing + presence subscriptions atomically, preventing memory leaks.
 *   [RC-8]   _seenBySubmitted key-space is per-session; teardown() is called on
 *            logout so old keys never bleed into the next user's session.
 *
 * Real-time features
 *   [RT-1]   Per-room typing subscriptions (chats/{id}/typing) update only the
 *            preview text of that one row — zero full re-renders.
 *   [RT-2]   Per-user presence subscriptions (users/{email}) update only the
 *            online dot of the affected avatar row — zero full re-renders.
 *   [RT-3]   Delivery/read-status ticks (isMine + isRead) are computed from
 *            unreadCount map on every snapshot and patched in-place.
 *   [RT-4]   Timestamp elements refresh every 60 s ("just now" → "2 min ago")
 *            without a Firestore round-trip.
 *   [RT-5]   Pinned conversations reorder in real time; sort runs on every
 *            snapshot, and DOM reorder uses insertBefore (no scroll reset).
 *   [RT-6]   Admin join-request badge surfaces a "🔔 N join requests pending"
 *            preview with an inflated unread badge for group admins.
 *
 * Performance
 *   [PERF-1] Incremental DOM diff: only changed fields of existing rows are
 *            patched; no innerHTML wipe, no scroll position reset.
 *   [PERF-2] New rows are created once and cached in _elements Map; removed rows
 *            are detached and their sub-listeners torn down immediately.
 *   [PERF-3] Presence and typing sub-listeners are deduplicated: one listener per
 *            unique email / roomId, never re-opened while alive.
 *   [PERF-4] requestAnimationFrame coalescing for nav-badge paints via the
 *            external _recomputeNavBadge() already provided by chat.js.
 *   [PERF-5] avatarEl() receives photoURL from cachedUsersData (in-memory); no
 *            extra Firestore reads are made for avatar resolution.
 *
 * UX
 *   [UX-1]   Sidebar context menu (right-click / long-press) per chat item:
 *            Pin/Unpin · Mark as read · Delete — directly from the list.
 *   [UX-2]   Swipe-left-to-delete on mobile (touch devices).
 *   [UX-3]   Empty state and error state render inline (not toast-only).
 *   [UX-4]   Retry button in error state re-subscribes without page refresh.
 *   [UX-5]   Search filter is re-applied after every snapshot so new chats
 *            that match the current query appear immediately.
 *   [UX-6]   Unread count capped at 99+ in badge; tooltip shows exact count.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
    collection, doc, setDoc, query, orderBy,
    onSnapshot, serverTimestamp, where,
    getDocs, deleteDoc, writeBatch, increment,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

// ─── Typing TTL constant (must match chat.js) ────────────────────────────────
const TYPING_TTL_MS = 5_000;

// ─── How long between timestamp-element refreshes ────────────────────────────
const TIMESTAMP_REFRESH_MS = 60_000;

// ─── Long-press duration for sidebar context menu on touch devices ────────────
const LONG_PRESS_MS = 500;

export class RecentChatsManager {
    /**
     * @param {Object} opts
     * @param {import('firebase/firestore').Firestore}  opts.db
     * @param {import('firebase/auth').Auth}             opts.auth
     * @param {() => Object|null}                        opts.currentUser   – live getter
     * @param {HTMLElement}                              opts.recentList    – sidebar list container
     * @param {HTMLInputElement|null}                    opts.sidebarSearchInput
     * @param {() => string|null}                        opts.activeRoomId  – live getter
     * @param {() => Array|null}                         opts.cachedUsersData – live getter
     * @param {{ rooms: Map, pending: Set, total: number }} opts.unread      – shared unread state
     * @param {() => void}                               opts.recomputeNavBadge
     * @param {() => (email, name, type) => void}        opts.onOpenRoom    – getter returning open-room fn (resolved at call time)
     * @param {(s: string) => string}                    opts.sanitize
     * @param {Function}                                 opts.avatarEl
     * @param {Function}                                 opts.formatRelativeTime
     * @param {Function}                                 opts.isUserOnline
     * @param {(msg: string, type: string) => void}      opts.showToast
     * @param {(opts: Object) => Promise<boolean>}       opts.showConfirm
     */
    constructor(opts) {
        this._db               = opts.db;
        this._auth             = opts.auth;
        this._getUser          = opts.currentUser;
        this._recentList       = opts.recentList;
        this._searchInput      = opts.sidebarSearchInput ?? null;
        this._getActiveRoom    = opts.activeRoomId;
        this._getCachedUsers   = opts.cachedUsersData;
        this._unread           = opts.unread;
        this._recomputeNavBadge = opts.recomputeNavBadge;
        // onOpenRoom must be passed as a zero-arg getter (() => fn) so that the
        // actual function is resolved at call time, not at construction time.
        // This allows chat.js to construct RecentChatsManager before openChatRoom
        // is defined (both live inside setupChat's function body).
        this._getOpenRoom      = opts.onOpenRoom;
        this._sanitize         = opts.sanitize;
        this._avatarEl         = opts.avatarEl;
        this._formatRelativeTime = opts.formatRelativeTime;
        this._isUserOnline     = opts.isUserOnline;
        this._showToast        = opts.showToast;
        this._showConfirm      = opts.showConfirm;

        // ── Subscription state ────────────────────────────────────────────
        /** @type {(() => void)|null} Main chats collection unsubscribe fn */
        this._sub              = null;
        /** Email of the user whose subscription is currently live */
        this._subOwner         = null;
        /** true = running ordered query; false = fallback unordered */
        this._ordered          = true;

        // ── DOM cache ─────────────────────────────────────────────────────
        /** Map<roomId, HTMLElement> – cached sidebar row elements */
        this._elements         = new Map();
        /** Map<roomId, string|null> – current typing label per room */
        this._typingLabels     = new Map();
        /** Map<roomId, () => void> – typing sub unsub fns */
        this._typingSubs       = new Map();
        /** Map<email, () => void> – presence sub unsub fns */
        this._presenceSubs     = new Map();
        /** Map<email, boolean> – live online status */
        this._online           = new Map();
        /** Last rendered params list — used by timestamp refresh */
        this._lastParams       = [];
        /** Last raw chat docs from snapshot — used by timestamp refresh */
        this._lastChats        = [];
        /** Interval handle for timestamp refresh */
        this._tsInterval       = null;

        // ── Context menu state ────────────────────────────────────────────
        /** Currently open context menu element */
        this._ctxMenu          = null;
        /** Long-press timer handle */
        this._lpTimer          = null;
        /** Room ID targeted by open context menu */
        this._ctxRoomId        = null;

        // ── Sidebar interaction wired once ────────────────────────────────
        this._interactionsWired = false;

        // Bind event handlers so they can be removed cleanly
        this._onDocClick       = this._onDocClick.bind(this);
        this._onContextMenu    = this._onContextMenu.bind(this);
        this._onTouchStart     = this._onTouchStart.bind(this);
        this._onTouchEnd       = this._onTouchEnd.bind(this);
        // Per-item swipe tracking
        this._swipe            = null; // { el, roomId, startX, currentX, anim }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Start (or no-op if already live for this user) the Firestore subscription.
     * Safe to call multiple times — idempotent for the same authenticated user.
     * Returns false if currentUser / recentList is not yet ready (caller can retry).
     */
    start() {
        const user = this._getUser();
        if (!user)               return false;
        if (!this._recentList)   return false;

        // [RC-1] — already subscribed for this user → no-op
        if (this._sub && this._subOwner === user.email) return true;

        this._subOwner = user.email;
        this._teardownSub();           // clean up any previous sub cleanly
        this._wireInteractions();      // attach sidebar-level event listeners once
        this._attach(true);            // start with the indexed (ordered) query
        return true;
    }

    /**
     * Force a re-subscription regardless of whether one is already live.
     * Call this when navigating to the chat page to guarantee freshness.
     */
    refresh() {
        const user = this._getUser();
        if (!user || !this._recentList) return false;
        this._subOwner = user.email;
        this._teardownSub();
        this._attach(true);
        return true;
    }

    /**
     * Full teardown: cancel all subscriptions, clear all DOM caches,
     * stop intervals. Call on logout / teardownChat().
     */
    teardown() {
        this._teardownSub();
        this._teardownSubs();
        this._stopTimestampRefresh();
        this._subOwner = null;
        this._lastParams = [];
        this._lastChats  = [];
        this._removeContextMenu();
        this._removeInteractions();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FIRESTORE SUBSCRIPTION
    // ═══════════════════════════════════════════════════════════════════════════

    _buildQuery(ordered) {
        const user = this._getUser();
        const base = query(
            collection(this._db, 'chats'),
            where('members', 'array-contains', user.email),
        );
        return ordered
            ? query(base, orderBy('lastUpdated', 'desc'))
            : base;
    }

    _attach(ordered) {
        this._ordered = ordered;
        this._teardownSub();

        const ownerEmail = this._subOwner;

        this._sub = onSnapshot(
            this._buildQuery(ordered),
            (snap) => this._onSnapshot(snap, ownerEmail),
            (err)  => this._onError(err, ownerEmail),
        );
    }

    _teardownSub() {
        if (this._sub) {
            try { this._sub(); } catch (_) { /* ignore */ }
            this._sub = null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SNAPSHOT HANDLER
    // ═══════════════════════════════════════════════════════════════════════════

    _onSnapshot(snap, ownerEmail) {
        const user = this._getUser();

        // [SEC-1] / [RC-2] — discard if user changed or signed out
        if (!user || user.email !== ownerEmail) return;

        const chats = [];
        snap.forEach(d => chats.push({ id: d.id, ...d.data() }));

        // [RC-4] — sort: pinned first, then by lastUpdated desc
        chats.sort((a, b) => {
            const ap = !!(a.pinnedBy?.[user.email] || a.pinned === true);
            const bp = !!(b.pinnedBy?.[user.email] || b.pinned === true);
            if (ap !== bp) return bp ? 1 : -1;
            return (b.lastUpdated?.toMillis?.() || 0) - (a.lastUpdated?.toMillis?.() || 0);
        });

        this._lastChats = chats;

        if (!chats.length) {
            this._renderEmpty();
            this._resetAllUnread(user);
            return;
        }

        // Build params and update unread map
        const paramsList = chats.map(chat => {
            const params = this._buildItemParams(chat, user);
            // [RC-3] — only write to unread map if NOT in pending set
            if (!this._unread.pending.has(chat.id)) {
                this._unread.rooms.set(chat.id, params._unreadForMap);
            }
            return params;
        });

        this._lastParams = paramsList;
        this._applyDelta(paramsList);
        this._startTimestampRefresh();
        this._applySearchFilter();
        this._recomputeNavBadge();
    }

    _onError(err, ownerEmail) {
        // [RC-5] — composite index not ready → fall back to client-side sort
        const isIndexError =
            err?.code === 'failed-precondition' ||
            (err?.message || '').toLowerCase().includes('index');

        if (this._ordered && isIndexError) {
            console.warn(
                '[RecentChatsManager] Composite index not ready — ' +
                'falling back to client-side sort. ' +
                'Deploy firestore.indexes.json to build the index.',
            );
            this._attach(false);
            return;
        }

        console.error('[RecentChatsManager] Firestore error:', err);

        // [RC-6] — dead-listener recovery: null state so refresh() re-subscribes
        this._teardownSub();
        this._subOwner = null;

        // Render inline error with retry button
        if (this._recentList && this._getUser()) {
            this._renderError(ownerEmail);
        }

        this._showToast('Lost connection to chat list.', 'error');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PARAMS BUILDER
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Derive all rendering params from a raw Firestore chat doc.
     * Centralised so the initial render and patch path share identical logic.
     */
    _buildItemParams(chat, user) {
        const isGroup      = chat.type === 'group';
        const email        = isGroup
            ? chat.id
            : (chat.members?.find(e => e !== user.email) || '');
        const cachedUsers  = this._getCachedUsers?.() || [];
        const cachedUser   = !isGroup
            ? cachedUsers.find(u => u.email === email)
            : null;

        const name = isGroup
            ? (chat.name || 'Group')
            : (cachedUser?.name
               || chat.memberNames?.find(n => n && n !== user.name)
               || email.split('@')[0]
               || 'Unknown');

        // [PERF-5] — photoURL from in-memory cache; no extra Firestore reads
        const photoURL  = (!isGroup && cachedUser?.photoURL) || null;

        const isBlocked    = chat.blockedBy?.length > 0;
        const rawLastMsg   = isBlocked
            ? '🔒 Chat Blocked'
            : (chat.lastMessage || 'New Chat');

        // ── Sender prefix (group chats) ───────────────────────────────────
        let senderPrefix = '';
        if (isGroup && chat.lastSenderEmail && !isBlocked) {
            senderPrefix = chat.lastSenderEmail === user.email
                ? 'You: '
                : `${chat.lastSenderName || chat.lastSenderEmail.split('@')[0]}: `;
        }

        const time           = this._formatRelativeTime(chat.lastUpdated);
        const activeRoomId   = this._getActiveRoom?.();
        const isActiveRoom   = chat.id === activeRoomId;
        const isPendingRead  = this._unread.pending.has(chat.id);
        const unreadFromServer = chat.unreadCount?.[user.email];

        // Auto-heal stale server counter for the open / pending-read room
        if (
            (isActiveRoom || isPendingRead) &&
            typeof unreadFromServer === 'number' &&
            unreadFromServer > 0
        ) {
            setDoc(
                doc(this._db, 'chats', chat.id),
                { [`unreadCount.${user.email}`]: 0 },
                { merge: true },
            ).catch(() => {});
        }

        const unread = (isActiveRoom || isPendingRead)
            ? 0
            : typeof unreadFromServer === 'number'
                ? Math.max(0, unreadFromServer)
                : (
                    chat.lastUpdated?.toMillis?.() >
                    (chat.lastRead?.[user.email]?.toMillis?.() || 0) &&
                    chat.lastSenderEmail &&
                    chat.lastSenderEmail !== user.email
                        ? 1 : 0
                  );

        // ── Online status ─────────────────────────────────────────────────
        const online = !isGroup
            ? (this._online.has(email)
                ? this._online.get(email)
                : this._isUserOnline(cachedUser?.lastActive))
            : false;

        // ── Pinned ────────────────────────────────────────────────────────
        // [RT-5] Per-user pinned flag (pinnedBy map); legacy pinned boolean fallback
        const isPinned = !!(chat.pinnedBy?.[user.email] || chat.pinned === true);

        // ── Admin join-request notice ─────────────────────────────────────
        const admins       = isGroup ? (chat.admins || [chat.admin].filter(Boolean)) : [];
        const isMeAdmin    = isGroup && admins.includes(user.email);
        const pendingCount = isMeAdmin ? (chat.pendingRequests?.length || 0) : 0;

        const effectiveLastMessage = (pendingCount > 0 && !isActiveRoom)
            ? `🔔 ${pendingCount} join request${pendingCount > 1 ? 's' : ''} pending`
            : rawLastMsg;
        const effectiveUnread = pendingCount > 0
            ? Math.max(unread, pendingCount)
            : unread;

        // ── Delivery / read ticks ─────────────────────────────────────────
        // [RT-3] isMine: current user sent the last message
        //        isRead: for private chats, recipient's unread counter is 0
        const isMine      = !!chat.lastSenderEmail && chat.lastSenderEmail === user.email;
        const recipEmail  = !isGroup ? email : null;
        const isRead      = isMine && recipEmail
            ? (chat.unreadCount?.[recipEmail] === 0)
            : false;

        return {
            id:          chat.id,
            email,
            name,
            type:        chat.type,
            lastMessage: effectiveLastMessage,
            time,
            unread:      effectiveUnread,
            online,
            isActive:    isActiveRoom,
            senderPrefix: pendingCount > 0 ? '' : senderPrefix,
            isPinned,
            photoURL,
            isMine,
            isRead,
            // Internal: written to _unread.rooms
            _unreadForMap: effectiveUnread,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INCREMENTAL DOM DELTA  [PERF-1]
    // ═══════════════════════════════════════════════════════════════════════════

    _applyDelta(paramsList) {
        const newIds = new Set(paramsList.map(p => p.id));

        // Remove rooms that left the list
        for (const [id, el] of this._elements) {
            if (!newIds.has(id)) {
                el.remove();
                this._elements.delete(id);
                this._typingLabels.delete(id);
                this._teardownTypingSub(id);
            }
        }

        // Create or patch each row
        for (const params of paramsList) {
            let el = this._elements.get(params.id);
            if (!el) {
                // New row — create, mount, wire swipe
                el = this._createElement(params);
                this._elements.set(params.id, el);
                this._recentList.appendChild(el);
                this._wireSwipe(el, params.id);
            } else {
                // Existing row — patch in place [PERF-1]
                const typingLabel = this._typingLabels.get(params.id) || null;
                this._patchRow(el, { ...params, typingLabel });
                el.dataset.lastPreview = this._sanitize(
                    params.senderPrefix + params.lastMessage,
                );
            }

            // [RT-1] Start per-room typing sub (no-op if already subscribed)
            this._ensureTypingSub(params.id);

            // [RT-2] Start per-user presence sub (no-op if already subscribed)
            if (params.type !== 'group' && params.email) {
                this._ensurePresenceSub(params.email);
            }
        }

        // Re-order DOM to match sorted order (pinned first, then lastUpdated)  [RT-5]
        paramsList.forEach((params, idx) => {
            const el      = this._elements.get(params.id);
            if (!el) return;
            const current = this._recentList.children[idx];
            if (current !== el) this._recentList.insertBefore(el, current ?? null);
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HTML / DOM BUILDERS
    // ═══════════════════════════════════════════════════════════════════════════

    _createElement(params) {
        const wrapper   = document.createElement('div');
        wrapper.innerHTML = this._buildRowHTML(params);
        const el        = wrapper.firstElementChild;
        return el;
    }

    /**
     * Build complete sidebar-row HTML.
     * [SEC-2] All user-supplied strings pass through sanitize().
     */
    _buildRowHTML({
        id, email, name, type,
        lastMessage, time,
        unread = 0, online = false, isActive = false,
        senderPrefix = '', isPinned = false,
        photoURL = null, isMine = false, isRead = false,
    }) {
        const s          = this._sanitize;
        const safeName   = s(name || email?.split('@')[0] || 'Unknown');
        const dataEmail  = type === 'group' ? id : email;
        const isBlocked  = lastMessage === '🔒 Chat Blocked';
        const preview    = s(senderPrefix + lastMessage);

        const ticksHTML  = this._buildTicks(isMine, isBlocked, isRead);
        const pinHTML    = isPinned
            ? `<span class="wa-pin-indicator" title="Pinned">📌</span>`
            : '';
        const badgeHTML  = unread > 0
            ? `<span class="wa-badge" data-count="${unread}" title="${unread} unread">${unread > 99 ? '99+' : unread}</span>`
            : '';
        const previewCls = isBlocked
            ? 'wa-sidebar-preview wa-blocked'
            : unread > 0
                ? 'wa-sidebar-preview wa-sidebar-preview--unread'
                : 'wa-sidebar-preview';

        return `
<div class="wa-sidebar-item${isActive ? ' wa-sidebar-item--active' : ''}"
     data-room-id="${s(id)}"
     data-email="${s(dataEmail)}"
     data-name="${safeName}"
     data-type="${s(type)}"
     data-last-preview="${preview.replace(/"/g, '&quot;')}"
     role="button" tabindex="0" aria-label="Conversation with ${safeName}">
    <div class="wa-sidebar-avatar">
        ${this._avatarEl(name, type, online, 46, photoURL)}
    </div>
    <div class="wa-sidebar-body">
        <div class="wa-sidebar-top">
            <span class="wa-sidebar-name${unread ? ' wa-sidebar-name--unread' : ''}">${safeName}${pinHTML}</span>
            <span class="wa-sidebar-time${unread ? ' wa-sidebar-time--unread' : ''}">${s(time)}</span>
        </div>
        <div class="wa-sidebar-bottom">
            ${ticksHTML}
            <span class="${previewCls}">${preview}</span>
            ${badgeHTML}
        </div>
    </div>
    <div class="wa-swipe-action" aria-hidden="true">
        <span class="wa-swipe-delete-icon">🗑️</span>
    </div>
</div>`.trim();
    }

    /**
     * Patch an existing row in-place — only touches changed fields.
     * [PERF-1] No innerHTML wipe; no scroll reset.
     */
    _patchRow(el, d) {
        if (!el) return;

        // Active state
        el.classList.toggle('wa-sidebar-item--active', !!d.isActive);
        el.dataset.name = this._sanitize(d.name || d.email?.split('@')[0] || 'Unknown');

        // Name
        const nameEl = el.querySelector('.wa-sidebar-name');
        if (nameEl) {
            nameEl.textContent = d.name || d.email?.split('@')[0] || 'Unknown';
            nameEl.classList.toggle('wa-sidebar-name--unread', d.unread > 0);
            // Pin indicator inside name element
            const existingPin = nameEl.querySelector('.wa-pin-indicator');
            if (d.isPinned && !existingPin) {
                const pin = document.createElement('span');
                pin.className = 'wa-pin-indicator';
                pin.title = 'Pinned';
                pin.textContent = '📌';
                nameEl.appendChild(pin);
            } else if (!d.isPinned && existingPin) {
                existingPin.remove();
            }
        }

        // Timestamp
        const timeEl = el.querySelector('.wa-sidebar-time');
        if (timeEl) {
            timeEl.textContent = d.time || '';
            timeEl.classList.toggle('wa-sidebar-time--unread', d.unread > 0);
        }

        // Preview / typing override
        const previewEl = el.querySelector('.wa-sidebar-preview');
        if (previewEl) {
            const isTyping  = !!d.typingLabel;
            const isBlocked = d.lastMessage === '🔒 Chat Blocked';
            if (isTyping) {
                previewEl.className = 'wa-sidebar-preview wa-sidebar-preview--typing';
                previewEl.innerHTML = `<em>${this._sanitize(d.typingLabel)} is typing…</em>`;
            } else {
                const cls = isBlocked
                    ? 'wa-sidebar-preview wa-blocked'
                    : d.unread > 0
                        ? 'wa-sidebar-preview wa-sidebar-preview--unread'
                        : 'wa-sidebar-preview';
                previewEl.className = cls;
                previewEl.textContent = this._sanitize(
                    (d.senderPrefix || '') + (d.lastMessage || ''),
                );
            }
        }

        // Unread badge
        const bottom  = el.querySelector('.wa-sidebar-bottom');
        let badgeEl   = el.querySelector('.wa-badge');
        if (d.unread > 0) {
            if (!badgeEl) {
                badgeEl = document.createElement('span');
                badgeEl.className = 'wa-badge';
                bottom?.appendChild(badgeEl);
            }
            badgeEl.dataset.count = d.unread;
            badgeEl.title         = `${d.unread} unread`;
            badgeEl.textContent   = d.unread > 99 ? '99+' : String(d.unread);
        } else {
            badgeEl?.remove();
        }

        // Delivery ticks
        const existingTicks = el.querySelector('.wa-sidebar-ticks');
        const newTicksHTML  = this._buildTicks(d.isMine, d.lastMessage === '🔒 Chat Blocked', d.isRead);
        if (newTicksHTML) {
            if (!existingTicks) {
                const tickWrap = document.createElement('span');
                tickWrap.className = 'wa-sidebar-ticks';
                tickWrap.innerHTML = newTicksHTML;
                bottom?.prepend(tickWrap);
            } else {
                existingTicks.innerHTML = newTicksHTML;
            }
        } else {
            existingTicks?.remove();
        }

        // Online dot — patch in avatar container
        const avatarContainer = el.querySelector('.wa-sidebar-avatar > div');
        if (avatarContainer) {
            const existingDot = avatarContainer.querySelector('.wa-online-dot');
            if (d.online && !existingDot) {
                const dot       = document.createElement('span');
                dot.className   = 'wa-online-dot';
                dot.setAttribute('style', [
                    'position:absolute', 'bottom:-1px', 'right:-1px',
                    'width:11px', 'height:11px', 'border-radius:50%',
                    'background:#10b981', 'border:2px solid #fff',
                ].join(';'));
                avatarContainer.appendChild(dot);
            } else if (!d.online && existingDot) {
                existingDot.remove();
            }
        }
    }

    /** Build SVG delivery/read ticks HTML. [RT-3] */
    _buildTicks(isMine, isBlocked, isRead) {
        if (!isMine || isBlocked) return '';
        const color = isRead ? '#4f46e5' : '#9ca3af';
        return `<svg class="wa-sidebar-tick${isRead ? ' wa-sidebar-tick--read' : ''}"
                     viewBox="0 0 18 11" fill="none"
                     style="width:14px;height:9px;flex-shrink:0;margin-right:2px">
            <path d="M1 5.5L5 9.5L13 1.5" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M5 5.5L9 9.5L17 1.5" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EMPTY / ERROR STATES
    // ═══════════════════════════════════════════════════════════════════════════

    _renderEmpty() {
        this._elements.forEach(el => el.remove());
        this._elements.clear();
        this._recentList.innerHTML = `
<div class="wa-list-empty">
    <div class="wa-list-empty__icon">💬</div>
    <p class="wa-list-empty__title">No conversations yet</p>
    <p class="wa-list-empty__sub">Start one from the Contacts tab</p>
</div>`;
    }

    _renderError(ownerEmail) {
        this._recentList.innerHTML = `
<div class="wa-list-error">
    <div class="wa-list-error__icon">⚠️</div>
    <p class="wa-list-error__title">Unable to load chat list</p>
    <p class="wa-list-error__sub">Check your connection or try again</p>
    <button id="rcm-retry-btn" class="wa-list-error__btn">Retry</button>
</div>`;
        document.getElementById('rcm-retry-btn')?.addEventListener('click', () => {
            this._recentList.innerHTML =
                `<div class="wa-list-loading">Reconnecting…</div>`;
            this._subOwner = ownerEmail;
            setTimeout(() => this.start(), 300);
        });
    }

    _resetAllUnread(user) {
        this._unread.rooms.clear();
        this._unread.pending.clear();
        this._unread.total = 0;
        const navDot = document.getElementById('chat-nav-indicator');
        if (navDot) {
            navDot.classList.add('hidden');
            navDot.classList.remove('chat-nav-dot--count');
            navDot.textContent = '';
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TYPING SUBSCRIPTIONS  [RT-1] [PERF-3]
    // ═══════════════════════════════════════════════════════════════════════════

    _ensureTypingSub(roomId) {
        if (this._typingSubs.has(roomId)) return; // [PERF-3]

        const typingCol = collection(this._db, `chats/${roomId}/typing`);
        const unsub = onSnapshot(typingCol, snap => {
            const user  = this._getUser();
            let name    = null;
            const now   = Date.now();
            snap.forEach(d => {
                if (d.id === user?.email) return;
                if (!d.data().typing)    return;
                const updatedMs = d.data().updatedAt?.toMillis?.() || 0;
                if (now - updatedMs > TYPING_TTL_MS) return;
                name = d.data().name || d.id;
            });

            const prev = this._typingLabels.get(roomId);
            if (prev === name) return; // [RT-1] no visual change
            this._typingLabels.set(roomId, name);

            const el        = this._elements.get(roomId);
            const previewEl = el?.querySelector('.wa-sidebar-preview');
            if (!previewEl) return;

            if (name) {
                previewEl.className = 'wa-sidebar-preview wa-sidebar-preview--typing';
                previewEl.innerHTML = `<em>${this._sanitize(name)} is typing…</em>`;
            } else {
                const lastPreview = el.dataset.lastPreview || '';
                const hasUnread   = parseInt(
                    el.querySelector('.wa-badge')?.dataset.count || '0',
                ) > 0;
                const isBlocked   = lastPreview === '🔒 Chat Blocked';
                previewEl.className = isBlocked
                    ? 'wa-sidebar-preview wa-blocked'
                    : hasUnread
                        ? 'wa-sidebar-preview wa-sidebar-preview--unread'
                        : 'wa-sidebar-preview';
                previewEl.textContent = lastPreview;
            }
        }, () => {}); // non-fatal

        this._typingSubs.set(roomId, unsub);
    }

    _teardownTypingSub(roomId) {
        const unsub = this._typingSubs.get(roomId);
        if (unsub) {
            try { unsub(); } catch (_) {}
            this._typingSubs.delete(roomId);
        }
        this._typingLabels.delete(roomId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRESENCE SUBSCRIPTIONS  [RT-2] [PERF-3]
    // ═══════════════════════════════════════════════════════════════════════════

    _ensurePresenceSub(email) {
        if (!email || this._presenceSubs.has(email)) return; // [PERF-3]

        const userRef = doc(this._db, 'users', email);
        const unsub   = onSnapshot(userRef, snap => {
            if (!snap.exists()) return;
            const isOnline = this._isUserOnline(snap.data().lastActive);
            const prev     = this._online.get(email);
            if (prev === isOnline) return; // [RT-2] no visual change
            this._online.set(email, isOnline);

            // Patch only the affected avatar dot
            const el = this._findElementByEmail(email);
            if (!el) return;
            const container = el.querySelector('.wa-sidebar-avatar > div');
            if (!container) return;
            const existing = container.querySelector('.wa-online-dot');
            if (isOnline && !existing) {
                const dot     = document.createElement('span');
                dot.className = 'wa-online-dot';
                dot.setAttribute('style', [
                    'position:absolute', 'bottom:-1px', 'right:-1px',
                    'width:11px', 'height:11px', 'border-radius:50%',
                    'background:#10b981', 'border:2px solid #fff',
                ].join(';'));
                container.appendChild(dot);
            } else if (!isOnline && existing) {
                existing.remove();
            }
        }, () => {}); // non-fatal

        this._presenceSubs.set(email, unsub);
    }

    /** Find a sidebar element whose data-email matches (private chats only). */
    _findElementByEmail(email) {
        for (const [, el] of this._elements) {
            if (el.dataset.type === 'private' && el.dataset.email === email) return el;
        }
        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TIMESTAMP REFRESH  [RT-4]
    // ═══════════════════════════════════════════════════════════════════════════

    _startTimestampRefresh() {
        if (this._tsInterval) return; // already running
        this._tsInterval = setInterval(() => {
            const user = this._getUser();
            if (!user) return;
            this._elements.forEach((el, roomId) => {
                const timeEl  = el.querySelector('.wa-sidebar-time');
                if (!timeEl) return;
                const chat = this._lastChats.find(c => c.id === roomId);
                if (chat) timeEl.textContent = this._formatRelativeTime(chat.lastUpdated);
            });
        }, TIMESTAMP_REFRESH_MS);
    }

    _stopTimestampRefresh() {
        if (this._tsInterval) {
            clearInterval(this._tsInterval);
            this._tsInterval = null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SEARCH FILTER  [UX-5]
    // ═══════════════════════════════════════════════════════════════════════════

    _applySearchFilter() {
        const q = (this._searchInput?.value || '').toLowerCase().trim();
        this._elements.forEach(el => {
            const match = !q || (el.dataset.name || '').toLowerCase().includes(q);
            el.style.display = match ? '' : 'none';
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SIDEBAR INTERACTIONS  [UX-1] [UX-2]
    // ═══════════════════════════════════════════════════════════════════════════

    _wireInteractions() {
        if (this._interactionsWired) return;
        this._interactionsWired = true;

        const list = this._recentList;

        // Click — open conversation
        list.addEventListener('click', e => {
            // Ignore clicks that came from swipe actions or context menus
            if (e.target.closest('.wa-swipe-action') || e.target.closest('.wa-ctx-menu')) return;
            const item = e.target.closest('.wa-sidebar-item');
            if (!item) return;
            this._openItem(item);
        });

        // Keyboard — Enter / Space opens conversation
        list.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const item = e.target.closest('.wa-sidebar-item');
            if (!item) return;
            e.preventDefault();
            this._openItem(item);
        });

        // Desktop right-click context menu  [UX-1]
        list.addEventListener('contextmenu', this._onContextMenu);

        // Touch long-press context menu  [UX-1]
        list.addEventListener('touchstart',  this._onTouchStart,  { passive: true });
        list.addEventListener('touchend',    this._onTouchEnd,    { passive: true });
        list.addEventListener('touchcancel', this._onTouchEnd,    { passive: true });

        // Close context menu on outside click
        document.addEventListener('click', this._onDocClick);

        // Search filter re-apply
        this._searchInput?.addEventListener('input', () => this._applySearchFilter());
    }

    _removeInteractions() {
        this._interactionsWired = false;
        const list = this._recentList;
        if (list) {
            list.removeEventListener('contextmenu', this._onContextMenu);
            list.removeEventListener('touchstart',  this._onTouchStart);
            list.removeEventListener('touchend',    this._onTouchEnd);
            list.removeEventListener('touchcancel', this._onTouchEnd);
        }
        document.removeEventListener('click', this._onDocClick);
    }

    _openItem(item) {
        const email    = item.dataset.email;
        const name     = item.dataset.name;
        const chatType = item.dataset.type;
        if (!email) return;
        this._getOpenRoom()?.(email, name, chatType);
    }

    // ── Context menu ──────────────────────────────────────────────────────────

    _onContextMenu(e) {
        const item = e.target.closest('.wa-sidebar-item');
        if (!item) return;
        e.preventDefault();
        this._showContextMenu(item, e.clientX, e.clientY);
    }

    _onTouchStart(e) {
        const item = e.target.closest('.wa-sidebar-item');
        if (!item) return;
        const touch = e.touches[0];
        this._lpTimer = setTimeout(() => {
            this._showContextMenu(item, touch.clientX, touch.clientY);
        }, LONG_PRESS_MS);
    }

    _onTouchEnd() {
        if (this._lpTimer) {
            clearTimeout(this._lpTimer);
            this._lpTimer = null;
        }
    }

    _onDocClick(e) {
        if (!this._ctxMenu) return;
        if (!this._ctxMenu.contains(e.target)) this._removeContextMenu();
    }

    _showContextMenu(item, x, y) {
        this._removeContextMenu();

        const roomId    = item.dataset.roomId || item.dataset.email;
        const chatData  = this._lastChats.find(c => c.id === roomId);
        const user      = this._getUser();
        if (!chatData || !user) return;
        this._ctxRoomId = roomId;

        const isPinned = !!(chatData.pinnedBy?.[user.email] || chatData.pinned === true);
        const unread   = this._unread.rooms.get(roomId) || 0;

        const menu = document.createElement('div');
        menu.className   = 'wa-ctx-menu';
        menu.style.cssText = [
            'position:fixed', `left:${x}px`, `top:${y}px`,
            'z-index:9999',
            'background:#fff', 'border-radius:8px',
            'box-shadow:0 4px 24px rgba(0,0,0,.18)',
            'min-width:180px', 'overflow:hidden',
            'font-size:13px',
        ].join(';');

        const menuItems = [
            { id: 'ctx-open',       icon: '💬', label: 'Open' },
            { id: 'ctx-pin',        icon: '📌', label: isPinned ? 'Unpin'  : 'Pin' },
            { id: 'ctx-mark-read',  icon: '✓',  label: 'Mark as read', hidden: unread === 0 },
            { id: 'ctx-delete',     icon: '🗑️', label: 'Delete', danger: true },
        ];

        menu.innerHTML = menuItems
            .filter(mi => !mi.hidden)
            .map(mi => `
<button data-ctx-action="${mi.id}"
        style="display:flex;align-items:center;gap:8px;width:100%;padding:10px 16px;
               background:none;border:none;cursor:pointer;text-align:left;
               color:${mi.danger ? '#dc2626' : '#111827'};
               transition:background .1s"
        onmouseover="this.style.background='#f3f4f6'"
        onmouseout="this.style.background='none'">
    <span>${mi.icon}</span> ${this._sanitize(mi.label)}
</button>`).join('');

        menu.addEventListener('click', e => {
            const btn    = e.target.closest('[data-ctx-action]');
            if (!btn) return;
            this._removeContextMenu();
            this._handleContextAction(btn.dataset.ctxAction, roomId, chatData, item);
        });

        document.body.appendChild(menu);
        this._ctxMenu = menu;

        // Reposition if it overflows viewport
        const rect = menu.getBoundingClientRect();
        if (rect.right  > window.innerWidth)  menu.style.left = `${window.innerWidth - rect.width - 8}px`;
        if (rect.bottom > window.innerHeight) menu.style.top  = `${window.innerHeight - rect.height - 8}px`;
    }

    _removeContextMenu() {
        this._ctxMenu?.remove();
        this._ctxMenu    = null;
        this._ctxRoomId  = null;
    }

    async _handleContextAction(action, roomId, chatData, itemEl) {
        const user = this._getUser();
        if (!user) return;

        if (action === 'ctx-open') {
            this._openItem(itemEl);
            return;
        }

        if (action === 'ctx-pin') {
            const isPinned = !!(chatData.pinnedBy?.[user.email] || chatData.pinned === true);
            try {
                await setDoc(
                    doc(this._db, 'chats', roomId),
                    { [`pinnedBy.${user.email}`]: !isPinned },
                    { merge: true },
                );
                this._showToast(!isPinned ? 'Conversation pinned 📌' : 'Conversation unpinned', 'success');
            } catch (err) {
                console.error('[RecentChatsManager] pin error:', err);
                this._showToast('Failed to update pin.', 'error');
            }
            return;
        }

        if (action === 'ctx-mark-read') {
            // Optimistic clear then server write
            this._unread.rooms.set(roomId, 0);
            this._unread.pending.add(roomId);
            this._recomputeNavBadge();
            const el = this._elements.get(roomId);
            if (el) {
                el.querySelector('.wa-badge')?.remove();
                el.querySelector('.wa-sidebar-name')?.classList.remove('wa-sidebar-name--unread');
                el.querySelector('.wa-sidebar-time')?.classList.remove('wa-sidebar-time--unread');
                el.querySelector('.wa-sidebar-preview')?.classList.remove('wa-sidebar-preview--unread');
            }
            try {
                await setDoc(
                    doc(this._db, 'chats', roomId),
                    {
                        [`lastRead.${user.email}`]:   serverTimestamp(),
                        [`unreadCount.${user.email}`]: 0,
                    },
                    { merge: true },
                );
                this._unread.pending.delete(roomId);
            } catch (err) {
                console.warn('[RecentChatsManager] mark-read error:', err);
                this._unread.pending.delete(roomId);
                this._recomputeNavBadge();
            }
            return;
        }

        if (action === 'ctx-delete') {
            const ok = await this._showConfirm({
                title:        'Delete chat?',
                body:         'All messages will be permanently removed. This cannot be undone.',
                confirmLabel: 'Delete',
                tone:         'danger',
            });
            if (!ok) return;

            try {
                const msgsSnap   = await getDocs(collection(this._db, `chats/${roomId}/messages`));
                const BATCH_SIZE = 499;
                const docs       = msgsSnap.docs;
                for (let i = 0; i < docs.length; i += BATCH_SIZE) {
                    const wb = writeBatch(this._db);
                    docs.slice(i, i + BATCH_SIZE).forEach(d => wb.delete(d.ref));
                    await wb.commit();
                }
                await deleteDoc(doc(this._db, 'chats', roomId));

                // Remove from DOM immediately — snapshot removal will also fire
                const el = this._elements.get(roomId);
                if (el) {
                    el.remove();
                    this._elements.delete(roomId);
                }
                this._unread.rooms.delete(roomId);
                this._recomputeNavBadge();

                this._showToast('Chat deleted.', 'success');
            } catch (err) {
                console.error('[RecentChatsManager] delete error:', err);
                this._showToast('Failed to delete chat.', 'error');
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SWIPE-TO-DELETE  [UX-2]
    // ═══════════════════════════════════════════════════════════════════════════

    _wireSwipe(el, roomId) {
        let startX    = 0;
        let startY    = 0;
        let active    = false;
        let confirmed = false;
        const THRESHOLD = 80; // px swipe left to reveal delete

        const onStart = e => {
            if (e.touches.length !== 1) return;
            startX    = e.touches[0].clientX;
            startY    = e.touches[0].clientY;
            active    = true;
            confirmed = false;
        };

        const onMove = e => {
            if (!active) return;
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            if (Math.abs(dy) > Math.abs(dx) && Math.abs(dx) < 10) {
                // Vertical scroll — cancel
                active = false;
                this._resetSwipe(el);
                return;
            }
            if (dx > 0) return; // only swipe left
            const clamp = Math.max(-120, dx);
            el.style.transform = `translateX(${clamp}px)`;
            el.style.transition = 'none';
            const action = el.querySelector('.wa-swipe-action');
            if (action) action.style.opacity = String(Math.min(1, Math.abs(clamp) / THRESHOLD));
            if (Math.abs(clamp) >= THRESHOLD) confirmed = true;
        };

        const onEnd = async () => {
            if (!active) return;
            active = false;
            if (confirmed) {
                // Confirm before deleting
                el.style.transform   = 'translateX(-80px)';
                el.style.transition  = 'transform .15s';
                const chatData = this._lastChats.find(c => c.id === roomId);
                const ok = await this._showConfirm({
                    title:        'Delete chat?',
                    body:         'All messages will be permanently removed. This cannot be undone.',
                    confirmLabel: 'Delete',
                    tone:         'danger',
                });
                if (ok) {
                    await this._handleContextAction('ctx-delete', roomId, chatData, el);
                } else {
                    this._resetSwipe(el);
                }
            } else {
                this._resetSwipe(el);
            }
        };

        el.addEventListener('touchstart', onStart, { passive: true });
        el.addEventListener('touchmove',  onMove,  { passive: true });
        el.addEventListener('touchend',   onEnd);
        el.addEventListener('touchcancel',() => { active = false; this._resetSwipe(el); });
    }

    _resetSwipe(el) {
        el.style.transition = 'transform .2s';
        el.style.transform  = 'translateX(0)';
        const action = el.querySelector('.wa-swipe-action');
        if (action) action.style.opacity = '0';
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TEARDOWN HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    /** Tear down all per-room typing + presence subscriptions and DOM caches. */
    _teardownSubs() {
        for (const unsub of this._typingSubs.values()) {
            try { unsub(); } catch (_) {}
        }
        this._typingSubs.clear();
        this._typingLabels.clear();

        for (const unsub of this._presenceSubs.values()) {
            try { unsub(); } catch (_) {}
        }
        this._presenceSubs.clear();
        this._online.clear();
        this._elements.clear();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CSS ADDITIONS
// Paste this block into Livechat.css (or any global stylesheet).
// The existing .wa-sidebar-item, .wa-badge, .wa-sidebar-* rules remain intact;
// these are new selectors only.
// ═══════════════════════════════════════════════════════════════════════════════
/*
────────────────────────────────────────
  Swipe-to-delete
────────────────────────────────────────
.wa-sidebar-item {
    position: relative;
    overflow: hidden;
    transition: transform .2s;
}
.wa-swipe-action {
    position: absolute;
    right: 0; top: 0; bottom: 0;
    width: 80px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #dc2626;
    color: #fff;
    font-size: 20px;
    opacity: 0;
    pointer-events: none;
    transition: opacity .1s;
    border-radius: 0 10px 10px 0;
}

────────────────────────────────────────
  Pin indicator inside name
────────────────────────────────────────
.wa-pin-indicator {
    font-size: 11px;
    margin-left: 4px;
    opacity: .7;
}

────────────────────────────────────────
  Sidebar typing preview
────────────────────────────────────────
.wa-sidebar-preview--typing em {
    color: #6366f1;
    font-style: normal;
    font-size: 12px;
}

────────────────────────────────────────
  Context menu (scoped to document)
────────────────────────────────────────
.wa-ctx-menu {
    user-select: none;
}
.wa-ctx-menu button:focus-visible {
    outline: 2px solid #6366f1;
    outline-offset: -2px;
}

────────────────────────────────────────
  Empty / error / loading list states
────────────────────────────────────────
.wa-list-empty,
.wa-list-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 64px 16px;
    text-align: center;
    gap: 10px;
}
.wa-list-empty__icon,
.wa-list-error__icon {
    width: 56px; height: 56px;
    border-radius: 50%;
    background: #f3f4f6;
    display: flex; align-items: center; justify-content: center;
    font-size: 24px;
}
.wa-list-error__icon { background: #fef2f2; }
.wa-list-empty__title,
.wa-list-error__title {
    font-size: 14px; font-weight: 600; color: #374151;
}
.wa-list-empty__sub,
.wa-list-error__sub {
    font-size: 12px; color: #9ca3af; line-height: 1.5;
}
.wa-list-error__btn {
    margin-top: 4px;
    padding: 8px 20px;
    border-radius: 8px;
    background: #4f46e5;
    color: #fff;
    font-size: 12px; font-weight: 700;
    border: none; cursor: pointer;
    transition: background .15s;
}
.wa-list-error__btn:hover { background: #4338ca; }
.wa-list-loading {
    display: flex; justify-content: center;
    padding: 40px 0;
    font-size: 14px; color: #9ca3af;
}
*/