import type { ShowCommandOutput, ObservedDevice, ObservedInterface } from '@studdy/shared';

/**
 * Parsers for real Cisco IOS command output, as pasted or OCR'd/read from the
 * Packet Tracer CLI window.
 *
 * Design constraints from the spec:
 *  - only produce facts that literally appear in the text
 *  - when the text is truncated or unparsable, say so instead of guessing
 *  - never synthesise interface config that was not shown
 */

export interface ParseResult<T> {
  value: T;
  warnings: string[];
}

const IP = /(\d{1,3}(?:\.\d{1,3}){3})/;

/** `show ip interface brief` */
export function parseShowIpInterfaceBrief(text: string): ParseResult<ObservedInterface[]> {
  const warnings: string[] = [];
  const interfaces: ObservedInterface[] = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    // Interface  IP-Address  OK? Method Status Protocol
    // Status can be two words ("administratively down" + "down"), so the tail
    // is captured whole and parsed rather than split into fixed columns.
    const match = /^(\S+)\s+(\d{1,3}(?:\.\d{1,3}){3}|unassigned)\s+(YES|NO)\s+(\S+)\s+(.+)$/i.exec(trimmed);
    if (!match) continue;
    const [, name, ipRaw, , , statusTail] = match;
    if (!name || !ipRaw) continue;
    const status = parseStatus(statusTail ?? '', '');
    interfaces.push({
      name,
      ipAddress: ipRaw.toLowerCase() === 'unassigned' ? null : ipRaw,
      subnetMask: null, // not shown by this command - we must not invent it
      status,
      vlan: null,
    });
  }

  if (interfaces.length === 0) {
    warnings.push('Kunde inte läsa några interface-rader. Är kommandot "show ip interface brief"?');
  } else if (!/subnet mask/i.test(text)) {
    warnings.push('Subnätmask finns inte i den här utskriften. Kör "show running-config" eller "show ip interface" för masken.');
  }
  return { value: interfaces, warnings };
}

function parseStatus(status: string, protocol: string): ObservedInterface['status'] {
  const s = `${status}/${protocol}`.toLowerCase();
  if (s.includes('administratively down')) return 'admin-down';
  if (s.startsWith('up/up')) return 'up';
  if (s.startsWith('down/down')) return 'down';
  if (s.includes('up')) return 'up';
  if (s.includes('down')) return 'down';
  return 'unknown';
}

/** `show running-config` - extracts interfaces with their ip address lines. */
export function parseRunningConfig(text: string): ParseResult<ObservedInterface[]> {
  const warnings: string[] = [];
  const interfaces: ObservedInterface[] = [];
  const lines = text.split(/\r?\n/);
  let current: ObservedInterface | null = null;

  for (const line of lines) {
    const ifaceMatch = /^interface\s+(\S+)/.exec(line.trim());
    if (ifaceMatch?.[1]) {
      if (current) interfaces.push(current);
      current = { name: ifaceMatch[1], ipAddress: null, subnetMask: null, status: 'unknown', vlan: null };
      continue;
    }
    if (!current) continue;
    const ipMatch = /^\s*ip address\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(line);
    if (ipMatch?.[1] && ipMatch[2]) {
      current.ipAddress = ipMatch[1];
      current.subnetMask = ipMatch[2];
    }
    if (/^\s*shutdown\s*$/.test(line)) current.status = 'admin-down';
    if (/^\s*no shutdown\s*$/.test(line) && current.status !== 'admin-down') current.status = 'up';
    const vlanMatch = /^\s*switchport access vlan\s+(\d+)/.exec(line);
    if (vlanMatch?.[1]) current.vlan = Number(vlanMatch[1]);
  }
  if (current) interfaces.push(current);

  if (interfaces.length === 0) warnings.push('Inga interface-block hittades i konfigurationen.');
  return { value: interfaces, warnings };
}

/** `show vlan brief` */
export function parseShowVlanBrief(text: string): ParseResult<{ id: number; name: string; ports: string[] }[]> {
  const vlans: { id: number; name: string; ports: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d{1,4})\s+(\S+)\s+(active|act\/unsup)\s*(.*)$/i.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    const ports = (match[4] ?? '').split(/[,\s]+/).filter(Boolean);
    vlans.push({ id: Number(match[1]), name: match[2], ports });
  }
  return {
    value: vlans,
    warnings: vlans.length === 0 ? ['Inga VLAN-rader hittades.'] : [],
  };
}

/** `show ip route` */
export function parseShowIpRoute(text: string): ParseResult<{ network: string; via: string | null; interfaceName: string | null; code: string }[]> {
  const routes: { network: string; via: string | null; interfaceName: string | null; code: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    // C    192.168.1.0/24 is directly connected, GigabitEthernet0/0
    // S*   0.0.0.0/0 [1/0] via 192.168.1.1
    const match = /^\s*([A-Z*]{1,3})\s+(\d{1,3}(?:\.\d{1,3}){3}\/?\d{0,2})\s*(?:\[.*?\])?\s*(?:is directly connected,\s*(\S+)|via\s+(\d{1,3}(?:\.\d{1,3}){3}))?/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    if (/^(gateway|codes)/i.test(line.trim())) continue;
    routes.push({
      code: match[1].replace('*', ''),
      network: match[2],
      via: match[4] ?? null,
      interfaceName: match[3] ?? null,
    });
  }
  return {
    value: routes,
    warnings: routes.length === 0 ? ['Inga rutter hittades i routingtabellen.'] : [],
  };
}

/** `show mac address-table` */
export function parseShowMacTable(text: string): ParseResult<{ mac: string; vlan: number | null; type: string; port: string }[]> {
  const entries: { mac: string; vlan: number | null; type: string; port: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d{1,4})?\s*([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}|[0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+(\S+)\s+(\S+)$/i.exec(line.trim());
    if (!match?.[2]) continue;
    entries.push({
      vlan: match[1] ? Number(match[1]) : null,
      mac: match[2],
      type: match[3] ?? 'unknown',
      port: match[4] ?? '',
    });
  }
  return { value: entries, warnings: entries.length === 0 ? ['Inga MAC-poster hittades.'] : [] };
}

/** ping / traceroute summaries. */
export function parsePingResult(text: string): ParseResult<{ success: boolean; sent: number | null; received: number | null; lossPercent: number | null }> {
  const summary =
    /(\d+)\s+packets transmitted,\s+(\d+)\s+received/i.exec(text) ??
    /Packets:\s*Sent\s*=\s*(\d+),\s*Received\s*=\s*(\d+)/i.exec(text) ??
    /Sent\s*=\s*(\d+).*?Received\s*=\s*(\d+)/i.exec(text);
  const loss = /(\d+(?:\.\d+)?)\s*%\s*(?:packet loss|loss)/i.exec(text);
  const dotsLine = /([.!]{4,})/.exec(text);
  let success = false;
  let sent: number | null = summary?.[1] ? Number(summary[1]) : null;
  let received: number | null = summary?.[2] ? Number(summary[2]) : null;

  if (received === null && dotsLine?.[1]) {
    sent = dotsLine[1].length;
    received = [...dotsLine[1]].filter((c) => c === '!').length;
  }
  if (received !== null && sent !== null) success = received > 0 && received === sent;
  else if (dotsLine?.[1]) success = dotsLine[1].includes('!');
  else if (/success rate is 100 percent/i.test(text)) {
    success = true;
    received = sent;
  } else if (/success rate is 0 percent/i.test(text)) {
    success = false;
  }

  return {
    value: {
      success,
      sent,
      received,
      lossPercent: loss?.[1] ? Number(loss[1]) : sent && received !== null && sent > 0 ? Math.round(((sent - received) / sent) * 100) : null,
    },
    warnings: summary || dotsLine ? [] : ['Kunde inte tolka ping-resultatet entydigt.'],
  };
}

/**
 * Detects which show-command produced a block of text. Used when the student
 * pastes output, or when OCR sees a CLI window but we do not know the command.
 */
export function detectCommand(text: string): ShowCommandOutput['command'] | null {
  const t = text.toLowerCase();
  if (/interface\s+ip-address\s+ok\?\s+method/.test(t)) return 'show ip interface brief';
  if (/^interface\s+\S+/m.test(t) && /version \d+\.\d+/.test(t)) return 'show running-config';
  if (/vlan\s+name\s+status\s+ports/.test(t)) return 'show vlan brief';
  if (/gateway of last resort|codes:.*l - local/.test(t)) return 'show ip route';
  if (/mac address table|vlan\s+mac address\s+type\s+ports/.test(t)) return 'show mac address-table';
  if (/packets transmitted|success rate is|ping statistics|reply from \d/.test(t)) return 'ping';
  if (/^\s*\d+\s+(\d+ ms|\*)/m.test(t) && /traceroute|tracing route/i.test(t)) return 'traceroute';
  if (/windows ip configuration|ipv4 address/i.test(t)) return 'ipconfig';
  return null;
}

export function parseShowCommand(command: string, text: string, deviceLabel: string | null = null): {
  output: ShowCommandOutput;
  interfaces?: ObservedInterface[];
  warnings: string[];
} {
  const output: ShowCommandOutput = { command, deviceLabel, raw: text };
  const detected = detectCommand(text);
  const effective = command || detected || 'unknown';

  switch (effective) {
    case 'show ip interface brief': {
      const parsed = parseShowIpInterfaceBrief(text);
      return { output: { ...output, command: effective }, interfaces: parsed.value, warnings: parsed.warnings };
    }
    case 'show running-config': {
      const parsed = parseRunningConfig(text);
      return { output: { ...output, command: effective }, interfaces: parsed.value, warnings: parsed.warnings };
    }
    default:
      return { output: { ...output, command: effective }, warnings: detected ? [] : ['Kommandot kunde inte identifieras.'] };
  }
}

/** Builds a device entry from parsed interface data plus a label the student gave. */
export function deviceFromInterfaces(label: string, interfaces: ObservedInterface[], evidence: ObservedDevice['evidence']): ObservedDevice {
  return { id: `dev:${label.toLowerCase()}`, label, kind: guessKind(label, interfaces), interfaces, evidence, bounds: null };
}

function guessKind(label: string, interfaces: ObservedInterface[]): ObservedDevice['kind'] {
  const l = label.toLowerCase().trim();
  // Labels look like "PC0", "R1", "Switch0": the kind is a prefix followed by an
  // optional number, so word-boundary matching alone would miss them.
  if (/^(pc|host|client|laptop)\d*\b/.test(l)) return 'PC';
  if (/^(s|sw|switch|sw-?\d*)\d*\b/.test(l) || /^switch/.test(l)) return 'SWITCH';
  if (/^(r|rt|router|gw|gateway)\d*\b/.test(l) || /^router/.test(l)) return 'ROUTER';
  if (/^(srv|server)\d*\b/.test(l)) return 'SERVER';
  if (/^(ap|wap|access.?point)\d*\b/.test(l)) return 'ACCESS_POINT';
  if (interfaces.some((i) => /gigabitethernet|fastethernet|serial/i.test(i.name)) && interfaces.length > 2) return 'SWITCH';
  return 'UNKNOWN';
}

export { IP };
