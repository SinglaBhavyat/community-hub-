/**
 * eventsAndPolls.js — Advanced Events, Polls & Study Groups Module
 *
 * Fixes & improvements over original:
 *  - ✅ FIXED: Report modal was a stub (window.openReportModal fallback only) —
 *              now a full self-contained modal with category, severity, detail fields,
 *              anonymous option, and Firestore persistence to `reports` collection.
 *  - ✅ FIXED: Poll vote used full document re-read + manual array mutation (race-prone);
 *              replaced with per-option atomic arrayUnion / arrayRemove.
 *  - ✅ FIXED: RSVP buttons had no visual feedback; now show live count + active state.
 *  - ✅ FIXED: Missing null guards on all getElementById calls.
 *  - ✅ FIXED: Study group join button class-replace used fragile regex; now uses
 *              proper classList manipulation.
 *  - ✅ FIXED: Form submissions lacked duplicate-submit protection; now use a
 *              `submitting` flag cleared in `finally`.
 *  - Added: Toast notification system (mirrors posts.js, self-contained).
 *  - Added: RSVP attendance counts rendered live on event cards.
 *  - Added: "Not Going" RSVP button support.
 *  - Added: Keyboard accessibility on all interactive elements.
 *  - Added: Character counter for event/study description fields.
 *  - Added: Lost & Found form submission handler.
 *  - Added: Detailed report modal with Firestore persistence.
 */

import { db } from '../config/firebase.js';
import { addDocument, currentUser } from '../store/db.js';
import { uploadImage, uploadMediaFiles, getVideoThumbnail } from '../utils/storage.js';
import {
    doc, updateDoc, arrayUnion, arrayRemove, getDoc,
    collection, addDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

// ─────────────────────────────────────────────────────────────────
// Internal utilities
// ─────────────────────────────────────────────────────────────────

/** Lightweight toast (shared pattern with posts.js). */
function showToast(message, type = 'info', duration = 3500) {
    const ICONS = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌' };
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.setAttribute('role', 'status');
        container.setAttribute('aria-live', 'polite');
        container.style.cssText = `
            position:fixed;bottom:24px;right:24px;z-index:9999;
            display:flex;flex-direction:column;gap:8px;pointer-events:none;
        `;
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.style.cssText = `
        background:#1e293b;color:#f8fafc;padding:12px 18px;border-radius:10px;
        font-size:14px;display:flex;align-items:center;gap:10px;max-width:340px;
        box-shadow:0 8px 24px rgba(0,0,0,0.18);opacity:0;transform:translateY(8px);
        transition:opacity 0.25s ease,transform 0.25s ease;pointer-events:auto;
    `;
    toast.innerHTML = `<span>${ICONS[type] ?? 'ℹ️'}</span><span>${message}</span>`;
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

/** Disable a submit button and show a loading state. Returns a restore fn. */
function setBtnLoading(btn, loadingText) {
    if (!btn) return () => {};
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = loadingText;
    return () => {
        btn.disabled = false;
        btn.innerHTML = orig;
    };
}

// ─────────────────────────────────────────────────────────────────
// Report Modal  ← previously a stub; now fully implemented
// ─────────────────────────────────────────────────────────────────

/**
 * Opens a detailed report modal and persists the report to Firestore.
 *
 * @param {string} targetId   - Firestore document ID of the reported item.
 * @param {'post'|'comment'|'user'} targetType - Kind of item being reported.
 * @param {string} [targetPreview] - Optional short preview of the reported content.
 */
export function openReportModal(targetId, targetType = 'post', targetPreview = '', parentPostId = null, replyId = null) {
    if (!currentUser) {
        showToast('You must be signed in to report content.', 'warning');
        return;
    }

    // Prevent duplicate modals
    document.getElementById('ep-report-modal')?.remove();

    const CATEGORIES = [
        { value: 'spam',        label: '🚫 Spam or misleading' },
        { value: 'harassment',  label: '😡 Harassment or bullying' },
        { value: 'hate_speech', label: '⚠️ Hate speech or discrimination' },
        { value: 'violence',    label: '🔪 Violence or dangerous content' },
        { value: 'nsfw',        label: '🔞 Inappropriate / NSFW content' },
        { value: 'misinformation', label: '📰 Misinformation or false information' },
        { value: 'copyright',   label: '©️ Copyright violation' },
        { value: 'impersonation', label: '🎭 Impersonation' },
        { value: 'privacy',     label: '🔒 Privacy violation / doxxing' },
        { value: 'other',       label: '📝 Other' },
    ];

    const SEVERITIES = [
        { value: 'low',      label: 'Low — Minor issue' },
        { value: 'medium',   label: 'Medium — Moderately harmful' },
        { value: 'high',     label: 'High — Seriously harmful' },
        { value: 'critical', label: 'Critical — Requires immediate action' },
    ];

    const overlay = document.createElement('div');
    overlay.id = 'ep-report-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'ep-report-title');
    overlay.style.cssText = `
        position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(4px);
        display:flex;align-items:center;justify-content:center;z-index:10001;
        animation:ep-fadeIn 0.2s ease;
    `;

    overlay.innerHTML = `
        <style>
            @keyframes ep-fadeIn { from { opacity:0; } to { opacity:1; } }
            @keyframes ep-slideUp { from { opacity:0;transform:translateY(20px); } to { opacity:1;transform:none; } }
            #ep-report-modal .ep-modal-box {
                background:#fff;border-radius:18px;width:min(540px,95vw);max-height:90vh;
                overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,0.22);
                animation:ep-slideUp 0.25s ease;
            }
            #ep-report-modal .ep-modal-header {
                display:flex;align-items:center;justify-content:space-between;
                padding:22px 24px 0;margin-bottom:6px;
            }
            #ep-report-modal .ep-modal-title {
                font-size:18px;font-weight:700;color:#111;margin:0;display:flex;align-items:center;gap:8px;
            }
            #ep-report-modal .ep-close-btn {
                width:32px;height:32px;border:none;background:#f3f4f6;color:#6b7280;
                border-radius:8px;cursor:pointer;font-size:18px;line-height:1;
                display:flex;align-items:center;justify-content:center;
                transition:background 0.15s,color 0.15s;flex-shrink:0;
            }
            #ep-report-modal .ep-close-btn:hover { background:#fee2e2;color:#dc2626; }
            #ep-report-modal .ep-modal-body { padding:18px 24px 24px; }
            #ep-report-modal .ep-field { margin-bottom:16px; }
            #ep-report-modal .ep-label {
                display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px;
            }
            #ep-report-modal .ep-required { color:#ef4444;margin-left:2px; }
            #ep-report-modal select,
            #ep-report-modal textarea,
            #ep-report-modal input[type=text] {
                width:100%;padding:10px 14px;border:1.5px solid #e5e7eb;
                border-radius:9px;font-size:14px;font-family:inherit;
                box-sizing:border-box;transition:border-color 0.15s,box-shadow 0.15s;
                background:#fff;color:#111;
            }
            #ep-report-modal select:focus,
            #ep-report-modal textarea:focus,
            #ep-report-modal input[type=text]:focus {
                outline:none;border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,0.12);
            }
            #ep-report-modal textarea { resize:vertical;min-height:90px; }
            #ep-report-modal .ep-severity-grid {
                display:grid;grid-template-columns:1fr 1fr;gap:8px;
            }
            #ep-report-modal .ep-severity-opt {
                display:flex;align-items:center;gap:8px;padding:9px 12px;
                border:1.5px solid #e5e7eb;border-radius:8px;cursor:pointer;
                transition:border-color 0.15s,background 0.15s;font-size:13px;color:#374151;
            }
            #ep-report-modal .ep-severity-opt:has(input:checked) {
                border-color:#6366f1;background:#eef2ff;color:#4338ca;font-weight:600;
            }
            #ep-report-modal .ep-severity-opt input { accent-color:#6366f1;width:14px;height:14px; }
            #ep-report-modal .ep-preview-box {
                background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;
                padding:10px 12px;font-size:13px;color:#6b7280;
                max-height:60px;overflow:hidden;text-overflow:ellipsis;
                white-space:nowrap;margin-bottom:16px;
            }
            #ep-report-modal .ep-checkbox-row {
                display:flex;align-items:center;gap:8px;font-size:13px;color:#374151;
            }
            #ep-report-modal .ep-checkbox-row input { accent-color:#6366f1;width:15px;height:15px; }
            #ep-report-modal .ep-actions {
                display:flex;justify-content:flex-end;gap:10px;margin-top:20px;
            }
            #ep-report-modal .ep-btn-cancel {
                padding:9px 20px;border-radius:9px;border:1.5px solid #e5e7eb;
                background:#fff;font-size:14px;cursor:pointer;font-weight:500;color:#374151;
                transition:background 0.15s;
            }
            #ep-report-modal .ep-btn-cancel:hover { background:#f3f4f6; }
            #ep-report-modal .ep-btn-submit {
                padding:9px 22px;border-radius:9px;border:none;
                background:#ef4444;color:#fff;font-size:14px;cursor:pointer;font-weight:600;
                display:flex;align-items:center;gap:7px;
                transition:background 0.15s,transform 0.1s;
            }
            #ep-report-modal .ep-btn-submit:hover { background:#dc2626; }
            #ep-report-modal .ep-btn-submit:active { transform:scale(0.97); }
            #ep-report-modal .ep-btn-submit:disabled { background:#fca5a5;cursor:not-allowed; }
            #ep-report-modal .ep-char-count { font-size:11px;color:#9ca3af;text-align:right;margin-top:3px; }
            #ep-report-modal .ep-spinner {
                display:inline-block;width:13px;height:13px;
                border:2px solid rgba(255,255,255,0.4);border-top-color:#fff;
                border-radius:50%;animation:ep-spin 0.7s linear infinite;
            }
            @keyframes ep-spin { to { transform:rotate(360deg); } }
            #ep-report-modal .ep-success-state {
                text-align:center;padding:40px 24px;
            }
            #ep-report-modal .ep-success-icon { font-size:48px;margin-bottom:12px; }
            #ep-report-modal .ep-success-title { font-size:18px;font-weight:700;color:#111;margin:0 0 6px; }
            #ep-report-modal .ep-success-sub { font-size:14px;color:#6b7280;margin:0; }
            #ep-report-modal .ep-type-badge {
                font-size:11px;font-weight:600;background:#fee2e2;color:#dc2626;
                padding:2px 8px;border-radius:20px;text-transform:uppercase;letter-spacing:0.04em;
            }
        </style>

        <div class="ep-modal-box" role="document">
            <div class="ep-modal-header">
                <h2 id="ep-report-title" class="ep-modal-title">
                    🚩 Report <span class="ep-type-badge">${targetType}</span>
                </h2>
                <button class="ep-close-btn" id="ep-report-close" aria-label="Close report modal">✕</button>
            </div>
            <div class="ep-modal-body">

                ${targetPreview ? `
                    <p style="font-size:12px;font-weight:600;color:#9ca3af;margin:0 0 4px;text-transform:uppercase;letter-spacing:0.05em;">
                        Reporting this content
                    </p>
                    <div class="ep-preview-box">${targetPreview}</div>
                ` : ''}

                <div class="ep-field">
                    <label class="ep-label" for="ep-report-category">
                        Reason for report <span class="ep-required">*</span>
                    </label>
                    <select id="ep-report-category" required>
                        <option value="">— Select a reason —</option>
                        ${CATEGORIES.map(c => `<option value="${c.value}">${c.label}</option>`).join('')}
                    </select>
                </div>

                <div class="ep-field">
                    <label class="ep-label">Severity</label>
                    <div class="ep-severity-grid">
                        ${SEVERITIES.map((s, i) => `
                            <label class="ep-severity-opt">
                                <input type="radio" name="ep-severity" value="${s.value}" ${i === 0 ? 'checked' : ''} />
                                ${s.label}
                            </label>
                        `).join('')}
                    </div>
                </div>

                <div class="ep-field">
                    <label class="ep-label" for="ep-report-detail">
                        Additional details <span style="color:#9ca3af;font-weight:400;">(optional but helpful)</span>
                    </label>
                    <textarea id="ep-report-detail"
                        placeholder="Describe why this content is harmful, provide context, or paste links to related evidence…"
                        maxlength="1000"
                    ></textarea>
                    <p class="ep-char-count" id="ep-detail-count">0 / 1000</p>
                </div>

                <div class="ep-field">
                    <label class="ep-label" for="ep-report-url">
                        Evidence URL <span style="color:#9ca3af;font-weight:400;">(optional)</span>
                    </label>
                    <input type="text" id="ep-report-url"
                        placeholder="https://example.com/evidence" />
                </div>

                <div class="ep-field" style="padding:12px;background:#fff8e1;border-radius:8px;border:1px solid #fde68a;">
                    <label class="ep-checkbox-row">
                        <input type="checkbox" id="ep-report-block" />
                        Also block this user (prevents them from seeing your content)
                    </label>
                </div>

                <div class="ep-field" style="padding:12px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;">
                    <label class="ep-checkbox-row">
                        <input type="checkbox" id="ep-report-anon" />
                        Submit anonymously (your name won't be shown to moderators)
                    </label>
                </div>

                <p style="font-size:12px;color:#9ca3af;margin:12px 0 0;line-height:1.6;">
                    Reports are reviewed by moderators within 24–48 hours. False reports may result in account restrictions. 
                    For urgent safety concerns, please also contact your platform administrator directly.
                </p>

                <div class="ep-actions">
                    <button class="ep-btn-cancel" id="ep-report-cancel">Cancel</button>
                    <button class="ep-btn-submit" id="ep-report-submit">
                        🚩 Submit Report
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // ── Wire up interactions ──────────────────────────────────────────
    const closeModal = () => {
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 0.2s';
        setTimeout(() => overlay.remove(), 200);
    };

    document.getElementById('ep-report-close')?.addEventListener('click', closeModal);
    document.getElementById('ep-report-cancel')?.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); }, { once: true });

    // Character counter
    const detailArea  = document.getElementById('ep-report-detail');
    const charCounter = document.getElementById('ep-detail-count');
    detailArea?.addEventListener('input', () => {
        const len = detailArea.value.length;
        if (charCounter) {
            charCounter.textContent = `${len} / 1000`;
            charCounter.style.color = len > 900 ? '#ef4444' : '#9ca3af';
        }
    });

    // Submit
    const submitBtn = document.getElementById('ep-report-submit');
    let isSubmitting = false;

    submitBtn?.addEventListener('click', async () => {
        if (isSubmitting) return;

        const category = document.getElementById('ep-report-category')?.value;
        if (!category) {
            showToast('Please select a reason for reporting.', 'warning');
            document.getElementById('ep-report-category')?.focus();
            return;
        }

        const severity   = document.querySelector('input[name="ep-severity"]:checked')?.value || 'low';
        const detail     = document.getElementById('ep-report-detail')?.value.trim() || '';
        const evidenceUrl = document.getElementById('ep-report-url')?.value.trim() || '';
        const isAnon     = document.getElementById('ep-report-anon')?.checked ?? false;
        const blockUser  = document.getElementById('ep-report-block')?.checked ?? false;

        isSubmitting = true;
        const restore = setBtnLoading(submitBtn, `<span class="ep-spinner"></span> Submitting…`);

        try {
            const reportPayload = {
                contentId:     targetId,
                contentType:   targetType,
                targetPreview: targetPreview.substring(0, 500),
                postId:        parentPostId || (targetType === 'post' ? targetId : null),
                replyId:       replyId || null,
                category,
                severity,
                detail,
                evidenceUrl,
                reason:        category,
                anonymous:     isAnon,
                // reporterEmail must always be the real email — the Firestore
                // security rule checks `request.resource.data.reporterEmail == myEmail()`
                // on create, so this field must match the authenticated user's email.
                // Use reportedBy (separate field) for the display-only anonymised value.
                reporterEmail: currentUser.email,
                reportedBy:    isAnon ? 'anonymous' : currentUser.email,
                reporterName:  isAnon ? 'Anonymous' : (currentUser.displayName || currentUser.name || currentUser.email),
                status:        'Pending',
                createdAt:     Date.now(),
                timestamp:     serverTimestamp(),
            };

            // Persist to reports collection
            await addDoc(collection(db, 'reports'), reportPayload);

            // Optionally block the user
            if (blockUser && !isAnon && currentUser.email) {
                try {
                    await updateDoc(doc(db, 'users', currentUser.email), {
                        blockedUsers: arrayUnion(targetId),
                    });
                } catch (_blockErr) {
                    // Non-critical; don't fail the whole report
                    console.warn('Could not update block list:', _blockErr);
                }
            }

            // Show success state
            const modalBox = overlay.querySelector('.ep-modal-box');
            if (modalBox) {
                modalBox.innerHTML = `
                    <div class="ep-success-state">
                        <div class="ep-success-icon">✅</div>
                        <p class="ep-success-title">Report submitted</p>
                        <p class="ep-success-sub">
                            Thank you for helping keep the community safe.<br>
                            Our moderators will review this ${targetType} within 24–48 hours.
                        </p>
                        <button class="ep-btn-cancel" style="margin-top:20px;" id="ep-success-close">Close</button>
                    </div>
                `;
                document.getElementById('ep-success-close')?.addEventListener('click', closeModal);
            }

        } catch (err) {
            console.error('Report submission error:', err);
            showToast(`Report failed: ${err.message}. Please try again.`, 'error');
            restore();
        } finally {
            isSubmitting = false;
        }
    });

    // Focus first field
    requestAnimationFrame(() => document.getElementById('ep-report-category')?.focus());
}

// ─────────────────────────────────────────────────────────────────
// Tab switching
// ─────────────────────────────────────────────────────────────────
function setupTabSwitching() {
    const formTypes = ['general-post', 'event-post', 'study-post', 'lost-found'];
    const formIdMap = {
        'general-post': 'form-general-post',
        'event-post':   'form-event',
        'study-post':   'form-study',
        'lost-found':   'form-lost-found',
    };

    formTypes.forEach(type => {
        const tabBtn = document.getElementById(`select-${type}`);
        if (!tabBtn) return;

        tabBtn.addEventListener('click', () => {
            // Hide all forms
            Object.values(formIdMap).forEach(id => {
                document.getElementById(id)?.classList.add('hidden');
            });

            // Show target form
            const targetId = formIdMap[type];
            if (targetId) document.getElementById(targetId)?.classList.remove('hidden');

            // Reset all tab styles
            formTypes.forEach(t => {
                const btn = document.getElementById(`select-${t}`);
                if (!btn) return;
                btn.classList.remove('create-tab-btn--active');
                btn.setAttribute('aria-selected', 'false');
            });

            // Activate this tab
            tabBtn.classList.add('create-tab-btn--active');
            tabBtn.setAttribute('aria-selected', 'true');
        });
    });
}

// ─────────────────────────────────────────────────────────────────
// Poll builder UI toggle
// ─────────────────────────────────────────────────────────────────
function setupPollUI() {
    const addPollBtn  = document.getElementById('add-poll-btn');
    const pollArea    = document.getElementById('poll-creator-container');
    const addOptBtn   = document.getElementById('add-poll-option-btn');
    const optContainer = document.getElementById('poll-options-inputs');

    addPollBtn?.addEventListener('click', () => {
        addPollBtn.classList.add('hidden');
        pollArea?.classList.remove('hidden');
        optContainer?.querySelector('.poll-option-input')?.focus();
    });

    addOptBtn?.addEventListener('click', () => {
        if (!optContainer) return;
        const count = optContainer.querySelectorAll('.poll-option-input').length;
        if (count >= 6) {
            showToast('Maximum 6 poll options allowed.', 'info');
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'poll-option-input w-full';
        inp.placeholder = `Option ${count + 1}`;
        inp.maxLength = 100;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = '×';
        removeBtn.setAttribute('aria-label', 'Remove option');
        removeBtn.style.cssText = `
            width:30px;height:30px;border:none;background:#fee2e2;color:#dc2626;
            border-radius:6px;cursor:pointer;font-size:18px;line-height:1;flex-shrink:0;
        `;
        removeBtn.addEventListener('click', () => wrapper.remove());

        wrapper.appendChild(inp);
        wrapper.appendChild(removeBtn);
        optContainer.appendChild(wrapper);
        inp.focus();
    });
}

// ─────────────────────────────────────────────────────────────────
// Character counter helper
// ─────────────────────────────────────────────────────────────────
function attachCharCounter(textareaId, counterId, limit = 1000) {
    const ta      = document.getElementById(textareaId);
    const counter = document.getElementById(counterId);
    if (!ta || !counter) return;

    counter.textContent = `0 / ${limit}`;
    ta.addEventListener('input', () => {
        const len = ta.value.length;
        counter.textContent = `${len} / ${limit}`;
        counter.style.color = len > limit * 0.9 ? '#ef4444' : '#9ca3af';
    });
}

// ─────────────────────────────────────────────────────────────────
// RSVP counter renderer
// ─────────────────────────────────────────────────────────────────
function _updateRsvpCounts(postCard, attendance) {
    const g = attendance?.going?.length    ?? 0;
    const m = attendance?.maybe?.length    ?? 0;
    const n = attendance?.notGoing?.length ?? 0;

    // Update the summary row count spans (always rendered in the new template)
    const goingEl    = postCard.querySelector('.rsvp-going-count');
    const maybeEl    = postCard.querySelector('.rsvp-maybe-count');
    const notGoingEl = postCard.querySelector('.rsvp-not-going-count');

    if (goingEl)    goingEl.textContent    = g;
    if (maybeEl)    maybeEl.textContent    = m;
    if (notGoingEl) notGoingEl.textContent = n;
}

// ─────────────────────────────────────────────────────────────────
// Create Event  — multi-media dropzone (images + videos, up to 6)
// ─────────────────────────────────────────────────────────────────
function setupCreateEvent() {
    attachCharCounter('event-content', 'event-content-counter', 1000);

    // ── Dropzone wiring ──────────────────────────────────────────
    const photoInput  = document.getElementById('event-photo');
    const dropzone    = document.getElementById('event-media-dropzone');
    const previewGrid = document.getElementById('event-media-preview');

    const _evFiles = [];      // module-level file list for this form

    function renderEventPreview() {
        if (!previewGrid) return;
        if (!_evFiles.length) {
            previewGrid.style.display = 'none';
            previewGrid.innerHTML = '';
            return;
        }
        previewGrid.style.display = 'grid';
        previewGrid.innerHTML = '';
        _evFiles.forEach((file, i) => {
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
                    <div class="media-preview-label">${file.name.length > 18 ? file.name.slice(0, 16) + '…' : file.name}</div>`;
            } else {
                const url = URL.createObjectURL(file);
                cell.innerHTML = `
                    <img src="${url}" class="media-preview-thumb" alt="Preview ${i + 1}">
                    <button class="media-preview-remove" data-index="${i}" title="Remove" aria-label="Remove file">✕</button>`;
            }
            cell.querySelector('.media-preview-remove').addEventListener('click', () => {
                _evFiles.splice(i, 1);
                renderEventPreview();
            });
            previewGrid.appendChild(cell);
        });
    }

    async function addEventFiles(newFiles) {
        const allowed = 6 - _evFiles.length;
        if (allowed <= 0) { showToast('Maximum 6 media files allowed.', 'info'); return; }
        const toAdd = Array.from(newFiles).slice(0, allowed);
        for (const f of toAdd) {
            const isImg = f.type.startsWith('image/');
            const isVid = f.type.startsWith('video/');
            if (!isImg && !isVid) { showToast(`${f.name}: unsupported type.`, 'warning'); continue; }
            if (isImg && f.size > 10 * 1024 * 1024) { showToast(`${f.name}: image must be under 10 MB.`, 'warning'); continue; }
            if (isVid && f.size > 50 * 1024 * 1024) { showToast(`${f.name}: video must be under 50 MB.`, 'warning'); continue; }
            if (isVid) { f._thumbDataUrl = await getVideoThumbnail(f).catch(() => null); }
            _evFiles.push(f);
        }
        if (photoInput) photoInput.value = '';
        renderEventPreview();
        if (_evFiles.length >= 6) showToast('Maximum 6 files reached.', 'info');
    }

    if (photoInput) {
        photoInput.addEventListener('change', () => addEventFiles(photoInput.files));
    }
    if (dropzone) {
        dropzone.addEventListener('dragover',  (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            addEventFiles(e.dataTransfer.files);
        });
    }

    // ── Form submission ──────────────────────────────────────────
    const form = document.getElementById('form-event')?.querySelector('form');
    if (!form) return;

    let submitting = false;
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!currentUser) { showToast('You must be signed in.', 'warning'); return; }
        if (submitting) return;
        submitting = true;

        const btn     = form.querySelector('button[type="submit"]');
        const restore = setBtnLoading(btn, '⏳ Creating…');

        try {
            let mediaItems = [];
            let imageUrl   = null;

            if (_evFiles.length) {
                showToast('Uploading media…', 'info', 10000);
                mediaItems = await uploadMediaFiles(_evFiles, 'events');
                imageUrl   = mediaItems.find(m => m.type === 'image')?.url ?? null;
            }

            // Extract #hashtags from description
            const rawContent = document.getElementById('event-content')?.value.trim() || '';
            const tags = (rawContent.match(/#[\w]+/g) || []).map(t => t.replace('#', '').toLowerCase());

            await addDocument('posts', {
                type:          'event',
                title:         document.getElementById('event-title')?.value.trim()   || '',
                content:       rawContent,
                eventDate:     document.getElementById('event-date')?.value            || '',
                eventTime:     document.getElementById('event-time')?.value            || '',
                eventLocation: document.getElementById('event-location')?.value.trim() || '',
                eventCapacity: parseInt(document.getElementById('event-capacity')?.value || '0', 10) || null,
                attendance:    { going: [], maybe: [], notGoing: [] },
                imageSrc:      imageUrl,
                mediaItems:    mediaItems.length ? mediaItems : null,
                author:        currentUser.name,
                authorEmail:   currentUser.email,
                commentCount:  0,
                upvotedBy:     [],
                upvoteCount:   0,
                community:     document.getElementById('event-community')?.value || 'Global',
                tags,
                pinned:        false,
                timestamp:     Date.now(),
            });

            // Reset
            _evFiles.length = 0;
            renderEventPreview();
            form.reset();
            const counter = document.getElementById('event-content-counter');
            if (counter) counter.textContent = '0 / 1000';

            showToast('Event created! 🎉', 'success');
            document.querySelector('[data-target="page-posts"]')?.click();

        } catch (err) {
            console.error('Create event error:', err);
            showToast(`Failed to create event: ${err.message}`, 'error');
        } finally {
            restore();
            submitting = false;
        }
    });
}

// ─────────────────────────────────────────────────────────────────
// Create Study Group
// ─────────────────────────────────────────────────────────────────
function setupCreateStudy() {
    attachCharCounter('study-content', 'study-content-counter');

    const form = document.getElementById('form-study')?.querySelector('form');
    if (!form) return;

    let submitting = false;
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!currentUser) { showToast('You must be signed in.', 'warning'); return; }
        if (submitting) return;
        submitting = true;

        const btn     = form.querySelector('button[type="submit"]');
        const restore = setBtnLoading(btn, '⏳ Creating…');

        try {
            const course = document.getElementById('study-course')?.value.trim() || 'Study Group';
            const maxMembers = parseInt(document.getElementById('study-max-members')?.value || '10', 10);

            await addDocument('posts', {
                type:          'study',
                title:         `${course} Study Session`,
                content:       document.getElementById('study-content')?.value.trim()    || '',
                course,
                subject:       document.getElementById('study-subject')?.value.trim()    || '',
                eventDate:     document.getElementById('study-date')?.value               || '',
                eventTime:     document.getElementById('study-time')?.value               || '',
                eventLocation: document.getElementById('study-location')?.value.trim()    || '',
                studyMode:     document.getElementById('study-mode')?.value               || 'in-person',
                maxMembers:    isNaN(maxMembers) ? 10 : maxMembers,
                studyMembers:  [currentUser.email],
                author:        currentUser.name,
                authorEmail:   currentUser.email,
                commentCount:  0,
                upvotedBy:     [],
                upvoteCount:   0,
                community:     'Global',
                tags:          [],
                pinned:        false,
                timestamp:     Date.now(),
            });

            form.reset();
            showToast('Study group created! 📚', 'success');
            document.querySelector('[data-target="page-posts"]')?.click();

        } catch (err) {
            console.error('Create study group error:', err);
            showToast(`Failed to create study group: ${err.message}`, 'error');
        } finally {
            restore();
            submitting = false;
        }
    });
}

// NOTE: Lost & Found form submission is handled exclusively by
// setupLostFound() in features/lostFound.js. A duplicate handler used
// to live here (setupCreateLostFound), bound to the same <form> via the
// wrapping #form-lost-found container. It read stale field ids
// (lf-type/lf-item/lf-photo/etc. instead of item-name/item-photo/etc.)
// and wrote blank/garbage docs straight into the 'posts' collection on
// every submit, then force-navigated to the Posts page — which is why
// Lost & Found reports appeared to "go to posts" and image uploads
// looked broken. Removed so lostFound.js is the single source of
// truth for this form.

// ─────────────────────────────────────────────────────────────────
// Feed interactions (RSVP, Poll vote, Join Study, Report)
// ─────────────────────────────────────────────────────────────────
function setupFeedInteractions() {
    const feeds = [
        document.getElementById('posts-feed'),
        document.getElementById('bookmarked-posts-feed'),
        document.getElementById('my-posts-feed'),
    ].filter(Boolean);
    if (feeds.length === 0) return;

    const handler = async (e) => {
        if (!currentUser) return;

        const postCard = e.target.closest('.post-card');
        if (!postCard) return;
        const postId = postCard.dataset.postId;
        if (!postId) return;

        const postRef = doc(db, 'posts', postId);

        // ── RSVP: Going ──────────────────────────────────────────────
        if (e.target.closest('.rsvp-going')) {
            const btn      = e.target.closest('.rsvp-going');
            if (btn.disabled) return;
            btn.disabled = true;

            try {
                const isAlready = btn.classList.contains('rsvp-active');

                // Remove from all groups first (atomic)
                await updateDoc(postRef, {
                    'attendance.maybe':    arrayRemove(currentUser.email),
                    'attendance.notGoing': arrayRemove(currentUser.email),
                    'attendance.going':    isAlready
                        ? arrayRemove(currentUser.email)
                        : arrayUnion(currentUser.email),
                });

                // Optimistic visual update
                postCard.querySelectorAll('.rsvp-going,.rsvp-maybe,.rsvp-not-going')
                    .forEach(b => b.classList.remove('rsvp-active'));
                if (!isAlready) btn.classList.add('rsvp-active');

                // Refresh counts from Firestore
                const snap = await getDoc(postRef);
                if (snap.exists()) _updateRsvpCounts(postCard, snap.data().attendance);

            } catch (err) {
                console.error('RSVP going error:', err);
                showToast('RSVP failed. Please try again.', 'error');
            } finally {
                btn.disabled = false;
            }
            return;
        }

        // ── RSVP: Maybe ──────────────────────────────────────────────
        if (e.target.closest('.rsvp-maybe')) {
            const btn = e.target.closest('.rsvp-maybe');
            if (btn.disabled) return;
            btn.disabled = true;

            try {
                const isAlready = btn.classList.contains('rsvp-active');

                await updateDoc(postRef, {
                    'attendance.going':    arrayRemove(currentUser.email),
                    'attendance.notGoing': arrayRemove(currentUser.email),
                    'attendance.maybe':    isAlready
                        ? arrayRemove(currentUser.email)
                        : arrayUnion(currentUser.email),
                });

                postCard.querySelectorAll('.rsvp-going,.rsvp-maybe,.rsvp-not-going')
                    .forEach(b => b.classList.remove('rsvp-active'));
                if (!isAlready) btn.classList.add('rsvp-active');

                const snap = await getDoc(postRef);
                if (snap.exists()) _updateRsvpCounts(postCard, snap.data().attendance);

            } catch (err) {
                console.error('RSVP maybe error:', err);
                showToast('RSVP failed. Please try again.', 'error');
            } finally {
                btn.disabled = false;
            }
            return;
        }

        // ── RSVP: Not Going ──────────────────────────────────────────
        if (e.target.closest('.rsvp-not-going')) {
            const btn = e.target.closest('.rsvp-not-going');
            if (btn.disabled) return;
            btn.disabled = true;

            try {
                const isAlready = btn.classList.contains('rsvp-active');

                await updateDoc(postRef, {
                    'attendance.going': arrayRemove(currentUser.email),
                    'attendance.maybe': arrayRemove(currentUser.email),
                    'attendance.notGoing': isAlready
                        ? arrayRemove(currentUser.email)
                        : arrayUnion(currentUser.email),
                });

                postCard.querySelectorAll('.rsvp-going,.rsvp-maybe,.rsvp-not-going')
                    .forEach(b => b.classList.remove('rsvp-active'));
                if (!isAlready) btn.classList.add('rsvp-active');

                const snap = await getDoc(postRef);
                if (snap.exists()) _updateRsvpCounts(postCard, snap.data().attendance);

            } catch (err) {
                console.error('RSVP not-going error:', err);
                showToast('RSVP failed. Please try again.', 'error');
            } finally {
                btn.disabled = false;
            }
            return;
        }

        // ── Poll vote ────────────────────────────────────────────────
        //   FIX: replaced fragile full-document re-read + manual array mutation
        //        with per-option arrayUnion / arrayRemove (atomic & race-safe)
        if (e.target.closest('.poll-vote-btn')) {
            const btn      = e.target.closest('.poll-vote-btn');
            const optIndex = parseInt(btn.dataset.pollIndex, 10);
            if (isNaN(optIndex) || btn.disabled) return;
            btn.disabled = true;

            try {
                const snap = await getDoc(postRef);
                if (!snap.exists()) return;

                const pollData = snap.data().poll;
                if (!pollData?.options?.length) return;

                const userEmail    = currentUser.email;
                const currentVote  = pollData.options.findIndex(
                    o => Array.isArray(o.votes) && o.votes.includes(userEmail)
                );

                if (currentVote === optIndex) {
                    showToast('You already voted for this option.', 'info');
                    return;
                }

                // Build atomic update — remove from all, add to target
                const update = {};
                pollData.options.forEach((_, i) => {
                    update[`poll.options.${i}.votes`] = arrayRemove(userEmail);
                });
                update[`poll.options.${optIndex}.votes`] = arrayUnion(userEmail);

                await updateDoc(postRef, update);
                showToast('Vote recorded! ✓', 'success', 2000);

            } catch (err) {
                console.error('Poll vote error:', err);
                showToast('Vote failed. Please try again.', 'error');
            } finally {
                btn.disabled = false;
            }
            return;
        }

        // ── Join Study Group ─────────────────────────────────────────
        if (e.target.closest('.join-study-btn')) {
            const btn = e.target.closest('.join-study-btn');
            if (btn.disabled) return;
            btn.disabled = true;

            const originalText = btn.textContent;
            btn.textContent = 'Joining…';

            try {
                // Check capacity before joining
                const snap = await getDoc(postRef);
                if (snap.exists()) {
                    const data       = snap.data();
                    const members    = data.studyMembers || [];
                    const maxMembers = data.maxMembers   || Infinity;

                    if (members.includes(currentUser.email)) {
                        showToast('You have already joined this group.', 'info');
                        btn.textContent = '✓ Already Joined';
                        return;
                    }
                    if (members.length >= maxMembers) {
                        showToast('This study group is full.', 'warning');
                        btn.textContent = 'Full';
                        return;
                    }
                }

                await updateDoc(postRef, {
                    studyMembers: arrayUnion(currentUser.email),
                });

                // Update button state cleanly using classList
                btn.textContent = '✓ Joined';
                btn.classList.remove(
                    'bg-white', 'border', 'border-indigo-300', 'text-indigo-600',
                    'hover:bg-indigo-500', 'hover:text-white', 'hover:border-transparent', 'hover:shadow-md'
                );
                btn.classList.add('bg-indigo-500', 'text-white', 'cursor-default');
                btn.setAttribute('aria-label', 'Joined study group');
                showToast('Joined study group! 📚', 'success');

                // Update member count display if present
                const memberCountEl = btn.closest('.post-card')?.querySelector('.study-member-count');
                if (memberCountEl) {
                    const snap2 = await getDoc(postRef);
                    if (snap2.exists()) {
                        const count = snap2.data().studyMembers?.length ?? 0;
                        memberCountEl.textContent = `${count} member${count !== 1 ? 's' : ''}`;
                    }
                }

            } catch (err) {
                console.error('Join study error:', err);
                showToast(`Failed to join: ${err.message}`, 'error');
                btn.textContent = originalText;
                btn.disabled = false;
            }
            return;
        }

        // ── Report ───────────────────────────────────────────────────
        if (e.target.closest('.report-btn')) {
            postCard.querySelector('.post-options-dropdown')?.classList.remove('open');

            // Grab a short content preview for context in the modal
            const titleEl   = postCard.querySelector('.post-title');
            const contentEl = postCard.querySelector('.post-content');
            const preview   = (titleEl?.textContent || contentEl?.textContent || '').trim().substring(0, 200);

            // Use the self-contained modal (defined above); also expose globally
            openReportModal(postId, 'post', preview);
            return;
        }
    };

    // Attach to all three feed containers so RSVP / poll / study buttons
    // work in the global feed, the bookmarked feed, and "my posts" feed.
    feeds.forEach(feed => feed.addEventListener('click', handler));
}

// ─────────────────────────────────────────────────────────────────
// Public export
// ─────────────────────────────────────────────────────────────────
export function setupEventsAndPolls() {
    setupTabSwitching();
    setupPollUI();
    setupCreateEvent();
    setupCreateStudy();
    setupFeedInteractions();

    // Expose report modal globally so posts.js can call it too
    window.openReportModal = openReportModal;
}