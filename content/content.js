/**
 * content/content.js – SpoilerShield v3 (Show-Aware Spoiler Detection)
 *
 * ── WHAT CHANGED FROM V2 ──────────────────────────────────────────────────
 *
 * V2 had a generic Stage 1 that checked every post for words like "dies" or
 * "ending" — but had no idea WHAT the user cared about. This caused false
 * positives (blurring random posts about death or endings that had nothing
 * to do with anything the user was watching).
 *
 * V3 replaces that with a show-aware two-stage pipeline:
 *
 *   Stage 1 – Show mention check (instant, zero cost)
 *     Does this post mention ANY of the user's protected shows by name?
 *     e.g. if the user added "Breaking Bad" — does this post say "breaking bad"?
 *     If NO → skip entirely. If YES → move to Stage 2.
 *
 *   Stage 2 – Gemini spoiler confirmation (async, only for show-relevant posts)
 *     "Does this text contain spoilers for [Show Name]?"
 *     Gemini replies YES or NO.
 *     If YES → blur the post and show "⚠ Spoiler Hidden – [Show Name]"
 *
 * This is much more accurate because:
 *   • Only posts that actually MENTION the show reach Gemini
 *   • Gemini gets the show name as context ("is this a spoiler for X?")
 *   • The overlay tells the user WHICH show triggered the blur
 *   • Far fewer false positives and far fewer API calls
 *
 * ── FULL PIPELINE ─────────────────────────────────────────────────────────
 *
 *   Post text extracted
 *         │
 *         ▼
 *   Stage 1: Does text mention any protected show?
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
 *                                   "Do you want to see the spoiler? Click to reveal"
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────

/** Tags whose text we never read — they hold code, not content */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'META', 'LINK']);

/**
 * Per-platform CSS selectors for individual post containers.
 * Blur is applied at this element level — not the whole page.
 */
const PLATFORM_POST_SELECTORS = {
  youtube : 'ytd-rich-item-renderer, ytd-video-primary-info-renderer, ytd-comment-renderer, ytd-compact-video-renderer',
  twitter : 'article',
  x       : 'article',
  reddit  : 'shreddit-post, .thing, [data-testid="post-container"], .Post',
};

const GEMINI_API_URL  = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=';
const DEBOUNCE_DELAY  = 400; // ms

// ── Module State ───────────────────────────────────────────────────────────
let domain          = null;
let geminiApiKey    = '';
let shieldEnabled   = true;
let protectedShows  = [];   // string[] — lowercase show/movie names from storage
let observer        = null;
let debounceTimer   = null;

/**
 * seenPosts – WeakSet<Element>
 * Tracks posts already processed so we never send the same post to Gemini twice.
 * WeakSet entries are garbage-collected when the element is removed from DOM.
 */
const seenPosts = new WeakSet();

// ── 1. Domain Detection ────────────────────────────────────────────────────

function getDomain() {
  const host = window.location.hostname.replace(/^www\./, '');
  if (host.includes('youtube.com'))  return 'youtube';
  if (host.includes('twitter.com'))  return 'twitter';
  if (host.includes('x.com'))        return 'x';
  if (host.includes('reddit.com'))   return 'reddit';
  return null;
}

// ── 2. Text Extraction ─────────────────────────────────────────────────────

/**
 * extractText(node)
 * Recursively collects text from a DOM subtree, skipping non-content tags.
 * textContent is used instead of innerText to avoid layout reflow.
 */
function extractText(node) {
  if (node.nodeType === Node.TEXT_NODE)    return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  if (SKIP_TAGS.has(node.tagName))         return '';
  let text = '';
  for (const child of node.childNodes) text += extractText(child);
  return text;
}

// ── 3. Stage 1 – Show Mention Check ───────────────────────────────────────

/**
 * findMentionedShow(text)
 *
 * Checks whether the post text mentions any of the user's protected shows.
 * Returns the FIRST matching show name, or null if none match.
 *
 * WHY THIS APPROACH:
 * Simply checking if the show name appears as a substring is fast and works
 * well for most cases. "breaking bad" will match "I watched breaking bad last
 * night", "breaking bad season 5", "BreakingBad" won't match (intentional —
 * hashtags without spaces are usually UI noise, not post content).
 *
 * We also check for common abbreviations the user might not have added:
 * if they added "game of thrones" we also check "got" as a bonus.
 * For now we keep this simple — just substring match on the full name.
 *
 * @param   {string}      text – lowercased post text
 * @returns {string|null}      – matched show name or null
 */
function findMentionedShow(text) {
  for (const show of protectedShows) {
    if (text.includes(show)) {
      return show; // return the first match
    }
  }
  return null;
}

// ── 4. Stage 2 – Gemini Spoiler Check ─────────────────────────────────────

/**
 * askGemini(text, showName)
 *
 * Sends the post text to Gemini 1.5 Flash with a show-specific prompt.
 *
 * PROMPT DESIGN:
 * Including the show name is critical. It tells Gemini exactly what to look
 * for. Without it, Gemini would have to guess whether "he dies at the end"
 * is a spoiler for anything. With it, Gemini knows the context and can make
 * a much better YES/NO decision.
 *
 * @param   {string}           text     – post text (will be truncated to 1500 chars)
 * @param   {string}           showName – the show that was mentioned
 * @returns {Promise<boolean>}          – true if Gemini confirms it's a spoiler
 */
async function askGemini(text, showName) {
  if (!geminiApiKey) {
    console.warn('[SpoilerShield] No API key set — skipping Gemini check.');
    return false;
  }

  const trimmed = text.trim().slice(0, 1500);

  // Show-specific prompt — Gemini now knows exactly what we're protecting
  const prompt = `You are a spoiler detection assistant for a browser extension.

The user has NOT yet watched "${showName}" and wants to avoid spoilers.

Analyze the following text and decide: does it reveal spoilers about "${showName}"?

A spoiler includes: character deaths, plot twists, season or series endings,
villain reveals, relationship outcomes, or any major story event.

Reply with ONE word only:
- YES if the text contains spoilers about "${showName}"
- NO if it does not

Do not explain. Do not add punctuation. One word only.

Text:
${trimmed}`;

  console.log(`[SpoilerShield] Asking Gemini about "${showName}"…`);

  try {
    const response = await fetch(`${GEMINI_API_URL}${geminiApiKey}`, {
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

    const data     = await response.json();
    const reply    = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned  = reply.trim().toUpperCase();

    console.log(`[SpoilerShield] Gemini reply for "${showName}": ${cleaned}`);
    return cleaned.startsWith('YES');

  } catch (err) {
    console.error('[SpoilerShield] Gemini fetch failed:', err);
    return false;
  }
}

// ── 5. Per-Post Blur with Show Name ───────────────────────────────────────

/**
 * blurPost(postEl, showName)
 *
 * Blurs a single post container and adds a click-to-reveal overlay.
 * The overlay shows WHICH show triggered the blur and asks the user
 * if they want to see it — much clearer than a generic "spoiler hidden".
 *
 * Clicking "Yes, show it" reveals the post immediately.
 * The post stays revealed for the rest of the session.
 *
 * @param {Element} postEl   – the post DOM element to blur
 * @param {string}  showName – the show name that triggered this blur
 */
function blurPost(postEl, showName) {
  if (postEl.dataset.ssBlurred === 'true') return; // already blurred
  postEl.dataset.ssBlurred = 'true';

  // Ensure overlay is positioned relative to this post container
  if (!postEl.style.position || postEl.style.position === 'static') {
    postEl.style.position = 'relative';
  }

  // Apply blur to the post content itself
  postEl.style.filter     = 'blur(10px)';
  postEl.style.userSelect = 'none';
  postEl.style.transition = 'filter 0.35s ease';

  // Capitalise show name nicely for display (e.g. "breaking bad" → "Breaking Bad")
  const displayName = showName
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  // Build overlay — sits inside the post at position:absolute
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
      <button class="ss-reveal-btn" id="ss-reveal-${Date.now()}">
        Yes, show it
      </button>
    </div>
  `;

  // The reveal button unblurs just this post
  const revealBtn = overlay.querySelector('.ss-reveal-btn');
  revealBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // prevent any parent click handlers firing
    revealPost(postEl, overlay);
  }, { once: true });

  postEl.appendChild(overlay);
  console.log(`[SpoilerShield] Blurred post for show: "${displayName}"`);
}

/**
 * revealPost(postEl, overlay)
 * Removes the blur and overlay from a single post when the user clicks reveal.
 *
 * @param {Element} postEl
 * @param {Element} overlay
 */
function revealPost(postEl, overlay) {
  postEl.style.filter      = '';
  postEl.style.userSelect  = '';
  postEl.dataset.ssBlurred = 'false';
  overlay.remove();
  console.log('[SpoilerShield] Post revealed by user.');
}

/** escapeHtml — prevent XSS when injecting show names into innerHTML */
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ── 6. Process a Single Post ───────────────────────────────────────────────

/**
 * processPost(postEl)
 *
 * Full detection pipeline for one post element:
 *   1. Skip if already seen (WeakSet deduplication — no duplicate API calls)
 *   2. Extract text from the post
 *   3. Stage 1: Does the post mention any protected show? → if NO, skip
 *   4. Stage 2: Ask Gemini "is this a spoiler for [show]?" → if NO, skip
 *   5. Blur the post with show name in the overlay
 *
 * @param {Element} postEl
 */
async function processPost(postEl) {
  // ── Deduplication ─────────────────────────────────────────────────────
  if (seenPosts.has(postEl)) return;
  seenPosts.add(postEl); // mark before any async work to block concurrent calls

  const rawText = extractText(postEl).trim();
  if (!rawText) return; // empty / image-only post

  const text = rawText.toLowerCase();

  // ── Stage 1: Show mention check ───────────────────────────────────────
  const matchedShow = findMentionedShow(text);

  if (!matchedShow) {
    // Post doesn't mention any protected show — ignore completely
    return;
  }

  console.log(`[SpoilerShield] Post mentions "${matchedShow}" — checking with Gemini…`);

  // ── Stage 2: Gemini confirmation ──────────────────────────────────────
  const isSpoiler = await askGemini(rawText, matchedShow);

  if (isSpoiler) {
    blurPost(postEl, matchedShow);
  } else {
    console.log(`[SpoilerShield] Gemini: not a spoiler for "${matchedShow}".`);
  }
}

// ── 7. Scan All Posts ──────────────────────────────────────────────────────

/**
 * scanAllPosts()
 * Finds all post containers for the current platform and runs processPost()
 * on each. Already-seen posts skip instantly via WeakSet.
 * Exits early if shield is off, no API key, or no protected shows.
 */
function scanAllPosts() {
  // Early exits — nothing to do in these states
  if (!shieldEnabled)          return;
  if (!geminiApiKey)           return;
  if (!protectedShows.length)  {
    console.log('[SpoilerShield] No protected shows — add a show in the popup.');
    return;
  }

  const sel = PLATFORM_POST_SELECTORS[domain];
  if (!sel) return;

  const posts = document.querySelectorAll(sel);
  console.log(`[SpoilerShield] Scanning ${posts.length} post(s) for: ${protectedShows.join(', ')}`);

  // Fire-and-forget — we don't block the scan loop on Gemini responses
  posts.forEach(post => processPost(post));
}

// ── 8. MutationObserver ────────────────────────────────────────────────────

/**
 * setupObserver()
 * Watches document.body for new DOM nodes (infinite scroll / lazy load).
 * Debounced at 400 ms to collapse rapid mutation bursts into one scan.
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

// ── 9. SPA Navigation ──────────────────────────────────────────────────────

/**
 * handleNavigation()
 * YouTube, Twitter, Reddit are SPAs — page changes don't reload the script.
 * We intercept pushState + popstate to re-scan after each navigation.
 * 800 ms delay lets the SPA render its new content before we scan.
 */
function handleNavigation() {
  console.log('[SpoilerShield] SPA navigation detected — re-scanning…');
  clearTimeout(debounceTimer);
  setTimeout(scanAllPosts, 800);
}

// ── 10. Storage Change Listener ────────────────────────────────────────────

/**
 * Reacts to popup changes in real time — no page reload needed.
 * Handles: enabled toggle, API key update, show list update.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;

  if (changes.enabled !== undefined) {
    shieldEnabled = changes.enabled.newValue;
    console.log(`[SpoilerShield] Shield ${shieldEnabled ? 'enabled' : 'disabled'}.`);
    if (shieldEnabled) scanAllPosts();
  }

  if (changes.geminiApiKey !== undefined) {
    geminiApiKey = changes.geminiApiKey.newValue || '';
    console.log('[SpoilerShield] API key updated.');
    if (geminiApiKey && shieldEnabled) scanAllPosts();
  }

  // ── New in v3: react when the user adds or removes a show ──────────────
  if (changes.protectedShows !== undefined) {
    protectedShows = (changes.protectedShows.newValue || []).map(s => s.toLowerCase().trim());
    console.log('[SpoilerShield] Protected shows updated:', protectedShows);

    // Immediately scan with the updated show list
    if (shieldEnabled && geminiApiKey) scanAllPosts();
  }
});

// ── 11. Initialisation ─────────────────────────────────────────────────────

/**
 * init()
 * Entry point. Loads all settings, then starts scanning and observing.
 */
async function init() {
  try {
    domain = getDomain();
    if (!domain) return; // unsupported site — exit silently

    const data = await chrome.storage.sync.get({
      enabled        : true,
      geminiApiKey   : '',
      protectedShows : [],
    });

    shieldEnabled  = data.enabled;
    geminiApiKey   = data.geminiApiKey;
    protectedShows = (data.protectedShows || []).map(s => s.toLowerCase().trim());

    console.log(
      `[SpoilerShield] v3 active on "${domain}" | ` +
      `enabled=${shieldEnabled} | ` +
      `shows=[${protectedShows.join(', ')}] | ` +
      `hasKey=${!!geminiApiKey}`
    );

    if (!shieldEnabled) {
      console.log('[SpoilerShield] Shield disabled — exiting.');
      return;
    }

    if (!geminiApiKey) {
      console.warn('[SpoilerShield] No API key — open the popup to add one.');
      return;
    }

    if (!protectedShows.length) {
      console.warn('[SpoilerShield] No shows added — open the popup to add a show.');
      // Still set up the observer so we react the moment a show is added
    }

    // Scan content already in the DOM
    scanAllPosts();

    // Watch for dynamically loaded content
    setupObserver();

    // Hook SPA navigation
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

// ── Boot ───────────────────────────────────────────────────────────────────
init();