/* ===== Arsenal Hub Scratch (ex-Clipboard, renamed 2026-07-07) =====
 * Dynamic multi-tab workspace with:
 *  - Canvas (Excalidraw) 
 *  - Notes (markdown textarea)
 * Persisted to localStorage.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'arsenal-hub-clipboard-v2';
  const SURFACE_TYPES = ['notes', 'canvas'];

  let tabs = [];
  let activeTabId = null;

  function loadTabs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.tabs && Array.isArray(parsed.tabs)) {
          tabs = parsed.tabs;
          activeTabId = parsed.activeTabId || tabs[0]?.id || null;
          return;
        }
      }
    } catch (e) { /* ignore */ }

    // Default: start with one notes tab
    tabs = [{ id: genId(), type: 'notes', title: 'Notes', content: '' }];
    activeTabId = tabs[0].id;
    save();
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs, activeTabId }));
  }

  function genId() {
    return 'cb-' + Math.random().toString(36).slice(2, 8);
  }

  function findTab(id) {
    return tabs.find(t => t.id === id);
  }

  function saveContent(id, content) {
    const tab = findTab(id);
    if (tab) {
      tab.content = content;
      save();
    }
  }

  // ===== RENDER =====
  function render() {
    renderTabBar();
    renderSurfaces();
  }

  function renderTabBar() {
    const container = document.getElementById('clipboard-tabs');
    if (!container) return;

    container.innerHTML = tabs.map(t => {
      const activeClass = t.id === activeTabId ? 'active' : '';
      const typeIcon = t.type === 'canvas' ? '✏️' : '📝';
      return `
        <div class="clipboard-tab ${activeClass}" data-tab-id="${t.id}" title="${esc(t.title)} (${t.type})">
          <span class="clipboard-tab-type">${typeIcon}</span>
          <span class="clipboard-tab-title">${esc(t.title)}</span>
          ${tabs.length > 1 ? `<button class="clipboard-tab-close" data-close="${t.id}" title="Close tab">×</button>` : ''}
        </div>
      `;
    }).join('');

    // Click to switch
    container.querySelectorAll('.clipboard-tab').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) return;
        switchTab(el.dataset.tabId);
      });
      // Double-click to rename
      el.addEventListener('dblclick', (e) => {
        if (e.target.closest('[data-close]')) return;
        renameTab(el.dataset.tabId);
      });
    });

    // Close buttons
    container.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(btn.dataset.close);
      });
    });
  }

  function renderSurfaces() {
    const container = document.getElementById('clipboard-surfaces');
    if (!container) return;

    // Save content from currently active surface before re-rendering
    saveActiveContent();

    // Destroy old excalidraw instances to prevent leaks
    container.querySelectorAll('.clipboard-excalidraw-container').forEach(el => {
      if (el._saveInterval) {
        clearInterval(el._saveInterval);
        el._saveInterval = null;
      }
      if (el._excalidrawAPI) {
        el._excalidrawAPI = null;
      }
      // Unmount React component
      try { ReactDOM.unmountComponentAtNode(el); } catch (e) { /* ignore */ }
    });

    container.innerHTML = tabs.map(t => {
      const hidden = t.id !== activeTabId ? 'hidden' : '';
      return `
        <div class="clipboard-surface ${hidden}" data-surface-id="${t.id}">
          ${renderSurface(t)}
        </div>
      `;
    }).join('');

    // Initialize active surface
    const activeTab = findTab(activeTabId);
    if (activeTab) {
      if (activeTab.type === 'canvas') {
        initExcalidraw(activeTab);
      } else {
        initNotes(activeTab);
      }
    }
  }

  function renderSurface(tab) {
    if (tab.type === 'canvas') {
      return `<div class="clipboard-excalidraw-container" id="excalidraw-${tab.id}" style="width:100%;height:100%;"></div>`;
    }
    // notes
    return `<textarea class="clipboard-notes-editor" data-notes-id="${tab.id}" placeholder="Type here... markdown supported"></textarea>`;
  }

  // ===== NOTES SURFACE =====
  function initNotes(tab) {
    const textarea = document.querySelector(`[data-notes-id="${tab.id}"]`);
    if (!textarea) return;

    textarea.value = tab.content || '';
    textarea.focus();

    // Debounced save
    let saveTimeout;
    textarea.addEventListener('input', () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        saveContent(tab.id, textarea.value);
      }, 500);
    });

    // Save on blur immediately
    textarea.addEventListener('blur', () => {
      saveContent(tab.id, textarea.value);
    });
  }

  // ===== EXCALIDRAW SURFACE =====
  function initExcalidraw(tab) {
    const container = document.getElementById(`excalidraw-${tab.id}`);
    if (!container) return;
    if (typeof ExcalidrawLib === 'undefined') {
      container.innerHTML = '<div class="clipboard-error">Excalidraw loading…</div>';
      return;
    }

    try {
      let initialData;
      try {
        initialData = tab.content ? JSON.parse(tab.content) : null;
      } catch (e) {
        initialData = null;
      }

      const elements = initialData?.elements || [];
      const appState = initialData?.appState || {};

      const excalidrawEl = React.createElement(ExcalidrawLib.Excalidraw, {
        initialData: { elements, appState },
        UIOptions: {
          canvasActions: { export: false, loadScene: false, saveScene: false, saveAsImage: false }
        },
        ref: (api) => {
          if (api) {
            container._excalidrawAPI = api;
          }
        }
      });

      ReactDOM.render(excalidrawEl, container);

      // Periodic save (Excalidraw UMD doesn't have onChange)
      let saveInterval = setInterval(() => {
        try {
          if (container._excalidrawAPI) {
            const api = container._excalidrawAPI;
            const els = api.getSceneElements();
            const state = api.getAppState();
            saveContent(tab.id, JSON.stringify({ elements: els, appState: state }));
          }
        } catch (e) { /* not ready */ }
      }, 3000);

      // Clean up interval when tab is destroyed
      container._saveInterval = saveInterval;

      // Force refresh after mount
      setTimeout(() => {
        try {
          if (container._excalidrawAPI && container._excalidrawAPI.refresh) {
            container._excalidrawAPI.refresh();
          }
        } catch (e) { /* ignore */ }
      }, 200);

    } catch (e) {
      container.innerHTML = `<div class="clipboard-error">Canvas error: ${e.message}</div>`;
    }
  }

  // ===== TAB ACTIONS =====
  function switchTab(id) {
    if (id === activeTabId) return;
    saveActiveContent();
    activeTabId = id;
    save();
    renderSurfaces(); // re-render to swap visible surface
    renderTabBar();   // update active state
  }

  function closeTab(id) {
    if (tabs.length <= 1) return;
    saveActiveContent();
    const idx = tabs.findIndex(t => t.id === id);
    tabs.splice(idx, 1);

    if (activeTabId === id) {
      activeTabId = tabs[Math.min(idx, tabs.length - 1)].id;
    }
    save();
    render();
  }

  function renameTab(id) {
    const tab = findTab(id);
    if (!tab) return;
    const newTitle = prompt('Rename tab:', tab.title);
    if (newTitle && newTitle.trim()) {
      tab.title = newTitle.trim();
      save();
      renderTabBar();
    }
  }

  function addTab(type) {
    saveActiveContent();
    const defaultTitles = { notes: 'Notes', canvas: 'Canvas' };
    const count = tabs.filter(t => t.type === type).length;
    const title = count > 0 ? `${defaultTitles[type]} ${count + 1}` : defaultTitles[type];

    const newTab = { id: genId(), type, title, content: '' };
    tabs.push(newTab);
    activeTabId = newTab.id;
    save();
    render();
  }

  function saveActiveContent() {
    if (!activeTabId) return;
    const tab = findTab(activeTabId);
    if (!tab) return;

    if (tab.type === 'notes') {
      const textarea = document.querySelector(`[data-notes-id="${tab.id}"]`);
      if (textarea) {
        tab.content = textarea.value;
        save();
      }
    }
    // Canvas content saved via onChange handler
  }

  // ===== ADD TAB MENU =====
  function setupAddButton() {
    const btn = document.getElementById('clipboard-add');
    if (!btn) return;

    btn.addEventListener('click', () => {
      // Simple toggle: if user clicks +, show a small inline menu
      const existing = document.getElementById('clipboard-add-menu');
      if (existing) {
        existing.remove();
        return;
      }

      const menu = document.createElement('div');
      menu.id = 'clipboard-add-menu';
      menu.className = 'clipboard-add-menu';
      menu.innerHTML = `
        <button data-type="notes">📝 Notes</button>
        <button data-type="canvas">✏️ Canvas</button>
      `;
      btn.parentNode.appendChild(menu);

      menu.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => {
          addTab(b.dataset.type);
          menu.remove();
        });
      });

      // Close on outside click
      setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
          if (!menu.contains(e.target) && e.target !== btn) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
          }
        });
      }, 10);
    });
  }

  // ===== INIT =====
  function init() {
    loadTabs();
    render();

    // Re-render when clipboard workspace tab becomes visible (fixes Excalidraw size)
    const clipboardTab = document.querySelector('[data-workspace="clipboard"]');
    if (clipboardTab) {
      clipboardTab.addEventListener('click', () => {
        setTimeout(() => {
          const activeTab = findTab(activeTabId);
          if (activeTab && activeTab.type === 'canvas') {
            const container = document.getElementById(`excalidraw-${activeTab.id}`);
            if (container && container._excalidrawAPI) {
              try { container._excalidrawAPI.refresh(); } catch (e) { /* ignore */ }
            }
          }
        }, 200);
      });
    }

    setupAddButton();
  }

  function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ExcalidrawLib becomes available after script loads
  // Wait for it if needed
  let initAttempts = 0;
  function waitForExcalidraw() {
    if (typeof ExcalidrawLib !== 'undefined') return;
    initAttempts++;
    if (initAttempts > 30) return; // give up after 3 seconds
    setTimeout(waitForExcalidraw, 100);
  }
  waitForExcalidraw();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
