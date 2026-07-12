/* ===== Arsenal Hub — Task Map v1 ===== */
/* Layer 1: project overview grid | Layer 2: Cytoscape agent graph
   Polls /api/taskmap every 15s while tab is active.
   Agent nodes sourced from specialist-cards.json + Kanban assignee slugs.
   Edge click → KANBAN tab. Node click → Tool Card side panel.
*/

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  let _currentProject = null;   // null = Layer 1
  let _cy = null;               // Cytoscape instance
  let _pollTimer = null;        // setInterval handle
  let _bound = false;           // static handlers attached once

  const POLL_MS = 15000;

  // ── API base (same :5000 → :9121 redirect as app.js) ──────
  function apiBase() {
    return window.location.origin.replace(':5000', ':9121');
  }

  async function fetchTaskMap(project) {
    const url = project
      ? `${apiBase()}/api/taskmap?project=${encodeURIComponent(project)}`
      : `${apiBase()}/api/taskmap`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  // ── Status colour helpers ──────────────────────────────────
  function agentStatusColor(status) {
    switch ((status || '').toLowerCase()) {
      case 'active':      return '#14b88a';  // --emerald
      case 'idle':        return '#5f6672';  // --text-muted
      case 'limited':     return '#e5a017';  // --amber
      case 'unavailable': return '#e5484d';  // --red
      default:            return '#5f6672';
    }
  }

  const STATUS_DOT_COLORS = {
    in_progress: '#14b88a',
    ready:       '#4b8bf5',
    todo:        '#4b8bf5',
    triage:      '#e5a017',
    blocked:     '#e5484d',
  };

  function projectAccentColor(statuses) {
    const s = statuses || [];
    if (s.includes('blocked'))     return 'red';
    if (s.includes('in_progress')) return 'emerald';
    if (s.includes('ready') || s.includes('todo')) return 'amber';
    return 'muted';
  }

  // ── Utilities ──────────────────────────────────────────────
  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function trunc(str, n) {
    if (!str) return '';
    return str.length > n ? str.slice(0, n) + '…' : str;
  }

  // ── Layer 1 — Project Grid ─────────────────────────────────
  async function renderLayer1() {
    const el    = document.getElementById('taskmap-projects');
    const graph = document.getElementById('taskmap-graph');
    const back  = document.getElementById('taskmap-back');
    const unsn  = document.getElementById('taskmap-unassigned');
    const crumb = document.getElementById('taskmap-breadcrumb');

    if (!el) return;
    graph.hidden = true;
    back.hidden  = true;
    unsn.hidden  = true;
    el.hidden    = false;
    closeDrawer();
    if (crumb) crumb.textContent = 'TASK MAP';

    el.innerHTML = '<div class="taskmap-loading"><span class="taskmap-spinner"></span>Loading projects…</div>';

    let data;
    try {
      data = await fetchTaskMap(null);
    } catch (e) {
      el.innerHTML = `<div class="taskmap-error">⚠ Could not reach /api/taskmap<br><small>${esc(e.message)}</small></div>`;
      return;
    }

    const projects = data.projects || [];

    if (!projects.length) {
      el.innerHTML = `
        <div class="taskmap-empty">
          <div class="taskmap-empty-icon">🗺</div>
          <div>No named boards found.</div>
          <div class="taskmap-empty-hint">Create tasks on a named Kanban board (not "default") to see them here.</div>
        </div>`;
      return;
    }

    el.innerHTML = '';

    const grid = document.createElement('div');
    grid.className = 'taskmap-grid';

    projects.forEach(proj => {
      const counts = {};
      (proj.statuses || []).forEach(s => { counts[s] = (counts[s] || 0) + 1; });
      const accent = projectAccentColor(proj.statuses);

      let dotsHtml = '';
      Object.entries(counts).forEach(([status, count]) => {
        const color = STATUS_DOT_COLORS[status] || '#5f6672';
        const show  = Math.min(count, 6);
        for (let i = 0; i < show; i++) {
          dotsHtml += `<span class="taskmap-status-dot" style="background:${color}" title="${esc(status)}"></span>`;
        }
        if (count > 6) dotsHtml += `<span class="taskmap-dot-overflow">+${count - 6}</span>`;
      });

      const card = document.createElement('div');
      card.className = `taskmap-project-card taskmap-accent-${accent}`;
      card.setAttribute('data-project', proj.name);
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `Open ${proj.name} agent graph`);

      card.innerHTML = `
        <div class="taskmap-project-inner">
          <div class="taskmap-project-name">${esc(proj.name)}</div>
          <div class="taskmap-project-active">${proj.active} active</div>
          <div class="taskmap-status-dots">${dotsHtml || '<span class="taskmap-dot-none">no active tasks</span>'}</div>
        </div>
        <div class="taskmap-project-arrow">→</div>
      `;

      card.addEventListener('click', () => drillIn(proj.name));
      card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') drillIn(proj.name); });
      grid.appendChild(card);
    });

    el.appendChild(grid);
  }

  // ── Layer 2 — Drill-in ─────────────────────────────────────
  async function drillIn(project) {
    _currentProject = project;

    const el    = document.getElementById('taskmap-projects');
    const graph = document.getElementById('taskmap-graph');
    const back  = document.getElementById('taskmap-back');
    const crumb = document.getElementById('taskmap-breadcrumb');

    el.hidden    = true;
    graph.hidden = false;
    back.hidden  = false;
    closeDrawer();
    if (crumb) crumb.textContent = `TASK MAP / ${project.toUpperCase()}`;

    graph.innerHTML = '<div class="taskmap-loading"><span class="taskmap-spinner"></span>Loading agents…</div>';

    let data;
    try {
      data = await fetchTaskMap(project);
    } catch (e) {
      graph.innerHTML = `<div class="taskmap-error">⚠ Could not load project "${esc(project)}"<br><small>${esc(e.message)}</small></div>`;
      return;
    }

    renderGraph(data, graph);
    renderUnassigned(data.unassigned || []);
  }

  // ── Cytoscape Graph ────────────────────────────────────────
  function renderGraph(data, container) {
    if (_cy) { _cy.destroy(); _cy = null; }
    container.innerHTML = '';

    const agents = data.agents || [];
    const edges  = data.edges  || [];

    if (!agents.length && !edges.length) {
      container.innerHTML = `
        <div class="taskmap-empty">
          <div class="taskmap-empty-icon">🤖</div>
          <div>No agents found for this project.</div>
          <div class="taskmap-empty-hint">Move tasks to "In Progress" with an assignee to populate the graph.</div>
        </div>`;
      return;
    }

    // Build id lookup: assignee name → node id
    const nameToId = {};
    agents.forEach(a => {
      nameToId[a.name.toLowerCase()] = a.id;
      (a.aliases || []).forEach(al => { nameToId[al.toLowerCase()] = a.id; });
    });

    function resolveId(nameSlug) {
      if (!nameSlug) return null;
      return nameToId[nameSlug.toLowerCase()]
        || nameToId[Object.keys(nameToId).find(k => k.includes(nameSlug.toLowerCase()) || nameSlug.toLowerCase().includes(k)) || '']
        || ('synth-' + nameSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    }

    // Cytoscape elements
    const elements = [];

    // Agent nodes
    const seenNodes = new Set();
    agents.forEach(agent => {
      const nid = agent.id || resolveId(agent.name);
      if (seenNodes.has(nid)) return;
      seenNodes.add(nid);
      elements.push({
        data: {
          id: nid,
          label: agent.name,
          status: agent.status || 'idle',
          _type: agent.name === agent.id ? 'agent-synth' : 'agent',
          _raw: agent,
        }
      });
    });

    // Synthetic nodes for any assignee slug not in cards
    edges.forEach(edge => {
      const tid = resolveId(edge.to);
      if (!tid || seenNodes.has(tid)) return;
      seenNodes.add(tid);
      elements.push({
        data: {
          id: tid,
          label: edge.to,
          status: 'active',
          _type: 'agent-synth',
          _raw: { name: edge.to, status: 'active', capabilities: [], links: {} },
        }
      });
    });

    // Task edges — render as self-loop labels on agent nodes when no dispatcher
    const edgeCounts = {};
    edges.forEach((edge, i) => {
      const tid = resolveId(edge.to);
      if (!tid) return;
      // Use task count per node to offset multiple edges visually
      edgeCounts[tid] = (edgeCounts[tid] || 0);
      const loopDir = edgeCounts[tid] * 60;
      edgeCounts[tid]++;

      elements.push({
        data: {
          id: `edge-${i}`,
          source: tid,
          target: tid,
          label: trunc(edge.task, 28),
          task_id: edge.task_id,
          status: edge.status || 'in_progress',
          _type: 'task-edge',
          loopDir,
        }
      });
    });

    // If graph would be empty nodes with no edges, make a nicer layout
    const useGrid = elements.filter(e => !e.data.source).length <= 3;

    _cy = cytoscape({
      container,
      elements,
      style: _cytoscapeStyle(),
      layout: {
        name: elements.filter(e => !e.data.source).length > 1 ? 'cose' : 'grid',
        animate: true,
        animationDuration: 500,
        animationEasing: 'ease-out-cubic',
        nodeRepulsion: () => 12000,
        idealEdgeLength: () => 160,
        edgeElasticity: () => 300,
        gravity: 0.3,
        numIter: 1200,
        initialTemp: 220,
        coolingFactor: 0.99,
        minTemp: 1.0,
        fit: true,
        padding: 60,
        randomize: false,
      },
      minZoom: 0.25,
      maxZoom: 3.5,
      wheelSensitivity: 0.18,
    });

    // Node click → Tool Card drawer
    _cy.on('tap', 'node', evt => {
      const raw = evt.target.data('_raw');
      if (raw) openDrawer(raw);
      _cy.nodes().removeClass('taskmap-highlight');
      evt.target.addClass('taskmap-highlight');
    });

    // Edge click → Kanban tab
    _cy.on('tap', 'edge', evt => {
      const taskId = evt.target.data('task_id');
      if (taskId && window._arsenalSwitchTab) {
        window._arsenalSwitchTab('kanban');
      }
    });

    // Background tap → deselect + close drawer
    _cy.on('tap', evt => {
      if (evt.target === _cy) {
        closeDrawer();
        _cy.nodes().removeClass('taskmap-highlight');
      }
    });
  }

  function _cytoscapeStyle() {
    return [
      // ── Agent nodes ─────────────────────────────────────────
      {
        selector: 'node',
        style: {
          'background-color': ele => agentStatusColor(ele.data('status')),
          'background-opacity': 0.85,
          'border-width': 2.5,
          'border-color': ele => agentStatusColor(ele.data('status')),
          'border-opacity': 0.5,
          'label': 'data(label)',
          'color': '#eceef2',
          'font-size': '11px',
          'font-family': 'Inter, -apple-system, sans-serif',
          'font-weight': '500',
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 8,
          'width': 52,
          'height': 52,
          'shape': 'ellipse',
          'text-outline-width': 2.5,
          'text-outline-color': '#0e1014',
          'overlay-padding': '8px',
          'z-index': 10,
          'transition-property': 'border-width, border-color, background-opacity',
          'transition-duration': '150ms',
          'shadow-blur': 12,
          'shadow-color': ele => agentStatusColor(ele.data('status')),
          'shadow-opacity': 0.25,
          'shadow-offset-x': 0,
          'shadow-offset-y': 0,
        }
      },
      // Synthetic / slug-only nodes (blue, dashed border)
      {
        selector: 'node[_type = "agent-synth"]',
        style: {
          'background-color': '#4b8bf5',
          'border-color': '#4b8bf5',
          'border-style': 'dashed',
          'shadow-color': '#4b8bf5',
        }
      },
      // Highlighted (clicked) node
      {
        selector: 'node.taskmap-highlight',
        style: {
          'border-width': 3.5,
          'border-color': '#eceef2',
          'border-opacity': 1,
          'background-opacity': 1,
        }
      },
      // ── Task edges ─────────────────────────────────────────
      {
        selector: 'edge',
        style: {
          'width': 1.5,
          'line-color': '#323844',
          'target-arrow-color': '#323844',
          'target-arrow-shape': 'none',
          'curve-style': 'loop',
          'loop-direction': ele => `${ele.data('loopDir') || 0}deg`,
          'loop-sweep': '−40deg',
          'label': 'data(label)',
          'color': '#949bab',
          'font-size': '9px',
          'font-family': 'JetBrains Mono, monospace',
          'text-background-color': '#181b22',
          'text-background-opacity': 0.92,
          'text-background-padding': '3px',
          'text-background-shape': 'roundrectangle',
          'text-border-width': 1,
          'text-border-color': '#252a33',
          'text-border-opacity': 1,
          'text-max-width': '130px',
          'text-wrap': 'wrap',
          'line-style': 'dashed',
          'line-dash-pattern': [6, 3],
          'overlay-padding': '8px',
          'z-index': 5,
        }
      },
      {
        selector: 'edge[status = "in_progress"]',
        style: {
          'line-color': '#14b88a',
          'color': '#6ee7b7',
          'line-dash-pattern': [8, 4],
        }
      },
      {
        selector: 'edge:selected',
        style: {
          'line-color': '#4b8bf5',
          'width': 2.5,
        }
      },
      {
        selector: 'node:active, edge:active',
        style: { 'overlay-opacity': 0.1 }
      },
    ];
  }

  // ── Unassigned pool ────────────────────────────────────────
  function renderUnassigned(tasks) {
    const el = document.getElementById('taskmap-unassigned');
    if (!el) return;
    if (!tasks || !tasks.length) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.innerHTML = `
      <div class="taskmap-unsn-label">UNASSIGNED <span class="taskmap-unsn-sub">ready · no owner</span></div>
      <div class="taskmap-unsn-chips">
        ${tasks.map(t => `
          <div class="taskmap-unsn-chip" title="${esc(t.title)}">
            <span class="taskmap-unsn-dot"></span>${esc(trunc(t.title, 40))}
          </div>
        `).join('')}
      </div>
    `;
  }

  // ── Tool Card side panel ───────────────────────────────────
  function openDrawer(agent) {
    const drawer = document.getElementById('taskmap-drawer');
    const dtitle = document.getElementById('taskmap-drawer-title');
    const dbody  = document.getElementById('taskmap-drawer-body');
    if (!drawer) return;

    dtitle.textContent = agent.name || 'Agent';
    const statusColor = agentStatusColor(agent.status || 'idle');

    const caps = (agent.capabilities || []).map(c =>
      `<span class="taskmap-cap-chip">${esc(c)}</span>`
    ).join('');

    const links = agent.links || {};
    const linkItems = Object.entries(links)
      .filter(([, v]) => v)
      .map(([k, v]) => `<a href="${esc(v)}" target="_blank" rel="noopener" class="taskmap-drawer-link">${esc(k)}</a>`)
      .join('');

    const isEmpty = !agent.description && !caps && !linkItems;

    dbody.innerHTML = `
      <div class="taskmap-drawer-status-row">
        <span class="taskmap-drawer-dot" style="background:${statusColor}"></span>
        <span class="taskmap-drawer-status-text">${esc(agent.status || 'idle')}</span>
        ${agent.category ? `<span class="taskmap-drawer-category">${esc(agent.category)}</span>` : ''}
      </div>
      ${agent.description ? `<p class="taskmap-drawer-desc">${esc(agent.description)}</p>` : ''}
      ${caps ? `<div class="taskmap-drawer-caps">${caps}</div>` : ''}
      ${linkItems ? `<div class="taskmap-drawer-links-row">${linkItems}</div>` : ''}
      ${isEmpty ? `<p class="taskmap-drawer-hint">No Tool Card yet.<br>Use <strong>TOOLS → Research</strong> to populate this agent.</p>` : ''}
    `;

    drawer.hidden = false;
  }

  function closeDrawer() {
    const drawer = document.getElementById('taskmap-drawer');
    if (drawer) drawer.hidden = true;
  }

  // ── Polling ────────────────────────────────────────────────
  function _startPolling() {
    _stopPolling();
    _pollTimer = setInterval(async () => {
      const activeTab = document.querySelector('.tab-btn.active')?.dataset?.tab;
      if (activeTab !== 'taskmap') return;
      if (_currentProject) {
        await drillIn(_currentProject);
      } else {
        await renderLayer1();
      }
    }, POLL_MS);
  }

  function _stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  // ── Static handler binding (once) ─────────────────────────
  function _bindOnce() {
    if (_bound) return;
    _bound = true;

    // Back button
    document.getElementById('taskmap-back')?.addEventListener('click', () => {
      _currentProject = null;
      if (_cy) { _cy.destroy(); _cy = null; }
      renderLayer1();
    });

    // Refresh button
    document.getElementById('taskmap-refresh')?.addEventListener('click', async () => {
      if (_currentProject) await drillIn(_currentProject);
      else await renderLayer1();
    });

    // Drawer close
    document.getElementById('taskmap-drawer-close')?.addEventListener('click', closeDrawer);
  }

  // ── Public API ─────────────────────────────────────────────
  async function init() {
    _bindOnce();
    _startPolling();
    if (_currentProject) await drillIn(_currentProject);
    else await renderLayer1();
  }

  function pause() {
    _stopPolling();
  }

  window.TaskMap = { init, pause };

})();
