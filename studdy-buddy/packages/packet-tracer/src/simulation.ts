/**
 * Packet Tracer Simulation Mode explanations.
 *
 * In Simulation Mode the student sees a PDU move between devices. We explain the
 * packet's journey ONLY from events that were actually visible (OSI layer
 * badges, device names, "Successful"/"Failed" markers). Anything else is
 * reported as unknown.
 */

export interface SimulationEvent {
  /** Device the packet is currently at or leaving, as labelled on screen. */
  deviceLabel: string;
  /** The OSI layer badge Packet Tracer shows for this hop, when readable. */
  osiLayer: number | null;
  /** Direction/description as shown in the event list. */
  description: string;
  /** Only when the UI literally shows success/failure. */
  outcome: 'success' | 'failed' | 'unknown';
  /** For failed events, the reason text if visible. */
  reason: string | null;
}

export interface SimulationExplanation {
  narrative: string[];
  /** What we could not determine from the screen. */
  unknown: string[];
  /** Concepts exercised by this specific simulation, from the events. */
  concepts: string[];
  /** True when we are confident enough to state the explanation. */
  confident: boolean;
}

export function explainSimulation(events: SimulationEvent[], options: { pduType?: 'ARP' | 'ICMP' | 'TCP' | 'UDP' | 'UNKNOWN' } = {}): SimulationExplanation {
  const narrative: string[] = [];
  const unknown: string[] = [];
  const concepts = new Set<string>();

  if (events.length === 0) {
    return {
      narrative: ['Inga händelser syns i simuleringslistan just nu. Starta om simuleringen så att händelserna blir synliga.'],
      unknown: ['Inga simuleringshändelser observerade.'],
      concepts: [],
      confident: false,
    };
  }

  const failed = events.filter((e) => e.outcome === 'failed');

  for (const event of events) {
    const layer = event.osiLayer;
    if (layer === 1) concepts.add('encapsulation');
    if (layer === 2) concepts.add('ethernet');
    if (layer === 3) concepts.add('ipv4-addressing');
    if (layer === 4) concepts.add('tcp-ip-model');

    const arrow = event.outcome === 'failed' ? 'stannade vid' : 'gick vidare via';
    if (layer !== null) {
      narrative.push(`${event.deviceLabel}: ${event.description} (lager ${layer}) – paketet ${arrow} ${event.deviceLabel}.`);
    } else {
      narrative.push(`${event.deviceLabel}: ${event.description}`);
      unknown.push(`OSI-lager för händelsen hos ${event.deviceLabel} gick inte att läsa.`);
    }
  }

  if (options.pduType === 'ARP') {
    concepts.add('arp');
    concepts.add('mac-addressing');
    narrative.push('Eftersom det är en ARP-PDU handlar första steget om att hitta rätt MAC-adress innan något kan skickas vidare.');
  }
  if (options.pduType === 'ICMP') {
    concepts.add('icmp');
  }

  if (failed.length) {
    const last = failed[failed.length - 1] as SimulationEvent;
    if (last.reason) {
      narrative.push(`Paketet stoppades hos ${last.deviceLabel}: "${last.reason}".`);
    } else {
      narrative.push(
        `Paketet stoppades hos ${last.deviceLabel}, men orsaken syns inte i händelselistan. Kör "show ip interface brief" eller kontrollera routingtabellen där.`,
      );
      unknown.push(`Orsaken till stoppet hos ${last.deviceLabel} framgår inte av det som syns på skärmen.`);
    }
    concepts.add('troubleshooting');
  }

  return {
    narrative,
    unknown,
    concepts: [...concepts],
    // We only claim confidence when every hop's layer was readable and the
    // outcome of each hop is known.
    confident: unknown.length === 0 && events.every((e) => e.outcome !== 'unknown'),
  };
}

/** Detects the PDU type from a visible packet label such as "ARP" or "ICMP". */
export function detectPduType(label: string): 'ARP' | 'ICMP' | 'TCP' | 'UDP' | 'UNKNOWN' {
  const l = label.toUpperCase();
  if (l.includes('ARP')) return 'ARP';
  if (l.includes('ICMP')) return 'ICMP';
  if (l.includes('TCP')) return 'TCP';
  if (l.includes('UDP')) return 'UDP';
  return 'UNKNOWN';
}
