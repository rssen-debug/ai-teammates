import type { ObservedInterface, TopologyObservation } from '@studdy/shared';

/**
 * Evidence-based troubleshooting.
 *
 * The engine never asserts a root cause it cannot support. It produces
 * *hypotheses* ranked by the evidence actually present, plus the single
 * diagnostic action that would discriminate between them. That matches the
 * spec's DEBUG mode: one question or one command at a time.
 */

export interface Hypothesis {
  id: string;
  /** Short, plain-language statement the chat can show. */
  statement: string;
  /** 0..1: how much the visible evidence supports this. */
  likelihood: number;
  /** Which observed facts support it. Empty means "plausible but unproven". */
  supportingEvidence: string[];
  /** The one command or check that would confirm or eliminate it. */
  nextStep: string;
  layer: 'L1' | 'L2' | 'L3' | 'L4' | 'L7';
}

export interface TroubleshootInput {
  symptom: 'ping-fail-local' | 'ping-fail-remote' | 'no-connectivity' | 'intermittent' | 'unknown';
  observation: TopologyObservation;
  /** Which device the student is working on, when known. */
  focusDeviceLabel?: string | null;
}

export interface TroubleshootResult {
  hypotheses: Hypothesis[];
  /** The single thing to do next. */
  nextAction: string;
  /** Explicit list of what we could NOT see, so the UI can say so. */
  missingEvidence: string[];
  /** Never assert a cause unless one hypothesis is clearly dominant. */
  conclusion: string | null;
}

export function analyseFault(input: TroubleshootInput): TroubleshootResult {
  const hypotheses: Hypothesis[] = [];
  const missingEvidence: string[] = [];
  const { observation } = input;

  const focus = input.focusDeviceLabel
    ? observation.devices.find((d) => d.label.toLowerCase() === input.focusDeviceLabel?.toLowerCase())
    : observation.devices[0];
  const interfaces: ObservedInterface[] = focus?.interfaces ?? [];

  if (observation.devices.length === 0) {
    missingEvidence.push('Inga enheter har observerats ännu.');
  }
  if (observation.cliOutputs.length === 0) {
    missingEvidence.push('Ingen CLI-utskrift har lästs in, så interface-status och IP-konfiguration är okända.');
  }
  if (interfaces.length === 0) {
    missingEvidence.push('Interface-listan är tom eller oläslig.');
  }

  // --- Layer 1/2: administratively down or down/down ------
  const adminDown = interfaces.filter((i) => i.status === 'admin-down');
  if (adminDown.length) {
    hypotheses.push({
      id: 'interface-shutdown',
      statement: `${adminDown.map((i) => i.name).join(', ')} är administrativt avstängd (shutdown).`,
      likelihood: 0.9,
      supportingEvidence: adminDown.map((i) => `${i.name}: administratively down`),
      nextStep: `På enheten: gå in på interfacet med "interface ${adminDown[0]?.name}" och kör "no shutdown".`,
      layer: 'L1',
    });
  }

  const linkDown = interfaces.filter((i) => i.status === 'down');
  if (linkDown.length) {
    hypotheses.push({
      id: 'link-down',
      statement: `${linkDown.map((i) => i.name).join(', ')} är nere (down/down), vilket oftast betyder att länken eller kabeln inte är aktiv.`,
      likelihood: 0.75,
      supportingEvidence: linkDown.map((i) => `${i.name}: down/down`),
      nextStep: 'Kontrollera att rätt kabeltyp är dragen och att porten i andra änden är aktiv.',
      layer: 'L1',
    });
  }

  // --- Layer 3: missing / wrong IP --------------------------------------
  const noIp = interfaces.filter((i) => !i.ipAddress && i.status !== 'admin-down');
  if (noIp.length && input.symptom !== 'unknown') {
    hypotheses.push({
      id: 'missing-ip',
      statement: `${noIp.map((i) => i.name).join(', ')} saknar IP-adress, så enheten kan inte kommunicera på lager 3 via dem.`,
      likelihood: 0.7,
      supportingEvidence: noIp.map((i) => `${i.name}: unassigned`),
      nextStep: 'Kör "show ip interface brief" och sätt en adress som ligger i rätt subnät.',
      layer: 'L3',
    });
  }

  // --- Layer 3: gateway mismatch from visible config --------------------
  const gatewayIssue = detectGatewayMismatch(observation);
  if (gatewayIssue) {
    hypotheses.push({
      id: 'gateway-mismatch',
      statement: gatewayIssue.statement,
      likelihood: 0.8,
      supportingEvidence: gatewayIssue.evidence,
      nextStep: 'Jämför PC:ns default gateway med routerns interface-adress och rätta den som är fel.',
      layer: 'L3',
    });
  }

  // --- Layer 3: routing table lacks a route ----------------------------
  const routeGap = detectMissingRoute(observation, input.symptom);
  if (routeGap) {
    hypotheses.push(routeGap);
  }

  // --- Layer 2: VLAN mismatch -----------------------------------------
  const vlanIssue = detectVlanMismatch(observation);
  if (vlanIssue) hypotheses.push(vlanIssue);

  // --- No data at all: do not invent a cause ---------------------------
  if (hypotheses.length === 0) {
    const fallbackNext =
      interfaces.length === 0
        ? 'Klistra in eller visa utskriften från "show ip interface brief" så att jag kan se statusen på interface:n.'
        : 'Pinga din default gateway. Fungerar det är felet bortom det lokala nätet; fungerar det inte är felet lokalt.';
    return {
      hypotheses: [],
      nextAction: fallbackNext,
      missingEvidence,
      conclusion: null,
    };
  }

  hypotheses.sort((a, b) => b.likelihood - a.likelihood);
  const top = hypotheses[0] as Hypothesis;
  // Only state a conclusion when the evidence is dominant. Otherwise stay in
  // diagnostic mode - which is what a good tutor does.
  // Several findings can be true at once (two interfaces may each be faulted),
  // so "dominant" means the top finding clearly leads the rest. We require both
  // a strong absolute likelihood and a visible margin over the runner-up; if two
  // causes are equally likely we stay in diagnostic mode and say nothing.
  const runnerUp = hypotheses[1]?.likelihood ?? 0;
  const dominant = top.likelihood >= 0.8 && top.likelihood - runnerUp >= 0.1;

  return {
    hypotheses,
    nextAction: top.nextStep,
    missingEvidence,
    conclusion: dominant ? top.statement : null,
  };
}

function detectGatewayMismatch(observation: TopologyObservation): { statement: string; evidence: string[] } | null {
  // We need both a PC gateway and a router interface on the same subnet.
  const evidence: string[] = [];
  for (const device of observation.devices) {
    for (const iface of device.interfaces) {
      const gwMatch = /default gateway\s*[:=]?\s*(\d{1,3}(?:\.\d{1,3}){3})/i.exec(iface.name);
      if (gwMatch?.[1]) evidence.push(`${device.label}: default gateway ${gwMatch[1]}`);
    }
  }
  const routerIps = observation.devices
    .filter((d) => d.kind === 'ROUTER')
    .flatMap((d) => d.interfaces.map((i) => i.ipAddress).filter((ip): ip is string => Boolean(ip)));

  const pcGateways = observation.devices
    .filter((d) => d.kind === 'PC')
    .flatMap((d) => d.interfaces.map((i) => i.subnetMask).filter(Boolean));

  if (routerIps.length === 0 || pcGateways.length === 0) return null;

  // Look for a PC whose interface names embed a gateway line that matches no router IP.
  const declaredGateways = observation.devices
    .filter((d) => d.kind === 'PC')
    .flatMap((d) =>
      d.interfaces
        .map((i) => /gateway[^0-9]*(\d{1,3}(?:\.\d{1,3}){3})/i.exec(i.name)?.[1])
        .filter((v): v is string => Boolean(v)),
    );

  const wrong = declaredGateways.filter((gw) => !routerIps.includes(gw));
  if (wrong.length === 0) return null;
  return {
    statement: `En PC pekar på gateway ${wrong[0]}, men ingen router-interface-adress i observationen matchar den.`,
    evidence: [...evidence, `Routeradresser i observationen: ${routerIps.join(', ')}`],
  };
}

function detectMissingRoute(observation: TopologyObservation, symptom: TroubleshootInput['symptom']): Hypothesis | null {
  if (symptom !== 'ping-fail-remote' && symptom !== 'no-connectivity') return null;
  const routeOutput = observation.cliOutputs.find((c) => /show ip route/i.test(c.command) || /gateway of last resort|codes:/i.test(c.raw));
  if (!routeOutput) return null;

  const hasDefault = /\bS\*|0\.0\.0\.0\/0/.test(routeOutput.raw);
  const connectedCount = (routeOutput.raw.match(/^\s*C\s+/gm) ?? []).length;

  if (!hasDefault && connectedCount > 0) {
    return {
      id: 'no-default-route',
      statement:
        'Routingtabellen har bara direktanslutna nät och ingen default route, så trafik mot andra nätverk har ingen väg ut.',
      likelihood: 0.7,
      supportingEvidence: ['Routingtabellen saknar 0.0.0.0/0 (S*).', `${connectedCount} direktanslutna nät syns.`],
      nextStep: 'Lägg till en default route mot grannroutern, till exempel: ip route 0.0.0.0 0.0.0.0 <next-hop>.',
      layer: 'L3',
    };
  }
  return null;
}

function detectVlanMismatch(observation: TopologyObservation): Hypothesis | null {
  const vlanOutput = observation.cliOutputs.find((c) => /show vlan/i.test(c.command) || /vlan\s+name\s+status/i.test(c.raw));
  if (!vlanOutput) return null;
  // Two PCs reported to be in different VLANs on the same switch is a classic
  // "ping fails locally" cause.
  const vlans = [...vlanOutput.raw.matchAll(/^\s*(\d{1,4})\s+(\S+)\s+active\s+(.+)$/gim)];
  if (vlans.length < 2) return null;
  const nonDefault = vlans.filter((v) => v[1] !== '1');
  if (nonDefault.length === 0) return null;
  return {
    id: 'vlan-segmentation',
    statement: `Det finns ${vlans.length} VLAN konfigurerade. Om de två enheterna ligger i olika VLAN kan de inte pinga varandra utan routing.`,
    likelihood: 0.45,
    supportingEvidence: vlans.slice(0, 4).map((v) => `VLAN ${v[1]} (${v[2]})`),
    nextStep: 'Kör "show vlan brief" och kontrollera vilket VLAN varje port tillhör.',
    layer: 'L2',
  };
}

/**
 * The 13-step loop from the spec, condensed into what the agent actually does
 * with a single observation. Kept explicit so each step is testable.
 */
export interface DebugStep {
  step: string;
  done: boolean;
  detail: string;
}

export function debugChecklist(input: TroubleshootInput, result: TroubleshootResult): DebugStep[] {
  return [
    { step: 'Inspektera det synliga nätet', done: input.observation.devices.length > 0, detail: `${input.observation.devices.length} enheter observerade` },
    { step: 'Identifiera relevanta enheter', done: Boolean(input.focusDeviceLabel), detail: input.focusDeviceLabel ?? 'ingen fokusenhet angiven' },
    { step: 'Kontrollera tillgänglig information', done: input.observation.cliOutputs.length > 0, detail: `${input.observation.cliOutputs.length} CLI-utskrifter` },
    { step: 'Bygg hypoteser', done: result.hypotheses.length > 0, detail: `${result.hypotheses.length} hypoteser` },
    { step: 'Identifiera saknade belägg', done: true, detail: result.missingEvidence.length ? result.missingEvidence.join(' | ') : 'inga uppenbara luckor' },
    { step: 'Föreslå en diagnostisk åtgärd', done: Boolean(result.nextAction), detail: result.nextAction },
  ];
}
