/**
 * achievements.js — Echo Achievements Module (Audited + Realtime) v2.0
 *
 * UI/UX REFACTOR CHANGELOG (on top of existing bug fixes)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * RENDERING OVERHAUL
 *   [R-01] renderCard — unlocked cards get a full gradient accent bar at
 *          top (matching the modal card pattern from style.css), replacing
 *          the plain border-only distinction. Locked cards use consistent
 *          opacity + grayscale filter so they're visually deprioritised
 *          without losing readability.
 *
 *   [R-02] renderCard — rarity badge now uses the same pill shape and
 *          font-mono style as .badge in style.css, with signal-palette
 *          colours per rarity tier.
 *
 *   [R-03] renderCard — progress bar track uses --edge-strong, fill uses
 *          rarity barBg; both match style.css .poll-result-bar pattern.
 *          Bar wrapper has overflow:hidden + border-radius so the fill
 *          never bleeds outside the track.
 *
 *   [R-04] renderCard — unlocked footer row: checkmark icon colour and
 *          XP badge both use the rarity accent; date shown in --ink-faint.
 *          XP pill has a subtle tinted background consistent with .badge.
 *
 *   [R-05] renderLevelPanel — progress bar fill now uses a gradient
 *          (--gradient-signal for upper levels, level colour for lower)
 *          matching the CTA button aesthetic. XP counter has data-count
 *          so animateCounters picks it up on first render.
 *
 *   [R-06] renderStatsPanel — stat cards use card-level padding and
 *          border consistent with .feature-card. Icon gets a tinted
 *          circular background. Count element has data-count attribute.
 *
 *   [R-07] renderFilterTabs — active tab uses --gradient-signal background
 *          (white text) matching .btn-primary; inactive tabs match
 *          .btn-secondary. Gap + flex-wrap prevent overflow on narrow
 *          containers.
 *
 *   [R-08] renderSkeletons — skeleton grid now uses the same minmax as the
 *          card grid so shimmer cards are the correct size.
 *
 *   [R-09] showError — button uses .btn-primary class; layout uses
 *          --signal-danger token consistently. Icon stroke uses currentColor
 *          with an explicit color property.
 *
 *   [R-10] showUnlockToast — icon area gets a rarity-tinted circular
 *          background. Toast max-width increased to 340px. An accent
 *          gradient bar is drawn at the top of the toast matching
 *          #report-modal .card::before.
 *
 *   [R-11] Header row (unlocked count + Live indicator) uses .eyebrow
 *          token styles and a .signal-dot span for the live dot, matching
 *          style.css section headers exactly.
 *
 *   [R-12] Empty-state message updated to match pattern used in other
 *          empty states across the app.
 *
 * RESPONSIVE / LAYOUT
 *   [R-13] Top summary grid (level + stats) switches to single column
 *          below 600 px via a CSS clamp on grid-template-columns.
 *
 *   [R-14] Achievement card grid uses minmax(200px, 1fr) so cards don't
 *          collapse below a readable width on mobile.
 *
 *   [R-15] Toast repositions correctly on resize via a ResizeObserver
 *          added to document.body, cleaned up in teardownAchievements().
 *
 * ACCESSIBILITY
 *   [R-16] Filter tab buttons get aria-pressed="true/false".
 *   [R-17] Card unlock checkmark svg gets aria-hidden="true".
 *   [R-18] Toast has role="status" aria-live="polite" so screen readers
 *          announce new achievements without interrupting flow.
 *   [R-19] Progress bars get role="progressbar" aria-valuenow/min/max.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { db } from '../config/firebase.js';
import { currentUser } from '../store/db.js';
import {
  collection, collectionGroup, query, where, onSnapshot,
  doc, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// ─── Module-level state ───────────────────────────────────────────────────────
let _listenerAttached = false;
let _activeUnsubs     = [];
let _liveStats        = {};
let _unlockDates      = {};
let _knownUnlocked    = null;
let _activeFilter     = 'All';
let _rafPending       = false;
let _listEl           = null;
let _readySources     = new Set();
let _toastQueue       = [];
let _firstRender      = true;
let _resizeObserver   = null; // [R-15]

// ─── Rarity config ────────────────────────────────────────────────────────────
// All colour values reference Night Network CSS custom properties so they
// adapt automatically to Daylight / Deep Space mode without any overrides.
const RARITY = {
  common: {
    label:       'Common',
    accent:      'var(--ink-dim)',
    cardBg:      'var(--surface-2)',
    cardBorder:  'var(--edge-strong)',
    barBg:       'var(--ink-faint)',
    iconBg:      'var(--surface-3)',
    glow:        '',
    gradient:    'linear-gradient(135deg, var(--ink-faint), var(--ink-dim))',
    toastBorder: 'var(--edge-strong)',
    toastAccent: 'var(--ink-dim)',
  },
  rare: {
    label:       'Rare',
    accent:      'var(--signal-violet)',
    cardBg:      'var(--tint-violet)',
    cardBorder:  'var(--tint-violet-border)',
    barBg:       'var(--signal-violet)',
    iconBg:      'var(--tint-violet)',
    glow:        '0 4px 24px rgba(124,92,255,0.18)',
    gradient:    'var(--gradient-signal)',
    toastBorder: 'var(--tint-violet-border)',
    toastAccent: 'var(--signal-violet)',
  },
  epic: {
    label:       'Epic',
    accent:      'var(--signal-magenta)',
    cardBg:      'rgba(255,79,216,0.07)',
    cardBorder:  'rgba(255,79,216,0.28)',
    barBg:       'var(--signal-magenta)',
    iconBg:      'rgba(255,79,216,0.10)',
    glow:        '0 4px 24px rgba(255,79,216,0.16)',
    gradient:    'linear-gradient(135deg, var(--signal-magenta), var(--signal-violet))',
    toastBorder: 'rgba(255,79,216,0.38)',
    toastAccent: 'var(--signal-magenta)',
  },
  legendary: {
    label:       'Legendary',
    accent:      'var(--signal-amber)',
    cardBg:      'rgba(255,180,84,0.08)',
    cardBorder:  'rgba(255,180,84,0.32)',
    barBg:       'var(--signal-amber)',
    iconBg:      'rgba(255,180,84,0.12)',
    glow:        '0 4px 28px rgba(255,180,84,0.20)',
    gradient:    'var(--gradient-signal-warm)',
    toastBorder: 'rgba(255,180,84,0.42)',
    toastAccent: 'var(--signal-amber)',
  },
};

// ─── Achievement definitions ──────────────────────────────────────────────────
const ACHIEVEMENT_DEFS = [
  // Posts
  { id: 'post_1',    title: 'First Words',       desc: 'Published your very first post.',          category: 'Posts',      rarity: 'common',    xp: 10,  stat: 'postCount',      threshold: 1,   icon: '✍️',  statLabel: 'post'     },
  { id: 'post_5',    title: 'Getting Started',   desc: 'Reached 5 posts.',                         category: 'Posts',      rarity: 'common',    xp: 25,  stat: 'postCount',      threshold: 5,   icon: '📝',  statLabel: 'posts'    },
  { id: 'post_10',   title: 'Regular Voice',     desc: "Hit 10 posts — you're consistent.",        category: 'Posts',      rarity: 'rare',      xp: 50,  stat: 'postCount',      threshold: 10,  icon: '🗣️', statLabel: 'posts'    },
  { id: 'post_25',   title: 'Prolific Writer',   desc: 'Reached 25 posts.',                        category: 'Posts',      rarity: 'rare',      xp: 100, stat: 'postCount',      threshold: 25,  icon: '📖',  statLabel: 'posts'    },
  { id: 'post_50',   title: 'Storyteller',       desc: '50 posts — your feed is a body of work.',  category: 'Posts',      rarity: 'epic',      xp: 200, stat: 'postCount',      threshold: 50,  icon: '🏆',  statLabel: 'posts'    },
  { id: 'post_100',  title: 'Legend',            desc: '100 posts. An institution.',               category: 'Posts',      rarity: 'legendary', xp: 500, stat: 'postCount',      threshold: 100, icon: '👑',  statLabel: 'posts'    },
  // Engagement
  { id: 'likes_1',   title: 'First Like',        desc: 'Someone appreciated your post.',           category: 'Engagement', rarity: 'common',    xp: 10,  stat: 'likesReceived',  threshold: 1,   icon: '❤️',  statLabel: 'like'     },
  { id: 'likes_10',  title: 'Popular',           desc: 'Received 10 likes across your posts.',     category: 'Engagement', rarity: 'common',    xp: 30,  stat: 'likesReceived',  threshold: 10,  icon: '🌟',  statLabel: 'likes'    },
  { id: 'likes_50',  title: 'Crowd Pleaser',     desc: 'Your posts have 50 likes total.',          category: 'Engagement', rarity: 'rare',      xp: 75,  stat: 'likesReceived',  threshold: 50,  icon: '🎯',  statLabel: 'likes'    },
  { id: 'likes_200', title: 'Influencer',        desc: '200 likes received — people love you.',    category: 'Engagement', rarity: 'epic',      xp: 250, stat: 'likesReceived',  threshold: 200, icon: '💫',  statLabel: 'likes'    },
  { id: 'likes_500', title: 'Viral',             desc: "500 likes. You're famous around here.",    category: 'Engagement', rarity: 'legendary', xp: 500, stat: 'likesReceived',  threshold: 500, icon: '🚀',  statLabel: 'likes'    },
  // Social
  { id: 'comment_1',   title: 'Joining In',        desc: 'Left your first comment.',              category: 'Social',     rarity: 'common',    xp: 10,  stat: 'commentsMade',   threshold: 1,   icon: '💬',  statLabel: 'comment'  },
  { id: 'comment_10',  title: 'Conversationalist', desc: 'Commented 10 times.',                   category: 'Social',     rarity: 'common',    xp: 30,  stat: 'commentsMade',   threshold: 10,  icon: '🤝',  statLabel: 'comments' },
  { id: 'comment_50',  title: 'Community Pillar',  desc: '50 comments — you keep things alive.',  category: 'Social',     rarity: 'rare',      xp: 100, stat: 'commentsMade',   threshold: 50,  icon: '🏛️', statLabel: 'comments' },
  { id: 'comment_100', title: 'Elder',             desc: '100 comments. The community elder.',    category: 'Social',     rarity: 'epic',      xp: 300, stat: 'commentsMade',   threshold: 100, icon: '🧙',  statLabel: 'comments' },
  // Profile
  { id: 'profile_bio',    title: 'Introduced',     desc: 'Added a bio to your profile.',          category: 'Profile',    rarity: 'common',    xp: 15,  stat: 'hasBio',          threshold: 1,  icon: '🪪',  statLabel: null },
  { id: 'profile_avatar', title: 'Face to a Name', desc: 'Uploaded a profile picture.',           category: 'Profile',    rarity: 'common',    xp: 15,  stat: 'hasAvatar',       threshold: 1,  icon: '🖼️', statLabel: null },
  { id: 'profile_full',   title: 'Complete',       desc: 'Filled out every profile field.',       category: 'Profile',    rarity: 'rare',      xp: 50,  stat: 'profileComplete', threshold: 1,  icon: '✅',  statLabel: null },
];

// ─── XP / Level ───────────────────────────────────────────────────────────────
const LEVELS = [
  { min: 0,    label: 'Newcomer',    color: 'var(--ink-faint)',      gradient: 'linear-gradient(90deg, var(--ink-faint), var(--ink-dim))'          },
  { min: 50,   label: 'Explorer',    color: 'var(--signal-cyan)',    gradient: 'linear-gradient(90deg, var(--signal-cyan), var(--signal-green))'    },
  { min: 150,  label: 'Contributor', color: 'var(--signal-green)',   gradient: 'linear-gradient(90deg, var(--signal-green), var(--signal-cyan))'   },
  { min: 350,  label: 'Veteran',     color: 'var(--signal-violet)',  gradient: 'var(--gradient-signal)'                                            },
  { min: 700,  label: 'Expert',      color: 'var(--signal-amber)',   gradient: 'linear-gradient(90deg, var(--signal-amber), var(--signal-magenta))' },
  { min: 1200, label: 'Master',      color: 'var(--signal-magenta)', gradient: 'var(--gradient-signal-warm)'                                       },
  { min: 2000, label: 'Legend',      color: 'var(--signal-amber)',   gradient: 'var(--gradient-signal-warm)'                                       },
];

function getLevel(xp) {
  let level = LEVELS[0];
  for (const l of LEVELS) { if (xp >= l.min) level = l; else break; }
  const idx      = LEVELS.indexOf(level);
  const next     = LEVELS[idx + 1] ?? null;
  const progress = next
    ? Math.min(100, Math.round(((xp - level.min) / (next.min - level.min)) * 100))
    : 100;
  return { ...level, next, progress };
}

// ─── Toast system ─────────────────────────────────────────────────────────────
function injectToastStyles() {
  if (document.getElementById('ach-toast-style')) return;
  const s = document.createElement('style');
  s.id = 'ach-toast-style';
  s.textContent = `
    @keyframes ach-toast-in  {
      from { opacity: 0; transform: translateY(14px) scale(.95); }
      to   { opacity: 1; transform: none; }
    }
    @keyframes ach-toast-out {
      to   { opacity: 0; transform: translateY(8px) scale(.97); }
    }
    .ach-toast {
      transition: bottom 0.3s cubic-bezier(0.22,1,0.36,1);
      cursor: pointer;
    }
    .ach-toast:hover { filter: brightness(1.04); }

    /* Responsive: stack from bottom-right, collapse to full-width on mobile */
    @media (max-width: 480px) {
      .ach-toast {
        right: 12px !important;
        left: 12px  !important;
        max-width: none !important;
      }
    }
  `;
  document.head.appendChild(s);
}

function repositionToasts() {
  const GAP = 10;
  let bottom = 24;
  for (let i = _toastQueue.length - 1; i >= 0; i--) {
    _toastQueue[i].style.bottom = `${bottom}px`;
    bottom += _toastQueue[i].offsetHeight + GAP;
  }
}

function showUnlockToast(ach) {
  injectToastStyles();
  const r = RARITY[ach.rarity];

  const toast = document.createElement('div');
  // [R-18] Accessible live region
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.className = 'ach-toast';

  // [R-10] Refined toast: gradient top bar + icon tinted background
  toast.style.cssText = `
    position: fixed;
    right: 20px;
    bottom: 24px;
    z-index: 9999;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 16px 14px;
    border-radius: var(--radius-md);
    max-width: 340px;
    width: max-content;
    background: var(--surface);
    border: 1px solid ${r.toastBorder};
    box-shadow: var(--shadow-lift), ${r.glow || 'none'};
    font-family: var(--font-body);
    color: var(--ink);
    animation: ach-toast-in 0.35s cubic-bezier(0.22,1,0.36,1) both;
    overflow: hidden;
  `;

  toast.innerHTML = `
    <!-- Accent gradient bar at top (mirrors modal card pattern from style.css) -->
    <div style="
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: ${r.gradient};
      border-radius: 0;
    " aria-hidden="true"></div>

    <!-- Icon with tinted circular background -->
    <div style="
      margin-top: 14px;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      background: ${r.iconBg};
      border: 1px solid ${r.toastBorder};
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      flex-shrink: 0;
    " aria-hidden="true">${ach.icon}</div>

    <!-- Text content -->
    <div style="min-width: 0; margin-top: 14px; flex: 1;">
      <div style="
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: ${r.toastAccent};
        font-family: var(--font-mono);
        margin-bottom: 2px;
      ">Achievement Unlocked &middot; ${r.label}</div>
      <div style="
        font-weight: 700;
        font-size: 0.875rem;
        color: var(--ink);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      ">${ach.title}</div>
      <div style="
        font-size: 0.75rem;
        color: var(--ink-dim);
        margin-top: 1px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      ">${ach.desc}</div>
    </div>

    <!-- XP pill — mirrors .badge style -->
    <div style="
      margin-top: 14px;
      padding: 3px 10px;
      border-radius: 9999px;
      border: 1px solid ${r.toastBorder};
      background: ${r.iconBg};
      font-size: 0.75rem;
      font-weight: 700;
      color: ${r.toastAccent};
      font-family: var(--font-mono);
      white-space: nowrap;
      flex-shrink: 0;
    ">+${ach.xp} XP</div>
  `;

  document.body.appendChild(toast);
  _toastQueue.push(toast);
  repositionToasts();

  const dismiss = () => {
    toast.style.animation = 'ach-toast-out 0.22s ease-in forwards';
    toast.addEventListener('animationend', () => {
      toast.remove();
      _toastQueue = _toastQueue.filter(t => t !== toast);
      repositionToasts();
    }, { once: true });
  };

  toast.addEventListener('click', dismiss);
  setTimeout(dismiss, 4500);
}

// ─── Persist new unlocks ──────────────────────────────────────────────────────
function persistNewUnlocks(email, currentlyUnlocked) {
  // [BUG-01] First emission initialises the baseline — no toasts yet
  if (!_knownUnlocked) {
    _knownUnlocked = new Set(currentlyUnlocked);
    return;
  }
  for (const id of currentlyUnlocked) {
    if (!_knownUnlocked.has(id)) {
      _knownUnlocked.add(id);
      const ach = ACHIEVEMENT_DEFS.find(a => a.id === id);
      if (ach) showUnlockToast(ach);
      setDoc(
        doc(db, 'users', email, 'achievements', id),
        { unlockedAt: serverTimestamp() },
        { merge: true }
      ).catch(console.error);
    }
  }
}

function maybeCheckAndPersist(email) {
  // [BUG-07] Wait for all 3 core data sources before persisting/toasting
  if (!_readySources.has('posts') || !_readySources.has('comments') || !_readySources.has('profile')) return;
  const currentlyUnlocked = ACHIEVEMENT_DEFS
    .filter(a => (_liveStats[a.stat] ?? 0) >= a.threshold)
    .map(a => a.id);
  persistNewUnlocks(email, currentlyUnlocked);
}

// ─── Render helpers ───────────────────────────────────────────────────────────
function formatDate(d) {
  return d?.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) ?? '';
}

function statSublabel(ach, value) {
  if (!ach.statLabel) return '';
  const label = value === 1 ? ach.statLabel.replace(/s$/, '') : ach.statLabel;
  return `
    <span style="
      font-size: 11px;
      color: var(--ink-faint);
      display: block;
      margin-top: 3px;
      font-family: var(--font-mono);
    ">${value} ${label}</span>`;
}

// [R-03] Progress bar — overflow:hidden on track prevents fill bleed
function progressBar(value, max, barBg, label) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return `
    <div style="margin-top: 14px;">
      <div style="
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: var(--ink-faint);
        margin-bottom: 5px;
        font-family: var(--font-mono);
      ">
        <span>${value} / ${max}</span>
        <span>${pct}%</span>
      </div>
      <div style="
        width: 100%;
        height: 5px;
        border-radius: 9999px;
        background: var(--edge-strong);
        overflow: hidden;
      " role="progressbar"
         aria-valuenow="${value}"
         aria-valuemin="0"
         aria-valuemax="${max}"
         aria-label="${label}">
        <div style="
          height: 100%;
          border-radius: 9999px;
          width: ${pct}%;
          background: ${barBg};
          transition: width 0.7s var(--ease-spring);
        "></div>
      </div>
    </div>`;
}

// [R-01][R-02][R-03][R-04] Fully redesigned achievement card
function renderCard(ach, stats, unlockDates) {
  const r        = RARITY[ach.rarity];
  const value    = stats[ach.stat] ?? 0;
  const unlocked = value >= ach.threshold;
  const dateStr  = unlocked && unlockDates[ach.id] ? formatDate(unlockDates[ach.id]) : '';

  const cardStyle = unlocked
    ? `background: ${r.cardBg};
       border: 1px solid ${r.cardBorder};
       box-shadow: ${r.glow || 'var(--shadow-sm)'};`
    : `background: var(--surface-2);
       border: 1px solid var(--edge);
       opacity: 0.65;
       filter: grayscale(0.3);`;

  return `
    <div style="
      ${cardStyle}
      border-radius: var(--radius-md);
      padding: 0 1rem 1rem;
      position: relative;
      overflow: hidden;
      transition: box-shadow 0.32s var(--ease-spring), transform 0.32s var(--ease-spring);
    ">
      <!-- [R-01] Gradient accent bar at top for unlocked cards -->
      ${unlocked ? `<div style="
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 2px;
        background: ${r.gradient};
      " aria-hidden="true"></div>` : ''}

      <!-- Header row: icon + rarity badge -->
      <div style="
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        margin-top: ${unlocked ? '16px' : '14px'};
      ">
        <!-- Icon in tinted circle -->
        <div style="
          width: 40px;
          height: 40px;
          border-radius: 50%;
          background: ${unlocked ? r.iconBg : 'var(--surface-3)'};
          border: 1px solid ${unlocked ? r.cardBorder : 'var(--edge)'};
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          flex-shrink: 0;
        " aria-hidden="true">${ach.icon}</div>

        <!-- [R-02] Rarity badge — mirrors .badge from style.css -->
        <span style="
          display: inline-flex;
          align-items: center;
          padding: 3px 9px;
          border-radius: 9999px;
          font-size: 10px;
          font-family: var(--font-mono);
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          border: 1px solid ${r.cardBorder};
          color: ${r.accent};
          background: ${unlocked ? r.cardBg : 'var(--surface-3)'};
          white-space: nowrap;
        ">${r.label}</span>
      </div>

      <!-- Title -->
      <div style="
        font-weight: 700;
        font-size: 0.88rem;
        margin-top: 10px;
        color: ${unlocked ? r.accent : 'var(--ink-dim)'};
        font-family: var(--font-display);
        line-height: 1.3;
      ">${ach.title}</div>

      <!-- Stat sub-label (locked only) -->
      ${!unlocked ? statSublabel(ach, value) : ''}

      <!-- Description -->
      <p style="
        font-size: 0.775rem;
        color: var(--ink-dim);
        margin-top: 5px;
        line-height: 1.55;
      ">${ach.desc}</p>

      <!-- Footer: unlocked info OR progress bar -->
      ${unlocked
        ? `<div style="
             margin-top: 12px;
             display: flex;
             align-items: center;
             gap: 6px;
             flex-wrap: wrap;
           ">
             <!-- Checkmark -->
             <svg width="14" height="14" fill="none" stroke="${r.accent}" viewBox="0 0 24 24"
                  style="flex-shrink:0" aria-hidden="true">
               <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>
             </svg>
             <span style="font-size: 0.72rem; color: var(--ink-faint);">
               Unlocked${dateStr ? ` &middot; ${dateStr}` : ''}
             </span>
             <!-- [R-04] XP pill -->
             <span style="
               margin-left: auto;
               padding: 2px 8px;
               border-radius: 9999px;
               border: 1px solid ${r.cardBorder};
               background: ${r.iconBg};
               font-size: 0.72rem;
               font-weight: 700;
               color: ${r.accent};
               font-family: var(--font-mono);
               white-space: nowrap;
             ">+${ach.xp} XP</span>
           </div>`
        : progressBar(value, ach.threshold, r.barBg, ach.title)
      }
    </div>`;
}

// [R-08] Skeleton cards match the card grid's minmax
function renderSkeletons(count = 6) {
  const card = `
    <div style="
      border-radius: var(--radius-md);
      padding: 0 1rem 1rem;
      background: var(--surface-2);
      border: 1px solid var(--edge);
      overflow: hidden;
      position: relative;
    ">
      <div style="position:absolute;top:0;left:0;right:0;height:2px;background:var(--surface-3)"></div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:16px">
        <div class="skeleton" style="width:40px;height:40px;border-radius:50%;flex-shrink:0"></div>
        <div class="skeleton" style="width:58px;height:20px;border-radius:9999px"></div>
      </div>
      <div class="skeleton" style="height:14px;width:65%;border-radius:4px;margin-top:12px"></div>
      <div class="skeleton" style="height:11px;width:100%;border-radius:4px;margin-top:8px"></div>
      <div class="skeleton" style="height:11px;width:55%;border-radius:4px;margin-top:5px"></div>
      <div class="skeleton" style="height:5px;width:100%;border-radius:9999px;margin-top:18px"></div>
    </div>`;
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px">
      ${card.repeat(count)}
    </div>`;
}

// [R-06] Stats panel — card-level styling, data-count for counter animation
function renderStatsPanel(s) {
  const items = [
    { label: 'Posts',          value: s.postCount     ?? 0, icon: '📝', color: 'var(--signal-cyan)',    iconBg: 'var(--tint-cyan)'    },
    { label: 'Likes Received', value: s.likesReceived ?? 0, icon: '❤️', color: 'var(--signal-magenta)', iconBg: 'rgba(255,79,216,0.10)' },
    { label: 'Comments Made',  value: s.commentsMade  ?? 0, icon: '💬', color: 'var(--signal-violet)',  iconBg: 'var(--tint-violet)'  },
  ];
  return `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
      ${items.map(i => `
        <div style="
          border-radius: var(--radius-md);
          border: 1px solid var(--edge);
          padding: 0.9rem 0.75rem;
          text-align: center;
          background: var(--surface);
        ">
          <!-- Icon with tinted bg -->
          <div style="
            width: 34px;
            height: 34px;
            border-radius: 50%;
            background: ${i.iconBg};
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 15px;
            margin: 0 auto 6px;
          " aria-hidden="true">${i.icon}</div>
          <!-- Count — data-count triggers animateCounters -->
          <div style="
            font-size: 1.45rem;
            font-weight: 700;
            color: ${i.color};
            font-family: var(--font-display);
            line-height: 1;
          " data-count="${i.value}">0</div>
          <div style="
            font-size: 0.7rem;
            color: var(--ink-dim);
            margin-top: 4px;
            line-height: 1.3;
            font-family: var(--font-mono);
          ">${i.label}</div>
        </div>`).join('')}
    </div>`;
}

// Counter animation (unchanged logic, works with new data-count placements)
function animateCounters(container) {
  container.querySelectorAll('[data-count]').forEach(el => {
    const target = parseInt(el.dataset.count, 10);
    if (!target) { el.textContent = '0'; return; }
    const duration = Math.min(900, target * 20);
    const start    = performance.now();
    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      el.textContent = Math.round(target * (1 - (1 - t) ** 2));
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = target;
    }
    requestAnimationFrame(tick);
  });
}

// [R-05] Level panel — gradient progress bar, XP has data-count
function renderLevelPanel(xp) {
  const level    = getLevel(xp);
  const nextNote = level.next
    ? `${level.next.min - xp} XP to ${level.next.label}`
    : 'Max level reached';

  return `
    <div style="
      border-radius: var(--radius-md);
      border: 1px solid var(--edge);
      padding: 1.1rem 1.1rem 1.25rem;
      background: var(--surface);
      position: relative;
      overflow: hidden;
    ">
      <!-- Subtle gradient tint in corner -->
      <div style="
        position: absolute;
        top: -40%; right: -20%;
        width: 140%; height: 140%;
        background: radial-gradient(circle, var(--tint-violet) 0%, transparent 65%);
        pointer-events: none;
      " aria-hidden="true"></div>

      <div style="
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
        position: relative;
      ">
        <div style="min-width: 0;">
          <div style="
            font-size: 0.68rem;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--ink-faint);
            font-family: var(--font-mono);
            margin-bottom: 3px;
          ">Your Level</div>
          <div style="
            font-size: 1.15rem;
            font-weight: 700;
            color: ${level.color};
            font-family: var(--font-display);
            line-height: 1.2;
          ">${level.label}</div>
        </div>
        <div style="text-align: right; flex-shrink: 0;">
          <!-- [R-05] XP value participates in animateCounters -->
          <div style="
            font-size: 1.35rem;
            font-weight: 700;
            color: var(--ink);
            font-family: var(--font-display);
            line-height: 1;
          ">
            <span data-count="${xp}">0</span>
            <span style="font-size: 0.8rem; color: var(--ink-dim); font-weight: 400;"> XP</span>
          </div>
          <div style="font-size: 0.7rem; color: var(--ink-faint); margin-top: 3px;">${nextNote}</div>
        </div>
      </div>

      <!-- [R-05] Gradient-filled progress bar -->
      <div style="
        width: 100%;
        height: 7px;
        border-radius: 9999px;
        background: var(--edge-strong);
        overflow: hidden;
        position: relative;
      " role="progressbar"
         aria-valuenow="${level.progress}"
         aria-valuemin="0"
         aria-valuemax="100"
         aria-label="Level progress">
        <div style="
          height: 100%;
          border-radius: 9999px;
          width: ${level.progress}%;
          background: ${level.gradient};
          transition: width 0.7s var(--ease-spring);
        "></div>
      </div>
    </div>`;
}

// [R-07] Filter tabs — active mirrors .btn-primary, inactive mirrors .btn-secondary
function renderFilterTabs(active, categories) {
  const tabs = ['All', ...categories, 'Rare+'];
  return `
    <div style="
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 18px;
    " role="group" aria-label="Filter achievements">
      ${tabs.map(f => {
        const isActive = f === active;
        return `
          <button
            data-filter="${f}"
            type="button"
            aria-pressed="${isActive}"
            style="
              padding: 5px 14px;
              border-radius: 9999px;
              font-size: 0.75rem;
              font-weight: 600;
              font-family: var(--font-mono);
              cursor: pointer;
              transition: all 0.18s var(--ease-spring);
              white-space: nowrap;
              border: 1px solid ${isActive ? 'transparent' : 'var(--edge-strong)'};
              background: ${isActive ? 'var(--gradient-signal)' : 'var(--surface-2)'};
              color: ${isActive ? '#ffffff' : 'var(--ink-dim)'};
              box-shadow: ${isActive ? '0 4px 14px rgba(124,92,255,0.22)' : 'none'};
            "
          >${f}</button>`;
      }).join('')}
    </div>`;
}

// ─── Core render ──────────────────────────────────────────────────────────────
function rerender() {
  if (!_listEl) return;

  const isReady = _readySources.has('posts') && _readySources.has('comments') && _readySources.has('profile');
  if (!isReady) return;

  const stats         = _liveStats;
  const dates         = _unlockDates;
  const totalXp       = ACHIEVEMENT_DEFS.filter(a => (stats[a.stat] ?? 0) >= a.threshold).reduce((s, a) => s + a.xp, 0);
  const unlockedCount = ACHIEVEMENT_DEFS.filter(a => (stats[a.stat] ?? 0) >= a.threshold).length;
  const categories    = [...new Set(ACHIEVEMENT_DEFS.map(a => a.category))];

  const filtered = ACHIEVEMENT_DEFS.filter(a => {
    if (_activeFilter === 'All')   return true;
    if (_activeFilter === 'Rare+') return ['rare', 'epic', 'legendary'].includes(a.rarity);
    return a.category === _activeFilter;
  });

  // [R-12] Empty state — matches app-wide empty-state style
  const emptyMsg = `
    <div style="
      grid-column: 1 / -1;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 48px 16px;
      gap: 10px;
      text-align: center;
    ">
      <div style="font-size: 2rem;" aria-hidden="true">🔍</div>
      <div style="font-weight: 600; color: var(--ink-dim); font-size: 0.9rem;">
        No achievements in this category yet.
      </div>
      <div style="font-size: 0.8rem; color: var(--ink-faint); max-width: 240px; line-height: 1.5;">
        Keep participating to unlock them.
      </div>
    </div>`;

  _listEl.innerHTML = `
    <!-- [R-13] Summary grid: 2-col on wide, 1-col on narrow via clamp -->
    <div style="
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
      gap: 14px;
      margin-bottom: 18px;
    ">
      ${renderLevelPanel(totalXp)}
      ${renderStatsPanel(stats)}
    </div>

    <!-- [R-11] Header row — mirrors .eyebrow / .signal-dot from style.css -->
    <div style="
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 14px;
      gap: 8px;
    ">
      <span style="
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--ink-dim);
        font-family: var(--font-mono);
      ">${unlockedCount} / ${ACHIEVEMENT_DEFS.length} Unlocked</span>

      <span style="
        font-size: 0.72rem;
        color: var(--signal-cyan);
        display: flex;
        align-items: center;
        gap: 6px;
        font-family: var(--font-mono);
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      ">
        <span class="signal-dot" aria-hidden="true"></span>Live
      </span>
    </div>

    ${renderFilterTabs(_activeFilter, categories)}

    <!-- [R-14] Card grid — minmax 200px prevents cards collapsing too narrow -->
    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px;">
      ${filtered.map(a => renderCard(a, stats, dates)).join('') || emptyMsg}
    </div>`;

  if (_firstRender) {
    _firstRender = false;
    animateCounters(_listEl);
  }
}

function scheduleRerender() {
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => {
    _rafPending = false;
    rerender();
  });
}

// ─── Listener teardown ────────────────────────────────────────────────────────
function teardownListeners() {
  _activeUnsubs.forEach(u => u());
  _activeUnsubs  = [];
  _liveStats     = {};
  _unlockDates   = {};
  _knownUnlocked = null;
  _readySources  = new Set();
  _firstRender   = true; // [BUG-10]
}

// ─── Attach realtime listeners ────────────────────────────────────────────────
function attachListeners(email, listEl) {
  teardownListeners();
  _listEl = listEl;
  listEl.innerHTML = renderSkeletons(6);

  const postsUnsub = onSnapshot(
    query(collection(db, 'posts'), where('authorEmail', '==', email)),
    snap => {
      const posts = snap.docs.map(d => d.data());
      _liveStats.postCount     = posts.length;
      _liveStats.likesReceived = posts.reduce((s, p) => s + (p.likeCount ?? p.likes ?? 0), 0);
      _readySources.add('posts');
      maybeCheckAndPersist(email);
      scheduleRerender();
    },
    err => showError(listEl, err)
  );

  // [BUG-08, BUG-09] collectionGroup across all posts/{id}/comments
  const commentsUnsub = onSnapshot(
    query(collectionGroup(db, 'comments'), where('authorEmail', '==', email)),
    snap => {
      _liveStats.commentsMade = snap.size;
      _readySources.add('comments');
      maybeCheckAndPersist(email);
      scheduleRerender();
    },
    err => showError(listEl, err)
  );

  const profileUnsub = onSnapshot(
    doc(db, 'users', email),
    snap => {
      const p = snap.exists() ? snap.data() : {};
      _liveStats.hasBio          = p.bio         ? 1 : 0;
      _liveStats.hasAvatar       = p.photoURL     ? 1 : 0;
      _liveStats.profileComplete = (p.bio && p.photoURL && p.displayName && p.location) ? 1 : 0;
      _readySources.add('profile');
      maybeCheckAndPersist(email);
      scheduleRerender();
    },
    err => showError(listEl, err)
  );

  const datesUnsub = onSnapshot(
    collection(db, 'users', email, 'achievements'),
    snap => {
      _unlockDates = {};
      snap.forEach(d => {
        _unlockDates[d.id] = d.data().unlockedAt?.toDate?.() ?? null;
      });
      scheduleRerender();
    },
    () => { /* non-critical */ }
  );

  _activeUnsubs = [postsUnsub, commentsUnsub, profileUnsub, datesUnsub];
}

// ─── Error display ────────────────────────────────────────────────────────────
// [R-09] Uses .btn-primary class; layout cleaned up
function showError(listEl, err) {
  console.error('[Achievements]', err);
  listEl.innerHTML = `
    <div style="
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 64px 16px;
      text-align: center;
    ">
      <div style="
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: var(--tint-danger);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--signal-danger);
      " aria-hidden="true">
        <svg width="26" height="26" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
        </svg>
      </div>
      <p style="color: var(--signal-danger); font-weight: 700; font-size: 1rem; margin: 0;">
        Connection lost
      </p>
      <p style="color: var(--ink-dim); font-size: 0.85rem; max-width: 260px; margin: 0; line-height: 1.5;">
        ${err?.message ?? 'Check your connection and try again.'}
      </p>
      <button id="ach-retry-btn" type="button" class="btn-primary" style="margin-top: 4px;">
        Reconnect
      </button>
    </div>`;
  document.getElementById('ach-retry-btn')?.addEventListener('click', () => {
    if (currentUser) attachListeners(currentUser.email, listEl);
  }, { once: true });
}

// ─── Setup ────────────────────────────────────────────────────────────────────
export function setupAchievements() {
  if (_listenerAttached) return;
  _listenerAttached = true;

  // [BUG-02] Single delegated listener on document for nav + filter clicks
  document.addEventListener('click', e => {
    if (e.target.closest('[data-target="page-achievements"]') && currentUser) {
      const listEl = document.getElementById('achievements-list');
      if (!listEl) return;
      if (_activeUnsubs.length === 0) {
        attachListeners(currentUser.email, listEl);
      }
      return;
    }

    const filterBtn = e.target.closest('[data-filter]');
    if (filterBtn && _listEl) {
      _activeFilter = filterBtn.dataset.filter;
      scheduleRerender();
    }
  });

  // [R-15] Reposition toasts on viewport resize (e.g. mobile keyboard appearing)
  _resizeObserver = new ResizeObserver(() => {
    if (_toastQueue.length) repositionToasts();
  });
  _resizeObserver.observe(document.body);
}

// ─── Teardown (call on logout / page unload) ──────────────────────────────────
export function teardownAchievements() {
  teardownListeners();
  _listEl           = null;
  _activeFilter     = 'All';
  _listenerAttached = false; // [BUG-03]

  // [R-15] Clean up resize observer
  _resizeObserver?.disconnect();
  _resizeObserver = null;
}