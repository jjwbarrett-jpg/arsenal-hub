"""
Arsenal Hub — Flask backend (v1 frame)
Serves static files (index.html + data.js + hub.css + app.js) + proxies chat.
Requires: pip install flask requests pyyaml
For pure static testing: python -m http.server
"""
import json
import os
import requests
from flask import Flask, request, jsonify, send_from_directory

app = Flask(__name__, static_folder=".", static_url_path="")

# Hermes API server config
HERMES_API = "http://localhost:8642"

def _load_api_key():
    """Load API key from env or ~/.hermes/.env."""
    key = os.environ.get("API_SERVER_KEY")
    if key and len(key) >= 16:
        return key
    env_path = os.path.expanduser("~/.hermes/.env")
    try:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("API_SERVER_KEY="):
                    val = line.split("=", 1)[1].strip().strip("'").strip('"')
                    if len(val) >= 16:
                        return val
    except Exception:
        pass
    raise RuntimeError("API_SERVER_KEY not found or too short. Set in ~/.hermes/.env")

API_KEY = _load_api_key()
HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
}

# Conversation name for persistent session
CONVERSATION = "arsenal-hub"


@app.route("/")
def index():
    return send_from_directory(".", "index.html")


# ===== KANBAN PROXY (passthrough to kanban_server :9121) =====
# Must be BEFORE the catch-all static route to match (/api/* beats <path:path>).

KANBAN_UPSTREAM = "http://127.0.0.1:9121"


def _proxy_kanban(path=""):
    """Forward a request to the kanban server; return its response."""
    url = f"{KANBAN_UPSTREAM}{path}"
    try:
        if request.is_json:
            r = requests.request(
                method=request.method, url=url,
                json=request.get_json(), timeout=10,
            )
        else:
            r = requests.request(
                method=request.method, url=url,
                data=request.get_data(), timeout=10,
            )
        excluded = ("Transfer-Encoding", "Connection", "Content-Encoding",
                    "Content-Length")
        headers = [(k, v) for k, v in r.raw.headers.items() if k.lower() not in excluded]
        return r.content, r.status_code, headers
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "kanban server not running on :9121"}), 502


@app.route("/api/tasks", methods=["GET", "POST"])
@app.route("/api/tasks/<path:subpath>", methods=["GET", "PATCH", "DELETE", "OPTIONS"])
def kanban_tasks(subpath=None):
    path = "/api/tasks"
    if subpath:
        path += "/" + subpath
    return _proxy_kanban(path)


@app.route("/api/boards", methods=["GET", "POST"])
@app.route("/api/boards/<path:subpath>", methods=["GET", "DELETE", "OPTIONS"])
def kanban_boards(subpath=None):
    path = "/api/boards"
    if subpath:
        path += "/" + subpath
    return _proxy_kanban(path)


@app.route("/api/state", methods=["GET"])
def kanban_state():
    return _proxy_kanban("/api/state")


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(".", path)


@app.route("/api/completions", methods=["POST"])
def completions():
    """Proxy chat completions to Hermes gateway for decomposition engine."""
    data = request.get_json()
    if not data or "messages" not in data:
        return jsonify({"error": "Missing 'messages' field"}), 400

    messages = data["messages"]
    model = data.get("model", "deepseek-v4-pro")

    if not isinstance(messages, list) or not messages:
        return jsonify({"error": "messages must be a non-empty array"}), 400

    try:
        resp = requests.post(
            f"{HERMES_API}/v1/chat/completions",
            headers=HEADERS,
            json={"model": model, "messages": messages},
            timeout=120,
        )
        resp.raise_for_status()
        result = resp.json()
        content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        return jsonify({"content": content, "model": model})
    except requests.exceptions.RequestException as e:
        return jsonify({"error": f"Hermes API error: {str(e)}"}), 502


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json()
    if not data or "message" not in data:
        return jsonify({"error": "Missing 'message' field"}), 400

    message = data["message"].strip()
    if not message:
        return jsonify({"error": "Empty message"}), 400

    try:
        # Use the Responses API for persistent conversation
        resp = requests.post(
            f"{HERMES_API}/v1/responses",
            headers=HEADERS,
            json={
                "model": "hermes-agent",
                "input": message,
                "conversation": CONVERSATION,
                "instructions": "You are Hermes, the user's primary AI agent and strategic partner. You are embedded in the Arsenal Hub — the user's command center for orchestrating AI tools and resources. Keep responses concise and actionable.",
                "store": True,
            },
            timeout=120,
        )
        resp.raise_for_status()
        result = resp.json()

        # Extract the assistant's text from the response
        output_text = ""
        for item in result.get("output", []):
            if item.get("type") == "message" and item.get("role") == "assistant":
                for content in item.get("content", []):
                    if content.get("type") == "output_text":
                        output_text += content.get("text", "")

        return jsonify({"response": output_text or "No response text received."})

    except requests.exceptions.RequestException as e:
        return jsonify({"error": f"Hermes API error: {str(e)}"}), 502


@app.route("/api/health")
def health():
    try:
        h = requests.get(f"{HERMES_API}/health", timeout=5)
        return jsonify({"hermes": h.json(), "hub": "ok"})
    except Exception:
        return jsonify({"hermes": "unreachable", "hub": "ok"})


# ===== TOOL / CONFIG ENDPOINTS =====

@app.route("/api/tools")
def tools():
    """Return live tool/agent status data."""
    tools = {
        "agents": [],
        "infrastructure": [],
        "mcp_servers": [],
    }

    # Read MCP servers from config
    import yaml
    config_path = os.path.expanduser("~/.hermes/config.yaml")
    try:
        with open(config_path) as f:
            config = yaml.safe_load(f)
    except Exception:
        config = {}

    # MCP servers
    mcp = config.get("mcp_servers", {})
    for name, cfg in mcp.items():
        tools["mcp_servers"].append({
            "name": name,
            "transport": "http" if "url" in cfg else "stdio",
            "url": cfg.get("url", ""),
            "auth": cfg.get("auth", "none"),
        })

    # Current model
    tools["current_model"] = config.get("model", {}).get("default", "unknown")
    tools["current_provider"] = config.get("model", {}).get("provider", "unknown")

    # Check Hermes API for active sessions
    try:
        r = requests.get(f"{HERMES_API}/api/sessions", headers=HEADERS, timeout=5)
        if r.ok:
            sessions = r.json()
            tools["active_sessions"] = len(sessions) if isinstance(sessions, list) else 0
        else:
            tools["active_sessions"] = "unknown"
    except Exception:
        tools["active_sessions"] = "unreachable"

    return jsonify(tools)


@app.route("/api/config")
def config_summary():
    """Return a safe summary of the Hermes config."""
    import yaml
    config_path = os.path.expanduser("~/.hermes/config.yaml")
    try:
        with open(config_path) as f:
            config = yaml.safe_load(f)
    except Exception:
        return jsonify({"error": "Cannot read config"}), 500

    safe = {
        "model": config.get("model", {}).get("default", "unknown"),
        "provider": config.get("model", {}).get("provider", "unknown"),
        "mcp_servers": list(config.get("mcp_servers", {}).keys()),
        "skills_count": _count_files(os.path.expanduser("~/.hermes/skills")),
        "cron_jobs": _count_cron_jobs(),
    }
    return jsonify(safe)


def _count_files(path):
    """Count files recursively."""
    try:
        count = 0
        for root, dirs, files in os.walk(path):
            count += len([f for f in files if f.endswith(".md")])
        return count
    except Exception:
        return 0


def _count_cron_jobs():
    """Count active cron jobs."""
    try:
        import subprocess
        result = subprocess.run(
            ["hermes", "cron", "list"],
            capture_output=True, text=True, timeout=10
        )
        return result.stdout.count("enabled")
    except Exception:
        return 0


# ===== BLUEPRINT ENDPOINTS =====

BLUEPRINTS_DIR = os.path.join(os.path.dirname(__file__), "blueprints")


@app.route("/api/blueprints", methods=["GET", "POST"])
def blueprints():
    if request.method == "GET":
        bps = []
        try:
            for fname in sorted(os.listdir(BLUEPRINTS_DIR)):
                if fname.endswith(".json"):
                    fpath = os.path.join(BLUEPRINTS_DIR, fname)
                    with open(fpath) as f:
                        bp = json.load(f)
                    bp["filename"] = fname
                    bps.append(bp)
        except FileNotFoundError:
            pass
        return jsonify(bps)

    elif request.method == "POST":
        data = request.get_json()
        if not data or "name" not in data:
            return jsonify({"error": "Blueprint requires a name"}), 400

        name = data["name"].strip().replace(" ", "_").lower()
        safe_name = "".join(c for c in name if c.isalnum() or c in "_-")
        fname = f"{safe_name}.json"
        fpath = os.path.join(BLUEPRINTS_DIR, fname)

        blueprint = {
            "name": data.get("name", "Untitled"),
            "description": data.get("description", ""),
            "target_agent": data.get("target_agent", "any"),
            "created": data.get("created", ""),
            "status": data.get("status", "draft"),
            "core_payload": data.get("core_payload", ""),
            "foundation": data.get("foundation", []),
            "enhancements": data.get("enhancements", []),
            "polish": data.get("polish", []),
            "edge_cases": data.get("edge_cases", []),
        }

        with open(fpath, "w") as f:
            json.dump(blueprint, f, indent=2)

        return jsonify({"saved": fname, "blueprint": blueprint}), 201


@app.route("/api/blueprints/<filename>", methods=["DELETE"])
def delete_blueprint(filename):
    fpath = os.path.join(BLUEPRINTS_DIR, filename)
    if os.path.exists(fpath):
        os.remove(fpath)
        return jsonify({"deleted": filename})
    return jsonify({"error": "Not found"}), 404


@app.route("/api/health-check")
def health_check():
    """Check real API reachability for tracking."""
    import concurrent.futures

    checks = {
        "DeepSeek API": "https://api.deepseek.com/v1/models",
        "OpenRouter": "https://openrouter.ai/api/v1/models",
        "Hermes Gateway": f"{HERMES_API}/health",
        "GitHub MCP": "https://api.github.com",
    }

    results = {}
    def check_one(name, url):
        try:
            hdrs = {}
            if "openrouter" in name.lower():
                hdrs["Authorization"] = f"Bearer {API_KEY}"
            r = requests.get(url, headers=hdrs, timeout=5)
            results[name] = "up" if r.status_code < 500 else "degraded"
        except Exception:
            results[name] = "down"

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        futures = [ex.submit(check_one, name, url) for name, url in checks.items()]
        for f in concurrent.futures.as_completed(futures):
            pass  # results collected in check_one

    return jsonify(results)


if __name__ == "__main__":
    print("Arsenal Hub (v1) starting on http://localhost:5000")
    app.run(host="0.0.0.0", port=5000, debug=False)
