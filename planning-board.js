/* Planning board UI — split resize, workspace tabs, kanban board */
(function () {
  'use strict';

  const STORAGE_BOARD = 'arsenal-hub-planning-board';
  const STORAGE_SPLIT = 'arsenal-hub-planning-split';

  const DEFAULT_BOARD = {
    columns: [
      { id: 'col-backlog', title: 'Backlog', cards: [{ id: 'card-1', text: 'Define scope' }] },
      { id: 'col-doing', title: 'In Progress', cards: [] },
      { id: 'col-done', title: 'Done', cards: [] }
    ]
  };

  let boardData = { columns: [] };
  let dragCardId = null;
  let dragFromColId = null;

  function uid(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 9);
  }

  function loadBoard() {
    try {
      const raw = localStorage.getItem(STORAGE_BOARD);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.columns)) {
          boardData = parsed;
          return;
        }
      }
    } catch (_) {}
    boardData = JSON.parse(JSON.stringify(DEFAULT_BOARD));
    saveBoard();
  }

  function saveBoard() {
    localStorage.setItem(STORAGE_BOARD, JSON.stringify(boardData));
  }

  function initSplitResize() {
    const split = document.getElementById('planning-split');
    const divider = document.getElementById('planning-divider');
    if (!split || !divider) return;

    const saved = localStorage.getItem(STORAGE_SPLIT);
    if (saved) {
      document.documentElement.style.setProperty('--chat-panel-width', saved);
    }

    let dragging = false;

    function onMove(clientX) {
      const rect = split.getBoundingClientRect();
      const pct = ((clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(72, Math.max(28, pct));
      const val = clamped.toFixed(1) + '%';
      document.documentElement.style.setProperty('--chat-panel-width', val);
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      divider.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const w = getComputedStyle(document.documentElement).getPropertyValue('--chat-panel-width').trim();
      localStorage.setItem(STORAGE_SPLIT, w);
    }

    divider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      divider.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (dragging) onMove(e.clientX);
    });
    document.addEventListener('mouseup', onUp);

    divider.addEventListener('keydown', (e) => {
      const current = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chat-panel-width')) || 42;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const next = Math.max(28, current - 2);
        document.documentElement.style.setProperty('--chat-panel-width', next + '%');
        localStorage.setItem(STORAGE_SPLIT, next + '%');
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        const next = Math.min(72, current + 2);
        document.documentElement.style.setProperty('--chat-panel-width', next + '%');
        localStorage.setItem(STORAGE_SPLIT, next + '%');
      }
    });
  }

  function initWorkspaceTabs() {
    const tabs = document.querySelectorAll('.workspace-tab[data-workspace]');
    const panes = {
      board: document.getElementById('workspace-board'),
      notes: document.getElementById('workspace-notes')
    };

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.workspace;
        tabs.forEach(t => {
          t.classList.toggle('active', t === tab);
          t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
        });
        Object.entries(panes).forEach(([key, pane]) => {
          if (!pane) return;
          const active = key === target;
          pane.classList.toggle('active', active);
          pane.hidden = !active;
        });
      });
    });
  }

  function renderBoard() {
    const container = document.getElementById('board-columns');
    if (!container) return;

    container.innerHTML = '';

    boardData.columns.forEach(col => {
      const colEl = document.createElement('div');
      colEl.className = 'board-column';
      colEl.dataset.colId = col.id;

      colEl.innerHTML = `
        <div class="board-column-header">
          <input type="text" class="board-column-title" value="" aria-label="Column title" />
          <button type="button" class="board-column-delete" title="Remove column" aria-label="Remove column">×</button>
        </div>
        <div class="board-column-cards"></div>
        <button type="button" class="btn-small board-add-card">+ Card</button>
      `;

      const titleInput = colEl.querySelector('.board-column-title');
      titleInput.value = col.title;
      titleInput.addEventListener('input', () => {
        col.title = titleInput.value;
        saveBoard();
      });

      colEl.querySelector('.board-column-delete').addEventListener('click', () => {
        if (boardData.columns.length <= 1) return;
        if (!confirm('Remove this column and its cards?')) return;
        boardData.columns = boardData.columns.filter(c => c.id !== col.id);
        saveBoard();
        renderBoard();
      });

      const cardsEl = colEl.querySelector('.board-column-cards');

      col.cards.forEach(card => {
        cardsEl.appendChild(createCardEl(col, card));
      });

      colEl.querySelector('.board-add-card').addEventListener('click', () => {
        const newCard = { id: uid('card'), text: '' };
        col.cards.push(newCard);
        saveBoard();
        renderBoard();
        const input = container.querySelector(`[data-card-id="${newCard.id}"] .board-card-label`);
        if (input) input.focus();
      });

      colEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        colEl.classList.add('drag-over');
      });
      colEl.addEventListener('dragleave', () => colEl.classList.remove('drag-over'));
      colEl.addEventListener('drop', (e) => {
        e.preventDefault();
        colEl.classList.remove('drag-over');
        if (!dragCardId || !dragFromColId) return;

        const fromCol = boardData.columns.find(c => c.id === dragFromColId);
        const toCol = boardData.columns.find(c => c.id === col.id);
        if (!fromCol || !toCol) return;

        const idx = fromCol.cards.findIndex(c => c.id === dragCardId);
        if (idx === -1) return;

        const [moved] = fromCol.cards.splice(idx, 1);
        toCol.cards.push(moved);
        saveBoard();
        renderBoard();
        dragCardId = null;
        dragFromColId = null;
      });

      container.appendChild(colEl);
    });
  }

  function createCardEl(col, card) {
    const cardEl = document.createElement('div');
    cardEl.className = 'board-card';
    cardEl.draggable = true;
    cardEl.dataset.cardId = card.id;

    cardEl.innerHTML = `
      <textarea class="board-card-label" rows="1" placeholder="Card label…" aria-label="Card label"></textarea>
      <div class="board-card-footer">
        <button type="button" class="board-card-delete" aria-label="Delete card">Delete</button>
      </div>
    `;

    const label = cardEl.querySelector('.board-card-label');
    label.value = card.text;
    label.addEventListener('input', () => {
      card.text = label.value;
      saveBoard();
    });
    label.addEventListener('click', (e) => e.stopPropagation());
    label.addEventListener('mousedown', (e) => e.stopPropagation());

    cardEl.querySelector('.board-card-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      col.cards = col.cards.filter(c => c.id !== card.id);
      saveBoard();
      renderBoard();
    });

    cardEl.addEventListener('dragstart', (e) => {
      dragCardId = card.id;
      dragFromColId = col.id;
      cardEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.board-column.drag-over').forEach(el => el.classList.remove('drag-over'));
    });

    return cardEl;
  }

  function initBoardControls() {
    const addColBtn = document.getElementById('board-add-column');
    if (addColBtn) {
      addColBtn.addEventListener('click', () => {
        const title = prompt('Column name:', 'New column');
        if (title === null) return;
        boardData.columns.push({
          id: uid('col'),
          title: title.trim() || 'New column',
          cards: []
        });
        saveBoard();
        renderBoard();
      });
    }
  }

  function init() {
    loadBoard();
    initSplitResize();
    initWorkspaceTabs();
    initBoardControls();
    renderBoard();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
