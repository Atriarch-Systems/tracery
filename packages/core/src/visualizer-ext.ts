/**
 * Type-only bridge to @atriarch/activity-visualizer. No renderer code is
 * pulled in: this file only re-exports types.
 *
 * `ActivityNode.group` and `ActivityEdge.kind` (SPEC.md §3, workstream B) are
 * already present in @atriarch/activity-visualizer/types as consumed here, so
 * project.ts uses ActivityNode/ActivityEdge directly with no local extension.
 */
export type {
  Activity,
  ActivityEdge,
  ActivityGraphHandle,
  ActivityGraphProps,
  ActivityGroup,
  ActivityNode,
  NodePresentation,
} from '@atriarch/activity-visualizer/types';
