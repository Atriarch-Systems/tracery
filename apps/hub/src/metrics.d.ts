/**
 * Prometheus text-exposition metrics (SPEC.md §6 "Hub" HTTP table, `/metrics`
 * row). A tiny counter registry rather than a dependency: the metric set is
 * fixed and small.
 */
import type { EventStore } from './store/types.js';
import type { SweepResult } from './store/types.js';
export declare class MetricsRegistry {
    private ingested;
    private rejected;
    private duplicates;
    private sweeps;
    private sweptFlows;
    private wsClients;
    recordIngest(accepted: number, rejected: number, duplicates: number): void;
    recordSweep(result: SweepResult): void;
    wsClientConnected(): void;
    wsClientDisconnected(): void;
    get wsClientCount(): number;
    /** Renders the full Prometheus text-exposition body, including `activity_flows_total` / `activity_store_events` read fresh from the store. */
    render(store: EventStore): Promise<string>;
}
