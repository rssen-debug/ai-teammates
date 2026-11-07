/**
 * MAJIN — alla verktyg på ett ställe. Inget att aktivera.
 */
import { Registry } from './registry.js';
import { fileTools } from './files.js';
import { shellTools } from './shell.js';
import { sysTools } from './sys.js';
import { netTools } from './net.js';
import { webTools } from './web.js';
import { mediaTools } from './media.js';
import { pluginTools } from './plugins.js';
import { reTools } from './re.js';
import { majinTools } from './majin.js';
import { agentTools } from './agent.js';
import { jobTools } from './jobs.js';
import { marketingTools } from './marketing.js';
import { githubTools } from './github.js';
import { tradingTools } from './trading.js';
import { metaTools } from './meta.js';
import { winControlTools } from './wincontrol.js';
import { researchTools } from './research.js';
import { execTools } from './exec.js';
import { flowsTools } from './flows.js';
import { channelTools } from './channels.js';
import { heartbeatTools } from './heartbeat.js';
import { computerTools } from './computer.js';
import { resetTools } from './reset.js';import { auditTools } from './audit.js';import { memorySyncTools } from './memory-sync.js';import { learnTools } from './learn.js';import { teamTools } from './teams.js';import { powerTools } from './power.js';
import { approvals } from '../guard.js';

export const ALL_TOOLS = [
  ...fileTools, ...shellTools, ...sysTools, ...netTools, ...webTools,
  ...mediaTools, ...reTools, ...majinTools, ...pluginTools, ...agentTools,
  ...jobTools, ...marketingTools, ...githubTools, ...tradingTools, ...metaTools,
  ...winControlTools, ...researchTools, ...execTools, ...flowsTools, ...channelTools,
  ...heartbeatTools, ...computerTools, ...resetTools, ...auditTools, ...memorySyncTools,
  ...learnTools, ...teamTools, ...powerTools,
];

export function buildRegistry(ctx) {
  if (!ctx.approvals) ctx.approvals = approvals;
  const reg = new Registry(ALL_TOOLS, ctx);
  ctx.registry = reg;
  return reg;
}

export function toolCount() {
  return ALL_TOOLS.length;
}

export { Registry, ALL_TOOLS as tools };
