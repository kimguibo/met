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
- Optionally swap to Tone.js Transport for simpler scheduling (still needs a reliable clock source).

## Recent Changes
- **Fixed Follower Start**: The leader now starts on the broadcasted state message, ensuring followers start in sync with the leader.
- **Fixed Start Button for Leader**: The start button is now correctly enabled for the leader after calibration.
- **Fixed `Uncaught ReferenceError: stopCalibrationTimer is not defined`**: Defined `stopCalibrationTimer` before `startCalibrationTimer` to ensure it is available when called.
- **Fixed Server Time Calibration**: Server time calibration is now only attempted on `localhost` to prevent errors on the deployed version.
- **Project Cleanup**: Removed outdated `mystrategy.txt` and `requirements.txt` files.
- **Increased Calibration Precision**: Increased the lead-in time and the number of samples used in calibration for more accurate synchronization.
- **Added LAN Time Anchor**: Added a `/now` endpoint to the server to act as a time anchor. The client now calibrates to this server time for improved sync accuracy.
- **Added Tap Tempo**: Added a "Tap" button to allow users to set the BPM by tapping.
- **Fixed `Uncaught SyntaxError: Unexpected end of input`**: Corrected a missing closing brace in the `connectToLeader` function in `client.js`.
- **Fixed `Uncaught ReferenceError: stopPing is not defined`**: Implemented the missing `startPing` and `stopPing` functions in `client.js` to properly manage the ping timer, resolving disconnection issues for both leader and follower.
- **Fixed Follower Calibration Logic**:
    *   Modified the `calibrateBtn` event listener to allow followers to initiate calibration without an unnecessary alert.
    *   Refactored `runCalibration` to distinguish between leader and follower roles, ensuring appropriate calibration logic for each.
    *   Updated `finishCalibration` to correctly display "Calibrated" for followers and disable the button after calibration.
- **Bilingual User Guide**: Added both English and Korean versions of the user guide to 'index.html' for better accessibility.
- **Fixed downbeat sync**: Follower clients now wait for clock offset to be initialized before scheduling the first beat, preventing phase errors. Clock state is now reset properly on leader change or disconnect.
- **Fixed BPM control for followers**: UI controls for BPM, beats, and lead-in are now correctly disabled for follower clients, preventing local changes from being overwritten.
- Auto-calibration added after BPM/TS changes and on leader assignment.
- Beat/bar durations recomputed on BPM/TS change; start snaps to next bar using current values.
- Audio-clock–based offset and scheduling; visuals driven via `requestAnimationFrame` on the audio clock.
- **Improved Synchronization Accuracy**:
    - Implemented a robust statistical method for clock offset calculation in `addOffsetSample`. This involves maintaining a sliding window of recent samples, filtering outliers based on RTT standard deviation, and calculating the average offset from filtered samples.
    - Replaced the less robust `minRtt` and `bestOffset` variables with this new method.
    - Refactored `startPing` to support flexible ping rates, enabling both fast calibration and slower continuous syncing.
    - Introduced `startContinuousSync` and `stopContinuousSync` to manage continuous background pinging (default 5-second interval) to maintain sync over time.
    - Enhanced `runCalibration` to use a faster ping rate (150ms for 2 seconds) for rapid initial calibration.
    - Adjusted `finishCalibration` to revert to the continuous sync rate after the initial calibration burst.
    - Removed the redundant `resyncTimer` as metronome schedule recalculation is now handled directly by `addOffsetSample` upon each new offset determination.
    - Updated `recalcFromLeaderTime`'s guard condition to correctly check for an established offset using `offsetSamples.length`.
- **Fixed "Two Leaders" Bug**:
    - Modified the `handleMessage` function to ensure that the hub correctly processes leader change messages for itself, preventing a "split-brain" scenario where multiple clients believe they are the leader.
- **Fixed "Follower Not Starting" Bug**:
    - Introduced a `pendingPlayback` flag: if a follower receives a "start" command before its initial calibration is complete, it now stores this command and automatically begins playback once calibration is successfully finished.
    - Updated `applyRemoteState` and `finishCalibration` to correctly implement this logic.
- **Improved Calibration Feedback**:
    - Enhanced the user interface feedback during calibration by setting the `offsetStatus` to "Calibrating…" when a follower connects and begins its automatic synchronization. This message is then replaced by the calculated offset value once calibration is complete.