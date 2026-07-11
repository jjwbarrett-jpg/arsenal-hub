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
import threading
from pathlib import Path
try:
    import yaml as _yaml
    _YAML_OK = True
except ImportError:
    _yaml = None
    _YAML_OK = False
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, urlopen
from urllib.error import URLError

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

# --- Skills directory ---
SKILLS_DIR = os.path.expanduser("~/.hermes/skills")

# --- Harvest watcher (TUI session harvests → Clipboard Proposed cards) ---
# Windows native path preferred; WSL fallback when running under Linux.
if os.name == "nt" or Path(r"C:\Core-User\mailbox").exists():
    HARVEST_DIR = Path(r"C:\Core-User\mailbox\harvests")
else:
    HARVEST_DIR = Path("/mnt/c/Core-User/mailbox/harvests")
HARVEST_POLL_SECONDS = 60
HARVEST_CLIPBOARD_URL = "http://127.0.0.1:9121/api/clipboard/agent"


def process_harvest_file(filepath: Path):
    """Parse a harvest markdown file and POST items to Clipboard as Proposed cards.

    Only renames to .md.done when every item POSTs successfully (or there are no
    items). Malformed files and Clipboard outages leave the file for retry.
    """
    try:
        content = filepath.read_text(encoding="utf-8")
        items = []
        current_section = None
        for line in content.splitlines():
            line = line.strip()
            if line.startswith("## "):
                current_section = line[3:].strip()
            elif line.startswith("- ") and current_section:
                item_text = line[2:].strip()
                if item_text:  # empty bullets skipped
                    items.append({"section": current_section, "text": item_text})

        # Empty sections / no bullets: nothing to post — mark done so we don't loop forever
        any_failed = False
        for item in items:
            try:
                body = json.dumps({
                    "action": "create-panel",
                    "payload": {
                        "title": f"{item['section']}: {item['text'][:60]}",
                        "body": item["text"],
                        "source": "scribe-tui",
                    },
                }).encode("utf-8")
                req = Request(
                    HARVEST_CLIPBOARD_URL,
                    data=body,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urlopen(req, timeout=5) as resp:
                    if getattr(resp, "status", 200) >= 400:
                        any_failed = True
                    else:
                        resp.read()
            except (URLError, OSError, TimeoutError, json.JSONDecodeError, ValueError):
                any_failed = True  # Clipboard down / bad response — retry next cycle

        # Only rename when all POSTs succeeded (or zero items)
        if not any_failed:
            filepath.rename(filepath.with_suffix(".md.done"))
    except Exception:
        pass  # malformed / unreadable — leave file, retry next cycle


def harvest_watcher_loop():
    """Background thread: poll harvests folder, process new .md files."""
    HARVEST_DIR.mkdir(parents=True, exist_ok=True)
    while True:
        try:
            for f in sorted(HARVEST_DIR.glob("*.md")):
                process_harvest_file(f)
        except Exception:
            pass
        time.sleep(HARVEST_POLL_SECONDS)

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
                # source: agent default; harvest watcher uses "scribe-tui"
                src = payload.get('source') or body.get('source') or 'agent'
                new_panel = {
                    "id": f"panel-{int(time.time())}-{bid}",
                    "title": payload.get('title', 'Untitled Panel'),
                    "type": "notes",
                    "source": src,
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

    # Background: auto-ingest TUI session harvests into Clipboard
    t = threading.Thread(target=harvest_watcher_loop, name="harvest-watcher", daemon=True)
    t.start()
    print(f"Harvest watcher polling {HARVEST_DIR} every {HARVEST_POLL_SECONDS}s")

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
