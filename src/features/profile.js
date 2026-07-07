import { db } from '../config/firebase.js';
import { currentUser } from '../store/db.js';
import { sanitize } from '../ui/templates.js';
import {
    doc, updateDoc, getDoc,
    collection, query, where, orderBy, getDocs
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// We expose a hook so posts.js can register its renderPost + handleFeedClick
// without creating a circular import. posts.js calls window.__registerPostRenderer().
let _renderPost = null;
let _handleFeedClick = null;

window.__registerPostRenderer = (renderFn, clickHandler) => {
    _renderPost = renderFn;
    _handleFeedClick = clickHandler;
};

export function setupProfile() {

    // ==========================================
    // 1. UPDATE OWN PROFILE (The Form)
    // ==========================================
    document.getElementById('profile-update-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!currentUser) return;

        const btn = e.target.querySelector('button[type="submit"]');
        btn.textContent = 'Saving...'; btn.disabled = true;

        const name     = document.getElementById('profile-update-name').value.trim();
        const major    = document.getElementById('profile-update-major').value.trim();
        const gradYear = document.getElementById('profile-update-year').value.trim();
        const bio      = document.getElementById('profile-update-bio').value.trim();

        const skillsRaw  = document.getElementById('profile-update-skills')?.value || '';
        const skillsArray = skillsRaw.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
        const github   = document.getElementById('profile-update-github')?.value.trim()  || '';
        const linkedin = document.getElementById('profile-update-linkedin')?.value.trim() || '';

        try {
            await updateDoc(doc(db, 'users', currentUser.email), {
                name, major, gradYear, bio,
                skills: skillsArray,
                socialLinks: { github, linkedin }
            });

            currentUser.name     = name;
            currentUser.major    = major;
            currentUser.gradYear = gradYear;
            currentUser.bio      = bio;
            currentUser.skills   = skillsArray;
            currentUser.socialLinks = { github, linkedin };

            const successMsg = document.getElementById('profile-update-success');
            successMsg.textContent = 'Profile updated successfully!';
            successMsg.classList.remove('hidden');
            setTimeout(() => successMsg.classList.add('hidden'), 3000);

        } catch (error) {
            console.error("Profile update failed:", error);
            alert("Failed to update profile.");
        } finally {
            btn.textContent = 'Save Changes'; btn.disabled = false;
        }
    });

    // ==========================================
    // 2. VIEWING OTHERS' PROFILES
    // ==========================================
    document.addEventListener('click', async (e) => {
        const profileBtn = e.target.closest('.view-user-profile-btn');
        if (!profileBtn) return;

        const targetEmail = profileBtn.dataset.userEmail;
        if (!targetEmail) return;

        try {
            const targetSnap = await getDoc(doc(db, 'users', targetEmail));
            if (!targetSnap.exists()) return alert("User not found.");

            const userData = targetSnap.data();
            const isMe     = currentUser && currentUser.email === targetEmail;

            // ── Skills chips ──────────────────────────────────────────────
            let skillsHTML = '';
            if (userData.skills?.length) {
                skillsHTML = `<div class="profile-skills-row">` +
                    userData.skills.map(s =>
                        `<span class="profile-skill-chip">${sanitize(s)}</span>`
                    ).join('') +
                    `</div>`;
            }

            // ── Social links ──────────────────────────────────────────────
            let socialHTML = '';
            if (userData.socialLinks?.github) {
                socialHTML += `<a href="${sanitize(userData.socialLinks.github)}" target="_blank" class="profile-social-link" title="GitHub">
                    <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                    </svg>
                </a>`;
            }
            if (userData.socialLinks?.linkedin) {
                socialHTML += `<a href="${sanitize(userData.socialLinks.linkedin)}" target="_blank" class="profile-social-link profile-social-link--linkedin" title="LinkedIn">
                    <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/>
                    </svg>
                </a>`;
            }

            // ── Profile header HTML ───────────────────────────────────────
            const profileCardHTML = `
                <div class="up-profile-card">
                    <div class="up-avatar">${(userData.name || 'U').charAt(0).toUpperCase()}</div>
                    <div class="up-info">
                        <h2 class="up-name">${sanitize(userData.name || 'Unknown')}</h2>
                        <p class="up-email">${sanitize(targetEmail)}</p>
                        ${userData.major ? `<p class="up-meta">🎓 ${sanitize(userData.major)}${userData.gradYear ? ' · Class of ' + sanitize(userData.gradYear) : ''}</p>` : ''}
                        ${userData.bio   ? `<p class="up-bio">${sanitize(userData.bio)}</p>` : ''}
                        ${skillsHTML}
                        ${socialHTML ? `<div class="up-socials">${socialHTML}</div>` : ''}
                    </div>
                    ${!isMe ? `
                    <button class="up-message-btn" data-email="${sanitize(targetEmail)}" data-name="${sanitize(userData.name || '')}">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        </svg>
                        Message
                    </button>` : `
                    <a href="#" data-target="page-profile" class="up-edit-btn">Edit Profile</a>`}
                </div>`;

            // ── Inject into the page ──────────────────────────────────────
            const page = document.getElementById('page-user-profile');
            if (!page) return;

            // Replace the entire page content
            page.innerHTML = `
                <div class="up-page-wrap">
                    ${profileCardHTML}
                    <div class="up-posts-section">
                        <h3 class="up-posts-heading">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                <polyline points="14 2 14 8 20 8"/>
                            </svg>
                            Posts by ${sanitize(userData.name || 'User')}
                        </h3>
                        <div id="user-profile-posts-feed"></div>
                    </div>
                </div>`;

            // Navigate to the page
            document.querySelector('[data-target="page-user-profile"]')?.click();

            // ── Load user's posts ─────────────────────────────────────────
            _loadUserPosts(targetEmail, userData.name || 'User');

        } catch (error) {
            console.error("Fetch profile error:", error);
        }
    });

    // Message button on profile page (delegated)
    document.addEventListener('click', (e) => {
        const msgBtn = e.target.closest('.up-message-btn');
        if (!msgBtn) return;
        if (!currentUser) {
            alert('Sign in to send messages.');
            return;
        }
        const email = msgBtn.dataset.email;
        const name  = msgBtn.dataset.name;
        document.querySelector('a[data-target="page-chat"]')?.click();
        window.startDirectChat?.(email, name);
    });

    // Edit profile link in profile page
    document.addEventListener('click', (e) => {
        const editBtn = e.target.closest('.up-edit-btn');
        if (!editBtn) return;
        e.preventDefault();
        document.querySelector('a[data-target="page-profile"]')?.click();
    });

    _injectProfileStyles();
}

// ── Load + render the user's posts ────────────────────────────────────────────
async function _loadUserPosts(email, userName) {
    const feed = document.getElementById('user-profile-posts-feed');
    if (!feed) return;

    feed.innerHTML = `<div class="up-loading">
        <div class="up-spinner"></div>
        <p>Loading posts…</p>
    </div>`;

    try {
        const q    = query(
            collection(db, 'posts'),
            where('authorEmail', '==', email),
            orderBy('timestamp', 'desc')
        );
        const snap = await getDocs(q);

        feed.innerHTML = '';

        if (snap.empty) {
            feed.innerHTML = `
                <div class="up-empty">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="1.5">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                    </svg>
                    <p>${sanitize(userName)} hasn't posted anything yet.</p>
                </div>`;
            return;
        }

        snap.forEach(d => {
            const post = { id: d.id, ...d.data() };

            // Populate the posts.js cache so upvote/bookmark/share/3-dot all work
            window.__postCacheSet?.(post.id, post);

            if (_renderPost) {
                const card = _renderPost(post);
                feed.appendChild(card);
            } else {
                // Fallback minimal card if renderPost isn't registered yet
                const card = document.createElement('div');
                card.className      = 'post-card';
                card.dataset.postId = post.id;
                card.innerHTML = `
                    <p style="font-weight:600;margin:0 0 6px">${post.title || ''}</p>
                    <p style="margin:0;color:#6b7280;font-size:14px">${(post.content || '').slice(0, 200)}${post.content?.length > 200 ? '…' : ''}</p>`;
                feed.appendChild(card);
            }
        });

    } catch (err) {
        console.error('[UserProfile] load posts error:', err);
        feed.innerHTML = `
            <div class="up-empty" style="color:#ef4444">
                <p>Failed to load posts. Please try again.</p>
            </div>`;
    }
}

// ── Styles ─────────────────────────────────────────────────────────────────────
function _injectProfileStyles() {
    if (document.getElementById('up-profile-styles')) return;
    const style = document.createElement('style');
    style.id = 'up-profile-styles';
    style.textContent = `
        /* ── Page wrapper ─── */
        .up-page-wrap {
            max-width: 680px;
            margin: 0 auto;
            padding: 24px 12px 80px;
        }

        /* ── Profile card ─── */
        .up-profile-card {
            display: flex;
            align-items: flex-start;
            gap: 20px;
            background: var(--surface-2, #fff);
            border: 0.5px solid var(--border, #ebebeb);
            border-radius: 20px;
            padding: 24px;
            margin-bottom: 28px;
            box-shadow: 0 2px 12px rgba(0,0,0,0.06);
            flex-wrap: wrap;
            position: relative;
        }
        body.dark-mode .up-profile-card {
            background: #1c1c1f;
            border-color: #2a2a2e;
        }

        /* ── Avatar ─── */
        .up-avatar {
            width: 72px; height: 72px;
            border-radius: 50%;
            background: linear-gradient(135deg, #6366f1, #8b5cf6);
            color: #fff;
            font-size: 28px;
            font-weight: 700;
            display: flex; align-items: center; justify-content: center;
            flex-shrink: 0;
            box-shadow: 0 4px 14px rgba(99,102,241,0.4);
        }

        /* ── Info ─── */
        .up-info { flex: 1; min-width: 0; }
        .up-name {
            font-size: 22px; font-weight: 700;
            color: var(--text-primary, #111);
            margin: 0 0 2px;
        }
        body.dark-mode .up-name { color: #f4f4f5; }
        .up-email {
            font-size: 13px; color: #6366f1;
            margin: 0 0 6px;
        }
        .up-meta {
            font-size: 13px; color: var(--text-muted, #6b7280);
            margin: 0 0 6px;
        }
        .up-bio {
            font-size: 14px; color: var(--text-secondary, #374151);
            line-height: 1.6; margin: 8px 0 0;
        }
        body.dark-mode .up-bio   { color: #a1a1aa; }
        body.dark-mode .up-meta  { color: #71717a; }

        /* ── Skills ─── */
        .profile-skills-row {
            display: flex; flex-wrap: wrap; gap: 6px;
            margin-top: 10px;
        }
        .profile-skill-chip {
            font-size: 11px; font-weight: 600;
            text-transform: uppercase; letter-spacing: 0.06em;
            color: #0ea5e9;
            background: rgba(14,165,233,0.1);
            border: 1px solid rgba(14,165,233,0.25);
            padding: 3px 10px; border-radius: 6px;
        }

        /* ── Socials ─── */
        .up-socials {
            display: flex; gap: 12px; margin-top: 12px;
        }
        .profile-social-link {
            color: #9ca3af;
            text-decoration: none;
            display: flex; align-items: center;
            transition: color 0.15s, transform 0.15s;
        }
        .profile-social-link:hover { color: #f4f4f5; transform: translateY(-2px); }
        .profile-social-link--linkedin:hover { color: #0ea5e9; }

        /* ── Message / Edit buttons ─── */
        .up-message-btn {
            display: inline-flex; align-items: center; gap: 7px;
            padding: 10px 20px; border-radius: 50px;
            background: linear-gradient(135deg, #6366f1, #4f46e5);
            color: #fff; font-size: 14px; font-weight: 600;
            border: none; cursor: pointer;
            box-shadow: 0 4px 14px rgba(99,102,241,0.35);
            transition: transform 0.15s, box-shadow 0.15s;
            align-self: flex-start;
            white-space: nowrap;
        }
        .up-message-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(99,102,241,0.5);
        }
        .up-message-btn:active { transform: scale(0.96); }

        .up-edit-btn {
            display: inline-flex; align-items: center;
            padding: 10px 20px; border-radius: 50px;
            background: var(--surface-0, #f3f4f6);
            color: var(--text-primary, #374151);
            font-size: 14px; font-weight: 600;
            text-decoration: none; border: 1px solid var(--border, #e5e7eb);
            transition: background 0.15s;
            align-self: flex-start; white-space: nowrap;
        }
        .up-edit-btn:hover { background: var(--surface-1, #e5e7eb); }
        body.dark-mode .up-edit-btn { background: #27272a; border-color: #3f3f46; color: #d4d4d8; }

        /* ── Posts section ─── */
        .up-posts-section { }
        .up-posts-heading {
            font-size: 17px; font-weight: 700;
            color: var(--text-primary, #111);
            margin: 0 0 16px;
            display: flex; align-items: center; gap: 8px;
        }
        body.dark-mode .up-posts-heading { color: #f4f4f5; }

        /* ── Loading ─── */
        .up-loading {
            display: flex; flex-direction: column; align-items: center;
            gap: 12px; padding: 48px 0;
            color: var(--text-muted, #9ca3af); font-size: 14px;
        }
        .up-spinner {
            width: 32px; height: 32px; border-radius: 50%;
            border: 3px solid rgba(99,102,241,0.2);
            border-top-color: #6366f1;
            animation: spin 0.7s linear infinite;
        }

        /* ── Empty state ─── */
        .up-empty {
            text-align: center; padding: 48px 24px;
            background: var(--surface-2, #fff);
            border: 0.5px dashed var(--border, #e5e7eb);
            border-radius: 16px;
            color: var(--text-muted, #9ca3af); font-size: 15px;
            display: flex; flex-direction: column; align-items: center; gap: 12px;
        }
        body.dark-mode .up-empty { background: #18181b; border-color: #27272a; }

        @media (max-width: 480px) {
            .up-profile-card { gap: 14px; padding: 16px; }
            .up-avatar { width: 56px; height: 56px; font-size: 22px; }
            .up-name { font-size: 18px; }
            .up-message-btn, .up-edit-btn { padding: 8px 16px; font-size: 13px; }
        }
    `;
    document.head.appendChild(style);
}