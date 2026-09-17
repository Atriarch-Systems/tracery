/**
 * Prometheus text-exposition metrics (SPEC.md §6 "Hub" HTTP table, `/metrics`
 * row). A tiny counter registry rather than a dependency: the metric set is
 * fixed and small.
 */
import type { EventStore } from './store/types.js';
import type { SweepResult } from './store/types.js';

export class MetricsRegistry {
  private ingested = 0;
  private rejected = 0;
  private duplicates = 0;
  private sweeps = 0;
  private sweptFlows = 0;
  private wsClients = 0;

  recordIngest(accepted: number, rejected: number, duplicates: number): void {
    this.ingested += accepted;
    this.rejected += rejected;
    this.duplicates += duplicates;
  }

  recordSweep(result: SweepResult): void {
    this.sweeps += 1;
    this.sweptFlows += result.sweptFlows;
  }

  wsClientConnected(): void {
    this.wsClients += 1;
  }

  wsClientDisconnected(): void {
    this.wsClients = Math.max(0, this.wsClients - 1);
  }

  get wsClientCount(): number {
    return this.wsClients;
  }

  /** Renders the full Prometheus text-exposition body, including `tracery_flows_total` / `tracery_store_events` read fresh from the store. */
  async render(store: EventStore): Promise<string> {
    const stats = await store.stats();
    const totalEvents = stats.reduce((sum, workspace) => sum + workspace.events, 0);
    const totalFlows = stats.reduce((sum, workspace) => sum + workspace.flows, 0);

    const lines: string[] = [
      '# HELP tracery_events_ingested_total Total events accepted by the hub.',
      '# TYPE tracery_events_ingested_total counter',
      `tracery_events_ingested_total ${this.ingested}`,
      '# HELP tracery_events_rejected_total Total events rejected during ingest.',
      '# TYPE tracery_events_rejected_total counter',
      `tracery_events_rejected_total ${this.rejected}`,
      '# HELP tracery_events_duplicate_total Total events ignored as duplicates.',
      '# TYPE tracery_events_duplicate_total counter',
      `tracery_events_duplicate_total ${this.duplicates}`,
      '# HELP tracery_flows_total Flows currently retained across all workspaces.',
      '# TYPE tracery_flows_total gauge',
      `tracery_flows_total ${totalFlows}`,
      '# HELP tracery_store_events Events currently retained across all workspaces.',
      '# TYPE tracery_store_events gauge',
      `tracery_store_events ${totalEvents}`,
      '# HELP tracery_ws_clients Live WebSocket clients currently connected.',
      '# TYPE tracery_ws_clients gauge',
      `tracery_ws_clients ${this.wsClients}`,
      '# HELP tracery_sweeps_total Retention sweeps run.',
      '# TYPE tracery_sweeps_total counter',
      `tracery_sweeps_total ${this.sweeps}`,
      '# HELP tracery_swept_flows_total Flows deleted by retention sweeps.',
      '# TYPE tracery_swept_flows_total counter',
      `tracery_swept_flows_total ${this.sweptFlows}`,
    ];
    return lines.join('\n') + '\n';
  }
}
