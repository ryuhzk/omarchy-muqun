/**
 * A host: one SSH alias, and everything currently known about it.
 *
 * The alias is the identity. A host is never configured beyond that -- what it
 * can do is asked, not declared -- which is the whole reason the desktop client
 * needs no pairing, no URL, and no token.
 */

import { Schema } from 'effect';
import { moreUrgent, wantsAttention, type AgentStatus } from './agent-status';
import { Pane, PaneSource } from './pane';

/**
 * What a host turned out to be able to do.
 *
 * simfarm is deliberately absent. It is not a way of reaching a terminal -- it
 * is a button that opens its own simulator surface. Folding it in as a third
 * capability would have put simulators in the pane list, which is not what they
 * are.
 */
export const Capability = PaneSource;
export type Capability = typeof Capability.Type;

export const HostState = Schema.Literals(['connecting', 'ready', 'error', 'offline']);
export type HostState = typeof HostState.Type;

export const Host = Schema.Struct({
  alias: Schema.String,
  label: Schema.String,
  capabilities: Schema.Array(Capability),
  panes: Schema.Array(Pane),
  state: HostState,
  /** Present when the state is `error` or `offline`; safe to show a person. */
  error: Schema.optional(Schema.String),
});
export type Host = typeof Host.Type;

/** A host as it looks the moment it is added, before anything has answered. */
export function connectingHost(alias: string, label?: string): Host {
  return {
    alias,
    label: label?.trim() || alias,
    capabilities: [],
    panes: [],
    state: 'connecting',
  };
}

/** How many things across every host are waiting on a human. */
export function attentionCount(hosts: ReadonlyArray<Host>): number {
  let total = 0;
  for (const host of hosts) {
    for (const pane of host.panes) {
      if (wantsAttention(pane.status)) total += 1;
    }
  }
  return total;
}

/** The single status that best describes a host, for its row in the panel. */
export function hostStatus(host: Host): AgentStatus {
  let best: AgentStatus = 'unknown';
  for (const pane of host.panes) best = moreUrgent(best, pane.status);
  return best;
}
