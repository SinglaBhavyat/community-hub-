import { db, auth } from '../config/firebase.js';
import { sanitize } from '../ui/templates.js';
import {
  collection, onSnapshot, query,
  orderBy, addDoc, serverTimestamp,
  doc, updateDoc, deleteDoc,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { uploadImage, uploadMediaFiles, getVideoThumbnail } from '../utils/storage.js';
import { currentUser, onCurrentUserChange } from '../store/db.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const COLLECTION       = 'lost_found';
const MAX_FILE_MB      = 5;
const TOAST_MS         = 3500;
const DESC_MAX         = 400;
const DESC_CLAMP_CHARS = 180;
const RESOLVE_TTL_MS   = 24 * 60 * 60 * 1000; // 24 h in ms

// ─── Module-level state ───────────────────────────────────────────────────────

// docId → plain item object; keeps modal data off the DOM
const _itemCache   = new Map();
let   _ttlTimer    = null;   // setInterval handle for TTL countdown refresh
let   _submitting  = false;  // double-submit guard (report form)
let   _editSubmitting   = false; // double-submit guard (edit form)
const _sweepInFlight = new Set(); // docIds currently being TTL-deleted, to avoid duplicate calls
let   _userUnsubscribe = null;    // handle returned by onCurrentUserChange
let   _feedUnsub = null;          // handle returned by the feed's onSnapshot — see startFeedListener()

// ─── Styles ──────────────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('lf-styles')) return;
  const s = document.createElement('style');
  s.id = 'lf-styles';
  s.textContent = `
    #lost-found-feed {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 18px;
      align-items: start;
    }

    /* ── Card ── */
    .lf-card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 16px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: border-color 0.18s, box-shadow 0.18s, transform 0.18s;
      animation: lf-card-in 0.25s ease both;
    }
    .lf-card:hover {
      border-color: #c7d2fe;
      box-shadow: 0 4px 20px rgba(99,102,241,0.08);
      transform: translateY(-2px);
    }
    .lf-card.resolved-card { opacity: 0.75; border-color: #d1fae5; }
    body.dark-mode .lf-card { background: #18181b; border-color: #27272a; }
    body.dark-mode .lf-card:hover { border-color: #4338ca; box-shadow: 0 4px 20px rgba(99,102,241,0.15); }
    body.dark-mode .lf-card.resolved-card { border-color: #065f46; }
    @keyframes lf-card-in {
      from { opacity: 0; transform: translateY(12px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* ── Card image ── */
    .lf-card-img-wrap {
      position: relative;
      overflow: hidden;
      cursor: zoom-in;
      background: #f4f4f5;
      border-bottom: 1px solid #e5e7eb;
    }
    body.dark-mode .lf-card-img-wrap { background: #09090b; border-bottom-color: #27272a; }
    .lf-card-img {
      width: 100%;
      height: 200px;
      object-fit: cover;
      display: block;
      transition: transform 0.3s ease;
    }
    .lf-card-img-wrap:hover .lf-card-img { transform: scale(1.03); }
    .lf-card-no-img {
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f4f4f5;
      border-bottom: 1px solid #e5e7eb;
      color: #a1a1aa;
      font-size: 28px;
    }
    body.dark-mode .lf-card-no-img { background: #09090b; border-bottom-color: #18181b; }
    .lf-zoom-hint {
      position: absolute;
      bottom: 8px; right: 8px;
      background: rgba(0,0,0,0.55);
      color: #fff;
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 20px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s;
    }
    .lf-card-img-wrap:hover .lf-zoom-hint { opacity: 1; }

    /* ── Resolved banner ── */
    .lf-resolved-banner {
      background: #d1fae5;
      color: #065f46;
      font-size: 12px;
      font-weight: 600;
      text-align: center;
      padding: 5px 12px;
      letter-spacing: 0.3px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    body.dark-mode .lf-resolved-banner { background: rgba(6,95,70,0.25); color: #6ee7b7; }

    /* ── Card body ── */
    .lf-card-body {
      padding: 14px 16px 16px;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .lf-card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .lf-card-title {
      font-size: 15px;
      font-weight: 700;
      color: #111827;
      margin: 0;
      line-height: 1.35;
      flex: 1;
      min-width: 0;
      word-break: break-word;
    }
    body.dark-mode .lf-card-title { color: #f4f4f5; }

    /* ── Badge ── */
    .lf-badge {
      flex-shrink: 0;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      padding: 3px 10px;
      border-radius: 20px;
      text-transform: uppercase;
    }
    .lf-badge--lost  { background: rgba(239,68,68,0.12); color: #dc2626; border: 1px solid rgba(239,68,68,0.25); }
    .lf-badge--found { background: rgba(34,197,94,0.12);  color: #16a34a; border: 1px solid rgba(34,197,94,0.25); }
    body.dark-mode .lf-badge--lost  { color: #f87171; }
    body.dark-mode .lf-badge--found { color: #4ade80; }

    /* ── Description ── */
    .lf-card-desc {
      font-size: 13.5px;
      color: #4b5563;
      line-height: 1.6;
      margin: 0;
      word-break: break-word;
      white-space: pre-wrap;
    }
    body.dark-mode .lf-card-desc { color: #a1a1aa; }
    /* white-space must be overridden for -webkit-line-clamp to work */
    .lf-card-desc.clamped {
      display: -webkit-box;
      -webkit-line-clamp: 4;
      -webkit-box-orient: vertical;
      overflow: hidden;
      white-space: normal;
    }
    .lf-expand-btn {
      background: none;
      border: none;
      color: #6366f1;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      padding: 0;
      align-self: flex-start;
      transition: color 0.15s;
    }
    .lf-expand-btn:hover { color: #4f46e5; text-decoration: underline; }

    /* ── Actions ── */
    .lf-card-actions { margin-top: 4px; display: flex; flex-direction: column; gap: 7px; }
    .lf-action-row   { display: flex; gap: 7px; flex-wrap: wrap; }
    .lf-action-btn {
      flex: 1;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 7px 12px;
      border-radius: 10px;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      border: 1.5px solid transparent;
      transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.1s;
      white-space: nowrap;
    }
    .lf-action-btn:active { transform: scale(0.97); }

    .lf-btn--message { background: transparent; border-color: #6366f1; color: #6366f1; }
    .lf-btn--message:hover { background: rgba(99,102,241,0.08); border-color: #4f46e5; color: #4f46e5; }
    body.dark-mode .lf-btn--message { color: #a5b4fc; border-color: #4338ca; }
    body.dark-mode .lf-btn--message:hover { background: rgba(99,102,241,0.15); }

    .lf-btn--resolve { background: transparent; border-color: #16a34a; color: #16a34a; }
    .lf-btn--resolve:hover { background: rgba(22,163,74,0.08); }
    body.dark-mode .lf-btn--resolve { color: #4ade80; border-color: #166534; }
    body.dark-mode .lf-btn--resolve:hover { background: rgba(34,197,94,0.1); }

    .lf-btn--resolved-state {
      background: rgba(22,163,74,0.1);
      border-color: #16a34a;
      color: #16a34a;
      cursor: default;
    }

    .lf-btn--delete { background: transparent; border-color: #ef4444; color: #ef4444; }
    .lf-btn--delete:hover { background: rgba(239,68,68,0.08); }
    body.dark-mode .lf-btn--delete { color: #f87171; border-color: #7f1d1d; }
    body.dark-mode .lf-btn--delete:hover { background: rgba(239,68,68,0.1); }

    /* ── Footer ── */
    .lf-card-footer {
      padding-top: 10px;
      border-top: 1px solid #f3f4f6;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    body.dark-mode .lf-card-footer { border-top-color: #27272a; }
    .lf-contact-row {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 12px;
      color: #6b7280;
    }
    .lf-contact-row svg { flex-shrink: 0; color: #9ca3af; }
    .lf-contact-row a { color: #6366f1; text-decoration: none; word-break: break-all; }
    .lf-contact-row a:hover { text-decoration: underline; }
    body.dark-mode .lf-contact-row { color: #71717a; }
    body.dark-mode .lf-contact-row a { color: #a5b4fc; }
    .lf-author-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #9ca3af;
    }
    .lf-timestamp { font-size: 11.5px; color: #9ca3af; }
    .lf-ttl-note  { font-size: 11px; color: #f59e0b; font-weight: 500; }
    body.dark-mode .lf-ttl-note { color: #fbbf24; }

    /* ── Copy button ── */
    .lf-copy-btn {
      background: none; border: none; cursor: pointer;
      color: #9ca3af; padding: 0 2px; line-height: 1;
      font-size: 12px; transition: color 0.15s;
    }
    .lf-copy-btn:hover  { color: #6366f1; }
    .lf-copy-btn.copied { color: #16a34a; }

    /* ── Skeleton ── */
    .lf-skeleton {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 16px;
      overflow: hidden;
    }
    body.dark-mode .lf-skeleton { background: #18181b; border-color: #27272a; }
    .lf-skel-img { height: 200px; background: #f3f4f6; }
    body.dark-mode .lf-skel-img { background: #27272a; }
    .lf-skel-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
    .lf-skel-line {
      border-radius: 6px;
      background: linear-gradient(90deg, #f3f4f6 25%, #e5e7eb 50%, #f3f4f6 75%);
      background-size: 200% 100%;
      animation: lf-shimmer 1.4s infinite;
    }
    body.dark-mode .lf-skel-line {
      background: linear-gradient(90deg, #27272a 25%, #3f3f46 50%, #27272a 75%);
      background-size: 200% 100%;
    }
    @keyframes lf-shimmer {
      0%   { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    /* ── Filter bar ── */
    .lf-filters {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 18px;
    }
    .lf-filter-btn {
      padding: 6px 16px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      border: 1.5px solid #e5e7eb;
      background: transparent;
      color: #6b7280;
      transition: all 0.15s;
    }
    .lf-filter-btn:hover { border-color: #a5b4fc; color: #4f46e5; background: rgba(99,102,241,0.06); }
    .lf-filter-btn.active { background: rgba(99,102,241,0.1); border-color: rgba(99,102,241,0.4); color: #4f46e5; }
    body.dark-mode .lf-filter-btn { border-color: #3f3f46; color: #71717a; }
    body.dark-mode .lf-filter-btn:hover,
    body.dark-mode .lf-filter-btn.active { background: rgba(99,102,241,0.15); border-color: #4338ca; color: #a5b4fc; }
    .lf-search-wrap { margin-left: auto; position: relative; display: flex; align-items: center; }
    .lf-search-wrap svg { position: absolute; left: 10px; color: #9ca3af; pointer-events: none; }
    .lf-search {
      background: #f9fafb;
      border: 1.5px solid #e5e7eb;
      border-radius: 10px;
      color: #111827;
      font-size: 13px;
      padding: 7px 10px 7px 32px;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
      width: 200px;
    }
    .lf-search:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.12); }
    .lf-search::placeholder { color: #9ca3af; }
    body.dark-mode .lf-search { background: #18181b; border-color: #3f3f46; color: #f4f4f5; }
    .lf-count { font-size: 12px; color: #9ca3af; white-space: nowrap; }

    /* ── Empty state ── */
    .lf-empty {
      grid-column: 1 / -1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 60px 20px;
      color: #9ca3af;
      text-align: center;
    }
    .lf-empty-icon { font-size: 40px; line-height: 1; opacity: 0.45; }
    .lf-empty h3   { font-size: 15px; color: #6b7280; margin: 0; }
    .lf-empty p    { font-size: 13px; margin: 0; }

    /* ── Toast ── */
    #lf-toast-container {
      position: fixed;
      bottom: 24px; right: 24px;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
    }
    .lf-toast {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      border-radius: 12px;
      font-size: 13.5px;
      font-weight: 500;
      max-width: 320px;
      pointer-events: auto;
      animation: lf-toast-in 0.25s ease;
      backdrop-filter: blur(8px);
    }
    .lf-toast--success { background: rgba(21,128,61,0.92);  color: #dcfce7; border: 1px solid rgba(34,197,94,0.3); }
    .lf-toast--error   { background: rgba(153,27,27,0.92);  color: #fee2e2; border: 1px solid rgba(239,68,68,0.3); }
    .lf-toast--info    { background: rgba(30,27,75,0.92);   color: #e0e7ff; border: 1px solid rgba(99,102,241,0.3); }
    .lf-toast.hiding   { animation: lf-toast-out 0.2s ease forwards; }
    @keyframes lf-toast-in  { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes lf-toast-out { from { opacity: 1; } to { opacity: 0; transform: translateY(6px); } }

    /* ── Carousel ── */
    .lf-carousel {
      position: relative;
      border-radius: 0;
      overflow: hidden;
      background: #0a0a14;
      height: 220px;
    }
    .lf-car-track {
      display: flex; height: 100%;
      transition: transform 0.42s cubic-bezier(0.4,0,0.2,1);
      will-change: transform;
    }
    .lf-carousel-slide {
      flex: 0 0 100%; height: 100%;
      position: relative; overflow: hidden;
    }
    .lf-carousel-slide img {
      width: 100%; height: 100%; object-fit: cover; display: block;
      transition: transform 0.5s ease;
    }
    .lf-carousel-slide:hover img { transform: scale(1.02); }
    .lf-car-arrow {
      position: absolute; top: 50%; transform: translateY(-50%);
      width: 36px; height: 36px; border-radius: 50%;
      border: none; background: rgba(0,0,0,0.5);
      color: #fff; font-size: 20px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      z-index: 10; opacity: 0;
      transition: background 0.2s, opacity 0.2s, transform 0.2s;
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    }
    .lf-carousel:hover .lf-car-arrow { opacity: 1; }
    .lf-car-prev { left: 10px; }
    .lf-car-next { right: 10px; }
    .lf-car-prev:hover { background: rgba(0,0,0,0.75); transform: translateY(-50%) scale(1.1); }
    .lf-car-next:hover { background: rgba(0,0,0,0.75); transform: translateY(-50%) scale(1.1); }
    @media (hover: none) {
      .lf-car-arrow    { opacity: 0.65 !important; }
      .lf-vid-controls { opacity: 1 !important; }
    }
    .lf-car-dots {
      position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
      display: flex; gap: 5px; z-index: 10;
    }
    .lf-car-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: rgba(255,255,255,0.4); cursor: pointer;
      transition: background 0.25s, transform 0.25s, width 0.25s;
    }
    .lf-car-dot.active { background: #fff; transform: scale(1.2); width: 18px; border-radius: 3px; }
    .lf-car-counter {
      position: absolute; top: 10px; right: 10px;
      font-size: 12px; color: rgba(255,255,255,0.9);
      background: rgba(0,0,0,0.45); padding: 3px 10px;
      border-radius: 20px; z-index: 10; font-weight: 500;
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
      letter-spacing: 0.02em;
    }

    /* ── Video Player (inside carousel & standalone) ── */
    .lf-vid-wrap {
      position: relative; width: 100%; height: 100%;
      background: #090912; min-height: 200px;
    }
    .lf-vid-wrap video {
      position: absolute; inset: 0; width: 100%; height: 100%;
      object-fit: contain;
    }
    .lf-vid-overlay {
      position: absolute; inset: 0; z-index: 2;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.12);
      transition: background 0.25s;
    }
    .lf-vid-overlay--paused { background: rgba(0,0,0,0.38); }
    .lf-vid-overlay:not(.lf-vid-overlay--paused) .lf-vid-play-btn { opacity: 0; pointer-events: none; }
    .lf-vid-overlay:hover .lf-vid-play-btn { opacity: 1 !important; pointer-events: auto; }
    .lf-vid-play-btn {
      width: 60px; height: 60px; border-radius: 50%;
      background: rgba(255,255,255,0.15);
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      display: flex; align-items: center; justify-content: center;
      color: #fff; cursor: pointer;
      transition: transform 0.2s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s;
      border: 1.5px solid rgba(255,255,255,0.3);
      box-shadow: 0 4px 24px rgba(0,0,0,0.3);
    }
    .lf-vid-play-btn:hover  { transform: scale(1.12); }
    .lf-vid-play-btn:active { transform: scale(0.95); }
    .lf-vid-icon-play, .lf-vid-icon-pause,
    .lf-vid-icon-unmuted, .lf-vid-icon-muted { display: block; }
    .hidden { display: none !important; }
    .lf-vid-controls {
      position: absolute; bottom: 0; left: 0; right: 0; z-index: 3;
      display: flex; align-items: center; gap: 6px; padding: 10px 12px;
      background: linear-gradient(transparent, rgba(0,0,0,0.75));
      opacity: 0; transition: opacity 0.25s;
    }
    .lf-vid-wrap:hover .lf-vid-controls { opacity: 1; }
    .lf-vid-ctrl-btn {
      background: none; border: none; color: #fff; cursor: pointer;
      padding: 4px; border-radius: 5px; display: flex; align-items: center;
      transition: background 0.15s, transform 0.15s;
    }
    .lf-vid-ctrl-btn:hover { background: rgba(255,255,255,0.15); transform: scale(1.1); }
    .lf-vid-progress-wrap { flex: 1; padding: 6px 0; cursor: pointer; }
    .lf-vid-progress-bar {
      position: relative; height: 3px;
      background: rgba(255,255,255,0.25);
      border-radius: 99px; overflow: visible;
      transition: height 0.15s;
    }
    .lf-vid-progress-wrap:hover .lf-vid-progress-bar { height: 5px; }
    .lf-vid-progress-fill { height: 100%; background: #fff; border-radius: 99px; width: 0; transition: width 0.1s linear; }
    .lf-vid-progress-thumb {
      position: absolute; top: 50%; transform: translate(-50%,-50%);
      width: 13px; height: 13px; border-radius: 50%; background: #fff;
      left: 0; opacity: 0; transition: opacity 0.15s;
      box-shadow: 0 1px 4px rgba(0,0,0,0.4);
    }
    .lf-vid-progress-wrap:hover .lf-vid-progress-thumb { opacity: 1; }
    .lf-vid-time {
      font-size: 11px; color: rgba(255,255,255,0.85);
      white-space: nowrap; font-variant-numeric: tabular-nums;
    }

    /* ── Lightbox ── */
    #lf-lightbox {
      position: fixed; inset: 0; z-index: 99999;
      background: rgba(0,0,0,0.88);
      display: none;
      align-items: center;
      justify-content: center;
      cursor: zoom-out;
    }
    #lf-lightbox.open { display: flex; animation: lf-lb-in 0.2s ease; }
    @keyframes lf-lb-in { from { opacity: 0; } to { opacity: 1; } }
    #lf-lightbox-img {
      max-width: min(90vw, 960px);
      max-height: 88vh;
      object-fit: contain;
      border-radius: 12px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.5);
      animation: lf-lb-scale 0.2s ease;
    }
    @keyframes lf-lb-scale { from { transform: scale(0.93); } to { transform: scale(1); } }
    #lf-lightbox-close {
      position: fixed; top: 20px; right: 24px;
      background: rgba(255,255,255,0.12);
      border: none; color: #fff;
      width: 36px; height: 36px;
      border-radius: 50%; font-size: 20px;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.15s;
      z-index: 100000;
    }
    #lf-lightbox-close:hover { background: rgba(255,255,255,0.22); }
    .lf-lb-close {
      position: absolute; top: -52px; right: 0;
      background: rgba(255,255,255,0.1); backdrop-filter: blur(8px);
      border: 0.5px solid rgba(255,255,255,0.2);
      color: #fff; width: 42px; height: 42px; border-radius: 50%;
      font-size: 18px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.15s, transform 0.15s;
    }
    .lf-lb-close:hover { background: rgba(255,255,255,0.2); transform: rotate(90deg) scale(1.1); }
    .lf-lb-media { display: flex; align-items: center; justify-content: center; }
    .lf-lb-nav {
      position: fixed; top: 50%; transform: translateY(-50%);
      background: rgba(255,255,255,0.1); backdrop-filter: blur(8px);
      border: 0.5px solid rgba(255,255,255,0.15);
      color: #fff; width: 50px; height: 50px; border-radius: 50%;
      font-size: 26px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.15s, transform 0.2s; z-index: 100001;
    }
    .lf-lb-nav:hover { background: rgba(255,255,255,0.2); transform: translateY(-50%) scale(1.08); }
    .lf-lb-prev { left: 16px; }
    .lf-lb-next { right: 16px; }
    .lf-lb-counter {
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      color: rgba(255,255,255,0.8); font-size: 13px; font-weight: 500;
      background: rgba(255,255,255,0.1); backdrop-filter: blur(8px);
      padding: 5px 14px; border-radius: 20px; z-index: 100001;
      border: 0.5px solid rgba(255,255,255,0.15);
    }

    /* ── Shared modal base ── */
    .lf-modal-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.55);
      backdrop-filter: blur(4px);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .lf-modal-overlay.open { display: flex; }
    @keyframes lf-modal-in {
      from { opacity: 0; transform: scale(0.94) translateY(8px); }
      to   { opacity: 1; transform: none; }
    }

    /* ── Message modal ── */
    #lf-msg-overlay { z-index: 10001; }
    #lf-msg-box {
      background: #fff; border-radius: 20px; padding: 24px;
      width: min(440px, 100%);
      display: flex; flex-direction: column; gap: 14px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.22);
      animation: lf-modal-in 0.2s ease;
    }
    body.dark-mode #lf-msg-box { background: #18181b; }
    .lf-msg-header { display: flex; align-items: center; justify-content: space-between; }
    .lf-msg-title  { font-size: 16px; font-weight: 700; color: #111827; margin: 0; }
    body.dark-mode .lf-msg-title { color: #f4f4f5; }
    .lf-msg-close  { background: none; border: none; font-size: 22px; color: #9ca3af; cursor: pointer; line-height: 1; padding: 2px 4px; }
    .lf-msg-close:hover { color: #6b7280; }
    .lf-msg-to     { font-size: 13px; color: #6b7280; margin: 0; }
    body.dark-mode .lf-msg-to { color: #71717a; }
    .lf-msg-textarea {
      width: 100%; box-sizing: border-box;
      border: 1.5px solid #e5e7eb; border-radius: 10px;
      padding: 10px 12px; font-size: 14px; font-family: inherit;
      resize: vertical; outline: none; min-height: 100px;
      transition: border-color 0.15s;
      background: #fff; color: #111827;
    }
    body.dark-mode .lf-msg-textarea { background: #09090b; border-color: #3f3f46; color: #f4f4f5; }
    .lf-msg-textarea:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.1); }
    .lf-msg-send {
      align-self: flex-end;
      background: #6366f1; color: #fff; border: none;
      padding: 9px 22px; border-radius: 10px;
      font-size: 14px; font-weight: 600; cursor: pointer;
      transition: background 0.15s, transform 0.1s;
    }
    .lf-msg-send:hover   { background: #4f46e5; }
    .lf-msg-send:active  { transform: scale(0.97); }
    .lf-msg-send:disabled { opacity: 0.5; cursor: not-allowed; }

    /* ── Edit modal ── */
    #lf-edit-overlay { z-index: 10001; }
    #lf-edit-box {
      background: #fff; border-radius: 20px; padding: 24px;
      width: min(460px, 100%);
      max-height: 86vh; overflow-y: auto;
      display: flex; flex-direction: column; gap: 10px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.22);
      animation: lf-modal-in 0.2s ease;
    }
    body.dark-mode #lf-edit-box { background: #18181b; }
    .lf-edit-label { font-size: 12.5px; font-weight: 600; color: #6b7280; margin-top: 4px; }
    body.dark-mode .lf-edit-label { color: #a1a1aa; }
    .lf-edit-input {
      width: 100%; box-sizing: border-box;
      border: 1.5px solid #e5e7eb; border-radius: 10px;
      padding: 9px 12px; font-size: 14px; font-family: inherit;
      outline: none; transition: border-color 0.15s;
      background: #fff; color: #111827;
    }
    body.dark-mode .lf-edit-input { background: #09090b; border-color: #3f3f46; color: #f4f4f5; }
    .lf-edit-input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.1); }

    /* ── Edit / Share / Report action buttons ── */
    .lf-btn--edit { background: transparent; border-color: #f59e0b; color: #b45309; }
    .lf-btn--edit:hover { background: rgba(245,158,11,0.08); }
    body.dark-mode .lf-btn--edit { color: #fbbf24; border-color: #92400e; }
    body.dark-mode .lf-btn--edit:hover { background: rgba(245,158,11,0.1); }

    .lf-btn--share { background: transparent; border-color: #9ca3af; color: #4b5563; }
    .lf-btn--share:hover { background: rgba(107,114,128,0.08); }
    body.dark-mode .lf-btn--share { color: #d1d5db; border-color: #52525b; }
    body.dark-mode .lf-btn--share:hover { background: rgba(161,161,170,0.1); }

    .lf-btn--report { background: transparent; border-color: #f97316; color: #c2410c; }
    .lf-btn--report:hover { background: rgba(249,115,22,0.08); }
    body.dark-mode .lf-btn--report { color: #fb923c; border-color: #7c2d12; }
    body.dark-mode .lf-btn--report:hover { background: rgba(249,115,22,0.1); }

    /* ── Resolve modal ── */
    #lf-resolve-overlay { z-index: 10002; }
    #lf-resolve-box {
      background: #fff; border-radius: 18px; padding: 24px;
      width: min(380px, 100%);
      display: flex; flex-direction: column; gap: 14px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.2);
      animation: lf-modal-in 0.2s ease;
    }
    body.dark-mode #lf-resolve-box { background: #18181b; }
    .lf-resolve-icon  { font-size: 32px; text-align: center; }
    .lf-resolve-title { font-size: 16px; font-weight: 700; color: #111827; margin: 0; text-align: center; }
    body.dark-mode .lf-resolve-title { color: #f4f4f5; }
    .lf-resolve-desc  { font-size: 13px; color: #6b7280; text-align: center; margin: 0; line-height: 1.55; }
    body.dark-mode .lf-resolve-desc { color: #71717a; }
    .lf-resolve-btns  { display: flex; gap: 10px; }
    .lf-resolve-cancel {
      flex: 1; padding: 9px; border-radius: 10px;
      border: 1.5px solid #e5e7eb; background: transparent;
      color: #374151; font-size: 14px; font-weight: 600; cursor: pointer;
      transition: background 0.15s;
    }
    .lf-resolve-cancel:hover { background: #f9fafb; }
    body.dark-mode .lf-resolve-cancel { border-color: #3f3f46; color: #d1d5db; }
    .lf-resolve-confirm {
      flex: 1; padding: 9px; border-radius: 10px; border: none;
      background: #16a34a; color: #fff;
      font-size: 14px; font-weight: 600; cursor: pointer;
      transition: background 0.15s;
    }
    .lf-resolve-confirm:hover { background: #15803d; }

    /* ── Delete modal ── */
    #lf-delete-overlay { z-index: 10003; }
    #lf-delete-box {
      background: #fff; border-radius: 18px; padding: 24px;
      width: min(380px, 100%);
      display: flex; flex-direction: column; gap: 14px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.2);
      animation: lf-modal-in 0.2s ease;
    }
    body.dark-mode #lf-delete-box { background: #18181b; }
    .lf-delete-icon  { font-size: 32px; text-align: center; }
    .lf-delete-title { font-size: 16px; font-weight: 700; color: #111827; margin: 0; text-align: center; }
    body.dark-mode .lf-delete-title { color: #f4f4f5; }
    .lf-delete-desc  { font-size: 13px; color: #6b7280; text-align: center; margin: 0; line-height: 1.55; }
    body.dark-mode .lf-delete-desc { color: #71717a; }
    .lf-delete-btns  { display: flex; gap: 10px; }
    .lf-delete-cancel {
      flex: 1; padding: 9px; border-radius: 10px;
      border: 1.5px solid #e5e7eb; background: transparent;
      color: #374151; font-size: 14px; font-weight: 600; cursor: pointer;
      transition: background 0.15s;
    }
    .lf-delete-cancel:hover { background: #f9fafb; }
    body.dark-mode .lf-delete-cancel { border-color: #3f3f46; color: #d1d5db; }
    .lf-delete-confirm {
      flex: 1; padding: 9px; border-radius: 10px; border: none;
      background: #dc2626; color: #fff;
      font-size: 14px; font-weight: 600; cursor: pointer;
      transition: background 0.15s;
    }
    .lf-delete-confirm:hover { background: #b91c1c; }

    /* ── Image preview (form) ── */
    #lf-img-preview-wrap { position: relative; display: none; margin-top: 8px; }
    #lf-img-preview-wrap.visible { display: block; }
    #lf-img-preview {
      width: 100%; max-height: 200px; object-fit: cover;
      border-radius: 10px; border: 1px solid #e5e7eb; display: block;
    }
    body.dark-mode #lf-img-preview { border-color: #3f3f46; }
    #lf-img-clear {
      position: absolute; top: 6px; right: 6px;
      width: 24px; height: 24px; border-radius: 50%;
      background: rgba(0,0,0,0.65);
      border: 1px solid rgba(255,255,255,0.15);
      color: #e4e4e7; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; line-height: 1; transition: color 0.15s;
    }
    #lf-img-clear:hover { color: #f87171; }

    /* ── Char counter ── */
    .lf-field-wrap { position: relative; }
    .lf-char-hint {
      position: absolute; bottom: 9px; right: 10px;
      font-size: 11px; color: #9ca3af; pointer-events: none;
    }
    .lf-char-hint.warn { color: #f59e0b; }
    .lf-char-hint.over { color: #ef4444; }

    /* ── Submit progress ── */
    .lf-submit-progress {
      width: 100%; height: 3px; background: #e5e7eb;
      border-radius: 2px; overflow: hidden;
      margin-top: 10px; display: none;
    }
    .lf-submit-progress.visible { display: block; }
    .lf-submit-progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #6366f1, #8b5cf6);
      border-radius: 2px; width: 0%;
      transition: width 0.3s ease;
    }
    body.dark-mode .lf-submit-progress { background: #27272a; }
  `;
  document.head.appendChild(s);
}

// ─── Lightbox ────────────────────────────────────────────────────────────────

function initLightbox() {
  if (document.getElementById('lf-lightbox')) return;
  const lb = document.createElement('div');
  lb.id = 'lf-lightbox';
  lb.setAttribute('role', 'dialog');
  lb.setAttribute('aria-label', 'Media viewer');
  document.body.appendChild(lb);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lb.classList.contains('open')) lb.classList.remove('open');
    if (e.key === 'ArrowLeft')  lb.querySelector('.lf-lb-prev')?.click();
    if (e.key === 'ArrowRight') lb.querySelector('.lf-lb-next')?.click();
  });
}

function openLightbox(mediaItems, startIndex = 0) {
  const items = Array.isArray(mediaItems)
    ? mediaItems.filter(m => m?.url)
    : [{ url: mediaItems, type: 'image' }];
  if (!items.length) return;

  let current = startIndex;

  // Use a dynamically created overlay (same pattern as posts.js) so we can
  // safely remove it on close rather than fighting with classList.
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:99999;
    display:flex;align-items:center;justify-content:center;
    animation:lf-lb-in 0.2s ease;
  `;

  function render() {
    const m = items[current];
    const isVideo = m.type === 'video';
    const navPrev = current > 0
      ? `<button class="lf-lb-nav lf-lb-prev" aria-label="Previous">‹</button>` : '';
    const navNext = current < items.length - 1
      ? `<button class="lf-lb-nav lf-lb-next" aria-label="Next">›</button>` : '';

    overlay.innerHTML = `
      <div style="position:absolute;inset:0;background:rgba(0,0,0,0.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);"></div>
      <div style="position:relative;z-index:1;display:flex;align-items:center;justify-content:center;animation:lf-lb-scale 0.2s ease;">
        <button class="lf-lb-close" aria-label="Close">✕</button>
        <div class="lf-lb-media">
          ${isVideo ? `
            <div class="lf-vid-wrap" style="border-radius:12px;overflow:hidden;background:#000;max-width:90vw;max-height:80vh;width:min(900px,90vw);height:min(500px,80vh);">
              <video src="${sanitize(m.url)}" controls autoplay
                     style="position:relative;width:100%;height:100%;object-fit:contain;"></video>
            </div>
          ` : `
            <img src="${sanitize(m.url)}" alt="Media ${current + 1}"
                 style="max-width:90vw;max-height:80vh;border-radius:12px;object-fit:contain;box-shadow:0 24px 64px rgba(0,0,0,0.5);" />
          `}
        </div>
        ${navPrev}${navNext}
        ${items.length > 1 ? `<div class="lf-lb-counter">${current + 1} / ${items.length}</div>` : ''}
      </div>
    `;
    overlay.querySelector('.lf-lb-close')?.addEventListener('click', close);
    overlay.querySelector('div')?.addEventListener('click', (e) => { if (e.target === overlay.querySelector('div')) close(); });
    overlay.querySelector('.lf-lb-prev')?.addEventListener('click', (e) => { e.stopPropagation(); current--; render(); });
    overlay.querySelector('.lf-lb-next')?.addEventListener('click', (e) => { e.stopPropagation(); current++; render(); });
  }

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', keyHandler);
  }
  function keyHandler(e) {
    if (!document.body.contains(overlay)) { document.removeEventListener('keydown', keyHandler); return; }
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft'  && current > 0)               { current--; render(); }
    if (e.key === 'ArrowRight' && current < items.length - 1) { current++; render(); }
  }

  render();
  document.addEventListener('keydown', keyHandler);
  document.body.appendChild(overlay);
}



// ─── Message modal ────────────────────────────────────────────────────────────

function initMessageModal() {
  if (document.getElementById('lf-msg-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'lf-msg-overlay';
  overlay.className = 'lf-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'lf-msg-title');
  overlay.innerHTML = `
    <div id="lf-msg-box">
      <div class="lf-msg-header">
        <h3 class="lf-msg-title" id="lf-msg-title">Message owner</h3>
        <button class="lf-msg-close" id="lf-msg-close-btn" aria-label="Close">✕</button>
      </div>
      <p class="lf-msg-to" id="lf-msg-to-label"></p>
      <textarea class="lf-msg-textarea" id="lf-msg-textarea"
        placeholder="Write your message…" rows="4" maxlength="800"></textarea>
      <button class="lf-msg-send" id="lf-msg-send-btn">Send message</button>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => {
    overlay.classList.remove('open');
    document.getElementById('lf-msg-textarea').value = '';
  };
  document.getElementById('lf-msg-close-btn').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) close();
  });
}

function openMessageModal(item, docId) {
  if (!currentUser) {
    showToast('Sign in to message the owner.', 'error');
    return;
  }
  const ownerEmail = item.authorEmail || item.email || '';
  if (ownerEmail && ownerEmail === currentUser.email) {
    showToast('This is your own post.', 'info');
    return;
  }
  if (!ownerEmail) {
    showToast('No contact info available for this post.', 'info');
    return;
  }
  const overlay  = document.getElementById('lf-msg-overlay');
  const toLabel  = document.getElementById('lf-msg-to-label');
  const sendBtn  = document.getElementById('lf-msg-send-btn');
  const textarea = document.getElementById('lf-msg-textarea');
  if (!overlay || !toLabel || !sendBtn || !textarea) return;

  toLabel.textContent = `To: ${ownerEmail}  ·  Re: "${item.name}"`;
  overlay.classList.add('open');
  textarea.focus();

  // Replace button to remove any previous click listener
  const fresh = sendBtn.cloneNode(true);
  sendBtn.replaceWith(fresh);
  fresh.addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (!text) { textarea.focus(); return; }
    fresh.disabled = true;
    fresh.textContent = 'Sending…';
    try {
      await addDoc(collection(db, 'messages'), {
        to:          ownerEmail,
        from:        currentUser.email,
        fromName:    currentUser.displayName || currentUser.name || currentUser.email,
        subject:     `Re: Lost & Found — ${item.name}`,
        body:        text,
        refDocId:    docId,
        refItemName: item.name,
        read:        false,
        timestamp:   serverTimestamp(),
      });
      showToast('Message sent!', 'success');
      overlay.classList.remove('open');
      textarea.value = '';
    } catch (err) {
      console.error('[LF] Message send error:', err);
      showToast('Failed to send message. Try again.', 'error');
      fresh.disabled = false;
      fresh.textContent = 'Send message';
    }
  });
}

// ─── Resolve modal ────────────────────────────────────────────────────────────

function initResolveModal() {
  if (document.getElementById('lf-resolve-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'lf-resolve-overlay';
  overlay.className = 'lf-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div id="lf-resolve-box">
      <div class="lf-resolve-icon">✅</div>
      <h3 class="lf-resolve-title">Mark as resolved?</h3>
      <p class="lf-resolve-desc">This item will be marked resolved and automatically removed after 24 hours.</p>
      <div class="lf-resolve-btns">
        <button class="lf-resolve-cancel" id="lf-resolve-cancel">Cancel</button>
        <button class="lf-resolve-confirm" id="lf-resolve-confirm">Yes, resolved</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.classList.remove('open');
  document.getElementById('lf-resolve-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) close();
  });
}

function openResolveModal(docId, onConfirmed) {
  const overlay = document.getElementById('lf-resolve-overlay');
  if (!overlay) return;
  overlay.classList.add('open');
  const confirmBtn = document.getElementById('lf-resolve-confirm');
  const fresh = confirmBtn.cloneNode(true);
  confirmBtn.replaceWith(fresh);
  fresh.addEventListener('click', async () => {
    fresh.disabled = true;
    fresh.textContent = 'Saving…';
    try {
      const resolvedAtMs = Date.now();
      await updateDoc(doc(db, COLLECTION, docId), {
        resolved:     true,
        resolvedAt:   serverTimestamp(),
        resolvedAtMs: resolvedAtMs,
      });
      overlay.classList.remove('open');
      showToast('Marked as resolved. Item will be removed in 24 hours.', 'success');
      onConfirmed?.();
    } catch (err) {
      console.error('[LF] Resolve error:', err);
      showToast('Failed to update. Try again.', 'error');
      fresh.disabled = false;
      fresh.textContent = 'Yes, resolved';
    }
  });
}

// ─── Delete modal ─────────────────────────────────────────────────────────────

function initDeleteModal() {
  if (document.getElementById('lf-delete-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'lf-delete-overlay';
  overlay.className = 'lf-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div id="lf-delete-box">
      <div class="lf-delete-icon">🗑️</div>
      <h3 class="lf-delete-title">Delete this post?</h3>
      <p class="lf-delete-desc">This action cannot be undone. The item will be permanently removed.</p>
      <div class="lf-delete-btns">
        <button class="lf-delete-cancel" id="lf-delete-cancel">Cancel</button>
        <button class="lf-delete-confirm" id="lf-delete-confirm">Delete</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.classList.remove('open');
  document.getElementById('lf-delete-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) close();
  });
}

function openDeleteModal(docId, onConfirmed) {
  const overlay = document.getElementById('lf-delete-overlay');
  if (!overlay) return;
  overlay.classList.add('open');
  const confirmBtn = document.getElementById('lf-delete-confirm');
  const fresh = confirmBtn.cloneNode(true);
  confirmBtn.replaceWith(fresh);
  fresh.addEventListener('click', async () => {
    fresh.disabled = true;
    fresh.textContent = 'Deleting…';
    try {
      await deleteDoc(doc(db, COLLECTION, docId));
      overlay.classList.remove('open');
      showToast('Post deleted.', 'success');
      onConfirmed?.();
    } catch (err) {
      console.error('[LF] Delete error:', err);
      showToast(
        err?.code === 'permission-denied' ? 'Permission denied.' : 'Delete failed. Try again.',
        'error'
      );
      fresh.disabled = false;
      fresh.textContent = 'Delete';
    }
  });
}

// ─── Edit modal (owner / admin only) ──────────────────────────────────────────

function initEditModal() {
  if (document.getElementById('lf-edit-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'lf-edit-overlay';
  overlay.className = 'lf-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'lf-edit-title');
  overlay.innerHTML = `
    <div id="lf-edit-box">
      <div class="lf-msg-header">
        <h3 class="lf-msg-title" id="lf-edit-title">Edit post</h3>
        <button class="lf-msg-close" id="lf-edit-close-btn" aria-label="Close">✕</button>
      </div>
      <label class="lf-edit-label" for="lf-edit-name">Item name</label>
      <input class="lf-edit-input" id="lf-edit-name" type="text" maxlength="120">

      <label class="lf-edit-label" for="lf-edit-status">Status</label>
      <select class="lf-edit-input" id="lf-edit-status">
        <option value="Lost">Lost</option>
        <option value="Found">Found</option>
      </select>

      <label class="lf-edit-label" for="lf-edit-description">Description</label>
      <textarea class="lf-msg-textarea" id="lf-edit-description" rows="3" maxlength="${DESC_MAX}"></textarea>

      <label class="lf-edit-label" for="lf-edit-phone">Phone</label>
      <input class="lf-edit-input" id="lf-edit-phone" type="tel">

      <label class="lf-edit-label" for="lf-edit-email">Contact email</label>
      <input class="lf-edit-input" id="lf-edit-email" type="email">

      <label class="lf-edit-label" for="lf-edit-photo">Replace photo (optional)</label>
      <input class="lf-edit-input" id="lf-edit-photo" type="file" accept="image/*">

      <button class="lf-msg-send" id="lf-edit-save-btn">Save changes</button>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.classList.remove('open');
  document.getElementById('lf-edit-close-btn').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) close();
  });
}

function openEditModal(docId, item) {
  if (!currentUser) { showToast('Sign in to edit this post.', 'error'); return; }

  // Defense in depth: the Firestore security rules are the real enforcement,
  // but checking here avoids a pointless round-trip and a confusing
  // permission-denied toast for someone who isn't allowed to edit anyway.
  const isOwner = item.authorEmail === currentUser.email || item.authorUid === currentUser.uid;
  const isAdmin = currentUser.role === 'admin';
  if (!isOwner && !isAdmin) {
    showToast('You can only edit your own posts.', 'error');
    return;
  }

  const overlay = document.getElementById('lf-edit-overlay');
  if (!overlay) return;

  document.getElementById('lf-edit-name').value        = item.name || '';
  document.getElementById('lf-edit-status').value       = item.status || 'Lost';
  document.getElementById('lf-edit-description').value  = item.description || '';
  document.getElementById('lf-edit-phone').value        = item.phone || '';
  document.getElementById('lf-edit-email').value        = item.contactEmail || '';
  const photoInput = document.getElementById('lf-edit-photo');
  if (photoInput) photoInput.value = '';

  overlay.classList.add('open');

  const saveBtn = document.getElementById('lf-edit-save-btn');
  const fresh = saveBtn.cloneNode(true);
  saveBtn.replaceWith(fresh);
  fresh.addEventListener('click', async () => {
    if (_editSubmitting) return;
    const name = document.getElementById('lf-edit-name').value.trim();
    const phone = document.getElementById('lf-edit-phone').value.trim();
    const email = document.getElementById('lf-edit-email').value.trim();
    if (!name) { showToast('Item name is required.', 'error'); return; }
    if (!phone && !email) { showToast('Provide at least a phone number or email.', 'error'); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showToast('Enter a valid email address.', 'error');
      return;
    }

    _editSubmitting = true;
    fresh.disabled = true;
    fresh.textContent = 'Saving…';

    try {
      const update = {
        name,
        status:       document.getElementById('lf-edit-status').value,
        description:  document.getElementById('lf-edit-description').value.trim(),
        phone,
        contactEmail: email,
        editedAt:     serverTimestamp(),
      };

      const file = document.getElementById('lf-edit-photo')?.files[0] ?? null;
      if (file) {
        if (!file.type.startsWith('image/')) {
          showToast('Only image files are accepted.', 'error');
          throw new Error('invalid-file-type');
        }
        if (file.size > MAX_FILE_MB * 1024 * 1024) {
          showToast(`Photo must be under ${MAX_FILE_MB} MB.`, 'error');
          throw new Error('file-too-large');
        }
        fresh.textContent = 'Uploading photo…';
        update.imageSrc = await uploadImage(file, 'lostfound');
      }

      await updateDoc(doc(db, COLLECTION, docId), update);
      overlay.classList.remove('open');
      showToast('Post updated.', 'success');
    } catch (err) {
      if (err?.message !== 'invalid-file-type' && err?.message !== 'file-too-large') {
        console.error('[LF] Edit error:', err);
        showToast(
          err?.code === 'permission-denied' ? 'Permission denied.' : 'Failed to save changes. Try again.',
          'error'
        );
      }
    } finally {
      _editSubmitting = false;
      fresh.disabled = false;
      fresh.textContent = 'Save changes';
    }
  });
}

// ─── Report-content (non-owners) ──────────────────────────────────────────────
//
// This app already has a single canonical reporting system: window.openReportModal,
// registered by ui/templates.js, which posts.js/comments.js also use. It already
// has duplicate-report prevention and a field contract that exactly matches what
// admin.js's moderation queue reads. Lost & Found just needs to call into it with
// contentType 'lostFound' — admin.js's collectionMap already maps that to
// 'lost_found' — rather than maintaining a second, divergent report UI/schema.

function reportItem(docId, item) {
  if (!currentUser) { showToast('Sign in to report a post.', 'error'); return; }

  const isOwner = item.authorEmail === currentUser.email || item.authorUid === currentUser.uid;
  if (isOwner) { showToast("You can't report your own post.", 'info'); return; }

  if (typeof window.openReportModal !== 'function') {
    console.error('[LF] window.openReportModal is not available — check that ui/templates.js loaded.');
    showToast('Reporting is temporarily unavailable. Try refreshing the page.', 'error');
    return;
  }

  // (contentId, contentType, postId, replyId) — lost_found posts are top-level
  // documents, so postId is just the same id and replyId is unused.
  window.openReportModal(docId, 'lostFound', docId, null);
}

// ─── Share ──────────────────────────────────────────────────────────────────

async function shareItem(docId, item) {
  const url = `${location.origin}${location.pathname}#lost-found/${docId}`;
  const shareData = {
    title: `${item.status}: ${item.name}`,
    text:  `Check out this ${item.status?.toLowerCase() || 'item'} post on Community Hub: ${item.name}`,
    url,
  };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
    } else {
      await navigator.clipboard.writeText(url);
      showToast('Link copied to clipboard!', 'success');
    }
  } catch (err) {
    // AbortError fires when the user dismisses the native share sheet — not a failure
    if (err?.name !== 'AbortError') {
      console.error('[LF] Share error:', err);
      showToast('Could not share this post.', 'error');
    }
  }
}



// ─── TTL sweep — owner/admin only to avoid permission errors ─────────────────

async function sweepResolvedItems(snapshot) {
  if (!currentUser) return;
  for (const snap of snapshot.docs) {
    const data = snap.data();
    if (!data.resolved) continue;
    const isOwner = data.authorEmail === currentUser.email ||
                    data.authorUid   === currentUser.uid;
    const isAdmin = currentUser?.role === 'admin';
    if (!isOwner && !isAdmin) continue;
    const resolvedAtMs = getResolvedAtMs(data);
    if (resolvedAtMs && Date.now() - resolvedAtMs > RESOLVE_TTL_MS) {
      // Guard against the same client issuing a second delete for a doc that's
      // already mid-flight (e.g. a rapid double snapshot event), and against
      // wasted network calls once another client has already removed it.
      if (_sweepInFlight.has(snap.id)) continue;
      _sweepInFlight.add(snap.id);
      try {
        await deleteDoc(doc(db, COLLECTION, snap.id));
      } catch (e) {
        // not-found / already-deleted is expected when another owner/admin
        // client won the race — anything else is worth a console warning.
        console.warn('[LF] Auto-delete skipped:', snap.id, e?.code);
      } finally {
        _sweepInFlight.delete(snap.id);
      }
    }
  }
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function getToastContainer() {
  let el = document.getElementById('lf-toast-container');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lf-toast-container';
    document.body.appendChild(el);
  }
  return el;
}

function showToast(message, type = 'info') {
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = `lf-toast lf-toast--${type}`;
  toast.innerHTML = `<span>${icons[type] ?? 'ℹ'}</span><span>${sanitize(message)}</span>`;
  getToastContainer().appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hiding');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, TOAST_MS);
}

// ─── Skeletons ───────────────────────────────────────────────────────────────

function renderSkeletons(feed, count = 6) {
  feed.innerHTML = Array.from({ length: count }, () => `
    <div class="lf-skeleton" aria-hidden="true">
      <div class="lf-skel-img"></div>
      <div class="lf-skel-body">
        <div class="lf-skel-line" style="height:16px;width:55%"></div>
        <div class="lf-skel-line" style="height:12px;width:95%"></div>
        <div class="lf-skel-line" style="height:12px;width:80%"></div>
        <div class="lf-skel-line" style="height:12px;width:60%;margin-top:6px"></div>
        <div class="lf-skel-line" style="height:30px;width:100%;margin-top:10px;border-radius:10px"></div>
      </div>
    </div>
  `).join('');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatRelativeTime(ts) {
  if (!ts) return '';
  const date = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
  const diff  = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Safely read resolvedAtMs from either the number field or a Firestore Timestamp
function getResolvedAtMs(item) {
  if (typeof item.resolvedAtMs === 'number') return item.resolvedAtMs;
  if (item.resolvedAt && typeof item.resolvedAt.toMillis === 'function') {
    return item.resolvedAt.toMillis();
  }
  return 0;
}

function formatTtlRemaining(resolvedAtMs) {
  if (!resolvedAtMs) return '';
  const remaining = RESOLVE_TTL_MS - (Date.now() - resolvedAtMs);
  if (remaining <= 0) return 'Deleting soon…';
  const hrs  = Math.floor(remaining / 3600000);
  if (hrs > 0) return `Removes in ~${hrs}h`;
  const mins = Math.ceil(remaining / 60000);
  return `Removes in ~${mins}m`;
}

// Update TTL labels on resolved cards every minute without a full re-render
function startTtlRefresh(feed) {
  if (_ttlTimer) clearInterval(_ttlTimer);
  _ttlTimer = setInterval(() => {
    feed.querySelectorAll('.lf-ttl-note[data-resolved-at]').forEach(el => {
      const ms = parseInt(el.dataset.resolvedAt, 10);
      if (!isNaN(ms)) el.textContent = formatTtlRemaining(ms);
    });
  }, 60_000);
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add('copied');
    btn.textContent = '✓';
    setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '⎘'; }, 1800);
  } catch {
    showToast('Could not copy to clipboard.', 'error');
  }
}
function _lfGoToSlide(car, index) {
  const track   = car.querySelector('.lf-car-track');
  const counter = car.querySelector('.lf-car-counter');
  const count   = parseInt(car.dataset.count, 10);
  if (!track || index < 0 || index >= count) return;
  car.dataset.current = index;
  track.style.transform = `translateX(-${index * 100}%)`;
  if (counter) counter.textContent = `${index + 1} / ${count}`;
  car.querySelectorAll('.lf-car-dot').forEach((d, i) => d.classList.toggle('active', i === index));
  // pause non-active videos
  car.querySelectorAll('.lf-carousel-slide').forEach((slide, i) => {
    const v = slide.querySelector('video');
    if (v && i !== index) v.pause();
  });
  // init full video player on active slide if not yet done
  const activeSlide = car.querySelectorAll('.lf-carousel-slide')[index];
  const activeVidWrap = activeSlide?.querySelector('.lf-vid-wrap');
  if (activeVidWrap) _lfInitVideo(activeVidWrap);
}

function _lfInitVideo(wrapper) {
  if (wrapper.dataset.playerInit) return;
  wrapper.dataset.playerInit = '1';
  const video = wrapper.querySelector('video');
  if (!video) return;

  // Remove old simple play button if present
  wrapper.querySelector('.lf-vid-play-btn')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'lf-vid-overlay';
  overlay.innerHTML = `
    <div class="lf-vid-play-btn" aria-label="Play/Pause">
      <svg class="lf-vid-icon-play" viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M8 5v14l11-7z"/></svg>
      <svg class="lf-vid-icon-pause hidden" viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
    </div>`;

  const controls = document.createElement('div');
  controls.className = 'lf-vid-controls';
  controls.innerHTML = `
    <button class="lf-vid-ctrl-btn lf-vid-toggle-btn" aria-label="Play/Pause">
      <svg class="lf-vid-icon-play" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M8 5v14l11-7z"/></svg>
      <svg class="lf-vid-icon-pause hidden" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
    </button>
    <div class="lf-vid-progress-wrap">
      <div class="lf-vid-progress-bar">
        <div class="lf-vid-progress-fill"></div>
        <div class="lf-vid-progress-thumb"></div>
      </div>
    </div>
    <span class="lf-vid-time">0:00</span>
    <button class="lf-vid-ctrl-btn lf-vid-mute-btn" aria-label="Mute/Unmute">
      <svg class="lf-vid-icon-unmuted" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
        <path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
      </svg>
      <svg class="lf-vid-icon-muted hidden" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
        <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
      </svg>
    </button>
    <button class="lf-vid-ctrl-btn lf-vid-fullscreen-btn" aria-label="Fullscreen">
      <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
    </button>`;

  wrapper.appendChild(overlay);
  wrapper.appendChild(controls);

  const playBtnOverlay = overlay.querySelector('.lf-vid-play-btn');
  const toggleBtn      = controls.querySelector('.lf-vid-toggle-btn');
  const muteBtn        = controls.querySelector('.lf-vid-mute-btn');
  const fsBtn          = controls.querySelector('.lf-vid-fullscreen-btn');
  const fill           = controls.querySelector('.lf-vid-progress-fill');
  const thumb          = controls.querySelector('.lf-vid-progress-thumb');
  const timeEl         = controls.querySelector('.lf-vid-time');
  const progressWrap   = controls.querySelector('.lf-vid-progress-bar');

  function fmtTime(s) {
    const m = Math.floor(s / 60);
    return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  }
  function syncPlayIcons(playing) {
    [overlay, controls].forEach(el => {
      el.querySelectorAll('.lf-vid-icon-play').forEach(i => i.classList.toggle('hidden', playing));
      el.querySelectorAll('.lf-vid-icon-pause').forEach(i => i.classList.toggle('hidden', !playing));
    });
    overlay.classList.toggle('lf-vid-overlay--paused', !playing);
  }
  function syncMuteIcons(muted) {
    muteBtn.querySelector('.lf-vid-icon-unmuted').classList.toggle('hidden', muted);
    muteBtn.querySelector('.lf-vid-icon-muted').classList.toggle('hidden', !muted);
  }
  function togglePlay() { video.paused ? video.play() : video.pause(); }

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
    video.currentTime = ((e.clientX - rect.left) / rect.width) * video.duration;
  });
  playBtnOverlay.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
  toggleBtn.addEventListener('click',      (e) => { e.stopPropagation(); togglePlay(); });
  overlay.addEventListener('click',        (e) => { if (e.target === overlay) togglePlay(); });
  video.muted = true;
  syncMuteIcons(true);
  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    video.muted = !video.muted;
    syncMuteIcons(video.muted);
  });
  fsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (document.fullscreenElement) document.exitFullscreen?.();
    else wrapper.requestFullscreen?.() || video.webkitRequestFullscreen?.();
  });
  // Pause when scrolled out of view
  const obs = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting && !video.paused) video.pause();
  }, { threshold: 0.2 });
  obs.observe(wrapper);
  const removalObs = new MutationObserver(() => {
    if (!document.contains(video)) { obs.disconnect(); removalObs.disconnect(); }
  });
  removalObs.observe(document.body, { childList: true, subtree: true });
  syncPlayIcons(false);
}
// ─── Card builder ─────────────────────────────────────────────────────────────

function buildCard(id, item, user) {
  const isLost       = item.status === 'Lost';
  const isResolved   = !!item.resolved;
  const resolvedAtMs = getResolvedAtMs(item);
  const desc         = (item.description || '').trim();
  const isLong       = desc.length > DESC_CLAMP_CHARS;
  const ts           = formatRelativeTime(item.timestamp);

  const isOwner = user && (
    item.authorEmail === user.email ||
    item.authorUid   === user.uid
  );
  const isAdmin    = user?.role === 'admin';
  const canResolve = (isOwner || isAdmin) && !isResolved;
  const canDelete  = isOwner || isAdmin;
  const canEdit    = isOwner || isAdmin;
  // Any signed-in non-owner can message (even on resolved items)
  const canMessage = user && !isOwner;
  // Any signed-in non-owner can report; owners/admins moderate via the panel instead
  const canReport  = user && !isOwner;
  // Sharing is always available — no sign-in required
  const canShare   = true;

  // ── Image/Media block — supports multiple images + videos ──
  const mediaItems = item.mediaItems?.length
    ? item.mediaItems
    : (item.imageSrc ? [{ url: item.imageSrc, type: 'image' }] : []);

  let imgBlock;
  if (mediaItems.length === 0) {
    imgBlock = `<div class="lf-card-no-img" aria-hidden="true">${isLost ? '🔍' : '📦'}</div>`;
  } else if (mediaItems.length === 1 && mediaItems[0].type === 'image') {
    imgBlock = `<div class="lf-card-img-wrap" role="button" tabindex="0"
        aria-label="View full image of ${sanitize(item.name)}"
        data-lf-media='${JSON.stringify(mediaItems)}'
        data-lf-media-index="0">
      <img src="${sanitize(mediaItems[0].url)}" class="lf-card-img"
           alt="${sanitize(item.name)}" loading="lazy">
      <span class="lf-zoom-hint" aria-hidden="true">Tap to expand</span>
    </div>`;
  } else {
    // Multi-media carousel
    const carId = 'lf-car-' + id;
    const count = mediaItems.length;
    const slides = mediaItems.map((m, i) => {
      if (m.type === 'video') {
        return `<div class="lf-carousel-slide" data-index="${i}">
          <div class="lf-vid-wrap">
            <video src="${sanitize(m.url)}" preload="metadata" playsinline muted
                   style="width:100%;height:100%;object-fit:cover;display:block;"></video>
          </div>
        </div>`;
      }
      return `<div class="lf-carousel-slide media-cell--image" data-index="${i}"
                   data-lf-media='${JSON.stringify(mediaItems)}' data-lf-media-index="${i}"
                   style="cursor:zoom-in;">
        <img src="${sanitize(m.url)}" alt="Media ${i+1}" loading="lazy"
             style="width:100%;height:100%;object-fit:cover;display:block;" />
      </div>`;
    }).join('');

    const dots = count > 1
      ? `<div class="lf-car-dots">${mediaItems.map((_, i) =>
          `<span class="lf-car-dot${i===0?' active':''}" data-dot="${i}"></span>`
        ).join('')}</div>` : '';

    imgBlock = `<div class="lf-carousel" id="${carId}" data-current="0" data-count="${count}"
                     data-lf-media='${JSON.stringify(mediaItems)}'>
      <div class="lf-car-track">${slides}</div>
      ${count > 1 ? `
        <button class="lf-car-arrow lf-car-prev" aria-label="Previous">‹</button>
        <button class="lf-car-arrow lf-car-next" aria-label="Next">›</button>
        <span class="lf-car-counter">1 / ${count}</span>
        ${dots}` : dots}
    </div>`;
  }

  // ── Resolved banner — shown to ALL users when item is resolved ──
  const resolvedBanner = isResolved
    ? `<div class="lf-resolved-banner" role="status">
         <span>✅ Resolved</span>
         ${resolvedAtMs
           ? `<span class="lf-ttl-note" data-resolved-at="${resolvedAtMs}">${formatTtlRemaining(resolvedAtMs)}</span>`
           : ''}
       </div>`
    : '';

  // ── Contact rows ──
  const phone = item.phone
    ? `<div class="lf-contact-row">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.89 13.5 19.79 19.79 0 0 1 1.84 5a2 2 0 0 1 1.99-2H6a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.09 10.9a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21 18z"/>
        </svg>
        <a href="tel:${sanitize(item.phone)}" aria-label="Call ${sanitize(item.phone)}">${sanitize(item.phone)}</a>
        <button class="lf-copy-btn" data-copy="${sanitize(item.phone)}" aria-label="Copy phone" title="Copy">⎘</button>
      </div>`
    : '';

  const emailRow = item.contactEmail
    ? `<div class="lf-contact-row">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
          <polyline points="22,6 12,13 2,6"/>
        </svg>
        <a href="mailto:${sanitize(item.contactEmail)}">${sanitize(item.contactEmail)}</a>
        <button class="lf-copy-btn" data-copy="${sanitize(item.contactEmail)}" aria-label="Copy email" title="Copy">⎘</button>
      </div>`
    : '';

  const authorRow = item.authorEmail
    ? `<div class="lf-author-row">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
        <span>${sanitize(item.authorEmail)}</span>
      </div>`
    : '';

  // ── Action buttons ──
  const messageBtn = canMessage
    ? `<button class="lf-action-btn lf-btn--message lf-msg-trigger"
             data-doc-id="${id}"
             aria-label="Message owner of ${sanitize(item.name)}">
         <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
         </svg>
         Message owner
       </button>`
    : '';

  let resolveBtn = '';
  if (canResolve) {
    resolveBtn = `<button class="lf-action-btn lf-btn--resolve lf-resolve-trigger"
                          data-doc-id="${id}"
                          aria-label="Mark ${sanitize(item.name)} as resolved">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    Mark resolved
                  </button>`;
  } else if (isResolved) {
    // Show resolved badge to ALL users — owner and non-owner alike
    resolveBtn = `<span class="lf-action-btn lf-btn--resolved-state" aria-label="Item is resolved">
                    ✅ Resolved
                  </span>`;
  }

  const deleteBtn = canDelete
    ? `<button class="lf-action-btn lf-btn--delete lf-delete-trigger"
             data-doc-id="${id}"
             aria-label="Delete post for ${sanitize(item.name)}">
         <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <polyline points="3 6 5 6 21 6"/>
           <path d="M19 6l-1 14H6L5 6"/>
           <path d="M10 11v6"/><path d="M14 11v6"/>
           <path d="M9 6V4h6v2"/>
         </svg>
         Delete
       </button>`
    : '';

  const editBtn = canEdit
    ? `<button class="lf-action-btn lf-btn--edit lf-edit-trigger"
             data-doc-id="${id}"
             aria-label="Edit post for ${sanitize(item.name)}">
         <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
           <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
         </svg>
         Edit
       </button>`
    : '';

  const shareBtn = canShare
    ? `<button class="lf-action-btn lf-btn--share lf-share-trigger"
             data-doc-id="${id}"
             aria-label="Share post for ${sanitize(item.name)}">
         <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
           <path d="M8.6 13.5l6.8 4M15.4 6.5L8.6 10.5"/>
         </svg>
         Share
       </button>`
    : '';

  const reportBtn = canReport
    ? `<button class="lf-action-btn lf-btn--report lf-report-trigger"
             data-doc-id="${id}"
             aria-label="Report post for ${sanitize(item.name)}">
         <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
           <line x1="4" y1="22" x2="4" y2="15"/>
         </svg>
         Report
       </button>`
    : '';

  const hasActions = messageBtn || resolveBtn || deleteBtn || editBtn || shareBtn || reportBtn;

  const timestampAttr = typeof item.timestamp?.toDate === 'function'
    ? item.timestamp.toDate().toLocaleString()
    : '';

  return `
    <article class="lf-card${isResolved ? ' resolved-card' : ''}"
             data-id="${id}"
             data-status="${sanitize(item.status)}"
             data-name="${sanitize(item.name).toLowerCase()}"
             data-resolved="${isResolved ? '1' : '0'}"
             aria-label="${sanitize(item.name)} — ${sanitize(item.status)}${isResolved ? ' (resolved)' : ''}">
      ${imgBlock}
      ${resolvedBanner}
      <div class="lf-card-body">
        <div class="lf-card-header">
          <h4 class="lf-card-title">${sanitize(item.name)}</h4>
          <span class="lf-badge ${isLost ? 'lf-badge--lost' : 'lf-badge--found'}"
                aria-label="Status: ${sanitize(item.status)}">${sanitize(item.status)}</span>
        </div>

        ${desc ? `
          <p class="lf-card-desc${isLong ? ' clamped' : ''}" id="desc-${id}">${sanitize(desc)}</p>
          ${isLong
            ? `<button class="lf-expand-btn" data-target="desc-${id}"
                       aria-expanded="false" aria-controls="desc-${id}">See more</button>`
            : ''}
        ` : ''}

        ${hasActions ? `
          <div class="lf-card-actions">
            <div class="lf-action-row">
              ${messageBtn}
              ${resolveBtn}
            </div>
            ${(editBtn || shareBtn || reportBtn) ? `
            <div class="lf-action-row">
              ${editBtn}
              ${shareBtn}
              ${reportBtn}
            </div>` : ''}
            ${deleteBtn ? `<div class="lf-action-row">${deleteBtn}</div>` : ''}
          </div>
        ` : ''}

        <div class="lf-card-footer">
          ${phone}
          ${emailRow}
          ${authorRow}
          ${ts ? `<span class="lf-timestamp" title="${timestampAttr}">${ts}</span>` : ''}
        </div>
      </div>
    </article>`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function setupLostFound() {
  injectStyles();
  initLightbox();
  initMessageModal();
  initResolveModal();
  initDeleteModal();
  initEditModal();

  const feed       = document.getElementById('lost-found-feed');
  const formWrapper = document.getElementById('form-lost-found');
  const form       = formWrapper?.querySelector('form') ?? null;

  // ── Feed ─────────────────────────────────────────────────────────────────

  if (feed) {
    // Inject filter bar once, above the feed
    const filterBar = document.createElement('div');
    filterBar.className = 'lf-filters';
    filterBar.setAttribute('role', 'toolbar');
    filterBar.setAttribute('aria-label', 'Filter lost and found items');
    filterBar.innerHTML = `
      <button class="lf-filter-btn active" data-filter="all"      aria-pressed="true">All</button>
      <button class="lf-filter-btn"        data-filter="Lost"     aria-pressed="false">Lost</button>
      <button class="lf-filter-btn"        data-filter="Found"    aria-pressed="false">Found</button>
      <button class="lf-filter-btn"        data-filter="resolved" aria-pressed="false">Resolved</button>
      <span class="lf-count" id="lf-count" aria-live="polite" aria-atomic="true"></span>
      <div class="lf-search-wrap">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input class="lf-search" id="lf-search" type="search"
               placeholder="  Search items…" aria-label="Search lost and found items">
      </div>
    `;
    feed.parentElement?.insertBefore(filterBar, feed);

    let activeFilter = 'all';
    let searchQuery  = '';

    function applyFilters() {
      const cards = feed.querySelectorAll('.lf-card');
      let visible = 0;
      feed.querySelector('.lf-empty')?.remove();

      cards.forEach(card => {
        const status   = card.dataset.status;
        const resolved = card.dataset.resolved === '1';
        const name     = card.dataset.name || '';

        let matchFilter;
        if      (activeFilter === 'all')      matchFilter = !resolved;
        else if (activeFilter === 'resolved') matchFilter = resolved;
        else                                  matchFilter = status === activeFilter && !resolved;

        const show = matchFilter && (!searchQuery || name.includes(searchQuery));
        card.style.display = show ? '' : 'none';
        if (show) visible++;
      });

      const countEl = document.getElementById('lf-count');
      if (countEl) countEl.textContent = `${visible} item${visible !== 1 ? 's' : ''}`;

      if (visible === 0 && cards.length > 0) {
        feed.insertAdjacentHTML('beforeend', `
          <div class="lf-empty" role="status">
            <div class="lf-empty-icon">🔍</div>
            <h3>No matches</h3>
            <p>Try a different filter or search term.</p>
          </div>`);
      }
    }

    filterBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.lf-filter-btn');
      if (!btn) return;
      filterBar.querySelectorAll('.lf-filter-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      activeFilter = btn.dataset.filter;
      applyFilters();
    });

    document.getElementById('lf-search')?.addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      applyFilters();
    });

    // Show skeletons immediately while Firestore loads
    renderSkeletons(feed);

    // Re-render existing cards (without a Firestore round-trip) whenever the
    // signed-in user, or their role, changes. Needed so owner/admin-only
    // buttons show up immediately on login, without waiting on a fresh
    // network round-trip.
    function rerenderFromCache() {
      if (_itemCache.size === 0) return; // nothing loaded yet — the listener will handle it
      let html = '';
      for (const [docId, data] of _itemCache) {
        html += buildCard(docId, data, currentUser);
      }
      feed.innerHTML = html;
      applyFilters();
    }

    // ── Feed listener (restartable) ─────────────────────────────────────
    //
    // onSnapshot() is attached as soon as this page's JS runs — which can
    // happen BEFORE Firebase Auth finishes restoring/confirming the user's
    // session. If the Firestore rules require sign-in and the listener
    // attaches a moment too early, it throws permission-denied immediately.
    // Critically, the Firestore SDK does NOT silently retry a listener that
    // already errored — it's dead until something explicitly creates a new
    // one. That's exactly what caused "permission denied / unable to load
    // items at the time of signing in": the listener died before auth was
    // ready and never recovered even after sign-in succeeded a moment
    // later. The fix is to tear down and re-create the listener every time
    // the auth state changes (see the onCurrentUserChange subscription
    // below), not just re-render from whatever was already cached.
    function startFeedListener() {
      _feedUnsub?.();

      _feedUnsub = onSnapshot(
        query(collection(db, COLLECTION), orderBy('timestamp', 'desc')),
        (snapshot) => {
          // Sweep expired resolved items (owner/admin only)
          sweepResolvedItems(snapshot);

          if (snapshot.empty) {
            // Clear skeletons and any previous cards
            feed.innerHTML = `
              <div class="lf-empty" role="status">
                <div class="lf-empty-icon">📭</div>
                <h3>Nothing reported yet</h3>
                <p>Be the first to post a lost or found item.</p>
              </div>`;
            _itemCache.clear();
            const countEl = document.getElementById('lf-count');
            if (countEl) countEl.textContent = '0 items';
            return;
          }

          // ── Full re-render: clear everything (skeletons + old cards) then
          //    insert all cards at once. Simple, correct, and fast enough for
          //    real-world lost-and-found volumes (hundreds of items).
          _itemCache.clear();
          let html = '';
          snapshot.forEach(d => {
            _itemCache.set(d.id, d.data());
            html += buildCard(d.id, d.data(), currentUser);
          });
          feed.innerHTML = html;

          // Init video player on first slide of each carousel
          feed.querySelectorAll('.lf-carousel').forEach(car => {
            const firstVidWrap = car.querySelector('.lf-carousel-slide:first-child .lf-vid-wrap');
            if (firstVidWrap) _lfInitVideo(firstVidWrap);
          });

          applyFilters();
          startTtlRefresh(feed);
        },
        (err) => {
          console.error('[LF] Snapshot error:', err);
          // permission-denied right after page load almost always means this
          // listener started before auth was ready — it'll be retried
          // automatically once sign-in state changes (see below). If it
          // persists after the user is confirmed signed in, that's a real
          // Firestore rules problem — see firestore.rules.
          feed.innerHTML = err?.code === 'permission-denied'
            ? `
            <div class="lf-empty" role="alert">
              <div class="lf-empty-icon">🔒</div>
              <h3>Access denied</h3>
              <p>${currentUser
                  ? "Your account doesn't have permission to view these posts. Contact an admin if this seems wrong."
                  : 'Sign in to view Lost &amp; Found posts.'}</p>
            </div>`
            : `
            <div class="lf-empty" role="alert">
              <div class="lf-empty-icon">⚠️</div>
              <h3>Couldn't load items</h3>
              <p>Check your connection and try refreshing.</p>
            </div>`;
          // Only toast for genuine, post-sign-in permission problems — not
          // for the expected denial while a signed-out visitor is browsing,
          // and not for the brief pre-auth-ready blip this function now
          // recovers from automatically.
          if (err?.code === 'permission-denied' && currentUser) {
            showToast('Permission denied loading items.', 'error');
          } else if (err?.code !== 'permission-denied') {
            showToast('Failed to load items. Check your connection.', 'error');
          }
        }
      );
    }

    _userUnsubscribe?.(); // guard against setupLostFound() being called more than once
    _userUnsubscribe = onCurrentUserChange(() => {
      rerenderFromCache();   // instant: refresh owner/admin buttons from cache
      startFeedListener();   // robust: get a fresh, correctly-authenticated listener
    });

    // FIX: wait for Firebase Auth to confirm the token before opening the first
    // Firestore listener. Calling startFeedListener() immediately meant the snapshot
    // fired before request.auth was valid server-side → permission-denied.
    // onAuthStateChanged is the canonical signal that the JWT is ready.
    const _unsubLFAuth = onAuthStateChanged(auth, firebaseUser => {
      _unsubLFAuth(); // one-shot
      if (firebaseUser) startFeedListener();
    });

    // ── Delegated events ──────────────────────────────────────────────────

    feed.addEventListener('click', (e) => {
      // Copy to clipboard
      const copyBtn = e.target.closest('.lf-copy-btn');
      if (copyBtn) {
        copyToClipboard(copyBtn.dataset.copy, copyBtn);
        return;
      }

      // Expand / collapse description
      const expandBtn = e.target.closest('.lf-expand-btn');
      if (expandBtn) {
        const descEl = document.getElementById(expandBtn.dataset.target);
        if (!descEl) return;
        // toggle returns true when class was ADDED (i.e. now clamped again)
        const nowClamped = descEl.classList.toggle('clamped');
        expandBtn.textContent = nowClamped ? 'See more' : 'See less';
        expandBtn.setAttribute('aria-expanded', String(!nowClamped));
        return;
      }

      // Lightbox — single image wrap or carousel image slide
      const mediaEl = e.target.closest('[data-lf-media]');
      if (mediaEl && !e.target.closest('.lf-car-arrow') && !e.target.closest('.lf-car-dot')) {
        // Don't open lightbox if click is on video or its controls
        if (e.target.closest('.lf-vid-wrap') || e.target.closest('.lf-vid-controls') || e.target.closest('.lf-vid-overlay')) return;
        try {
          const items = JSON.parse(mediaEl.dataset.lfMedia);
          const idx   = parseInt(mediaEl.dataset.lfMediaIndex || '0', 10);
          openLightbox(items, idx);
        } catch { /* ignore parse errors */ }
        return;
      }

      // Carousel arrows
      const arrow = e.target.closest('.lf-car-arrow');
      if (arrow) {
        const car   = arrow.closest('.lf-carousel');
        if (!car) return;
        const cur   = parseInt(car.dataset.current, 10);
        const cnt   = parseInt(car.dataset.count, 10);
        const next  = arrow.classList.contains('lf-car-next')
          ? Math.min(cur + 1, cnt - 1)
          : Math.max(cur - 1, 0);
        _lfGoToSlide(car, next);
        return;
      }

      // Carousel dots
      const dot = e.target.closest('.lf-car-dot');
      if (dot) {
        const car = dot.closest('.lf-carousel');
        if (car) _lfGoToSlide(car, parseInt(dot.dataset.dot, 10));
        return;
      }

      // Message owner — reads from _itemCache, never from DOM
      const msgBtn = e.target.closest('.lf-msg-trigger');
      if (msgBtn) {
        const docId = msgBtn.dataset.docId;
        if (!docId) return;
        const item = _itemCache.get(docId);
        if (!item) { showToast('Item not found. Try refreshing.', 'error'); return; }
        openMessageModal(item, docId);
        return;
      }

      // Edit own/admin post — reads from _itemCache, never from DOM
      const editBtn = e.target.closest('.lf-edit-trigger');
      if (editBtn) {
        const docId = editBtn.dataset.docId;
        if (!docId) return;
        const item = _itemCache.get(docId);
        if (!item) { showToast('Item not found. Try refreshing.', 'error'); return; }
        openEditModal(docId, item);
        return;
      }

      // Share — works for signed-out visitors too
      const shareBtn = e.target.closest('.lf-share-trigger');
      if (shareBtn) {
        const docId = shareBtn.dataset.docId;
        const item = _itemCache.get(docId) || { name: 'item', status: 'Lost' };
        shareItem(docId, item);
        return;
      }

      // Report — non-owners only
      const reportBtn = e.target.closest('.lf-report-trigger');
      if (reportBtn) {
        const docId = reportBtn.dataset.docId;
        if (!docId) return;
        const item = _itemCache.get(docId);
        if (!item) { showToast('Item not found. Try refreshing.', 'error'); return; }
        reportItem(docId, item);
        return;
      }

      // Mark resolved
      const resolveBtn = e.target.closest('.lf-resolve-trigger');
      if (resolveBtn) {
        const docId = resolveBtn.dataset.docId;
        if (!docId) return;
        openResolveModal(docId, () => {
          // Optimistic UI — Firestore snapshot will confirm
          const card = feed.querySelector(`.lf-card[data-id="${docId}"]`);
          if (card) {
            card.classList.add('resolved-card');
            card.dataset.resolved = '1';
            resolveBtn.outerHTML =
              `<span class="lf-action-btn lf-btn--resolved-state">✅ Resolved</span>`;
            applyFilters();
          }
        });
        return;
      }

      // Delete
      const deleteBtn = e.target.closest('.lf-delete-trigger');
      if (deleteBtn) {
        const docId = deleteBtn.dataset.docId;
        if (!docId) return;
        openDeleteModal(docId, () => {
          // Optimistic removal — Firestore snapshot will confirm
          feed.querySelector(`.lf-card[data-id="${docId}"]`)?.remove();
          _itemCache.delete(docId);
          applyFilters();
        });
        return;
      }
    });

    // Keyboard: Space/Enter on image wrapper opens lightbox (preventDefault stops page scroll)
    feed.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const imgWrap = e.target.closest('[data-lightbox-src]');
      if (imgWrap) {
        e.preventDefault();
        openLightbox(imgWrap.dataset.lightboxSrc, imgWrap.dataset.lightboxAlt);
      }
    });
  }

  // ── Form ─────────────────────────────────────────────────────────────────

  if (!form) return;

  // ── Multi-media upload (images + videos, up to 6 files) — dropzone ──
  const photoInput  = document.getElementById('item-photo');
  const dropzone    = document.getElementById('lf-media-dropzone');
  const previewGrid = document.getElementById('lf-media-preview-grid');

  const _lfFiles = [];

  function renderLfPreview() {
    if (!previewGrid) return;
    if (!_lfFiles.length) { previewGrid.style.display = 'none'; previewGrid.innerHTML = ''; return; }
    previewGrid.style.display = 'grid';
    previewGrid.innerHTML = '';
    _lfFiles.forEach((file, i) => {
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
        _lfFiles.splice(i, 1);
        renderLfPreview();
      });
      previewGrid.appendChild(cell);
    });
  }

  async function addLfFiles(newFiles) {
    const allowed = 6 - _lfFiles.length;
    if (allowed <= 0) { showToast('Maximum 6 media files allowed.', 'info'); return; }
    const toAdd = Array.from(newFiles).slice(0, allowed);
    for (const f of toAdd) {
      const isImg = f.type.startsWith('image/');
      const isVid = f.type.startsWith('video/');
      if (!isImg && !isVid) { showToast(`${f.name}: unsupported type.`, 'error'); continue; }
      if (isImg && f.size > MAX_FILE_MB * 1024 * 1024) { showToast(`${f.name}: too large (max ${MAX_FILE_MB} MB).`, 'error'); continue; }
      if (isVid && f.size > 50 * 1024 * 1024) { showToast(`${f.name}: video too large (max 50 MB).`, 'error'); continue; }
      if (isVid) { f._thumbDataUrl = await getVideoThumbnail(f).catch(() => null); }
      _lfFiles.push(f);
    }
    if (photoInput) photoInput.value = '';
    renderLfPreview();
    if (_lfFiles.length >= 6) showToast('Maximum 6 files reached.', 'info');
  }

  if (photoInput) {
    photoInput.addEventListener('change', () => { addLfFiles(photoInput.files); });
    // Expose file list to the submit handler
    photoInput._lfFiles = _lfFiles;
  }

  if (dropzone) {
    dropzone.addEventListener('dragover',  (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      addLfFiles(e.dataTransfer.files);
    });
  }

  // Description character counter
  const descField = document.getElementById('item-description');
  if (descField) {
    descField.setAttribute('maxlength', String(DESC_MAX));
    const hint = document.createElement('span');
    hint.className = 'lf-char-hint';
    hint.setAttribute('aria-live', 'polite');
    hint.textContent = `0 / ${DESC_MAX}`;
    const wrap = document.createElement('div');
    wrap.className = 'lf-field-wrap';
    descField.parentNode?.insertBefore(wrap, descField);
    wrap.appendChild(descField);
    wrap.appendChild(hint);
    descField.addEventListener('input', () => {
      const len = descField.value.length;
      hint.textContent = `${len} / ${DESC_MAX}`;
      hint.className = 'lf-char-hint'
        + (len > DESC_MAX * 0.85 ? ' warn' : '')
        + (len >= DESC_MAX       ? ' over' : '');
    });
  }

  // Submit progress bar
  const submitBtn = form.querySelector('button[type="submit"]');
  const progressWrap = document.createElement('div');
  progressWrap.className = 'lf-submit-progress';
  progressWrap.innerHTML = '<div class="lf-submit-progress-bar" id="lf-progress-bar"></div>';
  submitBtn?.parentElement?.appendChild(progressWrap);

  function setProgress(pct) {
    const bar = document.getElementById('lf-progress-bar');
    if (!bar) return;
    if (pct <= 0) {
      progressWrap.classList.remove('visible');
      bar.style.width = '0%';
      return;
    }
    progressWrap.classList.add('visible');
    bar.style.width = `${pct}%`;
    if (pct >= 100) {
      // Let the bar visually reach 100% before hiding
      setTimeout(() => progressWrap.classList.remove('visible'), 400);
    }
  }

  // Form validation
  function validateForm() {
    const name  = document.getElementById('item-name')?.value.trim();
    const phone = document.getElementById('item-contact-phone')?.value.trim();
    const email = document.getElementById('item-contact-email')?.value.trim();

    if (!name) {
      showToast('Item name is required.', 'error');
      document.getElementById('item-name')?.focus();
      return false;
    }
    if (!phone && !email) {
      showToast('Provide at least a phone number or email.', 'error');
      return false;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showToast('Enter a valid email address.', 'error');
      document.getElementById('item-contact-email')?.focus();
      return false;
    }
    return true;
  }

  // Submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (_submitting) return;                        // double-submit guard
    if (!currentUser) {
      showToast('Sign in to report an item.', 'error');
      return;
    }
    if (!validateForm()) return;

    _submitting = true;
    const originalLabel = submitBtn?.textContent ?? 'Report item';
    if (submitBtn) { submitBtn.textContent = 'Uploading…'; submitBtn.disabled = true; }
    setProgress(20);

    try {
      let mediaItems = [];
      let imageUrl   = null;

      if (_lfFiles.length) {
        mediaItems = await uploadMediaFiles(_lfFiles, 'lostfound');
        imageUrl   = mediaItems.find(m => m.type === 'image')?.url ?? null;
      }
      setProgress(60);

      if (submitBtn) submitBtn.textContent = 'Saving…';

      await addDoc(collection(db, COLLECTION), {
        name:         document.getElementById('item-name')?.value.trim()          ?? '',
        status:       document.getElementById('item-status')?.value               ?? 'Lost',
        description:  document.getElementById('item-description')?.value.trim()  ?? '',
        phone:        document.getElementById('item-contact-phone')?.value.trim() ?? '',
        contactEmail: document.getElementById('item-contact-email')?.value.trim() ?? '',
        imageSrc:     imageUrl ?? null,
        mediaItems:   mediaItems.length ? mediaItems : null,
        authorEmail:  currentUser.email,
        authorUid:    currentUser.uid ?? null,
        resolved:     false,
        resolvedAt:   null,
        resolvedAtMs: null,
        timestamp:    serverTimestamp(),
      });

      setProgress(100);
      showToast('Item reported successfully!', 'success');
      // clear multi-media file list and preview grid
      _lfFiles.length = 0;
      renderLfPreview();
      form.reset();

      // Reset char counter
      if (descField) {
        const h = descField.parentElement?.querySelector('.lf-char-hint');
        if (h) { h.textContent = `0 / ${DESC_MAX}`; h.className = 'lf-char-hint'; }
      }

      // Go back to list view
      document.querySelector('[data-target="page-lost-found"]')?.click();

    } catch (err) {
      console.error('[LF] Submit error:', err);
      showToast(
        err?.code === 'permission-denied'
          ? 'Permission denied. Check Firestore rules.'
          : `Submit failed: ${err?.message ?? 'Unknown error'}`,
        'error'
      );
      setProgress(0);
    } finally {
      _submitting = false;
      if (submitBtn) { submitBtn.textContent = originalLabel; submitBtn.disabled = false; }
    }
  });
}