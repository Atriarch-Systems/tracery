export type StoreKind = 'memory' | 'sqlite';
export type Role = 'ingest' | 'read' | 'admin';
export interface ApiKeyConfig {
    readonly id: string;
    readonly key: string;
    /** `*` marks the operator key: any workspace, request supplies it explicitly. */
    readonly workspace: string;
    readonly roles: readonly Role[];
}
export interface Config {
    readonly port: number;
    readonly host: string;
    readonly store: StoreKind;
    readonly sqlitePath: string;
    /** Configured keys, or `undefined` when none were configured (dev key mode). */
    readonly apiKeys: readonly ApiKeyConfig[] | undefined;
    readonly retentionHours: number;
    readonly maxEventsPerWorkspace: number;
    readonly metricsToken: string | undefined;
    readonly logLevel: string;
    readonly uiDir: string;
}
/** Parses `ACTIVITY_API_KEYS` (a JSON array) or the contents of `ACTIVITY_API_KEYS_FILE`. */
export declare function parseApiKeys(json: string, source: string): ApiKeyConfig[];
/** Reads every hub environment variable, applying defaults. Never touches `process.env` directly (pass it in). */
export declare function loadConfig(env?: NodeJS.ProcessEnv): Config;
