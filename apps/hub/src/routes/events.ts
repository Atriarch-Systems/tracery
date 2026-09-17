/**
 * `POST /v1/events` (SPEC.md §6 HTTP API table): batch ingest. Uses core's
 * `validateBatch` as the fast path (whole batch valid); when it fails, falls
 * back to per-event `validateEvent` (also core, never reimplemented) so a
 * batch with some bad events can still 207-partial-accept the good ones,
 * with `rejected[]` naming exactly which failed and why.
 */
import type { FastifyInstance } from 'fastify';
import { validateBatch, validateEvent } from '@atriarch/tracery-core';
import { ACTIVITY_CONTRACT_VERSION, ACTIVITY_LIMITS, type ActivityBatchResult, type ActivityEvent } from '@atriarch/tracery-core/contract';
import type { HubContext } from '../server-context.js';
import { errorBody } from './errors.js';

interface RawBatchLike {
  readonly v?: unknown;
  readonly workspace?: unknown;
  readonly events?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function registerEventsRoutes(app: FastifyInstance, ctx: HubContext): void {
  app.post(
    '/v1/events',
    {
      schema: {
        summary: 'Ingest an ActivityBatch',
        tags: ['events'],
        body: { type: 'object' },
      },
    },
    async (request, reply) => {
      const raw = request.body as RawBatchLike;

      if (!isPlainObject(raw) || raw.v !== ACTIVITY_CONTRACT_VERSION || !Array.isArray(raw.events)) {
        return reply.code(400).send(errorBody('invalid_batch', 'body must be an ActivityBatch: { v, workspace?, events[] }'));
      }
      if (raw.events.length > ACTIVITY_LIMITS.maxEventsPerBatch) {
        return reply
          .code(400)
          .send(errorBody('batch_too_large', `batch.events exceeds maxEventsPerBatch (${ACTIVITY_LIMITS.maxEventsPerBatch})`));
      }

      const requestedWorkspace = typeof raw.workspace === 'string' ? raw.workspace : undefined;
      const auth = await ctx.requireAuth(request, 'ingest', requestedWorkspace);

      const wholeBatch = validateBatch(raw);
      let validEvents: ActivityEvent[];
      const rejected: { index: number; reason: string }[] = [];

      if (wholeBatch.ok) {
        validEvents = [...wholeBatch.batch.events];
      } else {
        validEvents = [];
        for (let index = 0; index < raw.events.length; index++) {
          const result = validateEvent(raw.events[index]);
          if (result.ok) validEvents.push(result.event);
          else rejected.push({ index, reason: result.reason });
        }
      }

      const result = await ctx.store.append(auth.workspace, validEvents);
      ctx.metrics.recordIngest(result.accepted.length, rejected.length, result.duplicates);

      const body: ActivityBatchResult = {
        accepted: result.accepted.length,
        duplicates: result.duplicates,
        rejected,
        cursor: result.cursor,
      };

      reply.code(rejected.length > 0 ? 207 : 200).send(body);
    },
  );
}
