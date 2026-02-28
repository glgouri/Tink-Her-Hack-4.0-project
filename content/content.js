/**
 * content.js – SpoilerShield v3 (Platform-Aware)
 *
 * ARCHITECTURE OVERVIEW
 * ──────────────────────────────────────────────────────────────────────────
 * 1. getDomain()         – Detects which supported platform we're on.
 * 2. extractText()       – Recursively collects text from a DOM node,
 *                          skipping script/style/noscript tags.
 * 3. findMentionedShow() – Stage 1: checks if a post mentions any protected
 *                          show for the current platform.
 * 4. askGemini()         – Stage 2: asks Gemini 1.5 Flash whether the post
 *                          actually spoils the matched show.
 * 5. blurPost()          – Applies per-post blur + click-to-reveal overlay.
 * 6. processPost()       – Full pipeline for one post element.
 * 7. scanAllPosts()      – Queries all post containers and runs processPost().
 * 8. setupObserver()     – MutationObserver for infinite scroll / lazy load.
 * 9. handleNavigation()  – Re-scans after SPA route changes.
 * 10. init()             – Entry point: loads settings, scans, observes.
 *
 * STORAGE STRUCTURE (v3 platform-aware)
 * ──────────────────────────────────────────────────────────────────────────
 * chrome.storage.sync stores:
 *   showsByPlatform:    { youtube: [], reddit: [], twitter: [] }
 *   keywordsByPlatform: { youtube: [], reddit: [], twitter: [] }
 *   enabled:            boolean
 *
 * content.js reads only the slice for the current platform (domain), so
 * YouTube tabs use YouTube shows/keywords, Reddit uses Reddit's, etc.
 *
 * DETECTION PIPELINE
 * ──────────────────────────────────────────────────────────────────────────
 *   Post text extracted
 *         │
 *         ▼
 *   Stage 1: Does text mention any protected show for THIS platform?
 *         │
 *         ├── NO  → skip (Gemini not called)
 *         │
 *         └── YES → which show matched?
 *                         │
 *                         ▼
 *                   Stage 2: Ask Gemini
 *                   "Does this spoil [Show Name]?"
 *                         │
 *                         ├── NO  → not a spoiler, do nothing
 *                         │
 *                         └── YES → blur post
 *                                   show "⚠ Spoiler Hidden – [Show Name]"
 *                                   "Do you want to see it? Click to reveal"
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Tags whose text content we never read — they hold code, not prose. */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'META', 'LINK']);

/**
 * Per-platform CSS selectors for individual post containers.
 * Blur is applied at this level — not the whole page.
 */
const PLATFORM_POST_SELECTORS = {
  youtube : 'ytd-rich-item-renderer, ytd-video-primary-info-renderer, ytd-comment-renderer, ytd-compact-video-renderer',
  twitter : 'article',
  x       : 'article',
  reddit  : 'shreddit-post, .thing, [data-testid="post-container"], .Post',
};

/**
 * Per-platform blur-target selectors.
 * Used by getContentRoot() as the MutationObserver target.
 */
const PLATFORM_BLUR_SELECTORS = {
  youtube : 'ytd-app, #contents',
  twitter : 'main',
  x       : 'main',
  reddit  : 'shreddit-app, #SHORTCUT_FOCUSABLE_DIV, .ListingLayout-backgroundContainer, main',
};

// ── Hardcoded Gemini credentials ──────────────────────────────────────────────
const GEMINI_API_KEY = 'AIzaSyD3ZzkwGPZyrKdChe8OclF4_GO9pnXR3Zs';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const DEBOUNCE_DELAY = 400; // ms — collapses rapid mutation bursts into one scan

// ── Module State ──────────────────────────────────────────────────────────────

let domain         = null;  // 'youtube' | 'twitter' | 'x' | 'reddit' | null
let shieldEnabled  = true;
let protectedShows = [];    // string[] — lowercase show names for THIS platform
let keywords       = [];    // string[] — lowercase keywords for THIS platform
let observer       = null;
let debounceTimer  = null;

/**
 * seenPosts — WeakSet<Element>
 * Tracks posts already sent to the pipeline so we never call Gemini twice
 * for the same element. Entries are GC'd when the element leaves the DOM.
 */
const seenPosts = new WeakSet();

// ── 1. Domain Detection ───────────────────────────────────────────────────────

/**
 * getDomain()
 * Maps window.location.hostname to a canonical platform key.
 * Returns null for unsupported sites — init() exits silently in that case.
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

// ── 2. Content Root ───────────────────────────────────────────────────────────

/**
 * getContentRoot()
 * Returns the platform-specific wrapper element used as the
 * MutationObserver target. Falls back to document.body.
 *
 * @returns {Element}
 */
function getContentRoot() {
  const selectors = (PLATFORM_BLUR_SELECTORS[domain] || '').split(',').map(s => s.trim());
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return document.body;
}

// ── 3. Text Extraction ────────────────────────────────────────────────────────

/**
 * extractText(node)
 * Recursively collects text from a DOM subtree, skipping non-content tags.
 * Uses textContent instead of innerText to avoid layout reflow.
 *
 * @param   {Node}   node
 * @returns {string}
 */
function extractText(node) {
  if (node.nodeType === Node.TEXT_NODE)    return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  if (SKIP_TAGS.has(node.tagName))         return '';
  let text = '';
  for (const child of node.childNodes) text += extractText(child);
  return text;
}

// ── 4. Stage 1 — Show Mention Check ──────────────────────────────────────────

/**
 * findMentionedShow(text)
 * Checks whether the post text mentions any of the user's protected shows
 * for the CURRENT platform. Returns the first match, or null.
 *
 * Only posts that mention a show proceed to Gemini — this keeps API usage low
 * and eliminates false positives from generic words like "dies" or "ending".
 *
 * @param   {string}      text – lowercased post text
 * @returns {string|null}      – matched show name, or null
 */
function findMentionedShow(text) {
  for (const show of protectedShows) {
    if (text.includes(show)) return show;
  }
  return null;
}

// ── 5. Stage 2 — Gemini Spoiler Check ────────────────────────────────────────

/**
 * askGemini(text, showName)
 * Sends post text to the hardcoded Gemini 1.5 Flash endpoint.
 * Returns true if Gemini confirms the text is a spoiler for showName.
 *
 * @param   {string}           text     – raw post text (truncated to 1500 chars)
 * @param   {string}           showName – the show that was mentioned
 * @returns {Promise<boolean>}          – true = spoiler confirmed
 */
async function askGemini(text, showName) {
  const trimmed = text.trim().slice(0, 1500);

  const prompt =
`You are a spoiler detection assistant for a browser extension.
The user has NOT yet watched "${showName}" and wants to avoid spoilers.
Analyze the following text and decide: does it reveal spoilers about "${showName}"?
A spoiler includes: character deaths, plot twists, season or series endings,
villain reveals, relationship outcomes, or any major story event.

Reply with ONE word only:
- YES if the text contains spoilers about "${showName}"
- NO  if it does not

Do not explain. Do not add punctuation. One word only.

Text:
${trimmed}`;

  console.log(`[SpoilerShield] Asking Gemini about "${showName}"…`);

  try {
    const response = await fetch(GEMINI_API_URL, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`[SpoilerShield] Gemini error ${response.status}:`, err);
      return false;
    }

    const data    = await response.json();
    const reply   = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = reply.trim().toUpperCase();
    console.log(`[SpoilerShield] Gemini reply for "${showName}": ${cleaned}`);
    return cleaned.startsWith('YES');

  } catch (err) {
    console.error('[SpoilerShield] Gemini fetch failed:', err);
    return false;
  }
}

// ── 6. Per-Post Blur ──────────────────────────────────────────────────────────

/** Prevents XSS when injecting show names into innerHTML. */
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/**
 * blurPost(postEl, showName)
 * Blurs a single post and overlays a click-to-reveal prompt.
 * The overlay names WHICH show triggered the blur.
 *
 * @param {Element} postEl   – post DOM element to blur
 * @param {string}  showName – matched show name (lowercase)
 */
function blurPost(postEl, showName) {
  if (postEl.dataset.ssBlurred === 'true') return;
  postEl.dataset.ssBlurred = 'true';

  if (!postEl.style.position || postEl.style.position === 'static') {
    postEl.style.position = 'relative';
  }

  postEl.style.filter     = 'blur(10px)';
  postEl.style.userSelect = 'none';
  postEl.style.transition = 'filter 0.35s ease';

  const displayName = showName
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const overlay = document.createElement('div');
  overlay.className = 'ss-post-overlay';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-label', `Spoiler for ${displayName}. Click to reveal.`);

  overlay.innerHTML = `
    <div class="ss-post-overlay-inner">
      <span class="ss-post-icon">🛡</span>
      <span class="ss-post-show-name">${escapeHtml(displayName)}</span>
      <span class="ss-post-title">⚠ Spoiler Hidden</span>
      <span class="ss-post-question">Do you want to see this spoiler?</span>
      <button class="ss-reveal-btn">Yes, show it</button>
    </div>
  `;

  overlay.querySelector('.ss-reveal-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    revealPost(postEl, overlay);
  }, { once: true });

  postEl.appendChild(overlay);
  console.log(`[SpoilerShield] Blurred post for show: "${displayName}"`);
}

/**
 * revealPost(postEl, overlay)
 * Removes blur and overlay when the user clicks reveal.
 */
function revealPost(postEl, overlay) {
  postEl.style.filter      = '';
  postEl.style.userSelect  = '';
  postEl.dataset.ssBlurred = 'false';
  overlay.remove();
  console.log('[SpoilerShield] Post revealed by user.');
}

// ── 7. Process a Single Post ──────────────────────────────────────────────────

/**
 * processPost(postEl)
 * Full detection pipeline for one post element.
 *
 * @param {Element} postEl
 */
async function processPost(postEl) {
  if (seenPosts.has(postEl)) return;
  seenPosts.add(postEl);

  const rawText = extractText(postEl).trim();
  if (!rawText) return;

  const text = rawText.toLowerCase();

  const matchedShow = findMentionedShow(text);
  if (!matchedShow) return;

  console.log(`[SpoilerShield] Post mentions "${matchedShow}" on ${domain} — checking with Gemini…`);

  const isSpoiler = await askGemini(rawText, matchedShow);

  if (isSpoiler) {
    blurPost(postEl, matchedShow);
  } else {
    console.log(`[SpoilerShield] Gemini: not a spoiler for "${matchedShow}".`);
  }
}

// ── 8. Scan All Posts ─────────────────────────────────────────────────────────

/**
 * scanAllPosts()
 * Queries all post containers for the current platform and runs processPost().
 * Exits early if shield is off or no protected shows are configured.
 */
function scanAllPosts() {
  if (!shieldEnabled)         return;
  if (!protectedShows.length) {
    console.log('[SpoilerShield] No protected shows for this platform — add one in the popup.');
    return;
  }

  const sel = PLATFORM_POST_SELECTORS[domain];
  if (!sel) return;

  const posts = document.querySelectorAll(sel);
  console.log(`[SpoilerShield] Scanning ${posts.length} post(s) on ${domain} for: [${protectedShows.join(', ')}]`);

  posts.forEach(post => processPost(post));
}

// ── 9. MutationObserver ───────────────────────────────────────────────────────

/**
 * setupObserver()
 * Watches document.body for new DOM nodes (infinite scroll / lazy load).
 * Debounced at DEBOUNCE_DELAY ms to collapse rapid mutation bursts.
 */
function setupObserver() {
  if (observer) { observer.disconnect(); observer = null; }

  observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scanAllPosts, DEBOUNCE_DELAY);
  });

  observer.observe(document.body, { childList: true, subtree: true });
  console.log('[SpoilerShield] MutationObserver active.');
}

// ── 10. SPA Navigation ────────────────────────────────────────────────────────

/**
 * handleNavigation()
 * Re-scans after SPA route changes on YouTube / Twitter / Reddit.
 * 800 ms delay gives the framework time to render new content.
 */
function handleNavigation() {
  console.log('[SpoilerShield] SPA navigation detected — re-scanning…');
  clearTimeout(debounceTimer);
  setTimeout(scanAllPosts, 800);
}

// ── 11. Storage Change Listener ───────────────────────────────────────────────

/**
 * Reacts to popup changes in real time — no page reload needed.
 * Only listens for enabled toggle and show/keyword list changes.
 * API key is hardcoded so no listener needed for it.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;

  if (changes.enabled !== undefined) {
    shieldEnabled = changes.enabled.newValue;
    console.log(`[SpoilerShield] Shield ${shieldEnabled ? 'enabled' : 'disabled'}.`);
    if (shieldEnabled) scanAllPosts();
  }

  if (changes.showsByPlatform !== undefined) {
    const all = changes.showsByPlatform.newValue || {};
    const platformKey = domain === 'x' ? 'twitter' : domain;
    protectedShows = (all[platformKey] || []).map(s => s.toLowerCase().trim());
    console.log(`[SpoilerShield] Protected shows updated for ${domain}:`, protectedShows);
    if (shieldEnabled) scanAllPosts();
  }

  if (changes.keywordsByPlatform !== undefined) {
    const all = changes.keywordsByPlatform.newValue || {};
    const platformKey = domain === 'x' ? 'twitter' : domain;
    keywords = (all[platformKey] || []).map(k => k.toLowerCase().trim());
    console.log(`[SpoilerShield] Keywords updated for ${domain}:`, keywords);
    if (shieldEnabled) scanAllPosts();
  }
});

// ── 12. Initialisation ────────────────────────────────────────────────────────

/**
 * init()
 * Entry point. Detects platform, loads platform-specific settings,
 * performs an initial scan, and sets up the observer + SPA navigation hooks.
 * API key is hardcoded — no need to read it from storage.
 */
async function init() {
  try {
    domain = getDomain();
    if (!domain) return; // unsupported site — exit silently

    const data = await chrome.storage.sync.get({
      enabled            : true,
      showsByPlatform    : { youtube: [], reddit: [], twitter: [] },
      keywordsByPlatform : { youtube: [], reddit: [], twitter: [] },
    });

    shieldEnabled = data.enabled;

    // 'x' is twitter's domain alias — map it to the twitter storage key
    const platformKey = domain === 'x' ? 'twitter' : domain;
    protectedShows = (data.showsByPlatform[platformKey]    || []).map(s => s.toLowerCase().trim());
    keywords       = (data.keywordsByPlatform[platformKey] || []).map(k => k.toLowerCase().trim());

    console.log(
      `[SpoilerShield] v3 active | platform="${domain}" | ` +
      `enabled=${shieldEnabled} | ` +
      `shows=[${protectedShows.join(', ')}] | ` +
      `keywords=[${keywords.join(', ')}]`
    );

    if (!shieldEnabled) {
      console.log('[SpoilerShield] Shield disabled — exiting.');
      return;
    }

    if (!protectedShows.length) {
      console.warn(`[SpoilerShield] No shows for "${domain}" — open the popup to add one.`);
      // Still observe so we react the moment a show is added via the popup
    }

    // Initial scan — catches content already in the DOM at load time
    scanAllPosts();

    // Watch for dynamically loaded content (infinite scroll, lazy load)
    setupObserver();

    // Hook SPA navigation — YouTube / Twitter / Reddit don't fire 'load' on route changes
    const originalPushState = history.pushState.bind(history);
    history.pushState = function (...args) {
      originalPushState(...args);
      handleNavigation();
    };

    window.addEventListener('popstate', handleNavigation);

  } catch (err) {
    console.error('[SpoilerShield] init() failed:', err);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init();