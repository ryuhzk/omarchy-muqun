/**
 * Where a simulator farm may be reached, and from which address.
 *
 * One rule, in one place, because getting it wrong does not announce itself.
 * simfarm streams a device with a video decoder that browsers only turn on for
 * a secure origin: an `https` address is one, a plain remote `http` address is
 * not, and loopback is. Point a browser at the wrong one and the socket
 * connects, the server streams, and the picture sits on its first frame.
 */

export interface SimfarmConfig {
  /** Where simfarm answers, as the person wrote it. */
  readonly url: string;
  /** An ssh target for the machine, needed only to carry a plain http one. */
  readonly sshHost: string;
  /** This end of the forward, used only when one is needed. */
  readonly localPort: number;
}

export interface SimulatorStatus {
  readonly booted: number;
  readonly devices: number;
}

/** One simulator, as simfarm describes it. */
export interface SimulatorDevice {
  readonly id: string;
  readonly name: string;
  /** `ios`, `android`, and whatever simfarm grows next. */
  readonly kind: string;
  readonly booted: boolean;
  readonly width: number;
  readonly height: number;
  /**
   * Whether this device can send whole JPEG frames.
   *
   * The panel draws pictures, not video: it has no decoder and no business
   * having one. iOS offers jpeg alongside h264; Android offers h264 only, and
   * saying so is better than showing a picture that never arrives.
   */
  readonly showable: boolean;
  /**
   * The hardware buttons this device has, by name.
   *
   * Offered rather than assumed: an iPhone has a lock button and an Android has
   * a back button, and a panel showing a control the device does not have is a
   * control that does nothing.
   */
  readonly buttons: ReadonlyArray<string>;
}

/**
 * What each button is called on the wire.
 *
 * The names are simfarm's; the numbers are what the device reads.
 */
export const BUTTON_ID: Readonly<Record<string, number>> = {
  home: 0x01,
  lock: 0x02,
  volume_up: 0x03,
  volume_down: 0x04,
  back: 0x05,
  app_switch: 0x06,
  power: 0x07,
  siri: 0x08,
  menu: 0x09,
  camera: 0x0a,
  ringer_mute: 0x0b,
  action: 0x0c,
};

export function isSecure(url: string): boolean {
  return url.startsWith('https://');
}

/** The address a browser may use, which is not always the one given. */
export function browserUrl(config: SimfarmConfig): string {
  if (isSecure(config.url)) return config.url.replace(/\/$/, '');
  return `http://127.0.0.1:${config.localPort}`;
}

/** Where to ask for the farm's status. */
export function statusUrl(config: SimfarmConfig): string {
  return `${browserUrl(config)}/healthz`;
}

/**
 * What a forward has to carry, or null when none is needed.
 *
 * An address that is already secure needs nothing. One that cannot be parsed
 * needs nothing either, because there is nothing to point a forward at; the
 * panel then reports a farm it cannot reach, which is true.
 */
export function forwardFor(
  config: SimfarmConfig
): { readonly remoteHost: string; readonly remotePort: number } | null {
  if (isSecure(config.url) || config.sshHost === '') return null;
  try {
    const parsed = new URL(config.url);
    return {
      remoteHost: parsed.hostname,
      remotePort: parsed.port === '' ? 80 : Number.parseInt(parsed.port, 10),
    };
  } catch {
    return null;
  }
}
