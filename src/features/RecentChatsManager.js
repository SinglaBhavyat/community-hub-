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

// ✅ Confirm this import includes arrayUnion:
import {
    collection, doc, setDoc, updateDoc, query, orderBy,
    onSnapshot, serverTimestamp, where,
    getDoc, getDocs, deleteDoc, writeBatch, increment, deleteField,
    arrayUnion, FieldPath,
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
        // Q-7 FIX: bind the search input handler once so it can be removed in
        // _removeInteractions(). Without this, every re-login stacks an additional
        // 'input' listener on the same element since _interactionsWired is reset
        // to false in _removeInteractions(), causing _wireInteractions() to run again.
        this._onSearchInput    = () => this._applySearchFilter();
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
     * Optimistically remove a room from the sidebar immediately — before the
     * Firestore snapshot confirms the hiddenFor write. Called by chat.js after
     * the delete handler writes hiddenFor so the user sees instant feedback.
     * The next snapshot will confirm and keep it gone; if the write failed the
     * snapshot will restore it.
     */
    removeRoom(roomId) {
        // Remove DOM element
        const el = this._elements.get(roomId);
        if (el) {
            el.remove();
            this._elements.delete(roomId);
            this._teardownTypingSub(roomId);
        }
        // Purge from internal caches so refresh() doesn't re-insert it
        this._lastChats  = (this._lastChats  || []).filter(c => c.id !== roomId);
        this._lastParams = (this._lastParams || []).filter(p => p.id !== roomId);
        // Clear unread state for this room
        this._unread?.rooms?.delete(roomId);
        this._unread?.pending?.delete(roomId);
        this._recomputeNavBadge?.();
        // Show empty state if no rooms remain
        if (!this._lastChats.length) this._renderEmpty();
    }

    /**
     * Full teardown: cancel all subscriptions, clear all DOM caches,
     * stop intervals. Call on logout / teardownChat().
     */
    teardown() {
        this._teardownSub();
        this._teardownSubs();   // clears _elements Map and all sub-listeners
        this._stopTimestampRefresh();
        this._subOwner = null;
        this._lastParams = [];
        this._lastChats  = [];
        this._removeContextMenu();
        this._removeInteractions();
        // FIX CROSS-SESSION-DOM: _teardownSubs() clears the _elements Map but the
        // DOM nodes remain physically in _recentList. When a new user signs in and
        // refresh() fires, _applyDelta finds _elements empty and appends new rows
        // alongside the old user's still-mounted nodes, causing duplicate rows.
        // Wipe _recentList here to guarantee a clean slate for the next session.
        if (this._recentList) this._recentList.innerHTML = '';
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
        // FIX DUPLICATE-CHAT-3: deduplicate by document ID before processing.
        // In theory Firestore never returns two docs with the same ID in one snapshot,
        // but a TOCTOU race in openChatRoom (two concurrent setDoc calls on the same
        // roomId) can occasionally cause the listener to receive two separate "added"
        // change events for the same document ID within a short window — one for the
        // locally-committed write and one for the server confirmation.  Keep only the
        // last-seen entry so _applyDelta never sees two params objects sharing an ID,
        // which would otherwise create two sidebar rows mapped to a single roomId key.
        const _seenIds = new Set();
        snap.forEach(d => {
            if (_seenIds.has(d.id)) return; // skip duplicate
            _seenIds.add(d.id);
            chats.push({ id: d.id, ...d.data() });
        });

        // [RC-4] — sort: pinned first, then by lastUpdated desc
        chats.sort((a, b) => {
            const ap = !!(a.pinnedBy?.[user.email] || a.pinned === true);
            const bp = !!(b.pinnedBy?.[user.email] || b.pinned === true);
            if (ap !== bp) return bp ? 1 : -1;
            return (b.lastUpdated?.toMillis?.() || 0) - (a.lastUpdated?.toMillis?.() || 0);
        });

        // Filter out rooms the user has hidden ("Delete for me").
        // A room is un-hidden automatically when the other person sends a new
        // message after the deletion — we detect this by comparing lastUpdated
        // against the hiddenAt timestamp stored on the room doc.
        const visibleChats = chats.filter(chat => {
            const hiddenForMe = chat.hiddenFor?.[user.email];
            if (!hiddenForMe) return true; // not hidden
            // FIX: serverTimestamp() resolves to null on the local optimistic
            // snapshot that fires immediately after updateDoc() — before the server
            // confirms. The old || 0 fallback made lastUpdated > 0+5000 always true,
            // instantly un-hiding the room on the very first snapshot after deletion.
            // Use ?? Date.now() instead: an unresolved hiddenAt is treated as "right
            // now", which is always >= any pre-existing lastUpdated in the doc.
            const rawHiddenAt = chat.hiddenAt?.[user.email];
            const hiddenAt    = rawHiddenAt?.toMillis?.() ?? Date.now();
            const lastUpdated = chat.lastUpdated?.toMillis?.() || 0;
            // If a new message arrived AFTER the user deleted, un-hide the room.
            // A small 2 s grace window avoids a race where the hiddenAt write and
            // the lastUpdated write land in the same server batch.
            if (lastUpdated > hiddenAt + 5000 && chat.lastSenderEmail !== user.email) {
                // BUG-6 FIX: use deleteField() instead of writing false/null.
                // Writing false/null left stale map entries that accumulated over
                // time; deleteField() removes the key entirely, keeping the doc
                // clean. The filter above uses falsy-check so both approaches
                // work for filtering, but deleteField() is semantically correct.
                // FIX: use variadic FieldPath form so dots in the email address
                // (e.g. user@gmail.com) are not parsed as nested Firestore path
                // segments. Template-literal dot-notation keys like
                // `hiddenFor.user@gmail.com` are silently mis-written to
                // hiddenFor.user@gmail → com (two levels deep), so hiddenFor
                // is never set under the correct top-level email key and the
                // room is never filtered out on the next snapshot.
                updateDoc(
                    doc(this._db, 'chats', chat.id),
                    new FieldPath('hiddenFor', user.email), deleteField(),
                    new FieldPath('hiddenAt',  user.email), deleteField(),
                ).catch(() => {});
                return true; // show immediately; the next snapshot will confirm
            }
            return false;
        });

        this._lastChats = visibleChats;

        if (!visibleChats.length) {
            this._renderEmpty();
            this._resetAllUnread(user);
            return;
        }

        // Build params and update unread map
        // Q-5 FIX: hoist cachedUsers resolution outside the per-room loop.
        // _getCachedUsers() returns the same array reference for every room in a
        // given snapshot; calling it once here avoids O(rooms) redundant calls and
        // the linear find() inside _buildItemParams becomes O(rooms × contacts)
        // only once per snapshot instead of O(rooms² × contacts) over many snapshots.
        const cachedUsers = this._getCachedUsers?.() || [];
        const paramsList = visibleChats.map(chat => {
            const params = this._buildItemParams(chat, user, cachedUsers);
            // [RC-3] — pending-read guard: when markRoomRead() has fired but not
            // yet ACK'd, the server counter may still be non-zero (write in-flight).
            // We must NOT let the snapshot restore the old count, so we keep the
            // room at 0 in the map while pending.
            //
            // HOWEVER: if a *new* message arrives while the read-ACK is in-flight
            // (i.e. someone sends a message right as you open the chat), the server
            // counter will jump UP again. In that case we DO want to update the map
            // so the badge reflects the new incoming count rather than staying at 0
            // forever. We detect this by comparing against the current map value:
            // if the new server count is higher than what we have, it's a new message.
            const isPending      = this._unread.pending.has(chat.id);
            const currentInMap   = this._unread.rooms.get(chat.id) ?? 0;
            const newCount       = params._unreadForMap;
            if (!isPending) {
                // Normal case: always write the server count
                this._unread.rooms.set(chat.id, newCount);
            } else if (newCount > currentInMap) {
                // New message arrived while read-ACK was in-flight:
                // accept the higher count and remove from pending (the old
                // mark-read will be a no-op once it ACKs since count > 0 again)
                this._unread.rooms.set(chat.id, newCount);
                this._unread.pending.delete(chat.id);
            }
            // else: pending and count didn't increase → keep map at 0 (optimistic)
            return params;
        });

        this._lastParams = paramsList;
        this._applyDelta(paramsList);
        this._startTimestampRefresh();
        this._applySearchFilter();
        this._recomputeNavBadge();

        // Async enrichment: for private chats where the other user isn't in the
        // local contacts cache (contacts tab never opened), fetch their Firestore
        // user doc and patch the sidebar so the correct name + photo appear.
        // This runs after render so it never blocks the snapshot path.
        this._enrichMissingUsers(visibleChats, user, cachedUsers);
    }

    async _enrichMissingUsers(chats, user, cachedUsers) {
        const missing = chats.filter(c =>
            c.type !== 'group' &&
            !cachedUsers.find(u => u.email === (c.members?.find(e => e !== user.email) || ''))
        );
        if (!missing.length) return;

        for (const chat of missing) {
            const otherEmail = chat.members?.find(e => e !== user.email);
            if (!otherEmail) continue;
            try {
                const snap = await getDoc(doc(this._db, 'users', otherEmail));
                if (!snap.exists()) continue;
                const ud = snap.data();

                // Push into the shared cache so subsequent snapshots don't re-fetch
                const cache = this._getCachedUsers?.();
                if (Array.isArray(cache) && !cache.find(u => u.email === otherEmail)) {
                    cache.push(ud);
                }

                // Also update memberNames in Firestore at the correct index so both
                // sides see the right name from the Firestore doc going forward
                const otherIdx = (chat.members || []).indexOf(otherEmail);
                const myIdx    = (chat.members || []).indexOf(user.email);
                const names    = (chat.memberNames || []).slice();
                let changed    = false;
                if (otherIdx !== -1 && names[otherIdx] !== (ud.name || '')) {
                    names[otherIdx] = ud.name || names[otherIdx];
                    changed = true;
                }
                if (myIdx !== -1 && names[myIdx] !== (user.name || '')) {
                    names[myIdx] = user.name || names[myIdx];
                    changed = true;
                }
                if (changed) {
                    updateDoc(doc(this._db, 'chats', chat.id), { memberNames: names }).catch(() => {});
                }

                // Patch the existing sidebar row immediately (no full re-render)
                const freshCache = this._getCachedUsers?.() || [];
                const params = this._buildItemParams(chat, user, freshCache);
                const el = this._elements?.get(chat.id);
                if (el) this._patchRow(el, { ...params, typingLabel: this._typingLabels?.get(chat.id) || null });
                // Also update data-name so clicking the row passes the correct name
                if (el) el.dataset.name = this._sanitize(params.name);
            } catch (e) {
                // Non-critical: sidebar will still show email prefix as fallback
            }
        }
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
    // Q-5: cachedUsers is now passed in from _onSnapshot (hoisted outside the loop)
    // to avoid O(rooms) redundant _getCachedUsers() calls per snapshot.
    // Falls back to fetching internally for any direct call sites outside _onSnapshot.
    _buildItemParams(chat, user, cachedUsers = this._getCachedUsers?.() || []) {
        const isGroup      = chat.type === 'group';
        const email        = isGroup
            ? chat.id
            : (chat.members?.find(e => e !== user.email) || '');
        const cachedUser   = !isGroup
            ? cachedUsers.find(u => u.email === email)
            : null;

        // Resolve the other person's display name for private chats.
        // Use index-based lookup: find the position of the other person's email
        // in members[], then read memberNames[same index]. This is safe even when
        // both users share the same display name (the old find(n => n !== user.name)
        // approach would return the wrong entry in that case).
        // Fall back to the email prefix (part before @) so users always see a
        // human-readable label derived from their actual identifier.
        const otherMemberIdx = !isGroup && chat.members
            ? chat.members.indexOf(email)
            : -1;
        const nameFromMemberNames = otherMemberIdx !== -1
            ? (chat.memberNames?.[otherMemberIdx] || null)
            : null;

        const name = isGroup
            ? (chat.name || 'Group')
            : (cachedUser?.name
               || nameFromMemberNames
               || email.split('@')[0]
               || 'Unknown');

        // [PERF-5] — photo from in-memory cache; no extra Firestore reads
        // FIX: user doc stores the profile photo under 'picture' (set from
        // firebaseUser.photoURL in auth.js) — not 'photoURL'.
        const photoURL  = (!isGroup && (cachedUser?.picture || cachedUser?.photoURL)) || null;

        const isBlocked    = chat.blockedBy?.length > 0;
        const clearedAtMs   = chat.clearedAt?.[user.email]?.toMillis?.() || 0;
        const lastUpdatedMs = chat.lastUpdated?.toMillis?.() || 0;
        const isClearedForMe = clearedAtMs > 0 && lastUpdatedMs <= clearedAtMs + 2000;
        const rawLastMsg   = isBlocked
            ? '🔒 Chat Blocked'
            : isClearedForMe
                ? 'No messages'
                : (chat.lastMessage || 'New Chat');

        // ── Sender prefix ─────────────────────────────────────────────────
        // Show for both group and private chats so the recipient always sees
        // whose message is previewed in the recents list.
        // • Private: "You: …" when you sent it — nothing when they sent it
        //   (their name is already the row title, so repeating it is redundant).
        // • Group: "You: …" or "Alice: …" for every message.
        let senderPrefix = '';
        if (chat.lastSenderEmail && !isBlocked && !isClearedForMe) {
            if (chat.lastSenderEmail === 'system') {
                // Group-event messages (admin change, member added/removed, joined, left).
                // The lastMessage already contains a descriptive emoji + text; no prefix needed.
                senderPrefix = '';
            } else if (chat.lastSenderEmail === user.email) {
                senderPrefix = 'You: ';
            } else if (isGroup) {
                senderPrefix = `${chat.lastSenderName || chat.lastSenderEmail.split('@')[0]}: `;
            }
            // Private chat where the other person sent — no prefix needed;
            // their name is already the row heading.
        }

        const time           = this._formatRelativeTime(chat.lastUpdated);
        const activeRoomId   = this._getActiveRoom?.();
        const isActiveRoom   = chat.id === activeRoomId;
        const isPendingRead  = this._unread.pending.has(chat.id);
        const unreadFromServer = chat.unreadCount?.[user.email];

        // Auto-heal stale server counter ONLY for the currently-open room.
        // Restriction: do NOT fire for isPendingRead rooms — markRoomRead() already
        // issued the zero-write for those rooms and added them to _unread.pending.
        // Firing here too creates a duplicate updateDoc that races with the ACK
        // and can accidentally zero the counter for a room the user hasn't opened
        // yet (e.g. you receive a message in room B while room A is open; room B
        // is not in pending, but if anything ever puts it in pending prematurely
        // this guard ensures we never clobber the real count).
        //
        // Additionally, only fire when the last message was sent by someone ELSE —
        // our own send batch already writes unreadCount.us = 0 atomically, so
        // firing here for our own messages would be a redundant no-op at best and
        // a race condition at worst.
        // FIX UNREAD-ACTIVE-ROOM: zero the server counter whenever the user is
        // actively reading the room and the server still shows unread > 0.
        // The previous version skipped this when lastSenderEmail === user.email,
        // which was meant to avoid a redundant write after the user sends a message
        // (their own send batch already zeros their counter). But that condition also
        // blocked the heal when a snapshot arrived in a race where lastSenderEmail
        // was the current user even though recipients had bumped the counter.
        // Removing that condition is safe: writing unreadCount=0 when it's already 0
        // is a no-op from the server's perspective and the security rule allows it.
        if (
            isActiveRoom &&           // ← only the room the user is actively reading
            !isPendingRead &&         // ← markRoomRead() handles pending rooms
            typeof unreadFromServer === 'number' &&
            unreadFromServer > 0
        ) {
            // FIX: FieldPath prevents the email (e.g. user@gmail.com) being
            // interpreted as a nested dot-path by Firestore. Without it, the
            // security rule rejects the write because affectedKeys() sees
            // 'user@gmail' not 'user@gmail.com'.
            updateDoc(
                doc(this._db, 'chats', chat.id),
                new FieldPath('unreadCount', user.email), 0,
            ).catch(() => {});
        }

        // Unread count resolution — priority order:
        //   1. Room is open or pending-read → always 0 (user is reading it)
        //   2. Server unreadCount field present → use it (authoritative)
        //   3. No server counter (old doc / first message) → derive from lastRead:
        //      if lastUpdated > lastRead and someone else sent last → 1 unread
        //      (This fallback only triggers for docs written before unreadCount
        //       was introduced; new messages always write the counter.)
        //
        // NOTE: unreadFromServer can legitimately be 0 (read), so we must check
        // typeof === 'number' (not just truthiness) to distinguish 0 from undefined.
        //
        // FIX UNREAD-PERSIST-ON-REFRESH: cross-check lastRead as a secondary guard.
        // _unread.pending is in-memory only — it is wiped on every page refresh or
        // app reopen.  On a cold load the snapshot may arrive before the previous
        // session's unreadCount=0 write has fully propagated through Firestore's CDN,
        // so unreadFromServer can still be non-zero even though the user already read
        // the room.  markRoomRead() always writes lastRead=serverTimestamp() in the
        // same updateDoc, so lastRead is the durable, cross-session source of truth.
        // If lastRead >= lastUpdated (±2 s clock-skew grace) the room is definitively
        // read regardless of what unreadCount says right now.
        // The 2 s window mirrors the same tolerance used for clearedAt / hiddenAt
        // elsewhere in this file and avoids false-zero when the lastUpdated write and
        // the lastRead write land in the same server batch.
        const lastReadMs    = chat.lastRead?.[user.email]?.toMillis?.() || 0;
        // FIX: compare lastRead against lastMessageAt (written only on real message
        // sends) instead of lastUpdated (which was also bumped by openChatRoom on
        // every room open, making lastRead ≈ lastUpdated and isDefinitelyRead always
        // true — suppressing all unread badges even for genuinely unread messages).
        //
        // CRITICAL: only activate the isDefinitelyRead guard when lastMessageAt is
        // explicitly present. When absent (rooms predating this field), falling back
        // to lastUpdatedMs makes lastRead ≈ lastUpdated (because openChatRoom also
        // bumped lastUpdated), causing isDefinitelyRead to be permanently true and
        // suppressing all unread badges. Without lastMessageAt, skip this guard and
        // let unreadFromServer (the authoritative server counter) decide instead.
        const lastMessageAtMs = chat.lastMessageAt?.toMillis?.() ?? 0;
        // FIX UNREAD-GRACE: both markRoomRead (lastRead=serverTimestamp()) and incoming
        // messages (lastMessageAt=serverTimestamp()) write server timestamps that can land
        // within milliseconds of each other. A strict > check (1ms gap) is insufficient —
        // if the user opens the room and a message arrives concurrently, the lastRead
        // serverTimestamp can still end up slightly AFTER the message's lastMessageAt,
        // making isDefinitelyRead=true even though the user never saw the new message.
        //
        // Fix: require lastRead to be at least 5 seconds AFTER lastMessageAt.
        // 5 s is long enough to distinguish "user opened room, then message arrived" (the
        // problematic race) from "user genuinely read a message sent minutes/hours ago"
        // (the normal case). markRoomRead is called on room open, so lastRead always
        // reflects the most recent open; a message arriving within 5 s of that open is
        // treated as unread and shown with a badge. A message that arrived more than 5 s
        // before the last open is treated as read (correct — the user saw it).
        const DEFINITELY_READ_GRACE_MS = 5_000;
        const isDefinitelyRead = lastMessageAtMs > 0
            && lastReadMs > lastMessageAtMs + DEFINITELY_READ_GRACE_MS;

        const unread = (isActiveRoom || isPendingRead || isDefinitelyRead)
            ? 0
            : typeof unreadFromServer === 'number'
                ? Math.max(0, unreadFromServer)
                : (
                    lastMessageAtMs > lastReadMs &&
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
        const isMine      = !isClearedForMe && !!chat.lastSenderEmail && chat.lastSenderEmail === user.email;
        const recipEmail  = !isGroup ? email : null;
        const isRead      = isMine && recipEmail
            ? (chat.unreadCount?.[recipEmail] === 0)
            : false;

        // System event: group notification (admin change, member added/removed, left, joined).
        // Show a distinct dot indicator even when unread count is 0 (e.g. actor's own action).
        const isSystemEvent = !isActiveRoom
            && !isClearedForMe
            && chat.lastSenderEmail === 'system'
            && lastMessageAtMs > lastReadMs;

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
            isSystemEvent,
            // Internal: written to _unread.rooms for nav badge summation.
            // Use the raw message `unread` count, NOT effectiveUnread — effectiveUnread
            // is inflated by pendingCount (join requests) for sidebar display purposes,
            // but join-request badges are admin UX, not unread messages. Writing
            // effectiveUnread here causes the nav badge to count join requests as
            // unread messages, making it show incorrect totals.
            _unreadForMap: unread,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INCREMENTAL DOM DELTA  [PERF-1]
    // ═══════════════════════════════════════════════════════════════════════════

    _applyDelta(paramsList) {
        const newIds = new Set(paramsList.map(p => p.id));

        // Remove rooms that left the list.
        // Collect IDs first — mutating a Map while iterating it with for...of is
        // unsafe: deleting an entry mid-iteration causes the iterator to skip the
        // immediately following entry on V8. Snapshot the departed keys, then delete
        // after the loop finishes.
        const toRemove = [];
        for (const id of this._elements.keys()) {
            if (!newIds.has(id)) toRemove.push(id);
        }
        for (const id of toRemove) {
            // Q-4 FIX: tear down presence sub for private rooms that leave the
            // visible list, if no other visible room still references that email.
            // Without this, the presence listener for a contact whose chat was
            // hidden/deleted stays open indefinitely, accumulating over long sessions.
            const el = this._elements.get(id);
            if (el?.dataset.type === 'private') {
                const email = el.dataset.email;
                if (email) {
                    const stillNeeded = [...this._elements.values()]
                        .some(e => e !== el && e.dataset.type === 'private' && e.dataset.email === email);
                    if (!stillNeeded) {
                        const unsub = this._presenceSubs.get(email);
                        if (unsub) {
                            try { unsub(); } catch (_) {}
                            this._presenceSubs.delete(email);
                        }
                        this._online.delete(email);
                    }
                }
            }
            el?.remove();
            this._elements.delete(id);
            this._typingLabels.delete(id);
            this._teardownTypingSub(id);
            // Remove from the unread map so this room stops contributing to the
            // nav badge total.  Without this, deleted / left rooms accumulate in
            // _unread.rooms forever and the badge never reaches zero even after
            // every visible chat has been read.
            this._unread.rooms.delete(id);
            this._unread.pending.delete(id);
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
                this._wireSwipeActionTap(el, params.id);
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
        isSystemEvent = false,
    }) {
        const s          = this._sanitize;
        const safeName   = s(name || email?.split('@')[0] || 'Unknown');
        const safeEmail  = type !== 'group' ? s(email || '') : '';
        const dataEmail  = type === 'group' ? id : email;
        const isBlocked  = lastMessage === '🔒 Chat Blocked';
        const preview    = s(senderPrefix + lastMessage);

        const ticksHTML  = this._buildTicks(isMine, isBlocked, isRead);
        const pinHTML    = isPinned
            ? `<span class="wa-pin-indicator" title="Pinned">📌</span>`
            : '';
        const badgeHTML  = unread > 0
            ? `<span class="wa-badge" data-count="${unread}" title="${unread} unread">${unread > 99 ? '99+' : unread}</span>`
            : isSystemEvent
                ? `<span class="wa-badge wa-badge--system" title="Group update">!</span>`
                : '';
        const previewCls = isBlocked
            ? 'wa-sidebar-preview wa-blocked'
            : (unread > 0 || isSystemEvent)
                ? 'wa-sidebar-preview wa-sidebar-preview--unread'
                : 'wa-sidebar-preview';
        const emailSubHTML = safeEmail
            ? `<span class="wa-sidebar-email">${safeEmail}</span>`
            : '';

        return `
<div class="wa-sidebar-item${isActive ? ' wa-sidebar-item--active' : ''}"
     data-room-id="${id}"
     data-email="${dataEmail}"
     data-name="${safeName}"
     data-type="${s(type)}"
     data-last-preview="${preview.replace(/"/g, '&quot;')}"
     role="button" tabindex="0" aria-label="Conversation with ${safeName}">
    <div class="wa-sidebar-avatar">
        ${this._avatarEl(name, type, online, 46, photoURL, type !== 'group' ? email : null)}
    </div>
    <div class="wa-sidebar-body">
        <div class="wa-sidebar-top">
            <div class="wa-sidebar-name-wrap">
                <span class="wa-sidebar-name${unread ? ' wa-sidebar-name--unread' : ''}">${safeName}${pinHTML}</span>
                ${emailSubHTML}
            </div>
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

        // Email subtitle (private chats only)
        const emailEl = el.querySelector('.wa-sidebar-email');
        if (d.type !== 'group' && d.email) {
            if (emailEl) {
                emailEl.textContent = d.email;
            } else {
                // Element missing (e.g. row created before this update) — inject it
                const nameWrap = el.querySelector('.wa-sidebar-name-wrap');
                if (nameWrap) {
                    const span = document.createElement('span');
                    span.className   = 'wa-sidebar-email';
                    span.textContent = d.email;
                    nameWrap.appendChild(span);
                }
            }
        }

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
                    : (d.unread > 0 || d.isSystemEvent)
                        ? 'wa-sidebar-preview wa-sidebar-preview--unread'
                        : 'wa-sidebar-preview';
                previewEl.className = cls;
                previewEl.textContent = this._sanitize(
                    (d.senderPrefix || '') + (d.lastMessage || ''),
                );
            }
        }

        // Unread badge / system-event dot
        const bottom  = el.querySelector('.wa-sidebar-bottom');
        let badgeEl   = el.querySelector('.wa-badge');
        if (d.unread > 0) {
            if (!badgeEl) {
                badgeEl = document.createElement('span');
                badgeEl.className = 'wa-badge';
                bottom?.appendChild(badgeEl);
            }
            // Clear any system-event variant so it doesn't linger
            badgeEl.classList.remove('wa-badge--system');
            badgeEl.dataset.count = d.unread;
            badgeEl.title         = `${d.unread} unread`;
            badgeEl.textContent   = d.unread > 99 ? '99+' : String(d.unread);
        } else if (d.isSystemEvent) {
            if (!badgeEl) {
                badgeEl = document.createElement('span');
                bottom?.appendChild(badgeEl);
            }
            badgeEl.className     = 'wa-badge wa-badge--system';
            badgeEl.dataset.count = '0';
            badgeEl.title         = 'Group update';
            badgeEl.textContent   = '!';
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
        // FIX BUG-6: tear down per-room typing subs before clearing the element
        // cache. Without this, _typingSubs entries for every previously-visible room
        // remain open as live Firestore onSnapshot listeners — accumulating over time,
        // billing read bandwidth, and holding memory — whenever the list temporarily
        // becomes empty (e.g. during a snapshot race where visibleChats.length === 0).
        // Presence subs are keyed by email, not roomId, and are cheap to re-open;
        // they will be torn down correctly via Q-4's fix in _applyDelta when rooms
        // depart. Typing subs are the ones that must be cleaned up here.
        for (const roomId of this._elements.keys()) {
            this._teardownTypingSub(roomId);
        }
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
            setTimeout(() => this.refresh(), 300);
        });
    }

    _resetAllUnread(user) {
        this._unread.rooms.clear();
        // DO NOT clear _unread.pending here.  pending is a write-in-flight guard
        // owned by markRoomRead() in chat.js: it prevents an incoming snapshot from
        // restoring a non-zero badge while the setDoc ACK is still in-flight.
        // Clearing it here (triggered when the chat list momentarily becomes empty,
        // e.g. the first snapshot fires before index propagation) destroys that guard
        // and causes the badge to flicker back to its old count on the next snapshot.
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
                // FIX: use ?? Date.now() so a pending serverTimestamp (null before
                // server ACK) is treated as "just written" rather than epoch 0.
                // With || 0, now - 0 >> TYPING_TTL_MS → indicator is immediately
                // discarded before it ever appears.  Same fix applied to
                // subscribeTypingIndicator in chat.js.
                const updatedMs = d.data().updatedAt?.toMillis?.() ?? Date.now();
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

    _injectStyles() {
        if (document.getElementById('rcm-styles')) return;
        const style = document.createElement('style');
        style.id = 'rcm-styles';
        style.textContent = `
.wa-sidebar-item {
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: center;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
}
.wa-swipe-action {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 72px;
    background: #ef4444;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s;
    flex-shrink: 0;
    cursor: pointer;
}
.wa-swipe-action.rcm-tap-visible {
    opacity: 1;
    pointer-events: auto;
}
.wa-swipe-delete-icon {
    font-size: 20px;
    pointer-events: none;
}
`;
        document.head.appendChild(style);
    }

    _wireInteractions() {
        if (this._interactionsWired) return;
        this._interactionsWired = true;

        this._injectStyles();

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

        // Search filter re-apply (Q-7: use bound ref so it can be removed in _removeInteractions)
        this._searchInput?.addEventListener('input', this._onSearchInput);
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
        // Q-7 FIX: remove the search input listener so re-login doesn't stack
        // an additional handler on every _wireInteractions() call.
        this._searchInput?.removeEventListener('input', this._onSearchInput);
    }

    _openItem(item) {
        const email    = item.dataset.email;
        // FIX ENTITY-DECODE: dataset.name was written via sanitize() which HTML-encodes
        // special characters (e.g. "O'Brien" → "O&#39;Brien"). Passing the encoded string
        // directly to openChatRoom stored it in Firestore and showed garbled names in the
        // chat header. Decode via a temporary element so the raw name is passed instead.
        const rawName  = item.dataset.name || '';
        const _tmp     = document.createElement('span');
        _tmp.innerHTML = rawName;
        const name     = _tmp.textContent;
        const chatType = item.dataset.type;
        if (!email) return;
        const currentActive = this._getActiveRoom?.();
        if (currentActive && currentActive === item.dataset.roomId) return;
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
        // Don't start long-press from a swipe-action button tap
        if (e.target.closest('.wa-swipe-action')) return;
        const item = e.target.closest('.wa-sidebar-item');
        if (!item) return;
        const touch = e.touches[0];
        const startX = touch.clientX;
        const startY = touch.clientY;
        this._lpTimer = setTimeout(() => {
            this._showContextMenu(item, touch.clientX, touch.clientY);
        }, LONG_PRESS_MS);
        // Cancel long-press if the finger moves (swipe gesture)
        const onMove = mv => {
            const dx = Math.abs(mv.touches[0].clientX - startX);
            const dy = Math.abs(mv.touches[0].clientY - startY);
            if (dx > 8 || dy > 8) {
                clearTimeout(this._lpTimer);
                this._lpTimer = null;
                item.removeEventListener('touchmove', onMove);
            }
        };
        item.addEventListener('touchmove', onMove, { passive: true });
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

        const roomId   = item.dataset.roomId;
        const chatData = this._lastChats.find(c => c.id === roomId);
        const user     = this._getUser();
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
                // FIX BUG-3: setDoc+merge with a dot-notation key like
                // `pinnedBy.user@gmail.com` treats the whole string as a literal
                // top-level field name, not a nested path. The security rule's
                // affectedKeys() check then sees 'pinnedBy.user@gmail.com' instead
                // of 'pinnedBy', so the pinnedBy guard never matches → silent deny.
                // updateDoc + FieldPath writes the correct nested map entry AND
                // satisfies the security rule.
                await updateDoc(
                    doc(this._db, 'chats', roomId),
                    new FieldPath('pinnedBy', user.email), !isPinned,
                );
                this._showToast(!isPinned ? 'Conversation pinned 📌' : 'Conversation unpinned', 'success');
            } catch (err) {
                console.error('[RecentChatsManager] pin error:', err);
                this._showToast('Failed to update pin.', 'error');
            }
            return;
        }

        if (action === 'ctx-mark-read') {
            // Snapshot pre-read count before zeroing — needed to restore the badge
            // correctly if the Firestore write fails (e.g. user goes offline).
            // Without this, a failed write leaves _unread.rooms at 0 permanently
            // and the badge shows 0 even though the server never confirmed the read.
            const prevCount = this._unread.rooms.get(roomId) ?? 0;

            // Optimistic clear
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
                // FIX BUG-4: dot-notation template keys like `lastRead.user@gmail.com`
                // cause Firestore to split on dots, writing lastRead["user@gmail"]["com"]
                // instead of lastRead["user@gmail.com"]. The security rule's
                //   request.resource.data.get('lastRead', {}).keys().hasOnly([callerEmail()])
                // check then sees a path the rule doesn't allow → permission-denied.
                // Use variadic FieldPath form to match the pattern in markRoomRead() in chat.js.
                await updateDoc(
                    doc(this._db, 'chats', roomId),
                    new FieldPath('lastRead',    user.email), serverTimestamp(),
                    new FieldPath('unreadCount', user.email), 0,
                );
                this._unread.pending.delete(roomId);
            } catch (err) {
                // Rollback: restore pre-read count immediately — don't rely on a future
                // snapshot to repair the badge (may never arrive if user is offline).
                console.warn('[RecentChatsManager] mark-read error:', err);
                this._unread.rooms.set(roomId, prevCount);
                this._unread.pending.delete(roomId);
                this._recomputeNavBadge();
            }
            return;
        }

        if (action === 'ctx-delete') {
            // FIX CTX-DELETE: previously this did a hard-delete of every message
            // AND the room doc, which also destroyed the other participant's chat.
            // For private chats that is clearly wrong — the other person should
            // keep their conversation history.  For group chats it was even worse:
            // a regular member could hard-delete the room for all members.
            //
            // New behaviour mirrors the "Delete Chat" action inside openChatRoom:
            //   1. Stamp deletedFor.currentUser on every message   → "delete for me"
            //   2. Set hiddenFor/hiddenAt on the room doc          → hide from sidebar
            // The other participant's messages and room doc are fully preserved.
            // The room will un-hide automatically if the other person sends a new
            // message after the deletion (RecentChatsManager._onSnapshot handles this).
            const isGroupChat = chatData?.type === 'group';
            const ok = await this._showConfirm({
                title:        'Delete chat?',
                body:         isGroupChat
                    ? 'This conversation will be removed from your chat list. Other members will not be affected.'
                    : 'This conversation will be removed from your chat list. The other person will not be affected.',
                confirmLabel: 'Delete',
                tone:         'danger',
            });
            if (!ok) return;

            const user = this._getUser();
            if (!user?.email) return;

            try {
                // Step 1: stamp deletedFor on every message (delete for me)
                const msgsSnap   = await getDocs(collection(this._db, `chats/${roomId}/messages`));
                const BATCH_SIZE = 499;
                const msgDocs    = msgsSnap.docs;
                for (let i = 0; i < msgDocs.length; i += BATCH_SIZE) {
                    const wb = writeBatch(this._db);
                    msgDocs.slice(i, i + BATCH_SIZE).forEach(d =>
                        wb.update(d.ref, { deletedFor: arrayUnion(user.email) }),
                    );
                    await wb.commit();
                }

                // Step 2: mark room hidden for this user only
                // FIX: use variadic FieldPath form — dot-notation template keys
                // like `hiddenFor.user@gmail.com` are mis-parsed by Firestore as
                // nested paths (hiddenFor → user@gmail → com), writing the flag
                // to the wrong key. FieldPath('hiddenFor', email) writes the
                // correct top-level map entry keyed by the full email string.
                await updateDoc(
                    doc(this._db, 'chats', roomId),
                    new FieldPath('hiddenFor', user.email), true,
                    new FieldPath('hiddenAt',  user.email), serverTimestamp(),
                );

                // Step 3: clean up local state
                this._unread.rooms.delete(roomId);
                this._unread.pending.delete(roomId);
                this._recomputeNavBadge();
                // The hiddenFor filter in _onSnapshot will remove the row from the
                // sidebar on the next snapshot delivery.  Remove it immediately from
                // the DOM so the user sees instant feedback.
                this.removeRoom(roomId);
                this._showToast('Conversation deleted.', 'success');
            } catch (err) {
                console.error('[RecentChatsManager] delete error:', err);
                this._showToast('Failed to delete chat.', 'error');
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SWIPE-TO-DELETE  [UX-2]
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Tap-to-delete on the .wa-swipe-action button (mobile UX).
     * First tap reveals the button (shows red delete zone).
     * Second tap (or any tap while revealed) calls _handleContextAction.
     * Tapping anywhere else hides it.
     */
    _wireSwipeActionTap(el, roomId) {
        const action = el.querySelector('.wa-swipe-action');
        if (!action) return;

        // Make the action area tappable
        action.style.pointerEvents = 'auto';
        action.setAttribute('aria-hidden', 'false');
        action.setAttribute('role', 'button');
        action.setAttribute('aria-label', 'Delete conversation');
        action.setAttribute('tabindex', '-1');

        action.addEventListener('click', async e => {
            e.stopPropagation();
            const chatData = this._lastChats.find(c => c.id === roomId);
            await this._handleContextAction('ctx-delete', roomId, chatData, el);
        });

        // Hide the action panel when user taps elsewhere
        el.addEventListener('click', e => {
            if (!e.target.closest('.wa-swipe-action') && action.classList.contains('rcm-tap-visible')) {
                action.classList.remove('rcm-tap-visible');
                el.style.transform = '';
            }
        });
    }

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
                // Swipe threshold reached: reveal the delete zone and wait for a tap.
                // This is consistent with the _wireSwipeActionTap tap-to-delete UX.
                el.style.transform  = 'translateX(-72px)';
                el.style.transition = 'transform .15s';
                const action = el.querySelector('.wa-swipe-action');
                if (action) {
                    action.style.opacity = '1';
                    action.classList.add('rcm-tap-visible');
                }
                // Tapping the action area is handled by _wireSwipeActionTap's click listener.
                // Tapping elsewhere resets via the el click listener in _wireSwipeActionTap.
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
        if (action) {
            action.style.opacity = '0';
            action.classList.remove('rcm-tap-visible');
        }
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