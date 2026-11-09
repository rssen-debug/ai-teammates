# OMEGA: VNC worker without disturbing the owner's desktop

**Important:** Ordinary VNC to your current Windows session mirrors that
session. It cannot keep Buddy from moving your mouse. Never point the worker
at the VNC server of the active host desktop.

## Supported architecture

- **Host:** Omega CLI, LLM routing, encrypted API credentials, task planning.
- **Guest:** Separate VM (Hyper-V or other hypervisor) with its own OS, browser,
  applications, isolated pointer/keyboard and VNC server.
- **Connection:** Prefer a loopback-bound SSH tunnel between the host and guest
  (example target: `127.0.0.1::5901`). Never expose bare VNC to the Internet.
- **Security:** VM work mode is opt-in. While active, host desktop, host screen,
  and host browser tools are blocked. Do not share the owner's full home directory
  or the Windows DPAPI credentials into the guest.

## Prerequisites

You must first install a guest OS, its browser and a VNC server, and set up
a private/tunneled connection. Omega does **not** automatically provision a VM,
start a VNC server or grant remote access. On Windows 11 Pro/Enterprise, Hyper-V
can provide a persistent separate VM. Windows Sandbox is ephemeral: state is
deleted when it closes.

In the Omega terminal:

```text
/worker status
/worker target 127.0.0.1::5901
/worker password
/worker enable --vm
/worker capture
```

Optional dependency for VNC remote control:
`python -m pip install vncdotool Pillow`

The VM tools are `vnc_capture`, `vnc_click`, `vnc_key` and `vnc_type`.
They use the VNC guest, not Windows `SendInput`. The agent is still subject to
its existing permission and verification gates. Captures go to the local
application shots directory, not to GitHub.

Use `/worker disable` to return to normal host mode. VM mode is **not proof of
successful isolation** until a separate VM has actually been provisioned and
the endpoint verified. A direct VNC connection to the host's desktop would
otherwise still interfere with the owner's work.

## Limitations

The present backend has **coordinate-based VNC**, not a browser DOM bridge or
an automatic VM installer. It can operate a guest browser by screenshots,
mouse and keyboard, but only after the user has prepared the guest environment.
The host's existing Chrome windows, tabs, cookies or logged-in sessions are
not silently copied to the guest. Sign in separately or share only deliberate,
narrowly scoped data.
