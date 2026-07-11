# Arsenal Hub v2 — Scoping Document
## Purpose: Augmentation, Not Automation

**Core principle:** You are the orchestrator. The Hub doesn't replace your judgment — it eliminates the information gaps that slow your routing decisions. You still pull the trigger.

**What it answers:**
- "I need to do X. What's my optimal stack?"
- "What resources am I sitting on that I forgot about?"
- "What's this costing me right now?"

---

## 1. DATA MODEL

### 1.1 Tools (the things that do work)

Each tool entry needs:

```
{
  id: "cursor",
  name: "Cursor Pro",
  type: "ide",           // ide | agent | platform | api
  cost: {
    model: "subscription",
    amount: 20,
    period: "monthly",
    notes: "Design Mode is the unique differentiator"
  },
  capabilities: [
    { name: "code-generation", strength: 9, notes: "Claude-backed, fast iteration" },
    { name: "visual-design", strength: 10, notes: "Point-and-click CSS — only tool that sees what you see" },
    { name: "autonomous-agent", strength: 7, notes: "Cloud Agents available" },
    { name: "multi-instance", strength: 8, notes: "Multiple windows/workspaces" }
  ],
  access: {
    method: "desktop-app",
    platform: "windows",
    auth: "subscription"
  },
  status: {
    subscription: "active",
    credits_remaining: null,
    expires: null
  },
  parallel_limit: "unlimited",  // how many instances can run at once
  best_for: [
    "visual UI polish",
    "point-and-click CSS editing",
    "design-mode iteration"
  ],
  not_for: [
    "autonomous merge verification across many files"
  ]
}
```

### 1.2 Tasks (what needs doing)

Task types the Hub should recognize:

| Task Type | Example | Best Tool | Why |
|-----------|---------|-----------|-----|
| **visual-edit** | "Change button color" | Cursor | Only tool that sees the screen |
| **implementation** | "Build this feature" | Antigravity | Free, multi-agent SDK |
| **async-build** | "Go build this PR" | Jules | Fire-and-forget, free |
| **strategy** | "How should we architect X?" | Hermes + GLM 5.2 | 1M context, deep reasoning |
| **merge-verify** | "Did the worker break anything?" | Hermes | Cross-file auditing |
| **research** | "What API does X support?" | Gemini | Google ecosystem, web search |
| **creative** | "Generate app icon" | Grok | Image gen (while SuperGrok lasts) |
| **cheap-default** | Generic coding | Cline + DeepSeek | $0.80/day vs $2.14/turn |

### 1.3 Cost Tracking (what things cost)

Real-time is impossible without API access, but snapshot tracking works:

- **Fixed subscriptions:** Google One Pro ($20/mo), Cursor Pro ($20/mo), agoristic_association ($20/mo)
- **Credit pools:** Nous ($1.84 remaining), Modal ($280), Honcho ($90)
- **Pay-as-you-go:** DeepSeek direct ($0.80/day), Z.AI GLM (free ~6M tokens)
- **Free/included:** Antigravity (Google), Jules (Google), Gemini (Google)
- **Expiring:** SuperGrok (July 30, 2026)

---

## 2. QUERY PATTERNS

### 2.1 "What should I use for X?"

User describes a task → Hub suggests stack with rationale.

**Example input:** "I need to build a login form with a gradient background"

**Example output:**
```
Implementation: Antigravity (Claude Sonnet 4.6, free via Google, multi-agent if needed)
Visual polish: Cursor (Design Mode for gradient/colors — you can see it)
Verification: Hermes (cross-file merge check)
Estimated cost: $0 (Antigravity + Cursor subscriptions already paid)
```

### 2.2 "What am I not using?"

Shows idle or underutilized resources.

**Example output:**
```
IDLE: Jules (100 uses/day available, 0 dispatched this session)
IDLE: Cline CLI (installed, not dispatched today)
UNDERUTILIZED: Modal ($280 credits, no active workloads)
EXPIRING SOON: SuperGrok ($30/3mo, expires July 30 — 34 days)
```

### 2.3 "What's active right now?"

Shows current state across all tools. Not "busy vs idle" — "what's dispatched and where."

**Example output:**
```
Hermes: Strategy session (Arsenal Hub scoping)
Antigravity: Unknown (check C:\Core-User\mailbox\results\ for last completion)
Cursor: Active (user has it open — visual work on AidAiLine)
Jules: Idle (no PRs in flight)
```

---

## 3. ARCHITECTURE

### 3.1 Data Layer

**Canonical store:** `data.js` (or `data.json`) in the Hub project folder. Hermes maintains accuracy. All other layers read from this.

**Update mechanism:** Hermes updates the data file when facts change (subscription cancelled, credits burned, new tool added). The dashboard reads it live.

### 3.2 Presentation Layer

Static HTML/CSS/JS — no backend, no build step. Stitch handles visual design. The JS reads `data.js` and renders the dashboard.

### 3.3 Query Layer (v2.1+)

A small JS function that scores tools against task types:

```javascript
function suggestStack(taskType, constraints) {
  // Score each tool on: capability match, cost, availability
  // Return ranked suggestions with rationale
}
```

This is the "orchestration brain" — it doesn't dispatch, it *suggests*. You decide.

### 3.4 What Stays Manual

- **Tool status** ("what's running right now") — no API into Cursor/Antigravity/Jules. Unless they expose status endpoints, this stays manual. You know what you have open.
- **Credit burn rate** — no real-time API for Nous/Modal/Honcho credit pools. Snapshot updates when you check.
- **Task dispatch** — the Hub suggests, you route. No automatic agent spawning.

---

## 4. ROUTING LOGIC (Scoring Heuristics)

### Capability Scoring (0-10)

| Tool | Code | Visual | Strategy | Async | Cost/1K |
|------|------|--------|----------|-------|---------|
| Hermes + DeepSeek | 8 | 0 | 9 | 5 | $0.80/day |
| Hermes + GLM 5.2 | 7 | 0 | 10 | 4 | $1.84 remaining |
| Antigravity (Sonnet 4.6) | 9 | 5 | 7 | 6 | Free* |
| Cursor Pro | 8 | 10 | 6 | 8 | $20/mo |
| Jules (Gemini 3 Pro) | 7 | 0 | 5 | 10 | Free* |
| Cline + DeepSeek | 7 | 0 | 5 | 3 | $0.80/day |
| Gemini | 4 | 6 | 7 | 5 | Free* |
| Grok | 3 | 3 | 4 | 2 | Expiring |

*Free = included in Google One Pro subscription

### Routing Rules (Priority Order)

1. **Visual tasks always → Cursor.** Nothing else sees the screen.
2. **Async/build-and-PR → Jules.** Only tool designed for fire-and-forget PR workflow.
3. **Implementation → Antigravity.** Free, fast, multi-agent. Default builder.
4. **Strategy/architecture → Hermes + GLM 5.2.** 1M context, deep reasoning.
5. **Merge verification → Hermes.** Cross-file auditing, no other tool does this reliably.
6. **Creative assets → Grok** (while SuperGrok lasts).
7. **Cost-sensitive generic coding → Cline + DeepSeek.** Cheapest non-free option.

---

## 5. WHAT NOT TO BUILD

- **Real-time status polling** — no APIs into Cursor/Antigravity/Jules. Fake "live" data is worse than honest manual snapshots.
- **Automatic dispatch** — you're the orchestrator. The Hub augments, it doesn't replace.
- **Backend/server** — this is a static dashboard. No database, no auth, no deployment. Open in browser, works locally.
- **GitHub integration for Jules tracking** — Jules creates PRs. Those are visible in GitHub. The Hub doesn't need to duplicate that.

---

## 6. VISUAL DIRECTION

This section is for Stitch/AI image generation. The Hub should feel like:

- **Command center, not analytics dashboard.** Think NASA flight control, not Google Analytics.
- **Dark theme** (current palette works: emerald accents on deep void background).
- **Card-based layout** — each tool is a card showing: name, capabilities (visual strength bars), cost indicator, status.
- **Task input area** — a search-style bar: "What are you trying to do?" → ranked suggestions.
- **Alerts panel** — expiring subscriptions, idle resources, credit pools running low.
- **Quick-glance top bar** — active subscriptions count, monthly burn rate, expiring soon count.

**Reference prompt for AI image generation:**

> "Dark command center dashboard, NASA mission control aesthetic. Emerald green accents on deep charcoal background. Card-based layout with glowing borders. Each card represents an AI tool with capability strength bars. Search bar at top: 'What are you trying to do?' Alerts panel on right side showing expiring resources and idle tools. Clean, dense information design. No charts or graphs — just cards, bars, and status indicators. Professional but not corporate. Sci-fi operational feel."

---

## 7. TOOL DISCOVERY LAYER (v2.1+)

### 7.1 Dedicated Arsenal Hub Agent

A separate Hermes profile (`hermes profile create arsenal-hub`) with:
- **Isolated memory** — remembers tool evaluations, pricing changes, new discoveries
- **Isolated skills** — scraping patterns, evaluation criteria, report templates
- **Weekly cron jobs** — automated discovery, no manual maintenance

**Why a separate profile:** The main Hermes session is for strategy and orchestration. Mixing discovery into the same context adds noise. A dedicated profile keeps the Hub data layer maintained without polluting your working session.

**Cost:** Near-zero. Discovery runs on cheap models (GLM 4.6 free tokens or DeepSeek Flash). Weekly evaluation uses DeepSeek V4 Pro (~$0.01-0.05 per run).

### 7.2 Discovery Sources (Weekly Cron)

| Source | What It Finds | Method |
|--------|--------------|--------|
| Hugging Face trending models | New open-source models | `web_extract` |
| OpenRouter model catalog | New API-accessible models, pricing changes | `web_extract` |
| X (key accounts) | Tool announcements, platform news | `x_search` |
| GitHub trending (AI/ML) | New open-source tools, frameworks | `web_search` |
| Product Hunt (AI category) | New commercial AI tools | `web_extract` |

### 7.3 Evaluation Pipeline

Each discovered tool passes through a simple filter:

1. **Relevance check** — Does it fit the stack? (agent/coding/design/research/automation)
2. **Cost check** — Free? Subscription? Pay-as-you-go? Worth the price?
3. **Gap check** — Does it fill a capability nothing else in the stack covers?
4. **Quality check** — Early reviews, community size, stability signals

**Output:** A weekly "Discovery Report" dropped in `C:\Core-User\mailbox\user-mailbox\` with:
- New tools worth evaluating (with rationale)
- Pricing changes on existing tools
- Tools to deprecate (replaced by better options)
- Recommended additions to the Hub

### 7.4 Integration with the Dashboard

The discovery agent updates `data.js` directly when adding new tools. The dashboard picks up changes on next refresh. No manual data entry.

**Alert feed:** The dashboard shows a "Discoveries" panel — recent finds, pending evaluations, price drops. Keeps you aware without having to seek out tool news.

### 7.5 Fine-Tuning Path (Future)

If the discovery agent's evaluations become predictable enough:
1. Log every decision (tool X → added/rejected, reason Y)
2. After 50+ labeled decisions, fine-tune a small model on the pattern
3. Use Modal free tier ($30/mo) for the training run
4. Result: a model that evaluates tools with your judgment, without the weekly reasoning cost

This is v3 territory. The agent-based approach works immediately and generates the training data for free.
