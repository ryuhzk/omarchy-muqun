/**
 * How much of a human's attention a pane wants.
 *
 * These are herdr's own agent states, adopted rather than invented because
 * herdr is what decides them and a second vocabulary would only be a mapping to
 * maintain. tmux has no notion of an agent, so every tmux pane is `unknown`,
 * which the panel renders as "no opinion" rather than as a problem.
 */

import { Schema } from 'effect';

export const AgentStatus = Schema.Literals(['blocked', 'working', 'idle', 'done', 'unknown']);
export type AgentStatus = typeof AgentStatus.Type;

/** Ordered most-urgent first, for sorting and for summarising a group. */
export const URGENCY: ReadonlyArray<AgentStatus> = [
  'blocked',
  'working',
  'done',
  'idle',
  'unknown',
];

/**
 * Whether this state is what the bar badge counts.
 *
 * Only `blocked`. An agent that is working is the normal state of a healthy
 * machine, and a badge that counted it would be lit almost always, which is the
 * same as having no badge.
 */
export function wantsAttention(status: AgentStatus): boolean {
  return status === 'blocked';
}

export function moreUrgent(a: AgentStatus, b: AgentStatus): AgentStatus {
  return URGENCY.indexOf(a) <= URGENCY.indexOf(b) ? a : b;
}

/**
 * Read a status that came from outside.
 *
 * An unrecognised value from a newer herdr becomes `unknown` rather than
 * reaching the panel as a string it has no colour for.
 */
export function parseAgentStatus(value: string | undefined): AgentStatus {
  const decoded = Schema.decodeUnknownOption(AgentStatus)(value);
  return decoded._tag === 'Some' ? decoded.value : 'unknown';
}
