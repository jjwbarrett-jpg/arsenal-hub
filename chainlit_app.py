import os
import json
import re
import asyncio
import base64
import httpx
import chainlit as cl
from chainlit.input_widget import Select

# API and environment configuration
API_BASE = "http://127.0.0.1:9121"

DEFAULT_MODELS = {
    "DeepSeek V4 Pro": {
        "provider": "deepseek",
        "model": "deepseek-chat",
        "url": "https://api.deepseek.com/v1/chat/completions",
        "key_env": "DEEPSEEK_API_KEY",
        "vision": False,
    },
    "Gemini Lite (Free)": {
        "provider": "google",
        "model": "gemini-1.5-flash",
        "url": "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
        "key_env": "GEMINI_API_KEY",
        "vision": True,
    },
    "GLM 4.6 (Z.AI Free)": {
        "provider": "zai",
        "model": "glm-4-flash",
        "url": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        "key_env": "ZAI_API_KEY",
        "vision": False,
    },
}

TOOLS_DEFINITION = [
    {
        "type": "function",
        "function": {
            "name": "add_kanban_card",
            "description": "Creates a card in the Triage column on the Kanban board. Use this when the user explicitly requests to add a task, card, or action item.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "The title of the card (first line/short summary)"},
                    "description": {"type": "string", "description": "The description/body of the card"}
                },
                "required": ["title", "description"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "write_to_clipboard",
            "description": "Writes a note to the shared Clipboard. Use this to save specs, snippets, and other written notes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "The title of the clipboard note"},
                    "body": {"type": "string", "description": "The body content of the note"}
                },
                "required": ["title", "body"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "query_hub_state",
            "description": "Returns current kanban board, tools, blueprints, and active tab — so you know what is happening in the Hub.",
            "parameters": {
                "type": "object",
                "properties": {}
            }
        }
    }
]

# ===== IDENTITY LOADING (SOUL.md) =====
SOUL_PATH = os.path.expanduser("~/.hermes/SOUL.md")
ALT_PATHS = [
    "/mnt/c/Core-User/hermes-vault/Memory/persona/SOUL.md",
    "/home/kael-x/.hermes/SOUL.md",
    r"\\wsl.localhost\Ubuntu\home\kael-x\.hermes\SOUL.md",
    r"C:\Core-User\hermes\documents\SOUL.md",
]

def load_soul():
    for path in [SOUL_PATH] + ALT_PATHS:
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    return f.read().strip()
            except Exception:
                pass
    return "You are Hermes, a professional AI partner."

# ===== MEMORY LOADING (via Hub API) =====
def load_memory_context():
    """Fetch memory context from Hub GET /api/memory/context (proves API pipeline)."""
    try:
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(f"{API_BASE}/api/memory/context")
        if resp.status_code == 200:
            data = resp.json()
            if data.get("status") == "ok":
                return (data.get("context") or "").strip()
    except Exception:
        pass
    return ""

# ===== LOAD API KEYS FROM ENV FILE =====
def load_env_file():
    env_paths = [
        os.path.expanduser("~/.hermes/.env"),
        "/home/kael-x/.hermes/.env",
        r"\\wsl.localhost\Ubuntu\home\kael-x\.hermes\.env",
    ]
    for path in env_paths:
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            v = v.strip().strip("'").strip('"')
                            k = k.strip()
                            os.environ[k] = v
                break
            except Exception:
                pass
                
    # Environment variable fallbacks for aliases
    if "GEMINI_API_KEY" not in os.environ and "GOOGLE_API_KEY" in os.environ:
        os.environ["GEMINI_API_KEY"] = os.environ["GOOGLE_API_KEY"]
    if "ZAI_API_KEY" not in os.environ and "GLM_API_KEY" in os.environ:
        os.environ["ZAI_API_KEY"] = os.environ["GLM_API_KEY"]

# Load env variables at startup
load_env_file()

# ===== AUTO SCRIBE (live session note-taker) =====
SCRIBE_ENABLED = os.getenv("SCRIBE_ENABLED", "true").lower() == "true"
# 1.5-flash retired; pin to flash-lite-latest (cheap classify)
SCRIBE_MODEL = os.getenv("SCRIBE_MODEL", "gemini-flash-lite-latest")
SCRIBE_URL = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{SCRIBE_MODEL}:generateContent"
)
SCRIBE_MIN_CHARS = 12

SCRIBE_PROMPT = """You are a note-taking filter. Analyze this chat message and decide if it contains something worth saving as a note.

Notable: decisions, action items, discoveries, errors/fixes, architecture changes, user preferences, project milestones, new ideas, tool evaluations.

Not notable: greetings, filler, jokes, acknowledgments ("ok", "thanks"), small talk, debugging back-and-forth.

If NOT notable, respond with EXACTLY: {{"notable": false}}
If notable, respond with: {{"notable": true, "subject": "<3-5 word subject>", "summary": "<one sentence summary>", "importance": "low|medium|high"}}

Message: {message}"""


def _scribe_api_key() -> str:
    return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""


def _parse_scribe_json(text: str) -> dict:
    """Extract JSON object from model text (handles optional markdown fences)."""
    cleaned = (text or "").strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    cleaned = cleaned.strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if m:
            return json.loads(m.group(0))
        raise


async def scribe_check(message: str, author: str):
    """Fire-and-forget: classify message, post to Clipboard if notable.

    Never raises — scribe failures must not block chat.
    """
    if not SCRIBE_ENABLED:
        return
    key = _scribe_api_key()
    if not key:
        return
    text = (message or "").strip()
    if len(text) < SCRIBE_MIN_CHARS:
        return
    # Cap payload size so classify stays cheap
    if len(text) > 4000:
        text = text[:4000] + "…"

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{SCRIBE_URL}?key={key}",
                headers={"Content-Type": "application/json"},
                json={
                    "contents": [
                        {"parts": [{"text": SCRIBE_PROMPT.format(message=text)}]}
                    ],
                    "generationConfig": {
                        "temperature": 0.1,
                        "maxOutputTokens": 256,
                    },
                },
            )
            if resp.status_code != 200:
                return

            data = resp.json()
            parts = data["candidates"][0]["content"]["parts"]
            raw = "".join(p.get("text", "") for p in parts)
            result = _parse_scribe_json(raw)
            if not result.get("notable"):
                return

            subject = (result.get("subject") or "Session note").strip()[:80]
            summary = (result.get("summary") or text[:200]).strip()
            importance = result.get("importance", "medium")
            body = f"[{author}] {summary}\n\n(importance: {importance})"

            # Agent bridge — create-panel accepts title/body/source in payload
            await client.post(
                f"{API_BASE}/api/clipboard/agent",
                json={
                    "action": "create-panel",
                    "payload": {
                        "title": subject,
                        "body": body,
                        "source": "scribe",
                        "importance": importance,
                    },
                },
            )
    except Exception:
        pass  # Scribe fails silently — never blocks chat


# ===== MODEL CONFIG LOADING =====
def load_models():
    path = "models.json"
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return DEFAULT_MODELS

# ===== HUB API INTEGRATION =====
async def api_add_kanban_card(title: str, description: str) -> dict:
    url = f"{API_BASE}/api/tasks"
    payload = {
        "title": title.strip(),
        "body": description.strip(),
        "status": "triage",
        "created_by": "arsenal-hub"
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(url, json=payload)
    if resp.status_code in (200, 201):
        return resp.json()
    else:
        raise Exception(f"Failed to add kanban card: {resp.status_code} - {resp.text}")

async def api_write_to_clipboard(title: str, body: str) -> dict:
    url = f"{API_BASE}/api/clipboard/agent"
    payload = {
        "action": "create-panel",
        "payload": {
            "title": title.strip(),
            "body": body.strip()
        }
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(url, json=payload)
    if resp.status_code in (200, 201):
        return resp.json()
    else:
        raise Exception(f"Failed to write to clipboard: {resp.status_code} - {resp.text}")

async def api_query_hub_state() -> dict:
    url = f"{API_BASE}/api/state"
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(url)
    if resp.status_code == 200:
        return resp.json()
    else:
        raise Exception(f"Failed to query Hub state: {resp.status_code} - {resp.text}")

# ===== LLM API CLIENT =====
async def call_model(model_name: str, messages: list, image_info: list = None) -> dict:
    models = load_models()
    if model_name not in models:
        raise ValueError(f"Model {model_name} not found in configuration.")
    
    cfg = models[model_name]
    provider = cfg["provider"]
    url = cfg["url"]
    api_key = os.environ.get(cfg["key_env"], "")
    
    if provider == "google":
        # Google Gemini API REST call format
        google_url = f"{url}?key={api_key}"
        
        contents = []
        system_instruction = None
        
        for msg in messages:
            role = msg["role"]
            content = msg["content"]
            
            if role == "system":
                system_instruction = {
                    "parts": [{"text": content}]
                }
            else:
                gemini_role = "user" if role == "user" else "model"
                parts = [{"text": content}]
                contents.append({
                    "role": gemini_role,
                    "parts": parts
                })
        
        # Inject images into the last user content parts if vision is supported
        if image_info and contents and contents[-1]["role"] == "user":
            for img_data, mime in image_info:
                contents[-1]["parts"].append({
                    "inlineData": {
                        "mimeType": mime,
                        "data": img_data
                    }
                })
        
        payload = {"contents": contents}
        if system_instruction:
            payload["systemInstruction"] = system_instruction
            
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                google_url,
                headers={"Content-Type": "application/json"},
                json=payload
            )
            
        if resp.status_code == 200:
            res_json = resp.json()
            try:
                parts = res_json["candidates"][0]["content"]["parts"]
                text = "".join(part.get("text", "") for part in parts)
                return {"role": "assistant", "content": text}
            except Exception as e:
                return {"role": "assistant", "content": f"Error parsing Gemini response: {str(e)}. Response: {resp.text}"}
        else:
            return {"role": "assistant", "content": f"Gemini API Error: {resp.status_code} - {resp.text}"}
            
    else:
        # OpenAI compatible (deepseek, zai)
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}"
        }
        
        payload = {
            "model": cfg["model"],
            "messages": messages,
            "tools": TOOLS_DEFINITION
        }
        
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                url,
                headers=headers,
                json=payload
            )
            
        if resp.status_code == 200:
            res_json = resp.json()
            try:
                return res_json["choices"][0]["message"]
            except Exception as e:
                return {"role": "assistant", "content": f"Error parsing response: {str(e)}. Response: {resp.text}"}
        else:
            return {"role": "assistant", "content": f"API Error: {resp.status_code} - {resp.text}"}

# ===== UI WIDGET AND HEADER =====
def make_welcome_content(model_name):
    return f"**[Model: {model_name} ▾]** &nbsp;&nbsp;&nbsp;&nbsp; **[[+ New Chat](action:new_chat)]** &nbsp;&nbsp;&nbsp;&nbsp; **[[× Close](action:close_chat)]**"

@cl.on_chat_start
async def start():
    # Load available models
    models = load_models()
    default_model = "DeepSeek V4 Pro"
    
    # Store settings in user session
    cl.user_session.set("selected_model", default_model)
    cl.user_session.set("messages", [])
    
    # Define settings widget
    await cl.ChatSettings([
        Select(
            id="Model",
            label="Model Selection",
            values=list(models.keys()),
            initial_value=default_model
        )
    ]).send()
    
    # Send welcome settings row message
    welcome_content = make_welcome_content(default_model)
    welcome_msg = cl.Message(content=welcome_content)
    await welcome_msg.send()
    cl.user_session.set("welcome_msg_id", welcome_msg.id)

@cl.on_settings_update
async def on_settings_update(settings):
    model_name = settings.get("Model")
    if model_name:
        cl.user_session.set("selected_model", model_name)
        
        # Update the welcome message header
        welcome_msg_id = cl.user_session.get("welcome_msg_id")
        if welcome_msg_id:
            welcome_content = make_welcome_content(model_name)
            welcome_msg = cl.Message(content=welcome_content, id=welcome_msg_id)
            await welcome_msg.update()

# ===== CHAT MESSAGE FLOW =====
@cl.on_message
async def on_message(msg: cl.Message):
    messages = cl.user_session.get("messages", [])
    
    # Initialize session system prompt if empty
    if not messages:
        soul = load_soul()
        memory_ctx = load_memory_context()
        system_content = soul
        if memory_ctx:
            system_content += f"\n\n[MEMORY CONTEXT]\n{memory_ctx}"
        messages.append({"role": "system", "content": system_content})
        
    # Process any attached image files
    image_info = []
    for el in msg.elements:
        if el.mime and el.mime.startswith("image/"):
            try:
                img_bytes = None
                if el.path and os.path.exists(el.path):
                    with open(el.path, "rb") as f:
                        img_bytes = f.read()
                elif el.content:
                    img_bytes = el.content
                
                if img_bytes:
                    base64_str = base64.b64encode(img_bytes).decode("utf-8")
                    image_info.append((base64_str, el.mime))
            except Exception as e:
                print(f"Error loading image: {e}")
                
    # Append the user's text message
    messages.append({"role": "user", "content": msg.content})
    
    selected_model_name = cl.user_session.get("selected_model", "DeepSeek V4 Pro")
    models = load_models()
    model_cfg = models.get(selected_model_name, {})
    
    # Check vision capability & fallback
    if image_info:
        if not model_cfg.get("vision", False):
            # Fallback: Describe the image first using the first vision-capable model
            vision_model_name = None
            for name, cfg in models.items():
                if cfg.get("vision", False):
                    vision_model_name = name
                    break
            
            if vision_model_name:
                desc_status = cl.Message(content=f"⚙️ Describing image using {vision_model_name}...")
                await desc_status.send()
                
                try:
                    fallback_msgs = [
                        {"role": "system", "content": "You are a helpful assistant describing images in detail."},
                        {"role": "user", "content": "Describe this image in detail."}
                    ]
                    desc_res = await call_model(vision_model_name, fallback_msgs, image_info)
                    description = desc_res.get("content", "")
                    await desc_status.remove()
                    
                    # Inject description as system message
                    messages.append({
                        "role": "system",
                        "content": f"User attached an image. Image description: {description}"
                    })
                except Exception as e:
                    await desc_status.remove()
                    await cl.Message(content=f"⚠️ Vision fallback failed: {str(e)}").send()
            else:
                await cl.Message(content="⚠️ Image attached but no vision-capable model available to describe it.").send()
                
    # Trim messages history: system prompt (index 0) + last 39 messages (total 40 max)
    system_prompt = messages[0]
    other_msgs = messages[1:]
    if len(other_msgs) > 39:
        other_msgs = other_msgs[-39:]
    messages = [system_prompt] + other_msgs
    cl.user_session.set("messages", messages)
    
    # Show thinking indicator
    thinking_msg = cl.Message(content="")
    await thinking_msg.send()
    
    # Generation and tool call loop
    max_turns = 5
    turn = 0
    reply = ""
    run_messages = list(messages)
    
    while turn < max_turns:
        turn += 1
        
        # Include image only on the first turn if vision is supported
        current_images = image_info if (turn == 1 and model_cfg.get("vision", False)) else None
        
        try:
            model_response = await call_model(selected_model_name, run_messages, current_images)
        except Exception as e:
            reply = f"Error calling model API: {str(e)}"
            break
            
        if isinstance(model_response, str):
            reply = model_response
            break
            
        # Check for OpenAI tool calls
        tool_calls = model_response.get("tool_calls")
        if not tool_calls:
            reply = model_response.get("content") or ""
            break
            
        # Add assistant message (which holds the tool calls) to run history
        run_messages.append(model_response)
        
        for tc in tool_calls:
            tc_id = tc.get("id")
            func_name = tc.get("function", {}).get("name")
            arguments_str = tc.get("function", {}).get("arguments", "{}")
            
            try:
                args = json.loads(arguments_str)
            except Exception:
                args = {}
                
            tool_result = ""
            try:
                if func_name == "add_kanban_card":
                    res = await api_add_kanban_card(args.get("title", ""), args.get("description", ""))
                    tool_result = f"Success: Kanban card created with ID {res.get('id')}"
                elif func_name == "write_to_clipboard":
                    res = await api_write_to_clipboard(args.get("title", ""), args.get("body", ""))
                    tool_result = f"Success: Note '{args.get('title')}' written to Clipboard"
                elif func_name == "query_hub_state":
                    res = await api_query_hub_state()
                    tool_result = json.dumps(res)
                else:
                    tool_result = f"Error: Unknown tool function '{func_name}'"
            except Exception as e:
                tool_result = f"Error executing tool: {str(e)}"
                
            run_messages.append({
                "role": "tool",
                "tool_call_id": tc_id,
                "name": func_name,
                "content": tool_result
            })
            
    await thinking_msg.remove()
    
    # Save the assistant reply to history
    messages.append({"role": "assistant", "content": reply})
    cl.user_session.set("messages", messages)
    
    # Send the response message with action buttons
    response_msg = cl.Message(content=reply)
    response_msg.actions = [
        cl.Action(name="add_kanban", payload={"content": reply}, label="📌 Create Kanban Task", tooltip="Add as task to kanban board"),
        cl.Action(name="write_clipboard", payload={"content": reply}, label="📋 Write to Clipboard", tooltip="Write this reply to the shared Clipboard")
    ]
    await response_msg.send()

    # Auto Scribe — after turn completes; do not await (never blocks chat)
    if SCRIBE_ENABLED and msg.content:
        author = "user" if getattr(msg, "author", "User") in (None, "User", "user") else "agent"
        asyncio.create_task(scribe_check(msg.content, author))
        if reply:
            asyncio.create_task(scribe_check(reply, "agent"))

# ===== ACTION CALLBACKS =====
@cl.action_callback("new_chat")
async def on_new_chat(action: cl.Action):
    # Reset messages list
    soul = load_soul()
    memory_ctx = load_memory_context()
    system_content = soul
    if memory_ctx:
        system_content += f"\n\n[MEMORY CONTEXT]\n{memory_ctx}"
    
    cl.user_session.set("messages", [{"role": "system", "content": system_content}])
    await cl.Message(content="🔄 Chat history reset. System prompt (SOUL + memory context) loaded.").send()

@cl.action_callback("close_chat")
async def on_close_chat(action: cl.Action):
    # Call window message to parent window
    await cl.send_window_message({"action": "close"})
    await cl.Message(content="❌ Chat closed. You can close this slideout panel.").send()

@cl.action_callback("add_kanban")
async def on_add_kanban(action: cl.Action):
    text = action.payload.get("content", "")
    lines = text.strip().split("\n")
    title = lines[0][:100] if lines else "Task from Chat"
    description = "\n".join(lines[1:]) if len(lines) > 1 else ""
    try:
        res = await api_add_kanban_card(title, description)
        task_id = res.get("id", "unknown")
        await cl.Message(content=f"📌 Task created on Kanban board (Triage) with ID **{task_id}**: **{title}**").send()
    except Exception as e:
        await cl.Message(content=f"❌ Failed to create Kanban task: {str(e)}").send()

@cl.action_callback("write_clipboard")
async def on_write_clipboard(action: cl.Action):
    text = action.payload.get("content", "")
    lines = text.strip().split("\n")
    title = lines[0][:50] if lines else "Note from Chat"
    try:
        await api_write_to_clipboard(title, text)
        await cl.Message(content=f"📋 Note saved to Clipboard: **{title}**").send()
    except Exception as e:
        await cl.Message(content=f"❌ Failed to write to Clipboard: {str(e)}").send()
