// tab-agents.js — Specialist agents for each Hub tab
(function () {
  'use strict';

  const IS_ELECTRON = !!(window.arsenalBrowser && window.arsenalBrowser.isElectron);
  const API_BASE = IS_ELECTRON ? 'http://127.0.0.1:9121' : '';
  const STORAGE_BOARD = 'arsenal-hub-planning-board';

  window.HubState = {
    kanban: {},
    board: {},
    clipboard: {},
    tools: {},
    blueprints: {},
    activeTab: null,
    timestamp: null,
  };

  // === KANBAN AGENT ===
  async function refreshKanban() {
    try {
      const boardSelect = document.getElementById('kanban-board-select');
      const board = boardSelect ? boardSelect.value : 'default';
      if (window.arsenalBrowser?.isElectron) {
        const state = await window.arsenalBrowser.getHubState();
        HubState.kanban = state?.kanban || { board: board, source: 'ipc' };
      } else {
        const res = await fetch(`${API_BASE}/api/kanban/state?board=${encodeURIComponent(board)}`);
        if (res.ok) {
          HubState.kanban = await res.json();
        } else {
          HubState.kanban = { error: `API ${res.status}` };
        }
      }
    } catch (e) {
      HubState.kanban = { error: e.message };
    }
  }

  // === BOARD AGENT ===
  function refreshBoard() {
    try {
      const cols = document.querySelectorAll('#board-columns .board-column');
      HubState.board = { columns: [] };

      if (cols.length) {
        cols.forEach(col => {
          const title = col.querySelector('.board-column-title')?.value?.trim() || '';
          const cards = col.querySelectorAll('.board-card').length;
          HubState.board.columns.push({ name: title, cards });
        });
        return;
      }

      // Fallback when workflow board hasn't been rendered yet
      const raw = localStorage.getItem(STORAGE_BOARD);
      if (raw) {
        const data = JSON.parse(raw);
        HubState.board.columns = (data.columns || []).map(c => ({
          name: c.title || '',
          cards: (c.cards || []).length,
        }));
      }
    } catch (e) {
      HubState.board = { error: e.message };
    }
  }

  // === CLIPBOARD AGENT ===
  function refreshClipboard() {
    try {
      const tabs = document.querySelectorAll('#clipboard-tabs .clipboard-tab');
      HubState.clipboard = { tabs: [] };

      tabs.forEach(t => {
        const label = t.querySelector('.clipboard-tab-title')?.textContent?.trim()
          || t.textContent?.trim()
          || '';
        const icon = t.querySelector('.clipboard-tab-type')?.textContent?.trim();
        const type = icon === '✏️' ? 'canvas' : 'notes';
        HubState.clipboard.tabs.push({ type, label });
      });
    } catch (e) {
      HubState.clipboard = { error: e.message };
    }
  }

  // === TOOLS AGENT ===
  function refreshTools() {
    try {
      const cards = document.querySelectorAll('#tool-grid .tool-card');
      HubState.tools = { active: 0, tools: [] };

      cards.forEach(card => {
        const name = card.querySelector('.tool-name')?.textContent?.trim() || '';
        const dot = card.querySelector('.status-dot');
        const status = dot?.classList.contains('active') ? 'active' : 'idle';
        HubState.tools.tools.push({ name, status });
        if (status === 'active') HubState.tools.active++;
      });
    } catch (e) {
      HubState.tools = { error: e.message };
    }
  }

  // === BLUEPRINTS AGENT ===
  function refreshBlueprints() {
    try {
      // Prefer live specialist-chat state when available
      if (window.BlueprintsTab && typeof BlueprintsTab.getState === 'function') {
        const s = BlueprintsTab.getState();
        HubState.blueprints = {
          mode: 'chat',
          template: s.template || null,
          messageCount: (s.messages || []).length,
          complete: !!s.complete,
          extractedKeys: Object.keys(s.extracted || {}),
          blueprintName: s.blueprint?.name || s.blueprint?.blueprint_name || null,
          status: s.blueprint?.status || (s.complete ? 'ready' : 'in_progress'),
        };
        return;
      }

      const tree = document.querySelector('#blueprint-tree');
      const cats = tree?.querySelectorAll('.tree-cat') || [];
      const concepts = tree?.querySelectorAll('.tree-concept') || [];
      const versions = tree?.querySelectorAll('.tree-version') || [];
      const selectedEl = document.querySelector('.tree-version.selected');

      const detail = document.getElementById('detail-content');
      const path = document.getElementById('sel-path');
      let selected = selectedEl?.textContent?.trim() || null;
      if (!selected && detail && !detail.hidden && path?.textContent?.trim()) {
        const parts = path.textContent.split('›').map(s => s.trim());
        selected = parts[parts.length - 1] || null;
      }

      HubState.blueprints = {
        categories: cats.length,
        concepts: concepts.length,
        versions: versions.length,
        selected,
      };
    } catch (e) {
      HubState.blueprints = { error: e.message };
    }
  }

  // === REFRESH ALL ===
  async function refreshAll() {
    HubState.timestamp = new Date().toISOString();

    const active = document.querySelector('.tab-btn.active');
    HubState.activeTab = active?.dataset?.tab || null;

    await refreshKanban();
    refreshBoard();
    refreshClipboard();
    refreshTools();
    refreshBlueprints();

    try {
      if (IS_ELECTRON && window.arsenalBrowser.pushHubState) {
        await window.arsenalBrowser.pushHubState(HubState);
      } else {
        await fetch(`${API_BASE}/api/state`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(HubState),
        });
      }
    } catch (e) {
      console.warn('[TabAgents] Failed to push state:', e.message);
    }

    return HubState;
  }

  HubState.refresh = refreshAll;
  HubState.refreshKanban = refreshKanban;
  HubState.refreshBoard = refreshBoard;
  HubState.refreshClipboard = refreshClipboard;
  HubState.refreshTools = refreshTools;
  HubState.refreshBlueprints = refreshBlueprints;

  document.addEventListener('click', (e) => {
    if (e.target.matches('.tab-btn') || e.target.closest('.tab-btn')) {
      setTimeout(refreshAll, 300);
    }
  });

  const boardSelect = document.getElementById('kanban-board-select');
  if (boardSelect) {
    boardSelect.addEventListener('change', () => setTimeout(refreshAll, 300));
  }

  setInterval(refreshAll, 5000);
  refreshAll();

  const mode = IS_ELECTRON ? 'Electron IPC' : '/api/state';
  console.log(`%c[TabAgents] Specialist agents active — ${mode}`, 'color:#10b981');
})();