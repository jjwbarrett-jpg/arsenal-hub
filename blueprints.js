/* ===== Arsenal Hub — Blueprints Tab (Specialist-Led Chat) ===== */

window.BlueprintsTab = (function () {
  'use strict';

  const STORAGE_KEY = 'arsenal-hub-blueprint-chat-v1';

  const FIELD_LABELS = {
    name: 'Name',
    genre: 'Genre',
    engine: 'Engine',
    platform: 'Platform',
    scope: 'Scope',
    setting: 'Setting',
    art_style: 'Art style',
    players: 'Players',
    monetization: 'Monetization',
    purpose: 'Purpose',
    stack: 'Stack',
    auth: 'Auth',
    data: 'Data',
    audience: 'Audience',
    pages: 'Pages',
    hosting: 'Hosting',
    seo: 'SEO',
    forms: 'Forms',
    brand: 'Brand',
    runtime: 'Runtime',
    inputs: 'Inputs',
    outputs: 'Outputs',
    language: 'Language',
  };

  const REVIEW_FIELDS = [
    'name', 'genre', 'engine', 'platform', 'scope', 'setting', 'art_style',
    'players', 'purpose', 'stack', 'runtime', 'language', 'pages', 'monetization',
  ];

  let state = {
    template: 'game',
    messages: [],       // {role: 'user'|'specialist', content: string}
    extracted: {},
    blueprint: null,
    complete: false,
    sending: false,
    status: '',
    savedList: [],
  };

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function apiBase() {
    // Same origin as the Hub (kanban_server serves static + API on :9121)
    return '';
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      state.template = parsed.template || 'game';
      state.messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      state.extracted = parsed.extracted && typeof parsed.extracted === 'object' ? parsed.extracted : {};
      state.blueprint = parsed.blueprint || null;
      state.complete = !!parsed.complete;
    } catch (_) {
      /* ignore corrupt session */
    }
  }

  function saveSession() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        template: state.template,
        messages: state.messages,
        extracted: state.extracted,
        blueprint: state.blueprint,
        complete: state.complete,
      }));
    } catch (_) {
      /* quota / private mode */
    }
  }

  function setStatus(msg, isError) {
    state.status = msg || '';
    const el = document.getElementById('bp-chat-status');
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = '';
      el.classList.remove('error');
      return;
    }
    el.hidden = false;
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  function renderChips() {
    const el = document.getElementById('bp-extracted-chips');
    if (!el) return;
    const entries = Object.entries(state.extracted || {}).filter(([, v]) => v != null && v !== '');
    if (!entries.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = entries.map(([k, v]) =>
      '<span class="bp-chip" title="' + escapeHtml(FIELD_LABELS[k] || k) + '">' +
        '<span class="bp-chip-key">' + escapeHtml(FIELD_LABELS[k] || k) + '</span> ' +
        escapeHtml(String(v)) +
      '</span>'
    ).join('');
  }

  function renderMessages() {
    const area = document.getElementById('bp-chat-area');
    if (!area) return;

    if (!state.messages.length) {
      area.innerHTML =
        '<div class="bp-chat-empty">' +
          '<div class="bp-chat-empty-title">Blueprint specialist</div>' +
          '<div class="bp-chat-empty-body">Describe what you want to build. The specialist extracts what it can and only asks about gaps.</div>' +
        '</div>';
      return;
    }

    area.innerHTML = state.messages.map((m) => {
      const role = m.role === 'user' ? 'user' : 'specialist';
      const label = role === 'user' ? 'You' : 'Specialist';
      return (
        '<div class="bp-msg bp-msg-' + role + '">' +
          '<div class="bp-msg-label">' + label + '</div>' +
          '<div class="bp-msg-bubble">' + escapeHtml(m.content).replace(/\n/g, '<br>') + '</div>' +
        '</div>'
      );
    }).join('');

    if (state.sending) {
      area.innerHTML +=
        '<div class="bp-msg bp-msg-specialist bp-msg-typing">' +
          '<div class="bp-msg-label">Specialist</div>' +
          '<div class="bp-msg-bubble">Thinking…</div>' +
        '</div>';
    }

    area.scrollTop = area.scrollHeight;
  }

  function foundationList(bp) {
    if (!bp) return [];
    const f = bp.foundation;
    if (Array.isArray(f)) return f;
    if (f && Array.isArray(f.items)) return f.items;
    const core = bp.core_payload && bp.core_payload.primary_driver_details;
    if (core && Array.isArray(core.components)) return core.components;
    return [];
  }

  function renderReviewCard() {
    const card = document.getElementById('bp-review-card');
    if (!card) return;

    if (!state.complete || !state.blueprint) {
      card.hidden = true;
      card.innerHTML = '';
      return;
    }

    const bp = state.blueprint;
    const name = bp.name || bp.blueprint_name || 'Untitled';
    const type = (bp.type || bp.template || state.template || 'project').toString();
    const foundation = foundationList(bp);

    const fieldsHtml = REVIEW_FIELDS.filter((k) => {
      if (k === 'name') return false;
      const v = bp[k] != null && bp[k] !== '' ? bp[k] : state.extracted[k];
      return v != null && v !== '';
    }).map((k) => {
      const v = bp[k] != null && bp[k] !== '' ? bp[k] : state.extracted[k];
      return (
        '<div class="bp-review-field" data-field="' + escapeHtml(k) + '">' +
          '<label>' + escapeHtml(FIELD_LABELS[k] || k) + '</label>' +
          '<input class="bp-input bp-review-input" data-field="' + escapeHtml(k) + '" value="' + escapeHtml(String(v)) + '" />' +
        '</div>'
      );
    }).join('');

    const foundationHtml = foundation.length
      ? '<ul class="bp-review-foundation">' +
          foundation.map((item, i) =>
            '<li><input class="bp-input bp-foundation-input" data-idx="' + i + '" value="' + escapeHtml(String(item)) + '" /></li>'
          ).join('') +
        '</ul>'
      : '<div class="muted small">No foundation items yet.</div>';

    card.hidden = false;
    card.innerHTML =
      '<div class="bp-review-header">' +
        '<div class="bp-review-title">BLUEPRINT: ' +
          '<input class="bp-input bp-review-name" data-field="name" value="' + escapeHtml(name) + '" />' +
        '</div>' +
        '<div class="bp-review-type">Type: ' + escapeHtml(type) + '</div>' +
      '</div>' +
      '<div class="bp-review-fields">' + fieldsHtml + '</div>' +
      '<div class="bp-review-section">' +
        '<div class="bp-review-section-label">Foundation</div>' +
        foundationHtml +
      '</div>' +
      '<div class="bp-review-actions">' +
        '<button class="btn-secondary" id="bp-btn-edit-continue" type="button">Continue chatting</button>' +
        '<button class="btn-secondary" id="bp-btn-save-bp" type="button">Save</button>' +
        '<button class="btn-primary" id="bp-btn-dispatch" type="button">Approve &amp; Dispatch</button>' +
        '<button class="btn-secondary" id="bp-btn-start-over" type="button">Start Over</button>' +
      '</div>' +
      '<div class="bp-review-confirm" id="bp-review-confirm" hidden></div>';

    wireReviewHandlers();
  }

  function collectReviewEdits() {
    if (!state.blueprint) return null;
    const bp = Object.assign({}, state.blueprint);
    const nameInput = document.querySelector('.bp-review-name');
    if (nameInput) {
      bp.name = nameInput.value.trim() || bp.name;
      bp.blueprint_name = bp.name;
    }
    document.querySelectorAll('.bp-review-input').forEach((input) => {
      const field = input.dataset.field;
      if (!field) return;
      const val = input.value.trim();
      bp[field] = val;
      state.extracted[field] = val;
    });
    const foundation = [];
    document.querySelectorAll('.bp-foundation-input').forEach((input) => {
      const val = input.value.trim();
      if (val) foundation.push(val);
    });
    if (foundation.length) bp.foundation = foundation;
    state.blueprint = bp;
    return bp;
  }

  function wireReviewHandlers() {
    const cont = document.getElementById('bp-btn-edit-continue');
    if (cont) {
      cont.onclick = () => {
        collectReviewEdits();
        state.complete = false;
        // Keep blueprint as draft in extracted; allow more chat
        setStatus('Tell the specialist what to change.');
        const input = document.getElementById('bp-chat-input');
        if (input) input.focus();
        render();
        saveSession();
      };
    }

    const saveBtn = document.getElementById('bp-btn-save-bp');
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const bp = collectReviewEdits();
        if (!bp) return;
        try {
          setStatus('Saving…');
          const res = await fetch(apiBase() + '/api/blueprints', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ blueprint: bp }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || res.statusText);
          state.blueprint = data.blueprint || bp;
          setStatus('Blueprint saved' + (data.saved ? ': ' + data.saved : '.'));
          saveSession();
          renderReviewCard();
        } catch (err) {
          setStatus('Save failed: ' + err.message, true);
        }
      };
    }

    const dispatchBtn = document.getElementById('bp-btn-dispatch');
    if (dispatchBtn) {
      dispatchBtn.onclick = async () => {
        const bp = collectReviewEdits();
        if (!bp) return;
        try {
          setStatus('Dispatching…');
          dispatchBtn.disabled = true;
          const res = await fetch(apiBase() + '/api/blueprints/dispatch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ blueprint: bp }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || res.statusText);
          state.blueprint = data.blueprint || bp;
          state.blueprint.status = 'dispatched';
          const msg = data.message || 'Blueprint dispatched. Track it on the Kanban tab.';
          setStatus(msg);
          const confirm = document.getElementById('bp-review-confirm');
          if (confirm) {
            confirm.hidden = false;
            confirm.textContent = msg +
              (data.task_id ? ' Task #' + data.task_id + '.' : '') +
              (data.spec_path ? ' Spec written.' : '');
          }
          saveSession();
        } catch (err) {
          setStatus('Dispatch failed: ' + err.message, true);
          dispatchBtn.disabled = false;
        }
      };
    }

    const startOver = document.getElementById('bp-btn-start-over');
    if (startOver) {
      startOver.onclick = () => {
        if (!confirm('Start a new blueprint? Current conversation will be cleared.')) return;
        resetConversation(true);
      };
    }
  }

  function render() {
    const sel = document.getElementById('bp-template');
    if (sel && sel.value !== state.template) sel.value = state.template;

    renderChips();
    renderMessages();
    renderReviewCard();

    const sendBtn = document.getElementById('bp-chat-send');
    const input = document.getElementById('bp-chat-input');
    if (sendBtn) sendBtn.disabled = state.sending;
    if (input) input.disabled = state.sending;
  }

  async function sendMessage(text) {
    const content = (text || '').trim();
    if (!content || state.sending) return;

    state.messages.push({ role: 'user', content });
    state.sending = true;
    setStatus('');
    render();
    saveSession();

    const history = state.messages.slice(0, -1).map((m) => ({
      role: m.role === 'specialist' ? 'assistant' : 'user',
      content: m.content,
    }));

    try {
      const res = await fetch(apiBase() + '/api/blueprints/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template: state.template,
          messages: history,
          message: content,
          extracted: state.extracted,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);

      state.extracted = data.extracted || state.extracted;
      state.complete = !!data.complete;
      state.blueprint = data.blueprint || null;
      if (data.reply) {
        state.messages.push({ role: 'specialist', content: data.reply });
      }
    } catch (err) {
      state.messages.push({
        role: 'specialist',
        content: 'Sorry — the specialist hit an error: ' + err.message,
      });
      setStatus('Chat error: ' + err.message, true);
    } finally {
      state.sending = false;
      saveSession();
      render();
    }
  }

  async function openConversation() {
    // Seed with specialist opener if empty
    if (state.messages.length) {
      render();
      return;
    }
    state.sending = true;
    render();
    try {
      const res = await fetch(apiBase() + '/api/blueprints/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template: state.template,
          messages: [],
          message: '',
          extracted: {},
        }),
      });
      const data = await res.json();
      if (res.ok && data.reply) {
        state.messages.push({ role: 'specialist', content: data.reply });
        state.extracted = data.extracted || {};
      } else {
        state.messages.push({ role: 'specialist', content: 'What are you building?' });
      }
    } catch (_) {
      state.messages.push({ role: 'specialist', content: 'What are you building?' });
    } finally {
      state.sending = false;
      saveSession();
      render();
    }
  }

  function resetConversation(openAfter) {
    state.messages = [];
    state.extracted = {};
    state.blueprint = null;
    state.complete = false;
    state.status = '';
    setStatus('');
    saveSession();
    render();
    if (openAfter !== false) openConversation();
  }

  async function loadSavedList() {
    const list = document.getElementById('bp-list');
    if (!list) return;
    list.innerHTML = '<div class="bp-list-empty">Loading…</div>';
    try {
      const res = await fetch(apiBase() + '/api/blueprints');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      state.savedList = data.blueprints || [];
      if (!state.savedList.length) {
        list.innerHTML = '<div class="bp-list-empty">No saved blueprints yet.</div>';
        return;
      }
      list.innerHTML = state.savedList.map((bp, idx) => {
        const name = bp.blueprint_name || bp.name || bp.filename || 'Untitled';
        const meta = (bp.template || bp.type || '') + (bp.status ? ' · ' + bp.status : '');
        return (
          '<button class="bp-list-item" type="button" data-idx="' + idx + '">' +
            '<span class="bp-list-name">' + escapeHtml(name) + '</span>' +
            '<span class="bp-list-meta">' + escapeHtml(meta) + '</span>' +
          '</button>'
        );
      }).join('');
      list.querySelectorAll('.bp-list-item').forEach((btn) => {
        btn.addEventListener('click', () => {
          const bp = state.savedList[Number(btn.dataset.idx)];
          if (!bp) return;
          state.blueprint = bp;
          state.extracted = Object.assign({}, bp.extracted || {});
          REVIEW_FIELDS.forEach((k) => {
            if (bp[k] != null && bp[k] !== '') state.extracted[k] = bp[k];
          });
          state.complete = true;
          state.template = bp.template || bp.type || state.template;
          state.messages = [
            { role: 'specialist', content: 'Loaded saved blueprint. Review below or continue chatting to refine.' },
          ];
          const panel = document.getElementById('bp-load-panel');
          if (panel) panel.hidden = true;
          saveSession();
          render();
        });
      });
    } catch (err) {
      list.innerHTML = '<div class="bp-list-empty">Failed to load: ' + escapeHtml(err.message) + '</div>';
    }
  }

  function init() {
    loadSession();

    const sel = document.getElementById('bp-template');
    if (sel) {
      sel.value = state.template;
      sel.addEventListener('change', () => {
        if (state.messages.length > 1) {
          if (!confirm('Switch template and reset conversation?')) {
            sel.value = state.template;
            return;
          }
        }
        state.template = sel.value;
        resetConversation(true);
      });
    }

    const sendBtn = document.getElementById('bp-chat-send');
    const input = document.getElementById('bp-chat-input');
    if (sendBtn) {
      sendBtn.addEventListener('click', () => {
        const text = input ? input.value : '';
        if (input) input.value = '';
        sendMessage(text);
      });
    }
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const text = input.value;
          input.value = '';
          sendMessage(text);
        }
      });
    }

    const newBtn = document.getElementById('btn-new-blueprint');
    if (newBtn) {
      newBtn.addEventListener('click', () => {
        if (state.messages.length && !confirm('Start a new blueprint conversation?')) return;
        resetConversation(true);
      });
    }

    const loadBtn = document.getElementById('btn-bp-load');
    const loadPanel = document.getElementById('bp-load-panel');
    const loadClose = document.getElementById('bp-load-close');
    if (loadBtn && loadPanel) {
      loadBtn.addEventListener('click', () => {
        loadPanel.hidden = !loadPanel.hidden;
        if (!loadPanel.hidden) loadSavedList();
      });
    }
    if (loadClose && loadPanel) {
      loadClose.addEventListener('click', () => { loadPanel.hidden = true; });
    }

    if (!state.messages.length) {
      openConversation();
    } else {
      render();
    }
  }

  return {
    init,
    render,
    getState: () => state,
    reset: () => {
      localStorage.removeItem(STORAGE_KEY);
      resetConversation(true);
    },
  };
})();
