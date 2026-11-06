import { describe, it, expect } from 'vitest';
import {
  parseShowIpInterfaceBrief,
  parseRunningConfig,
  parseShowVlanBrief,
  parseShowIpRoute,
  parseShowMacTable,
  parsePingResult,
  detectCommand,
  analyseFault,
  explainSimulation,
  detectPduType,
  deviceFromInterfaces,
  debugChecklist,
} from '@studdy/packet-tracer';
import {
  SHOW_IP_INT_BRIEF_MIXED,
  SHOW_RUNNING_CONFIG,
  SHOW_VLAN_BRIEF,
  SHOW_IP_ROUTE_NO_DEFAULT,
  SHOW_IP_ROUTE_WITH_DEFAULT,
  SHOW_MAC_TABLE,
  PING_SUCCESS,
  PING_FAILURE,
} from '../fixtures/ios-output.js';

describe('show ip interface brief', () => {
  it('parses interfaces and their real statuses', () => {
    const { value, warnings } = parseShowIpInterfaceBrief(SHOW_IP_INT_BRIEF_MIXED);
    expect(value).toHaveLength(4);
    expect(value[0]).toMatchObject({ name: 'GigabitEthernet0/0', ipAddress: '192.168.1.1', status: 'up' });
    expect(value[1]).toMatchObject({ name: 'GigabitEthernet0/1', ipAddress: null, status: 'admin-down' });
    expect(value[2]).toMatchObject({ status: 'down' });
    expect(warnings.join(' ')).toMatch(/Subnätmask/);
  });

  it('never invents a subnet mask the command does not print', () => {
    const { value } = parseShowIpInterfaceBrief(SHOW_IP_INT_BRIEF_MIXED);
    expect(value.every((i) => i.subnetMask === null)).toBe(true);
  });

  it('warns instead of guessing on unrelated text', () => {
    const { value, warnings } = parseShowIpInterfaceBrief('hello world');
    expect(value).toEqual([]);
    expect(warnings[0]).toMatch(/Kunde inte läsa/);
  });
});

describe('show running-config', () => {
  it('extracts ip addresses, masks and shutdown state', () => {
    const { value } = parseRunningConfig(SHOW_RUNNING_CONFIG);
    const gi00 = value.find((i) => i.name === 'GigabitEthernet0/0');
    const gi01 = value.find((i) => i.name === 'GigabitEthernet0/1');
    expect(gi00).toMatchObject({ ipAddress: '192.168.1.1', subnetMask: '255.255.255.0', status: 'up' });
    expect(gi01).toMatchObject({ status: 'admin-down' });
    expect(value.find((i) => i.name === 'Vlan1')?.ipAddress).toBeNull();
  });
});

describe('other show commands', () => {
  it('parses vlan brief including ports', () => {
    const { value } = parseShowVlanBrief(SHOW_VLAN_BRIEF);
    expect(value.find((v) => v.id === 10)?.ports).toContain('Fa0/10');
    expect(value.length).toBeGreaterThan(3);
  });

  it('parses mac address-table', () => {
    const { value } = parseShowMacTable(SHOW_MAC_TABLE);
    expect(value).toHaveLength(3);
    expect(value[1]).toMatchObject({ vlan: 1, mac: '0002.17A3.4B5C', port: 'Fa0/2' });
  });

  it('parses routing tables with and without a default route', () => {
    const noDefault = parseShowIpRoute(SHOW_IP_ROUTE_NO_DEFAULT);
    expect(noDefault.value.some((r) => r.network.startsWith('192.168.1.0'))).toBe(true);
    expect(noDefault.value.some((r) => r.network === '0.0.0.0/0')).toBe(false);

    const withDefault = parseShowIpRoute(SHOW_IP_ROUTE_WITH_DEFAULT);
    const def = withDefault.value.find((r) => r.network === '0.0.0.0/0');
    expect(def?.via).toBe('203.0.113.1');
  });

  it('parses ping success and failure', () => {
    expect(parsePingResult(PING_SUCCESS).value).toMatchObject({ success: true, sent: 4, received: 4, lossPercent: 0 });
    expect(parsePingResult(PING_FAILURE).value).toMatchObject({ success: false, sent: 4, received: 0, lossPercent: 100 });
  });

  it('identifies the command that produced a block of output', () => {
    expect(detectCommand(SHOW_IP_INT_BRIEF_MIXED)).toBe('show ip interface brief');
    expect(detectCommand(SHOW_RUNNING_CONFIG)).toBe('show running-config');
    expect(detectCommand(SHOW_VLAN_BRIEF)).toBe('show vlan brief');
    expect(detectCommand(SHOW_MAC_TABLE)).toBe('show mac address-table');
    expect(detectCommand(PING_SUCCESS)).toBe('ping');
    expect(detectCommand('totally unrelated')).toBeNull();
  });
});

describe('device inference', () => {
  it('guesses device kind from the visible label', () => {
    expect(deviceFromInterfaces('PC0', [], 'STUDENT_REPORT').kind).toBe('PC');
    expect(deviceFromInterfaces('R1', [], 'STUDENT_REPORT').kind).toBe('ROUTER');
    expect(deviceFromInterfaces('S1', [], 'STUDENT_REPORT').kind).toBe('SWITCH');
  });
});

describe('fault analysis', () => {
  const baseObservation = {
    capturedAt: '2026-02-01T10:00:00Z',
    devices: [],
    cliOutputs: [],
    limitations: [],
  };

  it('does not invent a cause when nothing has been observed', () => {
    const result = analyseFault({ symptom: 'ping-fail-local', observation: baseObservation });
    expect(result.conclusion).toBeNull();
    expect(result.hypotheses).toHaveLength(0);
    expect(result.nextAction).toMatch(/show ip interface brief|gateway/i);
    expect(result.missingEvidence.length).toBeGreaterThan(0);
  });

  it('identifies an administratively down interface with high confidence', () => {
    const { value } = parseShowIpInterfaceBrief(SHOW_IP_INT_BRIEF_MIXED);
    const device = deviceFromInterfaces('R1', value, 'CLI_TEXT');
    const result = analyseFault({
      symptom: 'ping-fail-remote',
      observation: { ...baseObservation, devices: [device], cliOutputs: [{ command: 'show ip interface brief', deviceLabel: 'R1', raw: SHOW_IP_INT_BRIEF_MIXED }] },
      focusDeviceLabel: 'R1',
    });
    const top = result.hypotheses[0];
    expect(top?.id).toBe('interface-shutdown');
    expect(top?.statement).toContain('GigabitEthernet0/1');
    expect(result.conclusion).toContain('administrativt avstängd');
    expect(result.nextAction).toMatch(/no shutdown/);
  });

  it('identifies a missing default route from the routing table', () => {
    const device = deviceFromInterfaces('R1', parseRunningConfig(SHOW_RUNNING_CONFIG).value, 'CLI_TEXT');
    const result = analyseFault({
      symptom: 'ping-fail-remote',
      observation: {
        ...baseObservation,
        devices: [device],
        cliOutputs: [{ command: 'show ip route', deviceLabel: 'R1', raw: SHOW_IP_ROUTE_NO_DEFAULT }],
      },
      focusDeviceLabel: 'R1',
    });
    const hypothesis = result.hypotheses.find((h) => h.id === 'no-default-route');
    expect(hypothesis).toBeDefined();
    expect(hypothesis?.nextStep).toMatch(/ip route 0\.0\.0\.0/);
  });

  it('does not flag a missing default route when one exists', () => {
    const result = analyseFault({
      symptom: 'ping-fail-remote',
      observation: {
        ...baseObservation,
        devices: [deviceFromInterfaces('R1', [], 'CLI_TEXT')],
        cliOutputs: [{ command: 'show ip route', deviceLabel: 'R1', raw: SHOW_IP_ROUTE_WITH_DEFAULT }],
      },
    });
    expect(result.hypotheses.find((h) => h.id === 'no-default-route')).toBeUndefined();
  });

  it('suggests one diagnostic action, never a list', () => {
    const device = deviceFromInterfaces('R1', parseShowIpInterfaceBrief(SHOW_IP_INT_BRIEF_MIXED).value, 'CLI_TEXT');
    const result = analyseFault({
      symptom: 'ping-fail-local',
      observation: { ...baseObservation, devices: [device], cliOutputs: [] },
    });
    expect(result.nextAction.split('.').filter(Boolean).length).toBeLessThanOrEqual(2);
  });

  it('produces an honest debug checklist', () => {
    const observation = {
      ...baseObservation,
      devices: [deviceFromInterfaces('R1', [], 'CLI_TEXT')],
    };
    const result = analyseFault({ symptom: 'ping-fail-remote', observation });
    const checklist = debugChecklist({ symptom: 'ping-fail-remote', observation }, result);
    expect(checklist[0]?.done).toBe(true);
    expect(checklist[1]?.done).toBe(false);
    expect(checklist.every((s) => s.step.length > 0)).toBe(true);
  });
});

describe('simulation mode explanations', () => {
  it('explains a successful ARP exchange hop by hop', () => {
    const result = explainSimulation(
      [
        { deviceLabel: 'PC0', osiLayer: 2, description: 'ARP request broadcast', outcome: 'success', reason: null },
        { deviceLabel: 'Switch0', osiLayer: 2, description: 'frame flooded', outcome: 'success', reason: null },
        { deviceLabel: 'PC1', osiLayer: 2, description: 'ARP reply unicast', outcome: 'success', reason: null },
      ],
      { pduType: 'ARP' },
    );
    expect(result.confident).toBe(true);
    expect(result.narrative.length).toBeGreaterThan(3);
    expect(result.concepts).toContain('arp');
    expect(result.unknown).toHaveLength(0);
  });

  it('does not claim a cause for a failed packet when the reason is not visible', () => {
    const result = explainSimulation([
      { deviceLabel: 'R1', osiLayer: 3, description: 'packet dropped', outcome: 'failed', reason: null },
    ]);
    expect(result.confident).toBe(false);
    expect(result.unknown.join(' ')).toMatch(/framgår inte/);
    expect(result.narrative.join(' ')).toMatch(/show ip interface brief/);
  });

  it('reports a visible failure reason verbatim', () => {
    const result = explainSimulation([
      { deviceLabel: 'R1', osiLayer: 3, description: 'dropped', outcome: 'failed', reason: 'No route to destination' },
    ]);
    expect(result.narrative.join(' ')).toContain('No route to destination');
  });

  it('returns an honest message when no events are visible', () => {
    const result = explainSimulation([]);
    expect(result.confident).toBe(false);
    expect(result.narrative[0]).toMatch(/inga händelser/i);
  });

  it('detects PDU type from the on-screen label', () => {
    expect(detectPduType('ARP')).toBe('ARP');
    expect(detectPduType('ICMP echo')).toBe('ICMP');
    expect(detectPduType('???')).toBe('UNKNOWN');
  });
});
