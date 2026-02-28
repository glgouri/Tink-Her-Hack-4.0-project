/**
 * popup/popup.js – SpoilerShield v3
 *
 * WHAT'S NEW IN V3
 * ────────────────────────────────────────────────────────────────────────
 * • `protectedShows` array — stores show/movie names the user wants shielded.
 * • addShow() / removeShow() / renderShows() — mirror the existing keyword
 *   CRUD pattern exactly, just saved under a different storage key.
 * • showCount badge updates live as shows are added/removed.
 * • All existing keyword + API key logic is UNCHANGED.
 */

'use strict';

// ── DOM Refs ───────────────────────────────────────────────────────────────

// Existing
const enabledToggle = document.getElementById('enabledToggle');
const keywordInput  = document.getElementById('keywordInput');
const addBtn        = document.getElementById('addBtn');
const tagList       = document.getElementById('tagList');
const emptyMsg      = document.getElementById('emptyMsg');
const statusBar     = document.getElementById('statusBar');
const apiKeyInput   = document.getElementById('apiKeyInput');
const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');
const toggleApiVis  = document.getElementById('toggleApiVis');

// New in v3
const showInput     = document.getElementById('showInput');
const addShowBtn    = document.getElementById('addShowBtn');
const showList      = document.getElementById('showList');
const showEmptyMsg  = document.getElementById('showEmptyMsg');
const showCount     = document.getElementById('showCount');

// ── State ──────────────────────────────────────────────────────────────────
let keywords        = [];
let protectedShows  = []; // e.g. ["breaking bad", "oppenheimer"]

// ── Storage Helpers ────────────────────────────────────────────────────────

/**
 * loadSettings()
 * Reads all persisted values from chrome.storage.sync and populates the UI.
 * Now also loads `protectedShows`.
 */
async function loadSettings() {
  try {
    const data = await chrome.storage.sync.get({
      keywords       : [],
      enabled        : true,
      geminiApiKey   : '',
      protectedShows : [],   // ← new
    });

    keywords       = data.keywords;
    protectedShows = data.protectedShows;

    enabledToggle.checked = data.enabled;
    if (apiKeyInput) apiKeyInput.value = data.geminiApiKey || '';

    renderTags();
    renderShows();   // ← new

  } catch (err) {
    showStatus('Error loading settings', false);
    console.error('[SpoilerShield] loadSettings error:', err);
  }
}

/**
 * saveSettings()
 * Persists keywords + enabled toggle.
 * Shows and API key have their own dedicated save calls.
 */
async function saveSettings() {
  try {
    await chrome.storage.sync.set({ keywords, enabled: enabledToggle.checked });
    showStatus('Saved ✓', true);
  } catch (err) {
    showStatus('Save failed', false);
    console.error('[SpoilerShield] saveSettings error:', err);
  }
}

/**
 * saveShows()
 * Persists the protectedShows array to chrome.storage.sync.
 * content.js listens via storage.onChanged and reacts immediately —
 * no page reload required.
 */
async function saveShows() {
  try {
    await chrome.storage.sync.set({ protectedShows });
    // No status flash here — renderShows() already gives visual feedback
  } catch (err) {
    showStatus('Save failed', false);
    console.error('[SpoilerShield] saveShows error:', err);
  }
}

/**
 * saveApiKey()
 * Validates and saves the Gemini API key.
 */
async function saveApiKey() {
  const key = apiKeyInput ? apiKeyInput.value.trim() : '';
  if (!key) { showStatus('API key cannot be empty', false); return; }
  if (!key.startsWith('AIza')) { showStatus('Key should start with "AIza"', false); return; }
  try {
    await chrome.storage.sync.set({ geminiApiKey: key });
    showStatus('API key saved ✓', true);
  } catch (err) {
    showStatus('Save failed', false);
    console.error('[SpoilerShield] saveApiKey error:', err);
  }
}

// ── Show CRUD ──────────────────────────────────────────────────────────────

/**
 * addShow()
 * Reads the showInput value, validates it, adds to protectedShows, and saves.
 * Show names are stored lowercase for case-insensitive matching in content.js.
 */
function addShow() {
  const raw = showInput.value.trim().toLowerCase();
  if (!raw) return;

  if (protectedShows.includes(raw)) {
    showStatus(`"${raw}" already protected`, false);
    showInput.select();
    return;
  }

  protectedShows.push(raw);
  showInput.value = '';
  renderShows();
  saveShows();
  showStatus(`"${raw}" added ✓`, true);
}

/**
 * removeShow(index)
 * Removes a show by index from the array, re-renders, and saves.
 */
function removeShow(index) {
  const removed = protectedShows[index];
  protectedShows.splice(index, 1);
  renderShows();
  saveShows();
  showStatus(`"${removed}" removed`, true);
}

/**
 * renderShows()
 * Clears and re-draws all show tags in #showList.
 * Uses purple .show-tag chips to visually distinguish from keyword tags.
 * Also updates the live count badge.
 */
function renderShows() {
  // Remove existing show-tag elements
  [...showList.querySelectorAll('.show-tag')].forEach(t => t.remove());

  // Show/hide empty state message
  showEmptyMsg.style.display = protectedShows.length === 0 ? 'block' : 'none';

  // Update the count badge in the section label
  if (showCount) showCount.textContent = protectedShows.length;

  protectedShows.forEach((show, index) => {
    const tag = document.createElement('span');
    tag.className = 'show-tag';
    tag.innerHTML = `
      <span>🎬 ${escapeHtml(show)}</span>
      <button class="show-del" data-index="${index}" title="Remove show">×</button>
    `;
    showList.appendChild(tag);
  });
}

// ── Keyword CRUD (unchanged from v2) ──────────────────────────────────────

function renderTags() {
  [...tagList.querySelectorAll('.tag')].forEach(t => t.remove());
  emptyMsg.style.display = keywords.length === 0 ? 'block' : 'none';
  keywords.forEach((kw, index) => {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.innerHTML = `
      <span>${escapeHtml(kw)}</span>
      <button class="tag-del" data-index="${index}" title="Remove">×</button>
    `;
    tagList.appendChild(tag);
  });
}

function addKeyword() {
  const raw = keywordInput.value.trim().toLowerCase();
  if (!raw) return;
  if (keywords.includes(raw)) { showStatus('Already exists', false); keywordInput.select(); return; }
  keywords.push(raw);
  keywordInput.value = '';
  renderTags();
  saveSettings();
}

function removeKeyword(index) {
  keywords.splice(index, 1);
  renderTags();
  saveSettings();
}

// ── UI Helpers ─────────────────────────────────────────────────────────────

let statusTimer = null;
function showStatus(msg, success = true) {
  statusBar.textContent = msg;
  statusBar.className   = 'status' + (success ? ' saved' : ' error');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusBar.textContent = 'Ready';
    statusBar.className   = 'status';
  }, 1800);
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ── Event Listeners ────────────────────────────────────────────────────────

// Existing
addBtn.addEventListener('click', addKeyword);
keywordInput.addEventListener('keydown', e => { if (e.key === 'Enter') addKeyword(); });
tagList.addEventListener('click', e => {
  const del = e.target.closest('.tag-del');
  if (del) removeKeyword(parseInt(del.dataset.index, 10));
});
enabledToggle.addEventListener('change', saveSettings);
if (saveApiKeyBtn) saveApiKeyBtn.addEventListener('click', saveApiKey);
if (apiKeyInput)   apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveApiKey(); });
if (toggleApiVis && apiKeyInput) {
  toggleApiVis.addEventListener('click', () => {
    const hidden = apiKeyInput.type === 'password';
    apiKeyInput.type = hidden ? 'text' : 'password';
    toggleApiVis.textContent = hidden ? '🙈' : '👁';
  });
}

// New in v3 — show add/remove
addShowBtn.addEventListener('click', addShow);
showInput.addEventListener('keydown', e => { if (e.key === 'Enter') addShow(); });
showList.addEventListener('click', e => {
  const del = e.target.closest('.show-del');
  if (del) removeShow(parseInt(del.dataset.index, 10));
});

// ── Init ───────────────────────────────────────────────────────────────────
loadSettings();