/* ===== Arsenal Hub — Home / Dashboard Tab ===== */
/* Polls /api/dashboard every 30s and populates three zones:
   Zone 1 — Needs Attention (blocked / due-soon / active counts)
   Zone 2 — Glance grid (agents, clipboard, alerts, upcoming)
   Zone 3 — Action bar (quick deploy placeholder + chat bar)
   Also manages /api/deadlines CRUD.
*/

window.HomeTab = (function () {
  'use strict';

  let _pollTimer   = null;
  let _initialized = false;

  // ─── API base ──────────────────────────────────────────────────────────────
  function apiBase() {
    return window.location.origin.replace(':5000', ':9121');
  }

  // ─── Public API ────────────────────────────────────────────────────────────
  function init() {
    if (_initialized) {
      refresh();
      return;
    }
    _initialized = true;
    _bindStatCards();
    _bindChatBar();
    _bindDeadlineForm();
    refresh();
    _pollTimer = setInterval(refresh, 30000);
  }

  function pause() {
    // No-op — poll is cheap at 30s cadence.
  }

  function refresh() {
    fetch(apiBase() + '/api/dashboard')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        _renderPulse(data.attention        || {});
        _renderAgents(data.agents          || []);
        _renderClipboard(data.recent_clipboard || []);
        _renderAlerts(data.tool_alerts     || []);
        _renderUpcoming(data.upcoming      || []);
      })
      .catch(() => { /* server offline — silent */ });
    _refreshDeadlinesList();
  }

  // ─── Zone 1: Pulse cards ───────────────────────────────────────────────────
  function _renderPulse(attention) {
    _setStatCard('home-stat-blocked', attention.blocked  ?? '—', (attention.blocked  || 0) > 0);
    _setStatCard('home-stat-due',     attention.due_soon ?? '—', (attention.due_soon || 0) > 0);
    _setStatCard('home-stat-active',  attention.active   ?? '—', false);
  }

  function _setStatCard(id, count, hasItems) {
    var el = document.getElementById(id);
    if (!el) return;
    var numEl = el.querySelector('.home-stat-num');
    if (numEl) numEl.textContent = count;
    el.classList.toggle('has-items', !!hasItems);
  }

  function _bindStatCards() {
    document.querySelectorAll('[data-jump-tab]').forEach(function (card) {
      card.addEventListener('click', function () {
        var target = card.dataset.jumpTab;
        if (target && window._arsenalSwitchTab) {
          window._arsenalSwitchTab(target);
        }
      });
    });
  }

  // ─── Zone 2a: Agents ───────────────────────────────────────────────────────
  var STATUS_DOT = {
    busy:      '🟢',
    active:    '🟢',
    building:  '🟡',
    idle:      '⚪',
    cancelled: '⚪',
    error:     '🔴',
    blocked:   '🔴',
  };

  function _renderAgents(agents) {
    var el = document.getElementById('home-agents-body');
    if (!el) return;

    if (!agents.length) {
      el.innerHTML = '<div class="home-empty">No agent activity found</div>';
      return;
    }

    el.innerHTML = agents.map(function (ag) {
      var dot      = STATUS_DOT[ag.status] || '\u26AA';
      var activity = ag.activity
        ? '<span class="home-agent-activity">' + _esc(ag.activity) + '</span>'
        : '';
      return '<div class="home-agent-row">' +
        '<span class="home-agent-dot">' + dot + '</span>' +
        '<span class="home-agent-name">' + _esc(ag.name) + '</span>' +
        '<span class="home-agent-status">' + _esc(ag.status || 'idle') + '</span>' +
        activity +
        '</div>';
    }).join('');
  }

  // ─── Zone 2b: Recent Clipboard ─────────────────────────────────────────────
  function _renderClipboard(items) {
    var el = document.getElementById('home-clipboard-body');
    if (!el) return;

    if (!items.length) {
      el.innerHTML = '<div class="home-empty">No clipboard entries yet</div>';
      return;
    }

    el.innerHTML = items.map(function (item) {
      var badge = '<span class="home-source-badge home-source-' + _esc(item.source) + '">' +
        _esc(item.source) + '</span>';
      var rel = item.date ? _relTime(item.date) : '';
      return '<div class="home-clip-row">' +
        badge +
        '<span class="home-clip-title">' + _esc(item.title) + '</span>' +
        '<span class="home-clip-date">' + rel + '</span>' +
        '</div>';
    }).join('');
  }

  // ─── Zone 2c: Tool Alerts ──────────────────────────────────────────────────
  function _renderAlerts(alerts) {
    var el = document.getElementById('home-alerts-body');
    if (!el) return;

    if (!alerts.length) {
      el.innerHTML = '<div class="home-empty">No alerts detected</div>';
      return;
    }

    el.innerHTML = alerts.map(function (a) {
      return '<div class="home-alert-row">' +
        '<span class="home-alert-icon">\u26A0</span>' +
        '<span class="home-alert-tool">' + _esc(a.tool) + '</span>' +
        '<span class="home-alert-text">' + _esc(a.alert) + '</span>' +
        '</div>';
    }).join('');
  }

  // ─── Zone 2d: Upcoming ─────────────────────────────────────────────────────
  function _renderUpcoming(items) {
    var el = document.getElementById('home-upcoming-body');
    if (!el) return;

    if (!items.length) {
      el.innerHTML = '<div class="home-empty">No upcoming deadlines</div>';
      return;
    }

    el.innerHTML = items.map(function (item) {
      var icon = item.type === 'event' ? '\uD83D\uDCC5' :
                 item.type === 'reminder' ? '\uD83D\uDD14' : '\uD83D\uDCCC';
      return '<div class="home-upcoming-row">' +
        '<span class="home-upcoming-icon">' + icon + '</span>' +
        '<span class="home-upcoming-title">' + _esc(item.title) + '</span>' +
        '<span class="home-upcoming-date">' + _esc(_formatDate(item.date)) + '</span>' +
        '</div>';
    }).join('');
  }

  // ─── Deadlines CRUD ────────────────────────────────────────────────────────
  function _bindDeadlineForm() {
    var addBtn = document.getElementById('home-deadline-add');
    if (!addBtn) return;

    addBtn.addEventListener('click', function () {
      var titleEl = document.getElementById('home-dl-title');
      var dateEl  = document.getElementById('home-dl-date');
      var typeEl  = document.getElementById('home-dl-type');

      var title = (titleEl ? titleEl.value : '').trim();
      var date  = (dateEl  ? dateEl.value  : '').trim();
      var type  = typeEl   ? typeEl.value   : 'deadline';

      if (!title || !date) {
        _flash(addBtn, 'Title + date required');
        return;
      }

      addBtn.disabled   = true;
      addBtn.textContent = 'Adding\u2026';

      fetch(apiBase() + '/api/deadlines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title, date: date, type: type }),
      })
        .then(function (r) { return r.json(); })
        .then(function () {
          if (titleEl) titleEl.value = '';
          if (dateEl)  dateEl.value  = '';
          refresh();
        })
        .catch(function () {})
        .finally(function () {
          addBtn.disabled   = false;
          addBtn.textContent = 'Add';
        });
    });

    // Enter in title field triggers add
    var titleEl = document.getElementById('home-dl-title');
    if (titleEl) {
      titleEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') addBtn.click();
      });
    }
  }

  function _refreshDeadlinesList() {
    fetch(apiBase() + '/api/deadlines')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (items) { _renderDeadlinesList(items); })
      .catch(function () {});
  }

  function _renderDeadlinesList(items) {
    var el = document.getElementById('home-deadlines-list');
    if (!el) return;

    if (!items.length) {
      el.innerHTML = '<div class="home-empty">No deadlines added yet</div>';
      return;
    }

    // Sort by date ascending
    var sorted = items.slice().sort(function (a, b) {
      return (a.date || '') < (b.date || '') ? -1 : 1;
    });

    el.innerHTML = sorted.map(function (item) {
      var icon = item.type === 'event' ? '\uD83D\uDCC5' :
                 item.type === 'reminder' ? '\uD83D\uDD14' : '\uD83D\uDCCC';
      return '<div class="home-dl-item" data-id="' + _esc(item.id) + '">' +
        '<span class="home-dl-icon">' + icon + '</span>' +
        '<span class="home-dl-title">' + _esc(item.title) + '</span>' +
        '<span class="home-dl-date">' + _esc(_formatDate(item.date)) + '</span>' +
        '<button class="home-dl-del" data-id="' + _esc(item.id) + '" title="Remove">\u00D7</button>' +
        '</div>';
    }).join('');

    // Bind delete buttons
    el.querySelectorAll('.home-dl-del').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = btn.dataset.id;
        if (!id) return;
        btn.disabled = true;
        fetch(apiBase() + '/api/deadlines/' + encodeURIComponent(id), { method: 'DELETE' })
          .then(function () { refresh(); })
          .catch(function () { btn.disabled = false; });
      });
    });
  }

  // ─── Zone 3: Chat bar ──────────────────────────────────────────────────────
  function _bindChatBar() {
    var chatBar  = document.getElementById('home-chat-bar-input');
    var chatSend = document.getElementById('home-chat-bar-send');
    var slideout = document.getElementById('chat-slideout');

    function openChat() {
      if (slideout) slideout.hidden = false;
    }

    if (chatSend) chatSend.addEventListener('click', openChat);
    if (chatBar) {
      chatBar.addEventListener('focus', openChat);
      chatBar.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') openChat();
      });
    }
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────
  function _esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function _relTime(iso) {
    try {
      var diff = Date.now() - new Date(iso).getTime();
      var mins = Math.floor(diff / 60000);
      if (mins < 1)   return 'just now';
      if (mins < 60)  return mins + 'm ago';
      var hrs = Math.floor(mins / 60);
      if (hrs  < 24)  return hrs + 'h ago';
      var days = Math.floor(hrs / 24);
      if (days < 7)   return days + 'd ago';
      return _formatDate(iso);
    } catch (_) {
      return '';
    }
  }

  function _formatDate(iso) {
    if (!iso) return '';
    try {
      var d = iso.length === 10
        ? new Date(iso + 'T12:00:00')  // treat YYYY-MM-DD as local noon to avoid TZ shift
        : new Date(iso);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch (_) {
      return iso;
    }
  }

  function _flash(btn, msg) {
    var orig = btn.textContent;
    btn.textContent = msg;
    setTimeout(function () { btn.textContent = orig; }, 2000);
  }

  // ─── Export ────────────────────────────────────────────────────────────────
  return { init: init, pause: pause, refresh: refresh };

})();
