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

  /** Renders the full Prometheus text-exposition body, including `activity_flows_total` / `activity_store_events` read fresh from the store. */
  async render(store: EventStore): Promise<string> {
    const stats = await store.stats();
    const totalEvents = stats.reduce((sum, workspace) => sum + workspace.events, 0);
    const totalFlows = stats.reduce((sum, workspace) => sum + workspace.flows, 0);

    const lines: string[] = [
      '# HELP activity_events_ingested_total Total events accepted by the hub.',
      '# TYPE activity_events_ingested_total counter',
      `activity_events_ingested_total ${this.ingested}`,
      '# HELP activity_events_rejected_total Total events rejected during ingest.',
      '# TYPE activity_events_rejected_total counter',
      `activity_events_rejected_total ${this.rejected}`,
      '# HELP activity_events_duplicate_total Total events ignored as duplicates.',
      '# TYPE activity_events_duplicate_total counter',
      `activity_events_duplicate_total ${this.duplicates}`,
      '# HELP activity_flows_total Flows currently retained across all workspaces.',
      '# TYPE activity_flows_total gauge',
      `activity_flows_total ${totalFlows}`,
      '# HELP activity_store_events Events currently retained across all workspaces.',
      '# TYPE activity_store_events gauge',
      `activity_store_events ${totalEvents}`,
      '# HELP activity_ws_clients Live WebSocket clients currently connected.',
      '# TYPE activity_ws_clients gauge',
      `activity_ws_clients ${this.wsClients}`,
      '# HELP activity_sweeps_total Retention sweeps run.',
      '# TYPE activity_sweeps_total counter',
      `activity_sweeps_total ${this.sweeps}`,
      '# HELP activity_swept_flows_total Flows deleted by retention sweeps.',
      '# TYPE activity_swept_flows_total counter',
      `activity_swept_flows_total ${this.sweptFlows}`,
    ];
    return lines.join('\n') + '\n';
  }
}
