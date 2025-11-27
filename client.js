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
const offsetSamples = [];
const MAX_OFFSET_SAMPLES = 20;
const CALIBRATION_SAMPLES = 12;
const CALIBRATION_TIMEOUT_MS = 2500;
let peers = new Set();
let peerCount = 1;
let currentState = {
  bpm: Number(bpmInput.value),
  beatsPerBar: Number(beatsInput.value),
  leadInMs: Number(leadInInput.value),
  startAtLeaderAudio: null, // in seconds, leader audio clock
  playing: false,
};

let audioCtx = null;
let schedulerId = null;
let nextBeatTime = null;
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
  // If you're the leader, no need to ping yourself; mark calibrated immediately.
  if (!directLeaderConn || directLeaderConn.peer === selfId) {
    ensureAudio();
    offsetMs = 0;
    offsetAudioSec = 0;
    setOffsetStatus(offsetMs);
    calibrateBtn.textContent = 'Calibrated';
    calibrateBtn.disabled = false;
    startBtn.disabled = false;
    return;
  }
  ensureAudio();
  calibrateBtn.textContent = 'Calibrating…';
  calibrateBtn.disabled = true;
  startBtn.disabled = true;
  offsetSamples.length = 0;
  startCalibrationTimer();
  startPing(true);
});

startBtn.addEventListener('click', () => {
  if (!isLeader()) {
    alert('Only the leader can start. You can take leader and try again.');
    return;
  }
  ensureAudio();
  const beatSec = 60 / currentState.bpm;
  const barSec = beatSec * currentState.beatsPerBar;
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
  if (isLeader()) {
    startBtn.disabled = true;
    calibrateBtn.disabled = false;
    calibrateBtn.textContent = 'Calibrate';
    stopPlayback();
    broadcastState();
  }
});

beatsInput.addEventListener('input', () => {
  currentState.beatsPerBar = Number(beatsInput.value);
  renderMeter(currentState.beatsPerBar);
  if (isLeader()) {
    startBtn.disabled = true;
    calibrateBtn.disabled = false;
    calibrateBtn.textContent = 'Calibrate';
    stopPlayback();
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
    if (data.type === 'leader') {
      leaderId = data.id;
      broadcastLeader(conn.peer);
      return;
    }
    if (data.type === 'state') {
      currentState = data.data;
      broadcastState(conn.peer);
      return;
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
    } else {
      startBtn.disabled = true;
      calibrateBtn.disabled = true;
      calibrateBtn.textContent = 'Calibrate';
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
      calibrate: data.calibrate === true,
    });
    return;
  }

  if (data.type === 'pong' && directLeaderConn && conn.peer === directLeaderConn.peer) {
    const t1 = performance.now();
    const rtt = t1 - data.t0;
    const rttSec = rtt / 1000;
    ensureAudio();
    const localAudioNow = audioCtx.currentTime;
    const newOffsetAudio = data.leaderAudioTime - (localAudioNow + rttSec / 2);
    addOffsetSample(newOffsetAudio, data.calibrate === true);
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
    stopResync();
  }
  directLeaderConn = peer.connect(id, { reliable: true });
  directLeaderConn.on('open', () => {
    startPing();
    startResync();
    startCalibrationTimer();
  });
  directLeaderConn.on('data', (msg) => handleMessage(directLeaderConn, msg));
  directLeaderConn.on('close', () => {
    stopPing();
    stopResync();
    stopCalibrationTimer();
    startBtn.disabled = true;
    calibrateBtn.disabled = true;
    calibrateBtn.textContent = 'Calibrate';
  });
}

function startPing(isCalibration = false) {
  stopPing();
  pingTimer = setInterval(() => {
    if (directLeaderConn?.open) {
      send(directLeaderConn, { type: 'ping', t0: performance.now(), calibrate: isCalibration });
    }
  }, isCalibration ? 150 : 450);
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function startCalibrationTimer() {
  stopCalibrationTimer();
  calibrationTimer = setTimeout(() => {
    finishCalibration();
  }, CALIBRATION_TIMEOUT_MS);
}

function stopCalibrationTimer() {
  if (calibrationTimer) {
    clearTimeout(calibrationTimer);
    calibrationTimer = null;
  }
}

function startResync() {
  stopResync();
  resyncTimer = setInterval(() => {
    recalcFromLeaderTime();
  }, 600);
}

function stopResync() {
  if (resyncTimer) {
    clearInterval(resyncTimer);
    resyncTimer = null;
  }
  stopCalibrationTimer();
}

function applyRemoteState(data) {
  currentState = { ...currentState, ...data };
  bpmInput.value = currentState.bpm;
  beatsInput.value = currentState.beatsPerBar;
  leadInInput.value = currentState.leadInMs;
  renderMeter(currentState.beatsPerBar);

  if (data.playing && data.startAtLeaderAudio !== null) {
    ensureAudio();
    startPlayback(data.startAtLeaderAudio);
  } else if (!data.playing) {
    stopPlayback();
  }
  startBtn.disabled = true;
  calibrateBtn.disabled = true;
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
  startResync();
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

function addOffsetSample(sampleAudioSec, isCalibration = false) {
  offsetSamples.push(sampleAudioSec);
  if (offsetSamples.length > MAX_OFFSET_SAMPLES) offsetSamples.shift();
  const sorted = [...offsetSamples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  offsetAudioSec =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  offsetMs = offsetAudioSec * 1000;
  setOffsetStatus(offsetMs);
  if (isCalibration && offsetSamples.length >= CALIBRATION_SAMPLES) {
    finishCalibration();
  }
  // Recalculate schedule promptly if playing.
  recalcFromLeaderTime();
}

function isLeader() {
  return leaderId && leaderId === selfId;
}

function teardown() {
  stopPlayback();
  stopPing();
  stopResync();
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
}

function finishCalibration() {
  stopPing();
  stopCalibrationTimer();
  calibrateBtn.textContent = 'Calibrated';
  calibrateBtn.disabled = false;
  startBtn.disabled = false;
}

renderMeter(currentState.beatsPerBar);
setConnectionStatus('Disconnected');
setLeaderStatus('—');
