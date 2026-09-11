/**
 * A terminal pane, in the vocabulary the panel speaks.
 *
 * herdr and tmux describe overlapping things two different ways. Both adapters
 * translate into this shape, so nothing above the adapter boundary branches on
 * where a pane came from.
 */

import { Schema } from 'effect';
import { AgentStatus, URGENCY } from './agent-status';

/** Which tool described this pane. Probed, never configured. */
export const PaneSource = Schema.Literals(['herdr', 'tmux']);
export type PaneSource = typeof PaneSource.Type;

export const Pane = Schema.Struct({
  /** Opaque above the adapter. herdr's `w1:p5`, tmux's `%3`. */
  id: Schema.String,
  source: PaneSource,
  title: Schema.String,
  cwd: Schema.String,
  focused: Schema.Boolean,
  status: AgentStatus,
  /** The agent's kind when one was detected: `claude`, `codex`, and so on. */
  agent: Schema.optional(Schema.String),
  /** What groups panes in the panel: a herdr tab, or a tmux window. */
  groupId: Schema.String,
  groupLabel: Schema.String,
});
export type Pane = typeof Pane.Type;

/** Whether a pane is running an agent, as opposed to being a plain shell. */
export function isAgentPane(pane: Pane): boolean {
  return pane.agent !== undefined && pane.agent !== '';
}

export interface PaneGroup {
  readonly id: string;
  readonly label: string;
  readonly panes: ReadonlyArray<Pane>;
}

/**
 * Panes grouped for display: most urgent group first, arrival order within a
 * group.
 *
 * Sorting groups rather than panes keeps a tab's panes together, which is how
 * the person arranged them, while still floating the tab that needs an answer
 * to the top.
 */
export function groupPanes(panes: ReadonlyArray<Pane>): ReadonlyArray<PaneGroup> {
  const groups = new Map<string, { id: string; label: string; panes: Array<Pane> }>();
  for (const pane of panes) {
    let group = groups.get(pane.groupId);
    if (!group) {
      group = { id: pane.groupId, label: pane.groupLabel, panes: [] };
      groups.set(pane.groupId, group);
    }
    group.panes.push(pane);
  }

  const urgency = (group: { panes: ReadonlyArray<Pane> }): number => {
    let best = URGENCY.length;
    for (const pane of group.panes) best = Math.min(best, URGENCY.indexOf(pane.status));
    return best;
  };

  return [...groups.values()].sort((a, b) => urgency(a) - urgency(b));
}
