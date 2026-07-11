// Arsenal Hub v1 — Tools Data (per Frame Spec)
// Each tool object drives the grid. Edit here for new tools.
// Status: active | idle | limited | unavailable

const TOOLS = [
  {
    id: "antigravity",
    name: "Antigravity",
    status: "active",
    maxSessions: 3,
    activeSessions: 1,
    sessionLabels: ["AidAiLine canonical"],
    summary: "Google's AI-powered IDE with Claude Sonnet access. Multi-agent SDK and heavy coding workflows.",
    links: {
      platform: "https://antigravity.google/",
      docs: "https://docs.antigravity.google/",
      api: null
    },
    image: null,
    tags: ["Google Product", "IDE", "Agent Platform", "SDK"],
    expanded: false
  },
  {
    id: "cursor",
    name: "Cursor",
    status: "active",
    maxSessions: 2,
    activeSessions: 1,
    sessionLabels: ["Slidecaster", "Ball Drop Maze"],
    summary: "AI-first code editor with Design Mode for visual editing and instant previews.",
    links: {
      platform: "https://cursor.com/",
      docs: "https://docs.cursor.com/",
      api: null
    },
    image: null,
    tags: ["IDE", "Agent Platform"],
    expanded: false
  },
  {
    id: "hermes",
    name: "Hermes",
    status: "active",
    maxSessions: 4,
    activeSessions: 2,
    sessionLabels: ["Primary orchestrator", "WSL2 gateway"],
    summary: "Primary strategic agent and orchestration layer. Persistent memory + tool use via proxy.",
    links: {
      platform: null,
      docs: null,
      api: "http://localhost:8642"
    },
    image: null,
    tags: ["Agent Platform", "CLI", "API"],
    expanded: false
  },
  {
    id: "jules",
    name: "Jules",
    status: "idle",
    maxSessions: 100,
    activeSessions: 0,
    sessionLabels: [],
    summary: "Google async GitHub agent. Takes a spec, works autonomously, opens a PR.",
    links: {
      platform: "https://jules.google/",
      docs: null,
      api: null
    },
    image: null,
    tags: ["Google Product", "Agent Platform"],
    expanded: false
  },
  {
    id: "cline",
    name: "Cline CLI",
    status: "active",
    maxSessions: 5,
    activeSessions: 1,
    sessionLabels: ["Quick fixes"],
    summary: "Terminal-native coding agent running in WSL2. Fast iteration without leaving shell.",
    links: {
      platform: null,
      docs: null,
      api: null
    },
    image: null,
    tags: ["CLI", "Agent Platform"],
    expanded: false
  },
  {
    id: "gemini",
    name: "Gemini",
    status: "idle",
    maxSessions: 1,
    activeSessions: 0,
    sessionLabels: [],
    summary: "Google's multimodal model for research, vision, and structured outputs.",
    links: {
      platform: "https://gemini.google.com/",
      docs: null,
      api: "https://ai.google.dev/"
    },
    image: null,
    tags: ["Google Product", "API", "AI Model"],
    expanded: false
  },
  {
    id: "grok",
    name: "Grok",
    status: "idle",
    maxSessions: 2,
    activeSessions: 0,
    sessionLabels: [],
    summary: "xAI Grok for creative work, image generation, and X platform search.",
    links: {
      platform: "https://x.ai/",
      docs: null,
      api: "https://x.ai/api"
    },
    image: null,
    tags: ["API", "AI Model"],
    expanded: false
  },
  {
    id: "deepseek",
    name: "DeepSeek V4",
    status: "active",
    maxSessions: 3,
    activeSessions: 1,
    sessionLabels: ["Hermes primary driver"],
    summary: "High-performance reasoning and coding model. Primary daily driver via direct API.",
    links: {
      platform: "https://platform.deepseek.com/",
      docs: "https://platform.deepseek.com/docs",
      api: "https://platform.deepseek.com/"
    },
    image: null,
    tags: ["API", "AI Model"],
    expanded: false
  },
  {
    id: "glm52",
    name: "GLM 5.2",
    status: "idle",
    maxSessions: 1,
    activeSessions: 0,
    sessionLabels: [],
    summary: "Mythos-class long-context reasoning (1M). Best for architecture and deep analysis.",
    links: {
      platform: null,
      docs: null,
      api: null
    },
    image: null,
    tags: ["AI Model"],
    expanded: false
  },
  {
    id: "notebooklm",
    name: "NotebookLM",
    status: "idle",
    maxSessions: 1,
    activeSessions: 0,
    sessionLabels: [],
    summary: "Google's document synthesis and audio overview generator.",
    links: {
      platform: "https://notebooklm.google/",
      docs: null,
      api: null
    },
    image: null,
    tags: ["Google Product", "AI Model"],
    expanded: false
  }
];

// Expose globally
window.TOOLS = TOOLS;
