// Build-free client using PeerJS cloud signaling; no backend required at runtime.
// One peer acts as the room hub (deterministic ID). First to claim that ID wins.
// Leader can be anyone; state is broadcast via the hub. Direct leader links are
// used for ping/pong time offset estimation.

const roomInput = document.getElementById('room');
const connectBtn = document.getElementById('connect');
const disconnectBtn = document.getElementById('disconnect');
const connectionStatus = document.getElementById('connectionStatus');
const leaderStatus = document.getElementById('leaderStatus');
const offsetStatus = document.getElementById('offsetStatus');
const shareUrlInput = document.getElementById('shareUrl');
const copyUrlBtn = document.getElementById('copyUrl');
const peersLabel = document.getElementById('peers');
const leaderBtn = document.getElementById('becomeLeader');
const bpmInput = document.getElementById('bpm');
const beatsInput = document.getElementById('beats');
const leadInInput = document.getElementById('leadIn');
const calibrateBtn = document.getElementById('calibrate');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const muteInput = document.getElementById('mute');
const meter = document.getElementById('meter');

let peer = null;
let hubId = null;
let isHub = false;
let hubConn = null;
let selfId = null;
let leaderId = null;
let directLeaderConn = null;
let pingTimer = null;
let resyncTimer = null;
let calibrationTimer = null;
let offsetMs = 0;
let offsetAudioSec = 0;
let pingIntervalMs = 450;
let offsetSamples = []; // Stores objects like { offset: number, rtt: number }
const MAX_OFFSET_SAMPLES = 20; // Number of samples to keep in the sliding window

let peers = new Set();
let peerCount = 1;
let currentState = {
  bpm: Number(bpmInput.value),
  beatsPerBar: Number(beatsInput.value),
  leadInMs: Number(leadInInput.value),
  startAtLeaderAudio: null, // in seconds, leader audio clock
  playing: false,
};
let beatSec = 60 / currentState.bpm;
let barSec = beatSec * currentState.beatsPerBar;

let audioCtx = null;
let schedulerId = null;
let nextBeatTime = null;
let pendingPlayback = false;
let currentBeatIndex = 0;
let visualRaf = null;

shareUrlInput.value = location.href;
copyUrlBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareUrlInput.value);
    copyUrlBtn.textContent = 'Copied';
    setTimeout(() => (copyUrlBtn.textContent = 'Copy'), 1200);
  } catch (err) {
    copyUrlBtn.textContent = 'Copy failed';
    setTimeout(() => (copyUrlBtn.textContent = 'Copy'), 1400);
  }
});

connectBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  if (!room) {
    alert('Enter a room name');
    return;
  }
  if (peer) return;
  connect(room);
});

disconnectBtn.addEventListener('click', teardown);

leaderBtn.addEventListener('click', () => {
  if (!peer) {
    alert('Connect to a room first.');
    return;
  }
  announceLeader(selfId);
  startBtn.disabled = true;
  calibrateBtn.disabled = false;
  calibrateBtn.textContent = 'Calibrate';
});

calibrateBtn.addEventListener('click', () => {
  if (!isLeader()) {
    alert('Only the leader can initiate calibration. Take leader and retry.');
    return;
  }
  runCalibration();
});

startBtn.addEventListener('click', () => {
  if (!isLeader()) {
    alert('Only the leader can start. You can take leader and try again.');
    return;
  }
  ensureAudio();
  const nowLeaderAudio = audioCtx.currentTime;
  let startAtLeaderAudio = nowLeaderAudio + currentState.leadInMs / 1000;
  startAtLeaderAudio = Math.ceil(startAtLeaderAudio / barSec) * barSec; // snap to next bar
  startPlayback(startAtLeaderAudio);
  currentState.startAtLeaderAudio = startAtLeaderAudio;
  currentState.playing = true;
  broadcastState();
});

stopBtn.addEventListener('click', () => {
  if (!isLeader()) {
    alert('Only the leader can stop.');
    return;
  }
  stopPlayback();
  currentState.playing = false;
  currentState.startAtLeader = null;
  broadcastState();
});

bpmInput.addEventListener('input', () => {
  currentState.bpm = Number(bpmInput.value);
  beatSec = 60 / currentState.bpm;
  barSec = beatSec * currentState.beatsPerBar;
  if (isLeader()) {
    startBtn.disabled = true;
    calibrateBtn.disabled = false;
    calibrateBtn.textContent = 'Calibrate';
    stopPlayback();
    autoCalibrate();
    broadcastState();
  }
});

beatsInput.addEventListener('input', () => {
  currentState.beatsPerBar = Number(beatsInput.value);
  renderMeter(currentState.beatsPerBar);
  beatSec = 60 / currentState.bpm;
  barSec = beatSec * currentState.beatsPerBar;
  if (isLeader()) {
    startBtn.disabled = true;
    calibrateBtn.disabled = false;
    calibrateBtn.textContent = 'Calibrate';
    stopPlayback();
    autoCalibrate();
    broadcastState();
  }
});

leadInInput.addEventListener('input', () => {
  currentState.leadInMs = Number(leadInInput.value);
});

function connect(room) {
  setConnectionStatus('Connecting…');
  hubId = `metronome-${room}-hub`;

  tryCreateHubPeer(hubId)
    .then(({ instance, hub }) => {
      peer = instance;
      isHub = hub;
      selfId = peer.id;
      registerPeerHandlers();
      setConnectionStatus(isHub ? 'Connected (hub)' : 'Connected');
      peers.add(selfId);
      peerCount = peers.size;
      updatePeerCount();
      if (!isHub) {
        connectToHub();
      } else {
        leaderId = leaderId || selfId;
        setLeaderStatus('Leader: you');
        startBtn.disabled = true;
        calibrateBtn.disabled = false;
        calibrateBtn.textContent = 'Calibrate';
        autoCalibrate();
        broadcastLeader();
        broadcastPeerCount();
      }
    })
    .catch((err) => {
      console.error(err);
      setConnectionStatus('Failed to connect');
      alert('Failed to connect. Check network and retry.');
      teardown();
    });
}

function tryCreateHubPeer(id) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const hubPeer = new Peer(id, { debug: 0 });
    hubPeer.on('open', () => {
      if (settled) return;
      settled = true;
      resolve({ instance: hubPeer, hub: true });
    });
    hubPeer.on('error', (err) => {
      if (settled) return;
      if (err.type === 'unavailable-id') {
        hubPeer.destroy();
        const clientPeer = new Peer(undefined, { debug: 0 });
        clientPeer.on('open', () => resolve({ instance: clientPeer, hub: false }));
        clientPeer.on('error', (e) => reject(e));
      } else {
        reject(err);
      }
    });
  });
}

function registerPeerHandlers() {
  peer.on('connection', (conn) => {
    setupConnection(conn, true);
  });
  peer.on('error', (err) => {
    console.error('peer error', err);
  });
}

function connectToHub() {
  hubConn = peer.connect(hubId, { reliable: true });
  setupConnection(hubConn, false);
}

function setupConnection(conn, incoming) {
  conn.on('open', () => {
    if (!incoming && conn === hubConn) {
      send(conn, { type: 'hello', id: selfId });
    }
    if (isHub && incoming) {
      peers.add(conn.peer);
      peerCount = peers.size;
      updatePeerCount();
      broadcastPeerCount();
    }
  });

  conn.on('data', (msg) => handleMessage(conn, msg));
  conn.on('close', () => {
    if (isHub && peers.has(conn.peer)) {
      peers.delete(conn.peer);
      peerCount = peers.size;
      updatePeerCount();
      broadcastPeerCount();
    }
    if (conn === directLeaderConn) {
      directLeaderConn = null;
      stopPing();
    }
  });
}

function handleMessage(conn, msg) {
  const data = typeof msg === 'string' ? JSON.parse(msg) : msg;

  if (isHub) {
    if (data.type === 'hello') {
      peers.add(data.id);
      peerCount = peers.size;
      updatePeerCount();
      if (!leaderId) {
        leaderId = selfId;
        setLeaderStatus('Leader: you');
        broadcastLeader();
      }
      broadcastPeerCount();
      if (leaderId) send(conn, { type: 'leader', id: leaderId });
      if (currentState) send(conn, { type: 'state', data: currentState });
      return;
    }
    // For leader and state changes, the hub's job is just to broadcast.
    // After broadcasting, it will fall through to the common logic below
    // to update its own state, just like any other peer.
    if (data.type === 'leader') {
      broadcastLeader(conn.peer);
    }
    if (data.type === 'state') {
      broadcastState(conn.peer);
    }
  }

  if (data.type === 'leader') {
    leaderId = data.id;
    setLeaderStatus(leaderId === selfId ? 'Leader: you' : `Leader: ${leaderId}`);
    if (leaderId && leaderId !== selfId) {
      connectToLeader(leaderId);
    }
    if (isLeader()) {
      startBtn.disabled = true;
      calibrateBtn.disabled = false;
      calibrateBtn.textContent = 'Calibrate';
      autoCalibrate();
      bpmInput.disabled = false;
      beatsInput.disabled = false;
      leadInInput.disabled = false;
    } else {
      startBtn.disabled = true;
      calibrateBtn.disabled = true;
      calibrateBtn.textContent = 'Calibrate';
      bpmInput.disabled = true;
      beatsInput.disabled = true;
      leadInInput.disabled = true;
    }
    return;
  }

  if (data.type === 'state') {
    applyRemoteState(data.data);
    return;
  }

  if (data.type === 'peers') {
    peerCount = data.count;
    updatePeerCount();
    return;
  }

  if (data.type === 'ping' && isLeader()) {
    ensureAudio();
          send(conn, {
            type: 'pong',
            t0: data.t0,
            leaderNow: performance.now(),
            leaderAudioTime: audioCtx.currentTime,
          });    return;
  }

  if (data.type === 'pong' && directLeaderConn && conn.peer === directLeaderConn.peer) {
    const t1 = performance.now();
    const rtt = t1 - data.t0;
    const rttSec = rtt / 1000;
    ensureAudio();
    const localAudioNow = audioCtx.currentTime;
    const newOffsetAudio = data.leaderAudioTime - (localAudioNow + rttSec / 2);
    addOffsetSample(newOffsetAudio, rtt);
    return;
  }
}

function send(conn, payload) {
  try {
    conn.send(JSON.stringify(payload));
  } catch (err) {
    console.error('send error', err);
  }
}

function announceLeader(id) {
  leaderId = id;
  setLeaderStatus(leaderId === selfId ? 'Leader: you' : `Leader: ${leaderId}`);
  if (isHub) {
    broadcastLeader();
  } else if (hubConn?.open) {
    send(hubConn, { type: 'leader', id });
  }
}

function broadcastLeader(excludePeer) {
  if (!isHub) return;
  peer.connections &&
    Object.values(peer.connections).forEach((arr) =>
      arr.forEach((c) => {
        if (excludePeer && c.peer === excludePeer) return;
        if (c.open) send(c, { type: 'leader', id: leaderId });
      })
    );
}

function broadcastState(excludePeer) {
  if (isHub) {
    peer.connections &&
      Object.values(peer.connections).forEach((arr) =>
        arr.forEach((c) => {
          if (excludePeer && c.peer === excludePeer) return;
          if (c.open) send(c, { type: 'state', data: currentState });
        })
      );
  } else if (hubConn?.open) {
    send(hubConn, { type: 'state', data: currentState });
  }
}

function broadcastPeerCount() {
  if (!isHub) return;
  const payload = { type: 'peers', count: peers.size };
  peer.connections &&
    Object.values(peer.connections).forEach((arr) =>
      arr.forEach((c) => {
        if (c.open) send(c, payload);
      })
    );
}

function connectToLeader(id) {
  if (directLeaderConn && directLeaderConn.peer === id) return;
  if (directLeaderConn) {
    directLeaderConn.close();
    stopPing();
  }
  offsetSamples.length = 0;
  setOffsetStatus('Calibrating…');

  directLeaderConn = peer.connect(id, { reliable: true });
  directLeaderConn.on('open', () => {
    startContinuousSync(); // Start the continuous sync
    startCalibrationTimer();
  });
  directLeaderConn.on('data', (msg) => handleMessage(directLeaderConn, msg));
  directLeaderConn.on('close', () => {
    stopPing();
    stopContinuousSync(); // Use the new stop function
    stopCalibrationTimer();
    startBtn.disabled = true;
    calibrateBtn.disabled = true;
    calibrateBtn.textContent = 'Calibrate';
  });
}

function startContinuousSync() {
  stopContinuousSync(); // Ensure no multiple timers
  pingIntervalMs = 5000; // Default slow ping for continuous sync (e.g., every 5 seconds)
  startPing(pingIntervalMs);
  // The recalculation is now handled by addOffsetSample, which is called on each pong
}

function stopContinuousSync() {
  stopPing(); // Stop the pinging
  // No separate resync timer anymore
}

function applyRemoteState(data) {
  currentState = { ...currentState, ...data };
  bpmInput.value = currentState.bpm;
  beatsInput.value = currentState.beatsPerBar;
  leadInInput.value = currentState.leadInMs;
  renderMeter(currentState.beatsPerBar);
  beatSec = 60 / currentState.bpm;
  barSec = beatSec * currentState.beatsPerBar;

  if (data.playing && data.startAtLeaderAudio !== null) {
    ensureAudio();
    if (offsetSamples.length === 0) {
      // We're not calibrated yet. Wait until calibration finishes.
      pendingPlayback = true;
    } else {
      startPlayback(data.startAtLeaderAudio);
    }
  } else if (!data.playing) {
    pendingPlayback = false; // Reset if we get a stop message
    stopPlayback();
  }
  startBtn.disabled = true;
  calibrateBtn.disabled = true;
  bpmInput.disabled = true;
  beatsInput.disabled = true;
  leadInInput.disabled = true;
}

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } else if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

function startPlayback(startAtLeader) {
  ensureAudio();
  currentState.startAtLeaderAudio = startAtLeader;
  currentState.playing = true;
  recalcFromLeaderTime();
  if (!schedulerId) schedulerId = setInterval(schedulerTick, 20);
  startVisualLoop();
}

function stopPlayback() {
  currentState.playing = false;
  currentState.startAtLeaderAudio = null;
  nextBeatTime = null;
  currentBeatIndex = 0;
  if (schedulerId) {
    clearInterval(schedulerId);
    schedulerId = null;
  }
  stopResync();
  stopVisualLoop();
  highlightBeat(-1);
}

function recalcFromLeaderTime() {
  // Don't calculate timing until we have an offset from the leader.
  if (!isLeader() && offsetSamples.length === 0) return;

  if (!audioCtx || !currentState.playing || currentState.startAtLeaderAudio === null) return;
  const localAudioNow = audioCtx.currentTime + offsetAudioSec;
  const beatSec = 60 / currentState.bpm;
  const elapsed = localAudioNow - currentState.startAtLeaderAudio;
  const beatNumber = Math.max(0, Math.floor(elapsed / beatSec));
  currentBeatIndex = beatNumber % currentState.beatsPerBar;
  const beatStartLeader = currentState.startAtLeaderAudio + beatNumber * beatSec;
  const offsetSec = beatStartLeader - localAudioNow;
  nextBeatTime = audioCtx.currentTime + Math.max(0, offsetSec);
}

function schedulerTick() {
  if (!audioCtx || !currentState.playing || nextBeatTime === null) return;
  const lookAhead = 0.06;
  const beatDur = 60 / currentState.bpm;
  while (nextBeatTime < audioCtx.currentTime + lookAhead) {
    scheduleClick(nextBeatTime, currentBeatIndex);
    nextBeatTime += beatDur;
    currentBeatIndex = (currentBeatIndex + 1) % currentState.beatsPerBar;
  }
}

function scheduleClick(time, beatIndex) {
  if (muteInput.checked) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const isAccent = beatIndex === 0;
  const volume = isAccent ? 0.28 : 0.18;
  osc.type = 'square';
  osc.frequency.setValueAtTime(isAccent ? 1100 : 850, time);
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(volume, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.09);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(time);
  osc.stop(time + 0.12);
}

function renderMeter(beats) {
  meter.innerHTML = '';
  for (let i = 0; i < beats; i += 1) {
    const div = document.createElement('div');
    div.className = 'beat';
    div.textContent = i === 0 ? 'v' : '-';
    meter.appendChild(div);
  }
}

function highlightBeat(index) {
  const children = meter.querySelectorAll('.beat');
  children.forEach((child, idx) => {
    child.classList.toggle('active', idx === index);
  });
}

function startVisualLoop() {
  stopVisualLoop();
  const loop = () => {
    if (!audioCtx || !currentState.playing || currentState.startAtLeaderAudio === null) return;
    const localAudioNow = audioCtx.currentTime + offsetAudioSec;
    const beatSec = 60 / currentState.bpm;
    const elapsed = localAudioNow - currentState.startAtLeaderAudio;
    if (elapsed >= 0) {
      const beatNumber = Math.floor(elapsed / beatSec);
      highlightBeat(beatNumber % currentState.beatsPerBar);
    }
    visualRaf = requestAnimationFrame(loop);
  };
  visualRaf = requestAnimationFrame(loop);
}

function stopVisualLoop() {
  if (visualRaf) {
    cancelAnimationFrame(visualRaf);
    visualRaf = null;
  }
}

function updatePeerCount() {
  peersLabel.textContent = peerCount.toString();
}

function setConnectionStatus(text) {
  connectionStatus.textContent = text;
}

function setLeaderStatus(text) {
  leaderStatus.textContent = text;
}

function setOffsetStatus(offset) {
  if (Number.isFinite(offset)) {
    offsetStatus.textContent = `Offset: ${Math.round(offset)} ms`;
  } else {
    offsetStatus.textContent = 'Offset: —';
  }
}

function addOffsetSample(newOffsetAudioSec, rtt) {
  // Add new sample
  offsetSamples.push({ offset: newOffsetAudioSec, rtt: rtt });
  if (offsetSamples.length > MAX_OFFSET_SAMPLES) {
    offsetSamples.shift(); // Remove oldest sample
  }

  // Ensure we have enough samples to perform meaningful statistics
  if (offsetSamples.length < 3) { // Need at least 3 samples to calculate std dev
    const sum = offsetSamples.reduce((acc, s) => acc + s.offset, 0);
    offsetAudioSec = sum / offsetSamples.length;
    offsetMs = offsetAudioSec * 1000;
    setOffsetStatus(offsetMs);
    recalcFromLeaderTime();
    return;
  }

  // 1. Calculate median RTT and std deviation of RTTs
  const rtts = offsetSamples.map(s => s.rtt).sort((a, b) => a - b);
  const mid = Math.floor(rtts.length / 2);
  const medianRtt = rtts.length % 2 === 1 ? rtts[mid] : (rtts[mid - 1] + rtts[mid]) / 2;

  const meanRtt = rtts.reduce((acc, r) => acc + r, 0) / rtts.length;
  const stdDevRtt = Math.sqrt(rtts.map(r => (r - meanRtt) ** 2).reduce((acc, val) => acc + val, 0) / rtts.length);

  // 2. Filter out outliers based on RTT
  const filteredSamples = offsetSamples.filter(s => {
    // Keep samples within 1.5 standard deviations from the median RTT
    return Math.abs(s.rtt - medianRtt) <= 1.5 * stdDevRtt;
  });

  // If filtering removed all samples, fall back to unfiltered median offset
  if (filteredSamples.length === 0) {
    const offsets = offsetSamples.map(s => s.offset).sort((a, b) => a - b);
    const medianOffset = offsets.length % 2 === 1 ? offsets[Math.floor(offsets.length / 2)] : (offsets[Math.floor(offsets.length / 2) - 1] + offsets[Math.floor(offsets.length / 2)]) / 2;
    offsetAudioSec = medianOffset;
  } else {
    // 3. Calculate average offset from filtered samples
    const sumOffset = filteredSamples.reduce((acc, s) => acc + s.offset, 0);
    offsetAudioSec = sumOffset / filteredSamples.length;
  }

  offsetMs = offsetAudioSec * 1000;
  setOffsetStatus(offsetMs);

  // Recalculate schedule promptly if playing.
  recalcFromLeaderTime();
}

function isLeader() {
  return leaderId && leaderId === selfId;
}

function teardown() {
  stopPlayback();
  stopContinuousSync();
  stopCalibrationTimer();
  peers.clear();
  updatePeerCount();
  peer?.destroy();
  peer = null;
  hubConn = null;
  leaderId = null;
  setConnectionStatus('Disconnected');
  leaderStatus.textContent = '—';
  startBtn.disabled = true;
  calibrateBtn.disabled = false;
  calibrateBtn.textContent = 'Calibrate';
  bpmInput.disabled = false;
  beatsInput.disabled = false;
  offsetSamples.length = 0;
  setOffsetStatus('Offset: —');
}

function startCalibrationTimer() {
  stopCalibrationTimer();
  // Set a timeout for the calibration burst
  calibrationTimer = setTimeout(() => {
    finishCalibration();
  }, 2000); // Calibrate for 2 seconds with fast pings
}

function finishCalibration() {
  stopCalibrationTimer();
  pingIntervalMs = 5000; // Revert to slow ping for continuous sync
  startPing(pingIntervalMs); // Restart pinging at the continuous rate

  if (pendingPlayback && currentState.startAtLeaderAudio) {
    startPlayback(currentState.startAtLeaderAudio);
    pendingPlayback = false;
  }

  if (isLeader()) {
    calibrateBtn.textContent = 'Calibrated';
    calibrateBtn.disabled = false;
    startBtn.disabled = false;
  }
}

function runCalibration() {
  ensureAudio();
  // If leader is local (self), no need to ping.
  if (!directLeaderConn || directLeaderConn.peer === selfId) {
    offsetMs = 0;
    offsetAudioSec = 0;
    setOffsetStatus(offsetMs);
    calibrateBtn.textContent = 'Calibrated';
    calibrateBtn.disabled = false;
    startBtn.disabled = false;
    return;
  }
  calibrateBtn.textContent = 'Calibrating…';
  calibrateBtn.disabled = true;
  startBtn.disabled = true;
  offsetSamples.length = 0; // Clear samples for fresh calibration
  pingIntervalMs = 150; // Set fast ping for calibration burst
  startPing(pingIntervalMs); // Start fast pinging
  startCalibrationTimer(); // Start timer to end the calibration burst
}

function autoCalibrate() {
  if (!isLeader()) return;
  runCalibration();
}

renderMeter(currentState.beatsPerBar);
setConnectionStatus('Disconnected');
setLeaderStatus('—');
