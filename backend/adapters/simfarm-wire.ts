/**
 * simfarm's socket protocol, as bytes.
 *
 * One WebSocket carries everything, and the first byte says which of four
 * channels a message belongs to. Control and event frames are that byte
 * followed by JSON; a video frame is that byte, a stream id, a tag, and then
 * the picture.
 *
 * Kept apart from the client so the framing can be tested without a socket.
 */

import { Schema } from 'effect';
import type { SimulatorDevice } from '../domain/simfarm';

export const CHANNEL = {
  video: 0x01,
  input: 0x02,
  control: 0x03,
  event: 0x04,
} as const;

/**
 * What a video frame is.
 *
 * With the jpeg codec every tag carries a whole picture. `seed` is the first
 * one after attaching, which is why it is a picture even when the codec is
 * h264: it is there so a viewer has something to show immediately.
 */
export const VIDEO_TAG = {
  config: 0x01,
  key: 0x02,
  delta: 0x03,
  seed: 0x04,
} as const;

export type Frame =
  | { readonly channel: 'video'; readonly streamId: number; readonly tag: number; readonly data: Uint8Array }
  | { readonly channel: 'control'; readonly json: unknown }
  | { readonly channel: 'event'; readonly json: unknown }
  | { readonly channel: 'other' };

/** Read one message off the socket. */
export function decodeFrame(buffer: Uint8Array): Frame | null {
  if (buffer.length < 1) return null;
  const channel = buffer[0];

  if (channel === CHANNEL.video) {
    if (buffer.length < 3) return null;
    return {
      channel: 'video',
      streamId: buffer[1]!,
      tag: buffer[2]!,
      data: buffer.subarray(3),
    };
  }

  if (channel === CHANNEL.control || channel === CHANNEL.event) {
    const text = new TextDecoder().decode(buffer.subarray(1));
    try {
      return {
        channel: channel === CHANNEL.control ? 'control' : 'event',
        json: JSON.parse(text) as unknown,
      };
    } catch {
      return null;
    }
  }

  return { channel: 'other' };
}

/** Write one control message. */
export function encodeControl(message: Record<string, unknown>): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  const out = new Uint8Array(1 + bytes.length);
  out[0] = CHANNEL.control;
  out.set(bytes, 1);
  return out;
}

/** What an input frame carries, by kind. */
export const INPUT_KIND = {
  touch: 0x10,
  multitouch: 0x11,
  key: 0x12,
  button: 0x13,
  scroll: 0x14,
  text: 0x15,
} as const;

export const TOUCH_PHASE = { begin: 0, move: 1, end: 2 } as const;
export const KEY_PHASE = { down: 0, up: 1 } as const;

function inputFrame(streamId: number, kind: number, payloadLength: number): DataView {
  const bytes = new Uint8Array(3 + payloadLength);
  bytes[0] = CHANNEL.input;
  bytes[1] = streamId;
  bytes[2] = kind;
  return new DataView(bytes.buffer);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * A touch, in the picture's own coordinates.
 *
 * `x` and `y` are fractions of the picture rather than pixels, which is what
 * lets the panel be any size: the device is told where on itself it was
 * touched, and the window can be dragged to any shape without a number here
 * changing.
 */
export function encodeTouch(
  streamId: number,
  phase: number,
  x: number,
  y: number,
  seq: number,
  edge = 0
): Uint8Array {
  const view = inputFrame(streamId, INPUT_KIND.touch, 12);
  view.setUint8(3, phase);
  view.setFloat32(4, clamp01(x));
  view.setFloat32(8, clamp01(y));
  view.setUint16(12, seq & 0xffff);
  view.setUint8(14, edge);
  return new Uint8Array(view.buffer);
}

/** A key, by its HID usage, which is what the device speaks. */
export function encodeKey(streamId: number, phase: number, usage: number): Uint8Array {
  const view = inputFrame(streamId, INPUT_KIND.key, 5);
  view.setUint8(3, phase);
  view.setUint32(4, usage >>> 0);
  return new Uint8Array(view.buffer);
}

/** A hardware button: home, lock, volume, and the rest. */
export function encodeButton(streamId: number, phase: number, buttonId: number): Uint8Array {
  const view = inputFrame(streamId, INPUT_KIND.button, 2);
  view.setUint8(3, phase);
  view.setUint8(4, buttonId);
  return new Uint8Array(view.buffer);
}

export function encodeScroll(
  streamId: number,
  dx: number,
  dy: number,
  anchorX: number,
  anchorY: number
): Uint8Array {
  const view = inputFrame(streamId, INPUT_KIND.scroll, 16);
  view.setFloat32(3, dx);
  view.setFloat32(7, dy);
  view.setFloat32(11, clamp01(anchorX));
  view.setFloat32(15, clamp01(anchorY));
  return new Uint8Array(view.buffer);
}

/** Literal text, which is how anything with an input method gets typed. */
export function encodeText(streamId: number, text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const out = new Uint8Array(3 + bytes.length);
  out[0] = CHANNEL.input;
  out[1] = streamId;
  out[2] = INPUT_KIND.text;
  out.set(bytes, 3);
  return out;
}

/** A device as simfarm's `list` reply and `devices` event describe one. */
const WireDevice = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  screen: Schema.optional(
    Schema.Struct({
      width: Schema.optional(Schema.Number),
      height: Schema.optional(Schema.Number),
    })
  ),
  capabilities: Schema.optional(
    Schema.Struct({
      video: Schema.optional(Schema.Array(Schema.String)),
      buttons: Schema.optional(Schema.Array(Schema.String)),
    })
  ),
});

export const WireDeviceList = Schema.Struct({
  devices: Schema.optional(Schema.Array(WireDevice)),
});

/** Translate simfarm's devices into the domain's. */
export function devicesFrom(list: typeof WireDeviceList.Type): ReadonlyArray<SimulatorDevice> {
  return (list.devices ?? []).map((device) => ({
    id: device.id,
    name: device.name?.trim() || device.id,
    kind: device.kind ?? 'unknown',
    booted: device.state === 'booted',
    width: device.screen?.width ?? 0,
    height: device.screen?.height ?? 0,
    showable: (device.capabilities?.video ?? []).includes('jpeg'),
    buttons: device.capabilities?.buttons ?? [],
  }));
}
