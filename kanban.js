/* ===== Arsenal Hub Kanban ===== */
(function () {
  'use strict';

  const API_BASE = '';
  const COLUMNS = ['triage', 'todo', 'ready', 'in_progress', 'blocked', 'done'];
  const COLUMN_LABELS = {
    triage: 'Triage',
    todo: 'Todo',
    ready: 'Ready',
    in_progress: 'In Progress',
    blocked: 'Blocked',
    done: 'Done'
  };
  const COLUMN_ICONS = {
    triage: '💡',
    todo: '📋',
    ready: '⏳',
    in_progress: '⚡',
    blocked: '🛑',
    done: '✅'
  };

  let currentBoard = 'default';
  let tasksByColumn = {};
  let currentTaskId = null; // for editing

  // ===== API =====
  async function fetchTasks() {
    const res = await fetch(`${API_BASE}/api/tasks?board=${currentBoard}`);
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }

  async function createTask(data) {
    const res = await fetch(`${API_BASE}/api/tasks?board=${currentBoard}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }

  async function updateTask(taskId, data) {
    const res = await fetch(`${API_BASE}/api/tasks/${taskId}?board=${currentBoard}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }

  async function deleteTask(taskId) {
    const res = await fetch(`${API_BASE}/api/tasks/${taskId}?board=${currentBoard}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }

  async function fetchBoards() {
    const res = await fetch(`${API_BASE}/api/boards`);
    if (!res.ok) return { boards: ['default'] };
    return res.json();
  }

  // ===== RENDER =====
  function renderBoard(tasksData) {
    tasksByColumn = tasksData.tasks;
    const board = document.getElementById('kanban-board');
    board.innerHTML = '';

    COLUMNS.forEach(col => {
      const tasks = tasksData.tasks[col] || [];
      const colEl = document.createElement('div');
      colEl.className = 'kanban-column';
      colEl.dataset.column = col;

      const countBadge = tasks.length > 0 ? `<span class="kanban-count">${tasks.length}</span>` : '';

      colEl.innerHTML = `
        <div class="kanban-column-header">
          <span>${COLUMN_ICONS[col]} ${COLUMN_LABELS[col]} ${countBadge}</span>
        </div>
        <div class="kanban-column-cards" data-column="${col}">
          ${tasks.map(t => renderCard(t)).join('')}
        </div>
      `;

      board.appendChild(colEl);
    });

    // Attach drag events
    attachDragEvents();
  }

  function renderCard(task) {
    const priorityLabels = { 0: '', 1: '!', 2: '‼' };
    const priorityClass = task.priority >= 2 ? 'priority-urgent' : task.priority >= 1 ? 'priority-high' : '';
    const assignee = task.assignee ? `<span class="kanban-card-assignee">${task.assignee}</span>` : '';
    const tenant = task.tenant ? `<span class="kanban-card-tenant">${task.tenant}</span>` : '';
    const hasRuns = task.runs && task.runs.length > 0;
    const runStatus = hasRuns ? task.runs[0].status : '';

    return `
      <div class="kanban-card ${priorityClass}" draggable="true" data-task-id="${task.id}" data-status="${task.status}">
        <div class="kanban-card-title">${priorityLabels[task.priority] || ''} ${esc(task.title)}</div>
        <div class="kanban-card-meta">
          ${assignee}
          ${tenant}
        </div>
        ${hasRuns ? `<div class="kanban-card-run-status run-${runStatus}">● ${runStatus}</div>` : ''}
      </div>
    `;
  }

  function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ===== DRAG & DROP =====
  function attachDragEvents() {
    const cards = document.querySelectorAll('.kanban-card[draggable]');
    const columns = document.querySelectorAll('.kanban-column-cards');

    cards.forEach(card => {
      card.addEventListener('dragstart', handleDragStart);
      card.addEventListener('dragend', handleDragEnd);
      card.addEventListener('click', () => openDrawer(card.dataset.taskId));
    });

    columns.forEach(col => {
      col.addEventListener('dragover', handleDragOver);
      col.addEventListener('dragleave', handleDragLeave);
      col.addEventListener('drop', handleDrop);
    });
  }

  let draggedCard = null;

  function handleDragStart(e) {
    draggedCard = this;
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dataset.taskId);
  }

  function handleDragEnd(e) {
    this.classList.remove('dragging');
    draggedCard = null;
    document.querySelectorAll('.kanban-column-cards').forEach(c => c.classList.remove('drag-over'));
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    this.classList.add('drag-over');
  }

  function handleDragLeave(e) {
    this.classList.remove('drag-over');
  }

  async function handleDrop(e) {
    e.preventDefault();
    this.classList.remove('drag-over');

    const taskId = e.dataTransfer.getData('text/plain');
    const newColumn = this.dataset.column;

    if (!taskId || !newColumn) return;

    // Move card visually
    if (draggedCard) {
      this.appendChild(draggedCard);
    }

    // Update on server
    try {
      await updateTask(taskId, { status: newColumn });
    } catch (err) {
      console.error('Failed to move task:', err);
      // Refresh to reset state
      loadBoard();
    }
  }

  // ===== DRAWER =====
  async function openDrawer(taskId) {
    // Find task in current column data
    let task = null;
    for (const col of COLUMNS) {
      const found = (tasksByColumn[col] || []).find(t => t.id === taskId);
      if (found) { task = found; break; }
    }

    if (!task) {
      try {
        const res = await fetch(`${API_BASE}/api/tasks/${taskId}?board=${currentBoard}`);
        task = await res.json();
      } catch (err) {
        return;
      }
    }

    currentTaskId = taskId;

    const drawer = document.getElementById('kanban-drawer');
    const body = document.getElementById('kanban-drawer-body');
    document.getElementById('kanban-drawer-title').textContent = task.title;

    const created = task.created_at ? new Date(task.created_at * 1000).toLocaleString() : 'unknown';
    const priorityLabels = { 0: 'Normal', 1: 'High', 2: 'Urgent' };

    body.innerHTML = `
      <div class="drawer-field">
        <label>Status</label>
        <select id="drawer-status">
          ${COLUMNS.map(c => `<option value="${c}" ${task.status === c ? 'selected' : ''}>${COLUMN_LABELS[c]}</option>`).join('')}
        </select>
      </div>
      <div class="drawer-field">
        <label>Title</label>
        <input type="text" id="drawer-title" value="${esc(task.title)}" />
      </div>
      <div class="drawer-field">
        <label>Description</label>
        <textarea id="drawer-body" rows="4">${esc(task.body || '')}</textarea>
      </div>
      <div class="drawer-row">
        <div class="drawer-field">
          <label>Assignee</label>
          <input type="text" id="drawer-assignee" value="${esc(task.assignee || '')}" />
        </div>
        <div class="drawer-field">
          <label>Priority</label>
          <select id="drawer-priority">
            <option value="0" ${task.priority === 0 ? 'selected' : ''}>Normal</option>
            <option value="1" ${task.priority === 1 ? 'selected' : ''}>High</option>
            <option value="2" ${task.priority === 2 ? 'selected' : ''}>Urgent</option>
          </select>
        </div>
      </div>
      <div class="drawer-field">
        <label>Tenant</label>
        <input type="text" id="drawer-tenant" value="${esc(task.tenant || '')}" />
      </div>
      <div class="drawer-field">
        <label>Task ID</label>
        <code>${task.id}</code>
      </div>
      <div class="drawer-field">
        <label>Created</label>
        <span class="muted">${created}</span>
      </div>
      ${task.runs && task.runs.length > 0 ? `
        <div class="drawer-field">
          <label>Recent Runs</label>
          <div class="drawer-runs">
            ${task.runs.slice(0, 5).map(r => `
              <div class="run-entry">
                <span class="run-status-${r.status}">● ${r.status}</span>
                <span>${r.profile || ''}</span>
                <span class="muted">${r.outcome || ''}</span>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
      <div class="drawer-actions">
        <button class="btn-primary" id="drawer-save">Save Changes</button>
        <button class="btn-secondary" id="drawer-delete">Delete Task</button>
      </div>
    `;

    drawer.hidden = false;

    // Attach save
    document.getElementById('drawer-save').onclick = async () => {
      const updates = {
        status: document.getElementById('drawer-status').value,
        title: document.getElementById('drawer-title').value,
        body: document.getElementById('drawer-body').value,
        assignee: document.getElementById('drawer-assignee').value,
        priority: parseInt(document.getElementById('drawer-priority').value),
        tenant: document.getElementById('drawer-tenant').value
      };
      try {
        await updateTask(taskId, updates);
        drawer.hidden = true;
        loadBoard();
      } catch (err) {
        alert('Failed to save: ' + err.message);
      }
    };

    // Attach delete
    document.getElementById('drawer-delete').onclick = async () => {
      if (!confirm('Delete this task?')) return;
      try {
        await deleteTask(taskId);
        drawer.hidden = true;
        loadBoard();
      } catch (err) {
        alert('Failed to delete: ' + err.message);
      }
    };
  }

  // ===== MODAL =====
  function setupModal() {
    const overlay = document.getElementById('kanban-modal-overlay');
    const titleInput = document.getElementById('kanban-task-title');
    const bodyInput = document.getElementById('kanban-task-body');
    const assigneeInput = document.getElementById('kanban-task-assignee');
    const prioritySelect = document.getElementById('kanban-task-priority');
    const tenantInput = document.getElementById('kanban-task-tenant');

    document.getElementById('kanban-create-btn').onclick = () => {
      document.getElementById('kanban-modal-title').textContent = 'New Task';
      titleInput.value = '';
      bodyInput.value = '';
      assigneeInput.value = '';
      prioritySelect.value = '0';
      tenantInput.value = '';
      overlay.hidden = false;
      titleInput.focus();
    };

    document.getElementById('kanban-modal-close').onclick =
    document.getElementById('kanban-modal-cancel').onclick = () => {
      overlay.hidden = true;
    };

    document.getElementById('kanban-modal-save').onclick = async () => {
      const title = titleInput.value.trim();
      if (!title) {
        alert('Title is required');
        return;
      }

      try {
        await createTask({
          title,
          body: bodyInput.value.trim(),
          assignee: assigneeInput.value.trim(),
          priority: parseInt(prioritySelect.value),
          tenant: tenantInput.value.trim(),
          status: 'triage'
        });
        overlay.hidden = true;
        loadBoard();
      } catch (err) {
        alert('Failed to create task: ' + err.message);
      }
    };

    overlay.onclick = (e) => {
      if (e.target === overlay) overlay.hidden = true;
    };
  }

  // ===== BOARD SELECTOR =====
  async function setupBoardSelect() {
    const select = document.getElementById('kanban-board-select');
    try {
      const data = await fetchBoards();
      select.innerHTML = data.boards.map(b =>
        `<option value="${b}" ${b === currentBoard ? 'selected' : ''}>${b}</option>`
      ).join('');
    } catch (err) {
      console.warn('Could not load boards:', err);
    }

    select.onchange = () => {
      currentBoard = select.value;
      loadBoard();
    };
  }

  // ===== LOAD =====
  async function loadBoard() {
    try {
      const data = await fetchTasks();
      renderBoard(data);
    } catch (err) {
      console.error('Failed to load board:', err);
      document.getElementById('kanban-board').innerHTML =
        `<div class="kanban-error">Failed to load board. Is the kanban server running?<br><code>python3 kanban_server.py --port 9121</code></div>`;
    }
  }

  // ===== DRAWER CLOSE =====
  function setupDrawer() {
    document.getElementById('kanban-drawer-close').onclick = () => {
      document.getElementById('kanban-drawer').hidden = true;
      currentTaskId = null;
    };
  }

  // ===== INIT =====
  function init() {
    // Hook into tab switching — load board when KANBAN tab is clicked
    const kanbanTab = document.querySelector('[data-tab="kanban"]');
    if (kanbanTab) {
      kanbanTab.addEventListener('click', () => {
        loadBoard();
      });
    }

    // Also load if kanban tab starts active
    if (kanbanTab && kanbanTab.classList.contains('active')) {
      loadBoard();
    }

    setupModal();
    setupDrawer();
    setupBoardSelect();

    // Refresh button
    document.getElementById('kanban-refresh').onclick = loadBoard;
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
