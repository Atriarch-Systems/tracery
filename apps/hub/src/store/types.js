/** Converts a core `Flow` (whose `ops`/`nodes` are `Map`s) into the JSON wire shape. */
export function toFlowSummary(flow) {
    return {
        id: flow.id,
        label: flow.label,
        actor: flow.actor,
        status: flow.status,
        partial: flow.partial,
        startedAt: flow.startedAt,
        endedAt: flow.endedAt,
        link: flow.link,
        trace: flow.trace,
        ops: Object.fromEntries(flow.ops),
        nodes: Object.fromEntries(flow.nodes),
        edges: flow.edges,
    };
}
