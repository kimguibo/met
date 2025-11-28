# Multi-User Browser Metronome — Design

## Goals & Constraints
- Multi-user metronome that stays in sync over the same Wi‑Fi network.
- Runs in browsers on laptop + iPhone; no native installs.
- No physical server available.
- Remote Docker container exists only for development, not long-term serving/hosting; production use runs on a laptop inside the same Wi‑Fi.
- No build tools available for users; browser assets must be plain static files (no bundler, no transpile).
- No static IP; users will type a LAN URL (e.g., `http://192.168.x.x:3000`) while on the same Wi‑Fi.
- Main goal: phone-only use (all participants on phones); laptop is optional but not required as host.
- Free, simple stack; visual + audio ticks; supports arbitrary time signatures.
- Works offline after peers connect to the signaling host (progressive enhancement).

## High-Level Approach
- Use PeerJS cloud signaling (free, build-free) to negotiate WebRTC data channels; no custom server required at runtime.
- First user to join a room claims a deterministic hub peer ID for that room; others connect to that hub.
- Any user can become leader; leader shares tempo, time signature, and start time (leader clock). Followers estimate offset via ping/pong to leader and schedule audio with Web Audio for low jitter.
- Visual ticks render a moving indicator over the beat slots.

## Architecture
- **Signaling**: PeerJS cloud signaling via CDN script + default PeerJS server; no deployment needed.
  - Deterministic room hub ID: `metronome-<room>-hub`; first to claim becomes hub. Others connect to hub.
  - Hub relays leader/state messages to all peers; hub can also be leader but any peer may take leadership.
- **Client (Browser)**: Single-page HTML/JS (no framework, no build step).
  - WebRTC data channel (via PeerJS) to hub; direct channel to leader for ping/pong clock offset.
  - Leader broadcast: tempo, time signature, start time (leader clock); followers convert via offset and schedule audio.
  - Pre-start calibration (rapid ping/pong to leader) to estimate offset before enabling Start.
  - Web Audio API scheduler with short look-ahead; visual grid stays in sync.

## Sync Strategy
- **Clock Alignment**: Followers ping/pong the leader over a direct data channel to estimate RTT/2 offset to the leader’s `performance.now()`. A short calibration burst runs before Start; periodic pings keep offset fresh.
- **Leader Broadcast**: Leader sends `{bpm, beatsPerBar, leadInMs, startAtLeader}` via hub; `startAtLeader` is leader-clock time.
- **Start/Recover**: Followers convert `startAtLeader` using their offset, schedule ahead, and if they join mid-loop recompute beat index from elapsed time.
- **Fault Tolerance**: Any peer may press “Become leader”; hub relays the new leader ID to the room.

## Tap Tempo Logic
- A "Tap" button will be added to the UI.
- When the user taps the button, the timestamp of the tap is recorded.
- A history of the last N taps (e.g., 4 taps) is maintained.
- The average interval between these taps is calculated.
- If the user stops tapping for a certain period (e.g., 2 seconds), the tap history is cleared.
- The calculated average interval is converted to BPM: `BPM = 60 / average_interval_in_seconds`.
- The BPM input field is updated with the new value.
- If the user is the leader, the new BPM is broadcast to all followers.

## Data Model (messages)
- `hello`: client → hub to register.
- `leader`: hub ↔ peers to announce the current leader ID.
- `state`: leader → hub → peers `{bpm, beatsPerBar, leadInMs, startAtLeader, playing}`.
- `ping/pong`: follower ↔ leader direct channel for offset calculation.

## UI/UX Outline
- Minimal single page: room code input, "Host"/"Join" buttons, tempo slider/input, beats-per-bar selector, play/stop toggle, mute toggle.
- **Tap Tempo**: A "Tap" button allows the user to set the BPM by tapping at the desired speed.
- Visual ticks: render circles/slots; active slot highlighted as in examples:
  - 4/4: `( v - - - )` style loop.
  - 5/4: `( v - - - - )` style loop.
- Audio: short click sample or oscillator blip; accent first beat (higher pitch/volume).
- Status: connection state, leader indicator, sync quality badge (offset estimate).

## Testing Plan
- Desktop Chrome + Mobile Safari over same Wi‑Fi; verify:
  - Join flow, leader/follower roles, reconnections.
  - Stability at various BPM (e.g., 40–200) and time signatures (4/4, 5/4, 7/8).
  - Drift by recording with phone mic vs. laptop mic and visually inspecting waveform alignment.
  - Network resilience: toggle Wi‑Fi off/on to ensure rejoin works without refresh.

## Potential Issues & Mitigations
- **Safari autoplay restrictions**: require user gesture before starting audio context.
- **Local time drift**: periodic offset checks + leader nudge.
- **Packet loss**: periodic full `state` broadcasts, not just deltas.
- **NAT/Firewall**: Prefer same-network peer-to-peer; provide TURN-free STUN (public Google STUN) for ICE.

## Implementation Outline
- `index.html`: UI + controls; loads PeerJS from CDN.
- `client.js`: PeerJS setup, hub/leader logic, clock sync (ping/pong), scheduler, visuals.
- `style.css`: Simple layout; responsive for phone widths.
- `server.js`: optional static file server for local dev only (not needed on GitHub Pages).