# Dev Log

## Current Status
- Build-free browser metronome using WebRTC (PeerJS) with audio-clock scheduling.
- Leader sends future bar-aligned start times; followers schedule via AudioContext with offset.
- Auto-calibration runs on leader assignment and after tempo/time-signature changes; manual calibrate remains.
- Visuals are driven from the audio clock to stay aligned with clicks.
- Core synchronization of tempo and downbeat is now stable.

## Known Issues / Risks
- PeerJS cloud signaling jitter: offsets can vary, which may affect sync precision over unstable networks.
- No dedicated time anchor; the leader's clock is the anchor, so path jitter between the leader and followers can affect offset accuracy.

## Next Options
- Add a Tap Tempo feature for intuitive BPM setting.
- Add a tiny LAN `/now` endpoint to use as a time anchor (best for sync on same Wi‑Fi).
- Increase lead-in and sample count during calibration.
- Optionally swap to Tone.js Transport for simpler scheduling (still needs a reliable clock source).

## Recent Changes
- **Fixed downbeat sync**: Follower clients now wait for clock offset to be initialized before scheduling the first beat, preventing phase errors. Clock state is now reset properly on leader change or disconnect.
- **Fixed BPM control for followers**: UI controls for BPM, beats, and lead-in are now correctly disabled for follower clients, preventing local changes from being overwritten.
- Auto-calibration added after BPM/TS changes and on leader assignment.
- Beat/bar durations recomputed on BPM/TS change; start snaps to next bar using current values.
- Audio-clock–based offset and scheduling; visuals driven via `requestAnimationFrame` on the audio clock.