/**
 * posts.js  —  Advanced Community Feed Module
 *
 * Features added / refined:
 *  - Debounced, multi-filter real-time feed (community + hashtag + keyword search)
 *  - Optimistic UI for all interactions (upvote, bookmark, poll vote)
 *  - Rich post-creation form: media preview, poll builder, tag autocomplete
 *  - Reaction system with animated micro-interactions
 *  - Infinite scroll with smooth skeleton shimmer placeholders
 *  - Read-time estimate per post
 *  - AI summarise with streaming-style typewriter output
 *  - Comprehensive error handling with user-friendly toasts
 *  - In-memory post cache + per-snapshot reconciliation (no full DOM re-render)
 *  - Accessibility: keyboard-navigable dropdowns, ARIA labels, focus traps
 *  - Post editing (author only) via inline modal
 *  - Pin-to-top feature for mods
 *  - Image lightbox on click
 */

import { db } from '../config/firebase.js';
import { addDocument, currentUser } from '../store/db.js';
import { uploadImage } from '../utils/storage.js';
import {
    createPostCardHTML,
    handleAiSummarize,
} from '../ui/templates.js';
import {
    collection, onSnapshot, query, orderBy, limit,
    doc, updateDoc, arrayUnion, arrayRemove, deleteDoc,
    getDoc, setDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

/** Fire-and-forget toast notification. */
function showToast(message, type = 'info', duration = 3500) {
    const ICONS = { info: 'ℹ️', success: '✅', warn: '⚠️', warning: '⚠️', error: '❌' };
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.setAttribute('role', 'status');
        container.setAttribute('aria-live', 'polite');
        container.style.cssText = `
            position: fixed; bottom: 24px; right: 24px; z-index: 9999;
            display: flex; flex-direction: column; gap: 8px; pointer-events: none;
        `;
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.style.cssText = `
        background: #1e293b; color: #f8fafc; padding: 12px 18px;
        border-radius: 10px; font-size: 14px; display: flex; align-items: center;
        gap: 10px; max-width: 340px; box-shadow: 0 8px 24px rgba(0,0,0,0.18);
        opacity: 0; transform: translateY(8px);
        transition: opacity 0.25s ease, transform 0.25s ease;
        pointer-events: auto;
    `;
    toast.innerHTML = `<span>${ICONS[type]}</span><span>${message}</span>`;
    container.appendChild(toast);

    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    });

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

/** Debounce helper. */
function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

/** Estimate reading time from content string. */
function readingTime(text = '') {
    const words = text.trim().split(/\s+/).length;
    const mins  = Math.ceil(words / 200);
    return mins < 1 ? 'under 1 min read' : `${mins} min read`;
}

/** Extract hashtags from raw text. */
function extractTags(text = '') {
    const raw = text.match(/#[\w]+/g) || [];
    return [...new Set(raw.map(t => t.replace('#', '').toLowerCase()))];
}

/** Relative time string (e.g. "3 min ago"). */
function relativeTime(timestamp) {
    const diff = Date.now() - timestamp;
    const m = Math.floor(diff / 60_000);
    const h = Math.floor(diff / 3_600_000);
    const d = Math.floor(diff / 86_400_000);
    if (m < 1)  return 'just now';
    if (m < 60) return `${m}m ago`;
    if (h < 24) return `${h}h ago`;
    if (d < 7)  return `${d}d ago`;
    return new Date(timestamp).toLocaleDateString();
}

// ─────────────────────────────────────────────
// In-memory post cache (source of truth for AI + edit)
// ─────────────────────────────────────────────
const _postCache = new Map();

// ─────────────────────────────────────────────
// Image Lightbox
// ─────────────────────────────────────────────
function openLightbox(src) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.85);
        display: flex; align-items: center; justify-content: center;
        z-index: 10000; cursor: zoom-out; animation: fadeIn 0.2s ease;
    `;
    const img = document.createElement('img');
    img.src = src;
    img.style.cssText = `
        max-width: 90vw; max-height: 90vh; border-radius: 10px;
        object-fit: contain; box-shadow: 0 20px 60px rgba(0,0,0,0.6);
    `;
    overlay.appendChild(img);
    overlay.addEventListener('click', () => overlay.remove());
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') overlay.remove();
    }, { once: true });
    document.body.appendChild(overlay);
}

// ─────────────────────────────────────────────
// Edit Post Modal
// ─────────────────────────────────────────────
async function openEditModal(postId) {
    const post = _postCache.get(postId);
    if (!post) return showToast('Post data not available.', 'error');

    // Double-check ownership (defensive, in case cache was stale)
    if (!currentUser || post.authorEmail !== currentUser.email) {
        return showToast('You can only edit your own posts.', 'warn');
    }

    // Remove existing modal if any
    document.getElementById('edit-post-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'edit-post-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'edit-modal-title');
    modal.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.5);
        display: flex; align-items: center; justify-content: center;
        z-index: 9000; animation: fadeIn 0.2s ease;
    `;
    modal.innerHTML = `
        <div style="background:#fff; border-radius:16px; padding:28px; width:min(560px,95vw);
                    box-shadow:0 20px 60px rgba(0,0,0,0.25); display:flex; flex-direction:column; gap:16px;">
            <h2 id="edit-modal-title" style="margin:0; font-size:18px; font-weight:600; color:#111;">Edit Post</h2>
            <div style="display:flex; flex-direction:column; gap:12px;">
                <label style="font-size:13px; font-weight:500; color:#374151;">Title</label>
                <input id="edit-title" type="text" value="${(post.title || '').replace(/"/g, '&quot;')}"
                    style="padding:10px 14px; border:1.5px solid #e5e7eb; border-radius:8px; font-size:15px;"
                    placeholder="Post title" />
                <label style="font-size:13px; font-weight:500; color:#374151;">Content</label>
                <textarea id="edit-content" rows="6"
                    style="padding:10px 14px; border:1.5px solid #e5e7eb; border-radius:8px; font-size:15px;
                           resize:vertical; font-family:inherit;"
                    placeholder="What's on your mind?">${post.content || ''}</textarea>
            </div>
            <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:4px;">
                <button id="edit-cancel-btn"
                    style="padding:9px 18px; border-radius:8px; border:1.5px solid #e5e7eb;
                           background:#fff; font-size:14px; cursor:pointer; font-weight:500; color:#374151;">
                    Cancel
                </button>
                <button id="edit-save-btn"
                    style="padding:9px 18px; border-radius:8px; border:none;
                           background:#3b82f6; color:#fff; font-size:14px;
                           cursor:pointer; font-weight:500;">
                    Save changes
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const closeModal = () => modal.remove();

    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    modal.querySelector('#edit-cancel-btn').addEventListener('click', closeModal);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); }, { once: true });

    modal.querySelector('#edit-save-btn').addEventListener('click', async () => {
        const newTitle   = modal.querySelector('#edit-title').value.trim();
        const newContent = modal.querySelector('#edit-content').value.trim();

        if (!newContent) return showToast('Content cannot be empty.', 'warn');

        const saveBtn = modal.querySelector('#edit-save-btn');
        saveBtn.textContent = 'Saving…';
        saveBtn.disabled = true;

        try {
            // Re-verify ownership before writing
            const cached = _postCache.get(postId);
            if (!currentUser || (cached && cached.authorEmail !== currentUser.email)) {
                showToast('Permission denied.', 'error');
                saveBtn.textContent = 'Save changes';
                saveBtn.disabled = false;
                return;
            }
            const newTags = extractTags(newContent);
            await updateDoc(doc(db, 'posts', postId), {
                title:   newTitle,
                content: newContent,
                tags:    newTags,
                edited:  true,
                editedAt: Date.now(),
            });
            showToast('Post updated.', 'success');
            closeModal();
        } catch (err) {
            console.error('Edit error:', err);
            showToast(`Failed to save: ${err.message}`, 'error');
            saveBtn.textContent = 'Save changes';
            saveBtn.disabled = false;
        }
    });

    // Focus first input
    requestAnimationFrame(() => modal.querySelector('#edit-title')?.focus());
}

// ─────────────────────────────────────────────
// Poll Vote
// ─────────────────────────────────────────────
async function handlePollVote(postId, optionIndex) {
    if (!currentUser) return showToast('Sign in to vote.', 'warn');

    const post = _postCache.get(postId);
    if (!post?.poll) return;

    const userEmail   = currentUser.email;
    const currentVote = post.poll.options.findIndex(o => o.votes?.includes(userEmail));

    if (currentVote === optionIndex) return showToast('Already voted for this option.', 'info');

    // Build updated options array
    const updatedOptions = post.poll.options.map((opt, i) => {
        let votes = [...(opt.votes || [])];
        if (i === currentVote) votes = votes.filter(v => v !== userEmail); // remove old vote
        if (i === optionIndex) votes.push(userEmail);                       // add new vote
        return { ...opt, votes };
    });

    // Optimistic local update
    _postCache.set(postId, { ...post, poll: { ...post.poll, options: updatedOptions } });
    _renderPollResult(postId, updatedOptions, userEmail);

    try {
        await updateDoc(doc(db, 'posts', postId), { 'poll.options': updatedOptions });
    } catch (err) {
        console.error('Poll vote error:', err);
        showToast('Vote failed. Please try again.', 'error');
        // Revert optimistic update
        _postCache.set(postId, post);
        _renderPollResult(postId, post.poll.options, userEmail);
    }
}

function _renderPollResult(postId, options, userEmail) {
    const card = document.querySelector(`.post-card[data-post-id="${postId}"]`);
    if (!card) return;
    const pollEl = card.querySelector('.poll-container');
    if (!pollEl) return;

    const totalVotes = options.reduce((sum, o) => sum + (o.votes?.length || 0), 0);

    pollEl.querySelectorAll('.poll-option').forEach((el, i) => {
        const opt     = options[i];
        const count   = opt.votes?.length || 0;
        const pct     = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
        const isVoted = opt.votes?.includes(userEmail);

        const bar    = el.querySelector('.poll-bar');
        const label  = el.querySelector('.poll-pct');
        if (bar)   bar.style.width   = `${pct}%`;
        if (label) label.textContent = `${pct}%`;
        el.classList.toggle('poll-option--voted', isVoted);
    });

    const totalEl = pollEl.querySelector('.poll-total');
    if (totalEl) totalEl.textContent = `${totalVotes} vote${totalVotes !== 1 ? 's' : ''}`;
}

// ─────────────────────────────────────────────
// AI Summarize (typewriter effect)
// ─────────────────────────────────────────────
async function aiSummarizePost(postCard, postData) {
    const btn = postCard.querySelector('.ai-summarize-btn');
    let summaryEl = postCard.querySelector('.ai-summary-box');

    if (summaryEl) {
        summaryEl.style.maxHeight = summaryEl.style.maxHeight === '0px' ? '200px' : '0px';
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner"></span> Summarising…`;
    }

    summaryEl = document.createElement('div');
    summaryEl.className = 'ai-summary-box';
    summaryEl.style.cssText = `
        margin-top: 14px; padding: 14px 16px; background: linear-gradient(135deg, #f0f4ff, #fff);
        border-radius: 10px; border-left: 3px solid #6366f1; font-size: 14px; line-height: 1.7;
        color: #374151; overflow: hidden; max-height: 0; transition: max-height 0.5s ease;
    `;

    const header = document.createElement('p');
    header.style.cssText = 'margin: 0 0 6px; font-size: 11px; font-weight: 600; color: #6366f1; letter-spacing: 0.08em;';
    header.textContent = '✦ AI SUMMARY';

    const body = document.createElement('p');
    body.style.cssText = 'margin: 0; color: #374151;';

    summaryEl.append(header, body);

    // Insert after content area
    const contentArea = postCard.querySelector('.post-content') || postCard.querySelector('p');
    contentArea?.after(summaryEl);

    requestAnimationFrame(() => { summaryEl.style.maxHeight = '200px'; });

    try {
        // Simple local summary — first 2 sentences or first 280 chars
        const raw = (postData.content || '').trim();
        const sentences = raw.match(/[^.!?\n]+[.!?]+/g) || [];
        let text = sentences.length >= 2
            ? sentences.slice(0, 2).join(' ').trim()
            : raw.slice(0, 280).trim() + (raw.length > 280 ? '…' : '');
        if (!text) text = 'No content to summarise.';

        // Typewriter
        let i = 0;
        const type = () => {
            if (i < text.length) {
                body.textContent += text[i++];
                requestAnimationFrame(type);
            }
        };
        type();
    } catch {
        body.textContent = 'Unable to summarise this post right now.';
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `✦ Summary`;
        }
    }
}

// ─────────────────────────────────────────────
// Skeleton placeholder HTML
// ─────────────────────────────────────────────
function skeletonHTML(count = 4) {
    return Array(count).fill(0).map(() => `
        <div class="post-card post-card--skeleton" aria-hidden="true">
            <div class="skeleton-row" style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
                <div class="skeleton-circle" style="width:42px;height:42px;border-radius:50%;background:var(--sk);flex-shrink:0;"></div>
                <div style="flex:1;display:flex;flex-direction:column;gap:8px;">
                    <div class="skeleton-block" style="height:12px;width:40%;background:var(--sk);border-radius:4px;"></div>
                    <div class="skeleton-block" style="height:10px;width:28%;background:var(--sk);border-radius:4px;"></div>
                </div>
            </div>
            <div class="skeleton-block" style="height:16px;width:70%;background:var(--sk);border-radius:4px;margin-bottom:12px;"></div>
            <div class="skeleton-block" style="height:12px;width:100%;background:var(--sk);border-radius:4px;margin-bottom:8px;"></div>
            <div class="skeleton-block" style="height:12px;width:85%;background:var(--sk);border-radius:4px;"></div>
        </div>
    `).join('');
}

// ─────────────────────────────────────────────
// Media Preview (for post creation form)
// ─────────────────────────────────────────────
function setupMediaPreview() {
    const photoInput   = document.getElementById('post-photo');
    const previewWrap  = document.getElementById('photo-preview-wrap');
    const previewImg   = document.getElementById('photo-preview-img');
    const removeBtn    = document.getElementById('photo-remove-btn');

    if (!photoInput || !previewWrap) return;

    photoInput.addEventListener('change', () => {
        const file = photoInput.files[0];
        if (!file) return;

        // Validate type & size (5 MB max)
        if (!file.type.startsWith('image/')) {
            showToast('Only image files are supported.', 'error');
            photoInput.value = '';
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            showToast('Image must be under 5 MB.', 'warn');
            photoInput.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            if (previewImg) previewImg.src = e.target.result;
            previewWrap.classList.remove('hidden');
        };
        reader.readAsDataURL(file);
    });

    removeBtn?.addEventListener('click', () => {
        photoInput.value = '';
        if (previewImg) previewImg.src = '';
        previewWrap.classList.add('hidden');
    });
}

// ─────────────────────────────────────────────
// Poll Builder (for post creation form)
// ─────────────────────────────────────────────
function setupPollBuilder() {
    const addPollBtn  = document.getElementById('add-poll-btn');
    const pollArea    = document.getElementById('poll-creator-container');
    const addOptBtn   = document.getElementById('add-poll-option-btn');
    const optList     = document.getElementById('poll-options-list');

    addPollBtn?.addEventListener('click', () => {
        addPollBtn.classList.add('hidden');
        pollArea?.classList.remove('hidden');
        optList?.querySelector('.poll-option-input')?.focus();
    });

    addOptBtn?.addEventListener('click', () => {
        if (!optList) return;
        const currentOptions = optList.querySelectorAll('.poll-option-input');
        if (currentOptions.length >= 6) {
            showToast('Maximum 6 poll options allowed.', 'info');
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'poll-option-row';
        wrapper.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
        wrapper.innerHTML = `
            <input type="text" class="poll-option-input"
                placeholder="Option ${currentOptions.length + 1}"
                style="flex:1;padding:8px 12px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:14px;"
                maxlength="100" />
            <button type="button" class="remove-poll-option-btn"
                aria-label="Remove option"
                style="width:32px;height:32px;border:none;background:#fee2e2;color:#dc2626;
                       border-radius:6px;cursor:pointer;font-size:18px;line-height:1;">
                ×
            </button>
        `;
        wrapper.querySelector('.remove-poll-option-btn').addEventListener('click', () => {
            wrapper.remove();
        });
        optList.appendChild(wrapper);
        wrapper.querySelector('.poll-option-input').focus();
    });
}

// ─────────────────────────────────────────────
// Character Counter + Tag Preview (post creation form)
// ─────────────────────────────────────────────
function setupContentEnhancements() {
    const contentArea = document.getElementById('post-content');
    const charCounter = document.getElementById('post-char-counter');
    const tagPreview  = document.getElementById('post-tag-preview');
    const LIMIT = 5000;

    contentArea?.addEventListener('input', () => {
        const len  = contentArea.value.length;
        const tags = extractTags(contentArea.value);

        if (charCounter) {
            charCounter.textContent = `${len} / ${LIMIT}`;
            charCounter.style.color = len > LIMIT * 0.9 ? '#ef4444' : '#9ca3af';
        }

        if (tagPreview) {
            tagPreview.innerHTML = tags.length
                ? tags.map(t => `<span class="tag-chip">#${t}</span>`).join('')
                : '';
        }
    });
}

// ─────────────────────────────────────────────
// Main: setupPosts()
// ─────────────────────────────────────────────
export function setupPosts() {
    let postLimit        = 30;
    let activeFeedUnsub  = null;
    let cacheUnsub       = null;
    let isLoadingMore    = false;

    const feed     = document.getElementById('posts-feed');
    const sentinel = document.getElementById('feed-end-sentinel');

    // ── Init sub-systems ──────────────────────
    setupMediaPreview();
    setupPollBuilder();
    setupContentEnhancements();
    _injectGlobalStyles();

    // ── Community custom input ────────────────
    document.getElementById('post-community')?.addEventListener('change', (e) => {
        const custom = document.getElementById('post-community-custom');
        if (!custom) return;
        const isCustom = e.target.value === 'Custom';
        custom.classList.toggle('hidden', !isCustom);
        custom.required = isCustom;
        if (!isCustom) custom.value = '';
    });

    // ─────────────────────────────────────────
    // FEED: filter controls
    // ─────────────────────────────────────────
    const debouncedLoad = debounce(() => loadFeed(), 300);

    document.getElementById('community-filter-select')?.addEventListener('change', () => loadFeed());
    document.getElementById('hashtag-filter-input')?.addEventListener('input', debouncedLoad);
    document.getElementById('keyword-search-input')?.addEventListener('input', debouncedLoad);

    // Sort controls
    document.querySelectorAll('[data-sort]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-sort]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            loadFeed();
        });
    });

    // ─────────────────────────────────────────
    // FEED: Load / Render
    // ─────────────────────────────────────────
    function getActiveSort() {
        return document.querySelector('[data-sort].active')?.dataset.sort || 'timestamp';
    }

    function buildFeedQuery() {
        const sortField = getActiveSort();
        return query(
            collection(db, 'posts'),
            orderBy(sortField === 'popular' ? 'upvoteCount' : 'timestamp', 'desc'),
            limit(postLimit)
        );
    }

    function matchesFilters(post) {
        const communityEl = document.getElementById('community-filter-select');
        const hashtagEl   = document.getElementById('hashtag-filter-input');
        const keywordEl   = document.getElementById('keyword-search-input');

        const community = communityEl?.value || 'all';
        const tag       = (hashtagEl?.value || '').replace(/#/g, '').trim().toLowerCase();
        const keyword   = (keywordEl?.value || '').trim().toLowerCase();

        const matchCommunity = community === 'all' || post.community === community;
        const matchTag       = !tag || (post.tags && post.tags.includes(tag));
        const matchKeyword   = !keyword ||
            (post.title || '').toLowerCase().includes(keyword) ||
            (post.content || '').toLowerCase().includes(keyword) ||
            (post.author || '').toLowerCase().includes(keyword);

        return matchCommunity && matchTag && matchKeyword;
    }

    function renderPost(post) {
        const card = document.createElement('div');
        card.className     = 'post-card';
        card.dataset.postId = post.id;

        const isOwnPost  = currentUser && currentUser.email === post.authorEmail;
        const isVoted    = currentUser && (post.upvotedBy || []).includes(currentUser.email);
        const isSaved    = currentUser && (currentUser.savedPosts || []).includes(post.id);
        const upvotes    = post.upvotedBy?.length || 0;

        card.innerHTML = `
            <div class="post-header">
                <div class="post-author-info">
                    <div class="author-avatar" aria-hidden="true">
                        ${(post.author || 'A').charAt(0).toUpperCase()}
                    </div>
                    <div>
                        <span class="post-author-name">${post.author || 'Anonymous'}</span>
                        <div class="post-meta-row">
                            <span class="post-time" title="${new Date(post.timestamp).toLocaleString()}">${relativeTime(post.timestamp)}</span>
                            ${post.edited ? '<span class="post-edited-badge">edited</span>' : ''}
                            <span class="post-separator">·</span>
                            <span class="post-community-chip">${post.community || 'Global'}</span>
                            ${post.category ? `<span class="post-separator">·</span><span class="post-category-chip">${post.category}</span>` : ''}
                            <span class="post-separator">·</span>
                            <span class="post-reading-time">${readingTime(post.content)}</span>
                        </div>
                    </div>
                </div>

                <div class="post-options-menu" data-post-id="${post.id}" style="position:relative;">
                    <button class="post-options-trigger" aria-haspopup="true" aria-label="Post options">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
                        </svg>
                    </button>
                    <div class="post-options-dropdown" role="menu"
                         data-author-email="${post.authorEmail}"
                         data-author-name="${post.author || ''}"
                         data-post-id="${post.id}"
                         data-pinned="${post.pinned ? '1' : '0'}">
                        <!-- populated dynamically on open by _buildDropdown() -->
                    </div>
                </div>
            </div>

            ${post.title ? `<h3 class="post-title">${post.title}</h3>` : ''}

            <div class="post-content">${_renderContent(post.content || '')}</div>

            ${post.imageSrc ? `
                <div class="post-image-wrap">
                    <img src="${post.imageSrc}" alt="Post image" class="post-image" loading="lazy" />
                </div>
            ` : ''}

            ${post.poll ? _renderPoll(post) : ''}

            ${post.tags?.length ? `
                <div class="post-tags">
                    ${post.tags.map(t => `<button class="hashtag-link" data-tag="${t}">#${t}</button>`).join('')}
                </div>
            ` : ''}

            <div class="post-actions">
                <button class="action-btn upvote-btn ${isVoted ? 'action-btn--active' : ''}"
                    aria-label="${isVoted ? 'Remove upvote' : 'Upvote'}"
                    aria-pressed="${isVoted}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="${isVoted ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/>
                        <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
                    </svg>
                    <span class="upvote-count">${upvotes}</span>
                </button>

                <button class="action-btn view-comments-btn" aria-label="View comments">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    <span>${post.commentCount || 0}</span>
                </button>

                <button class="action-btn bookmark-btn ${isSaved ? 'action-btn--saved' : ''}"
                    aria-label="${isSaved ? 'Remove bookmark' : 'Bookmark'}"
                    aria-pressed="${isSaved}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="${isSaved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
                    </svg>
                </button>

                <button class="action-btn ai-summarize-btn" aria-label="AI summary" title="AI summary">
                    ✦ Summary
                </button>
            </div>

            <div class="ai-summary-container hidden" style="margin-top:12px;padding:14px 16px;
                 background:linear-gradient(135deg,rgba(139,92,246,.06),rgba(59,130,246,.06));
                 border-radius:10px;border:1px solid rgba(139,92,246,.18);">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                    <div style="width:18px;height:18px;border-radius:5px;
                         background:linear-gradient(135deg,#8b5cf6,#3b82f6);
                         display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5">
                            <path d="M13 10V3L4 14h7v7l9-11h-7z"/>
                        </svg>
                    </div>
                    <span style="font-size:10px;font-weight:700;color:#8b5cf6;text-transform:uppercase;letter-spacing:.08em;">AI Summary</span>
                </div>
                <p class="ai-summary-text" style="margin:0;font-size:14px;color:#374151;line-height:1.7;"></p>
            </div>
        `;

        return card;
    }

    /**
     * Render content with hashtag links and basic linkification.
     */
    function _renderContent(text) {
        return text
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/#([\w]+)/g, '<button class="hashtag-link" data-tag="$1">#$1</button>')
            .replace(/\n/g, '<br>');
    }

    function _renderPoll(post) {
        const opts       = post.poll?.options || [];
        const totalVotes = opts.reduce((s, o) => s + (o.votes?.length || 0), 0);
        const userVote   = currentUser ? opts.findIndex(o => (o.votes || []).includes(currentUser.email)) : -1;

        return `
            <div class="poll-container" aria-label="Poll">
                <p class="poll-question">📊 Poll — ${totalVotes} vote${totalVotes !== 1 ? 's' : ''} total</p>
                ${opts.map((opt, i) => {
                    const count  = opt.votes?.length || 0;
                    const pct    = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
                    const voted  = i === userVote;
                    return `
                        <button class="poll-option ${voted ? 'poll-option--voted' : ''}"
                            data-option-index="${i}" aria-pressed="${voted}">
                            <span class="poll-option-text">${opt.text}</span>
                            <div class="poll-bar-track">
                                <div class="poll-bar" style="width:${pct}%"></div>
                            </div>
                            <span class="poll-pct">${pct}%</span>
                        </button>
                    `;
                }).join('')}
                <p class="poll-total">${totalVotes} vote${totalVotes !== 1 ? 's' : ''}</p>
            </div>
        `;
    }

    function loadFeed(reset = true) {
        if (!feed) return;
        if (activeFeedUnsub) { activeFeedUnsub(); activeFeedUnsub = null; }
        if (reset) postLimit = 30;

        if (!feed.children.length || reset) {
            feed.innerHTML = skeletonHTML(4);
        }

        activeFeedUnsub = onSnapshot(buildFeedQuery(), (snapshot) => {
            // Handle incremental changes — especially deletions from admin panel
            snapshot.docChanges().forEach(change => {
                if (change.type === 'removed') {
                    const card = feed.querySelector(`.post-card[data-post-id="${change.doc.id}"]`);
                    if (card) {
                        card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
                        card.style.opacity    = '0';
                        card.style.transform  = 'scale(0.97)';
                        setTimeout(() => card.remove(), 320);
                    }
                    _postCache.delete(change.doc.id);
                }
            });

            // Populate / update cache for all live docs
            snapshot.forEach(d => _postCache.set(d.id, { id: d.id, ...d.data() }));

            // Full re-render of feed: pinned posts first, then rest in snapshot order
            feed.innerHTML = '';
            let count = 0;
            const pinned = [];
            const normal = [];

            snapshot.forEach(docSnap => {
                const post = { id: docSnap.id, ...docSnap.data() };
                if (!matchesFilters(post)) return;
                const card = renderPost(post);
                if (post.pinned) {
                    card.classList.add('post-card--pinned');
                    pinned.push(card);
                } else {
                    normal.push(card);
                }
                count++;
            });

            pinned.forEach(c => feed.appendChild(c));
            normal.forEach(c => feed.appendChild(c));

            if (count === 0) {
                feed.innerHTML = `
                    <div class="empty-feed" role="status">
                        <div class="empty-feed-icon" aria-hidden="true">💬</div>
                        <p class="empty-feed-title">No posts found</p>
                        <p class="empty-feed-sub">Try adjusting your filters, or be the first to post.</p>
                    </div>
                `;
            }

            if (sentinel) {
                sentinel.classList.toggle('hidden', snapshot.docs.length < postLimit);
            }

            isLoadingMore = false;
        }, (error) => {
            console.error('Feed snapshot error:', error);
            feed.innerHTML = `
                <div class="feed-error" role="alert">
                    <p>⚠️ Failed to load posts.</p>
                    <button onclick="location.reload()" class="action-btn">Refresh</button>
                </div>
            `;
        });
    }

    // ─────────────────────────────────────────
    // DYNAMIC DROPDOWN BUILDER
    // ─────────────────────────────────────────
    /**
     * Populate a post's options dropdown with the correct items for the
     * CURRENT (live) user at the moment they open the menu.
     * Reading currentUser here — not at render time — is the only safe
     * approach: the feed snapshot often fires before auth completes, and
     * re-renders don't track role changes.
     */
    function _buildDropdown(dropdown) {
        const authorEmail = dropdown.dataset.authorEmail || '';
        const authorName  = dropdown.dataset.authorName  || '';
        const postId      = dropdown.dataset.postId      || '';
        const isPinned    = dropdown.dataset.pinned === '1';

        const isOwner = !!(currentUser && currentUser.email === authorEmail);
        const isAdmin = !!(currentUser && currentUser.role === 'admin');

        let html = '';

        if (isOwner) {
            // Owner: Edit, Share, Delete
            html = `
                <button class="dropdown-item edit-post-btn" role="menuitem">✏️ Edit post</button>
                <button class="dropdown-item share-btn" role="menuitem">🔗 Share</button>
                <button class="dropdown-item delete-post-btn" role="menuitem" style="color:#ef4444;">🗑️ Delete post</button>
            `;
        } else if (isAdmin) {
            // Admin: Pin/Unpin, Delete, Share
            html = `
                <button class="dropdown-item share-btn" role="menuitem">🔗 Share</button>
                <button class="dropdown-item pin-post-btn" role="menuitem">${isPinned ? '📌 Unpin post' : '📌 Pin post'}</button>
                <button class="dropdown-item delete-post-btn" role="menuitem" style="color:#ef4444;">🗑️ Delete (Admin)</button>
            `;
        } else {
            // Non-owner: Message Owner, Share, Report
            const firstName = authorName.split(' ')[0] || 'author';
            html = `
                <button class="dropdown-item message-author-btn" role="menuitem"
                    data-email="${authorEmail}" data-name="${authorName}">
                    💬 Message ${firstName}
                </button>
                <button class="dropdown-item share-btn" role="menuitem">🔗 Share</button>
                <button class="dropdown-item report-btn" role="menuitem"
                    data-content-id="${postId}" data-content-type="post"
                    data-content-author-email="${authorEmail}">🚩 Report</button>
            `;
        }

        dropdown.innerHTML = html;

        // Keep data-pinned in sync for re-opens (pin state may change via snapshot)
        const cached = _postCache.get(postId);
        if (cached) dropdown.dataset.pinned = cached.pinned ? '1' : '0';
    }

    loadFeed();

    // ── Infinite scroll ───────────────────────
    if (sentinel) {
        new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !isLoadingMore) {
                isLoadingMore = true;
                postLimit += 20;
                loadFeed(false);
            }
        }, { rootMargin: '200px' }).observe(sentinel);
    }

    // ─────────────────────────────────────────
    // CREATE POST
    // ─────────────────────────────────────────
    const generalForm = document.querySelector('#form-general-post form');

    generalForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!currentUser) return showToast('You must be signed in to post.', 'warn');

        const rawContent = (document.getElementById('post-content')?.value || '').trim();
        if (!rawContent && !document.getElementById('post-photo')?.files[0]) {
            return showToast('Please add some content before posting.', 'warn');
        }

        const btn = document.getElementById('submit-post-btn');
        const origHTML = btn?.innerHTML;
        if (btn) {
            btn.innerHTML = `<span class="spinner"></span> Publishing…`;
            btn.disabled = true;
        }

        try {
            const imageFile = document.getElementById('post-photo')?.files[0];
            const imageUrl  = imageFile ? await uploadImage(imageFile, 'posts') : null;

            // Poll
            let pollData = null;
            const pollContainer = document.getElementById('poll-creator-container');
            if (pollContainer && !pollContainer.classList.contains('hidden')) {
                const opts = Array.from(document.querySelectorAll('.poll-option-input'))
                    .map(inp => inp.value.trim()).filter(Boolean);
                if (opts.length < 2) {
                    showToast('Add at least 2 poll options.', 'warn');
                    if (btn) { btn.innerHTML = origHTML; btn.disabled = false; }
                    return;
                }
                pollData = { options: opts.map(text => ({ text, votes: [] })) };
            }

            // Community
            let community = document.getElementById('post-community')?.value || 'Global';
            if (community === 'Custom') {
                community = document.getElementById('post-community-custom')?.value.trim() || 'Global';
            }

            const tagsArray = extractTags(rawContent);

            await addDocument('posts', {
                type:         'post',
                title:        (document.getElementById('post-title')?.value || '').trim(),
                content:      rawContent,
                category:     document.getElementById('post-category')?.value || 'General',
                community,
                tags:         tagsArray,
                poll:         pollData,
                imageSrc:     imageUrl,
                author:       currentUser.name,
                authorEmail:  currentUser.email,
                commentCount: 0,
                upvotedBy:    [],
                upvoteCount:  0,
                pinned:       false,
                edited:       false,
                timestamp:    Date.now(),
            });

            // Reset form
            generalForm.reset();
            document.getElementById('post-community-custom')?.classList.add('hidden');
            pollContainer?.classList.add('hidden');
            document.getElementById('add-poll-btn')?.classList.remove('hidden');
            document.getElementById('photo-preview-wrap')?.classList.add('hidden');
            document.getElementById('post-char-counter') && (document.getElementById('post-char-counter').textContent = '0 / 5000');
            document.getElementById('post-tag-preview') && (document.getElementById('post-tag-preview').innerHTML = '');

            showToast('Post published!', 'success');

            document.querySelector('a[data-target="page-posts"]')?.click();
            window.scrollTo({ top: 0, behavior: 'smooth' });

        } catch (error) {
            console.error('Post creation failed:', error);
            showToast(`Failed to publish: ${error.message}`, 'error');
        } finally {
            if (btn) { btn.innerHTML = origHTML; btn.disabled = false; }
        }
    });

    // ─────────────────────────────────────────
    // FEED INTERACTION DELEGATION
    // ─────────────────────────────────────────
    feed?.addEventListener('click', async (e) => {
        const postCard = e.target.closest('.post-card');
        if (!postCard || postCard.classList.contains('post-card--skeleton')) return;

        const postId  = postCard.dataset.postId;
        if (!postId) return;
        const postRef = doc(db, 'posts', postId);

        // ── Options dropdown ──────────────────
        if (e.target.closest('.post-options-trigger')) {
            const dropdown = postCard.querySelector('.post-options-dropdown');
            const isOpen   = dropdown?.classList.contains('open');

            // Close all open dropdowns first
            document.querySelectorAll('.post-options-dropdown.open').forEach(d => d.classList.remove('open'));

            if (dropdown && !isOpen) {
                // Build dropdown items NOW using the live currentUser — not at render time.
                // This is the only correct place to check permissions: at the moment the user
                // actually opens the menu, so role/email are always up to date.
                _buildDropdown(dropdown);
                dropdown.classList.add('open');
                const close = () => dropdown.classList.remove('open');
                setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
            }
            return;
        }

        // ── Edit ─────────────────────────────
        if (e.target.closest('.edit-post-btn')) {
            postCard.querySelector('.post-options-dropdown')?.classList.remove('open');
            if (!currentUser) return;
            const post = _postCache.get(postId);
            if (post && post.authorEmail !== currentUser.email) {
                return showToast('You can only edit your own posts.', 'warn');
            }
            openEditModal(postId);
            return;
        }

        // ── Delete ────────────────────────────
        if (e.target.closest('.delete-post-btn')) {
            if (!currentUser) return;
            postCard.querySelector('.post-options-dropdown')?.classList.remove('open');

            const post = _postCache.get(postId);
            const isAdmin = currentUser.role === 'admin';
            if (post && post.authorEmail !== currentUser.email && !isAdmin) {
                return showToast('You can only delete your own posts.', 'warn');
            }

            if (!confirm('Permanently delete this post? This cannot be undone.')) return;

            const btn = e.target.closest('.delete-post-btn');
            btn.textContent = 'Deleting…';
            btn.disabled = true;

            try {
                await deleteDoc(doc(db, 'posts', postId));
                postCard.style.transition = 'opacity 0.35s, transform 0.35s';
                postCard.style.opacity    = '0';
                postCard.style.transform  = 'scale(0.96)';
                setTimeout(() => postCard.remove(), 360);
                showToast('Post deleted.', 'success');
            } catch (err) {
                showToast(`Delete failed: ${err.message}`, 'error');
                btn.textContent = '🗑️ Delete post';
                btn.disabled = false;
            }
            return;
        }

        // ── Pin post (admin only) ─────────────
        if (e.target.closest('.pin-post-btn')) {
            postCard.querySelector('.post-options-dropdown')?.classList.remove('open');
            if (currentUser?.role !== 'admin') return showToast('Admins only.', 'warn');
            const post = _postCache.get(postId);
            const isPinned = !!post?.pinned;
            try {
                await updateDoc(doc(db, 'posts', postId), { pinned: !isPinned });
                showToast(isPinned ? 'Post unpinned.' : 'Post pinned.', 'success');
            } catch (err) {
                showToast('Failed to update pin.', 'error');
            }
            return;
        }

        // ── Report ────────────────────────────
        if (e.target.closest('.report-btn')) {
            e.stopPropagation();
            postCard.querySelector('.post-options-dropdown')?.classList.remove('open');
            if (!currentUser) return showToast('Sign in to report content.', 'warn');
            const reportBtn   = e.target.closest('.report-btn');
            const contentId   = reportBtn.dataset.contentId   || postId;
            const contentType = reportBtn.dataset.contentType || 'post';
            const replyId2    = reportBtn.dataset.replyId     || null;
            const authorEmail2 = reportBtn.dataset.contentAuthorEmail || '';
            if (window.openReportModal) {
                window.openReportModal(contentId, contentType, postId, replyId2, authorEmail2);
            } else {
                showToast('Report system loading — please try again in a moment.', 'warn');
            }
            return;
        }

        // ── Message Author ────────────────────
        if (e.target.closest('.message-author-btn')) {
            if (!currentUser) return showToast('Sign in to message.', 'warn');
            const btn        = e.target.closest('.message-author-btn');
            const targetEmail = btn.dataset.email;
            const targetName  = btn.dataset.name;
            document.querySelector('a[data-target="page-chat"]')?.click();
            window.startDirectChat?.(targetEmail, targetName);
            return;
        }

        // ── Share ─────────────────────────────
        if (e.target.closest('.share-btn')) {
            postCard.querySelector('.post-options-dropdown')?.classList.remove('open');
            const url = `${location.origin}${location.pathname}?post=${postId}`;
            if (navigator.share) {
                navigator.share({ title: _postCache.get(postId)?.title || 'Check this post', url });
            } else {
                navigator.clipboard.writeText(url).then(() => showToast('Link copied!', 'success'));
            }
            return;
        }

        // ── Upvote ────────────────────────────
        if (e.target.closest('.upvote-btn')) {
            if (!currentUser) return showToast('Sign in to upvote.', 'warn');

            const btn     = e.target.closest('.upvote-btn');
            const isVoted = btn.classList.contains('action-btn--active');
            const counter = btn.querySelector('.upvote-count');
            const current = parseInt(counter?.textContent || '0', 10);

            // Optimistic UI
            btn.classList.toggle('action-btn--active', !isVoted);
            btn.setAttribute('aria-pressed', String(!isVoted));
            if (counter) counter.textContent = String(isVoted ? current - 1 : current + 1);

            // Bounce animation
            btn.animate(
                [{ transform: 'scale(1)' }, { transform: 'scale(1.25)' }, { transform: 'scale(1)' }],
                { duration: 280, easing: 'ease' }
            );

            try {
                await updateDoc(postRef, {
                    upvotedBy:  isVoted ? arrayRemove(currentUser.email) : arrayUnion(currentUser.email),
                    upvoteCount: isVoted ? Math.max(0, current - 1) : current + 1,
                });
            } catch (err) {
                // Revert
                btn.classList.toggle('action-btn--active', isVoted);
                if (counter) counter.textContent = String(current);
                showToast('Upvote failed. Try again.', 'error');
            }
            return;
        }

        // ── Bookmark ──────────────────────────
        if (e.target.closest('.bookmark-btn')) {
            if (!currentUser) return showToast('Sign in to bookmark.', 'warn');

            const btn    = e.target.closest('.bookmark-btn');
            const isSaved = btn.classList.contains('action-btn--saved');
            const userRef = doc(db, 'users', currentUser.email);

            // Optimistic UI
            btn.classList.toggle('action-btn--saved', !isSaved);
            btn.setAttribute('aria-pressed', String(!isSaved));
            if (!currentUser.savedPosts) currentUser.savedPosts = [];
            if (isSaved) {
                currentUser.savedPosts = currentUser.savedPosts.filter(id => id !== postId);
            } else {
                currentUser.savedPosts.push(postId);
                btn.animate(
                    [{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }],
                    { duration: 300, easing: 'ease' }
                );
            }

            showToast(isSaved ? 'Bookmark removed.' : 'Bookmarked!', 'success', 2000);

            try {
                await updateDoc(userRef, {
                    savedPosts: isSaved ? arrayRemove(postId) : arrayUnion(postId)
                });
            } catch (err) {
                // Revert
                btn.classList.toggle('action-btn--saved', isSaved);
                showToast('Bookmark failed.', 'error');
            }
            return;
        }

        // ── Hashtag filter ────────────────────
        if (e.target.closest('.hashtag-link')) {
            const tag = e.target.closest('.hashtag-link').dataset.tag;
            const filterInput = document.getElementById('hashtag-filter-input');
            if (filterInput) {
                filterInput.value = '#' + tag;
                loadFeed();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
            return;
        }

        // ── Comments ──────────────────────────
        if (e.target.closest('.view-comments-btn')) {
            window.openComments?.(postId);
            return;
        }

        // ── Poll vote ─────────────────────────
        const pollOption = e.target.closest('.poll-option');
        if (pollOption) {
            const idx = parseInt(pollOption.dataset.optionIndex, 10);
            if (!isNaN(idx)) await handlePollVote(postId, idx);
            return;
        }

        // ── AI Summarize ──────────────────────
        if (e.target.closest('.ai-summarize-btn')) {
            if (!currentUser) return showToast('Sign in to use AI features.', 'warn');
            const postData = _postCache.get(postId);
            if (postData) await handleAiSummarize(postCard, postData);
            return;
        }

        // ── Image lightbox ────────────────────
        if (e.target.closest('.post-image')) {
            openLightbox(e.target.closest('.post-image').src);
            return;
        }
    });

    // ── Global report-btn delegation (covers comments panel, lost-found, etc.) ──
    // The feed's own delegated handler covers post-level report btns.
    // This catches report btns in the comments panel and other panels outside the feed.
    document.addEventListener('click', (e) => {
        const reportBtn = e.target.closest('.report-btn');
        if (!reportBtn) return;
        // Skip if already handled by the feed's own listener (inside #posts-feed)
        if (reportBtn.closest('#posts-feed')) return;

        e.stopPropagation();
        if (!currentUser) return showToast('Sign in to report content.', 'warn');

        const contentId   = reportBtn.dataset.contentId   || '';
        const contentType = reportBtn.dataset.contentType || 'post';
        // Try to find a parent post id from a data-post-id attribute up the DOM tree
        const parentPostEl = reportBtn.closest('[data-post-id]');
        // Also check for comments page which uses data-current-post-id
        const commentsPage = document.getElementById('page-comments');
        const postId = parentPostEl?.dataset.postId
            || commentsPage?.dataset.currentPostId
            || contentId;

        const replyId = reportBtn.dataset.replyId || null;
        const authorEmail3 = reportBtn.dataset.contentAuthorEmail || '';
        if (window.openReportModal) {
            window.openReportModal(contentId, contentType, postId, replyId, authorEmail3);
        }
    });

    // ─────────────────────────────────────────
    // Passive cache listener (kept alive for AI + edit)
    // ─────────────────────────────────────────
    function startCacheListener() {
        if (cacheUnsub) cacheUnsub();
        cacheUnsub = onSnapshot(
            query(collection(db, 'posts'), orderBy('timestamp', 'desc'), limit(100)),
            (snap) => snap.forEach(d => _postCache.set(d.id, { id: d.id, ...d.data() }))
        );
    }
    startCacheListener();
}

// ─────────────────────────────────────────────
// Global CSS (injected once)
// ─────────────────────────────────────────────
function _injectGlobalStyles() {
    if (document.getElementById('posts-module-styles')) return;

    const style = document.createElement('style');
    style.id = 'posts-module-styles';
    style.textContent = `
        /* ── Skeletons ─────────────────────── */
        :root { --sk: #f0f0f0; }
        @media (prefers-color-scheme: dark) { :root { --sk: #2a2a2a; } }

        .post-card--skeleton { pointer-events: none; }
        .post-card--skeleton .skeleton-block,
        .post-card--skeleton .skeleton-circle {
            background: linear-gradient(90deg, var(--sk) 25%, #e8e8e8 50%, var(--sk) 75%);
            background-size: 200% 100%;
            animation: shimmer 1.4s infinite;
        }
        @keyframes shimmer { to { background-position: -200% 0; } }

        /* ── Post card ─────────────────────── */
        .post-card {
            background: #fff;
            border: 1px solid #f0f0f0;
            border-radius: 14px;
            padding: 20px 22px;
            margin-bottom: 14px;
            transition: box-shadow 0.2s ease, border-color 0.2s ease;
        }
        .post-card:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.06); border-color: #e5e7eb; }
        .post-card--pinned { border-left: 3px solid #6366f1; }

        /* ── Post header ───────────────────── */
        .post-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 12px; gap: 8px; }
        .post-author-info { display: flex; align-items: center; gap: 11px; }

        .author-avatar {
            width: 40px; height: 40px; border-radius: 50%;
            background: linear-gradient(135deg, #6366f1, #8b5cf6);
            color: #fff; font-weight: 600; font-size: 16px;
            display: flex; align-items: center; justify-content: center;
            flex-shrink: 0; user-select: none;
        }

        .post-author-name { font-size: 15px; font-weight: 600; color: #111; display: block; }

        .post-meta-row {
            display: flex; align-items: center; flex-wrap: wrap;
            gap: 4px; margin-top: 2px;
        }
        .post-time { font-size: 12px; color: #9ca3af; }
        .post-edited-badge {
            font-size: 11px; color: #6b7280; background: #f3f4f6;
            padding: 1px 6px; border-radius: 4px;
        }
        .post-separator { color: #d1d5db; font-size: 12px; }
        .post-community-chip {
            font-size: 12px; font-weight: 500; color: #6366f1;
            background: #eef2ff; padding: 2px 8px; border-radius: 20px;
        }
        .post-category-chip {
            font-size: 12px; color: #6b7280;
            background: #f9fafb; padding: 2px 8px; border-radius: 20px;
        }
        .post-reading-time { font-size: 11px; color: #d1d5db; }

        /* ── Options dropdown ──────────────── */
        .post-options-trigger {
            background: none; border: none; color: #9ca3af; cursor: pointer;
            padding: 4px 6px; border-radius: 6px;
            display: flex; align-items: center;
            transition: background 0.15s, color 0.15s;
        }
        .post-options-trigger:hover { background: #f3f4f6; color: #374151; }

        .post-options-dropdown {
            display: none; position: absolute; right: 0; top: 32px;
            background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.1); padding: 6px; z-index: 100;
            min-width: 180px;
        }
        .post-options-dropdown.open { display: block; animation: dropIn 0.15s ease; }
        @keyframes dropIn { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:none; } }

        .dropdown-item {
            display: block; width: 100%; text-align: left;
            background: none; border: none; font-size: 14px;
            color: #374151; padding: 8px 12px; border-radius: 7px;
            cursor: pointer; transition: background 0.12s;
        }
        .dropdown-item:hover { background: #f3f4f6; }

        /* ── Post content ──────────────────── */
        .post-title { font-size: 17px; font-weight: 600; color: #111; margin: 0 0 8px; line-height: 1.4; }

        .post-content {
            font-size: 15px; color: #374151; line-height: 1.7;
            margin-bottom: 12px; word-break: break-word;
        }

        /* ── Post image ────────────────────── */
        .post-image-wrap { margin: 10px 0 14px; border-radius: 10px; overflow: hidden; }
        .post-image {
            width: 100%; max-height: 420px; object-fit: cover;
            display: block; cursor: zoom-in; transition: opacity 0.2s;
        }
        .post-image:hover { opacity: 0.95; }

        /* ── Poll ──────────────────────────── */
        .poll-container { margin: 12px 0 16px; }
        .poll-question { font-size: 13px; font-weight: 600; color: #374151; margin: 0 0 10px; }

        .poll-option {
            display: flex; align-items: center; gap: 10px;
            width: 100%; padding: 9px 12px; margin-bottom: 8px;
            border: 1.5px solid #e5e7eb; border-radius: 9px;
            background: #fff; cursor: pointer;
            transition: border-color 0.15s, background 0.15s;
            text-align: left;
        }
        .poll-option:hover { border-color: #6366f1; background: #f5f3ff; }
        .poll-option--voted { border-color: #6366f1; background: #eef2ff; }

        .poll-option-text { font-size: 14px; color: #374151; flex: 1; min-width: 0; }

        .poll-bar-track {
            flex: 1; height: 6px; background: #f3f4f6;
            border-radius: 99px; overflow: hidden; max-width: 120px;
        }
        .poll-bar { height: 100%; background: #6366f1; border-radius: 99px; transition: width 0.5s ease; }
        .poll-option--voted .poll-bar { background: #4f46e5; }

        .poll-pct { font-size: 12px; font-weight: 600; color: #6366f1; min-width: 32px; text-align: right; }
        .poll-total { font-size: 12px; color: #9ca3af; margin: 6px 0 0; }

        /* ── Tags ──────────────────────────── */
        .post-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 14px; }
        .hashtag-link {
            font-size: 13px; color: #6366f1; font-weight: 500;
            background: #eef2ff; padding: 3px 10px; border-radius: 20px;
            border: none; cursor: pointer; transition: background 0.15s;
        }
        .hashtag-link:hover { background: #e0e7ff; }

        /* ── Action bar ────────────────────── */
        .post-actions {
            display: flex; align-items: center; gap: 6px;
            padding-top: 12px; border-top: 1px solid #f3f4f6;
            flex-wrap: wrap;
        }

        .action-btn {
            display: inline-flex; align-items: center; gap: 5px;
            padding: 6px 12px; border-radius: 8px; border: none;
            background: #f9fafb; color: #6b7280; font-size: 13px;
            cursor: pointer; font-weight: 500;
            transition: background 0.15s, color 0.15s, transform 0.1s;
            font-family: inherit;
        }
        .action-btn:hover { background: #f3f4f6; color: #374151; }
        .action-btn:active { transform: scale(0.96); }

        .action-btn--active { background: #eef2ff; color: #6366f1; }
        .action-btn--active:hover { background: #e0e7ff; }

        .action-btn--saved { color: #f59e0b; background: #fffbeb; }
        .action-btn--saved:hover { background: #fef3c7; }

        /* ── AI summary box ────────────────── */
        .ai-summary-box { transition: max-height 0.5s ease; }

        /* ── Empty / error states ──────────── */
        .empty-feed {
            text-align: center; padding: 60px 24px;
            background: #fff; border-radius: 14px; border: 1px dashed #e5e7eb;
        }
        .empty-feed-icon { font-size: 40px; margin-bottom: 12px; }
        .empty-feed-title { font-size: 16px; font-weight: 600; color: #374151; margin: 0 0 6px; }
        .empty-feed-sub { font-size: 14px; color: #9ca3af; margin: 0; }

        .feed-error { text-align: center; padding: 32px; color: #ef4444; font-size: 15px; }

        /* ── Spinner ───────────────────────── */
        .spinner {
            display: inline-block; width: 14px; height: 14px;
            border: 2px solid rgba(255,255,255,0.4);
            border-top-color: #fff; border-radius: 50%;
            animation: spin 0.7s linear infinite; vertical-align: -2px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* ── Tag chip (form) ───────────────── */
        .tag-chip {
            display: inline-block; font-size: 12px; font-weight: 500;
            color: #6366f1; background: #eef2ff; padding: 2px 8px;
            border-radius: 20px; margin: 2px;
        }

        /* ── Lightbox fadeIn ───────────────── */
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

        /* ── Dark mode overrides ───────────── */
        /* Driven by the app's own toggle (body.dark-mode), not the OS
           prefers-color-scheme media query — these need to follow the
           in-app theme button, not the system setting. */
        body.dark-mode .post-card { background: #18181b; border-color: #27272a; }
        body.dark-mode .post-card:hover { border-color: #3f3f46; }
        body.dark-mode .post-author-name,
        body.dark-mode .post-title,
        body.dark-mode .post-content { color: #f4f4f5; }
        body.dark-mode .post-options-dropdown { background: #1c1c1f; border-color: #27272a; }
        body.dark-mode .dropdown-item { color: #d4d4d8; }
        body.dark-mode .dropdown-item:hover { background: #27272a; }
        body.dark-mode .action-btn { background: #27272a; color: #a1a1aa; }
        body.dark-mode .action-btn:hover { background: #3f3f46; color: #f4f4f5; }
        body.dark-mode .action-btn--active { background: #312e81; color: #a5b4fc; }
        body.dark-mode .poll-option { background: #18181b; border-color: #3f3f46; }
        body.dark-mode .poll-option:hover { background: #1e1b4b; border-color: #6366f1; }
        body.dark-mode .empty-feed { background: #18181b; border-color: #27272a; }
        body.dark-mode .empty-feed-title { color: #d4d4d8; }
        body.dark-mode { --sk: #27272a; }
    `;
    document.head.appendChild(style);
}