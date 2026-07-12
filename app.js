/* ===== Arsenal Hub v2 — Chat Panel + Toolbar (Revision 4) ===== */
/* Tabs: Clipboard / Workflow / Kanban / Tools / Blueprints
   Chat: Hermes slide-out only (CHAT tab removed 2026-07-08)
   Workflow: the former Planning — Board + Clipboard workspace (no split, no embedded chat)
   Tools: collapsible filter accordion, card grid (name/status/sessions/tags + expand)
   Blueprints: Decomposition Engine — tree + edit panel, localStorage, markdown export
 */

(function () {
  'use strict';

  // Storage keys
  const STORAGE_TOOLS = 'arsenal-hub-v1-tools';
  // State
  let tools = [];
  let specialistCards = [];   // auto-populated from /api/tools/specialist
  let currentToolFilter = 'ALL';


  // ===== INIT TOOLS =====
  function loadTools() {
    const base = (window.TOOLS || []).map(t => ({ ...t }));
    if (!base.length) {
      console.warn('No TOOLS found in data.js');
    }

    // Merge persisted status (and expanded)
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_TOOLS) || '{}');
    } catch (_) {}

    tools = base.map(t => ({
      ...t,
      status: saved[t.id]?.status || t.status || 'idle',
      expanded: !!saved[t.id]?.expanded
    }));

    // Merge any already-loaded specialist cards
    _mergeSpecialistCards();
  }

  // Merge specialistCards into the tools array (append, no duplicate names)
  function _mergeSpecialistCards() {
    const existingNames = new Set(tools.map(t => t.name.toLowerCase()));
    specialistCards.forEach(sc => {
      if (existingNames.has(sc.name.toLowerCase())) {
        // Update the existing card in-place with specialist data
        const idx = tools.findIndex(t => t.name.toLowerCase() === sc.name.toLowerCase());
        if (idx !== -1) tools[idx] = { ...tools[idx], ...sc, _specialist: true };
      } else {
        tools.push({ ...sc, _specialist: true, expanded: false });
        existingNames.add(sc.name.toLowerCase());
      }
    });
  }

  // Async: fetch specialist cards from server, merge, re-render
  function loadSpecialistCards() {
    const apiBase = window.location.origin.replace(':5000', ':9121');
    fetch(apiBase + '/api/tools/specialist')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || !Array.isArray(data.cards)) return;
        specialistCards = data.cards;
        _mergeSpecialistCards();
        updateActiveCount();
        renderToolGrid();
      })
      .catch(() => { /* server not running — silent */ });
  }


  function saveToolsState() {
    const map = {};
    tools.forEach(t => {
      map[t.id] = { status: t.status, expanded: !!t.expanded };
    });
    localStorage.setItem(STORAGE_TOOLS, JSON.stringify(map));
  }

  function getActiveCount() {
    return tools.filter(t => t.status === 'active').length;
  }

  function updateActiveCount() {
    const el = document.getElementById('active-num');
    if (el) el.textContent = getActiveCount();
  }

  const IS_ELECTRON = !!(window.arsenalBrowser && window.arsenalBrowser.isElectron);

  function applyElectronMode() {
    if (!IS_ELECTRON) return;

    document.body.classList.add('electron-browser-panel');

    const chatTab = document.querySelector('.tab-btn[data-tab="chat"]');
    const chatPane = document.getElementById('pane-chat');
    if (chatTab) chatTab.hidden = true;
    if (chatPane) chatPane.hidden = true;

    const hermesFloat = document.getElementById('hermes-float');
    const slideout = document.getElementById('chat-slideout');
    if (hermesFloat) hermesFloat.hidden = true;
    if (slideout) slideout.hidden = true;

    const hash = (location.hash || '').replace(/^#/, '');
    const validTabs = ['clipboard-session', 'workflow', 'kanban', 'tools', 'blueprints'];
    const initialTab = validTabs.includes(hash) ? hash : 'workflow';

    if (initialTab !== 'chat') {
      switchTab(initialTab);
    }

    initHubBrowserChrome();
  }

  function initHubBrowserChrome() {
    const chrome = document.getElementById('hub-browser-chrome');
    if (!chrome || !window.arsenalBrowser) return;

    chrome.hidden = false;

    const urlInput = document.getElementById('hub-browser-url');
    const btnBack = document.getElementById('hub-browser-back');
    const btnForward = document.getElementById('hub-browser-forward');
    const btnReload = document.getElementById('hub-browser-reload');
    const btnGo = document.getElementById('hub-browser-go');

    function syncNav() {
      window.arsenalBrowser.getPageInfo().then((info) => {
        if (urlInput && document.activeElement !== urlInput) {
          urlInput.value = info.url || location.href;
        }
      }).catch(() => {});
    }

    if (btnBack) {
      btnBack.addEventListener('click', () => window.arsenalBrowser.goBack());
    }
    if (btnForward) {
      btnForward.addEventListener('click', () => window.arsenalBrowser.goForward());
    }
    if (btnReload) {
      btnReload.addEventListener('click', () => window.arsenalBrowser.reload());
    }
    if (btnGo && urlInput) {
      const go = () => window.arsenalBrowser.navigate(urlInput.value);
      btnGo.addEventListener('click', go);
      urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') go();
      });
    }

    syncNav();
    setInterval(syncNav, 3000);
  }

  function openInBrowser(url) {
    if (!url) return;
    if (IS_ELECTRON && window.arsenalBrowser.openUrl) {
      window.arsenalBrowser.openUrl(url);
    } else {
      window.open(url, '_blank', 'noopener');
    }
  }

  // ===== TAB SWITCHING =====
  function switchTab(target) {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const panes = document.querySelectorAll('.tab-pane');

    tabBtns.forEach(b => {
      b.classList.toggle('active', b.dataset.tab === target);
    });

    panes.forEach(p => p.classList.remove('active'));
    const pane = document.getElementById('pane-' + target);
    if (pane) pane.classList.add('active');

    if (target === 'tools') {
      renderToolFilters();
      renderToolGrid();
    }
    if (target === 'blueprints' && window.BlueprintsTab) {
      BlueprintsTab.render();
    }

    if (IS_ELECTRON && target !== 'chat') {
      history.replaceState(null, '', `#${target}`);
    }
  }

  // Expose switchTab so toolbar can call it from inline handlers
  window._arsenalSwitchTab = switchTab;

  function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  // ===== SLIDE-OUT CHAT v2 =====
  // Skills cache
  let _skillsCache = null;           // { categories: {...}, total: N }
  let _skillPopoverTarget = null;    // { name, description } currently shown

  const CURATED_SKILLS = [
    { name: 'godot-ai-development',  label: 'Godot AI' },
    { name: 'aidailine-persona',     label: 'AidAiline' },
    { name: 'multi-agent-workflow',  label: 'Multi-Agent' },
  ];

  // --- Toast ---
  function showToast(msg, durationMs) {
    durationMs = durationMs || 3000;
    const t = document.createElement('div');
    t.className = 'hub-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => {
      t.classList.add('toast-out');
      t.addEventListener('animationend', () => t.remove(), { once: true });
    }, durationMs);
  }

  // --- Load skill (copy /skill <name> to clipboard) ---
  function loadSkill(skillName) {
    const cmd = `/skill ${skillName}`;
    navigator.clipboard.writeText(cmd).then(() => {
      showToast(`\u201c${cmd}\u201d copied \u2014 paste into chat`);
    }).catch(() => {
      showToast(`Type in chat: ${cmd}`);
    });
  }

  // --- Skill popover ---
  function showSkillPopover(skillName, description) {
    const popover = document.getElementById('skill-popover');
    const nameEl  = document.getElementById('skill-popover-name');
    const descEl  = document.getElementById('skill-popover-desc');
    if (!popover || !nameEl || !descEl) return;
    _skillPopoverTarget = { name: skillName, description };
    nameEl.textContent = skillName;
    descEl.textContent = description || '(No description)';
    popover.hidden = false;
  }

  function hideSkillPopover() {
    const popover = document.getElementById('skill-popover');
    if (popover) popover.hidden = true;
    _skillPopoverTarget = null;
  }

  // --- Curated skill buttons ---
  function renderCuratedSkillBtns() {
    const container = document.getElementById('chat-tool-skills');
    if (!container) return;
    container.innerHTML = '';

    CURATED_SKILLS.forEach(skill => {
      const btn = document.createElement('button');
      btn.className = 'chat-tool-skill-btn';
      btn.title = skill.name;
      btn.textContent = skill.label;
      btn.dataset.skillName = skill.name;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Find description from cache
        let desc = '';
        if (_skillsCache) {
          Object.values(_skillsCache.categories).forEach(list => {
            const found = list.find(s => s.name === skill.name);
            if (found) desc = found.description;
          });
        }
        showSkillPopover(skill.name, desc);
      });
      container.appendChild(btn);
    });
  }

  // --- Skills dropdown ---
  function renderSkillsDropdown(categories) {
    const list = document.getElementById('skills-dropdown-list');
    if (!list) return;
    list.innerHTML = '';

    const catNames = Object.keys(categories).sort();
    if (catNames.length === 0) {
      list.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--text-muted)">No skills found in ~/.hermes/skills/</div>';
      return;
    }

    catNames.forEach(cat => {
      const skills = categories[cat];

      // Category header
      const header = document.createElement('div');
      header.className = 'skills-cat-header';
      header.innerHTML = `<span class="skills-cat-toggle">\u25b6</span><span>${escapeHtml(cat)}</span>`;

      const catList = document.createElement('div');
      catList.className = 'skills-cat-list';

      header.addEventListener('click', () => {
        const isOpen = header.classList.contains('open');
        header.classList.toggle('open', !isOpen);
        catList.classList.toggle('open', !isOpen);
      });

      skills.forEach(skill => {
        const row = document.createElement('div');
        row.className = 'skill-row';
        row.innerHTML =
          `<span class="skill-row-name">${escapeHtml(skill.name)}</span>` +
          `<span class="skill-row-desc">${escapeHtml(skill.description)}</span>`;
        row.addEventListener('click', () => {
          // Hide the dropdown, show popover
          const dd = document.getElementById('skills-dropdown');
          if (dd) dd.hidden = true;
          showSkillPopover(skill.name, skill.description);
        });
        catList.appendChild(row);
      });

      list.appendChild(header);
      list.appendChild(catList);
    });
  }

  // --- Fetch skills from /api/skills ---
  function fetchSkills() {
    const apiBase = window.location.origin.replace(':5000', ':9121');
    fetch(apiBase + '/api/skills')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        _skillsCache = data;
        renderSkillsDropdown(data.categories || {});
      })
      .catch(() => { /* server not running or skills dir missing — silent */ });
  }

  function initHermesFloat() {
    const hermesBtn   = document.getElementById('hermes-float');
    const slideout    = document.getElementById('chat-slideout');
    const slideoutClose = document.getElementById('chat-slideout-close');
    const newChatBtn  = document.getElementById('chat-slideout-new');
    const chatIframe  = document.getElementById('chat-slideout-iframe');
    const handle      = document.getElementById('chat-slideout-handle');

    const intellimodSl    = document.getElementById('intellimod-slideout');
    const intellimodClose = document.getElementById('intellimod-slideout-close');
    const intellimodHandle = document.getElementById('intellimod-slideout-handle');

    const skillsDropdown    = document.getElementById('skills-dropdown');
    const moreDropdown      = document.getElementById('chat-tool-more-dropdown');
    const skillPopover      = document.getElementById('skill-popover');
    const skillPopoverLoad  = document.getElementById('skill-popover-load');
    const skillPopoverClose = document.getElementById('skill-popover-close');

    // --- Toggle chat slide-out ---
    if (hermesBtn && slideout) {
      hermesBtn.addEventListener('click', () => {
        slideout.hidden = !slideout.hidden;
      });
    }
    if (slideoutClose && slideout) {
      slideoutClose.addEventListener('click', () => { slideout.hidden = true; });
    }

    // --- IntelliMod open/close ---
    if (intellimodClose && intellimodSl) {
      intellimodClose.addEventListener('click', () => { intellimodSl.hidden = true; });
    }

    // --- New Chat button (reload iframe) ---
    if (newChatBtn && chatIframe) {
      newChatBtn.addEventListener('click', () => {
        const src = chatIframe.src;
        chatIframe.src = '';
        requestAnimationFrame(() => { chatIframe.src = src; });
      });
    }

    // --- Toolbar buttons ---
    const clipboardBtn   = document.getElementById('chat-tool-clipboard');
    const intellimodBtn  = document.getElementById('chat-tool-intellimod');
    const moreBtn        = document.getElementById('chat-tool-more');

    if (clipboardBtn) {
      clipboardBtn.addEventListener('click', () => {
        // Switch the main tab to Clipboard; slideout stays open
        switchTab('clipboard-session');
        // Close any open dropdowns/popovers
        closeAllOverlays();
      });
    }

    if (intellimodBtn && intellimodSl) {
      intellimodBtn.addEventListener('click', () => {
        const isOpen = !intellimodSl.hidden;
        if (isOpen) {
          intellimodSl.hidden = true;
          intellimodBtn.classList.remove('active');
        } else {
          intellimodSl.hidden = false;
          intellimodBtn.classList.add('active');
        }
        closeDropdowns();
      });
    }

    if (moreBtn) {
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (moreDropdown) {
          moreDropdown.hidden = !moreDropdown.hidden;
          if (skillsDropdown) skillsDropdown.hidden = true;
        }
      });
    }

    // --- More dropdown actions ---
    if (moreDropdown) {
      moreDropdown.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === 'browse-skills') {
          moreDropdown.hidden = true;
          if (skillsDropdown) skillsDropdown.hidden = false;
        } else if (action === 'blueprints') {
          moreDropdown.hidden = true;
          switchTab('blueprints');
        }
      });
    }

    // --- Skill popover actions ---
    if (skillPopoverLoad) {
      skillPopoverLoad.addEventListener('click', () => {
        if (_skillPopoverTarget) loadSkill(_skillPopoverTarget.name);
        hideSkillPopover();
      });
    }
    if (skillPopoverClose) {
      skillPopoverClose.addEventListener('click', hideSkillPopover);
    }

    // --- Close overlays on outside click ---
    document.addEventListener('click', (e) => {
      // Dropdowns
      if (moreDropdown && !moreDropdown.hidden) {
        if (!moreDropdown.contains(e.target) && e.target !== moreBtn) {
          moreDropdown.hidden = true;
        }
      }
      if (skillsDropdown && !skillsDropdown.hidden) {
        const toolbar = document.getElementById('chat-toolbar');
        if (toolbar && !toolbar.contains(e.target) && !skillsDropdown.contains(e.target)) {
          skillsDropdown.hidden = true;
        }
      }
      // Popover
      if (skillPopover && !skillPopover.hidden) {
        if (!skillPopover.contains(e.target)) {
          const isSkillBtn = e.target.closest('.chat-tool-skill-btn') || e.target.closest('.skill-row');
          if (!isSkillBtn) hideSkillPopover();
        }
      }
    });

    // --- Escape key: close overlays then slide-outs ---
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // First close any open overlay
      if (skillPopover && !skillPopover.hidden) { hideSkillPopover(); return; }
      if (moreDropdown && !moreDropdown.hidden) { moreDropdown.hidden = true; return; }
      if (skillsDropdown && !skillsDropdown.hidden) { skillsDropdown.hidden = true; return; }
      // Then close slide-outs
      if (intellimodSl && !intellimodSl.hidden) {
        intellimodSl.hidden = true;
        if (intellimodBtn) intellimodBtn.classList.remove('active');
        return;
      }
      if (slideout && !slideout.hidden) { slideout.hidden = true; }
    });

    // --- Resize handle: chat slide-out ---
    if (handle && slideout) {
      initResizeHandle(handle, slideout);
    }
    if (intellimodHandle && intellimodSl) {
      initResizeHandle(intellimodHandle, intellimodSl);
    }

    // --- Render curated skill buttons ---
    renderCuratedSkillBtns();
  }

  // --- Helpers ---
  function closeDropdowns() {
    const dd1 = document.getElementById('skills-dropdown');
    const dd2 = document.getElementById('chat-tool-more-dropdown');
    if (dd1) dd1.hidden = true;
    if (dd2) dd2.hidden = true;
  }

  function closeAllOverlays() {
    closeDropdowns();
    hideSkillPopover();
  }

  // --- Drag-resize handle ---
  function initResizeHandle(handle, panel) {
    let startX = 0;
    let startW = 0;
    let isDragging = false;
    let isFullscreen = false;
    let savedWidth = '';

    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      startX = e.clientX;
      startW = panel.offsetWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const delta = startX - e.clientX;   // dragging left = wider
      const newW = Math.max(280, Math.min(window.innerWidth, startW + delta));
      panel.style.width = newW + 'px';
      isFullscreen = false;
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      savedWidth = panel.style.width;
    });

    handle.addEventListener('dblclick', () => {
      if (isFullscreen) {
        panel.style.width = savedWidth || '420px';
        isFullscreen = false;
      } else {
        savedWidth = panel.style.width || panel.offsetWidth + 'px';
        panel.style.width = '100vw';
        isFullscreen = true;
      }
    });
  }

  // ===== TOOLS TAB: FILTER ACCORDION =====
  function getAllToolTags() {
    const set = new Set();
    tools.forEach(t => (t.tags || []).forEach(tag => set.add(tag)));
    return Array.from(set).sort();
  }

  function renderToolFilters() {
    const toggle = document.getElementById('filter-toggle');
    const accordion = document.getElementById('filter-accordion');
    const tagList = document.getElementById('tag-list');
    if (!toggle || !accordion || !tagList) return;

    // Toggle behavior
    toggle.onclick = () => {
      const isOpen = toggle.getAttribute('aria-expanded') === 'true';
      if (isOpen) {
        accordion.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = 'FILTER ▸';
      } else {
        accordion.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        toggle.textContent = 'FILTER ▼';
      }
    };

    // Populate tags
    tagList.innerHTML = '';
    const tags = getAllToolTags();
    tags.forEach(tag => {
      const b = document.createElement('button');
      b.className = 'tag-btn';
      b.textContent = tag;
      b.dataset.tag = tag;
      if (tag === currentToolFilter) b.classList.add('active');
      b.onclick = () => {
        currentToolFilter = tag;
        renderToolFilters();
        renderToolGrid();
      };
      tagList.appendChild(b);
    });

    // Ensure ALL button
    const allBtn = document.querySelector('.tag-btn.all');
    if (allBtn) {
      allBtn.onclick = () => {
        currentToolFilter = 'ALL';
        renderToolFilters();
        renderToolGrid();
      };
      if (currentToolFilter === 'ALL') allBtn.classList.add('active'); else allBtn.classList.remove('active');
    }
  }

  function renderToolGrid() {
    const grid = document.getElementById('tool-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const filtered = tools.filter(t => {
      if (currentToolFilter === 'ALL') return true;
      return (t.tags || []).includes(currentToolFilter);
    });

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'tool-empty';
      empty.textContent = 'No tools match filter.';
      grid.appendChild(empty);
      return;
    }

    filtered.forEach(tool => {
      const card = document.createElement('div');
      card.className = 'tool-card' + (tool.expanded ? ' expanded' : '');

      const statusClass = tool.status === 'active' ? 'active' : 'idle';
      const sess = tool.sessions ? `<span class="sessions">${tool.sessions} sessions</span>` : '';
      const tagsHtml = (tool.tags || []).map(t => `<span class="tag-pill" data-tag="${t}">${t}</span>`).join('');

      // Specialist badge — shown below tags for auto-populated cards
      let specialistBadge = '';
      if (tool._specialist) {
        const dateStr = tool.lastUpdated
          ? new Date(tool.lastUpdated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          : '';
        specialistBadge = `<div class="tool-specialist-badge">🤖 Auto-populated${dateStr ? ' · ' + dateStr : ''}</div>`;
      }

      let extra = '';
      if (tool.expanded && (tool.description || tool.summary)) {
        extra = `<div class="tool-desc">${escapeHtml(tool.description || tool.summary)}</div>`;
      }

      const platformUrl = tool.links?.platform;
      const openBtn = platformUrl
        ? `<button class="tool-open-browser" type="button" data-url="${escapeHtml(platformUrl)}" title="Open in browser">↗</button>`
        : '';

      card.innerHTML = `
        <div class="tool-header">
          <div class="tool-name">${escapeHtml(tool.name)}</div>
          <div class="tool-header-actions">
            ${openBtn}
            <div class="status-indicator">
              <div class="status-dot ${statusClass}" title="Click to toggle status"></div>
            </div>
          </div>
        </div>
        <div class="tool-sessions">${sess}</div>
        <div class="tool-tags">${tagsHtml}</div>
        ${specialistBadge}
        ${extra}
      `;


      // Expand / collapse on card (except interactive children)
      card.querySelector('.tool-open-browser')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openInBrowser(e.currentTarget.dataset.url);
      });

      card.addEventListener('click', (e) => {
        if (e.target.classList.contains('status-dot') || e.target.classList.contains('tag-pill')) return;
        if (e.target.closest('.tool-open-browser')) return;
        tool.expanded = !tool.expanded;
        saveToolsState();
        renderToolGrid();
      });

      // Status dot
      const dot = card.querySelector('.status-dot');
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        // Cycle active <-> idle (per current behavior)
        tool.status = (tool.status === 'active') ? 'idle' : 'active';
        saveToolsState();
        updateActiveCount();
        renderToolGrid();
      });

      // Tag on card applies filter
      card.querySelectorAll('.tag-pill').forEach(pill => {
        pill.addEventListener('click', (e) => {
          e.stopPropagation();
          currentToolFilter = pill.dataset.tag;
          renderToolFilters();
          renderToolGrid();
        });
      });

      grid.appendChild(card);
    });
  }

  // ===== STATIC TICKER =====
  function initTicker() {

    const t = document.getElementById('ticker-content');
    if (!t) return;
    t.addEventListener('mouseenter', () => t.style.animationPlayState = 'paused');
    t.addEventListener('mouseleave', () => t.style.animationPlayState = 'running');
  }

  // ===== TOOL CARD SPECIALIST =====
  function ingestTool(name, url, category) {
    const btn = document.getElementById('ts-research');
    if (btn) { btn.textContent = 'Researching…'; btn.disabled = true; }

    const apiBase = window.location.origin.replace(':5000', ':9121');
    fetch(apiBase + '/api/tools/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, category })
    })
      .then(r => r.json().then(data => ({ ok: r.ok, status: r.status, data })))
      .then(({ ok, data }) => {
        if (!ok) {
          showToast('❌ ' + (data.error || 'Ingest failed'), 5000);
          return;
        }
        if (data.status === 'partial') {
          showToast('⚠️ Extraction incomplete — check server logs', 5000);
          return;
        }
        // Success: upsert into specialistCards, reload + re-render
        const idx = specialistCards.findIndex(c => c.name.toLowerCase() === data.name.toLowerCase());
        if (idx !== -1) specialistCards[idx] = data;
        else specialistCards.push(data);

        loadTools();           // reloads base tools from window.TOOLS
        _mergeSpecialistCards(); // re-applies specialist overrides
        updateActiveCount();
        renderToolFilters();
        renderToolGrid();

        // Clear form inputs
        const nameEl = document.getElementById('ts-name');
        const urlEl  = document.getElementById('ts-url');
        if (nameEl) nameEl.value = '';
        if (urlEl)  urlEl.value  = '';

        showToast(`✅ "${data.name}" card populated`, 4000);
      })
      .catch(err => {
        showToast('❌ Network error: ' + err.message, 5000);
      })
      .finally(() => {
        if (btn) { btn.textContent = 'Research'; btn.disabled = false; }
      });
  }

  function initToolSpecialist() {
    const btn = document.getElementById('ts-research');
    if (!btn) return;

    btn.addEventListener('click', () => {
      const name     = (document.getElementById('ts-name')?.value     || '').trim();
      const url      = (document.getElementById('ts-url')?.value      || '').trim();
      const category = (document.getElementById('ts-category')?.value || '').trim();

      if (!name) { showToast('Enter a tool name first', 2500); return; }
      if (!url)  { showToast('Enter a docs URL first', 2500); return; }

      ingestTool(name, url, category);
    });

    // Enter key in URL field triggers research
    const urlEl = document.getElementById('ts-url');
    if (urlEl) {
      urlEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') btn.click();
      });
    }
  }

  // ===== UTILS =====
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&')
      .replace(/</g, '<')
      .replace(/>/g, '>')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // / focuses chat input (when workflow tab visible)
      if (e.key === '/' && document.activeElement.tagName === 'BODY') {
        const pane = document.getElementById('pane-workflow');
        if (pane && pane.classList.contains('active')) {
          e.preventDefault();
          const input = document.getElementById('chat-widget-input');
          if (input) input.focus();
        }
      }
      // a resets tools filter when tools tab active
      if (e.key.toLowerCase() === 'a' && document.activeElement.tagName === 'BODY') {
        const toolsPane = document.getElementById('pane-tools');
        if (toolsPane && toolsPane.classList.contains('active')) {
          e.preventDefault();
          currentToolFilter = 'ALL';
          const toggle = document.getElementById('filter-toggle');
          const accordion = document.getElementById('filter-accordion');
          if (accordion) accordion.hidden = false;
          if (toggle) {
            toggle.setAttribute('aria-expanded', 'true');
            toggle.textContent = 'FILTER ▼';
          }
          renderToolFilters();
          renderToolGrid();
        }
      }
    });
  }

  // ===== MAIN INIT =====
  function init() {
    // Tools
    loadTools();
    loadSpecialistCards();   // async: fetches from server, merges, re-renders
    updateActiveCount();


    // Tabs
    initTabs();
    initHermesFloat();
    applyElectronMode();

    // Fetch skills from server (populates toolbar + dropdown asynchronously)
    fetchSkills();

    initWorkspaceTabs();

    // Blueprints tab (decomposition engine)
    if (window.BlueprintsTab) BlueprintsTab.init();

    // Tools tab
    // Initial filter render + grid (also called when tab activates)
    renderToolFilters();
    renderToolGrid();

    // Tool Card Specialist form
    initToolSpecialist();

    // Ticker
    initTicker();


    // Shortcuts
    initKeyboardShortcuts();

    // Boot log
    console.log('%c[Arsenal Hub v1] Tab-based frame initialized.', 'color:#10b981');

    // Expose debug helpers
    window.ArsenalHub = {
      reset: () => {
        localStorage.removeItem(STORAGE_TOOLS);
        localStorage.removeItem('arsenal-hub-decomposition-blueprints');
        localStorage.removeItem('arsenal-hub-clipboard-v2');
        location.reload();
      },
      getTools: () => tools,
      getBlueprints: () => window.BlueprintsTab ? BlueprintsTab.getState() : null,
      setToolFilter: (tag) => {
        currentToolFilter = tag || 'ALL';
        renderToolFilters();
        renderToolGrid();
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }


})();
