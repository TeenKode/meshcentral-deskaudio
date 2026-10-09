# Desktop Audio for MeshCentral

[Русская версия](README.ru.md)

A [MeshCentral](https://github.com/Ylianst/MeshCentral) plugin that lets you hear what plays on a remote
computer's speakers, live, in your browser — alongside the remote desktop.

* Works on **Windows 7–11** (x86, x64, ARM64) and **Linux** (PulseAudio or PipeWire).
* **Opus** audio by default (~32 kbit/s) on Windows; ADPCM on Linux and as a fallback.
* Nothing to install on the remote computer: the agent receives a small capture helper from your server.
* Several people (or one account on several PCs) can listen to the same device at once.
* Respects MeshCentral's desktop permissions and user-consent settings; every session is logged.

## Requirements

* MeshCentral 1.1.0 or newer with plugins enabled.
* A browser with Web Audio: Chrome, Edge, Firefox or Safari. Opus needs WebCodecs; without it the plugin
  falls back to ADPCM automatically.
* On Linux devices: `parec` (`pulseaudio-utils`) or `pw-record` (`pipewire-bin`).
* macOS devices are not supported.

## Installation

1. Enable plugins in `meshcentral-data/config.json` and restart MeshCentral:

   ```json
   "settings": { "plugins": { "enabled": true } }
   ```

2. In MeshCentral open **My Server → Plugins → Download plugin** and paste:

   ```
   https://raw.githubusercontent.com/TeenKode/meshcentral-deskaudio/main/config.json
   ```

3. Enable the plugin in the list.
4. **Restart MeshCentral.** The plugin's agent code is built into the agent core only when the server
   starts; agents pick up the new core when they reconnect.

Do the same restart after every plugin update.

## Usage

* Open a device: the **Audio** tab has the Listen button, volume, settings and a log.
* On the **Desktop** tab, the **Audio** button in the toolbar starts and stops listening without leaving the
  remote desktop. Disconnecting the desktop stops the audio too.
* *Listen when connecting to the desktop* starts audio automatically with each desktop session.

Settings on the Audio tab are saved in the browser and apply immediately:

| Setting | Options |
| --- | --- |
| Codec | Auto (Opus if supported), Opus, ADPCM, PCM |
| Opus bitrate | 24, 32, 48 kbit/s |
| Sample rate (ADPCM/PCM) | 8, 16, 24 kHz |
| Don't send silence | saves traffic while nothing plays |
| Buffer / latency | Low, Medium, High |

The buffer adapts by itself: if audio arrives with gaps, it grows (up to 1 s) and shrinks back once the
connection is steady. The learned size is remembered per device for a day.

## Permissions and consent

* Listening requires the **Remote Control** right on the device. Users restricted with **No Desktop** cannot
  listen.
* If the device group or user requires **desktop consent**, the remote user is asked to allow listening
  first. With **desktop notification**, the remote user gets a notification telling who is listening.
* With the **connection toolbar** flag, a bar on the remote screen shows who is listening for as long as
  audio is on. Closing the bar stops listening for everyone.
* Options of the open desktop session count too: after connecting with **Ask Consent**, **Privacy Bar** or
  **Ask Consent + Bar** from the Connect menu, turning audio on asks or shows the bar the same way.
* Every start and stop (with duration) is recorded in the device's event log.

Use the plugin in line with your organisation's policies and applicable law.

## Server settings (optional)

In `meshcentral-data/config.json`. Changes apply to the next listening session, no restart needed.

```json
"settings": {
  "plugins": {
    "enabled": true,
    "deskaudio": {
      "maxListenersPerNode": 10,
      "maxStreams": 50,
      "spawnAsUser": false,
      "consentMessage": "User {0} wants to listen to this computer's audio. Allow?",
      "notifyMessage": "User {0} is listening to this computer's audio.",
      "barMessage": "Desktop audio is being listened to by: {0}"
    }
  }
}
```

| Key | Meaning | Default |
| --- | --- | --- |
| `maxListenersPerNode` | listeners per device (1–100) | 10 |
| `maxStreams` | simultaneous audio streams on the server | 50 |
| `spawnAsUser` | Windows: run the capture helper in the logged-in user's session | `false` |
| `consentMessage` | consent prompt on the remote computer, `{0}` = user name | text above |
| `notifyMessage` | notification on the remote computer, `{0}` = user name | text above |
| `barMessage` | listening bar on the remote computer, `{0}` = who is listening | text above |

## Troubleshooting

Open the **Log** on the Audio tab and copy it; it shows each step from the request to playback.

* **Silence** — Windows sends no audio while nothing is playing; this is normal.
* **The log says the agent core is outdated** — restart MeshCentral, then reconnect the agent.
* **Antivirus blocks the helper** — the helper runs from the agent's folder as
  `C:\Program Files\Mesh Agent\deskaudio-helper.exe`. Add that path to the exclusions if needed.
* **No sound on Windows although something plays** — try `"spawnAsUser": true`.
* **RDP sessions** — only the console's audio device is captured, not the audio of RDP sessions.
* **Linux with several logged-in users** — the user of the active session is captured.

## How it works

```
browser ◀── audio ── MeshCentral server ◀── audio ── agent ◀── capture helper
```

On Windows a native helper (`helpers/deskaudio-*.exe`) captures the default output device with WASAPI
loopback, resamples it with SpeexDSP and encodes Opus or ADPCM. It follows output device changes. The server
signs it with MeshCentral's agent code-signing certificate, if one is configured. The agent downloads it once and keeps it,
checking its SHA-384 hash. On Linux the agent runs `parec` or `pw-record` as the active session's user.
Audio travels over the agent's existing control channel; the browser decodes it and plays it through an
AudioWorklet.

## Development

```sh
npm test                    # unit tests, Node 20, no dependencies
helpers/build-opus.sh       # build libopus 1.5.2 for MinGW
helpers/build-native.sh     # cross-compile the Windows helpers (MinGW-w64)
```

The helper build is reproducible: CI rebuilds the `.exe` files and fails if they differ from the committed
ones. CI also captures real audio on a Windows runner (virtual sound card) and tests playback in Chromium.

## License

[Apache License 2.0](LICENSE). The Windows helpers include SpeexDSP and libopus (BSD licenses) — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
