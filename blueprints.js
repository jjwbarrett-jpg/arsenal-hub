/* ===== Arsenal Hub — Blueprints Tab (Decomposition Engine UI) ===== */

window.BlueprintsTab = (function () {
  'use strict';

  const STORAGE_KEY = 'arsenal-hub-decomposition-blueprints';

  let state = {
    blueprints: [],
    activeId: null,
    selectedNodeId: null,
    decomposing: false,
    progress: null
  };

  function escapeHtml(str) {
    return Decomposer.escapeHtml(str);
  }

  function uid(prefix) {
    return Decomposer.uid(prefix);
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.blueprints)) {
          state.blueprints = parsed.blueprints;
          state.activeId = parsed.activeId || (parsed.blueprints[0]?.id ?? null);
          return;
        }
      }
    } catch (_) {}

    state.blueprints = [];
    state.activeId = null;
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      blueprints: state.blueprints,
      activeId: state.activeId
    }));
  }

  function getActiveBlueprint() {
    return state.blueprints.find((b) => b.id === state.activeId) || null;
  }

  function setActive(id) {
    state.activeId = id;
    state.selectedNodeId = null;
    save();
    render();
  }

  function selectNode(nodeId) {
    state.selectedNodeId = nodeId;
    renderTree();
    renderDetail();
  }

  function render() {
    renderBlueprintList();
    renderTree();
    renderDetail();
    renderProgress();
    renderActions();
  }

  function renderBlueprintList() {
    const el = document.getElementById('bp-list');
    if (!el) return;

    if (!state.blueprints.length) {
      el.innerHTML = '<div class="bp-list-empty">No blueprints yet.</div>';
      return;
    }

    el.innerHTML = state.blueprints.map((bp) => {
      const active = bp.id === state.activeId ? ' active' : '';
      const status = bp.status || 'draft';
      return (
        '<button class="bp-list-item' + active + '" data-id="' + escapeHtml(bp.id) + '" type="button">' +
          '<span class="bp-list-name">' + escapeHtml(bp.plan) + '</span>' +
          '<span class="bp-list-meta">' + escapeHtml(bp.typeName || bp.type) + ' · ' + status + '</span>' +
        '</button>'
      );
    }).join('');

    el.querySelectorAll('.bp-list-item').forEach((btn) => {
      btn.addEventListener('click', () => setActive(btn.dataset.id));
    });
  }

  function renderTree() {
    const container = document.getElementById('blueprint-tree');
    if (!container) return;

    const bp = getActiveBlueprint();
    if (!bp) {
      container.innerHTML = '<div class="tree-empty">Create a blueprint to begin decomposition.</div>';
      return;
    }

    container.innerHTML = '';
    const root = document.createElement('ul');
    root.appendChild(renderTreeNode(bp.tree, bp));
    container.appendChild(root);
  }

  function renderTreeNode(node, bp) {
    const li = document.createElement('li');
    const hasChildren = node.children && node.children.length > 0;
    const isOpen = node._open !== false;
    const isSelected = state.selectedNodeId === node.id;

    const row = document.createElement('div');
    row.className = 'tree-node' +
      (hasChildren ? ' has-children' : '') +
      (isOpen ? ' open' : '') +
      (isSelected ? ' selected' : '');
    row.dataset.nodeId = node.id;
    row.style.paddingLeft = (node.depth * 10 + 4) + 'px';

    const toggle = hasChildren ? '<span class="tree-toggle">' + (isOpen ? '▼' : '▸') + '</span> ' : '<span class="tree-toggle leaf">•</span> ';
    row.innerHTML = toggle + '<span class="tree-label">' + escapeHtml(node.name) + '</span>';

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.classList.contains('tree-toggle') && hasChildren) {
        node._open = !isOpen;
        renderTree();
        return;
      }
      selectNode(node.id);
    });

    li.appendChild(row);

    if (hasChildren && isOpen) {
      const ul = document.createElement('ul');
      node.children.forEach((child) => ul.appendChild(renderTreeNode(child, bp)));
      li.appendChild(ul);
    }

    return li;
  }

  function renderDetail() {
    const empty = document.getElementById('detail-empty');
    const content = document.getElementById('detail-content');
    if (!empty || !content) return;

    const bp = getActiveBlueprint();
    if (!bp || !state.selectedNodeId) {
      empty.hidden = false;
      content.hidden = true;
      empty.textContent = bp
        ? 'Select a node from the tree to view and edit details.'
        : 'Create a new blueprint to begin.';
      return;
    }

    const node = Decomposer.findNode(bp.tree, state.selectedNodeId);
    if (!node) {
      empty.hidden = false;
      content.hidden = true;
      return;
    }

    empty.hidden = true;
    content.hidden = false;

    const path = Decomposer.getNodePath(bp.tree, node.id) || [node.name];
    document.getElementById('sel-path').textContent = path.join(' › ');

    document.getElementById('bp-node-name').value = node.name || '';
    document.getElementById('bp-node-desc').value = node.description || '';

    const attrsEl = document.getElementById('bp-node-attrs');
    if (attrsEl) {
      const attrs = node.attributes || {};
      const entries = Object.entries(attrs);
      attrsEl.innerHTML = entries.length
        ? entries.map(([k, v]) =>
            '<div class="attr-row">' +
              '<input class="attr-key" data-attr-key="' + escapeHtml(k) + '" value="' + escapeHtml(k) + '" />' +
              '<input class="attr-val" data-attr-key="' + escapeHtml(k) + '" value="' + escapeHtml(String(v)) + '" />' +
              '<button class="btn-icon attr-del" data-attr-key="' + escapeHtml(k) + '" type="button" title="Remove">×</button>' +
            '</div>'
          ).join('')
        : '<div class="attr-empty muted small">No attributes</div>';
    }

    const meta = document.getElementById('bp-created');
    if (meta) {
      meta.textContent = 'Type: ' + (bp.typeName || bp.type) +
        ' · Depth: ' + (node.depth ?? 0) +
        (bp.updatedAt ? ' · Updated: ' + bp.updatedAt.slice(0, 10) : '');
    }

    wireDetailHandlers(bp, node);
  }

  function wireDetailHandlers(bp, node) {
    const nameEl = document.getElementById('bp-node-name');
    const descEl = document.getElementById('bp-node-desc');

    if (nameEl) {
      nameEl.onchange = () => {
        node.name = nameEl.value.trim() || node.name;
        bp.updatedAt = new Date().toISOString();
        save();
        renderTree();
      };
    }

    if (descEl) {
      descEl.onchange = () => {
        node.description = descEl.value;
        bp.updatedAt = new Date().toISOString();
        save();
      };
    }

    document.querySelectorAll('.attr-key, .attr-val').forEach((input) => {
      input.onchange = () => syncAttributes(bp, node);
    });

    document.querySelectorAll('.attr-del').forEach((btn) => {
      btn.onclick = () => {
        const key = btn.dataset.attrKey;
        if (node.attributes) delete node.attributes[key];
        bp.updatedAt = new Date().toISOString();
        save();
        renderDetail();
      };
    });

    const addAttr = document.getElementById('btn-add-attr');
    if (addAttr) {
      addAttr.onclick = () => {
        if (!node.attributes) node.attributes = {};
        let key = 'key';
        let i = 1;
        while (node.attributes[key]) { key = 'key' + i++; }
        node.attributes[key] = '';
        bp.updatedAt = new Date().toISOString();
        save();
        renderDetail();
      };
    }

    const addChild = document.getElementById('btn-add-child');
    if (addChild) {
      addChild.onclick = () => {
        const name = prompt('New child item name:');
        if (!name || !name.trim()) return;
        const child = Decomposer.createNode({
          name: name.trim(),
          branch: name.trim(),
          description: '',
          depth: (node.depth || 0) + 1,
          leaf: true,
          decomposable: false
        });
        if (!node.children) node.children = [];
        node.children.push(child);
        node._open = true;
        bp.updatedAt = new Date().toISOString();
        save();
        selectNode(child.id);
      };
    }

    const removeNode = document.getElementById('btn-remove-node');
    if (removeNode) {
      removeNode.onclick = () => {
        if (node.id === bp.tree.id) {
          alert('Cannot remove the root node.');
          return;
        }
        if (!confirm('Remove "' + node.name + '" and all its children?')) return;
        removeNodeFromTree(bp.tree, node.id);
        state.selectedNodeId = bp.tree.id;
        bp.updatedAt = new Date().toISOString();
        save();
        render();
      };
    }

    const refill = document.getElementById('btn-refill');
    if (refill) {
      refill.disabled = state.decomposing;
      refill.onclick = async () => {
        const guidance = prompt('Optional guidance for AI refill (or leave blank):', '');
        await rerunBranch(bp, node.id, guidance);
      };
    }

    const approve = document.getElementById('btn-approve');
    if (approve) {
      approve.onclick = () => {
        bp.status = bp.status === 'approved' ? 'draft' : 'approved';
        bp.updatedAt = new Date().toISOString();
        save();
        renderBlueprintList();
        renderDetail();
      };
      approve.textContent = bp.status === 'approved' ? 'Unapprove' : 'Approve';
    }
  }

  function syncAttributes(bp, node) {
    const attrs = {};
    document.querySelectorAll('.attr-row').forEach((row) => {
      const keyInput = row.querySelector('.attr-key');
      const valInput = row.querySelector('.attr-val');
      if (keyInput && valInput && keyInput.value.trim()) {
        attrs[keyInput.value.trim()] = valInput.value;
      }
    });
    node.attributes = attrs;
    bp.updatedAt = new Date().toISOString();
    save();
  }

  function removeNodeFromTree(root, nodeId) {
    if (!root.children) return false;
    const idx = root.children.findIndex((c) => c.id === nodeId);
    if (idx >= 0) {
      root.children.splice(idx, 1);
      return true;
    }
    for (const child of root.children) {
      if (removeNodeFromTree(child, nodeId)) return true;
    }
    return false;
  }

  function renderProgress() {
    const el = document.getElementById('bp-progress');
    if (!el) return;

    if (!state.decomposing) {
      el.hidden = true;
      return;
    }

    el.hidden = false;
    const p = state.progress || {};
    el.textContent = p.phase === 'detected'
      ? 'Detected type: ' + (p.typeName || p.type) + '…'
      : 'Filling: ' + (p.branch || p.node || '…') + ' (depth ' + (p.depth ?? 0) + ')';
  }

  function renderActions() {
    const dispatch = document.getElementById('btn-dispatch');
    const exp = document.getElementById('btn-export');
    const saveBtn = document.getElementById('btn-save-bp');
    const delBtn = document.getElementById('btn-delete-bp');
    const bp = getActiveBlueprint();

    if (dispatch) {
      dispatch.disabled = !bp || bp.status !== 'approved';
      dispatch.title = bp?.status === 'approved'
        ? 'Dispatch not wired in MVP'
        : 'Approve blueprint first';
    }

    if (exp) {
      exp.disabled = !bp;
    }

    if (saveBtn) saveBtn.disabled = !bp;
    if (delBtn) delBtn.disabled = !bp;
  }

  async function startNewBlueprint() {
    const plan = prompt('Enter your plan:', 'fighting game with insects');
    if (!plan || !plan.trim()) return;

    const useAI = confirm(
      'Run AI decomposition?\n\nOK = call Hermes gateway (requires Flask server)\nCancel = use offline mock filler'
    );

    state.decomposing = true;
    state.progress = { phase: 'starting' };
    renderProgress();

    try {
      await Decomposer.loadTemplates();
      const blueprint = await Decomposer.decompose(plan.trim(), {
        useAI,
        onProgress: (p) => {
          state.progress = p;
          renderProgress();
        }
      });

      state.blueprints.unshift(blueprint);
      state.activeId = blueprint.id;
      state.selectedNodeId = blueprint.tree.id;
      save();
      render();
    } catch (err) {
      alert('Decomposition failed: ' + err.message);
    } finally {
      state.decomposing = false;
      state.progress = null;
      renderProgress();
      renderActions();
    }
  }

  async function rerunBranch(bp, nodeId, guidance) {
    state.decomposing = true;
    state.progress = { phase: 'refilling' };
    renderProgress();

    try {
      const theme = guidance
        ? bp.theme + '. Guidance: ' + guidance
        : bp.theme;

      await Decomposer.refillBranch(bp, nodeId, {
        theme,
        onProgress: (p) => {
          state.progress = p;
          renderProgress();
        }
      });

      save();
      render();
    } catch (err) {
      alert('Refill failed: ' + err.message);
    } finally {
      state.decomposing = false;
      state.progress = null;
      renderProgress();
      renderActions();
    }
  }

  function exportMarkdown() {
    const bp = getActiveBlueprint();
    if (!bp) return;

    const md = Decomposer.exportMarkdown(bp);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (bp.plan || 'blueprint').replace(/[^\w\-]+/g, '_').slice(0, 60) + '.md';
    a.click();
    URL.revokeObjectURL(url);
  }

  function deleteBlueprint() {
    const bp = getActiveBlueprint();
    if (!bp) return;
    if (!confirm('Delete blueprint "' + bp.plan + '"?')) return;

    state.blueprints = state.blueprints.filter((b) => b.id !== bp.id);
    state.activeId = state.blueprints[0]?.id || null;
    state.selectedNodeId = null;
    save();
    render();
  }

  function initDeadlines() {
    const list = document.getElementById('deadlines-list');
    if (!list) return;

    list.innerHTML =
      '<div class="deadline-item"><span class="date">Jul 15</span><span>DeepSeek peak rates</span></div>' +
      '<div class="deadline-item"><span class="date">Jul 30</span><span>SuperGrok expires</span></div>';

    const add = document.getElementById('deadline-add');
    if (add) add.onclick = () => {};
  }

  function init() {
    load();
    Decomposer.loadTemplates().catch(() => {});

    const newBtn = document.getElementById('btn-new-blueprint');
    if (newBtn) newBtn.addEventListener('click', startNewBlueprint);

    const exportBtn = document.getElementById('btn-export');
    if (exportBtn) {
      exportBtn.disabled = false;
      exportBtn.addEventListener('click', exportMarkdown);
    }

    const dispatchBtn = document.getElementById('btn-dispatch');
    if (dispatchBtn) {
      dispatchBtn.addEventListener('click', () => {
        alert('Dispatch to Spec-Driven Develop is out of scope for MVP.');
      });
    }

    const saveBtn = document.getElementById('btn-save-bp');
    if (saveBtn) saveBtn.addEventListener('click', () => {
      save();
      const bp = getActiveBlueprint();
      if (bp) {
        bp.updatedAt = new Date().toISOString();
        save();
      }
      renderBlueprintList();
    });

    const delBtn = document.getElementById('btn-delete-bp');
    if (delBtn) delBtn.addEventListener('click', deleteBlueprint);

    initDeadlines();
    render();
  }

  return {
    init,
    render,
    getState: () => state,
    reset: () => {
      localStorage.removeItem(STORAGE_KEY);
      load();
      render();
    }
  };
})();