import { currentUser } from '../store/db.js';
import { db } from '../config/firebase.js';
import {
    collection, query, where, getDocs, orderBy
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { createPostCardHTML } from './templates.js';

// ============================================================
//  NAV SETUP
// ============================================================
export function setupNavigation() {
    // Delegated click handler for [data-target] links
    document.addEventListener('click', async (e) => {
        const navLink = e.target.closest('[data-target]');
        if (navLink) {
            e.preventDefault();
            showPage(navLink.dataset.target);
            // Update active nav state
            document.querySelectorAll('.nav-link[data-target]').forEach(l => {
                l.classList.toggle('active', l.dataset.target === navLink.dataset.target);
            });
            return;
        }

        // View user profile
        const profileLink = e.target.closest('.view-user-profile-btn');
        if (profileLink) {
            e.preventDefault();
            await loadUserProfile(profileLink.dataset.userEmail);
            return;
        }
    });

    // Profile dropdown toggle
    const profileMenu = document.getElementById('profile-dropdown-menu');
    const dropdownBtn = document.getElementById('profile-dropdown-btn');

    if (dropdownBtn && profileMenu) {
        dropdownBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            profileMenu.classList.toggle('hidden');
        });
    }

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
        if (profileMenu && dropdownBtn && !dropdownBtn.contains(e.target)) {
            profileMenu.classList.add('hidden');
        }
    });

    // Scroll header effect
    window.addEventListener('scroll', () => {
        const header = document.getElementById('header');
        if (header) header.classList.toggle('scrolled', window.scrollY > 10);
    }, { passive: true });
}

// ============================================================
//  PAGE ROUTER
// ============================================================
export function showPage(pageId) {
    // Guard: unauthenticated → login
    if (!currentUser && pageId !== 'page-login') pageId = 'page-login';

    // Guard: non-admin → home
    if (pageId === 'page-admin' && currentUser?.role !== 'admin') {
        pageId = 'page-home';
    }

    // Toggle sections
    document.querySelectorAll('.page-section').forEach(sec => {
        const isTarget = sec.id === pageId;
        sec.classList.toggle('hidden', !isTarget);
        // Trigger entrance animation on reveal
        if (isTarget) {
            sec.style.animation = 'none';
            // Force reflow
            void sec.offsetHeight;
            sec.style.animation = '';
        }
    });

    // Secondary navbar visibility
    const navbar = document.getElementById('secondary-navbar');
    if (navbar) {
        const pagesWithNav = [
            'page-posts', 'page-create', 'page-lost-found', 'page-chat',
            'page-help', 'page-comments', 'page-my-posts', 'page-profile',
            'page-achievements', 'page-ai-chat', 'page-user-profile', 'page-admin'
        ];
        navbar.classList.toggle('hidden', !currentUser || !pagesWithNav.includes(pageId));
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================================================
//  AUTH UI UPDATE
// ============================================================
export function updateAuthUI() {
    const guestView   = document.getElementById('header-guest-view');
    const authView    = document.getElementById('header-auth-view');
    const nameEl      = document.getElementById('header-user-name');
    const avatar      = document.getElementById('header-avatar');
    const mainNavLinks= document.getElementById('main-nav-links');
    const adminLink   = document.getElementById('admin-panel-link');

    if (currentUser) {
        // Show auth UI
        guestView?.classList.add('hidden');
        if (authView) { authView.classList.remove('hidden'); authView.classList.add('flex'); }

        // Populate profile data
        if (nameEl) nameEl.textContent = currentUser.name;
        const dropName  = document.getElementById('dropdown-user-name');
        const dropEmail = document.getElementById('dropdown-user-email');
        if (dropName)  dropName.textContent  = currentUser.name;
        if (dropEmail) dropEmail.textContent = currentUser.email;

        // Avatar: photo or initials
        if (avatar) {
            if (currentUser.picture) {
                avatar.innerHTML = `<img src="${currentUser.picture}" alt="${currentUser.name}" class="w-full h-full object-cover rounded-lg">`;
            } else {
                const initials = currentUser.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
                avatar.textContent = initials;
            }
        }

        // Show navigation
        if (mainNavLinks) {
            mainNavLinks.classList.remove('hidden');
            mainNavLinks.classList.add('grid');
        }

        // Admin link
        if (adminLink) adminLink.classList.toggle('hidden', currentUser.role !== 'admin');

        showPage('page-home');

    } else {
        // Show guest UI
        guestView?.classList.remove('hidden');
        if (authView) { authView.classList.add('hidden'); authView.classList.remove('flex'); }

        if (mainNavLinks) {
            mainNavLinks.classList.add('hidden');
            mainNavLinks.classList.remove('grid');
        }
        if (adminLink) adminLink.classList.add('hidden');

        showPage('page-login');
    }
}

// ============================================================
//  USER PROFILE LOADER
// ============================================================
async function loadUserProfile(email) {
    if (!email) return;
    const feed = document.getElementById('user-profile-posts-feed');
    if (!feed) return;

    showPage('page-user-profile');
    feed.innerHTML = `
        <div class="text-center py-8 text-gray-400">
            <div class="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
            Loading posts…
        </div>`;

    try {
        const q = query(
            collection(db, 'posts'),
            where('authorEmail', '==', email),
            orderBy('timestamp', 'desc')
        );
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            feed.innerHTML = `<div class="text-center py-12 text-gray-400">No posts yet.</div>`;
        } else {
            feed.innerHTML = '';
            snapshot.forEach(docSnap => {
                feed.innerHTML += createPostCardHTML({ id: docSnap.id, ...docSnap.data() }, currentUser);
            });
        }
    } catch (err) {
        console.error('Profile load error:', err);
        feed.innerHTML = `<div class="text-center py-8 text-red-400">Failed to load profile posts.</div>`;
    }
}

// ============================================================
//  THEME TOGGLE — persisted to localStorage
// ============================================================
export function setupThemeToggle() {
    const btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;

    // NOTE: index.html's inline <script> is the single source of truth for
    // theme toggling — it already owns the click listener, localStorage
    // persistence, and initial-load logic (including system preference
    // fallback). This function used to ALSO bind its own click listener
    // here, which fired on every click right after the inline script's
    // listener and immediately flipped `dark-mode` back off (or on) —
    // the two listeners were canceling each other out on every single
    // click, which is why the toggle looked completely broken. This
    // function now only keeps the icon in sync; it never toggles the
    // theme itself.

    const sunIcon  = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>`;
    const moonIcon = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 015.646 5.646 9.001 9.001 0 0020.354 15.354z"/></svg>`;

    // Keep the icon correct if this module initializes after the inline
    // script has already applied a theme (sun = currently dark, click to
    // go light; moon = currently light, click to go dark).
    const isDark = document.body.classList.contains('dark-mode');
    btn.innerHTML = isDark ? sunIcon : moonIcon;

    // Re-sync the icon if the theme changes by any other means (e.g. the
    // inline script's own listener), so this module never drifts out of
    // sync with the actual body class.
    const syncObserver = new MutationObserver(() => {
        const nowDark = document.body.classList.contains('dark-mode');
        btn.innerHTML = nowDark ? sunIcon : moonIcon;
    });
    syncObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}