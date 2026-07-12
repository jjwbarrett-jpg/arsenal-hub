"""
Arsenal Hub Kanban Backend
Serves Hermes kanban.db as JSON and accepts updates.
Run: python3 kanban_server.py [--port PORT]
"""
import sqlite3
import json
import uuid
import time
import sys
import os
import re
try:
    import yaml as _yaml
    _YAML_OK = True
except ImportError:
    _yaml = None
    _YAML_OK = False
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

KANBAN_DB = os.path.expanduser("~/.hermes/kanban.db")
KANBAN_BOARDS_DIR = os.path.expanduser("~/.hermes/kanban/boards")

# Gateway proxy config (for chat widget)
GATEWAY_URL = "http://127.0.0.1:8642/v1/chat/completions"
GATEWAY_KEY = "c6bf346d3d4b518ca78f944b3fd8ccd25276b1c915cd4d24b8874e02cc6bfbab"
GATEWAY_MODEL = "deepseek-v4-pro"

# Column definitions (matches Hermes kanban workflow)
COLUMNS = ["triage", "todo", "ready", "in_progress", "blocked", "done"]
COLUMN_LABELS = {
    "triage": "Triage",
    "todo": "Todo",
    "ready": "Ready",
    "in_progress": "In Progress",
    "blocked": "Blocked",
    "done": "Done",
}
# Statuses that map to active columns
ACTIVE_STATUSES = ["triage", "todo", "ready", "in_progress", "blocked"]

# In-memory Hub state — browser POSTs every 5s via tab-agents.js, Hermes GETs /api/state
_hub_state = {}

# --- Clipboard Session ---
CLIPBOARD_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".files", "clipboard-session.json")

# --- Specialist cards storage (auto-populated tool cards) ---
_REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
TOOLS_DIR = os.path.join(_REPO_ROOT, ".files", "tools")
SPECIALIST_CARDS_FILE = os.path.join(TOOLS_DIR, "specialist-cards.json")
# Schema: committed at repo root; runtime mirror under .files/tools/
TOOL_CARD_SCHEMA_REPO = os.path.join(_REPO_ROOT, "tool-card-schema.json")
TOOL_CARD_SCHEMA_FILE = os.path.join(TOOLS_DIR, "schema.json")

# Gemini-lite config for tool extraction (same as chainlit_app.py Scribe usage)
GEMINI_EXTRACT_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"
GEMINI_KEY_ENV = "GEMINI_API_KEY"
GEMINI_KEY_ENV_FALLBACK = "GOOGLE_API_KEY"

# Manual (user-provided) fields — preserved across specialist re-extract / refresh
USER_CARD_FIELDS = ("aliases", "paths", "context_notes", "custom_model", "status_override")
USER_FIELD_DEFAULTS = {
    "aliases": [],
    "paths": {"config": None, "binary": None},
    "context_notes": None,
    "custom_model": None,
    "status_override": None,
}

TOOL_EXTRACT_PROMPT = """You are a tool researcher. Extract structured information from this documentation page.

Return ONLY valid JSON with these exact fields (no markdown fences, no extra text):
{
  "name": "<tool name>",
  "description": "<2-3 sentence description of what it does>",
  "category": "<best fit: Agent Platform | IDE | CLI | API | SDK | Google Product | Infrastructure | Other>",
  "tags": ["<3-5 relevant tags>"],
  "capabilities": ["<normalized capability labels, e.g. code-generation, multi-agent, cron-jobs, web-search>"],
  "pricing_model": "<free | freemium | paid | subscription | self-hosted>",
  "pricing_details": "<brief pricing info or null>",
  "version": "<latest version string if found or null>",
  "has_api": <true|false>,
  "has_cli": <true|false>,
  "has_gui": <true|false>,
  "key_features": ["<3-6 key features>"],
  "docs_url": "<best documentation link or null>",
  "github_url": "<GitHub URL if found or null>",
  "website_url": "<homepage URL if found or null>",
  "status_url": "<status page URL if found or null>",
  "pricing_url": "<pricing page URL if found or null>"
}

Page content:
{content}"""

# --- Skills directory ---
SKILLS_DIR = os.path.expanduser("~/.hermes/skills")

def _load_clipboard():
    """Load clipboard state from JSON file. Returns default if missing/corrupt.
    Accepts both `panels` (v0.3+) and legacy `subjects` keys.
    """
    try:
        if os.path.exists(CLIPBOARD_FILE):
            with open(CLIPBOARD_FILE, 'r') as f:
                data = json.load(f)
            if data and 'sessionId' in data and (
                    isinstance(data.get('panels'), list) or
                    isinstance(data.get('subjects'), list)):
                return data
    except (json.JSONDecodeError, IOError):
        pass
    return {
        "sessionId": f"sess-{int(time.time())}",
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "panels": []
    }

def _save_clipboard(state):
    """Persist clipboard state to JSON file."""
    try:
        os.makedirs(os.path.dirname(CLIPBOARD_FILE), exist_ok=True)
        with open(CLIPBOARD_FILE, 'w') as f:
            json.dump(state, f, indent=2)
        return True
    except IOError:
        return False


def _parse_frontmatter_regex(text):
    """Minimal YAML-ish frontmatter parser (fallback when pyyaml not installed).
    Returns a dict of top-level scalar string/int values between the first --- delimiters.
    """
    result = {}
    parts = text.split('---', 2)
    if len(parts) < 3:
        return result
    for line in parts[1].splitlines():
        m = re.match(r'^([\w][\w-]*):\s*(.+)$', line.strip())
        if m:
            result[m.group(1)] = m.group(2).strip().strip('"\'')
    return result


def _get_memory_context():
    """Return Quick Recall text via memory_client (read-only).

    Prefers in-process MemoryClient when deps are available; otherwise runs
    memory_client.py under a Hermes venv that has psycopg2 (Hub system
    python often does not).
    """
    scripts_dirs = [
        os.path.expanduser("~/.hermes/scripts"),
        "/home/kael-x/.hermes/scripts",
    ]
    for d in scripts_dirs:
        if d and os.path.isdir(d) and d not in sys.path:
            sys.path.insert(0, d)

    # 1) In-process import (works if psycopg2 is installed for this interpreter)
    try:
        from memory_client import MemoryClient
        mc = MemoryClient()
        try:
            return mc.quick_recall()
        finally:
            mc.close()
    except Exception:
        pass

    # 2) Subprocess via Hermes Python envs that ship memory deps
    import subprocess
    script_candidates = [
        os.path.join(d, "memory_client.py") for d in scripts_dirs
    ]
    script = next((p for p in script_candidates if os.path.isfile(p)), None)
    if not script:
        raise FileNotFoundError("memory_client.py not found under ~/.hermes/scripts")

    py_candidates = [
        os.path.expanduser("~/.hermes/hermes-agent/venv/bin/python3"),
        os.path.expanduser("~/.hermes/.venv/bin/python3"),
        "/home/kael-x/.hermes/hermes-agent/venv/bin/python3",
        "/home/kael-x/.hermes/.venv/bin/python3",
        sys.executable,
    ]
    last_err = None
    for py in py_candidates:
        if not py or not os.path.isfile(py):
            continue
        try:
            result = subprocess.run(
                [py, script, "all"],
                capture_output=True,
                text=True,
                timeout=15,
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
            last_err = result.stderr.strip() or f"exit {result.returncode}"
        except Exception as e:
            last_err = str(e)
    raise RuntimeError(f"memory_client failed: {last_err}")


def _load_specialist_cards():
    """Load specialist-populated tool cards from JSON file. Returns [] on miss/corrupt."""
    try:
        if os.path.exists(SPECIALIST_CARDS_FILE):
            with open(SPECIALIST_CARDS_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, list):
                return [_normalize_tool_card(c) for c in data if isinstance(c, dict)]
    except (json.JSONDecodeError, IOError):
        pass
    return []


def _save_specialist_cards(cards):
    """Persist specialist cards list to JSON file."""
    try:
        os.makedirs(os.path.dirname(SPECIALIST_CARDS_FILE), exist_ok=True)
        with open(SPECIALIST_CARDS_FILE, 'w', encoding='utf-8') as f:
            json.dump(cards, f, indent=2)
        return True
    except IOError:
        return False


def _load_tool_card_schema():
    """Load tool card JSON schema from .files mirror or committed repo root. Returns {} on miss."""
    for path in (TOOL_CARD_SCHEMA_FILE, TOOL_CARD_SCHEMA_REPO):
        try:
            if os.path.exists(path):
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    # Keep runtime mirror in sync when reading from repo root
                    if path == TOOL_CARD_SCHEMA_REPO and not os.path.exists(TOOL_CARD_SCHEMA_FILE):
                        try:
                            os.makedirs(TOOLS_DIR, exist_ok=True)
                            with open(TOOL_CARD_SCHEMA_FILE, 'w', encoding='utf-8') as out:
                                json.dump(data, out, indent=2)
                        except IOError:
                            pass
                    return data
        except (json.JSONDecodeError, IOError):
            continue
    return {}


def _user_fields_from_card(card):
    """Extract manual/user-provided fields from an existing card (with defaults)."""
    if not isinstance(card, dict):
        return dict(USER_FIELD_DEFAULTS)
    paths = card.get('paths') if isinstance(card.get('paths'), dict) else {}
    return {
        'aliases': list(card.get('aliases') or []),
        'paths': {
            'config': paths.get('config'),
            'binary': paths.get('binary'),
            **{k: v for k, v in paths.items() if k not in ('config', 'binary')},
        },
        'context_notes': card.get('context_notes'),
        'custom_model': card.get('custom_model'),
        'status_override': card.get('status_override'),
    }


def _normalize_tool_card(card):
    """Ensure a card has v2 auto + manual fields (backward compatible with v1 cards)."""
    if not isinstance(card, dict):
        return card
    out = dict(card)
    # Auto layer defaults
    if 'capabilities' not in out:
        # Prefer features if present, else empty
        feats = out.get('features') or []
        out['capabilities'] = list(feats) if isinstance(feats, list) else []
    if 'pricing_model' not in out:
        pricing = out.get('pricing') if isinstance(out.get('pricing'), dict) else {}
        out['pricing_model'] = pricing.get('model')
    if 'pricing_details' not in out:
        pricing = out.get('pricing') if isinstance(out.get('pricing'), dict) else {}
        out['pricing_details'] = pricing.get('details')
    if 'version' not in out:
        out['version'] = None
    if 'last_refreshed' not in out:
        out['last_refreshed'] = out.get('lastUpdated')
    if 'lastUpdated' not in out and out.get('last_refreshed'):
        out['lastUpdated'] = out['last_refreshed']
    # Links shape
    links = out.get('links') if isinstance(out.get('links'), dict) else {}
    for key in ('docs', 'github', 'website', 'status', 'pricing'):
        links.setdefault(key, links.get(key))
    out['links'] = links
    # Manual layer defaults
    user = _user_fields_from_card(out)
    for k, v in user.items():
        if k not in out or out[k] is None and v is not None and k == 'paths':
            out[k] = v
        elif k not in out:
            out[k] = v
    if not isinstance(out.get('aliases'), list):
        out['aliases'] = []
    if not isinstance(out.get('paths'), dict):
        out['paths'] = dict(USER_FIELD_DEFAULTS['paths'])
    if 'summary' not in out and out.get('description'):
        out['summary'] = out['description']
    if 'source' not in out:
        out['source'] = 'specialist'
    return out


def _find_card_index(cards, name=None, card_id=None):
    """Find card index by id or name (case-insensitive). Returns -1 if missing."""
    if card_id:
        for i, c in enumerate(cards):
            if c.get('id') == card_id:
                return i
    if name:
        name_lower = name.lower()
        for i, c in enumerate(cards):
            if c.get('name', '').lower() == name_lower:
                return i
            aliases = c.get('aliases') or []
            if any(isinstance(a, str) and a.lower() == name_lower for a in aliases):
                return i
    return -1


def _fetch_url_plain_text(url_str):
    """Fetch a URL and return stripped plain text. Raises on network failure."""
    import urllib.request as _ur
    fetch_req = _ur.Request(url_str)
    fetch_req.add_header('User-Agent', 'ArsenalHub/1.0 (Tool Card Specialist)')
    with _ur.urlopen(fetch_req, timeout=15) as resp:
        raw_bytes = resp.read()
    try:
        raw_html = raw_bytes.decode('utf-8', errors='replace')
    except Exception:
        raw_html = raw_bytes.decode('latin-1', errors='replace')
    plain = re.sub(r'<[^>]+>', ' ', raw_html)
    plain = re.sub(r'[ \t]{2,}', ' ', plain)
    plain = re.sub(r'\n{3,}', '\n\n', plain).strip()
    return plain


def _build_tool_card(name, url_str, extracted, user_category='', existing=None):
    """Build a full v2 Tool Card from extraction + preserved user fields."""
    tool_id = (existing or {}).get('id') or ('tool-' + re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-'))
    now_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

    model_tags = extracted.get('tags') or []
    feature_tags = []
    if extracted.get('has_api'):
        feature_tags.append('API')
    if extracted.get('has_cli'):
        feature_tags.append('CLI')
    if extracted.get('has_gui'):
        feature_tags.append('GUI')
    final_tags = list(dict.fromkeys(list(model_tags) + feature_tags))

    capabilities = extracted.get('capabilities') or extracted.get('key_features') or []
    if not isinstance(capabilities, list):
        capabilities = []

    pricing_model = extracted.get('pricing_model')
    pricing_details = extracted.get('pricing_details')
    pricing = {}
    if pricing_model:
        pricing['model'] = pricing_model
    if pricing_details:
        pricing['details'] = pricing_details

    links = {}
    if extracted.get('docs_url'):
        links['docs'] = extracted['docs_url']
    if extracted.get('github_url'):
        links['github'] = extracted['github_url']
    if extracted.get('website_url'):
        links['website'] = extracted['website_url']
    if extracted.get('status_url'):
        links['status'] = extracted['status_url']
    if extracted.get('pricing_url'):
        links['pricing'] = extracted['pricing_url']
    # Ensure the researched URL is retained as docs if nothing better
    if url_str and url_str not in links.values():
        links.setdefault('docs', url_str)
    # Complete link keys for schema shape
    for key in ('docs', 'github', 'website', 'status', 'pricing'):
        links.setdefault(key, None)

    description = extracted.get('description') or ''
    user = _user_fields_from_card(existing)

    card = {
        'id': tool_id,
        'name': name,  # always use caller-supplied name
        'category': user_category or extracted.get('category') or (existing or {}).get('category') or 'Other',
        'tags': final_tags,
        'status': (existing or {}).get('status') or 'active',
        'description': description,
        'summary': description,
        'links': links,
        'capabilities': capabilities,
        'pricing_model': pricing_model,
        'pricing_details': pricing_details,
        'version': extracted.get('version'),
        'last_refreshed': now_iso,
        'lastUpdated': now_iso,  # legacy alias
        'pricing': pricing,
        'features': extracted.get('key_features') or list(capabilities),
        'peak_hours': (existing or {}).get('peak_hours'),
        'source': 'specialist',
        # Manual layer (preserved)
        'aliases': user['aliases'],
        'paths': user['paths'],
        'context_notes': user['context_notes'],
        'custom_model': user['custom_model'],
        'status_override': user['status_override'],
    }
    return _normalize_tool_card(card)


def _extract_tool_from_url(url_str):
    """Fetch docs URL and run Gemini extraction. Returns (extracted_dict | None, error_dict | None)."""
    try:
        plain = _fetch_url_plain_text(url_str)
    except Exception as e:
        return None, {'error': f'Could not fetch documentation: {str(e)}', 'status': 422}

    extracted = None
    raw_text_fallback = None
    for _attempt in range(2):
        try:
            extracted = _call_gemini_extract(plain)
            break
        except json.JSONDecodeError as jde:
            raw_text_fallback = str(jde)
        except Exception as e:
            return None, {'error': f'Gemini extraction failed: {str(e)}', 'status': 502}

    if extracted is None:
        return None, {
            'status': 'partial',
            'message': 'Could not parse structured data from model response',
            'raw_text': raw_text_fallback or '',
            'http_status': 200,
        }
    return extracted, None


def _call_gemini_extract(content):
    """Send page content to Gemini-lite and return extracted JSON dict.
    Uses stdlib urllib to stay dependency-free (same as the chat proxy).
    Raises ValueError if the model returns unparseable JSON after one retry.
    """
    import urllib.request as _ur

    api_key = os.environ.get(GEMINI_KEY_ENV, '') or os.environ.get(GEMINI_KEY_ENV_FALLBACK, '')
    if not api_key:
        raise RuntimeError("No GEMINI_API_KEY or GOOGLE_API_KEY found in environment")

    prompt = TOOL_EXTRACT_PROMPT.replace('{content}', content[:8000])
    payload = json.dumps({
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.1, "maxOutputTokens": 1024}
    }).encode('utf-8')

    url = f"{GEMINI_EXTRACT_URL}?key={api_key}"
    req = _ur.Request(url, data=payload)
    req.add_header('Content-Type', 'application/json')

    with _ur.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())

    # Extract text from Gemini response structure
    parts = result.get('candidates', [{}])[0].get('content', {}).get('parts', [])
    raw_text = ''.join(p.get('text', '') for p in parts).strip()

    # Strip markdown fences if the model wrapped output in ```json ... ```
    if raw_text.startswith('```'):
        raw_text = re.sub(r'^```[\w]*\n?', '', raw_text)
        raw_text = re.sub(r'\n?```$', '', raw_text).strip()

    return json.loads(raw_text)  # Raises json.JSONDecodeError on bad output


def _list_skills():
    """Walk SKILLS_DIR, parse YAML frontmatter from each SKILL.md, return grouped by category."""
    from pathlib import Path
    skills_by_cat = {}
    skills_dir = Path(SKILLS_DIR)
    if not skills_dir.is_dir():
        return {}
    for skill_md in skills_dir.rglob('SKILL.md'):
        rel_parts = skill_md.relative_to(skills_dir).parts
        if any(p.startswith('.') for p in rel_parts):
            continue  # skip hidden/archived folders (.archive, etc.)
        try:
            text = skill_md.read_text(encoding='utf-8', errors='replace')
        except OSError:
            continue
        parts = text.split('---', 2)
        if len(parts) < 3:
            continue
        try:
            if _YAML_OK:
                fm = _yaml.safe_load(parts[1])
            else:
                fm = _parse_frontmatter_regex(text)
        except Exception:
            continue
        if not fm or 'name' not in fm:
            continue
        # Category comes from the directory structure, not the frontmatter:
        #   SKILLS_DIR/<category>/<skill>/SKILL.md -> category = <category>
        #   SKILLS_DIR/<skill>/SKILL.md            -> top-level; use frontmatter or 'uncategorized'
        rel_parts = skill_md.relative_to(skills_dir).parts
        if len(rel_parts) >= 3:
            cat = rel_parts[0]
        else:
            cat = str(fm.get('category') or 'uncategorized')
        skills_by_cat.setdefault(cat, []).append({
            'name': str(fm['name']),
            'description': str(fm.get('description', '')),
            'category': cat,
        })
    result = {}
    for cat in sorted(skills_by_cat):
        result[cat] = sorted(skills_by_cat[cat], key=lambda s: s['name'])
    return result

def get_db(board=None):
    """Get a connection to the kanban database."""
    if board and board != "default":
        db_path = os.path.join(KANBAN_BOARDS_DIR, board, "kanban.db")
    else:
        db_path = KANBAN_DB
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

def ensure_schema(conn):
    """Make sure the tasks table exists."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            body TEXT,
            assignee TEXT,
            status TEXT NOT NULL,
            priority INTEGER DEFAULT 0,
            created_by TEXT,
            created_at INTEGER NOT NULL,
            started_at INTEGER,
            completed_at INTEGER,
            workspace_kind TEXT NOT NULL DEFAULT 'scratch',
            workspace_path TEXT,
            claim_lock TEXT,
            claim_expires INTEGER,
            tenant TEXT,
            result TEXT,
            idempotency_key TEXT,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            worker_pid INTEGER,
            last_failure_error TEXT,
            max_runtime_seconds INTEGER,
            last_heartbeat_at INTEGER,
            current_run_id INTEGER,
            workflow_template_id TEXT,
            current_step_key TEXT,
            skills TEXT,
            max_retries INTEGER,
            branch_name TEXT,
            model_override TEXT,
            session_id TEXT,
            goal_mode INTEGER NOT NULL DEFAULT 0,
            goal_max_turns INTEGER,
            project_id TEXT,
            block_kind TEXT,
            block_recurrences INTEGER NOT NULL DEFAULT 0,
            board TEXT NOT NULL DEFAULT 'default'
        )
    """)
    conn.commit()
    ensure_board_column(conn)

def ensure_board_column(conn):
    """Add board column to legacy databases."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(tasks)").fetchall()}
    if 'board' not in cols:
        conn.execute("ALTER TABLE tasks ADD COLUMN board TEXT NOT NULL DEFAULT 'default'")
        conn.commit()

def task_to_dict(row):
    """Convert a sqlite Row to a JSON-friendly dict."""
    d = dict(row)
    # Convert any bytes to str
    for k, v in d.items():
        if isinstance(v, bytes):
            d[k] = v.decode('utf-8', errors='replace')
    return d

def list_kanban_boards():
    """List available kanban board names."""
    boards = {"default"}
    try:
        conn = get_db()
        ensure_schema(conn)
        rows = conn.execute(
            "SELECT DISTINCT board FROM tasks WHERE board IS NOT NULL AND board != ''"
        ).fetchall()
        boards.update(r["board"] for r in rows)
        conn.close()
    except sqlite3.Error:
        pass

    if os.path.isdir(KANBAN_BOARDS_DIR):
        for name in os.listdir(KANBAN_BOARDS_DIR):
            db_path = os.path.join(KANBAN_BOARDS_DIR, name, "kanban.db")
            if os.path.isfile(db_path):
                boards.add(name)

    return sorted(boards)

def _fetch_board_tasks(conn, board):
    """Load active tasks for a board from the connected database."""
    has_board_col = 'board' in {r[1] for r in conn.execute("PRAGMA table_info(tasks)").fetchall()}
    status_placeholders = ','.join('?' for _ in ACTIVE_STATUSES)

    if has_board_col:
        return conn.execute(
            f"SELECT * FROM tasks WHERE board = ? AND status IN ({status_placeholders}) "
            "ORDER BY priority DESC, created_at DESC",
            (board, *ACTIVE_STATUSES),
        ).fetchall()

    return conn.execute(
        f"SELECT * FROM tasks WHERE status IN ({status_placeholders}) "
        "ORDER BY priority DESC, created_at DESC",
        ACTIVE_STATUSES,
    ).fetchall()

def kanban_state_summary(board='default'):
    """Summarized kanban state for tab agents / Hermes."""
    conn = get_db()
    ensure_schema(conn)
    tasks = _fetch_board_tasks(conn, board)

    if not tasks and board != 'default':
        conn.close()
        conn = get_db(board)
        ensure_schema(conn)
        tasks = _fetch_board_tasks(conn, board)

    counts = {col: 0 for col in COLUMNS}
    count_rows = []
    has_board_col = 'board' in {r[1] for r in conn.execute("PRAGMA table_info(tasks)").fetchall()}
    status_placeholders = ','.join('?' for _ in ACTIVE_STATUSES)

    if has_board_col:
        count_rows = conn.execute(
            f"SELECT status, COUNT(*) as count FROM tasks "
            f"WHERE board = ? AND status IN ({status_placeholders}) GROUP BY status",
            (board, *ACTIVE_STATUSES),
        ).fetchall()
    else:
        count_rows = conn.execute(
            f"SELECT status, COUNT(*) as count FROM tasks "
            f"WHERE status IN ({status_placeholders}) GROUP BY status",
            ACTIVE_STATUSES,
        ).fetchall()

    conn.close()

    for row in count_rows:
        status = row['status']
        if status in counts:
            counts[status] = row['count']

    columns = []
    blocked = []
    tasks_by_col = {col: [] for col in COLUMNS}

    for t in tasks:
        col = t['status'] if t['status'] in COLUMNS else 'triage'
        tasks_by_col[col].append(task_to_dict(t))

    for col in COLUMNS:
        col_tasks = tasks_by_col[col]
        columns.append({
            "name": COLUMN_LABELS[col],
            "status": col,
            "cards": counts.get(col, len(col_tasks)),
            "tasks": [
                {
                    "title": t.get("title", ""),
                    "assignee": t.get("assignee", ""),
                    "priority": t.get("priority", 0),
                    "status": t.get("status", col),
                }
                for t in col_tasks
            ],
        })
        if col == "blocked":
            blocked = [
                {"title": t.get("title", ""), "assignee": t.get("assignee", "")}
                for t in col_tasks
            ]

    return {"board": board, "columns": columns, "blocked": blocked}

def _kanban_board_state_flat(conn, board):
    """Per-board column counts + blocked tasks (tab agent / Hermes format)."""
    has_board_col = 'board' in {r[1] for r in conn.execute("PRAGMA table_info(tasks)").fetchall()}
    status_placeholders = ','.join('?' for _ in ACTIVE_STATUSES)

    if has_board_col:
        count_rows = conn.execute(
            f"SELECT status, COUNT(*) as count FROM tasks "
            f"WHERE board = ? AND status IN ({status_placeholders}) GROUP BY status",
            (board, *ACTIVE_STATUSES),
        ).fetchall()
        blocked_rows = conn.execute(
            "SELECT title, assignee FROM tasks WHERE board = ? AND status = 'blocked'",
            (board,),
        ).fetchall()
    else:
        count_rows = conn.execute(
            f"SELECT status, COUNT(*) as count FROM tasks "
            f"WHERE status IN ({status_placeholders}) GROUP BY status",
            ACTIVE_STATUSES,
        ).fetchall()
        blocked_rows = conn.execute(
            "SELECT title, assignee FROM tasks WHERE status = 'blocked'",
        ).fetchall()

    board_state = {
        COLUMN_LABELS.get(row["status"], row["status"]): row["count"]
        for row in count_rows
    }
    board_state["blocked"] = [
        {"title": row["title"], "assignee": row["assignee"] or ""}
        for row in blocked_rows
    ]
    return board_state

def kanban_state_all():
    """Return current kanban state across all boards for tab agents."""
    result = {"boards": {}}

    for board in list_kanban_boards():
        conn = get_db()
        ensure_schema(conn)
        board_state = _kanban_board_state_flat(conn, board)
        total_cards = sum(v for v in board_state.values() if isinstance(v, int))

        if board != 'default' and total_cards == 0 and not board_state["blocked"]:
            conn.close()
            conn = get_db(board)
            ensure_schema(conn)
            board_state = _kanban_board_state_flat(conn, board)

        result["boards"][board] = board_state
        conn.close()

    return result

class KanbanHandler(BaseHTTPRequestHandler):
    # Serve static files from this directory
    STATIC_DIR = os.path.dirname(os.path.abspath(__file__))
    STATIC_EXTS = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
    }

    def log_message(self, format, *args):
        """Suppress default logging."""
        pass

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/')
        params = parse_qs(parsed.query)

        # Serve static files
        if path == '' or path == '/':
            path = '/index.html'
        ext = os.path.splitext(path)[1].lower()
        if ext in self.STATIC_EXTS:
            filepath = os.path.join(self.STATIC_DIR, path.lstrip('/'))
            if os.path.isfile(filepath) and not os.path.islink(filepath):
                try:
                    with open(filepath, 'rb') as f:
                        data = f.read()
                    self.send_response(200)
                    self.send_header('Content-Type', self.STATIC_EXTS[ext])
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                except OSError:
                    pass
            return self._send_json({"error": "Not found"}, 404)

        if path == '/api/state':
            return self._send_json(_hub_state or {})

        if path == '/api/clipboard':
            return self._send_json(_load_clipboard())

        if path == '/api/kanban/state':
            # Tab agent endpoint — summarized kanban state from kanban.db
            board = params.get('board', [None])[0]
            if board == 'all':
                return self._send_json(kanban_state_all())
            if board:
                return self._send_json(kanban_state_summary(board))
            return self._send_json(kanban_state_summary('default'))

        if path == '/api/boards':
            return self._send_json({"boards": list_kanban_boards()})

        if path == '/api/tools/specialist':
            cards = _load_specialist_cards()
            return self._send_json({'cards': cards, 'count': len(cards)})

        if path == '/api/tools/schema':
            schema = _load_tool_card_schema()
            if not schema:
                return self._send_json({'error': 'Schema not found'}, 404)
            return self._send_json(schema)

        if path == '/api/skills':
            try:
                categories = _list_skills()
            except Exception as exc:
                categories = {}
                print(f'[skills] Error listing skills: {exc}')
            total = sum(len(v) for v in categories.values())
            return self._send_json({'categories': categories, 'total': total})

        if path == '/api/memory/context':
            # Memory pipeline smoke test — read-only Quick Recall for default identity
            try:
                context = _get_memory_context()
                return self._send_json({"status": "ok", "context": context or ""})
            except Exception as e:
                print(f'[memory] Error loading context: {e}')
                return self._send_json({"status": "error", "error": str(e)}, 500)

        if path == '/api/tasks':
            board = params.get('board', ['default'])[0]
            conn = get_db(board)
            ensure_schema(conn)

            # Get all active tasks (non-archived)
            tasks = conn.execute(
                "SELECT * FROM tasks WHERE status IN ({}) ORDER BY priority DESC, created_at DESC".format(
                    ','.join('?' for _ in ACTIVE_STATUSES)
                ),
                ACTIVE_STATUSES
            ).fetchall()

            # Get task runs for active tasks
            task_ids = [t['id'] for t in tasks]
            runs = {}
            if task_ids:
                placeholders = ','.join('?' for _ in task_ids)
                run_rows = conn.execute(
                    f"SELECT * FROM task_runs WHERE task_id IN ({placeholders}) ORDER BY id DESC",
                    task_ids
                ).fetchall()
                for r in run_rows:
                    rid = r['task_id']
                    if rid not in runs:
                        runs[rid] = []
                    runs[rid].append(task_to_dict(r))

            # Get task links
            links = {"parents": {}, "children": {}}
            if task_ids:
                placeholders = ','.join('?' for _ in task_ids)
                link_rows = conn.execute(
                    f"SELECT parent_id, child_id FROM task_links WHERE parent_id IN ({placeholders}) OR child_id IN ({placeholders})",
                    task_ids + task_ids
                ).fetchall()
                for l in link_rows:
                    pid = l['parent_id']
                    cid = l['child_id']
                    if pid not in links["children"]:
                        links["children"][pid] = []
                    links["children"][pid].append(cid)
                    if cid not in links["parents"]:
                        links["parents"][cid] = []
                    links["parents"][cid].append(pid)

            conn.close()

            result = {
                "board": board,
                "columns": COLUMNS,
                "tasks": {col: [] for col in COLUMNS},
                "runs": runs,
                "links": links
            }

            for t in tasks:
                col = t['status'] if t['status'] in COLUMNS else 'triage'
                task_dict = task_to_dict(t)
                task_dict['runs'] = runs.get(t['id'], [])
                task_dict['parents'] = links["parents"].get(t['id'], [])
                task_dict['children'] = links["children"].get(t['id'], [])
                result["tasks"][col].append(task_dict)

            return self._send_json(result)

        if path.startswith('/api/tasks/'):
            task_id = path.split('/api/tasks/')[1]
            board = params.get('board', ['default'])[0]
            conn = get_db(board)
            task = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if task:
                return self._send_json(task_to_dict(task))
            conn.close()
            return self._send_json({"error": "Task not found"}, 404)

        return self._send_json({"error": "Not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/')
        params = parse_qs(parsed.query)
        board = params.get('board', ['default'])[0]

        if path == '/api/state':
            content_len = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}
            global _hub_state
            _hub_state = body
            return self._send_json({"ok": True, "timestamp": body.get("timestamp")})

        # --- Clipboard Session ---
        if path == '/api/clipboard':
            # Browser full sync — trusted user channel
            content_len = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}
            if _save_clipboard(body):
                return self._send_json({"ok": True})
            return self._send_json({"error": "Failed to save clipboard"}, 500)

        if path == '/api/clipboard/agent':
            content_len = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}
            action = body.get('action')
            # Accept both panelId (new) and subjectId (legacy alias)
            panel_id = body.get('panelId') or body.get('subjectId')
            payload = body.get('payload', {})

            state = _load_clipboard()
            # Normalise: if server file still uses legacy `subjects` key, migrate
            if 'subjects' in state and 'panels' not in state:
                state['panels'] = state.pop('subjects')

            # create-panel (also accepts legacy create-subject alias)
            if action in ('create-panel', 'create-subject'):
                now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                bid = os.urandom(4).hex()
                new_panel = {
                    "id": f"panel-{int(time.time())}-{bid}",
                    "title": payload.get('title', 'Untitled Panel'),
                    "type": "notes",
                    "source": "agent",
                    "body": payload.get('body', ''),
                    "grabs": [],
                    "createdAt": now,
                    "updatedAt": now
                }
                state.setdefault('panels', []).append(new_panel)
                _save_clipboard(state)
                return self._send_json({"ok": True, "panel": new_panel})

            panel = next((p for p in state.get('panels', []) if p['id'] == panel_id), None)
            if not panel:
                return self._send_json({"error": "Panel not found"}, 404)

            if action == 'add-grab':
                grab = {
                    "id": f"grab-{int(time.time())}-{os.urandom(4).hex()}",
                    "text": payload.get('text', ''),
                    "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "source": "agent"   # §3 attribution
                }
                panel.setdefault('grabs', []).append(grab)
                panel['updatedAt'] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                _save_clipboard(state)
                return self._send_json({"ok": True, "grab": grab})

            if action == 'set-body':
                panel['body'] = payload.get('body', '')
                panel['updatedAt'] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                _save_clipboard(state)
                return self._send_json({"ok": True})

            if action == 'set-title':
                panel['title'] = payload.get('title', panel['title'])
                panel['updatedAt'] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                _save_clipboard(state)
                return self._send_json({"ok": True})

            return self._send_json({"error": f"Unknown action: {action}"}, 400)

        # --- Universal Scribe Ingest ---
        # Framework-agnostic: any agent POSTs notes/decisions/actions to Hub Clipboard
        if path == '/api/scribe/ingest':
            content_len = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}
            agent = body.get('agent', 'unknown')
            session = body.get('session', '')
            items = body.get('items', [])
            state = _load_clipboard()
            # Normalise legacy subjects → panels
            if 'subjects' in state and 'panels' not in state:
                state['panels'] = state.pop('subjects')
            now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            ingested = 0
            for item in items:
                item_type = item.get('type', 'note')
                text = item.get('text', '').strip()
                if not text:
                    continue
                bid = os.urandom(4).hex()
                panel = {
                    "id": f"panel-{int(time.time())}-{bid}",
                    "title": f"[{item_type}] {text[:60]}",
                    "type": "notes",
                    "source": agent,
                    "body": text,
                    "grabs": [],
                    "createdAt": now,
                    "updatedAt": now,
                }
                if session:
                    panel["session"] = session
                state.setdefault('panels', []).append(panel)
                ingested += 1
            _save_clipboard(state)
            return self._send_json({"status": "ok", "ingested": ingested})

        # Chat proxy — forward to Hermes gateway
        if path == '/api/chat':
            content_len = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}
            messages = body.get('messages', [])
            if not messages:
                return self._send_json({"error": "messages required"}, 400)

            import urllib.request
            req_body = json.dumps({
                "model": GATEWAY_MODEL,
                "messages": messages,
                "max_tokens": body.get("max_tokens", 2048)
            }).encode('utf-8')

            req = urllib.request.Request(GATEWAY_URL, data=req_body)
            req.add_header('Content-Type', 'application/json')
            req.add_header('Authorization', f'Bearer {GATEWAY_KEY}')

            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    result = json.loads(resp.read())
                    return self._send_json(result)
            except Exception as e:
                return self._send_json({"error": str(e)}, 502)

        # --- Tool Card Specialist Ingest (v2 auto-discovered fields) ---
        if path == '/api/tools/ingest':
            content_len = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}

            name = (body.get('name') or '').strip()
            url_str = (body.get('url') or '').strip()
            user_category = (body.get('category') or '').strip()

            if not name or not url_str:
                return self._send_json({'error': 'name and url are required'}, 400)

            extracted, err = _extract_tool_from_url(url_str)
            if err:
                if err.get('status') == 'partial':
                    return self._send_json({
                        'status': 'partial',
                        'message': err.get('message'),
                        'raw_text': err.get('raw_text', ''),
                    })
                return self._send_json({'error': err['error']}, err.get('status', 500))

            cards = _load_specialist_cards()
            idx = _find_card_index(cards, name=name)
            existing = cards[idx] if idx >= 0 else None
            card = _build_tool_card(name, url_str, extracted, user_category=user_category, existing=existing)

            if idx >= 0:
                cards[idx] = card
            else:
                cards.append(card)
            _save_specialist_cards(cards)

            print(f'[specialist] {"Updated" if idx >= 0 else "Added"} card: {name}')
            return self._send_json(card, 201)

        # --- Tool Card Refresh (re-extract auto fields, preserve manual) ---
        if path == '/api/tools/refresh':
            content_len = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}

            name = (body.get('name') or '').strip()
            card_id = (body.get('id') or '').strip()
            url_override = (body.get('url') or '').strip()

            if not name and not card_id:
                return self._send_json({'error': 'name or id is required'}, 400)

            cards = _load_specialist_cards()
            idx = _find_card_index(cards, name=name or None, card_id=card_id or None)
            if idx < 0:
                return self._send_json({'error': 'Card not found'}, 404)

            existing = cards[idx]
            links = existing.get('links') if isinstance(existing.get('links'), dict) else {}
            url_str = url_override or links.get('docs') or links.get('website') or links.get('github') or ''
            if not url_str:
                return self._send_json({
                    'error': 'No docs/website URL on card — pass url in body to refresh'
                }, 400)

            extracted, err = _extract_tool_from_url(url_str)
            if err:
                if err.get('status') == 'partial':
                    return self._send_json({
                        'status': 'partial',
                        'message': err.get('message'),
                        'raw_text': err.get('raw_text', ''),
                    })
                return self._send_json({'error': err['error']}, err.get('status', 500))

            card_name = existing.get('name') or name
            card = _build_tool_card(
                card_name,
                url_str,
                extracted,
                user_category=existing.get('category') or '',
                existing=existing,
            )
            cards[idx] = card
            _save_specialist_cards(cards)

            print(f'[specialist] Refreshed card: {card_name} @ {card.get("last_refreshed")}')
            return self._send_json(card)

        if path == '/api/tasks':
            content_len = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}

            title = body.get('title', '').strip()
            if not title:
                return self._send_json({"error": "title is required"}, 400)

            task_id = body.get('id') or str(uuid.uuid4())[:8]
            status = body.get('status', 'triage')
            if status not in COLUMNS:
                status = 'triage'

            conn = get_db(board)
            ensure_schema(conn)

            now = int(time.time())
            conn.execute("""
                INSERT OR REPLACE INTO tasks (id, title, body, assignee, status, priority, created_by, created_at, tenant, project_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                task_id,
                title,
                body.get('body', ''),
                body.get('assignee', ''),
                status,
                body.get('priority', 0),
                body.get('created_by', 'arsenal-hub'),
                body.get('created_at', now),
                body.get('tenant', ''),
                body.get('project_id', '')
            ))

            conn.commit()
            task = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            conn.close()

            return self._send_json(task_to_dict(task), 201)

        return self._send_json({"error": "Not found"}, 404)

    def do_PATCH(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/')

        # --- Tool Card manual fields (user notes) ---
        # PATCH /api/tools/specialist  body: { id|name, aliases, paths, context_notes, custom_model, status_override }
        # PATCH /api/tools/specialist/{id}
        if path == '/api/tools/specialist' or path.startswith('/api/tools/specialist/'):
            content_len = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}

            card_id = ''
            if path.startswith('/api/tools/specialist/'):
                card_id = path.split('/api/tools/specialist/', 1)[1].strip()
            card_id = (body.get('id') or card_id or '').strip()
            name = (body.get('name') or '').strip()

            if not card_id and not name:
                return self._send_json({'error': 'id or name is required'}, 400)

            cards = _load_specialist_cards()
            idx = _find_card_index(cards, name=name or None, card_id=card_id or None)
            if idx < 0:
                return self._send_json({'error': 'Card not found'}, 404)

            card = dict(cards[idx])

            if 'aliases' in body:
                aliases = body['aliases']
                if isinstance(aliases, str):
                    aliases = [a.strip() for a in aliases.split(',') if a.strip()]
                if not isinstance(aliases, list):
                    return self._send_json({'error': 'aliases must be a list or comma-separated string'}, 400)
                card['aliases'] = [str(a).strip() for a in aliases if str(a).strip()]

            if 'paths' in body:
                paths = body['paths']
                if not isinstance(paths, dict):
                    return self._send_json({'error': 'paths must be an object'}, 400)
                merged_paths = dict(card.get('paths') or {})
                for k, v in paths.items():
                    merged_paths[k] = v if v not in ('',) else None
                card['paths'] = merged_paths

            for field in ('context_notes', 'custom_model', 'status_override'):
                if field in body:
                    val = body[field]
                    card[field] = val if val not in ('',) else None

            # Optional: allow status pin via status_override only (auto fields not writable here)
            card = _normalize_tool_card(card)
            cards[idx] = card
            _save_specialist_cards(cards)

            print(f'[specialist] Manual update: {card.get("name")}')
            return self._send_json(card)

        if path.startswith('/api/tasks/'):
            task_id = path.split('/api/tasks/')[1]
            params = parse_qs(parsed.query)
            board = params.get('board', ['default'])[0]

            content_len = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}

            conn = get_db(board)
            ensure_schema(conn)

            task = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if not task:
                conn.close()
                return self._send_json({"error": "Task not found"}, 404)

            now = int(time.time())

            # Handle status changes
            if 'status' in body:
                new_status = body['status']
                if new_status not in COLUMNS:
                    conn.close()
                    return self._send_json({"error": f"Invalid status: {new_status}"}, 400)

                if new_status == 'in_progress' and task['status'] != 'in_progress':
                    conn.execute("UPDATE tasks SET started_at = ? WHERE id = ?", (now, task_id))
                elif new_status == 'done':
                    conn.execute("UPDATE tasks SET completed_at = ? WHERE id = ?", (now, task_id))
                elif new_status == 'blocked' and body.get('block_reason'):
                    conn.execute("UPDATE tasks SET block_kind = ? WHERE id = ?",
                               (body['block_reason'], task_id))

                conn.execute("UPDATE tasks SET status = ? WHERE id = ?", (new_status, task_id))

            # Handle other fields
            for field in ['title', 'body', 'assignee', 'priority', 'tenant']:
                if field in body:
                    conn.execute(f"UPDATE tasks SET {field} = ? WHERE id = ?",
                               (body[field], task_id))

            conn.commit()
            task = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            conn.close()

            return self._send_json(task_to_dict(task))

        return self._send_json({"error": "Not found"}, 404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/')

        if path.startswith('/api/tasks/'):
            task_id = path.split('/api/tasks/')[1]
            params = parse_qs(parsed.query)
            board = params.get('board', ['default'])[0]

            conn = get_db(board)
            conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
            # Also clean up related data
            conn.execute("DELETE FROM task_runs WHERE task_id = ?", (task_id,))
            conn.execute("DELETE FROM task_links WHERE parent_id = ? OR child_id = ?", (task_id, task_id))
            conn.execute("DELETE FROM task_comments WHERE task_id = ?", (task_id,))
            conn.commit()
            conn.close()

            return self._send_json({"deleted": task_id})

        return self._send_json({"error": "Not found"}, 404)


def main():
    port = 9121
    for i, arg in enumerate(sys.argv):
        if arg == '--port' and i + 1 < len(sys.argv):
            port = int(sys.argv[i + 1])

    server = HTTPServer(('0.0.0.0', port), KanbanHandler)
    print(f"Kanban server running on http://127.0.0.1:{port}")
    print(f"Using DB: {KANBAN_DB}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == '__main__':
    main()
