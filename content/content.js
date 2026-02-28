/**
 * content.js – SpoilerShield Content Script
 *
 * ARCHITECTURE OVERVIEW
 * ──────────────────────────────────────────────────────────────────────────
 * 1. getDomain()       – Detects which supported platform we're on.
 * 2. getContentRoot()  – Returns the platform-specific element to blur.
 * 3. scanForSpoilers() – Walks only visible content containers, looking for
 *                        keyword matches. Skips script/style/noscript tags.
 * 4. blurContent()     – Applies blur + overlay to the content root.
 * 5. setupObserver()   – Installs a MutationObserver that debounces scans
 *                        whenever new DOM nodes are added (infinite-scroll,
 *                        lazy-load, etc.).
 *
 * DYNAMIC SITE HANDLING
 * ──────────────────────────────────────────────────────────────────────────
 * YouTube, Twitter/X, and Reddit are Single Page Applications (SPAs). They
 * mutate the DOM rather than navigating to new pages, so a one-time scan at
 * document_idle would miss dynamically loaded content.
 *
 * MutationObserver watches for childList changes on the content root (or
 * document.body as fallback). Every time new nodes land in the DOM:
 *   • We schedule a debounced scan (avoids firing on every single mutation).
 *   • The scan only reads text from the platform's known content containers.
 *   • Once a spoiler is found we disconnect the observer to stop all future
 *     scanning (no infinite loops, no wasted CPU).
 *
 * PERFORMANCE
 * ──────────────────────────────────────────────────────────────────────────
 * • Debounce (300 ms) collapses bursts of mutations into one scan.
 * • We target specific container selectors per platform, not document.body.
 * • innerText is avoided in favour of textContent (no layout reflow).
 * • SKIP_TAGS prevents reading script/style/noscript nodes.
 * • A `blurred` flag short-circuits everything once triggered.
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────

/** Tags whose text we always skip – they contain code, not readable content */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'META', 'LINK']);

/**
 * Per-platform content-container selectors.
 * We scan ONLY nodes that match these to avoid processing the whole document.
 *
 * YouTube  – ytd-rich-item-renderer, ytd-comment-renderer, ytd-video-primary-info-renderer
 * Twitter  – article elements inside main (each tweet card)
 * Reddit   – shreddit-post, .thing (old Reddit), .Post (new Reddit)
 */
const PLATFORM_SCAN_SELECTORS = {
  youtube : 'ytd-rich-item-renderer, ytd-video-primary-info-renderer, ytd-comment-renderer, ytd-compact-video-renderer',
  twitter : 'article',
  x       : 'article',
  reddit  : 'shreddit-post, .thing, [data-testid="post-container"], .Post',
};

/**
 * Per-platform blur-target selectors.
 * We blur THIS element – the main content wrapper, NOT the whole <body>.
 * This ensures the browser chrome and extension popup are unaffected.
 */
const PLATFORM_BLUR_SELECTORS = {
  youtube : 'ytd-app, #contents',
  twitter : 'main',
  x       : 'main',
  reddit  : 'shreddit-app, #SHORTCUT_FOCUSABLE_DIV, .ListingLayout-backgroundContainer, main',
};

const OVERLAY_ID      = 'spoilershield-overlay';
const DEBOUNCE_DELAY  = 300; // ms – wait this long after last mutation before scanning

// ── Module State ───────────────────────────────────────────────────────────
let keywords    = [];   // lowercased keyword strings from storage
let domain      = null; // one of: youtube | twitter | x | reddit | null
let blurred     = false;
let observer    = null;
let debounceTimer = null;

// ── 1. Domain Detection ────────────────────────────────────────────────────

/**
 * getDomain()
 * Examines window.location.hostname and maps it to a canonical platform key.
 * Returns null if the site isn't in our supported list.
 *
 * This is more reliable than checking manifest host_permissions because the
 * content script could theoretically be injected on subdomains we haven't
 * anticipated (e.g., music.youtube.com).
 *
 * @returns {string|null}
 */
function getDomain() {
  const host = window.location.hostname.replace(/^www\./, '');
  if (host.includes('youtube.com'))  return 'youtube';
  if (host.includes('twitter.com'))  return 'twitter';
  if (host.includes('x.com'))        return 'x';
  if (host.includes('reddit.com'))   return 'reddit';
  return null;
}

// ── 2. Content Root ────────────────────────────────────────────────────────

/**
 * getContentRoot()
 * Returns the DOM element we will blur for the current platform.
 * Tries each comma-separated selector in order and returns the first hit.
 * Falls back to document.body if nothing matches (shouldn't happen).
 *
 * @returns {Element}
 */
function getContentRoot() {
  const selectors = (PLATFORM_BLUR_SELECTORS[domain] || '').split(',').map(s => s.trim());
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return document.body; // safe fallback
}

// ── 3. Spoiler Scan ────────────────────────────────────────────────────────

/**
 * extractText(node)
 * Recursively collects textContent from a node, skipping tag types in
 * SKIP_TAGS. Using textContent instead of innerText avoids forcing a layout
 * reflow (significant perf win on large DOM trees).
 *
 * @param {Node} node
 * @returns {string}
 */
function extractText(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  if (SKIP_TAGS.has(node.tagName)) return '';

  let text = '';
  for (const child of node.childNodes) {
    text += extractText(child);
  }
  return text;
}

/**
 * scanForSpoilers()
 * Queries only the platform-specific content containers, then extracts text
 * from each and checks for keyword matches.
 *
 * Returns true if a match is found, false otherwise.
 * Bails immediately on first match to minimise work.
 *
 * @returns {boolean}
 */
function scanForSpoilers() {
  if (blurred || !keywords.length) return false;

  const sel = PLATFORM_SCAN_SELECTORS[domain];
  if (!sel) return false;

  // querySelectorAll is lazy (NodeList) – we iterate and bail early
  const containers = document.querySelectorAll(sel);

  for (const container of containers) {
    const text = extractText(container).toLowerCase();
    for (const kw of keywords) {
      if (text.includes(kw)) {
        console.info(`[SpoilerShield] Keyword matched: "${kw}"`);
        return true;
      }
    }
  }

  return false;
}

// ── 4. Blur & Overlay ──────────────────────────────────────────────────────

/**
 * blurContent()
 * Applies CSS blur to the platform content root and inserts the overlay.
 * Also disables scrolling and pointer events on the page body.
 *
 * The overlay is a single fixed <div> appended to document.body so it sits
 * above everything including the blurred content root.
 *
 * Clicking the overlay removes all effects (restoreContent).
 */
function blurContent() {
  if (blurred) return; // prevent duplicate application
  blurred = true;

  // Stop observer – no more scanning needed
  if (observer) {
    observer.disconnect();
    observer = null;
  }

  const root = getContentRoot();

  // Blur + pointer-events:none on the content area
  root.style.cssText += ';filter:blur(18px);pointer-events:none;user-select:none;transition:filter 0.3s ease;';

  // Prevent body scroll while blurred
  document.body.style.overflow = 'hidden';

  // ── Build Overlay ──────────────────────────────────────────────────────
  if (document.getElementById(OVERLAY_ID)) return; // guard: no duplicates

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-label', 'Spoiler detected. Click to reveal.');

  // Overlay styles are set inline for portability (style.css covers the class)
  overlay.innerHTML = `
    <div class="ss-overlay-inner">
      <div class="ss-icon">🛡</div>
      <h2 class="ss-title">⚠ Spoiler Detected</h2>
      <p class="ss-sub">Click anywhere to reveal</p>
    </div>
  `;

  document.body.appendChild(overlay);

  // Single click on overlay restores everything
  overlay.addEventListener('click', restoreContent, { once: true });
}

/**
 * restoreContent()
 * Removes blur, re-enables interaction, and removes the overlay.
 * Called when the user clicks the overlay.
 */
function restoreContent() {
  blurred = false; // allow future scans if user navigates (SPA)

  const root = getContentRoot();
  root.style.filter         = '';
  root.style.pointerEvents  = '';
  root.style.userSelect     = '';

  document.body.style.overflow = '';

  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();

  // Re-attach observer so navigation to new content is still monitored
  setupObserver();
}

// ── 5. MutationObserver Setup ──────────────────────────────────────────────

/**
 * setupObserver()
 * Installs a MutationObserver on the content root (or body as fallback).
 *
 * HOW MutationObserver WORKS:
 * ──────────────────────────────────────────────────────────────────────────
 * MutationObserver is a native browser API that fires a callback whenever
 * the DOM changes. We pass { childList: true, subtree: true } which means:
 *   • childList  – notify when child nodes are added or removed
 *   • subtree    – watch all descendants, not just direct children
 *
 * Each callback receives an array of MutationRecord objects. We don't need
 * to inspect these records because we re-scan the full container set anyway.
 *
 * DEBOUNCE:
 * SPAs like YouTube can fire dozens of mutations per second when content
 * loads. Without debouncing we'd run scanForSpoilers() excessively.
 * Instead, each mutation callback resets a 300 ms timer. The scan only
 * runs after 300 ms of DOM silence – collapsing burst mutations into one scan.
 *
 * INFINITE LOOP PREVENTION:
 * The observer watches the content root for new nodes.
 * blurContent() itself only touches CSS properties (style), not childList,
 * so it does NOT trigger the observer. The blurred flag further ensures we
 * do nothing if triggered again before disconnect.
 */
function setupObserver() {
  if (observer) return; // already running

  // Prefer the platform root element; fallback to body
  const target = getContentRoot() || document.body;

  observer = new MutationObserver((_mutations) => {
    // Debounce: cancel any pending scan and restart the timer
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (scanForSpoilers()) {
        blurContent();
      }
    }, DEBOUNCE_DELAY);
  });

  observer.observe(target, { childList: true, subtree: true });
  console.info('[SpoilerShield] Observer active on', target.tagName || 'BODY');
}

// ── Initialisation ─────────────────────────────────────────────────────────

/**
 * init()
 * Entry point. Reads settings from chrome.storage, validates the platform,
 * does an immediate scan, then sets up the MutationObserver for future changes.
 */
async function init() {
  try {
    domain = getDomain();
    if (!domain) return; // unsupported site – exit silently

    const data = await chrome.storage.sync.get({ keywords: [], enabled: true });

    if (!data.enabled) {
      console.info('[SpoilerShield] Shield is disabled by user.');
      return;
    }

    keywords = data.keywords.map(k => k.toLowerCase().trim()).filter(Boolean);

    if (!keywords.length) {
      console.info('[SpoilerShield] No keywords configured.');
      return;
    }

    console.info(`[SpoilerShield] Active on "${domain}" with ${keywords.length} keyword(s).`);

    // Immediate scan – catches content already in DOM at load time
    if (scanForSpoilers()) {
      blurContent();
      return; // observer not needed if already blurred
    }

    // Watch for dynamically loaded content (infinite scroll, SPA navigation)
    setupObserver();

    // Re-run when user navigates within the SPA (pushState / replaceState)
    // YouTube and Twitter don't fire 'load' on SPA transitions, so we hook
    // into the History API by intercepting pushState.
    const originalPushState = history.pushState.bind(history);
    history.pushState = function (...args) {
      originalPushState(...args);
      handleNavigation();
    };
    window.addEventListener('popstate', handleNavigation);

  } catch (err) {
    console.error('[SpoilerShield] init error:', err);
  }
}

/**
 * handleNavigation()
 * Called when the SPA navigates to a new "page" (URL change without reload).
 * Resets state and starts fresh scanning on the new content.
 *
 * We wait 800 ms to give the SPA time to render its new content before scanning.
 */
function handleNavigation() {
  // Disconnect any existing observer
  if (observer) { observer.disconnect(); observer = null; }
  clearTimeout(debounceTimer);

  // If currently blurred, clean up UI first
  if (blurred) {
    restoreContent();
    return; // restoreContent re-attaches observer
  }

  // Small delay – SPA frameworks need a tick to render new route content
  setTimeout(() => {
    if (!blurred) {
      if (scanForSpoilers()) {
        blurContent();
      } else {
        setupObserver();
      }
    }
  }, 800);
}

// ── Storage Change Listener ────────────────────────────────────────────────

/**
 * Listen for changes made in the popup (e.g. new keywords added while
 * the user is browsing). We reload keywords and re-scan immediately.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;

  if (changes.enabled) {
    const nowEnabled = changes.enabled.newValue;
    if (!nowEnabled && observer) {
      observer.disconnect();
      observer = null;
      console.info('[SpoilerShield] Disabled via popup.');
    }
    if (nowEnabled && !observer && !blurred) {
      setupObserver();
    }
  }

  if (changes.keywords) {
    keywords = (changes.keywords.newValue || []).map(k => k.toLowerCase().trim()).filter(Boolean);
    console.info('[SpoilerShield] Keywords updated:', keywords);
    // Re-scan with updated keywords
    if (!blurred && scanForSpoilers()) {
      blurContent();
    }
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────
init();