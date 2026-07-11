/* ===== Arsenal Hub — Decomposition Engine ===== */
/* Type detection, template loading, recursive decomposition, AI filler */

window.Decomposer = (function () {
  'use strict';

  const TEMPLATE_FILES = [
    'game.json',
    'game-fighting.json',
    'game-platformer.json',
    'game-puzzle.json',
    'app.json',
    'app-weather.json',
    'app-utility.json',
    'website.json'
  ];

  const MODELS = {
    structure: 'gemini-2.0-flash-lite',
    creative: 'deepseek-v4-pro'
  };

  const templates = new Map();
  let templatesLoaded = false;

  function uid(prefix = 'node') {
    return prefix + '-' + Math.random().toString(36).slice(2, 9);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async function loadTemplates() {
    if (templatesLoaded) return templates;

    const loads = TEMPLATE_FILES.map(async (file) => {
      try {
        const res = await fetch('templates/' + file);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        templates.set(data.id, data);
      } catch (err) {
        console.warn('[Decomposer] Failed to load template:', file, err);
      }
    });

    await Promise.all(loads);
    templatesLoaded = true;
    return templates;
  }

  function getTemplate(id) {
    return templates.get(id) || null;
  }

  function getAllTemplates() {
    return Array.from(templates.values());
  }

  function scoreTemplate(plan, template) {
    const text = plan.toLowerCase();
    const keywords = template.keywords || [];
    let score = 0;

    keywords.forEach((kw) => {
      if (text.includes(kw.toLowerCase())) score += kw.split(' ').length;
    });

    if (template.id && text.includes(template.id.replace(/-/g, ' '))) {
      score += 2;
    }

    return score;
  }

  function detectTypeFromKeywords(plan) {
    const subtypeTemplates = getAllTemplates().filter((t) => t.parent);
    let best = null;
    let bestScore = 0;

    subtypeTemplates.forEach((t) => {
      const score = scoreTemplate(plan, t);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    });

    if (best && bestScore > 0) return best.id;

    const rootTemplates = getAllTemplates().filter((t) => !t.parent && t.subtypes);
    rootTemplates.forEach((t) => {
      const score = scoreTemplate(plan, t);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    });

    if (best && bestScore > 0) return best.id;

    if (/website|landing page|portfolio|blog/i.test(plan)) return 'website';
    if (/app|application/i.test(plan)) return 'app-utility';
    if (/game/i.test(plan)) return 'game-puzzle';

    return 'app-utility';
  }

  async function callAI(messages, model) {
    const res = await fetch('/api/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'API error ' + res.status);
    }

    const data = await res.json();
    return data.content || '';
  }

  function parseJSONFromAI(text) {
    const trimmed = (text || '').trim();
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fence ? fence[1].trim() : trimmed;

    try {
      return JSON.parse(raw);
    } catch (_) {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) {
        return JSON.parse(raw.slice(start, end + 1));
      }
      throw new Error('Could not parse AI JSON response');
    }
  }

  function extractTheme(plan) {
    const lower = plan.toLowerCase();
    const withMatch = lower.match(/with\s+(.+)/);
    if (withMatch) return withMatch[1].trim();

    const aboutMatch = lower.match(/about\s+(.+)/);
    if (aboutMatch) return aboutMatch[1].trim();

    return plan;
  }

  function mockFillBranch({ plan, theme, branch, parent }) {
    const themeWord = theme.split(/\s+/).slice(0, 2).join(' ') || 'themed';
    const items = [
      {
        name: themeWord.charAt(0).toUpperCase() + themeWord.slice(1) + ' Variant A',
        description: 'A ' + themeWord + '-themed element for ' + branch + ' in ' + (parent || plan) + '.',
        attributes: { theme: themeWord },
        decomposable: true
      },
      {
        name: themeWord.charAt(0).toUpperCase() + themeWord.slice(1) + ' Variant B',
        description: 'Alternative ' + themeWord + ' approach for ' + branch + ' with distinct mechanics.',
        attributes: { theme: themeWord },
        decomposable: true
      },
      {
        name: 'Core ' + branch + ' Rules',
        description: 'Fundamental rules and constraints governing ' + branch.toLowerCase() + '.',
        attributes: {},
        decomposable: false
      }
    ];
    return { items };
  }

  function buildFillPrompt({ plan, theme, branch, parent, siblings }) {
    const siblingList = (siblings || []).map((s) => s.name || s).join(', ') || '(none)';

    return [
      {
        role: 'system',
        content: 'You are filling in a branch of a project design blueprint. Respond ONLY with valid JSON, no markdown explanation.'
      },
      {
        role: 'user',
        content: [
          'You are filling in a branch of a game/app design blueprint.',
          '',
          'Plan: ' + plan,
          'Theme: ' + theme,
          'Branch: ' + branch,
          'Parent: ' + (parent || 'root'),
          'Siblings: ' + siblingList,
          '',
          'Generate a list of 3-6 items for this branch. Each item should have:',
          '- name (string)',
          '- description (1-2 sentences)',
          '- attributes (object, optional key-value pairs)',
          '- decomposable (boolean — false if this is atomic and cannot be broken down further)',
          '',
          'Return JSON exactly in this shape:',
          '{"items":[{"name":"...","description":"...","attributes":{},"decomposable":true}]}'
        ].join('\n')
      }
    ];
  }

  async function fillBranch(ctx, options = {}) {
    const model = options.model || MODELS[ctx.modelTier || 'creative'] || MODELS.creative;
    const prompt = buildFillPrompt(ctx);

    try {
      const raw = await callAI(prompt, model);
      const parsed = parseJSONFromAI(raw);
      if (!parsed.items || !Array.isArray(parsed.items)) {
        throw new Error('Invalid items array');
      }
      return parsed;
    } catch (err) {
      console.warn('[Decomposer] AI fill failed, using mock:', err.message);
      return mockFillBranch(ctx);
    }
  }

  function createNode({ name, branch, type, description, attributes, children, depth, leaf, decomposable }) {
    return {
      id: uid('node'),
      name: name || branch || 'Untitled',
      branch: branch || null,
      type: type || null,
      description: description || '',
      attributes: attributes || {},
      children: children || [],
      depth: depth || 0,
      leaf: !!leaf,
      decomposable: decomposable !== false,
      _open: true
    };
  }

  function getBranchesForType(typeId) {
    const template = getTemplate(typeId);
    if (!template) return [];

    const branches = (template.branches || []).map((b) =>
      typeof b === 'string' ? { name: b, modelTier: template.modelTier || 'creative' } : b
    );

    if (template.parent) {
      const parent = getTemplate(template.parent);
      if (parent && parent.universal_branches) {
        const universal = parent.universal_branches.map((b) =>
          typeof b === 'string' ? { name: b, modelTier: 'structure' } : b
        );
        return branches.concat(universal);
      }
    }

    return branches;
  }

  async function decomposeNode(node, ctx) {
    const { plan, theme, onProgress, useAI = true } = ctx;
    const template = node.type ? getTemplate(node.type) : null;
    const maxDepth = node._maxDepth || template?.maxDepth || 4;

    if (node.depth >= maxDepth || node.leaf || node.decomposable === false) {
      return node;
    }

    if (node.branch && node.children.length === 0) {
      const branchDef = ctx.branchDef || { name: node.branch, modelTier: 'creative', maxDepth };
      const siblings = ctx.siblings || [];

      if (onProgress) {
        onProgress({ phase: 'filling', node: node.name, branch: node.branch, depth: node.depth });
      }

      let items = [];
      if (useAI) {
        const filled = await fillBranch({
          plan,
          theme,
          branch: node.branch,
          parent: ctx.parentName || plan,
          siblings,
          modelTier: branchDef.modelTier
        });
        items = filled.items || [];
      } else {
        items = mockFillBranch({
          plan,
          theme,
          branch: node.branch,
          parent: ctx.parentName
        }).items;
      }

      const childMaxDepth = branchDef.maxDepth || maxDepth;

      for (const item of items) {
        const child = createNode({
          name: item.name,
          branch: item.name,
          description: item.description,
          attributes: item.attributes || {},
          depth: node.depth + 1,
          leaf: item.decomposable === false,
          decomposable: item.decomposable !== false
        });
        child._maxDepth = childMaxDepth;

        if (item.decomposable !== false && child.depth < childMaxDepth) {
          await decomposeNode(child, {
            plan,
            theme,
            onProgress,
            useAI,
            parentName: node.name,
            siblings: items.filter((i) => i.name !== item.name).map((i) => i.name),
            branchDef: { name: item.name, modelTier: branchDef.modelTier, maxDepth: childMaxDepth }
          });
        }

        node.children.push(child);
      }

      return node;
    }

    if (node.type && node.children.length === 0) {
      const branches = getBranchesForType(node.type);

      for (const branchDef of branches) {
        const branchNode = createNode({
          name: branchDef.name,
          branch: branchDef.name,
          type: null,
          depth: node.depth + 1,
          decomposable: true
        });
        branchNode._maxDepth = branchDef.maxDepth || maxDepth;

        await decomposeNode(branchNode, {
          plan,
          theme,
          onProgress,
          useAI,
          parentName: node.name,
          siblings: branches.filter((b) => b.name !== branchDef.name),
          branchDef
        });

        node.children.push(branchNode);
      }
    }

    return node;
  }

  async function decompose(plan, options = {}) {
    await loadTemplates();

    const typeId = options.type || detectTypeFromKeywords(plan);
    const template = getTemplate(typeId);
    const theme = options.theme || extractTheme(plan);

    if (onProgressSafe(options.onProgress)) {
      options.onProgress({ phase: 'detected', type: typeId, typeName: template?.name || typeId });
    }

    const root = createNode({
      name: plan,
      type: typeId,
      description: 'Blueprint for: ' + plan,
      depth: 0,
      decomposable: true
    });
    root._maxDepth = template?.maxDepth || 4;

    await decomposeNode(root, {
      plan,
      theme,
      onProgress: options.onProgress,
      useAI: options.useAI !== false,
      parentName: null,
      siblings: []
    });

    return {
      id: uid('bp'),
      plan,
      theme,
      type: typeId,
      typeName: template?.name || typeId,
      status: 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tree: root
    };
  }

  async function refillBranch(blueprint, nodeId, options = {}) {
    const node = findNode(blueprint.tree, nodeId);
    if (!node) throw new Error('Node not found');

    node.children = [];
    node.leaf = false;
    node.decomposable = true;

    const branchDef = {
      name: node.branch || node.name,
      modelTier: options.modelTier || 'creative',
      maxDepth: node._maxDepth || 3
    };

    await decomposeNode(node, {
      plan: blueprint.plan,
      theme: options.theme || blueprint.theme,
      onProgress: options.onProgress,
      useAI: true,
      parentName: getParentName(blueprint.tree, nodeId),
      siblings: getSiblingNames(blueprint.tree, nodeId),
      branchDef
    });

    blueprint.updatedAt = new Date().toISOString();
    return blueprint;
  }

  function onProgressSafe(fn) {
    return typeof fn === 'function' ? fn : null;
  }

  function findNode(root, nodeId) {
    if (!root) return null;
    if (root.id === nodeId) return root;
    for (const child of root.children || []) {
      const found = findNode(child, nodeId);
      if (found) return found;
    }
    return null;
  }

  function getParentName(root, nodeId, parentName = null) {
    if (!root) return undefined;
    if (root.id === nodeId) return parentName;
    for (const child of root.children || []) {
      const found = getParentName(child, nodeId, root.name);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  function getSiblingNames(root, nodeId) {
    function walk(node, parent) {
      if (!node) return null;
      if (node.id === nodeId) {
        return (parent?.children || [])
          .filter((c) => c.id !== nodeId)
          .map((c) => c.name);
      }
      for (const child of node.children || []) {
        const result = walk(child, node);
        if (result) return result;
      }
      return null;
    }
    return walk(root, null) || [];
  }

  function getNodePath(root, nodeId, path = []) {
    if (!root) return null;
    const current = path.concat(root.name);
    if (root.id === nodeId) return current;
    for (const child of root.children || []) {
      const found = getNodePath(child, nodeId, current);
      if (found) return found;
    }
    return null;
  }

  function exportMarkdown(blueprint) {
    const lines = [];
    lines.push('# ' + blueprint.plan);
    lines.push('');
    lines.push('**Type:** ' + (blueprint.typeName || blueprint.type));
    lines.push('**Theme:** ' + (blueprint.theme || '—'));
    lines.push('**Status:** ' + (blueprint.status || 'draft'));
    lines.push('**Created:** ' + (blueprint.createdAt || '—'));
    lines.push('');
    lines.push('---');
    lines.push('');

    function walk(node, depth) {
      const indent = '  '.repeat(Math.max(0, depth - 1));
      const prefix = depth === 0 ? '#' : '#'.repeat(Math.min(depth + 1, 6));
      lines.push(prefix + ' ' + node.name);
      if (node.description) {
        lines.push('');
        lines.push(indent + node.description);
      }
      if (node.attributes && Object.keys(node.attributes).length) {
        lines.push('');
        lines.push(indent + '**Attributes:**');
        Object.entries(node.attributes).forEach(([k, v]) => {
          lines.push(indent + '- ' + k + ': ' + v);
        });
      }
      lines.push('');
      (node.children || []).forEach((child) => walk(child, depth + 1));
    }

    walk(blueprint.tree, 0);
    return lines.join('\n');
  }

  return {
    loadTemplates,
    getTemplate,
    getAllTemplates,
    detectTypeFromKeywords,
    fillBranch,
    decompose,
    refillBranch,
    findNode,
    getNodePath,
    exportMarkdown,
    createNode,
    uid,
    escapeHtml,
    MODELS
  };
})();