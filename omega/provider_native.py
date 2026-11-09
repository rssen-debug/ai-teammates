"""Native provider support for Studdy Buddy Omega.

Installed by buddy.py at startup. This module never stores keys in Git or
environment files; the existing Windows DPAPI Vault holds them locally.
"""
from __future__ import annotations

import asyncio
import os
import uuid
import urllib.request

PROVIDERS = {
    "OpenRouter": {
        "endpoint": "https://openrouter.ai/api/v1",
        "model": "deepseek/deepseek-v4.1-flash-1017",
        "vault": "openrouter_api_key",
        "env": "OPENROUTER_API_KEY",
    },
    "OpenCode Go": {
        "endpoint": "https://opencode.ai/inference/go/openai/v1",
        "model": "deepseek-v4.1-flash",
        "vault": "opencode_go_api_key",
        "env": "OPENCODE_GO_API_KEY",
    },
}

GO_PREFIX = "https://opencode.ai/inference/go/"
SESSION_ID = "ses_" + uuid.uuid4().hex


def install(buddy):
    """Patch only the provider routing and slash UI of the running Buddy module."""
    Gateway, Router, Buddy = buddy.Gateway, buddy.Router, buddy.Buddy
    original_gateway_init = Gateway.__init__
    original_gateway_key = Gateway.key
    original_router_resolve = Router.resolve
    original_router_ladder = Router.ladder
    original_command = Buddy.command
    original_submit = Buddy.submit
    original_request = urllib.request.Request

    def provider_from_vault(vault):
        selected = vault.get("omega_active_provider")
        if selected in PROVIDERS or selected == "Kilo":
            return selected
        if os.environ.get("OPENROUTER_API_KEY") or vault.get("openrouter_api_key"):
            return "OpenRouter"
        if os.environ.get("OPENCODE_GO_API_KEY") or vault.get("opencode_go_api_key"):
            return "OpenCode Go"
        if os.environ.get("KILO_API_KEY") or vault.get("kilo_api_key"):
            return "Kilo"
        return "OpenRouter"  # key can be entered AFTER starting the app

    def gateway_init(self, vault):
        provider = provider_from_vault(vault)
        self.provider = provider
        if provider in PROVIDERS:
            endpoint = PROVIDERS[provider]["endpoint"]
            self.BASES = (endpoint, endpoint)
        original_gateway_init(self, vault)

    def provider_key(self):
        provider = getattr(self, "provider", "Kilo")
        if provider not in PROVIDERS:
            return original_gateway_key(self)
        spec = PROVIDERS[provider]
        value = os.environ.get(spec["env"]) or self.vault.get(spec["vault"])
        if value:
            buddy._SECRETS_SEEN.add(value)
        return value

    def resolve(self, role):
        provider = getattr(self.gw, "provider", "Kilo")
        if provider in PROVIDERS:
            return PROVIDERS[provider]["model"]
        return original_router_resolve(self, role)

    def ladder(self):
        if getattr(self.gw, "provider", "Kilo") in PROVIDERS:
            return []
        return original_router_ladder(self)

    def session_request(url, *args, **kwargs):
        req = original_request(url, *args, **kwargs)
        if isinstance(url, str) and url.startswith(GO_PREFIX):
            req.add_header("x-opencode-session", SESSION_ID)
        return req

    async def command(self, line):
        parts = line.strip().split()
        cmd = parts[0].lower() if parts else ""
        arg = parts[1].lower() if len(parts) > 1 else ""
        provider_names = {
            "1": "OpenRouter", "openrouter": "OpenRouter",
            "2": "OpenCode Go", "go": "OpenCode Go",
            "opencode": "OpenCode Go", "opencode-go": "OpenCode Go",
            "3": "Kilo", "kilo": "Kilo",
        }
        if cmd in ("/models", "/model", "/provider", "/settings"):
            selected = provider_names.get(arg)
            if selected:
                if self.current_run:
                    self.out("Vänta tills den pågående uppgiften är färdig.")
                    return
                self.vault.set("omega_active_provider", selected)
                self.gateway = Gateway(self.vault)
                self.router.gw = self.gateway
                self.out("Aktiv: " + selected + " / " + self.router.resolve("chat") +
                         " | API: " + ("sparad" if self.gateway.key() else "saknas"))
            else:
                self.out("MODELLER (skriv /models 1, /models 2 eller /models 3)\n"
                         "  1  OpenRouter  — DeepSeek Flash 1017\n"
                         "  2  OpenCode Go — DeepSeek Flash\n"
                         "  3  Kilo       — befintlig Kilo-konfiguration\n"
                         "Aktiv: " + self.gateway.provider + " / " + self.router.resolve("chat") +
                         "\nNyckel: /api openrouter eller /api go | Test: /testapi")
            return
        if cmd == "/api":
            target = provider_names.get(arg)
            if target not in PROVIDERS:
                self.out("Använd /api openrouter eller /api go.")
                return
            self._omega_key_entry = target
            self.out("Klistra in " + target + "-nyckeln i nästa inmatning och tryck Enter."
                     " Nyckeln visas medan du skriver men döljs i chatthistoriken."
                     " Den lagras krypterat via Windows DPAPI. Skriv /cancel för att avbryta.")
            return
        if cmd == "/testapi":
            if not self.gateway.key():
                self.out("Ingen API-nyckel för vald leverantör. Skriv /api.")
                return
            model = self.router.resolve("chat")
            ok, detail = await asyncio.to_thread(self.gateway.ping, model)
            status = "PASS" if ok else "FAIL"
            self.out(status + ": " + self.gateway.provider + " / " + model +
                     " — " + buddy.redact(str(detail))[:180])
            return
        await original_command(self, line)

    async def submit(self, text, source="text", lang=None):
        pending = getattr(self, "_omega_key_entry", None)
        if pending and source == "text":
            self._omega_key_entry = None
            value = text.strip()
            if value.lower() in ("/cancel", "cancel", "avbryt"):
                self.out("API-nyckelinmatning avbruten.")
                self.ui.prompt()
                return
            if not value:
                self.out("Tom API-nyckel. Använd /api igen.")
                self.ui.prompt()
                return
            self.vault.set(PROVIDERS[pending]["vault"], value)
            self.gateway = Gateway(self.vault)
            self.router.gw = self.gateway
            self.out(pending + "-nyckeln sparades krypterat. Använd /models och /testapi.")
            self.ui.prompt()
            return
        await original_submit(self, text, source, lang)

    Gateway.__init__ = gateway_init
    Gateway.key = provider_key
    Router.resolve = resolve
    Router.ladder = ladder
    Buddy.command = command
    Buddy.submit = submit
    urllib.request.Request = session_request
