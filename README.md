# Muqun for Omarchy

The coding agents running on your other machines, from the Omarchy bar.

The bar carries one number: how many agents are waiting on a human. Clicking it
opens a window holding the pane that is asking, live, with the keyboard pointed
at it. Typing goes to that pane and its own echo is what comes back, which is
what happens when you log in.

![The window: agents and terminals on the left, a live pane in the middle, a
simulator on the right](preview.png)

## What it is

A machine is one ssh destination you can already reach. Nothing else is
configured. The plugin connects, asks the machine what it has, and shows what is
running on it.

There is no pairing, no URL, no token and no QR code anywhere in this plugin.
Muqun's iOS and Android apps need those because a phone has no ssh agent and no
`~/.ssh/config`. A desktop has both, so this uses them.

- **The bar** shows how many agents are blocked, and nothing when none are.
- **The list** has two sections per machine, each named for the tool behind it:
  the agents herdr is running, and the terminals tmux holds. Right-click a row
  to close it.
- **The terminal** is a real one. It is not a picture of a pane refreshed on a
  timer: the plugin holds a pty open over ssh and renders what comes back, so
  editors, pagers, full-screen programs, colour, the mouse and Ctrl-C all work.
- **New terminals** open on any machine that has tmux, and outlive the window.
- **Pasting an image** works. An agent reads a picture from a path and the path
  has to mean something on the machine the agent runs on, so the picture is sent
  there and the pane is handed where it landed.
- **Simulators** appear in a strip down the right when a simfarm server is
  configured, with the device's own buttons, and they are operable.

## Requirements

- Omarchy with the Quickshell-based shell (Quattro or newer).
- [Bun](https://bun.sh) 1.4 or newer on this machine. The plugin's backend runs
  on it. `bun --version` should print something.
- OpenSSH on this machine, and an ssh destination you can already reach without
  being prompted. The plugin connects with `BatchMode=yes`, so key
  authentication has to work on its own. `wl-clipboard` for copy and paste.
- On the machine you are watching: [herdr](https://herdr.dev) for agents, tmux
  for terminals, or both. Neither is required by the other, and what a machine
  has is probed rather than declared.
- Optional: a [simfarm](https://github.com/BANG88/simfarm) server for the
  simulator strip.

No dependency is installed for you, and nothing here runs as root.

## Install

```bash
omarchy plugin add https://github.com/ryuhzk/omarchy-muqun --enable
```

Then put the widget on the bar, from **Setup → Plugins → Muqun**, or:

```bash
omarchy bar put ryuhzk.muqun --section right
```

The first time you open the window it asks for a machine. Type an ssh
destination the way you would type it in a terminal — a name from your ssh
config, or `you@machine` — and press Add. The machine name in the window's
header opens that list again later.

## Remove

```bash
omarchy plugin remove ryuhzk.muqun
```

That takes it off the bar and out of your configuration.

Removing the plugin leaves the machines it was watching untouched: nothing is
ever installed on them.

## Configure

Everything is optional except a machine, and a machine can be added from the
window. The rest is in **Setup → Plugins → Muqun**:

| Setting | What it is |
|---|---|
| `hosts` | Colon-separated ssh destinations, for example `you@machine:build-box`. |
| `simfarmUrl` | Where a simfarm server answers. Empty hides the simulators. |
| `simfarmSshHost` | An ssh destination used to tunnel a plain-http simfarm. |
| `simfarmLocalPort` | The local end of that tunnel. |
| `panelWidth` | A starting width, used only when the screen size is unknown. |

## Keys

| Key | What it does |
|---|---|
| `ctrl shift c` | Copy the selection. Drag over the output to select. |
| `ctrl shift v` | Paste. Text is typed; an image goes to the machine and its path is typed. |
| `ctrl shift b` | Show or hide the pane list. |
| `ctrl shift s` | Show or hide the simulators. |
| `esc` | Close the window. |

Everything else goes to the pane, including `ctrl c`, `ctrl b` and `ctrl s`,
because those belong to the program on the other side.

## What it touches

- **Reads** your ssh configuration by running `ssh`, the same way you do. It
  never reads your keys, and it holds no credentials of its own.
- **Writes** its list of machines back into `~/.config/omarchy/shell.json`, and
  only when you add or remove one in the window. Nothing else in that file is
  changed, and no other configuration is written.
- **Writes** a control socket and, while the simulator strip is open, two video
  frames, into `$XDG_RUNTIME_DIR`. Nothing goes to `/tmp`.
- **Runs** on the machines you name: `herdr` and `tmux`, to list what is there
  and to attach to it. It installs nothing on them.
- **Writes** one kind of file on them, and only when you paste a picture: the
  picture itself, into `~/.cache/omarchy-muqun/incoming`, owner-only, under a
  name built from the clock. Only PNG, JPEG, WebP and GIF, checked against the
  bytes rather than trusted from the clipboard's own label, and capped at 16 MB.
  Nothing else is ever sent.
- **Opens** a link a pane printed, with `xdg-open`, and only when it is `http`
  or `https`. A pane cannot make a clickable launcher.
- **Never** asks for elevated privileges, installs a background service,
  invokes a package manager, or reaches a network address you did not give it.

## How it works

Everything that touches a network lives in a sidecar, a Bun process the panel
starts and speaks JSON lines to. The panel holds no credentials, no protocol
knowledge and no parsing: it draws what arrives and sends what was typed.

The sidecar is written in [Effect](https://effect.website), in layers that point
inward: `domain` knows the rules of a terminal and nothing else, `application`
is the use cases written against ports, `adapters` are ssh, herdr, tmux, simfarm
and the terminal itself, and `interface` is the line protocol.

The terminal is real. `backend/domain/vt-screen.ts` is a screen with scrollback,
alternate screens, scroll regions and wide characters; `backend/adapters/vt-parser.ts`
drives it from the escape sequences. The two subtle parts — what an SGR
parameter list means and how wide a character is — come from
[libghostty-vt](https://ghostty.org/docs/vt) when it is installed, with a
fallback held to the same tests when it is not.

Nothing polls. A blocking `herdr agent wait` is held open per machine, so the
bar's number changes when the agent does.

## Develop

```bash
bun install
bun test
```

Live checks against a real machine live in `scripts/` and are not part of the
suite. Each says what it needs:

```bash
MUQUN_ALIAS=you@machine bun run scripts/check-sources.ts
```

After changing anything under `backend/`, restart the shell: the sidecar is a
separate process and only a restart picks it up.

```bash
omarchy restart shell
```

## License

MIT. See [LICENSE](LICENSE).
