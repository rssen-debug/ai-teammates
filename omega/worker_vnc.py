"""Opt-in VNC worker for a SEPARATE VM desktop, never the host desktop.

This client does not create a VM, expose VNC to the Internet, or claim that a
VNC connection is isolated by itself. The owner must provision a guest OS and
a VNC server, then tunnel it to localhost (recommended) or a private address.
When enabled, normal host screen, browser and desktop tools fail closed.
"""
from __future__ import annotations

import hashlib
from contextlib import contextmanager
import ipaddress
import os
import re
import time
from pathlib import Path

TARGET_RE = re.compile(r"^([a-zA-Z0-9.:-]+)::([0-9]{2,5})$")


def validate_target(value: str) -> str:
    """Accept numeric loopback/private VM IP and explicit TCP port, not URLs."""
    match = TARGET_RE.fullmatch(value.strip())
    if not match:
        raise ValueError("Ange IP::PORT, t.ex. 127.0.0.1::5901 (SSH-tunnel till VM).")
    host, port_string = match.groups()
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        raise ValueError("Ange en numerisk IP-adress, inte ett värdnamn.") from exc
    if not (address.is_loopback or address.is_private) or address.is_multicast or address.is_unspecified:
        raise ValueError("Endast lokala/privata VM-adresser tillåts.")
    port = int(port_string)
    if not 1 <= port <= 65535:
        raise ValueError("Ogiltig TCP-port.")
    return f"{address}::{port}"


class Worker:
    def __init__(self, app):
        self.app = app

    @property
    def enabled(self):
        return bool(self.app.settings.get("worker_vnc_enabled", False))

    @property
    def target(self):
        return str(self.app.settings.get("worker_vnc_target", "") or "")

    def ready(self):
        if not self.enabled:
            return False, "Isolerat läge är avstängt. Använd /worker enable --vm."
        try:
            validate_target(self.target)
        except ValueError as exc:
            return False, str(exc)
        if not self.app.vault.get("worker_vnc_password"):
            return False, "VNC-lösenord saknas. Använd /worker password."
        try:
            from vncdotool import api  # noqa: F401
        except ImportError:
            return False, "Paket saknas: pip install vncdotool Pillow"
        return True, ""

    def connect(self):
        ok, why = self.ready()
        if not ok:
            raise RuntimeError(why)
        from vncdotool import api
        return api.connect(self.target,
                           password=self.app.vault.get("worker_vnc_password"))

    @contextmanager
    def session(self):
        # vncdotool clients expose disconnect() rather than a guaranteed
        # context-manager protocol. Always close even after screenshot errors.
        client = self.connect()
        try:
            yield client
        finally:
            client.disconnect()

    def capture(self):
        with self.session() as client:
            path = self.app.vault.get("worker_vnc_capture_dir")
            directory = Path(path) if path else Path(self.app.store.path).parent / "shots"
            directory.mkdir(parents=True, exist_ok=True)
            name = "vm-screen-" + str(int(time.time() * 1000)) + ".png"
            dest = directory / name
            client.captureScreen(str(dest))
        fingerprint = hashlib.sha256(dest.read_bytes()).hexdigest()[:16]
        return {"image_path": str(dest), "sha256_prefix": fingerprint,
                "source": "separate-VNC-session", "host_desktop": False}

    def click(self, x, y, button):
        if not (0 <= x <= 10000 and 0 <= y <= 10000):
            raise ValueError("Koordinater utanför förväntad skärmyta.")
        if button not in (1, 2, 3):
            raise ValueError("Ogiltig musknapp.")
        with self.session() as client:
            client.mouseMove(x, y)
            client.mousePress(button)
        return {"clicked": [x, y], "button": button, "desktop": "VM"}

    def key(self, key):
        if not re.fullmatch(r"[a-zA-Z0-9+_-]{1,48}", key):
            raise ValueError("Ogiltig VNC-tangent.")
        with self.session() as client:
            client.keyPress(key)
        return {"key_sent": key, "desktop": "VM"}

    def type(self, value):
        if not value or len(value) > 2500:
            raise ValueError("Skriv 1–2500 tecken.")
        if "\n" in value or "\r" in value:
            raise ValueError("Radbrytningar får inte automatiskt skicka formulär. Använd vnc_key separat.")
        with self.session() as client:
            client.type(value)
        return {"typed_chars": len(value), "desktop": "VM", "submitted": False}


def install(buddy):
    Buddy = buddy.Buddy
    original_init = Buddy.__init__
    original_command = Buddy.command
    original_submit = Buddy.submit
    original_execute = buddy.Executor.execute

    def init(self, headless=False):
        original_init(self, headless=headless)
        worker = Worker(self)
        self.vnc_worker = worker

        def available():
            return worker.ready()

        self.registry.register(buddy.ToolSpec(
            name="vnc_capture", category="isolated", risk=buddy.Risk.OBSERVE,
            observes=True, available=available, timeout=40,
            description="Capture the separate VM screen via VNC. Never captures the owner's host desktop.",
            parameters=buddy.schema_obj(),
            handler=lambda a, c: worker.capture(),
        ))
        self.registry.register(buddy.ToolSpec(
            name="vnc_click", category="isolated", risk=buddy.Risk.INPUT,
            effect=True, available=available, timeout=40,
            description="Click coordinates in the separate VM; verify using vnc_capture afterward.",
            parameters=buddy.schema_obj({"x": {"type": "integer"},
                                          "y": {"type": "integer"},
                                          "button": {"type": "integer", "enum": [1, 2, 3]}},
                                         ["x", "y"]),
            handler=lambda a, c: worker.click(a["x"], a["y"], a.get("button", 1)),
        ))
        self.registry.register(buddy.ToolSpec(
            name="vnc_key", category="isolated", risk=buddy.Risk.INPUT,
            effect=True, available=available, timeout=40,
            description="Press a single named key only inside the separate VM.",
            parameters=buddy.schema_obj({"key": {"type": "string"}}, ["key"]),
            handler=lambda a, c: worker.key(a["key"]),
        ))
        self.registry.register(buddy.ToolSpec(
            name="vnc_type", category="isolated", risk=buddy.Risk.INPUT,
            effect=True, available=available, timeout=40,
            description="Type text in the separate VM; never presses Enter or submits automatically.",
            parameters=buddy.schema_obj({"text": {"type": "string"}}, ["text"]),
            handler=lambda a, c: worker.type(a["text"]),
        ))

    async def execute(self, spec, args, ctx):
        if (self.app.settings.get("worker_vnc_enabled", False)
                and spec.category in ("desktop", "screen", "browser")
                and spec.name not in ("tool_search",)):
            return buddy.ToolResult(tool=spec.name, ok=False, category="permission_denied",
                error="Isolerat VM-läge är aktivt. Lokalt skrivbord och lokal webbläsare är spärrade.",
                hint="Använd vnc_capture/vnc_click/vnc_type/vnc_key mot separat VM, eller /worker disable.")
        return await original_execute(self, spec, args, ctx)

    async def command(self, line):
        parts = line.strip().split()
        if not parts or parts[0].lower() != "/worker":
            return await original_command(self, line)
        action = parts[1].lower() if len(parts) > 1 else "status"
        if action == "status":
            worker = self.vnc_worker
            ready, why = worker.ready()
            self.out("ISOLATED VNC WORKER\n" +
                     f"  Mode: {'ON' if worker.enabled else 'OFF'}\n" +
                     f"  Target: {worker.target or '(none)'}\n" +
                     f"  Ready: {ready}\n" +
                     (f"  Reason: {why}\n" if why else "") +
                     "  IMPORTANT: VNC must point to a separate VM, not your active Windows desktop.")
        elif action == "target":
            if len(parts) != 3:
                self.out("Använd /worker target 127.0.0.1::5901 (tunnel till din VM).")
            else:
                try:
                    target = validate_target(parts[2])
                except ValueError as exc:
                    self.out(str(exc))
                else:
                    self.settings.set("worker_vnc_target", target)
                    self.out("VM endpoint inställd: " + target)
        elif action == "password":
            self._worker_vnc_password_pending = True
            self.out("Klistra in VM-lösenordet i nästa rad. Det sparas i DPAPI och döljs i chatthistoriken.")
        elif action == "enable":
            if "--vm" not in parts:
                self.out("Använd /worker enable --vm ENDAST om VNC-adressen går till en separat VM.")
            elif not self.vnc_worker.target:
                self.out("Ange /worker target IP::PORT först.")
            else:
                self.settings.set("worker_vnc_enabled", True)
                self.out("VM-arbetsläge aktiverat. Värddatorns desktop/browser-verktyg är spärrade.")
        elif action == "disable":
            self.settings.set("worker_vnc_enabled", False)
            self.out("VM-arbetsläge avstängt.")
        elif action == "capture":
            try:
                result = await __import__("asyncio").to_thread(self.vnc_worker.capture)
                self.out("VM-skärmbild: " + result["image_path"])
            except Exception as exc:
                self.out("VNC ej tillgänglig: " + type(exc).__name__ + ": " + str(exc)[:140])
        else:
            self.out("Kommandon: /worker status | target IP::PORT | password | enable --vm | disable | capture")

    async def submit(self, text, source="text", lang=None):
        if getattr(self, "_worker_vnc_password_pending", False) and source == "text":
            self._worker_vnc_password_pending = False
            if text.strip() not in ("", "/cancel"):
                self.vault.set("worker_vnc_password", text.strip())
                self.out("VNC-lösenord sparat krypterat.")
            else:
                self.out("Avbrutet.")
            self.ui.prompt()
            return
        return await original_submit(self, text, source, lang)

    Buddy.__init__ = init
    Buddy.command = command
    Buddy.submit = submit
    buddy.Executor.execute = execute
    Buddy.HELP += ("\n/models [1|2|3]  /api [openrouter|go]  /testapi "
                   " /worker [status|target|password|enable --vm|disable|capture]")
