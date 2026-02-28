/**
 * popup.js – SpoilerShield Extension Popup
 * Manages keyword storage and shield toggle via chrome.storage.sync.
 */

'use strict';

// ── DOM Refs ───────────────────────────────────────────────────────────────
const enabledToggle = document.getElementById('enabledToggle');
const keywordInput  = document.getElementById('keywordInput');
const addBtn        = document.getElementById('addBtn');
const tagList       = document.getElementById('tagList');
const emptyMsg      = document.getElementById('emptyMsg');
const statusBar     = document.getElementById('statusBar');

// ── State ──────────────────────────────────────────────────────────────────
let keywords = [];

// ── Storage Helpers ────────────────────────────────────────────────────────

/** Load all settings from chrome.storage.sync */
async function loadSettings() {
  try {
    const data = await chrome.storage.sync.get({ keywords: [], enabled: true });
    keywords = data.keywords;
    enabledToggle.checked = data.enabled;
    renderTags();
  } catch (err) {
    showStatus('Error loading settings', false);
    console.error('[SpoilerShield] loadSettings error:', err);
  }
}

/** Persist current state to chrome.storage.sync */
async function saveSettings() {
  try {
    await chrome.storage.sync.set({ keywords, enabled: enabledToggle.checked });
    showStatus('Saved ✓', true);
  } catch (err) {
    showStatus('Save failed', false);
    console.error('[SpoilerShield] saveSettings error:', err);
  }
}

// ── UI Helpers ─────────────────────────────────────────────────────────────

/** Render all keyword tags into #tagList */
function renderTags() {
  // Remove existing tags (keep emptyMsg node)
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

/** Add a new keyword if valid and not duplicate */
function addKeyword() {
  const raw = keywordInput.value.trim().toLowerCase();
  if (!raw) return;

  if (keywords.includes(raw)) {
    showStatus('Already exists', false);
    keywordInput.select();
    return;
  }

  keywords.push(raw);
  keywordInput.value = '';
  renderTags();
  saveSettings();
}

/** Remove keyword by index */
function removeKeyword(index) {
  keywords.splice(index, 1);
  renderTags();
  saveSettings();
}

/** Flash status bar */
let statusTimer = null;
function showStatus(msg, success = true) {
  statusBar.textContent = msg;
  statusBar.className = 'status' + (success ? ' saved' : '');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusBar.textContent = 'Ready';
    statusBar.className = 'status';
  }, 1800);
}

/** Escape HTML to prevent XSS in tag labels */
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ── Event Listeners ────────────────────────────────────────────────────────

addBtn.addEventListener('click', addKeyword);

keywordInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') addKeyword();
});

// Delegate delete clicks on tag list
tagList.addEventListener('click', e => {
  const del = e.target.closest('.tag-del');
  if (!del) return;
  const index = parseInt(del.dataset.index, 10);
  removeKeyword(index);
});

enabledToggle.addEventListener('change', saveSettings);

// ── Init ───────────────────────────────────────────────────────────────────
loadSettings();