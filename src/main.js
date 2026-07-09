import { setupNavigation, setupThemeToggle } from './ui/navigation.js';
import { setupAuth } from './features/auth.js';
import { setupPosts } from './features/posts.js';
import { setupEventsAndPolls } from './features/eventsAndPolls.js';
import { setupComments } from './features/comments.js';
import { setupChat, teardownChat } from './features/chat.js';
import { setupLostFound } from './features/lostFound.js';
import { setupAiChat, setApiKey } from './features/aiChat.js';
import { setupAchievements } from './features/achievements.js';
import { setupProfile } from './features/profile.js';
import { setupAdmin } from './features/admin.js';
import { initPostOptionsDropdowns } from './ui/templates.js';
import { setupLiveChat, teardownLiveChat } from './features/Livechat.js';

// Firebase & DB Imports
import { db, auth, googleProvider } from './config/firebase.js';
import { currentUser, onCurrentUserChange } from './store/db.js';
import { onSnapshot, doc } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { signOut, signInWithPopup } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';

document.addEventListener('DOMContentLoaded', () => {

    // ==========================================
    // MAINTENANCE LOCK
    // ==========================================
    window.isMaintenanceActive = false;
    let _maintOverlayReady = false;  // guard against duplicate overlay creation
    let _maintInterval     = null;

    function enforceMaintenanceLock() {
        const isMaint   = window.isMaintenanceActive;
        const isAdmin   = currentUser && currentUser.role === 'admin';
        const isLoggedIn = auth.currentUser !== null;

        const header = document.getElementById('header');
        const main   = document.querySelector('main');
        let   overlay = document.getElementById('maint-overlay-lock');

        // ── LOCK: maintenance ON and user is NOT an admin ──────────────────
        if (isMaint && !isAdmin) {
            if (header) header.style.display = 'none';
            if (main)   main.style.display   = 'none';

            if (!overlay && !_maintOverlayReady) {
                _maintOverlayReady = true;

                overlay = document.createElement('div');
                overlay.id = 'maint-overlay-lock';
                overlay.style.cssText = [
                    'position:fixed;inset:0;z-index:999999',
                    'display:flex;flex-direction:column;align-items:center;justify-content:center',
                    'background:#020617;color:white;padding:2rem;text-align:center',
                    'font-family:"Inter",sans-serif',
                ].join(';');

                overlay.innerHTML = `
                    <div style="width:80px;height:80px;background:rgba(56,189,248,.1);border-radius:50%;
                                display:flex;align-items:center;justify-content:center;margin-bottom:2rem;
                                border:1px solid rgba(56,189,248,.2);box-shadow:0 0 30px rgba(56,189,248,.2);">
                        <svg style="width:40px;height:40px;color:#38bdf8;" fill="none" viewBox="0 0 24 24"
                             stroke="currentColor" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round"
                                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667
                                     1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34
                                     16c-.77-1.333.192 3 1.732 3z"/>
                        </svg>
                    </div>
                    <h1 style="font-size:2.5rem;font-weight:900;letter-spacing:-.05em;margin-bottom:1rem;">
                        🛠️ Maintenance Mode
                    </h1>
                    <p style="color:#94a3b8;font-size:1.1rem;max-width:500px;line-height:1.6;margin-bottom:2.5rem;">
                        The system is currently undergoing scheduled maintenance.
                        Secure access will be restored shortly.
                    </p>
                    <button id="maint-action-btn"
                            style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);
                                   padding:14px 28px;border-radius:99px;color:white;font-weight:bold;
                                   cursor:pointer;transition:all .3s;font-size:.9rem;
                                   text-transform:uppercase;letter-spacing:.05em;">
                    </button>`;

                document.body.appendChild(overlay);

                document.getElementById('maint-action-btn').addEventListener('click', async (e) => {
                    const btn = e.currentTarget;
                    btn.textContent = 'Processing…';
                    btn.disabled    = true;
                    try {
                        if (auth.currentUser) {
                            await signOut(auth);
                        } else {
                            await signInWithPopup(auth, googleProvider);
                        }
                        window.location.reload();
                    } catch {
                        btn.disabled = false;
                        _syncMaintBtn();
                    }
                });
            }

            // Keep button label in sync with auth state
            _syncMaintBtn();

        } else {
            // ── UNLOCK: maintenance OFF or user is an admin ──────────────────
            if (overlay) {
                overlay.remove();
                _maintOverlayReady = false;
            }
            // Don't restore header/main if the ban lock also needs them hidden
            // (this listener can fire independently of the ban-lock poll below).
            if (!(currentUser && currentUser.isBanned)) {
                if (header) header.style.display = '';
                if (main)   main.style.display   = '';
            }
        }
    }

    function _syncMaintBtn() {
        const btn = document.getElementById('maint-action-btn');
        if (btn && btn.textContent !== 'Processing…') {
            btn.textContent = auth.currentUser ? 'Switch Account (Logout)' : '🔒 Admin Login Only';
        }
    }

    // ==========================================
    // BAN LOCK
    // ──────────────────────────────────────────
    // firestore.rules now hard-blocks writes from banned users (isBanned()
    // check on every create rule) — that's the actual security enforcement.
    // This overlay is the UX layer on top of it: without it, a suspended user
    // just sees confusing "Failed to..." toasts from permission-denied errors
    // every time they try to post/comment/chat, with no explanation why.
    //
    // currentUser.isBanned is populated once at sign-in (auth.js fetches the
    // Firestore profile then). Same convention as currentUser.role elsewhere
    // in this file — a change made by an admin takes effect for the affected
    // user on their next login/refresh, not instantly mid-session. The rules
    // enforcement above is what actually stops writes in the meantime.
    // ==========================================
    let _banOverlayReady = false;

    function enforceBanLock() {
        const isBannedUser = !!(currentUser && currentUser.isBanned);
        const header = document.getElementById('header');
        const main   = document.querySelector('main');
        let   overlay = document.getElementById('ban-overlay-lock');

        if (isBannedUser) {
            if (header) header.style.display = 'none';
            if (main)   main.style.display   = 'none';

            if (!overlay && !_banOverlayReady) {
                _banOverlayReady = true;

                overlay = document.createElement('div');
                overlay.id = 'ban-overlay-lock';
                overlay.style.cssText = [
                    'position:fixed;inset:0;z-index:999999',
                    'display:flex;flex-direction:column;align-items:center;justify-content:center',
                    'background:#020617;color:white;padding:2rem;text-align:center',
                    'font-family:"Inter",sans-serif',
                ].join(';');

                overlay.innerHTML = `
                    <div style="width:80px;height:80px;background:rgba(248,113,113,.1);border-radius:50%;
                                display:flex;align-items:center;justify-content:center;margin-bottom:2rem;
                                border:1px solid rgba(248,113,113,.2);box-shadow:0 0 30px rgba(248,113,113,.2);">
                        <svg style="width:40px;height:40px;color:#f87171;" fill="none" viewBox="0 0 24 24"
                             stroke="currentColor" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round"
                                  d="M18.364 18.364A9 9 0 105.636 5.636a9 9 0 0012.728 12.728zM5.636 5.636l12.728 12.728"/>
                        </svg>
                    </div>
                    <h1 style="font-size:2.5rem;font-weight:900;letter-spacing:-.05em;margin-bottom:1rem;">
                        Account Suspended
                    </h1>
                    <p style="color:#94a3b8;font-size:1.1rem;max-width:500px;line-height:1.6;margin-bottom:2.5rem;">
                        Your account has been suspended by a moderator for violating
                        community guidelines. If you believe this is a mistake, please
                        contact the community team.
                    </p>
                    <button id="ban-logout-btn"
                            style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);
                                   padding:14px 28px;border-radius:99px;color:white;font-weight:bold;
                                   cursor:pointer;transition:all .3s;font-size:.9rem;
                                   text-transform:uppercase;letter-spacing:.05em;">
                        Log Out
                    </button>`;

                document.body.appendChild(overlay);

                document.getElementById('ban-logout-btn').addEventListener('click', async (e) => {
                    const btn = e.currentTarget;
                    btn.textContent = 'Processing…';
                    btn.disabled    = true;
                    try {
                        await signOut(auth);
                        window.location.reload();
                    } catch (err) {
                        console.error('Ban-lock sign-out error:', err);
                        btn.disabled = false;
                        btn.textContent = 'Log Out';
                    }
                });
            }
        } else {
            if (overlay) {
                overlay.remove();
                _banOverlayReady = false;
            }
            // Only restore header/main here if maintenance lock isn't also
            // supposed to be hiding them right now.
            if (!(window.isMaintenanceActive && !(currentUser && currentUser.role === 'admin'))) {
                if (header) header.style.display = '';
                if (main)   main.style.display   = '';
            }
        }
    }

    // Poll at a gentler cadence (1 s) to catch auth-state flips between Firestore snapshots.
    // Cleared automatically if the page is hidden to avoid background CPU waste.
    function _enforceAccessLocks() {
        enforceMaintenanceLock();
        enforceBanLock();
    }

    // Listen to Firestore for the global maintenance flag
    onSnapshot(
        doc(db, 'platform_settings', 'global'),
        (docSnap) => {
            window.isMaintenanceActive = docSnap.exists() && docSnap.data().maintenanceMode === true;
            _enforceAccessLocks();
        },
        (error) => {
            console.error(
                'CRITICAL: Update your Firebase rules to allow public read on platform_settings!',
                error,
            );
        },
    );

    _maintInterval = setInterval(_enforceAccessLocks, 1000);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            clearInterval(_maintInterval);
        } else {
            _maintInterval = setInterval(_enforceAccessLocks, 1000);
        }
    });

    // ==========================================
    // INITIALIZE CORE MODULES
    // ==========================================
    // Show login page immediately so screen is never blank while Firebase initialises.
    // All page-sections default to hidden in HTML; without this, users see a blank
    // dark screen for 1-3 seconds until onAuthStateChanged fires and calls showPage().
    document.querySelectorAll('.page-section').forEach(sec => {
        sec.classList.toggle('hidden', sec.id !== 'page-login');
    });

    // setupNavigation, setupThemeToggle, and setupAuth are UI/auth bootstraps
    // that must run immediately — they don't touch Firestore.
    setupNavigation();
    setupThemeToggle();
    setupAuth();
    initPostOptionsDropdowns(); // registers global 3-dot dropdown handler (templates.js)

    // Live chat button wiring runs immediately so unauthenticated users see
    // the button and get redirected to sign-in on click.
    setupLiveChat();

    // All modules that open Firestore listeners (posts, chat, admin, etc.) are
    // deferred until the app's own currentUser is fully populated — meaning
    // auth.js has finished fetching the user's Firestore profile (including role).
    //
    // We use onCurrentUserChange from store/db.js rather than Firebase's own
    // onAuthStateChanged because the Firebase callback fires BEFORE auth.js has
    // awaited getUserFromDB() and called setCurrentUser(). At that point
    // currentUser is still null, so setupAdmin() would run without a role and
    // all admin Firestore reads would get permission-denied.
    //
    // onCurrentUserChange fires only AFTER setCurrentUser() is called, which is
    // the earliest moment currentUser.role is actually available.
    let _modulesInitialised = false;
    onCurrentUserChange((user) => {
        if (!user && _modulesInitialised) {
            // User signed out — tear down ALL module subscriptions so stale
            // Firestore listeners don't fire against a null currentUser.
            teardownChat();
            teardownLiveChat();
            // Reset init flag so modules re-initialise cleanly on next sign-in
            _modulesInitialised = false;
        }
        if (!user) enforceBanLock(); // currentUser is null here, so this just clears any stale overlay
        if (user && !_modulesInitialised) {
            _modulesInitialised = true;
            enforceBanLock();
            setupPosts();
            setupEventsAndPolls();
            setupComments();
            setupChat();
            setupLostFound();
            // Gemini API key: read from localStorage first, then window.__GEMINI_KEY.
            // The user can set it via the AI chat UI if missing.
            const savedKey = localStorage.getItem('echo_gemini_api_key');
            if (savedKey) setApiKey(savedKey);
            else if (window.__GEMINI_KEY) setApiKey(window.__GEMINI_KEY);
            setupAiChat({ theme: 'dark' });
            setupAchievements();
            setupProfile();
            setupAdmin();

            // FIX 7: After all modules have initialised, check for a ?joinGroup=CODE
            // URL parameter (set by the invite link) and automatically trigger the
            // "Join a Group" flow so the user lands directly on that dialog.
            const joinCode = new URLSearchParams(window.location.search).get('joinGroup');
            if (joinCode) {
                // Strip the param from the URL (no page reload)
                const cleanUrl = window.location.origin + window.location.pathname;
                window.history.replaceState({}, '', cleanUrl);
                // Navigate to the chat page then open the join modal pre-filled
                setTimeout(() => {
                    const chatNavBtn = document.querySelector('[data-target="page-chat"]');
                    if (chatNavBtn) chatNavBtn.click();
                    setTimeout(() => {
                        const joinBtn = document.getElementById('btn-join-group');
                        if (joinBtn) {
                            joinBtn.click();
                            setTimeout(() => {
                                const input = document.getElementById('join-group-code-input');
                                if (input) {
                                    input.value = joinCode.toUpperCase();
                                    input.dispatchEvent(new Event('input'));
                                }
                            }, 300);
                        }
                    }, 400);
                }, 600);
            }
        }
    });

    // ==========================================
    // GLOBAL REPORT MODAL
    // ──────────────────────────────────────────
    // The modal HTML and its open/close controller now live in index.html
    // (the inline <script> block just above the module script tag).
    // main.js only needs to:
    //   1. Set the hidden content-id / content-type fields
    //   2. Call window._reportModalOpen() which index.html exposes
    //   3. Handle the form submit to write to Firestore
    // ==========================================

    // NOTE: window.openReportModal is registered by templates.js (IIFE at bottom of that file).
    // It writes directly to Firestore 'reports' and handles its own modal UI.
    // Do NOT redefine it here — doing so would shadow the templates.js version and break reporting.
    //
    // The legacy #report-form / #report-content-id DOM elements in index.html are no longer
    // used; templates.js builds and manages its own modal dynamically.
});