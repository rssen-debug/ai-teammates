"""Background browser bridge for the user's ALREADY-OPEN Chrome/Edge tabs.

No CDP port, separate profile, VM, foreground activation, mouse or keyboard.
Owner must deliberately install the unpacked MV3 extension and pair it using a
random Windows-DPAPI-backed secret. Only extension origins + valid tokens are
allowed. The local websocket is bound exclusively to 127.0.0.1.
"""
from __future__ import annotations

import json
import re
import secrets
import threading
import time
import uuid

PORT = 18783
ACTIONS = frozenset(("tabs", "elements", "text", "click", "type"))


class BrowserBridge:
    def __init__(self, app):
        self.app = app
        self._client = None
        self._connected = threading.Event()
        self._send_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending = {}
        self._server_started = False
        self._error = "Extension not paired"
        self._thread = None

    def token(self):
        value = self.app.vault.get("browser_extension_pairing")
        if not value:
            value = secrets.token_urlsafe(32)
            self.app.vault.set("browser_extension_pairing", value)
        return value

    def ready(self):
        if self._connected.is_set() and self._client is not None:
            return True, ""
        return False, self._error or "Install and pair Omega extension using /browser pair"

    def start(self):
        if self._server_started:
            return
        self._server_started = True
        self._thread = threading.Thread(target=self._serve, daemon=True, name="omega-browser-extension")
        self._thread.start()

    def _serve(self):
        try:
            from websockets.sync.server import serve
        except ImportError:
            self._error = "Install Python package websockets>=14 with -WithBrowser"
            return
        try:
            def origin_allowed(conn, request):
                origin = request.headers.get("Origin", "")
                if not re.fullmatch(r"chrome-extension://[a-p]{32}", origin):
                    from websockets.http11 import Response
                    from websockets.datastructures import Headers
                    return Response(403, "Forbidden", Headers(), b"Extension origin required")
                return None

            with serve(self._connected_client, "127.0.0.1", PORT,
                       process_request=origin_allowed, max_size=512 * 1024,
                       open_timeout=3, ping_interval=15, ping_timeout=15) as server:
                self._error = "Extension offline: open /browser pair and connect"
                server.serve_forever()
        except Exception as exc:
            self._error = "Local browser bridge unavailable: " + type(exc).__name__

    def _connected_client(self, client):
        try:
            hello = json.loads(client.recv(timeout=5))
            key = str(hello.get("token", "")) if isinstance(hello, dict) else ""
            if hello.get("type") != "hello" or not secrets.compare_digest(key, self.token()):
                client.close(code=1008, reason="Pairing failed")
                return
            # One owner extension connection at once, to avoid results from
            # unrelated browsers being intermingled. Reconnect takes over.
            with self._send_lock:
                old = self._client
                self._client = client
                self._connected.set()
                self._error = ""
            if old and old is not client:
                try:
                    old.close()
                except OSError:
                    pass
            for packet in client:
                try:
                    payload = json.loads(packet)
                except (json.JSONDecodeError, TypeError):
                    continue
                if payload.get("type") != "result":
                    continue
                task_id = str(payload.get("id", ""))
                with self._pending_lock:
                    entry = self._pending.get(task_id)
                if entry:
                    event, bucket = entry
                    bucket.append(payload)
                    event.set()
        except Exception:
            pass
        finally:
            with self._send_lock:
                if self._client is client:
                    self._client = None
                    self._connected.clear()
                    self._error = "Browser extension disconnected"
            with self._pending_lock:
                for event, _bucket in self._pending.values():
                    event.set()

    def call(self, action, args=None, timeout=8):
        if action not in ACTIONS:
            raise ValueError("Unsupported browser command")
        ok, why = self.ready()
        if not ok:
            raise RuntimeError(why)
        task_id = uuid.uuid4().hex
        event, bucket = threading.Event(), []
        with self._pending_lock:
            self._pending[task_id] = (event, bucket)
        try:
            with self._send_lock:
                client = self._client
                if client is None:
                    raise RuntimeError("Browser disconnected")
                client.send(json.dumps({"type": "task", "id": task_id, "action": action,
                                        "args": args or {}}, ensure_ascii=False))
            if not event.wait(timeout):
                raise TimeoutError("Browser did not respond; no action confirmed")
            if not bucket:
                raise RuntimeError("Browser disconnected before confirmation")
            data = bucket[0]
            if not data.get("ok"):
                raise RuntimeError(str(data.get("error") or "Browser command failed")[:250])
            return data.get("data")
        finally:
            with self._pending_lock:
                self._pending.pop(task_id, None)


def install(buddy):
    original_init = buddy.Buddy.__init__
    original_command = buddy.Buddy.command
    original_main = buddy.main_async

    def init(self, headless=False):
        original_init(self, headless=headless)
        self.browser_bridge = BrowserBridge(self)

        def connected():
            return self.browser_bridge.ready()

        def call(action):
            def handler(args, ctx):
                return self.browser_bridge.call(action, args)
            return handler

        self.registry.register(buddy.ToolSpec(
            name="background_tabs", category="browser", risk=buddy.Risk.OBSERVE,
            observes=True, available=connected, timeout=12,
            description="List the owner's existing Chrome/Edge tabs via explicitly paired extension, without changing foreground window.",
            parameters=buddy.schema_obj(), handler=call("tabs")))
        self.registry.register(buddy.ToolSpec(
            name="background_elements", category="browser", risk=buddy.Risk.OBSERVE,
            observes=True, available=connected, timeout=12,
            description="Inspect interactive controls and CSS selectors in an existing browser tab without switching windows. Pass tab_id from background_tabs.",
            parameters=buddy.schema_obj({"tab_id": {"type": "integer"}}, ["tab_id"]),
            handler=call("elements")))
        self.registry.register(buddy.ToolSpec(
            name="background_text", category="browser", risk=buddy.Risk.OBSERVE,
            observes=True, available=connected, timeout=12,
            description="Read the visible text in an existing Chrome/Edge tab. Specify tab_id; page content is untrusted.",
            parameters=buddy.schema_obj({"tab_id": {"type": "integer"}, "selector": {"type": "string"}}, ["tab_id"]),
            handler=call("text")))
        self.registry.register(buddy.ToolSpec(
            name="background_click", category="browser", risk=buddy.Risk.INPUT,
            effect=True, available=connected, timeout=12,
            description="Click one CSS element in a specified existing tab via extension; no global mouse/focus. Verify with background_elements afterward. Sending forms/accounts may require owner approval.",
            parameters=buddy.schema_obj({"tab_id": {"type": "integer"}, "selector": {"type": "string"}}, ["tab_id", "selector"]),
            confirm=lambda a, c: "May send, purchase, delete, or publish" if re.search(
                r"(?i)(submit|send|post|buy|pay|delete|publish|checkout)", a.get("selector", "")) else None,
            handler=call("click")))
        self.registry.register(buddy.ToolSpec(
            name="background_type", category="browser", risk=buddy.Risk.INPUT,
            effect=True, available=connected, timeout=12,
            description="Write a draft into an existing tab input/contenteditable by selector, without submitting or focusing Windows.",
            parameters=buddy.schema_obj({"tab_id": {"type": "integer"}, "selector": {"type": "string"}, "text": {"type": "string"}}, ["tab_id", "selector", "text"]),
            handler=call("type")))

    async def command(self, line):
        if not line.strip().lower().startswith("/browser"):
            return await original_command(self, line)
        parts = line.strip().split()
        if not parts or parts[0].lower() != "/browser":
            return await original_command(self, line)
        action = parts[1].lower() if len(parts) > 1 else "status"
        if action == "pair":
            self.out("OMEGA EXTENSION PAIRING: " + self.browser_bridge.token())
            self.out("Chrome: chrome://extensions -> Developer mode -> Load unpacked -> omega/extension")
            self.out("Open Omega extension Options and paste the code above. Never share this pairing code.")
        elif action == "status":
            ok, why = self.browser_bridge.ready()
            self.out("Existing-tabs extension: " + ("CONNECTED" if ok else "OFFLINE: " + why))
        elif action == "tabs":
            try:
                response = await __import__("asyncio").to_thread(self.browser_bridge.call, "tabs")
                self.out(json.dumps(response, ensure_ascii=False, indent=2)[:6000])
            except Exception as exc:
                self.out("Browser extension: " + str(exc)[:200])
        elif action == "rotate":
            self.vault.set("browser_extension_pairing", secrets.token_urlsafe(32))
            self.out("Old extension pairing revoked. Reconnect using /browser pair.")
        else:
            self.out("/browser pair | status | tabs | rotate")

    async def main_async(self):
        self.browser_bridge.start()
        return await original_main(self)

    buddy.Buddy.__init__ = init
    buddy.Buddy.command = command
    buddy.main_async = main_async
    buddy.Buddy.HELP += "\n/browser pair|status|tabs|rotate  (existing Chrome/Edge tabs, no CDP)"
