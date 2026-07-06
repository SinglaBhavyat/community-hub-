/**
 * posts.js — Advanced Community Feed Module
 */

import { db, auth } from '../config/firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { addDocument, currentUser } from '../store/db.js';
import { uploadImage, uploadMediaFiles, getVideoThumbnail } from '../utils/storage.js';
import {
    createPostCardHTML,
    handleAiSummarize,
} from '../ui/templates.js';
import {
    collection, onSnapshot, query, orderBy, limit, where,
    doc, updateDoc, arrayUnion, arrayRemove, deleteDoc,
    getDoc, getDocs, setDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { onPageVisit } from '../ui/navigation.js';

// ─── Utilities ────────────────────────────────────────────────────────────────

function showToast(message, type = 'info', duration = 3500) {
    const ICONS = { info: 'ℹ️', success: '✅', warn: '⚠️', warning: '⚠️', error: '❌' };
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.setAttribute('role', 'status');
        container.setAttribute('aria-live', 'polite');
        container.style.cssText = `
            position: fixed; bottom: 28px; right: 24px; z-index: 9999;
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

function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function readingTime(text = '') {
    const words = text.trim().split(/\s+/).length;
    const mins  = Math.ceil(words / 200);
    return mins < 1 ? 'under 1 min read' : `${mins} min read`;
}

function extractTags(text = '') {
    const raw = text.match(/#[\w]+/g) || [];
    return [...new Set(raw.map(t => t.replace('#', '').toLowerCase()))];
}

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

// ─── In-memory post cache ─────────────────────────────────────────────────────
const _postCache = new Map();

// ─── Video Player ─────────────────────────────────────────────────────────────
function initVideoPlayer(wrapper) {
    const video = wrapper.querySelector('video');
    if (!video || wrapper.dataset.playerInit) return;
    wrapper.dataset.playerInit = '1';

    const overlay = document.createElement('div');
    overlay.className = 'vid-overlay';
    overlay.innerHTML = `
        <div class="vid-play-btn" aria-label="Play/Pause">
            <svg class="vid-icon-play" viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M8 5v14l11-7z"/></svg>
            <svg class="vid-icon-pause hidden" viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
        </div>
    `;

    const controls = document.createElement('div');
    controls.className = 'vid-controls';
    controls.innerHTML = `
        <button class="vid-ctrl-btn vid-toggle-btn" aria-label="Play/Pause">
            <svg class="vid-icon-play" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M8 5v14l11-7z"/></svg>
            <svg class="vid-icon-pause hidden" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
        </button>
        <div class="vid-progress-wrap">
            <div class="vid-progress-bar">
                <div class="vid-progress-fill"></div>
                <div class="vid-progress-thumb"></div>
            </div>
        </div>
        <span class="vid-time">0:00</span>
        <button class="vid-ctrl-btn vid-mute-btn" aria-label="Mute/Unmute">
            <svg class="vid-icon-unmuted" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
                <path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
            </svg>
            <svg class="vid-icon-muted hidden" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
            </svg>
        </button>
        <button class="vid-ctrl-btn vid-fullscreen-btn" aria-label="Fullscreen">
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
        </button>
    `;

    wrapper.appendChild(overlay);
    wrapper.appendChild(controls);

    const playBtnOverlay = overlay.querySelector('.vid-play-btn');
    const toggleBtn    = controls.querySelector('.vid-toggle-btn');
    const muteBtn      = controls.querySelector('.vid-mute-btn');
    const fsBtn        = controls.querySelector('.vid-fullscreen-btn');
    const fill         = controls.querySelector('.vid-progress-fill');
    const thumb        = controls.querySelector('.vid-progress-thumb');
    const timeEl       = controls.querySelector('.vid-time');
    const progressWrap = controls.querySelector('.vid-progress-bar');

    function fmtTime(s) {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec.toString().padStart(2, '0')}`;
    }

    function syncPlayIcons(playing) {
        [overlay, controls].forEach(el => {
            el.querySelectorAll('.vid-icon-play').forEach(i => i.classList.toggle('hidden', playing));
            el.querySelectorAll('.vid-icon-pause').forEach(i => i.classList.toggle('hidden', !playing));
        });
        overlay.classList.toggle('vid-overlay--paused', !playing);
    }

    function syncMuteIcons(muted) {
        muteBtn.querySelector('.vid-icon-unmuted').classList.toggle('hidden', muted);
        muteBtn.querySelector('.vid-icon-muted').classList.toggle('hidden', !muted);
    }

    function togglePlay() {
        if (video.paused) { video.play(); } else { video.pause(); }
    }

    video.addEventListener('play',  () => syncPlayIcons(true));
    video.addEventListener('pause', () => syncPlayIcons(false));
    video.addEventListener('ended', () => syncPlayIcons(false));

    video.addEventListener('timeupdate', () => {
        if (!video.duration) return;
        const pct = (video.currentTime / video.duration) * 100;
        fill.style.width  = pct + '%';
        thumb.style.left  = pct + '%';
        timeEl.textContent = fmtTime(video.currentTime);
    });

    progressWrap.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = progressWrap.getBoundingClientRect();
        const pct  = (e.clientX - rect.left) / rect.width;
        video.currentTime = pct * video.duration;
    });

    playBtnOverlay.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
    toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) togglePlay(); });

    video.muted = true;
    syncMuteIcons(true);
    muteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        video.muted = !video.muted;
        syncMuteIcons(video.muted);
    });

    fsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (document.fullscreenElement) {
            document.exitFullscreen?.();
        } else {
            wrapper.requestFullscreen?.() || video.webkitRequestFullscreen?.();
        }
    });

    // Pause when out of view + cleanup on removal
    const obs = new IntersectionObserver(entries => {
        if (!entries[0].isIntersecting && !video.paused) video.pause();
    }, { threshold: 0.2 });
    obs.observe(wrapper);

    const removalObserver = new MutationObserver(() => {
        if (!document.contains(video)) {
            obs.disconnect();
            removalObserver.disconnect();
        }
    });
    removalObserver.observe(document.body, { childList: true, subtree: true });

    syncPlayIcons(false);
}

// ─── Media Gallery Renderer ───────────────────────────────────────────────────
function renderMediaItems(mediaItems) {
    if (!mediaItems?.length) return '';
    const items = mediaItems.filter(m => m?.url);
    if (!items.length) return '';

    const id    = 'carousel-' + Math.random().toString(36).slice(2, 8);
    const count = items.length;

    const slides = items.map((m, i) => {
        if (m.type === 'video') {
            return `
                <div class="carousel-slide" data-index="${i}">
                    <div class="vid-wrapper">
                        <video src="${m.url}" preload="metadata" playsinline muted
                               style="width:100%;height:100%;object-fit:cover;display:block;"></video>
                    </div>
                </div>`;
        }
        return `
            <div class="carousel-slide media-cell--image" data-index="${i}" data-media-type="image">
                <img src="${m.url}" alt="Post image ${i+1}" loading="lazy" class="post-image"
                     style="width:100%;height:100%;object-fit:cover;display:block;" />
            </div>`;
    }).join('');

    const dots = count > 1
        ? `<div class="carousel-dots">${items.map((_, i) =>
            `<span class="carousel-dot ${i === 0 ? 'carousel-dot--active' : ''}" data-dot="${i}"></span>`
          ).join('')}</div>`
        : '';

    const arrows = count > 1 ? `
        <button class="carousel-arrow carousel-prev" aria-label="Previous">‹</button>
        <button class="carousel-arrow carousel-next" aria-label="Next">›</button>` : '';

    return `
        <div class="post-carousel" id="${id}" data-current="0" data-count="${count}">
            <div class="carousel-track">${slides}</div>
            ${arrows}
            ${dots}
            ${count > 1 ? `<span class="carousel-counter">1 / ${count}</span>` : ''}
        </div>`;
}

// ─── Image / Video Lightbox ───────────────────────────────────────────────────
function openMediaLightbox(mediaItems, startIndex = 0) {
    const items = (mediaItems || []).filter(m => m?.url);
    if (!items.length) return;

    let current = startIndex;
    const overlay = document.createElement('div');
    overlay.className = 'lightbox-overlay';

    function render() {
        const m       = items[current];
        const isVideo = m.type === 'video';
        const navPrev = current > 0
            ? `<button class="lightbox-nav lightbox-prev" aria-label="Previous">‹</button>` : '';
        const navNext = current < items.length - 1
            ? `<button class="lightbox-nav lightbox-next" aria-label="Next">›</button>` : '';

        overlay.innerHTML = `
            <div class="lightbox-backdrop"></div>
            <div class="lightbox-container">
                <button class="lightbox-close" aria-label="Close">✕</button>
                <div class="lightbox-media">
                    ${isVideo ? `
                        <div class="vid-wrapper vid-wrapper--lightbox">
                            <video src="${m.url}" controls autoplay
                                   style="max-width:90vw;max-height:80vh;border-radius:10px;"></video>
                        </div>
                    ` : `
                        <img src="${m.url}" alt="Media ${current+1}"
                             style="max-width:90vw;max-height:80vh;border-radius:10px;object-fit:contain;" />
                    `}
                </div>
                ${navPrev}${navNext}
                ${items.length > 1 ? `<div class="lightbox-counter">${current+1} / ${items.length}</div>` : ''}
            </div>
        `;

        overlay.querySelector('.lightbox-close')?.addEventListener('click', () => overlay.remove());
        overlay.querySelector('.lightbox-backdrop')?.addEventListener('click', () => overlay.remove());
        overlay.querySelector('.lightbox-prev')?.addEventListener('click', (e) => { e.stopPropagation(); current--; render(); });
        overlay.querySelector('.lightbox-next')?.addEventListener('click', (e) => { e.stopPropagation(); current++; render(); });
    }

    render();

    // Fixed: no stacking listeners
    function _lbKeyHandler(e) {
        if (!document.body.contains(overlay)) {
            document.removeEventListener('keydown', _lbKeyHandler);
            return;
        }
        if (e.key === 'Escape')      { overlay.remove(); document.removeEventListener('keydown', _lbKeyHandler); }
        if (e.key === 'ArrowLeft'  && current > 0)               { current--; render(); }
        if (e.key === 'ArrowRight' && current < items.length - 1) { current++; render(); }
    }
    document.addEventListener('keydown', _lbKeyHandler);
    document.body.appendChild(overlay);
}

// ─── Create Post Media Dropzone ───────────────────────────────────────────────
const _selectedFiles = [];

function setupMediaDropzone() {
    const dropzone    = document.getElementById('post-media-dropzone');
    const input       = document.getElementById('post-media-input');
    const previewGrid = document.getElementById('post-media-preview');
    if (!dropzone || !input) return;

    _selectedFiles.length = 0;

    function renderPreview() {
        if (!previewGrid) return;
        if (!_selectedFiles.length) {
            previewGrid.style.display = 'none';
            previewGrid.innerHTML = '';
            return;
        }
        previewGrid.style.display = 'grid';
        previewGrid.innerHTML = '';

        _selectedFiles.forEach((file, i) => {
            const cell = document.createElement('div');
            cell.className = 'media-preview-cell';

            if (file.type.startsWith('video/')) {
                const thumb = file._thumbDataUrl;
                cell.innerHTML = `
                    <div class="media-preview-thumb media-preview-thumb--video">
                        ${thumb ? `<img src="${thumb}" style="width:100%;height:100%;object-fit:cover;border-radius:6px;">` : ''}
                        <div class="media-preview-video-badge">▶ VIDEO</div>
                    </div>
                    <button class="media-preview-remove" data-index="${i}" title="Remove" aria-label="Remove file">✕</button>
                    <div class="media-preview-label">${file.name.length > 18 ? file.name.slice(0,16)+'…' : file.name}</div>
                `;
            } else {
                const url = URL.createObjectURL(file);
                cell.innerHTML = `
                    <img src="${url}" class="media-preview-thumb" alt="Preview ${i+1}">
                    <button class="media-preview-remove" data-index="${i}" title="Remove" aria-label="Remove file">✕</button>
                `;
            }

            cell.querySelector('.media-preview-remove').addEventListener('click', () => {
                _selectedFiles.splice(i, 1);
                renderPreview();
            });

            previewGrid.appendChild(cell);
        });
    }

    async function addFiles(newFiles) {
        const allowed = 6 - _selectedFiles.length;
        if (allowed <= 0) { showToast('Maximum 6 media files allowed.', 'warn'); return; }
        const toAdd = Array.from(newFiles).slice(0, allowed);

        for (const f of toAdd) {
            const isImage = f.type.startsWith('image/');
            const isVideo = f.type.startsWith('video/');
            if (!isImage && !isVideo) { showToast(`${f.name}: unsupported file type.`, 'warn'); continue; }
            if (isImage && f.size > 10 * 1024 * 1024) { showToast(`${f.name}: image must be under 10 MB.`, 'warn'); continue; }
            if (isVideo && f.size > 50 * 1024 * 1024) { showToast(`${f.name}: video must be under 50 MB.`, 'warn'); continue; }
            if (isVideo) { f._thumbDataUrl = await getVideoThumbnail(f).catch(() => null); }
            _selectedFiles.push(f);
        }

        renderPreview();
        if (_selectedFiles.length >= 6) showToast('Maximum 6 files reached.', 'info', 2000);
    }

    input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
    dropzone.addEventListener('dragover',  (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); addFiles(e.dataTransfer.files); });
}

// ─── Poll Builder ─────────────────────────────────────────────────────────────
function setupPollBuilder() {
    const addPollBtn = document.getElementById('add-poll-btn');
    const pollArea   = document.getElementById('poll-creator-container');
    const addOptBtn  = document.getElementById('add-poll-option-btn');
    const optList    = document.getElementById('poll-options-list');

    addPollBtn?.addEventListener('click', () => {
        addPollBtn.classList.add('hidden');
        pollArea?.classList.remove('hidden');
        optList?.querySelector('.poll-option-input')?.focus();
    });

    addOptBtn?.addEventListener('click', () => {
        if (!optList) return;
        const currentOptions = optList.querySelectorAll('.poll-option-input');
        if (currentOptions.length >= 6) { showToast('Maximum 6 poll options allowed.', 'info'); return; }
        const wrapper = document.createElement('div');
        wrapper.className = 'poll-option-row';
        wrapper.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
        wrapper.innerHTML = `
            <input type="text" class="poll-option-input"
                placeholder="Option ${currentOptions.length + 1}"
                style="flex:1;padding:8px 12px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:14px;"
                maxlength="100" />
            <button type="button" class="remove-poll-option-btn" aria-label="Remove option"
                style="width:32px;height:32px;border:none;background:#fee2e2;color:#dc2626;
                       border-radius:6px;cursor:pointer;font-size:18px;line-height:1;">×</button>
        `;
        wrapper.querySelector('.remove-poll-option-btn').addEventListener('click', () => wrapper.remove());
        optList.appendChild(wrapper);
        wrapper.querySelector('.poll-option-input').focus();
    });
}

// ─── Character Counter + Tag Preview ─────────────────────────────────────────
function setupContentEnhancements() {
    const contentArea = document.getElementById('post-content');
    const charCounter = document.getElementById('post-char-counter');
    const tagPreview  = document.getElementById('post-tag-preview');
    const LIMIT = 5000;

    contentArea?.addEventListener('input', () => {
        const len  = contentArea.value.length;
        const tags = extractTags(contentArea.value);
        if (charCounter) {
            charCounter.textContent  = `${len} / ${LIMIT}`;
            charCounter.style.color  = len > LIMIT * 0.9 ? '#ef4444' : '#9ca3af';
        }
        if (tagPreview) {
            tagPreview.innerHTML = tags.length
                ? tags.map(t => `<span class="tag-chip">#${t}</span>`).join('')
                : '';
        }
    });
}

// ─── Poll Vote ────────────────────────────────────────────────────────────────
async function handlePollVote(postId, optionIndex) {
    if (!currentUser) return showToast('Sign in to vote.', 'warn');
    const post = _postCache.get(postId);
    if (!post?.poll) return;

    const userEmail   = currentUser.email;
    const currentVote = post.poll.options.findIndex(o => o.votes?.includes(userEmail));
    if (currentVote === optionIndex) return showToast('Already voted for this option.', 'info');

    const updatedOptions = post.poll.options.map((opt, i) => {
        let votes = [...(opt.votes || [])];
        if (i === currentVote) votes = votes.filter(v => v !== userEmail);
        if (i === optionIndex) votes.push(userEmail);
        return { ...opt, votes };
    });

    _postCache.set(postId, { ...post, poll: { ...post.poll, options: updatedOptions } });
    _renderPollResult(postId, updatedOptions, userEmail);

    try {
        await updateDoc(doc(db, 'posts', postId), { 'poll.options': updatedOptions });
    } catch (err) {
        showToast('Vote failed. Please try again.', 'error');
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
        const bar     = el.querySelector('.poll-bar');
        const label   = el.querySelector('.poll-pct');
        if (bar)   bar.style.width   = `${pct}%`;
        if (label) label.textContent = `${pct}%`;
        el.classList.toggle('poll-option--voted', isVoted);
    });
    const totalEl = pollEl.querySelector('.poll-total');
    if (totalEl) totalEl.textContent = `${totalVotes} vote${totalVotes !== 1 ? 's' : ''}`;
}

// ─── AI Summarize ─────────────────────────────────────────────────────────────
async function aiSummarizePost(postCard, postData) {
    const btn = postCard.querySelector('.ai-summarize-btn');
    let summaryEl = postCard.querySelector('.ai-summary-box');

    if (summaryEl) {
        summaryEl.style.maxHeight = summaryEl.style.maxHeight === '0px' ? '200px' : '0px';
        return;
    }

    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Summarising…`; }

    summaryEl = document.createElement('div');
    summaryEl.className = 'ai-summary-box';
    summaryEl.style.cssText = `
        margin-top: 14px; padding: 14px 16px;
        border-radius: 10px; border-left: 3px solid #6366f1; font-size: 14px; line-height: 1.7;
        color: #374151; overflow: hidden; max-height: 0; transition: max-height 0.5s ease;
    `;
    const header = document.createElement('p');
    header.style.cssText = 'margin: 0 0 6px; font-size: 11px; font-weight: 600; color: #6366f1; letter-spacing: 0.08em;';
    header.textContent = '✦ AI SUMMARY';
    const body = document.createElement('p');
    body.style.cssText = 'margin: 0; color: #374151;';
    summaryEl.append(header, body);
    const contentArea = postCard.querySelector('.post-content') || postCard.querySelector('p');
    contentArea?.after(summaryEl);
    requestAnimationFrame(() => { summaryEl.style.maxHeight = '200px'; });

    try {
        const raw       = (postData.content || '').trim();
        const sentences = raw.match(/[^.!?\n]+[.!?]+/g) || [];
        let text = sentences.length >= 2
            ? sentences.slice(0, 2).join(' ').trim()
            : raw.slice(0, 280).trim() + (raw.length > 280 ? '…' : '');
        if (!text) text = 'No content to summarise.';
        let i = 0;
        const type = () => { if (i < text.length) { body.textContent += text[i++]; requestAnimationFrame(type); } };
        type();
    } catch {
        body.textContent = 'Unable to summarise this post right now.';
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = `✦ Summary`; }
    }
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────
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

// ─── Edit Post Modal ──────────────────────────────────────────────────────────
async function openEditModal(postId) {
    const post = _postCache.get(postId);
    if (!post) return showToast('Post data not available.', 'error');
    if (!currentUser || post.authorEmail !== currentUser.email) {
        return showToast('You can only edit your own posts.', 'warn');
    }

    document.getElementById('edit-post-modal')?.remove();

    let editMediaItems = [...(post.mediaItems || [])];
    if (!editMediaItems.length && post.imageSrc) {
        editMediaItems = [{ url: post.imageSrc, type: 'image' }];
    }

    const editNewFiles = [];

    const modal = document.createElement('div');
    modal.id = 'edit-post-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'edit-modal-title');
    modal.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.55);
        display: flex; align-items: center; justify-content: center;
        z-index: 9000; animation: fadeIn 0.2s ease; padding: 16px;
    `;
    modal.innerHTML = `
        <div style="background:#fff;border-radius:18px;padding:clamp(16px,4vw,28px);width:min(620px,100%);
                    box-shadow:0 20px 60px rgba(0,0,0,0.25);display:flex;flex-direction:column;gap:20px;
                    max-height:90vh;overflow-y:auto;box-sizing:border-box;">
            <h2 id="edit-modal-title" style="margin:0;font-size:20px;font-weight:700;color:#111;">Edit Post</h2>
            <div>
                <label style="font-size:13px;font-weight:600;color:#374151;display:block;margin-bottom:6px;">Title</label>
                <input id="edit-title" type="text" value="${(post.title || '').replace(/"/g, '&quot;')}"
                    style="width:100%;padding:10px 14px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:15px;box-sizing:border-box;"
                    placeholder="Post title" />
            </div>
            <div>
                <label style="font-size:13px;font-weight:600;color:#374151;display:block;margin-bottom:6px;">Content</label>
                <textarea id="edit-content" rows="5"
                    style="width:100%;padding:10px 14px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:15px;
                           resize:vertical;font-family:inherit;box-sizing:border-box;"
                    placeholder="What's on your mind?">${post.content || ''}</textarea>
            </div>
            <div>
                <label style="font-size:13px;font-weight:600;color:#374151;display:block;margin-bottom:10px;">
                    Media <span style="font-weight:400;color:#9ca3af;font-size:12px;margin-left:6px;">Click × to remove · Add new below</span>
                </label>
                <div id="edit-existing-media" style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px;overflow:visible;"></div>
                <div id="edit-new-media-preview" style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px;overflow:visible;"></div>
                <label id="edit-add-media-label"
                    style="display:inline-flex;align-items:center;gap:8px;padding:9px 16px;
                           border:1.5px dashed #c7d2fe;border-radius:10px;cursor:pointer;
                           font-size:13px;color:#6366f1;font-weight:500;background:#f5f3ff;transition:background 0.15s;">
                    <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
                    </svg>
                    Add media
                    <input id="edit-add-media-input" type="file" accept="image/*,video/mp4,video/webm,video/quicktime"
                        multiple style="display:none;">
                </label>
                <p id="edit-media-count" style="font-size:12px;color:#9ca3af;margin:6px 0 0;"></p>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;padding-top:4px;border-top:1px solid #f3f4f6;">
                <button id="edit-cancel-btn"
                    style="padding:10px 20px;border-radius:10px;border:1.5px solid #e5e7eb;
                           background:#fff;font-size:14px;cursor:pointer;font-weight:500;color:#374151;">Cancel</button>
                <button id="edit-save-btn"
                    style="padding:10px 20px;border-radius:10px;border:none;
                           background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;font-size:14px;
                           cursor:pointer;font-weight:600;min-width:120px;">Save changes</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    function renderExistingMedia() {
        const container = modal.querySelector('#edit-existing-media');
        container.innerHTML = '';
        editMediaItems.forEach((m, i) => {
            const cell = document.createElement('div');
            cell.style.cssText = 'position:relative;width:90px;height:90px;border-radius:8px;overflow:hidden;flex-shrink:0;';
            if (m.type === 'video') {
                cell.innerHTML = `<div style="width:100%;height:100%;background:#1e293b;display:flex;align-items:center;justify-content:center;border-radius:8px;">
                    <svg width="28" height="28" fill="white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>`;
            } else {
                cell.innerHTML = `<img src="${m.url}" style="width:100%;height:100%;object-fit:cover;">`;
            }
            const removeBtn = document.createElement('button');
            removeBtn.innerHTML = '✕';
            removeBtn.title = 'Remove';
            removeBtn.style.cssText = `position:absolute;top:4px;right:4px;width:22px;height:22px;border-radius:50%;border:none;
                background:rgba(0,0,0,0.65);color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;padding:0;`;
            removeBtn.addEventListener('click', () => {
                editMediaItems.splice(i, 1);
                renderExistingMedia();
                updateMediaCount();
            });
            cell.appendChild(removeBtn);
            container.appendChild(cell);
        });
    }

    function renderNewFilesPreview() {
        const container = modal.querySelector('#edit-new-media-preview');
        container.innerHTML = '';
        editNewFiles.forEach((file, i) => {
            const cell = document.createElement('div');
            cell.style.cssText = 'position:relative;width:90px;height:90px;border-radius:8px;overflow:hidden;flex-shrink:0;border:2px solid #6366f1;';
            if (file.type.startsWith('video/')) {
                const thumb = file._thumbDataUrl;
                cell.innerHTML = `<div style="width:100%;height:100%;background:#1e1b4b;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;">
                    ${thumb ? `<img src="${thumb}" style="width:100%;height:100%;object-fit:cover;position:absolute;inset:0;opacity:0.5;">` : ''}
                    <svg width="24" height="24" fill="white" viewBox="0 0 24 24" style="position:relative;z-index:1;"><path d="M8 5v14l11-7z"/></svg>
                    <span style="font-size:9px;color:white;position:relative;z-index:1;font-weight:600;">NEW</span></div>`;
            } else {
                const url = URL.createObjectURL(file);
                cell.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;">
                    <span style="position:absolute;bottom:2px;left:50%;transform:translateX(-50%);
                        background:rgba(99,102,241,0.85);color:#fff;font-size:9px;padding:1px 4px;border-radius:3px;font-weight:600;">NEW</span>`;
            }
            const removeBtn = document.createElement('button');
            removeBtn.innerHTML = '✕';
            removeBtn.style.cssText = `position:absolute;top:4px;right:4px;width:22px;height:22px;border-radius:50%;border:none;
                background:rgba(0,0,0,0.65);color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;padding:0;z-index:2;`;
            removeBtn.addEventListener('click', () => {
                editNewFiles.splice(i, 1);
                renderNewFilesPreview();
                updateMediaCount();
            });
            cell.appendChild(removeBtn);
            container.appendChild(cell);
        });
    }

    function updateMediaCount() {
        const total    = editMediaItems.length + editNewFiles.length;
        const el       = modal.querySelector('#edit-media-count');
        const addLabel = modal.querySelector('#edit-add-media-label');
        if (el) el.textContent = total ? `${total} / 6 files` : '';
        if (addLabel) addLabel.style.display = total >= 6 ? 'none' : 'inline-flex';
    }

    renderExistingMedia();
    renderNewFilesPreview();
    updateMediaCount();

    const addInput = modal.querySelector('#edit-add-media-input');
    addInput?.addEventListener('change', async () => {
        const totalCurrent = editMediaItems.length + editNewFiles.length;
        const allowed      = 6 - totalCurrent;
        const files        = Array.from(addInput.files).slice(0, allowed);
        for (const f of files) {
            if (f.type.startsWith('video/')) { f._thumbDataUrl = await getVideoThumbnail(f).catch(() => null); }
            editNewFiles.push(f);
        }
        renderNewFilesPreview();
        updateMediaCount();
        addInput.value = '';
    });

    const closeModal = () => modal.remove();
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    modal.querySelector('#edit-cancel-btn').addEventListener('click', closeModal);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); }, { once: true });

    modal.querySelector('#edit-save-btn').addEventListener('click', async () => {
        const newTitle   = modal.querySelector('#edit-title').value.trim();
        const newContent = modal.querySelector('#edit-content').value.trim();
        if (!newContent && !editMediaItems.length && !editNewFiles.length) {
            return showToast('Please add content or media.', 'warn');
        }

        const saveBtn = modal.querySelector('#edit-save-btn');
        saveBtn.innerHTML = `<span class="spinner"></span> Saving…`;
        saveBtn.disabled  = true;

        try {
            let uploadedNew = [];
            if (editNewFiles.length) {
                showToast('Uploading new media…', 'info', 8000);
                uploadedNew = await uploadMediaFiles(editNewFiles, 'posts');
            }

            const finalMediaItems = [...editMediaItems, ...uploadedNew];
            const newTags         = extractTags(newContent);
            const firstImage      = finalMediaItems.find(m => m.type === 'image');

            await updateDoc(doc(db, 'posts', postId), {
                title:      newTitle,
                content:    newContent,
                tags:       newTags,
                edited:     true,
                editedAt:   Date.now(),
                mediaItems: finalMediaItems,
                imageSrc:   firstImage?.url || null,
            });

            showToast('Post updated!', 'success');
            closeModal();
        } catch (err) {
            console.error('Edit error:', err);
            showToast(`Failed to save: ${err.message}`, 'error');
            saveBtn.innerHTML = 'Save changes';
            saveBtn.disabled  = false;
        }
    });

    requestAnimationFrame(() => modal.querySelector('#edit-title')?.focus());
}

// ─── Render Helpers ───────────────────────────────────────────────────────────
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
                const count = opt.votes?.length || 0;
                const pct   = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
                const voted = i === userVote;
                return `
                    <button class="poll-option ${voted ? 'poll-option--voted' : ''}"
                        data-option-index="${i}" aria-pressed="${voted}">
                        <span class="poll-option-text">${opt.text}</span>
                        <div class="poll-bar-track"><div class="poll-bar" style="width:${pct}%"></div></div>
                        <span class="poll-pct">${pct}%</span>
                    </button>`;
            }).join('')}
            <p class="poll-total">${totalVotes} vote${totalVotes !== 1 ? 's' : ''}</p>
        </div>`;
}

// ─── Render Post ──────────────────────────────────────────────────────────────
function renderPost(post) {
    const card = document.createElement('div');
    card.className      = 'post-card';
    card.dataset.postId = post.id;

    const isVoted = currentUser && (post.upvotedBy || []).includes(currentUser.email);
    const isSaved = currentUser && (currentUser.savedPosts || []).includes(post.id);
    const upvotes = post.upvotedBy?.length || 0;

    const mediaItems = post.mediaItems?.length
        ? post.mediaItems
        : (post.imageSrc ? [{ url: post.imageSrc, type: 'image' }] : []);

    card.innerHTML = `
        <div class="post-header">
            <div class="post-author-info">
                <div class="author-avatar" aria-hidden="true">${(post.author || 'A').charAt(0).toUpperCase()}</div>
                <div>
                    <span class="post-author-name">${post.author || 'Anonymous'}</span>
                    <div class="post-meta-row">
                        <span class="post-time" title="${new Date(post.timestamp).toLocaleString()}">${relativeTime(post.timestamp)}</span>
                        ${post.edited ? '<span class="post-edited-badge">edited</span>' : ''}
                        <span class="post-separator"></span>
                        <span class="post-community-chip">${post.community || 'Global'}</span>
                        ${post.category ? `<span class="post-separator"></span><span class="post-category-chip">${post.category}</span>` : ''}
                        <span class="post-separator"></span>
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
                </div>
            </div>
        </div>

        ${post.title ? `<h3 class="post-title">${post.title}</h3>` : ''}
        <div class="post-content">${_renderContent(post.content || '')}</div>

        ${renderMediaItems(mediaItems)}
        ${post.poll ? _renderPoll(post) : ''}
        ${post.type === 'event' ? (() => {
            const going      = post.attendance?.going?.length    || 0;
            const maybe      = post.attendance?.maybe?.length   || 0;
            const notGoing   = post.attendance?.notGoing?.length || 0;
            const isGoing    = !!(post.attendance?.going?.includes(currentUser?.email));
            const isMaybe    = !!(post.attendance?.maybe?.includes(currentUser?.email));
            const isNotGoing = !!(post.attendance?.notGoing?.includes(currentUser?.email));
            return `
        <div class="mt-4 rounded-2xl border overflow-hidden transition-all duration-300"
             style="background: rgba(249,115,22,0.04); border-color: rgba(249,115,22,0.2);">
            <div class="px-4 pt-3 pb-2">
                <div class="flex flex-wrap gap-x-5 gap-y-1 text-sm mb-3">
                    ${post.eventDate ? `<span class="flex items-center gap-1.5 text-orange-600 font-semibold">📅 ${post.eventDate}${post.eventTime ? ' · ' + post.eventTime : ''}</span>` : ''}
                    ${post.eventLocation ? `<span class="flex items-center gap-1.5 text-gray-500">📍 ${post.eventLocation}</span>` : ''}
                </div>
                <div class="flex items-center gap-1 mb-3 text-xs text-gray-400">
                    <span class="font-semibold text-emerald-600"><span class="rsvp-going-count">${going}</span> going</span>
                    <span>·</span>
                    <span><span class="rsvp-maybe-count">${maybe}</span> maybe</span>
                    <span>·</span>
                    <span><span class="rsvp-not-going-count">${notGoing}</span> not going</span>
                </div>
                <div class="flex gap-2">
                    <button class="rsvp-btn rsvp-going flex-1 py-2 rounded-xl text-sm font-semibold border transition-all duration-200 ${isGoing ? 'bg-emerald-500 text-white border-emerald-500 shadow-md rsvp-active' : 'border-gray-300 text-gray-600 hover:border-emerald-400 hover:text-emerald-600 bg-white'}">✓ Going</button>
                    <button class="rsvp-btn rsvp-maybe flex-1 py-2 rounded-xl text-sm font-semibold border transition-all duration-200 ${isMaybe ? 'bg-amber-400 text-white border-amber-400 shadow-md rsvp-active' : 'border-gray-300 text-gray-600 hover:border-amber-400 hover:text-amber-600 bg-white'}">? Maybe</button>
                    <button class="rsvp-btn rsvp-not-going flex-1 py-2 rounded-xl text-sm font-semibold border transition-all duration-200 ${isNotGoing ? 'bg-red-400 text-white border-red-400 shadow-md rsvp-active' : 'border-gray-300 text-gray-600 hover:border-red-400 hover:text-red-600 bg-white'}">✕ Not Going</button>
                </div>
            </div>
        </div>`; })() : ''}

        ${post.tags?.length ? `
            <div class="post-tags">
                ${post.tags.map(t => `<button class="hashtag-link" data-tag="${t}">#${t}</button>`).join('')}
            </div>` : ''}

        <div class="post-actions">
            <button class="action-btn upvote-btn ${isVoted ? 'action-btn--active' : ''}"
                aria-label="${isVoted ? 'Remove upvote' : 'Upvote'}" aria-pressed="${isVoted}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="${isVoted ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
                    <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/>
                    <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
                </svg>
                <span class="upvote-count">${upvotes}</span>
            </button>
            <button class="action-btn view-comments-btn" aria-label="View comments">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                <span>${post.commentCount || 0}</span>
            </button>
            <button class="action-btn bookmark-btn ${isSaved ? 'action-btn--saved' : ''}"
                aria-label="${isSaved ? 'Remove bookmark' : 'Bookmark'}" aria-pressed="${isSaved}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="${isSaved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
                </svg>
            </button>
            <button class="action-btn ai-summarize-btn" aria-label="AI summary" title="AI summary">✦ Summary</button>
        </div>
    `;

    requestAnimationFrame(() => {
        card.querySelectorAll('.vid-wrapper').forEach(w => initVideoPlayer(w));
    });

    return card;
}

// ─── Carousel ─────────────────────────────────────────────────────────────────
function goToSlide(carousel, index) {
    const track   = carousel.querySelector('.carousel-track');
    const counter = carousel.querySelector('.carousel-counter');
    const count   = parseInt(carousel.dataset.count, 10);
    if (!track) return;
    track.style.transform     = `translateX(-${index * 100}%)`;
    carousel.dataset.current  = index;
    carousel.querySelectorAll('.carousel-dot').forEach((d, i) => {
        d.classList.toggle('carousel-dot--active', i === index);
    });
    if (counter) counter.textContent = `${index + 1} / ${count}`;
    carousel.querySelectorAll('video').forEach((v, i) => { if (i !== index) v.pause(); });
    const currentSlide = carousel.querySelectorAll('.carousel-slide')[index];
    const vidWrapper   = currentSlide?.querySelector('.vid-wrapper');
    if (vidWrapper) initVideoPlayer(vidWrapper);
}

function setupCarousels() {
    // Check dropdown viewport edge on open
    function _fixDropdownEdge(dropdown) {
        const rect = dropdown.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            dropdown.style.right = 'auto';
            dropdown.style.left  = '0';
        }
    }

    document.addEventListener('click', (e) => {
        const arrow = e.target.closest('.carousel-arrow');
        if (arrow) {
            e.stopPropagation();
            const carousel = arrow.closest('.post-carousel');
            if (!carousel) return;
            const current = parseInt(carousel.dataset.current, 10);
            const count   = parseInt(carousel.dataset.count, 10);
            const next    = arrow.classList.contains('carousel-next')
                ? (current + 1) % count
                : (current - 1 + count) % count;
            goToSlide(carousel, next);
            return;
        }
        const dot = e.target.closest('.carousel-dot');
        if (dot) {
            e.stopPropagation();
            const carousel = dot.closest('.post-carousel');
            if (!carousel) return;
            goToSlide(carousel, parseInt(dot.dataset.dot, 10));
            return;
        }
        // Single image from templates.js card
        const singleImgWrap = e.target.closest('.post-single-image-wrap');
        if (singleImgWrap) {
            const src = singleImgWrap.dataset.imgSrc;
            if (src) openMediaLightbox([{ url: src, type: 'image' }], 0);
            return;
        }

        const slide = e.target.closest('.carousel-slide.media-cell--image');
        if (slide && !e.target.closest('.carousel-arrow')) {
            const carousel = slide.closest('.post-carousel');
            const postCard = slide.closest('.post-card');
            if (!postCard || !carousel) return;
            const postId = postCard.dataset.postId;
            const post   = _postCache.get(postId);
            const items  = post?.mediaItems?.length
                ? post.mediaItems
                : (post?.imageSrc ? [{ url: post.imageSrc, type: 'image' }] : []);
            openMediaLightbox(items, parseInt(carousel.dataset.current, 10));
        }
    });

    let touchStartX = 0;
    document.addEventListener('touchstart', (e) => {
        if (e.target.closest('.post-carousel')) touchStartX = e.touches[0].clientX;
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
        const carousel = e.target.closest('.post-carousel');
        if (!carousel) return;
        const diff    = touchStartX - e.changedTouches[0].clientX;
        if (Math.abs(diff) < 40) return;
        const current = parseInt(carousel.dataset.current, 10);
        const count   = parseInt(carousel.dataset.count, 10);
        goToSlide(carousel, diff > 0 ? (current + 1) % count : (current - 1 + count) % count);
    }, { passive: true });
}

// ─── Theme Toggle ─────────────────────────────────────────────────────────────
function _injectThemeToggle() {
    // index.html is the single owner of #theme-toggle-btn and nexus_theme.
    // It exposes window.__applyTheme and registers the authoritative click
    // listener in capture phase (with stopPropagation) so this function must
    // NOT add a second listener — doing so caused a double-toggle bug where
    // every click immediately reverted the change.
    //
    // All we do here is: re-sync the icon in case posts.js loaded after the
    // inline script ran and overwrote the button's innerHTML, and add the
    // ambient background particle if it's missing.

    if (typeof window.__applyTheme === 'function') {
        // Re-apply current state so the icon is correct for the loaded theme.
        window.__applyTheme(document.body.classList.contains('dark-mode'));
    } else {
        // Fallback: index.html script hasn't run yet (unusual) — apply from storage.
        const STORAGE_KEY = 'nexus_theme';
        const saved      = localStorage.getItem(STORAGE_KEY);
        const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const isDark     = saved === 'dark' || (!saved && systemDark);
        document.body.classList.toggle('dark-mode', isDark);
        localStorage.setItem(STORAGE_KEY, isDark ? 'dark' : 'light');
        const btn = document.getElementById('theme-toggle-btn');
        if (btn) {
            const sunSVG  = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>`;
            const moonSVG = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 015.646 5.646 9.001 9.001 0 0120.354 15.354z"/></svg>`;
            btn.innerHTML = isDark ? sunSVG : moonSVG;
            // Register click only in this rare fallback path
            document.addEventListener('click', (e) => {
                if (e.target.closest('#theme-toggle-btn')) {
                    const next = !document.body.classList.contains('dark-mode');
                    document.body.classList.toggle('dark-mode', next);
                    localStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light');
                    btn.innerHTML = next ? sunSVG : moonSVG;
                }
            }, { capture: true });
        }
    }

    // Background orb (ambient decoration)
    if (!document.querySelector('.bg-particle')) {
        const orb = document.createElement('div');
        orb.className  = 'bg-particle';
        orb.style.cssText = 'width:360px;height:360px;background:#06b6d4;top:45%;left:40%;animation-duration:25s;';
        document.body.insertBefore(orb, document.body.firstChild);
    }
}

// ─── Main: setupPosts() ───────────────────────────────────────────────────────
export function setupPosts() {
    let postLimit       = 30;
    let activeFeedUnsub = null;
    let cacheUnsub      = null;
    let isLoadingMore   = false;

    const feed     = document.getElementById('posts-feed');
    const sentinel = document.getElementById('feed-end-sentinel');

    _injectGlobalStyles();
    _injectThemeToggle();
    setupMediaDropzone();
    setupPollBuilder();
    setupContentEnhancements();
    setupCarousels();

    document.getElementById('post-community')?.addEventListener('change', (e) => {
        const custom   = document.getElementById('post-community-custom');
        if (!custom) return;
        const isCustom = e.target.value === 'Custom';
        custom.classList.toggle('hidden', !isCustom);
        custom.required = isCustom;
        if (!isCustom) custom.value = '';
    });

    const debouncedLoad = debounce(() => loadFeed(), 300);
    document.getElementById('community-filter-select')?.addEventListener('change', () => loadFeed());
    document.getElementById('hashtag-filter-input')?.addEventListener('input', debouncedLoad);
    document.getElementById('keyword-search-input')?.addEventListener('input', debouncedLoad);

    document.querySelectorAll('[data-sort]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-sort]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            loadFeed();
        });
    });

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
        const community = document.getElementById('community-filter-select')?.value || 'all';
        const tag       = (document.getElementById('hashtag-filter-input')?.value || '').replace(/#/g, '').trim().toLowerCase();
        const keyword   = (document.getElementById('keyword-search-input')?.value || '').trim().toLowerCase();

        return (community === 'all' || post.community === community)
            && (!tag     || (post.tags && post.tags.includes(tag)))
            && (!keyword || (post.title || '').toLowerCase().includes(keyword)
                         || (post.content || '').toLowerCase().includes(keyword)
                         || (post.author || '').toLowerCase().includes(keyword));
    }

    function loadFeed(reset = true) {
        if (!feed) return;
        if (activeFeedUnsub) { activeFeedUnsub(); activeFeedUnsub = null; }
        if (reset) { postLimit = 30; feed.innerHTML = skeletonHTML(4); }

        activeFeedUnsub = onSnapshot(buildFeedQuery(), (snapshot) => {
            // Handle removals
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

            // Update cache
            snapshot.forEach(d => _postCache.set(d.id, { id: d.id, ...d.data() }));

            if (reset) feed.innerHTML = '';

            const broadcasts = [];  // isBroadcast:true — always topmost
            const pinned     = [];  // regular pinned posts — below broadcasts
            const normal     = [];
            let count        = 0;

            snapshot.forEach(docSnap => {
                const post = { id: docSnap.id, ...docSnap.data() };
                if (!matchesFilters(post)) return;
                if (!reset && feed.querySelector(`.post-card[data-post-id="${post.id}"]`)) return;
                const card = renderPost(post);

                // Active broadcasts: mark with both CSS classes and inject
                // a "Broadcast" banner chip at the top of the card content.
                if (post.isBroadcast && post.status !== 'archived' && post.status !== 'scheduled') {
                    card.classList.add('post-card--pinned', 'post-card--broadcast');
                    // Inject broadcast badge above the card title (if not already there)
                    const cardBody = card.querySelector('.post-header, .post-content, .post-body, h2, h3, p');
                    if (cardBody && !card.querySelector('.broadcast-feed-banner')) {
                        const catEmoji = {
                            MAINTENANCE:'🔧', UPDATE:'✨', WARNING:'⚠️',
                            EVENT:'🎉', POLICY:'📜', NOTICE:'📣',
                        }[post.broadcastCategory] || '📡';
                        const banner = document.createElement('div');
                        banner.className = 'broadcast-feed-banner';
                        banner.innerHTML = `<span>${catEmoji} BROADCAST · ${post.broadcastCategory || 'ANNOUNCEMENT'}</span>`;
                        cardBody.parentElement?.insertBefore(banner, cardBody);
                    }
                    broadcasts.push(card);
                } else if (post.pinned) {
                    card.classList.add('post-card--pinned');
                    pinned.push(card);
                } else {
                    normal.push(card);
                }
                count++;
            });

            if (reset) {
                // Render order: broadcasts → regular pinned → normal posts
                broadcasts.forEach(c => feed.appendChild(c));
                pinned.forEach(c => feed.appendChild(c));
                normal.forEach(c => feed.appendChild(c));
                if (count === 0) {
                    feed.innerHTML = `
                        <div class="empty-feed" role="status">
                            <div class="empty-feed-icon" aria-hidden="true">
                                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                                </svg>
                            </div>
                            <p class="empty-feed-title">No posts found</p>
                            <p class="empty-feed-sub">Try adjusting your filters, or be the first to post.</p>
                        </div>`;
                }
            } else {
                normal.forEach(c => feed.appendChild(c));
            }

            if (sentinel) sentinel.classList.toggle('hidden', snapshot.docs.length < postLimit);
            isLoadingMore = false;

            requestAnimationFrame(() => {
                feed.querySelectorAll('.vid-wrapper:not([data-player-init])').forEach(w => initVideoPlayer(w));
            });
        }, (error) => {
            // permission-denied after sign-out is expected — the listener fires
            // one last time as credentials are revoked. Unsubscribe and stay quiet
            // rather than flashing an error card the user will never see.
            if (error?.code === 'permission-denied') {
                if (activeFeedUnsub) { activeFeedUnsub(); activeFeedUnsub = null; }
                return;
            }
            console.error('Feed error:', error);
            feed.innerHTML = `<div class="feed-error" role="alert"><p>⚠️ Failed to load posts.</p><button onclick="location.reload()" class="action-btn">Refresh</button></div>`;
        });
    }

    function _buildDropdown(dropdown) {
        const authorEmail = dropdown.dataset.authorEmail || '';
        const authorName  = dropdown.dataset.authorName  || '';
        const postId      = dropdown.dataset.postId      || '';
        const isPinned    = dropdown.dataset.pinned === '1';
        const isOwner     = !!(currentUser && currentUser.email === authorEmail);
        const isAdmin     = !!(currentUser && currentUser.role === 'admin');

        let html = '';
        if (isOwner) {
            html = `
                <button class="dropdown-item edit-post-btn" role="menuitem">✏️ Edit post</button>
                <button class="dropdown-item share-btn" role="menuitem">🔗 Share</button>
                <button class="dropdown-item delete-post-btn" role="menuitem" style="color:#ef4444;">🗑️ Delete post</button>`;
        } else if (isAdmin) {
            html = `
                <button class="dropdown-item share-btn" role="menuitem">🔗 Share</button>
                <button class="dropdown-item pin-post-btn" role="menuitem">${isPinned ? '📌 Unpin post' : '📌 Pin post'}</button>
                <button class="dropdown-item delete-post-btn" role="menuitem" style="color:#ef4444;">🗑️ Delete (Admin)</button>`;
        } else {
            const firstName = authorName.split(' ')[0] || 'author';
            html = `
                <button class="dropdown-item message-author-btn" role="menuitem"
                    data-email="${authorEmail}" data-name="${authorName}">💬 Message ${firstName}</button>
                <button class="dropdown-item share-btn" role="menuitem">🔗 Share</button>
                <button class="dropdown-item report-btn" role="menuitem"
                    data-content-id="${postId}" data-content-type="post"
                    data-content-author-email="${authorEmail}">🚩 Report</button>`;
        }
        dropdown.innerHTML = html;
        const cached = _postCache.get(postId);
        if (cached) dropdown.dataset.pinned = cached.pinned ? '1' : '0';

        // Fix edge clipping
        requestAnimationFrame(() => {
            const rect = dropdown.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                dropdown.style.right = 'auto';
                dropdown.style.left  = '0';
            }
        });
    }

    loadFeed();

    if (sentinel) {
        new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !isLoadingMore) {
                isLoadingMore = true;
                postLimit += 20;
                loadFeed(false);
            }
        }, { rootMargin: '200px' }).observe(sentinel);
    }

    // ── CREATE POST ──
    const generalForm = document.querySelector('#form-general-post form');
    generalForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!currentUser) return showToast('You must be signed in to post.', 'warn');

        const rawContent = (document.getElementById('post-content')?.value || '').trim();
        if (!rawContent && !_selectedFiles.length) {
            return showToast('Please add some content or media before posting.', 'warn');
        }

        const btn      = document.getElementById('submit-post-btn');
        const origHTML = btn?.innerHTML;
        if (btn) { btn.innerHTML = `<span class="spinner"></span> Publishing…`; btn.disabled = true; }

        try {
            let mediaItems = [];
            if (_selectedFiles.length) {
                showToast('Uploading media…', 'info', 10000);
                mediaItems = await uploadMediaFiles(_selectedFiles, 'posts', (pct) => {
                    if (btn) btn.innerHTML = `<span class="spinner"></span> Uploading… ${pct}%`;
                });
            }

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

            let community = document.getElementById('post-community')?.value || 'Global';
            if (community === 'Custom') {
                community = document.getElementById('post-community-custom')?.value.trim() || 'Global';
            }

            const tagsArray  = extractTags(rawContent);
            const firstImage = mediaItems.find(m => m.type === 'image');

            await addDocument('posts', {
                type:         'post',
                title:        (document.getElementById('post-title')?.value || '').trim(),
                content:      rawContent,
                category:     document.getElementById('post-category')?.value || 'General',
                community,
                tags:         tagsArray,
                poll:         pollData,
                mediaItems,
                imageSrc:     firstImage?.url || null,
                author:       currentUser.name,
                authorEmail:  currentUser.email,
                commentCount: 0,
                upvotedBy:    [],
                upvoteCount:  0,
                pinned:       false,
                edited:       false,
                timestamp:    Date.now(),
            });

            generalForm.reset();
            _selectedFiles.length = 0;
            const previewEl = document.getElementById('post-media-preview');
            if (previewEl) { previewEl.style.display = 'none'; previewEl.innerHTML = ''; }
            document.getElementById('post-community-custom')?.classList.add('hidden');
            pollContainer?.classList.add('hidden');
            document.getElementById('add-poll-btn')?.classList.remove('hidden');
            const charCtr = document.getElementById('post-char-counter');
            if (charCtr) charCtr.textContent = '0 / 5000';
            const tagPrev = document.getElementById('post-tag-preview');
            if (tagPrev) tagPrev.innerHTML = '';

            showToast('Post published! 🎉', 'success');
            document.querySelector('a[data-target="page-posts"]')?.click();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } catch (error) {
            console.error('Post creation failed:', error);
            showToast(`Failed to publish: ${error.message}`, 'error');
        } finally {
            if (btn) { btn.innerHTML = origHTML; btn.disabled = false; }
        }
    });

    // ── FEED INTERACTION DELEGATION ──
    // Named handler so we can attach it to all feed containers
    // (bookmarked-posts-feed and my-posts-feed share the same post card markup)
    const handleFeedClick = async (e) => {
        const postCard = e.target.closest('.post-card');
        if (!postCard || postCard.classList.contains('post-card--skeleton')) return;
        const postId  = postCard.dataset.postId;
        if (!postId) return;
        const postRef = doc(db, 'posts', postId);

        // Helper: close all open dropdowns (handles both class systems)
        const closeAllDropdowns = () => {
            document.querySelectorAll('.post-options-dropdown.open').forEach(d => d.classList.remove('open'));
            document.querySelectorAll('.post-options-dropdown:not(.hidden)').forEach(d => {
                if (d.innerHTML.trim()) d.classList.add('hidden');
            });
        };
        const closeDropdown = (card) => {
            const dd = card?.querySelector('.post-options-dropdown');
            if (!dd) return;
            dd.classList.remove('open');
            dd.classList.add('hidden');
        };

        // Handle both class names: post-options-trigger (posts.js CSS) and
        // post-options-btn (templates.js — used by the imported createPostCardHTML)
        if (e.target.closest('.post-options-trigger') || e.target.closest('.post-options-btn')) {
            e.stopPropagation(); // prevent initPostOptionsDropdowns (templates.js) from double-handling (would open then immediately close)
            const dropdown = postCard.querySelector('.post-options-dropdown');
            // Detect open state for both systems
            const isOpen = dropdown?.classList.contains('open') || 
                           (dropdown && !dropdown.classList.contains('hidden') && dropdown.innerHTML.trim() !== '');
            closeAllDropdowns();
            if (dropdown && !isOpen) {
                _buildDropdown(dropdown);
                dropdown.classList.add('open');
                dropdown.classList.remove('hidden');
                const close = () => closeDropdown(postCard);
                setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
            }
            return;
        }

        if (e.target.closest('.edit-post-btn')) {
            closeDropdown(postCard);
            if (!currentUser) return;
            openEditModal(postId);
            return;
        }

        if (e.target.closest('.delete-post-btn')) {
            if (!currentUser) return;
            closeDropdown(postCard);
            const post    = _postCache.get(postId);
            const isAdmin = currentUser.role === 'admin';
            if (post && post.authorEmail !== currentUser.email && !isAdmin) {
                return showToast('You can only delete your own posts.', 'warn');
            }
            if (!confirm('Permanently delete this post? This cannot be undone.')) return;
            const btn = e.target.closest('.delete-post-btn');
            btn.textContent = 'Deleting…'; btn.disabled = true;
            try {
                await deleteDoc(doc(db, 'posts', postId));
                postCard.style.transition = 'opacity 0.35s, transform 0.35s';
                postCard.style.opacity    = '0';
                postCard.style.transform  = 'scale(0.96)';
                setTimeout(() => postCard.remove(), 360);
                showToast('Post deleted.', 'success');
            } catch (err) {
                showToast(`Delete failed: ${err.message}`, 'error');
                btn.textContent = '🗑️ Delete post'; btn.disabled = false;
            }
            return;
        }

        if (e.target.closest('.pin-post-btn')) {
            closeDropdown(postCard);
            if (currentUser?.role !== 'admin') return showToast('Admins only.', 'warn');
            const post     = _postCache.get(postId);
            const isPinned = !!post?.pinned;
            try {
                await updateDoc(doc(db, 'posts', postId), { pinned: !isPinned });
                showToast(isPinned ? 'Post unpinned.' : 'Post pinned.', 'success');
            } catch { showToast('Failed to update pin.', 'error'); }
            return;
        }

        if (e.target.closest('.report-btn')) {
            e.stopPropagation();
            closeDropdown(postCard);
            if (!currentUser) return showToast('Sign in to report content.', 'warn');
            const reportBtn = e.target.closest('.report-btn');
            window.openReportModal?.(reportBtn.dataset.contentId || postId, 'post', postId, null, reportBtn.dataset.contentAuthorEmail || '');
            return;
        }

        if (e.target.closest('.message-author-btn')) {
            if (!currentUser) return showToast('Sign in to message.', 'warn');
            const btn = e.target.closest('.message-author-btn');
            document.querySelector('a[data-target="page-chat"]')?.click();
            window.startDirectChat?.(btn.dataset.email, btn.dataset.name);
            return;
        }

        if (e.target.closest('.share-btn')) {
            closeDropdown(postCard);
            const url = `${location.origin}${location.pathname}?post=${postId}`;
            if (navigator.share) {
                navigator.share({ title: _postCache.get(postId)?.title || 'Check this post', url });
            } else {
                navigator.clipboard.writeText(url).then(() => showToast('Link copied!', 'success'));
            }
            return;
        }

        if (e.target.closest('.upvote-btn')) {
            if (!currentUser) return showToast('Sign in to upvote.', 'warn');
            const btn     = e.target.closest('.upvote-btn');
            const counter = btn.querySelector('.upvote-count');
            const current = parseInt(counter?.textContent || '0', 10);

            // Detect voted state from either card type:
            //   renderPost()         → action-btn--active
            //   createPostCardHTML() → bg-indigo-50 / aria-pressed="true"
            const isVoted = btn.classList.contains('action-btn--active') ||
                            btn.getAttribute('aria-pressed') === 'true' ||
                            btn.classList.contains('bg-indigo-50');

            // Update posts.js-style classes
            btn.classList.toggle('action-btn--active', !isVoted);
            // Update templates.js-style classes
            if (!isVoted) {
                btn.classList.add('bg-indigo-50', 'text-indigo-600', 'border-indigo-200',
                    'dark:bg-indigo-900/30', 'dark:text-indigo-400', 'dark:border-indigo-800');
                btn.classList.remove('text-gray-500', 'dark:text-gray-400', 'border-transparent');
                const svg = btn.querySelector('svg');
                if (svg) svg.setAttribute('fill', 'currentColor');
            } else {
                btn.classList.remove('bg-indigo-50', 'text-indigo-600', 'border-indigo-200',
                    'dark:bg-indigo-900/30', 'dark:text-indigo-400', 'dark:border-indigo-800');
                btn.classList.add('text-gray-500', 'dark:text-gray-400', 'border-transparent');
                const svg = btn.querySelector('svg');
                if (svg) svg.setAttribute('fill', 'none');
            }

            btn.setAttribute('aria-pressed', String(!isVoted));
            if (counter) counter.textContent = String(isVoted ? Math.max(0, current - 1) : current + 1);
            btn.animate(
                [{ transform: 'scale(1)' }, { transform: 'scale(1.25)' }, { transform: 'scale(1)' }],
                { duration: 280, easing: 'ease' }
            );
            try {
                await updateDoc(postRef, {
                    upvotedBy:   isVoted ? arrayRemove(currentUser.email) : arrayUnion(currentUser.email),
                    upvoteCount: isVoted ? Math.max(0, current - 1) : current + 1,
                });
            } catch {
                // Rollback
                btn.classList.toggle('action-btn--active', isVoted);
                if (isVoted) {
                    btn.classList.add('bg-indigo-50', 'text-indigo-600', 'border-indigo-200');
                } else {
                    btn.classList.remove('bg-indigo-50', 'text-indigo-600', 'border-indigo-200');
                    btn.classList.add('text-gray-500', 'dark:text-gray-400', 'border-transparent');
                }
                btn.setAttribute('aria-pressed', String(isVoted));
                if (counter) counter.textContent = String(current);
                showToast('Upvote failed. Try again.', 'error');
            }
            return;
        }

        if (e.target.closest('.bookmark-btn')) {
            if (!currentUser) return showToast('Sign in to bookmark.', 'warn');
            const btn     = e.target.closest('.bookmark-btn');
            const userRef = doc(db, 'users', currentUser.email);

            // Detect saved state from either card type:
            //   renderPost()         → action-btn--saved class
            //   createPostCardHTML() → aria-pressed="true" or text-amber-500 class
            const isSaved = btn.classList.contains('action-btn--saved') ||
                            btn.getAttribute('aria-pressed') === 'true' ||
                            btn.classList.contains('text-amber-500');

            // Update UI — posts.js style (action-btn--saved)
            btn.classList.toggle('action-btn--saved', !isSaved);

            // Update UI — templates.js style (amber color classes)
            if (!isSaved) {
                btn.classList.add('text-amber-500', 'bg-amber-50', 'dark:bg-amber-900/20');
                btn.classList.remove('text-gray-400', 'dark:text-gray-500',
                    'hover:text-amber-500', 'dark:hover:text-amber-400',
                    'hover:bg-gray-100', 'dark:hover:bg-zinc-800');
                // Fill the SVG bookmark icon
                const svgPath = btn.querySelector('svg');
                if (svgPath) svgPath.setAttribute('fill', 'currentColor');
            } else {
                btn.classList.remove('text-amber-500', 'bg-amber-50', 'dark:bg-amber-900/20');
                btn.classList.add('text-gray-400', 'dark:text-gray-500',
                    'hover:text-amber-500', 'dark:hover:text-amber-400',
                    'hover:bg-gray-100', 'dark:hover:bg-zinc-800');
                const svgPath = btn.querySelector('svg');
                if (svgPath) svgPath.setAttribute('fill', 'none');
            }

            btn.setAttribute('aria-pressed', String(!isSaved));
            btn.title = isSaved ? 'Bookmark' : 'Remove bookmark';

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
                await updateDoc(userRef, { savedPosts: isSaved ? arrayRemove(postId) : arrayUnion(postId) });
            } catch {
                // Rollback both style systems
                btn.classList.toggle('action-btn--saved', isSaved);
                if (isSaved) {
                    btn.classList.add('text-amber-500', 'bg-amber-50', 'dark:bg-amber-900/20');
                    btn.classList.remove('text-gray-400', 'dark:text-gray-500');
                } else {
                    btn.classList.remove('text-amber-500', 'bg-amber-50', 'dark:bg-amber-900/20');
                    btn.classList.add('text-gray-400', 'dark:text-gray-500');
                }
                showToast('Bookmark failed.', 'error');
            }
            return;
        }

        if (e.target.closest('.hashtag-link')) {
            const tag         = e.target.closest('.hashtag-link').dataset.tag;
            const filterInput = document.getElementById('hashtag-filter-input');
            if (filterInput) { filterInput.value = '#' + tag; loadFeed(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
            return;
        }

        if (e.target.closest('.view-comments-btn')) {
            window.openComments?.(postId);
            return;
        }

        // poll-option = posts.js renderPost cards; poll-vote-btn = templates.js createPostCardHTML cards
        const pollOption = e.target.closest('.poll-option');
        if (pollOption) {
            const idx = parseInt(pollOption.dataset.optionIndex, 10);
            if (!isNaN(idx)) await handlePollVote(postId, idx);
            return;
        }

        // poll-vote-btn is used by createPostCardHTML (bookmarks / my-posts feed)
        const pollVoteBtn = e.target.closest('.poll-vote-btn');
        if (pollVoteBtn) {
            if (!currentUser) return showToast('Sign in to vote.', 'warn');
            const optIdx = parseInt(pollVoteBtn.dataset.pollIndex, 10);
            if (!isNaN(optIdx)) await handlePollVote(postId, optIdx);
            return;
        }

        // ── RSVP buttons (going / maybe / not-going) ──────────────────────
        // These are rendered in both renderPost() and createPostCardHTML().
        // eventsAndPolls.js has its own handler but posts.js must also handle
        // them so they work regardless of which module's listener fires first.
        // Each RSVP button has exactly one of these classes (they don't overlap)
        const rsvpGoing    = e.target.closest('.rsvp-going');
        const rsvpMaybe    = !rsvpGoing && e.target.closest('.rsvp-maybe');
        const rsvpNotGoing = !rsvpGoing && !rsvpMaybe && e.target.closest('.rsvp-not-going');
        const rsvpBtn      = rsvpGoing || rsvpMaybe || rsvpNotGoing;

        if (rsvpBtn) {
            if (!currentUser) return showToast('Sign in to RSVP.', 'warn');
            if (rsvpBtn.disabled) return;
            // Stop the eventsAndPolls.js handler (also attached to these feeds)
            // from firing its own partial RSVP logic on the same click.
            e.stopImmediatePropagation();
            rsvpBtn.disabled = true;

            const rsvpKey  = rsvpGoing ? 'going' : rsvpMaybe ? 'maybe' : 'notGoing';
            const isAlready = rsvpBtn.classList.contains('rsvp-active');

            // ── Visual RSVP state helper ──────────────────────────────────────
            // Both renderPost() (posts.js) and createPostCardHTML() (templates.js)
            // bake color classes directly into each button at render time, so toggling
            // rsvp-active alone doesn't change colors. We must swap the full class sets.
            //
            // Active classes per button type:
            //   going    → bg-emerald-500 text-white border-emerald-500 shadow-md
            //   maybe    → bg-amber-400   text-white border-amber-400   shadow-md
            //   not-going→ bg-red-400     text-white border-red-400     shadow-md
            //
            // Inactive classes (shared by both card types, with dark variants):
            //   bg-white dark:bg-zinc-800 border-gray-300 dark:border-zinc-600
            //   text-gray-600 dark:text-gray-400
            const INACTIVE_ADD    = ['bg-white', 'dark:bg-zinc-800', 'border-gray-300',
                                     'dark:border-zinc-600', 'text-gray-600', 'dark:text-gray-400'];
            const INACTIVE_REMOVE = ['text-white', 'shadow-md', 'rsvp-active',
                                     'bg-emerald-500', 'border-emerald-500',
                                     'bg-amber-400',   'border-amber-400',
                                     'bg-red-400',     'border-red-400'];

            const ACTIVE_CLASSES = {
                going:    ['bg-emerald-500', 'border-emerald-500', 'text-white', 'shadow-md', 'rsvp-active'],
                maybe:    ['bg-amber-400',   'border-amber-400',   'text-white', 'shadow-md', 'rsvp-active'],
                notGoing: ['bg-red-400',     'border-red-400',     'text-white', 'shadow-md', 'rsvp-active'],
            };

            function _setRsvpActive(btn, key) {
                btn.classList.remove(...INACTIVE_ADD);
                btn.classList.add(...ACTIVE_CLASSES[key]);
            }
            function _setRsvpInactive(btn) {
                btn.classList.remove(...INACTIVE_REMOVE);
                btn.classList.add(...INACTIVE_ADD);
            }

            // Optimistic UI update — reset all to inactive then activate chosen one
            const goingBtn    = postCard.querySelector('.rsvp-going');
            const maybeBtn    = postCard.querySelector('.rsvp-maybe');
            const notGoingBtn = postCard.querySelector('.rsvp-not-going');
            [goingBtn, maybeBtn, notGoingBtn].forEach(b => { if (b) _setRsvpInactive(b); });
            if (!isAlready) _setRsvpActive(rsvpBtn, rsvpKey);

            try {
                const updatePayload = {
                    'attendance.going':    arrayRemove(currentUser.email),
                    'attendance.maybe':    arrayRemove(currentUser.email),
                    'attendance.notGoing': arrayRemove(currentUser.email),
                };
                if (!isAlready) updatePayload[`attendance.${rsvpKey}`] = arrayUnion(currentUser.email);

                await updateDoc(postRef, updatePayload);

                // Refresh attendance counts from Firestore
                const snap = await getDoc(postRef);
                if (snap.exists()) {
                    const att = snap.data().attendance || {};
                    const goingEl    = postCard.querySelector('.rsvp-going-count');
                    const maybeEl    = postCard.querySelector('.rsvp-maybe-count');
                    const notGoingEl = postCard.querySelector('.rsvp-not-going-count');
                    if (goingEl)    goingEl.textContent    = att.going?.length    ?? 0;
                    if (maybeEl)    maybeEl.textContent    = att.maybe?.length    ?? 0;
                    if (notGoingEl) notGoingEl.textContent = att.notGoing?.length ?? 0;
                }
            } catch (err) {
                console.error('RSVP error:', err);
                // Rollback optimistic UI
                [goingBtn, maybeBtn, notGoingBtn].forEach(b => { if (b) _setRsvpInactive(b); });
                if (isAlready) _setRsvpActive(rsvpBtn, rsvpKey);
                showToast('RSVP failed. Please try again.', 'error');
            } finally {
                rsvpBtn.disabled = false;
            }
            return;
        }

        if (e.target.closest('.ai-summarize-btn')) {
            if (!currentUser) return showToast('Sign in to use AI features.', 'warn');
            const postData = _postCache.get(postId);
            if (!postData) return;

            // Support both card types:
            //   renderPost()           → .ai-summary-box (posts.js local function)
            //   createPostCardHTML()   → .ai-summary-container + .ai-summary-text (templates.js)
            const templatesContainer = postCard.querySelector('.ai-summary-container');
            if (templatesContainer) {
                await handleAiSummarize(postCard, postData);
            } else {
                await aiSummarizePost(postCard, postData);
            }
            return;
        }
    };

    // Attach the same handler to all three feed containers so that
    // upvote / comment / share / AI-summarize / 3-dots all work in
    // Bookmarked Posts and My Posts as well as the main feed.
    feed?.addEventListener('click', handleFeedClick);
    document.getElementById('bookmarked-posts-feed')?.addEventListener('click', handleFeedClick);
    document.getElementById('my-posts-feed')?.addEventListener('click', handleFeedClick);

    // Global report delegation
    document.addEventListener('click', (e) => {
        const reportBtn = e.target.closest('.report-btn');
        // Skip if already handled by a feed's own listener
        if (!reportBtn || reportBtn.closest('#posts-feed') || reportBtn.closest('#bookmarked-posts-feed') || reportBtn.closest('#my-posts-feed')) return;
        e.stopPropagation();
        if (!currentUser) return showToast('Sign in to report content.', 'warn');
        const contentId    = reportBtn.dataset.contentId || '';
        const contentType  = reportBtn.dataset.contentType || 'post';
        const parentPostEl = reportBtn.closest('[data-post-id]');
        const commentsPage = document.getElementById('page-comments');
        const postId       = parentPostEl?.dataset.postId || commentsPage?.dataset.currentPostId || contentId;
        const replyId      = reportBtn.dataset.replyId || null;
        const authorEmail3 = reportBtn.dataset.contentAuthorEmail || '';
        window.openReportModal?.(contentId, contentType, postId, replyId, authorEmail3);
    });

    function startCacheListener() {
        if (cacheUnsub) cacheUnsub();
        cacheUnsub = onSnapshot(
            query(collection(db, 'posts'), orderBy('timestamp', 'desc'), limit(100)),
            (snap) => snap.forEach(d => _postCache.set(d.id, { id: d.id, ...d.data() }))
        );
    }

    // FIX: gate both listeners behind confirmed Firebase Auth state.
    // Previously loadFeed() and startCacheListener() fired immediately, before
    // the Firebase JWT was validated server-side → permission-denied on every
    // snapshot. onAuthStateChanged is the canonical signal the token is ready.
    const _unsubPostsAuth = onAuthStateChanged(auth, firebaseUser => {
        _unsubPostsAuth(); // one-shot
        if (firebaseUser) {
            loadFeed();
            startCacheListener();
        }
    });

    // ── My Posts — lazy load when the page is visited ─────────────────────
    onPageVisit('page-my-posts', async () => {
        if (!currentUser) return;
        const feed = document.getElementById('my-posts-feed');
        if (!feed) return;
        feed.innerHTML = skeletonHTML(3);
        try {
            const q = query(
                collection(db, 'posts'),
                where('authorEmail', '==', currentUser.email),
                orderBy('timestamp', 'desc')
            );
            const snap = await getDocs(q);
            if (snap.empty) {
                feed.innerHTML = `<div class="empty-feed"><p class="empty-feed-title">You haven't posted anything yet.</p></div>`;
            } else {
                feed.innerHTML = '';
                snap.forEach(d => {
                    const post = { id: d.id, ...d.data() };
                    _postCache.set(post.id, post);
                    feed.innerHTML += createPostCardHTML(post, currentUser);
                });
            }
        } catch (err) {
            console.error('[My Posts] load error:', err);
            feed.innerHTML = `<div class="empty-feed"><p class="empty-feed-title" style="color:#ef4444">Failed to load your posts. Please try again.</p></div>`;
        }
    });

    // ── Bookmarked Posts — lazy load when the page is visited ─────────────
    onPageVisit('page-bookmarked-posts', async () => {
        if (!currentUser) return;
        const feed = document.getElementById('bookmarked-posts-feed');
        if (!feed) return;
        feed.innerHTML = skeletonHTML(3);

        const savedIds = currentUser.savedPosts || [];
        if (savedIds.length === 0) {
            feed.innerHTML = `<div class="empty-feed"><p class="empty-feed-title">No bookmarked posts yet.</p><p class="empty-feed-sub">Tap the bookmark icon on any post to save it here.</p></div>`;
            return;
        }

        try {
            // Firestore 'in' query supports up to 30 items; batch if needed
            const BATCH = 30;
            const posts = [];
            for (let i = 0; i < savedIds.length; i += BATCH) {
                const chunk = savedIds.slice(i, i + BATCH);
                const q = query(collection(db, 'posts'), where('__name__', 'in', chunk));
                const snap = await getDocs(q);
                snap.forEach(d => posts.push({ id: d.id, ...d.data() }));
            }
            // Sort by bookmark order (most recently bookmarked first)
            posts.sort((a, b) => savedIds.indexOf(a.id) - savedIds.indexOf(b.id));
            if (posts.length === 0) {
                feed.innerHTML = `<div class="empty-feed"><p class="empty-feed-title">No bookmarked posts found.</p></div>`;
            } else {
                feed.innerHTML = '';
                posts.forEach(p => {
                    // Populate cache so AI summarize, pin, and other cache-
                    // dependent actions work correctly in the bookmarked feed.
                    _postCache.set(p.id, p);
                    feed.innerHTML += createPostCardHTML(p, currentUser);
                });
            }
        } catch (err) {
            console.error('[Bookmarked Posts] load error:', err);
            feed.innerHTML = `<div class="empty-feed"><p class="empty-feed-title" style="color:#ef4444">Failed to load bookmarked posts. Please try again.</p></div>`;
        }
    });
}

// ─── Global CSS ───────────────────────────────────────────────────────────────
function _injectGlobalStyles() {
    if (document.getElementById('posts-module-styles')) return;
    const style = document.createElement('style');
    style.id    = 'posts-module-styles';
    style.textContent = `
        /* ── Global resets ─────────────────── */
        *, *::before, *::after { box-sizing: border-box; }
        body { overflow-x: hidden; }
        .hidden { display: none !important; }

        /* ── Variables ─────────────────────── */
        :root {
            --sk: #f0f0f0;
            --accent: #6366f1;
            --accent-light: #eef2ff;
            --accent-dark: #4f46e5;
            --card-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04);
            --card-shadow-hover: 0 8px 32px rgba(99,102,241,0.12), 0 2px 8px rgba(0,0,0,0.08);
        }
        body.dark-mode {
            --sk: #27272a;
            --accent-light: #1e1b4b;
            --card-shadow: 0 1px 3px rgba(0,0,0,0.3), 0 4px 16px rgba(0,0,0,0.2);
            --card-shadow-hover: 0 8px 32px rgba(99,102,241,0.2), 0 2px 8px rgba(0,0,0,0.3);
        }

        /* ── Keyframes ─────────────────────── */
        @keyframes shimmer { to { background-position: -200% 0; } }
        @keyframes fadeIn  { from { opacity:0; } to { opacity:1; } }
        @keyframes spin    { to { transform: rotate(360deg); } }
        @keyframes cardEntrance {
            from { opacity:0; transform:translateY(20px) scale(0.98); }
            to   { opacity:1; transform:translateY(0) scale(1); }
        }
        @keyframes dropIn {
            from { opacity:0; transform:translateY(-8px) scale(0.96); }
            to   { opacity:1; transform:translateY(0) scale(1); }
        }
        @keyframes popIn {
            0%   { transform:scale(0.8); opacity:0; }
            70%  { transform:scale(1.1); }
            100% { transform:scale(1);   opacity:1; }
        }
        @keyframes slideUp {
            from { opacity:0; transform:translateY(8px); }
            to   { opacity:1; transform:translateY(0); }
        }
        @keyframes orbFloat {
            0%   { transform: translate(0, 0) scale(1); }
            33%  { transform: translate(40px, 30px) scale(1.06); }
            66%  { transform: translate(-20px, 50px) scale(0.96); }
            100% { transform: translate(30px, -20px) scale(1.04); }
        }

        /* ── Background orbs ───────────────── */
        body::before, body::after {
            content: '';
            position: fixed;
            border-radius: 50%;
            pointer-events: none;
            z-index: 0;
            filter: blur(80px);
            opacity: 0.045;
            animation: orbFloat 18s ease-in-out infinite alternate;
        }
        body::before {
            width: 520px; height: 520px;
            background: #6366f1;
            top: -120px; left: -120px;
            animation-duration: 18s;
        }
        body::after {
            width: 420px; height: 420px;
            background: #8b5cf6;
            bottom: -100px; right: -80px;
            animation-duration: 22s;
            animation-direction: alternate-reverse;
        }
        body.dark-mode::before { opacity: 0.07; }
        body.dark-mode::after  { opacity: 0.07; }
        .bg-particle {
            position: fixed;
            border-radius: 50%;
            pointer-events: none;
            z-index: 0;
            opacity: 0.04;
            filter: blur(60px);
            animation: orbFloat 28s ease-in-out infinite alternate;
        }
        body.dark-mode .bg-particle { opacity: 0.08; }

        /* ── Feed layout ───────────────────── */
        #posts-feed {
            max-width: 680px;
            margin: 0 auto;
            padding: 0 12px 80px;
        }

        /* ── Skeletons ─────────────────────── */
        .post-card--skeleton { pointer-events: none; }
        .post-card--skeleton .skeleton-block,
        .post-card--skeleton .skeleton-circle {
            background: linear-gradient(90deg, var(--sk) 25%, #e8e8e8 50%, var(--sk) 75%);
            background-size: 200% 100%;
            animation: shimmer 1.4s infinite;
        }
        body.dark-mode .post-card--skeleton .skeleton-block,
        body.dark-mode .post-card--skeleton .skeleton-circle {
            background: linear-gradient(90deg, var(--sk) 25%, #3f3f46 50%, var(--sk) 75%);
            background-size: 200% 100%;
        }

        /* ── Post card ─────────────────────── */
        .post-card {
            background: var(--surface-2, #fff);
            border: 0.5px solid var(--border, #ebebeb);
            border-radius: 16px;
            padding: 20px 22px;
            margin-bottom: 20px;
            box-shadow: var(--card-shadow);
            transition: box-shadow 0.3s ease, border-color 0.3s ease, transform 0.2s ease;
            animation: cardEntrance 0.4s cubic-bezier(0.34,1.2,0.64,1) both;
            width: 100%;
            box-sizing: border-box;
            position: relative;
        }
        .post-card:hover {
            box-shadow: var(--card-shadow-hover);
            border-color: rgba(99,102,241,0.25);
            transform: translateY(-1px);
        }
        .post-card--pinned {
            border-left: 3px solid #6366f1;
        }
        /* Broadcast cards override the pinned indigo border with sky blue */
        .post-card--broadcast {
            border-left: 3px solid #38bdf8 !important;
            background: linear-gradient(135deg, rgba(56,189,248,0.04) 0%, transparent 60%);
        }
        .broadcast-feed-banner {
            display: inline-flex; align-items: center; gap: 5px;
            padding: 2px 10px; border-radius: 20px; margin-bottom: 8px;
            background: rgba(56,189,248,0.12);
            border: 1px solid rgba(56,189,248,0.25);
        }
        .broadcast-feed-banner span {
            font-size: 10px; font-weight: 800; color: #38bdf8;
            text-transform: uppercase; letter-spacing: 0.08em;
        }

        /* ── Post header ───────────────────── */
        .post-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 12px;
            gap: 8px;
        }
        .post-author-info { display: flex; align-items: center; gap: 12px; }
        .author-avatar {
            width: 42px; height: 42px; border-radius: 50%;
            background: linear-gradient(135deg, #6366f1, #8b5cf6);
            color: #fff; font-weight: 500; font-size: 16px; line-height: 1;
            display: flex; align-items: center; justify-content: center;
            flex-shrink: 0; user-select: none;
            box-shadow: 0 2px 8px rgba(99,102,241,0.35);
            transition: transform 0.2s ease, box-shadow 0.2s ease;
        }
        .author-avatar:hover {
            transform: scale(1.08);
            box-shadow: 0 4px 14px rgba(99,102,241,0.45);
        }
        .post-author-name {
            font-size: 15px; font-weight: 500;
            color: var(--text-primary, #111); display: block;
        }
        .post-meta-row {
            display: flex; align-items: center;
            flex-wrap: wrap; column-gap: 4px; row-gap: 4px;
            margin-top: 3px;
        }
        .post-time         { font-size: 12px; color: var(--text-muted, #9ca3af); }
        .post-edited-badge {
            font-size: 11px; color: var(--text-muted, #6b7280);
            background: var(--surface-0, #f3f4f6);
            padding: 1px 6px; border-radius: 4px;
        }
        .post-separator {
            display: inline-block;
            width: 3px; height: 3px; border-radius: 50%;
            background: var(--border-strong, #d1d5db);
            vertical-align: middle;
        }
        .post-community-chip {
            font-size: 12px; font-weight: 500;
            color: var(--text-accent, #6366f1);
            background: var(--bg-accent, #eef2ff);
            padding: 2px 8px; border-radius: 20px;
            transition: background 0.15s;
        }
        .post-community-chip:hover { background: #e0e7ff; }
        .post-category-chip {
            font-size: 12px; color: var(--text-secondary, #6b7280);
            background: var(--surface-0, #f9fafb);
            padding: 2px 8px; border-radius: 20px;
        }
        .post-reading-time { font-size: 12px; color: var(--text-muted, #9ca3af); }

        /* ── Options dropdown ──────────────── */
        .post-options-trigger {
            background: none; border: none;
            color: var(--text-muted, #9ca3af);
            cursor: pointer; padding: 6px; border-radius: 8px;
            display: flex; align-items: center;
            transition: background 0.15s, color 0.15s, transform 0.15s;
        }
        .post-options-trigger:hover {
            background: var(--surface-0, #f3f4f6);
            color: var(--text-primary, #374151);
            transform: rotate(90deg);
        }
        .post-options-dropdown {
            display: none; position: absolute; right: 0; top: 36px;
            background: var(--surface-2, #fff);
            border: 0.5px solid var(--border, #e5e7eb);
            border-radius: 12px;
            box-shadow: 0 16px 48px rgba(0,0,0,0.12), 0 4px 12px rgba(0,0,0,0.06);
            padding: 6px; z-index: 100;
            min-width: 168px; max-width: calc(100vw - 32px);
        }
        .post-options-dropdown.open {
            display: block;
            animation: dropIn 0.2s cubic-bezier(0.34,1.2,0.64,1);
        }
        .dropdown-item {
            display: block; width: 100%; text-align: left;
            background: none; border: none;
            font-size: 14px; font-weight: 400;
            color: var(--text-primary, #374151);
            padding: 9px 12px; border-radius: 8px;
            cursor: pointer;
            transition: background 0.12s, transform 0.1s;
        }
        .dropdown-item:hover { background: var(--surface-0, #f3f4f6); transform: translateX(2px); }

        /* ── Post content ──────────────────── */
        .post-title {
            font-size: 18px; font-weight: 500;
            color: var(--text-primary, #111);
            margin: 0 0 8px; line-height: 1.4;
            letter-spacing: -0.01em;
        }
        .post-content {
            font-size: 15px;
            color: var(--text-secondary, #374151);
            line-height: 1.75; margin-bottom: 14px;
            word-break: break-word;
        }

        /* ── Single image ──────────────────── */
        .post-image {
            width: 100%;
            max-height: clamp(200px, 40vw, 300px);
            object-fit: cover;
            border-radius: 12px;
            display: block;
            margin: 0 0 14px;
        }

        /* ── Carousel ──────────────────────── */
        .post-carousel {
            position: relative; margin: 0 0 14px;
            border-radius: 12px; overflow: hidden;
            background: #0a0a14;
            height: clamp(200px, 40vw, 300px);
        }
        .carousel-track {
            display: flex; height: 100%;
            transition: transform 0.42s cubic-bezier(0.4,0,0.2,1);
            will-change: transform;
        }
        .carousel-slide {
            flex: 0 0 100%; height: 100%;
            position: relative; overflow: hidden;
        }
        .carousel-slide img {
            width: 100%; height: 100%; object-fit: cover; display: block;
            transition: transform 0.5s ease;
        }
        .carousel-slide:hover img { transform: scale(1.02); }
        .carousel-arrow {
            position: absolute; top: 50%; transform: translateY(-50%);
            width: 38px; height: 38px; border-radius: 50%;
            border: none; background: rgba(0,0,0,0.5);
            color: #fff; font-size: 20px; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            z-index: 10; opacity: 0;
            transition: background 0.2s, opacity 0.2s, transform 0.2s;
            backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
        }
        .post-carousel:hover .carousel-arrow { opacity: 1; }
        .carousel-prev { left: 10px; }
        .carousel-next { right: 10px; }
        .carousel-prev:hover { background: rgba(0,0,0,0.75); transform: translateY(-50%) scale(1.1); }
        .carousel-next:hover { background: rgba(0,0,0,0.75); transform: translateY(-50%) scale(1.1); }
        @media (hover: none) {
            .carousel-arrow { opacity: 0.65 !important; }
            .vid-controls   { opacity: 1 !important; }
        }
        .carousel-dots {
            position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%);
            display: flex; gap: 5px; z-index: 10;
        }
        .carousel-dot {
            width: 6px; height: 6px; border-radius: 50%;
            background: rgba(255,255,255,0.4); cursor: pointer;
            transition: background 0.25s, transform 0.25s, width 0.25s;
        }
        .carousel-dot--active { background: #fff; transform: scale(1.2); width: 18px; border-radius: 3px; }
        .carousel-counter {
            position: absolute; top: 12px; right: 12px;
            font-size: 12px; color: rgba(255,255,255,0.9);
            background: rgba(0,0,0,0.45); padding: 3px 10px;
            border-radius: 20px; z-index: 10; font-weight: 500;
            backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
            letter-spacing: 0.02em;
        }
        .carousel-slide .vid-wrapper { min-height: unset; height: 100%; }

        /* ── Standalone video ──────────────── */
        .vid-wrapper:not(.carousel-slide .vid-wrapper):not(.vid-wrapper--lightbox) {
            aspect-ratio: 16 / 9;
            min-height: unset;
        }

        /* ── Video Player ──────────────────── */
        .vid-wrapper {
            position: relative; width: 100%; height: 100%;
            background: #090912; min-height: 200px;
        }
        .vid-wrapper video {
            position: absolute; inset: 0; width: 100%; height: 100%;
            object-fit: contain;
        }
        .vid-overlay {
            position: absolute; inset: 0; z-index: 2;
            display: flex; align-items: center; justify-content: center;
            background: rgba(0,0,0,0.12);
            transition: background 0.25s;
        }
        .vid-overlay--paused { background: rgba(0,0,0,0.38); }
        .vid-overlay:not(.vid-overlay--paused) .vid-play-btn { opacity: 0; pointer-events: none; }
        .vid-overlay:hover .vid-play-btn { opacity: 1 !important; pointer-events: auto; }
        .vid-play-btn {
            width: 64px; height: 64px; border-radius: 50%;
            background: rgba(255,255,255,0.15);
            backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
            display: flex; align-items: center; justify-content: center;
            color: #fff; cursor: pointer;
            transition: transform 0.2s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s;
            border: 1.5px solid rgba(255,255,255,0.3);
            box-shadow: 0 4px 24px rgba(0,0,0,0.3);
        }
        .vid-play-btn:hover  { transform: scale(1.12); }
        .vid-play-btn:active { transform: scale(0.95); }
        .vid-icon-play, .vid-icon-pause,
        .vid-icon-unmuted, .vid-icon-muted { display: block; }
        .vid-controls {
            position: absolute; bottom: 0; left: 0; right: 0; z-index: 3;
            display: flex; align-items: center; gap: 6px; padding: 10px 12px;
            background: linear-gradient(transparent, rgba(0,0,0,0.75));
            opacity: 0; transition: opacity 0.25s;
        }
        .vid-wrapper:hover .vid-controls { opacity: 1; }
        .vid-ctrl-btn {
            background: none; border: none; color: #fff; cursor: pointer;
            padding: 4px; border-radius: 5px; display: flex; align-items: center;
            transition: background 0.15s, transform 0.15s;
        }
        .vid-ctrl-btn:hover { background: rgba(255,255,255,0.15); transform: scale(1.1); }
        .vid-progress-wrap { flex: 1; padding: 6px 0; cursor: pointer; }
        .vid-progress-bar {
            position: relative; height: 3px;
            background: rgba(255,255,255,0.25);
            border-radius: 99px; overflow: visible;
            transition: height 0.15s;
        }
        .vid-progress-wrap:hover .vid-progress-bar { height: 5px; }
        .vid-progress-fill { height: 100%; background: #fff; border-radius: 99px; width: 0; transition: width 0.1s linear; }
        .vid-progress-thumb {
            position: absolute; top: 50%; transform: translate(-50%,-50%);
            width: 13px; height: 13px; border-radius: 50%; background: #fff;
            left: 0; opacity: 0; transition: opacity 0.15s;
            box-shadow: 0 1px 4px rgba(0,0,0,0.4);
        }
        .vid-progress-wrap:hover .vid-progress-thumb { opacity: 1; }
        .vid-time {
            font-size: 11px; color: rgba(255,255,255,0.85);
            white-space: nowrap; font-variant-numeric: tabular-nums;
        }
        .vid-wrapper--lightbox { border-radius: 12px; overflow: hidden; background: #000; }
        .vid-wrapper--lightbox video { position: static; width: auto; height: auto; }

        /* ── Poll ──────────────────────────── */
        .poll-container { margin: 14px 0 16px; }
        .poll-question  { font-size: 13px; font-weight: 500; color: var(--text-secondary, #374151); margin: 0 0 10px; }
        .poll-option {
            display: flex; align-items: center; gap: 10px;
            width: 100%; padding: 10px 14px; margin-bottom: 8px;
            border: 0.5px solid var(--border, #e5e7eb); border-radius: 10px;
            background: var(--surface-2, #fff); cursor: pointer; text-align: left;
            transition: border-color 0.2s, background 0.2s, transform 0.15s;
        }
        .poll-option:hover       { border-color: #6366f1; background: var(--bg-accent, #f5f3ff); transform: translateX(2px); }
        .poll-option--voted      { border-color: #6366f1; background: var(--bg-accent, #eef2ff); }
        .poll-option-text        { font-size: 14px; color: var(--text-secondary, #374151); flex: 1; min-width: 0; }
        .poll-bar-track          { flex: 1; height: 5px; background: var(--border, #f3f4f6); border-radius: 99px; overflow: hidden; }
        .poll-bar                { height: 100%; background: #6366f1; border-radius: 99px; transition: width 0.6s cubic-bezier(0.4,0,0.2,1); }
        .poll-option--voted .poll-bar { background: #4f46e5; }
        .poll-pct                { font-size: 12px; font-weight: 500; color: #6366f1; min-width: 32px; text-align: right; }
        .poll-total              { font-size: 12px; color: var(--text-muted, #9ca3af); margin: 6px 0 0; }

        /* ── Tags ──────────────────────────── */
        .post-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 14px; }
        .hashtag-link {
            font-size: 12px; color: #6366f1; font-weight: 500;
            background: var(--bg-accent, #eef2ff); padding: 3px 10px;
            border-radius: 20px; border: none; cursor: pointer; margin: 0;
            transition: background 0.15s, transform 0.15s;
        }
        .hashtag-link:hover { background: #e0e7ff; transform: translateY(-1px); }

        /* ── Action bar ────────────────────── */
        .post-actions {
            display: flex; align-items: center; gap: 6px;
            padding-top: 12px; margin-top: 4px;
            border-top: 0.5px solid var(--border, #f0f0f0);
            flex-wrap: nowrap; overflow-x: auto;
            scrollbar-width: none;
            -webkit-mask: linear-gradient(to right, #000 85%, transparent 100%);
            mask: linear-gradient(to right, #000 85%, transparent 100%);
        }
        .post-actions::-webkit-scrollbar { display: none; }
        .action-btn {
            display: inline-flex; align-items: center; gap: 5px;
            padding: 6px 11px; border-radius: 8px; border: none;
            background: var(--surface-0, #f7f7f8);
            color: var(--text-secondary, #6b7280);
            font-size: 13px; cursor: pointer; font-weight: 400;
            transition: background 0.15s, color 0.15s, transform 0.15s;
            font-family: inherit; white-space: nowrap; flex-shrink: 0;
        }
        .action-btn:hover  { background: var(--surface-1, #efefef); color: var(--text-primary, #374151); transform: translateY(-1px); }
        .action-btn:active { transform: scale(0.95); }
        .action-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px #6366f1; }
        .action-btn--active       { background: var(--bg-accent, #eef2ff); color: #6366f1; }
        .action-btn--active:hover { background: #e0e7ff; }
        .action-btn--saved        { color: #f59e0b; background: #fffbeb; }
        .action-btn--saved:hover  { background: #fef3c7; }

        /* ── AI summary ────────────────────── */
        .ai-summary-box {
            margin-top: 14px; border-radius: 12px;
            border-left: 3px solid #6366f1; border-radius: 0 12px 12px 0;
            overflow: hidden;
            transition: max-height 0.5s cubic-bezier(0.4,0,0.2,1);
            background: var(--bg-accent, #f8f9ff);
        }
        body.dark-mode .ai-summary-box { background: #1e1b4b; }

        /* ── Dropzone ──────────────────────── */
        .post-media-dropzone {
            border: 1.5px dashed var(--border-strong, #e5e7eb);
            border-radius: 12px; padding: 24px 20px;
            display: flex; align-items: center; gap: 14px; cursor: pointer;
            transition: border-color 0.2s, background 0.2s, transform 0.2s;
        }
        .post-media-dropzone:hover,
        .post-media-dropzone.dragover {
            border-color: #6366f1;
            background: var(--bg-accent, #f5f3ff);
            transform: scale(1.01);
        }
        .post-media-preview-grid {
            grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
            gap: 10px; margin-top: 12px; overflow: visible; padding: 6px;
        }
        .media-preview-cell         { position: relative; border-radius: 8px; overflow: visible; }
        .media-preview-thumb        { width: 90px; height: 90px; object-fit: cover; border-radius: 8px; display: block; }
        .media-preview-thumb--video {
            width: 90px; height: 90px; background: #1e293b;
            border-radius: 8px; display: flex; align-items: center;
            justify-content: center; position: relative; overflow: hidden;
        }
        .media-preview-video-badge {
            position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%);
            background: rgba(0,0,0,0.7); color: #fff; font-size: 9px; font-weight: 600;
            padding: 2px 5px; border-radius: 3px; white-space: nowrap;
        }
        .media-preview-remove {
            position: absolute; top: -6px; right: -6px;
            width: 20px; height: 20px; border-radius: 50%;
            background: #ef4444; color: #fff; border: none;
            font-size: 11px; cursor: pointer; line-height: 1;
            display: flex; align-items: center; justify-content: center;
            z-index: 5; padding: 0; transition: transform 0.15s;
        }
        .media-preview-remove:hover { transform: scale(1.2); }
        .media-preview-label {
            font-size: 10px; color: var(--text-muted, #6b7280);
            text-align: center; margin-top: 3px;
            overflow: hidden; text-overflow: ellipsis;
            white-space: nowrap; width: 90px;
        }

        /* ── Lightbox ──────────────────────── */
        .lightbox-overlay {
            position: fixed; inset: 0; z-index: 10000;
            display: flex; align-items: center; justify-content: center;
            animation: fadeIn 0.2s ease;
        }
        .lightbox-backdrop {
            position: absolute; inset: 0; background: rgba(0,0,0,0.92);
            backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
        }
        .lightbox-container {
            position: relative; z-index: 1;
            display: flex; align-items: center; justify-content: center;
            animation: popIn 0.3s cubic-bezier(0.34,1.2,0.64,1);
        }
        .lightbox-media { display: flex; align-items: center; justify-content: center; }
        .lightbox-close {
            position: absolute; top: -52px; right: 0;
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(8px);
            border: 0.5px solid rgba(255,255,255,0.2);
            color: #fff; width: 42px; height: 42px; border-radius: 50%;
            font-size: 18px; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            transition: background 0.15s, transform 0.15s;
        }
        .lightbox-close:hover { background: rgba(255,255,255,0.2); transform: rotate(90deg) scale(1.1); }
        .lightbox-nav {
            position: fixed; top: 50%; transform: translateY(-50%);
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(8px);
            border: 0.5px solid rgba(255,255,255,0.15);
            color: #fff; width: 50px; height: 50px; border-radius: 50%;
            font-size: 26px; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            transition: background 0.15s, transform 0.2s;
        }
        .lightbox-nav:hover { background: rgba(255,255,255,0.2); transform: translateY(-50%) scale(1.08); }
        .lightbox-prev { left: 16px; }
        .lightbox-next { right: 16px; }
        .lightbox-counter {
            position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
            color: rgba(255,255,255,0.8); font-size: 13px; font-weight: 500;
            background: rgba(255,255,255,0.1); backdrop-filter: blur(8px);
            padding: 5px 14px; border-radius: 20px;
            border: 0.5px solid rgba(255,255,255,0.15);
        }

        /* ── Empty / error ─────────────────── */
        .empty-feed {
            text-align: center; padding: 64px 24px;
            background: var(--surface-2, #fff);
            border-radius: 16px;
            border: 0.5px dashed var(--border, #e5e7eb);
            animation: slideUp 0.4s ease;
        }
        .empty-feed-icon  { margin-bottom: 14px; display: flex; justify-content: center; }
        .empty-feed-title { font-size: 17px; font-weight: 500; color: var(--text-primary, #374151); margin: 0 0 6px; }
        .empty-feed-sub   { font-size: 14px; color: var(--text-muted, #9ca3af); margin: 0; }
        .feed-error       { text-align: center; padding: 32px; color: #ef4444; font-size: 15px; }

        /* ── Spinner ───────────────────────── */
        .spinner {
            display: inline-block; width: 14px; height: 14px;
            border: 2px solid rgba(255,255,255,0.35);
            border-top-color: #fff; border-radius: 50%;
            animation: spin 0.65s linear infinite;
            vertical-align: -2px;
        }

        /* ── Tag chip ──────────────────────── */
        .tag-chip {
            display: inline-block; font-size: 12px; font-weight: 500;
            color: #6366f1; background: var(--bg-accent, #eef2ff);
            padding: 2px 8px; border-radius: 20px;
        }

        /* ── Mobile ────────────────────────── */
        @media (max-width: 600px) {
            .post-card     { padding: 14px; border-radius: 12px; }
            .post-title    { font-size: 16px; }
            .post-content  { font-size: 14px; }
            .action-btn    { padding: 5px 9px; font-size: 12px; }
            .author-avatar { width: 36px; height: 36px; font-size: 14px; }
        }

        /* ── Dark mode ─────────────────────── */
        body.dark-mode .post-card           { background: #1c1c1f; border-color: #2a2a2e; }
        body.dark-mode .post-card:hover     { border-color: rgba(99,102,241,0.35); }
        body.dark-mode .post-card--pinned   { border-left-color: #6366f1; }
        body.dark-mode .post-author-name,
        body.dark-mode .post-title          { color: #f4f4f5; }
        body.dark-mode .post-content        { color: #a1a1aa; }
        body.dark-mode .post-options-dropdown {
            background: #1c1c1f; border-color: #27272a;
            box-shadow: 0 16px 48px rgba(0,0,0,0.5);
        }
        body.dark-mode .dropdown-item       { color: #d4d4d8; }
        body.dark-mode .dropdown-item:hover { background: #27272a; }
        body.dark-mode .action-btn          { background: #27272a; color: #a1a1aa; }
        body.dark-mode .action-btn:hover    { background: #3f3f46; color: #f4f4f5; }
        body.dark-mode .action-btn--active  { background: #312e81; color: #a5b4fc; }
        body.dark-mode .action-btn--saved   { color: #fbbf24; background: #422006; }
        body.dark-mode .poll-option         { background: #18181b; border-color: #3f3f46; }
        body.dark-mode .poll-option:hover   { background: #1e1b4b; border-color: #6366f1; }
        body.dark-mode .poll-option-text    { color: #d4d4d8; }
        body.dark-mode .poll-bar-track      { background: #27272a; }
        body.dark-mode .empty-feed          { background: #18181b; border-color: #27272a; }
        body.dark-mode .empty-feed-title    { color: #d4d4d8; }
        body.dark-mode .post-media-dropzone { border-color: #3f3f46; background: #18181b; }
        body.dark-mode .post-media-dropzone:hover { border-color: #6366f1; background: #1e1b4b; }
        body.dark-mode .post-actions        { border-top-color: #27272a; }
        body.dark-mode .hashtag-link        { background: #1e1b4b; color: #a5b4fc; }
        body.dark-mode .hashtag-link:hover  { background: #312e81; }
        body.dark-mode .tag-chip            { background: #1e1b4b; color: #a5b4fc; }
        body.dark-mode .post-community-chip { background: #1e1b4b; color: #a5b4fc; }
        body.dark-mode .post-category-chip  { background: #27272a; color: #a1a1aa; }
        body.dark-mode .post-edited-badge   { background: #27272a; color: #71717a; }
        body.dark-mode .author-avatar       { box-shadow: 0 2px 8px rgba(99,102,241,0.5); }
        body.dark-mode .post-card--pinned   { background: rgba(99,102,241,0.06); }
        body.dark-mode .post-card--broadcast { border-left-color: #38bdf8 !important; background: rgba(56,189,248,0.05) !important; }
        body.dark-mode .broadcast-feed-banner { background: rgba(56,189,248,0.1); border-color: rgba(56,189,248,0.2); }
    `;
    document.head.appendChild(style);
}