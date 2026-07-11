/* ===== Arsenal Hub — Clipboard Session (v0.3) =====
 * Panel-model clipboard with server sync and agent bridge.
 *
 * MODEL: one shared room, no permission lanes.
 *   Everything is attributed: source = "user" | "agent" | "auto" (auto reserved).
 *   Unit = panel. This build: type = "notes" only.
 *   Auto note taker + Canvas panels are OUT OF SCOPE (spec §5).
 *
 * STORAGE:  localStorage (cache/fallback)  +  server JSON file (canonical)
 *   POST /api/clipboard       — browser full sync (trusted user channel)
 *   GET  /api/clipboard       — read canonical state
 *   POST /api/clipboard/agent — agent write (attributed; no permission gate)
 *
 * TYPING-BUG FIX (v0.3):
 *   pollServer() no longer re-renders the open detail view while the user is
 *   actively editing it (document.activeElement guard). Every input event also
 *   immediately writes panel.body → state in memory (no network), so the local
 *   object always wins the timestamp comparison inside mergeServerState() while
 *   the textarea is focused. The 500ms debounce applies only to the server POST.
 *
 * MIGRATION: old state with `subjects` key → migrated to `panels` in-place.
 *   Old `mode` field is silently ignored (no permission lanes in new model).
 *
 * Does NOT touch: arsenal-hub-clipboard-v2, clipboard.js, or any existing module.
 */

(function () {
  'use strict';

  // ===== CONSTANTS =====
  var STORAGE_KEY = 'arsenal-hub-clipboard-session-v1';
  var BODY_DEBOUNCE_MS = 500;
  var POLL_INTERVAL_MS = 15000;  // 15s server poll

  // Server URL — same origin as the page, uses kanban_server.py :9121
  var API_BASE = window.location.origin.replace(':5000', ':9121');
  var API_CLIPBOARD = API_BASE + '/api/clipboard';

  // ===== STATE =====
  var state = null;           // { sessionId, startedAt, panels: [] }
  var currentPanelId = null;  // null = index view; string = detail view
  var bodyDebounceTimer = null;
  var pollTimer = null;       // eslint-disable-line no-unused-vars
  var lastServerHash = '';    // fingerprint to detect agent changes

  // ===== ID GENERATOR =====
  function genId(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 9);
  }

  // ===== STATE FINGERPRINT =====
  // Accepts both `panels` (v0.3+) and `subjects` (legacy) keys so a cold-start
  // poll against an old server file doesn't produce a spurious hash mismatch.
  function stateHash(s) {
    var panels = s.panels || s.subjects || [];
    return panels.map(function (p) {
      return p.id + ':' + (p.updatedAt || p.createdAt || '') + ':' + (p.grabs || []).length;
    }).sort().join('|');
  }

  // ===== MIGRATION: subjects → panels =====
  // Runs in-place on a freshly-loaded state object. Safe to call multiple times.
  function migrateState(s) {
    if (s && Array.isArray(s.subjects) && !s.panels) {
      s.panels = s.subjects.map(function (subj) {
        return {
          id: subj.id,
          title: subj.title && subj.title !== 'Untitled Panel' ? subj.title : ('Note — ' + new Date(subj.createdAt).toLocaleString(undefined, {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})),
          type: 'notes',
          source: 'user',
          body: subj.body || '',
          grabs: (subj.grabs || []).map(function (g) {
            return { id: g.id, text: g.text, at: g.at, source: g.source || 'user' };
          }),
          createdAt: subj.createdAt,
          updatedAt: subj.updatedAt
        };
      });
      delete s.subjects;
    }
    return s;
  }

  // ===== LOCAL STORAGE (cache layer) =====
  function loadLocal() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.sessionId &&
            (Array.isArray(parsed.panels) || Array.isArray(parsed.subjects))) {
          return migrateState(parsed);
        }
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  function saveLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('[ClipboardSession] localStorage write failed:', e);
    }
  }

  // ===== SERVER SYNC =====
  function syncToServer() {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', API_CLIPBOARD);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 5000;
    xhr.onerror = function () { /* server unreachable — localStorage is fallback */ };
    xhr.send(JSON.stringify(state));
  }

  function loadFromServer(callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', API_CLIPBOARD);
    xhr.timeout = 5000;
    xhr.onload = function () {
      if (xhr.status === 200) {
        try {
          var serverState = JSON.parse(xhr.responseText);
          if (serverState && serverState.sessionId &&
              (Array.isArray(serverState.panels) || Array.isArray(serverState.subjects))) {
            state = migrateState(serverState);
            lastServerHash = stateHash(state);
            saveLocal();  // cache migrated copy
            callback(true);
            return;
          }
        } catch (_) { /* fall through to fallback */ }
      }
      callback(false);
    };
    xhr.onerror = function () { callback(false); };
    xhr.ontimeout = function () { callback(false); };
    xhr.send();
  }

  // ===== POLL SERVER (agent-change detection) =====
  // §1 typing-bug fix:
  //   - Detects whether the user is actively editing the open panel.
  //   - Syncs the live textarea value to state BEFORE merge (so local timestamp wins).
  //   - Skips re-rendering the detail view while editing — DOM is left untouched.
  function pollServer() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', API_CLIPBOARD);
    xhr.timeout = 5000;
    xhr.onload = function () {
      if (xhr.status !== 200) return;
      try {
        var serverState = JSON.parse(xhr.responseText);
        if (!serverState ||
            (!Array.isArray(serverState.panels) && !Array.isArray(serverState.subjects))) return;

        migrateState(serverState);
        var serverHash = stateHash(serverState);
        if (serverHash === lastServerHash) return;

        // Detect active editing BEFORE merge
        var activeEl = document.activeElement;
        var isEditingBody = activeEl && (activeEl.id === 'cs-body-textarea' || activeEl.id === 'cs-note-body');
        var isEditingGrab = activeEl && (activeEl.id === 'cs-grab-input' || activeEl.id === 'cs-note-body');
        var isEditing = isEditingBody || isEditingGrab;

        // Sync live textarea value into state so local object always wins the
        // timestamp comparison for the currently-open panel while focused.
        if (isEditingBody && currentPanelId) {
          var ta = document.getElementById('cs-body-textarea') || document.getElementById('cs-note-body');
          var livePanel = findPanel(currentPanelId);
          if (ta && livePanel) {
            livePanel.body = ta.value;
            livePanel.updatedAt = new Date().toISOString();
          }
        }

        mergeServerState(serverState);
        lastServerHash = stateHash(state);
        saveLocal();

        // Re-render only when safe — leave the DOM alone while user is typing
        if (currentPanelId) {
          var panel = findPanel(currentPanelId);
          if (panel) {
            if (!isEditing) renderDetail(panel);
            // else: state is up-to-date; DOM untouched — user keeps typing uninterrupted
          } else {
            showIndex();
          }
        } else {
          renderIndex();
        }
      } catch (_) { /* ignore */ }
    };
    xhr.send();
  }

  // ===== MERGE SERVER STATE =====
  // For each server panel: if newer than local, adopt it.
  // Exception: if the user is actively editing the open panel, always keep local.
  function mergeServerState(serverState) {
    var localMap = {};
    (state.panels || []).forEach(function (p) { localMap[p.id] = p; });

    var activeEl = document.activeElement;
    var isEditingBody = activeEl && (activeEl.id === 'cs-body-textarea' || activeEl.id === 'cs-note-body');

    var merged = [];
    (serverState.panels || []).forEach(function (sp) {
      var local = localMap[sp.id];
      if (!local) {
        // New panel from agent — add it
        merged.push(sp);
      } else if (sp.id === currentPanelId && isEditingBody) {
        // User is actively editing this panel — local is source of truth
        merged.push(local);
      } else {
        // Keep whichever was updated more recently
        var ssTime = new Date(sp.updatedAt || sp.createdAt || 0).getTime();
        var lcTime = new Date(local.updatedAt || local.createdAt || 0).getTime();
        merged.push(ssTime >= lcTime ? sp : local);
      }
      delete localMap[sp.id];
    });

    // Any local panels NOT on server — keep them (server might be behind)
    Object.keys(localMap).forEach(function (id) {
      merged.push(localMap[id]);
    });

    state.panels = merged;
  }

  // ===== PANEL HELPERS =====
  function findPanel(id) {
    return (state.panels || []).filter(function (p) { return p.id === id; })[0] || null;
  }

  function createPanel(title) {
    var now = new Date().toISOString();
    var defaultTitle = 'Note — ' + new Date().toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    var panel = {
      id: genId('panel'),
      title: title || defaultTitle,
      type: 'notes',
      source: 'user',
      body: '',
      grabs: [],
      createdAt: now,
      updatedAt: now
    };
    state.panels.push(panel);
    persist();
    return panel;
  }

  function touchPanel(id) {
    var panel = findPanel(id);
    if (panel) {
      panel.updatedAt = new Date().toISOString();
    }
  }

  function deletePanel(id) {
    state.panels = state.panels.filter(function (p) { return p.id !== id; });
    persist();
  }

  function persist() {
    saveLocal();
    syncToServer();
  }

  // ===== ESCAPE UTIL =====
  function esc(str) {
    if (!str) return '';
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ===== TIMESTAMP FORMAT =====
  function fmtTime(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (_) {
      return iso;
    }
  }

  // ===== PREVIEW HELPER =====
  function panelPreview(panel) {
    if (panel.body && panel.body.trim()) {
      return panel.body.trim().slice(0, 80);
    }
    if (panel.grabs && panel.grabs.length > 0) {
      return panel.grabs[panel.grabs.length - 1].text.slice(0, 80);
    }
    return '';
  }

  // ===== ROOT CONTAINERS =====
  function getIndexEl() { return document.getElementById('cs-index'); }
  function getDetailEl() { return document.getElementById('cs-detail'); }

  // ===== NAVIGATE =====
  function showIndex() {
    // Save open panel before leaving — blur/debounce may not fire on TV/tablet nav
    if (currentPanelId) {
      var ta = document.getElementById('cs-body-textarea');
      var panel = findPanel(currentPanelId);
      if (ta && panel) {
        panel.body = ta.value;
        touchPanel(panel.id);
        persist();
      }
    }
    currentPanelId = null;
    editingPanelId = null;
    getIndexEl().hidden = false;
    getDetailEl().hidden = true;
    renderIndex();
  }

  function showDetail(id) {
    // In unified mode, detail is never shown — editing happens in the index view.
    // This function exists only for backward compat (old code paths calling it).
    // Just open the index and set the editing state.
    getIndexEl().hidden = false;
    getDetailEl().hidden = true;
    renderIndex();
  }

  // ===== RENDER: INDEX (unified surface) =====
  // One-page layout: scrollable saved-notes list on top, fixed input area at bottom.
  // Click a saved note → loads into the input area for editing. No separate detail view.

  var editingPanelId = null; // null = creating new; string = editing existing

  function renderIndex() {
    var container = getIndexEl();
    if (!container) return;

    container.innerHTML = '';
    var main = document.createElement('div');
    main.className = 'cs-main-container';

    // --- Header (Clipboard title + Export button) ---
    var header = document.createElement('div');
    header.className = 'cs-notes-header';
    header.innerHTML =
      '<span class="cs-notes-title">Clipboard</span>' +
      '<button class="btn-small" id="cs-download-btn">⬇ Export Notes</button>';
    main.appendChild(header);

    // --- Scrollable saved notes list ---
    var listArea = document.createElement('div');
    listArea.id = 'cs-saved-notes';
    listArea.className = 'cs-saved-notes';
    main.appendChild(listArea);

    // --- FAB Button and Modal overlay ---
    var modalContainer = document.createElement('div');
    modalContainer.style.display = 'contents';
    modalContainer.innerHTML =
      '<button class="cs-fab" id="cs-fab-btn">+</button>' +
      '<div class="cs-modal-overlay" id="cs-modal-overlay">' +
        '<div class="cs-modal">' +
          '<div class="cs-modal-header">' +
            '<span>New Note</span>' +
            '<button class="cs-modal-close" id="cs-modal-close">✕</button>' +
          '</div>' +
          '<input type="text" class="cs-note-title-input" id="cs-note-title" placeholder="Title (optional)" />' +
          '<textarea class="cs-note-body-input" id="cs-note-body" placeholder="Type a note…" rows="4"></textarea>' +
          '<div class="cs-note-input-actions">' +
            '<button class="btn-small" id="cs-cancel-edit-btn" style="display:none">Cancel</button>' +
            '<button class="btn-small" id="cs-delete-note-btn" style="display:none">Delete</button>' +
            '<button class="btn-primary" id="cs-save-note-btn">Add Note</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    main.appendChild(modalContainer);

    container.appendChild(main);

    renderNoteList();
    wireNoteInput();

    // Download handler
    document.getElementById('cs-download-btn').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(state, null, 2)], {type: 'application/json'});
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'arsenal-hub-notes-' + new Date().toISOString().slice(0,10) + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  function renderNoteList() {
    var listEl = document.getElementById('cs-saved-notes');
    if (!listEl) return;
    listEl.innerHTML = '';

    var panels = state.panels || [];
    if (panels.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'cs-empty';
      empty.textContent = 'No notes yet. Click the + button at the bottom right to add one.';
      listEl.appendChild(empty);
      return;
    }

    var sorted = panels.slice().sort(function (a, b) {
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });

    sorted.forEach(function (panel) {
      var row = document.createElement('div');
      row.className = 'cs-note-row';
      if (panel.id === editingPanelId) row.classList.add('cs-note-row-active');
      row.dataset.id = panel.id;

      var preview = (panel.body || '').trim().slice(0, 80);
      var time = fmtTime(panel.updatedAt || panel.createdAt);

      row.innerHTML =
        '<div class="cs-note-left">' +
          '<div class="cs-note-row-title">' + esc(panel.title) + '</div>' +
          '<div class="cs-note-row-time">' + esc(time) + '</div>' +
        '</div>' +
        '<div class="cs-note-right">' +
          '<div class="cs-note-row-preview">' + esc(preview) + '</div>' +
        '</div>';

      row.addEventListener('click', function () { editNote(panel.id); });
      listEl.appendChild(row);
    });
  }

  function wireNoteInput() {
    var titleEl  = document.getElementById('cs-note-title');
    var bodyEl   = document.getElementById('cs-note-body');
    var saveBtn  = document.getElementById('cs-save-note-btn');
    var cancelBtn = document.getElementById('cs-cancel-edit-btn');
    var deleteBtn = document.getElementById('cs-delete-note-btn');

    function doSave() {
      var title = titleEl.value.trim();
      var body  = bodyEl.value.trim();
      if (!body && !title) return;

      if (editingPanelId) {
        // Update existing
        var panel = findPanel(editingPanelId);
        if (panel) {
          panel.title = title || panel.title;
          panel.body = body;
          touchPanel(editingPanelId);
          persist();
        }
      } else {
        // Create new
        if (!body) return;
        var firstLine = body.split('\n')[0];
        var autoTitle = title || (firstLine.length > 50 ? firstLine.slice(0, 47) + '\u2026' : firstLine);
        var panel = createPanel(autoTitle);
        panel.body = body;
        panel.updatedAt = new Date().toISOString();
        persist();
      }

      clearEdit();
    }

    saveBtn.addEventListener('click', doSave);

    // Enter saves (Shift+Enter for newline in body)
    bodyEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSave();
      }
    });
    titleEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        bodyEl.focus();
      }
    });

    cancelBtn.addEventListener('click', clearEdit);

    deleteBtn.addEventListener('click', function () {
      if (!editingPanelId) return;
      var panel = findPanel(editingPanelId);
      if (!panel) return;
      if (!confirm('Delete "' + panel.title + '"? This cannot be undone.')) return;
      deletePanel(editingPanelId);
      clearEdit();
    });

    // FAB opens modal
    document.getElementById('cs-fab-btn').addEventListener('click', function () {
      clearEdit();
      document.getElementById('cs-modal-overlay').classList.add('active');
      document.getElementById('cs-note-body').focus();
    });

    // Close button hides modal
    document.getElementById('cs-modal-close').addEventListener('click', function () {
      document.getElementById('cs-modal-overlay').classList.remove('active');
      clearEdit();
    });

    // Clicking backdrop also closes
    document.getElementById('cs-modal-overlay').addEventListener('click', function (e) {
      if (e.target === this) {
        this.classList.remove('active');
        clearEdit();
      }
    });
  }

  function editNote(id) {
    var panel = findPanel(id);
    if (!panel) return;
    editingPanelId = id;

    document.getElementById('cs-note-title').value = panel.title;
    document.getElementById('cs-note-body').value = panel.body || '';
    document.getElementById('cs-save-note-btn').textContent = 'Save Note';

    var headerSpan = document.querySelector('.cs-modal-header span');
    if (headerSpan) headerSpan.textContent = 'Edit Note';

    document.getElementById('cs-cancel-edit-btn').style.display = '';
    document.getElementById('cs-delete-note-btn').style.display = '';

    document.getElementById('cs-modal-overlay').classList.add('active');
    document.getElementById('cs-note-body').focus();

    renderNoteList();
  }

  function clearEdit() {
    editingPanelId = null;
    var titleEl = document.getElementById('cs-note-title');
    var bodyEl = document.getElementById('cs-note-body');
    var saveBtn = document.getElementById('cs-save-note-btn');
    var cancelBtn = document.getElementById('cs-cancel-edit-btn');
    var deleteBtn = document.getElementById('cs-delete-note-btn');
    var overlay = document.getElementById('cs-modal-overlay');
    var headerSpan = document.querySelector('.cs-modal-header span');

    if (titleEl) titleEl.value = '';
    if (bodyEl) bodyEl.value = '';
    if (saveBtn) saveBtn.textContent = 'Add Note';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (deleteBtn) deleteBtn.style.display = 'none';
    if (headerSpan) headerSpan.textContent = 'New Note';
    if (overlay) overlay.classList.remove('active');

    renderNoteList();
  }

  // ===== GRAB ITEM HTML HELPER =====
  function grabItemHtml(g) {
    var sourceLabel = g.source === 'agent' ? 'agent' : 'you';
    return '<div class="cs-grab-item" data-grab-id="' + esc(g.id) + '">' +
      '<div class="cs-grab-text">' + esc(g.text) + '</div>' +
      '<div class="cs-grab-footer">' +
        '<span class="cs-grab-time">' + esc(fmtTime(g.at)) + '</span>' +
        '<span class="cs-grab-source">' + esc(sourceLabel) + '</span>' +
        '<button class="cs-grab-remove btn-small" data-remove-grab="' + esc(g.id) + '" title="Remove">✕</button>' +
      '</div>' +
    '</div>';
  }

  // ===== RENDER: DETAIL =====
  function renderDetail(panel) {
    var container = getDetailEl();
    if (!container) return;

    var grabs = panel.grabs || [];
    var grabsHtml = grabs.length === 0
      ? '<div class="cs-grabs-empty">No grabs yet. Use the input below to capture something.</div>'
      : grabs.slice().reverse().map(grabItemHtml).join('');

    container.innerHTML =
      '<div class="cs-detail-header">' +
        '<button class="btn-small" id="cs-back-btn">← Back</button>' +
        '<div class="cs-detail-title-row">' +
          '<span class="cs-detail-title" id="cs-panel-title">' + esc(panel.title) + '</span>' +
          '<button class="btn-small" id="cs-rename-btn">Rename</button>' +
        '</div>' +
        '<button class="btn-primary" id="cs-save-btn">Save</button>' +
        '<button class="btn-small cs-delete-btn" id="cs-delete-btn">Delete Panel</button>' +
      '</div>' +

      '<div class="cs-body-section">' +
        '<label class="cs-section-label">NOTES</label>' +
        '<textarea class="cs-body-textarea" id="cs-body-textarea"' +
          ' placeholder="Running notes — decisions, context, where we left off..."' +
        '>' + esc(panel.body) + '</textarea>' +
      '</div>' +

      '<div class="cs-grabs-section">' +
        '<label class="cs-section-label">GRABS <span class="cs-grab-count-badge">' + grabs.length + '</span></label>' +
        '<div class="cs-grabs-list" id="cs-grabs-list">' +
          grabsHtml +
        '</div>' +
      '</div>';

    // --- Back ---
    document.getElementById('cs-back-btn').addEventListener('click', showIndex);

    // --- Save ---
    document.getElementById('cs-save-btn').addEventListener('click', function () {
      var ta = document.getElementById('cs-body-textarea');
      if (ta) panel.body = ta.value;
      // Auto-generate title from first line of body if title looks auto-assigned
      if (panel.body.trim() && /^Note — /.test(panel.title)) {
        var firstLine = panel.body.trim().split('\n')[0];
        panel.title = firstLine.length > 50 ? firstLine.slice(0, 47) + '…' : firstLine;
        document.getElementById('cs-panel-title').textContent = panel.title;
      }
      touchPanel(panel.id);
      persist();
      var btn = document.getElementById('cs-save-btn');
      btn.textContent = 'Saved!';
      setTimeout(function () { btn.textContent = 'Save'; }, 1500);
    });

    // --- Rename ---
    document.getElementById('cs-rename-btn').addEventListener('click', function () {
      var newTitle = prompt('Rename panel:', panel.title);
      if (newTitle && newTitle.trim()) {
        panel.title = newTitle.trim();
        touchPanel(panel.id);
        persist();
        document.getElementById('cs-panel-title').textContent = panel.title;
      }
    });

    // --- Body textarea ---
    // §1 fix: every input event writes panel.body to state immediately (in-memory only).
    // This makes the local object always beat a background merge by timestamp.
    // Only the network POST is debounced (BODY_DEBOUNCE_MS).
    var textarea = document.getElementById('cs-body-textarea');
    textarea.addEventListener('input', function () {
      panel.body = textarea.value;           // live-buffer guard: cheap, no network
      clearTimeout(bodyDebounceTimer);
      bodyDebounceTimer = setTimeout(function () {
        touchPanel(panel.id);
        persist();
      }, BODY_DEBOUNCE_MS);
    });
    textarea.addEventListener('blur', function () {
      clearTimeout(bodyDebounceTimer);
      panel.body = textarea.value;
      touchPanel(panel.id);
      persist();
    });

    // --- Grab remove (event delegation) ---
    var grabsList = document.getElementById('cs-grabs-list');
    if (grabsList) {
      grabsList.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-remove-grab]');
        if (!btn) return;
        var grabId = btn.dataset.removeGrab;
        panel.grabs = (panel.grabs || []).filter(function (g) { return g.id !== grabId; });
        touchPanel(panel.id);
        persist();
        refreshGrabsList(panel);
      });
    }

    // --- Delete panel ---
    document.getElementById('cs-delete-btn').addEventListener('click', function () {
      if (!confirm('Delete "' + panel.title + '"? This cannot be undone.')) return;
      var ta = document.getElementById('cs-body-textarea');
      if (ta) panel.body = ta.value;
      deletePanel(panel.id);
      showIndex();
    });
  }

  // ===== PARTIAL REFRESH: GRABS LIST ONLY =====
  function refreshGrabsList(panel) {
    var container = document.getElementById('cs-grabs-list');
    if (!container) return;

    var badge = document.querySelector('.cs-grab-count-badge');
    if (badge) badge.textContent = (panel.grabs || []).length;

    var grabs = panel.grabs || [];
    if (grabs.length === 0) {
      container.innerHTML =
        '<div class="cs-grabs-empty">No grabs yet. Use the input below to capture something.</div>';
      return;
    }

    container.innerHTML = grabs.slice().reverse().map(grabItemHtml).join('');
  }

  // ===== INIT =====
  function init() {
    loadFromServer(function (serverOk) {
      if (!serverOk) {
        var local = loadLocal();
        if (local) {
          state = local;
        } else {
          state = {
            sessionId: genId('sess'),
            startedAt: new Date().toISOString(),
            panels: []
          };
          persist();
        }
      }
      lastServerHash = stateHash(state);
      showIndex();

      // Start polling for agent changes
      pollTimer = setInterval(pollServer, POLL_INTERVAL_MS);
    });
  }

  // ===== PUBLIC API =====
  window.ClipboardSession = {
    getState:  function () { return JSON.parse(JSON.stringify(state)); },
    refresh:   function () { pollServer(); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
