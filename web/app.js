const statusEl = document.getElementById("status");
const statusDotEl = document.getElementById("statusDot");
const volumeEl = document.getElementById("volume");
const volumeValueEl = document.getElementById("volumeValue");
const balanceEl = document.getElementById("balance");
const balanceValueEl = document.getElementById("balanceValue");
const brightnessEl = document.getElementById("brightness");
const brightnessValueEl = document.getElementById("brightnessValue");
const inputGroupEl = document.getElementById("inputGroup");
const muteEl = document.getElementById("mute");
const standbyEl = document.getElementById("standby");
const ampStateValueEl = document.getElementById("ampStateValue");
const tempValueEl = document.getElementById("tempValue");
const refreshEl = document.getElementById("refresh");
const refreshTubesEl = document.getElementById("refreshTubes");
const tubeListEl = document.getElementById("tubeList");
const tubeNumEl = document.getElementById("tubeNum");
const tubeActiveEl = document.getElementById("tubeActive");
const tubeHourEl = document.getElementById("tubeHour");
const tubeMinEl = document.getElementById("tubeMin");
const tubeLoadEl = document.getElementById("tubeLoad");
const tubeSaveEl = document.getElementById("tubeSave");
const tubeAddEl = document.getElementById("tubeAdd");
const tubeDeleteEl = document.getElementById("tubeDelete");

let ws = null;
let reconnectTimer = null;
let pendingSend = {};
let labels = {};
let ampStates = {};
let tubes = {};
let currentAmp = null;
let currentMute = null;
let pollTimer = null;
const MAX_QUEUED_LINES = 48;
let queuedLines = [];
let syncCooldownUntilMs = 0;
let pendingSyncTimer = null;
const UI_DEBOUNCE_VOL_MS = 25;
const UI_DEBOUNCE_BAL_MS = 25;
const UI_DEBOUNCE_BRI_MS = 40;
const SYNC_COOLDOWN_FULL_MS = 120;
const SYNC_COOLDOWN_STATE_MS = 80;
const HTTP_FALLBACK_STATE_POLL_DELAY_MS = 60;
const HTTP_FALLBACK_RETRY_BACKOFF_MS = 60;
const WS_RECONNECT_DELAY_MS = 700;
const WS_FALLBACK_GRACE_MS = 2200;
let lastReconnectKickMs = 0;
const RECONNECT_KICK_MIN_INTERVAL_MS = 2000;
let startupPollTimer = null;
let wsHealthTimer = null;
let wsLastMessageMs = 0;
let muteInFlight = false;
let standbyInFlight = false;
let muteInFlightTimer = null;
let standbyInFlightTimer = null;
let pendingMuteTarget = null;
let pendingMuteRetryTimer = null;
let pendingMuteRetriesLeft = 0;
let pendingStandbyTarget = null;
let pendingStandbyRetryTimer = null;
let pendingStandbyRetriesLeft = 0;
let selectedTubeNum = null;
let tubeEditorDirty = false;
let pendingTubeSave = null;
let pendingTubeDeleteNum = null;
let pendingTubeDeleteUntilMs = 0;
let pendingTubeSnapshot = false;
let tubeSnapshot = {};
let pendingManualTubeRefresh = false;
let pendingManualTubeRefreshTimer = null;
const HTTP_FALLBACK_POLL_INTERVAL_MS = 1200;
const HTTP_FALLBACK_META_POLL_EVERY = 12;
let pollInFlight = false;
let fallbackMetaPollCountdown = 0;
let suspendCloseInProgress = false;
let pendingStatePollTimer = null;
let fallbackStartTimer = null;

function isPageVisible() {
  return !document.hidden && document.visibilityState === "visible";
}

function clearPollTimer() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function clearFallbackStartTimer() {
  if (fallbackStartTimer) {
    clearTimeout(fallbackStartTimer);
    fallbackStartTimer = null;
  }
}

function schedulePollState(delayMs = HTTP_FALLBACK_STATE_POLL_DELAY_MS) {
  if (pendingStatePollTimer) {
    clearTimeout(pendingStatePollTimer);
  }
  pendingStatePollTimer = setTimeout(() => {
    pendingStatePollTimer = null;
    pollState();
  }, delayMs);
}

function scheduleFallbackStart() {
  if (fallbackStartTimer) {
    return;
  }
  fallbackStartTimer = setTimeout(() => {
    fallbackStartTimer = null;
    if (ws) {
      return;
    }
    if (!isPageVisible()) {
      return;
    }
    if (!pollTimer) {
      pollTimer = setInterval(pollState, HTTP_FALLBACK_POLL_INTERVAL_MS);
    }
  }, WS_FALLBACK_GRACE_MS);
}

function markTubeEditorDirty() {
  tubeEditorDirty = true;
}

function clearTubeEditorDirty() {
  tubeEditorDirty = false;
}

function tubeMatches(tube, expected) {
  return (
    Number(tube.num) === Number(expected.num)
    && String(toYN(tube.active)) === String(toYN(expected.active))
    && Number(tube.hour) === Number(expected.hour)
    && Number(tube.min) === Number(expected.min)
  );
}

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.classList.toggle("ok", !!ok);
  if (statusDotEl) {
    statusDotEl.classList.toggle("ok", !!ok);
  }
}

function scheduleSend(key, line, delayMs) {
  if (pendingSend[key]) {
    clearTimeout(pendingSend[key]);
  }
  pendingSend[key] = setTimeout(() => {
    sendLine(line);
    delete pendingSend[key];
  }, delayMs);
}

function debugWs(text) {
  // intentionally quiet in production UI
}

function requestFullSync(delayMs = 0, reason = "manual") {
  const run = () => {
    const now = Date.now();
    if (now < syncCooldownUntilMs) {
      pendingSyncTimer = setTimeout(run, syncCooldownUntilMs - now);
      return;
    }
    syncCooldownUntilMs = Date.now() + SYNC_COOLDOWN_FULL_MS;
    debugWs(`full-sync (${reason})`);
    sendLine("GET STATE");
    sendLine("GET SELECTOR_LABELS");
    sendLine("GET AMP_STATES");
    requestTubesSnapshot();
  };

  if (pendingSyncTimer) {
    clearTimeout(pendingSyncTimer);
    pendingSyncTimer = null;
  }
  if (delayMs > 0) {
    pendingSyncTimer = setTimeout(run, delayMs);
    return;
  }
  run();
}

function requestStateOnly(reason = "state-only") {
  const now = Date.now();
  if (now < syncCooldownUntilMs) {
    return;
  }
  syncCooldownUntilMs = Date.now() + SYNC_COOLDOWN_STATE_MS;
  debugWs(`state-sync (${reason})`);
  sendLine("GET STATE");
}

function updateStandbyButtonStyle(isStandby) {
  standbyEl.classList.toggle("on", !!isStandby);
  standbyEl.classList.toggle("operate-cta", !!isStandby);
  standbyEl.classList.toggle("standby-cta", !isStandby);
}

function syncOnResume() {
  if (!isPageVisible()) {
    return;
  }
  const now = Date.now();
  if (now - lastReconnectKickMs < RECONNECT_KICK_MIN_INTERVAL_MS) {
    return;
  }
  lastReconnectKickMs = now;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    // On iOS wake, always replace the socket to avoid stale or half-open sessions.
    forceReconnectWebSocket();
    return;
  }
  connectWebSocket();
}

function startWsHealthTimer() {
  if (wsHealthTimer) {
    clearInterval(wsHealthTimer);
  }
  wsHealthTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const now = Date.now();
    if (!wsLastMessageMs) {
      wsLastMessageMs = now;
    }
    const idleMs = now - wsLastMessageMs;
    if (idleMs > 20000) {
      requestStateOnly("ws-idle");
    }
    if (idleMs > 45000) {
      forceReconnectWebSocket();
    }
  }, 5000);
}

function stopWsHealthTimer() {
  if (wsHealthTimer) {
    clearInterval(wsHealthTimer);
    wsHealthTimer = null;
  }
}

function sendStandbyCommand(next) {
  pendingStandbyTarget = next;
  pendingStandbyRetriesLeft = 1;
  standbyInFlight = true;
  if (standbyInFlightTimer) {
    clearTimeout(standbyInFlightTimer);
  }
  standbyInFlightTimer = setTimeout(() => {
    pendingStandbyTarget = null;
    standbyInFlight = false;
    standbyInFlightTimer = null;
  }, 45000);
  if (pendingStandbyRetryTimer) {
    clearTimeout(pendingStandbyRetryTimer);
  }
  pendingStandbyRetryTimer = setTimeout(() => {
    if (pendingStandbyTarget === null) {
      pendingStandbyRetryTimer = null;
      return;
    }
    const targetAmp = pendingStandbyTarget === 1 ? 4 : 3;
    const progressingToOperate = pendingStandbyTarget === 0 && (currentAmp === 1 || currentAmp === 2);
    if (currentAmp !== targetAmp && !progressingToOperate && pendingStandbyRetriesLeft > 0) {
      pendingStandbyRetriesLeft -= 1;
      sendLine(`SET STBY ${pendingStandbyTarget}`);
    }
    pendingStandbyRetryTimer = null;
  }, 450);
  sendLine(`SET STBY ${next}`);
}

function sendMuteCommand(next) {
  pendingMuteTarget = next;
  pendingMuteRetriesLeft = 1;
  muteInFlight = true;
  if (muteInFlightTimer) {
    clearTimeout(muteInFlightTimer);
  }
  muteInFlightTimer = setTimeout(() => {
    muteInFlight = false;
    muteInFlightTimer = null;
  }, 1200);
  if (pendingMuteRetryTimer) {
    clearTimeout(pendingMuteRetryTimer);
  }
  pendingMuteRetryTimer = setTimeout(() => {
    if (pendingMuteTarget === null) {
      pendingMuteRetryTimer = null;
      return;
    }
    if (currentMute !== pendingMuteTarget && pendingMuteRetriesLeft > 0) {
      pendingMuteRetriesLeft -= 1;
      sendLine(`SET MUTE ${pendingMuteTarget}`);
    }
    pendingMuteRetryTimer = null;
  }, 320);
  sendLine(`SET MUTE ${next}`);
}

function getStandbyIntentFromUi() {
  const label = String(standbyEl.textContent || "").toLowerCase();
  if (label.includes("operate")) {
    return 0;
  }
  if (label.includes("standby")) {
    return 1;
  }
  return null;
}

function queueLine(line) {
  const text = String(line || "").trim();
  if (!text) return;

  // Coalesce stateful SET commands so reconnect flushes only latest intent.
  const m = text.match(/^SET\s+([A-Z_]+)\s+/i);
  if (m) {
    const key = `SET ${String(m[1]).toUpperCase()}`;
    for (let i = queuedLines.length - 1; i >= 0; i -= 1) {
      const existing = queuedLines[i];
      if (existing.toUpperCase().startsWith(`${key} `)) {
        queuedLines.splice(i, 1);
      }
    }
  }

  if (queuedLines.length >= MAX_QUEUED_LINES) {
    queuedLines.shift();
  }
  queuedLines.push(text);
}

function flushQueuedLines() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !queuedLines.length) {
    return;
  }
  const pending = queuedLines.slice();
  queuedLines = [];
  pending.forEach((line) => {
    try {
      ws.send(line);
    } catch (err) {
      queueLine(line);
    }
  });
}

function sendLine(line) {
  const text = String(line || "").trim();
  if (!text) {
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(text);
    return;
  }
  if (ws && ws.readyState === WebSocket.CONNECTING) {
    queueLine(text);
    return;
  }
  postCommand(text).then((ok) => {
    if (!ok) {
      queueLine(text);
      connectWebSocket();
    }
  });
}

async function postCommand(line, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch("/api/cmd", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: line,
      });
      if (res.ok) {
        // In HTTP fallback mode, pull fresh state after command ACK/STATE settles.
        schedulePollState(HTTP_FALLBACK_STATE_POLL_DELAY_MS);
        return true;
      }
    } catch (err) {
      // retry below
    }
    if (attempt < retries) {
      // Brief backoff to ride out reconnect/transient network gaps.
      await new Promise((resolve) => setTimeout(resolve, HTTP_FALLBACK_RETRY_BACKOFF_MS));
    }
  }
  return false;
}

async function pollState() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return;
  }
  if (!isPageVisible()) {
    return;
  }
  if (pollInFlight) {
    return;
  }
  pollInFlight = true;
  try {
    const fetchMeta = fallbackMetaPollCountdown <= 0;
    if (fetchMeta) {
      fallbackMetaPollCountdown = HTTP_FALLBACK_META_POLL_EVERY;
    } else {
      fallbackMetaPollCountdown -= 1;
    }

    const stateRes = await fetch("/api/state");
    const stateLine = (await stateRes.text()).trim();
    if (stateLine.startsWith("STATE ")) {
      handleStateLine(stateLine);
    }
    if (fetchMeta) {
      const [labelsRes, ampStatesRes, tubesRes] = await Promise.all([
        fetch("/api/labels"),
        fetch("/api/amp_states"),
        fetch("/api/tubes"),
      ]);
      const labelsLine = (await labelsRes.text()).trim();
      const ampStatesLine = (await ampStatesRes.text()).trim();
      const tubesText = (await tubesRes.text()).trim();
      if (labelsLine.startsWith("SELECTOR_LABELS")) {
        handleLabelsLine(labelsLine);
      }
      if (ampStatesLine.startsWith("AMP_STATES")) {
        handleAmpStatesLine(ampStatesLine);
      }
      if (tubesText) {
        handleTubesText(tubesText);
      }
    }
  } catch (err) {
    // best-effort polling fallback
  } finally {
    pollInFlight = false;
  }
}

function setActiveInput(value) {
  const buttons = inputGroupEl.querySelectorAll("button[data-input]");
  buttons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.input === String(value));
  });
}

function updateInputOptions() {
  const current = inputGroupEl.dataset.current || "1";
  inputGroupEl.innerHTML = "";

  const keys = Object.keys(labels);
  const inputs = keys.length
    ? keys.sort((a, b) => Number(a) - Number(b))
    : ["1", "2", "3", "4"];

  inputs.forEach((key) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "input-btn";
    btn.dataset.input = key;
    btn.textContent = labels[key] || `Input ${key}`;
    btn.addEventListener("click", () => {
      setActiveInput(key);
      sendLine(`SET INP ${key}`);
    });
    inputGroupEl.appendChild(btn);
  });

  inputGroupEl.dataset.current = String(current);
  setActiveInput(current);
}

function handleStateLine(line) {
  const parts = line.split(/\s+/);
  const state = {};
  for (let i = 1; i < parts.length; i += 1) {
    const [key, value] = parts[i].split("=");
    if (key && value !== undefined) {
      state[key] = value;
    }
  }

  if (state.VOL !== undefined) {
    volumeEl.value = state.VOL;
    volumeValueEl.textContent = state.VOL;
  }
  if (state.BAL !== undefined) {
    balanceEl.value = state.BAL;
    balanceValueEl.textContent = state.BAL;
  }
  if (state.BRI !== undefined) {
    brightnessEl.value = state.BRI;
    brightnessValueEl.textContent = state.BRI;
  }
  if (state.INP !== undefined) {
    inputGroupEl.dataset.current = String(state.INP);
    setActiveInput(state.INP);
  }
  if (state.MUTE !== undefined) {
    const isMuted = Number(state.MUTE) === 1;
    currentMute = isMuted ? 1 : 0;
    muteEl.textContent = isMuted ? "Mute On" : "Mute Off";
    muteEl.classList.toggle("on", isMuted);
    if (pendingMuteTarget !== null && currentMute === pendingMuteTarget) {
      pendingMuteTarget = null;
      pendingMuteRetriesLeft = 0;
      if (pendingMuteRetryTimer) {
        clearTimeout(pendingMuteRetryTimer);
        pendingMuteRetryTimer = null;
      }
    }
    muteInFlight = false;
    if (muteInFlightTimer) {
      clearTimeout(muteInFlightTimer);
      muteInFlightTimer = null;
    }
  }
  if (state.AMP !== undefined) {
    const amp = Number(state.AMP);
    if (!Number.isNaN(amp)) {
      currentAmp = amp;
      updateAmpStateView();
      const isStandby = amp === 4;
      standbyEl.textContent = isStandby ? "Go To Operate" : "Go To Standby";
      updateStandbyButtonStyle(isStandby);
      if (pendingStandbyTarget !== null) {
        const targetAmp = pendingStandbyTarget === 1 ? 4 : 3;
        if (amp === targetAmp) {
          pendingStandbyTarget = null;
          pendingStandbyRetriesLeft = 0;
          standbyInFlight = false;
          if (standbyInFlightTimer) {
            clearTimeout(standbyInFlightTimer);
            standbyInFlightTimer = null;
          }
          if (pendingStandbyRetryTimer) {
            clearTimeout(pendingStandbyRetryTimer);
            pendingStandbyRetryTimer = null;
          }
        } else {
          standbyInFlight = true;
        }
      } else {
        standbyInFlight = false;
        if (standbyInFlightTimer) {
          clearTimeout(standbyInFlightTimer);
          standbyInFlightTimer = null;
        }
        if (pendingStandbyRetryTimer) {
          clearTimeout(pendingStandbyRetryTimer);
          pendingStandbyRetryTimer = null;
        }
      }
    }
  }
  if (state.TEMP !== undefined) {
    const tempText = String(state.TEMP);
    tempValueEl.textContent = tempText === "NA"
      ? "Temperature: NA"
      : `Temperature: ${tempText}\u00B0C`;
  }
}

function handleLabelsLine(line) {
  labels = {};
  const re = /INP(\d+)="([^"]*)"/g;
  let match = re.exec(line);
  while (match) {
    labels[match[1]] = match[2];
    match = re.exec(line);
  }
  updateInputOptions();
}

function handleAmpStatesLine(line) {
  ampStates = {};
  const re = /(\d+)=("([^"]*)"|[^"\s]+)/g;
  let match = re.exec(line);
  while (match) {
    ampStates[match[1]] = match[3] !== undefined ? match[3] : match[2];
    match = re.exec(line);
  }
  updateAmpStateView();
}

function toYN(active) {
  const a = String(active || "").toLowerCase();
  return a === "yes" || a === "y" || a === "1" ? "Y" : "N";
}

function parseTubeLine(line) {
  const state = {};
  const parts = line.split(/\s+/);
  for (let i = 1; i < parts.length; i += 1) {
    const [key, value] = parts[i].split("=");
    if (key && value !== undefined) {
      state[key] = value;
    }
  }
  const numMatch = String(state.NUM || "").match(/\d+/);
  const num = numMatch ? Number(numMatch[0]) : Number.NaN;
  if (Number.isNaN(num)) {
    return null;
  }
  const hourMatch = String(state.HOUR || state.HOURS || "0").match(/\d+/);
  const minMatch = String(state.MIN || state.MINS || state.MINUTE || state.MINUTES || "0").match(/\d+/);
  return {
    num,
    active: toYN(state.ACT || "?"),
    min: minMatch ? Number(minMatch[0]) : 0,
    hour: hourMatch ? Number(hourMatch[0]) : 0,
  };
}

function parseIntField(line, key) {
  const m = line.match(new RegExp(`${key}=(\\d+)`));
  return m ? Number(m[1]) : null;
}

function setTubeEditorStatus(text, clearAfterMs = 0) {
  // Tube editor status annunciator removed from UI.
}

function completeManualTubeRefreshStatus(message = "Tube list refreshed.") {
  if (!pendingManualTubeRefresh) {
    return;
  }
  pendingManualTubeRefresh = false;
  if (pendingManualTubeRefreshTimer) {
    clearTimeout(pendingManualTubeRefreshTimer);
    pendingManualTubeRefreshTimer = null;
  }
  setTubeEditorStatus(message, 1500);
}

function clearPendingTubeDelete() {
  pendingTubeDeleteNum = null;
  pendingTubeDeleteUntilMs = 0;
  if (tubeDeleteEl) {
    tubeDeleteEl.textContent = "Delete Tube";
  }
}

function setTubeEditorFromRecord(tube) {
  if (!tube) return;
  selectedTubeNum = tube.num;
  tubeNumEl.value = String(tube.num);
  tubeActiveEl.value = toYN(tube.active);
  tubeHourEl.value = String(tube.hour);
  tubeMinEl.value = String(tube.min);
  clearPendingTubeDelete();
  clearTubeEditorDirty();
}

function applyTubesMap(nextTubes) {
  tubes = nextTubes;
  if (selectedTubeNum !== null && !tubes[selectedTubeNum]) {
    selectedTubeNum = null;
  }
  if (selectedTubeNum === null) {
    const nums = Object.keys(tubes).map((v) => Number(v)).sort((a, b) => a - b);
    if (nums.length) {
      setTubeEditorFromRecord(tubes[nums[0]]);
    }
  } else if (!tubeEditorDirty) {
    setTubeEditorFromRecord(tubes[selectedTubeNum]);
  }
  renderTubes();
  completeManualTubeRefreshStatus();
}

function requestTubesSnapshot() {
  pendingTubeSnapshot = true;
  tubeSnapshot = {};
  sendLine("GET TUBES");
}

function handleTubeLine(line) {
  const tube = parseTubeLine(line);
  if (!tube) return;
  if (pendingTubeSave && tube.num === pendingTubeSave.num) {
    if (tubeMatches(tube, pendingTubeSave)) {
      pendingTubeSave = null;
    } else if (Date.now() < pendingTubeSave.ignoreUntilMs) {
      return;
    }
  }
  if (pendingTubeSnapshot) {
    tubeSnapshot[tube.num] = tube;
    return;
  }
  tubes[tube.num] = tube;
  if ((selectedTubeNum === tube.num || selectedTubeNum === null) && !tubeEditorDirty) {
    setTubeEditorFromRecord(tube);
  }
  renderTubes();
}

function handleTubesText(text) {
  const nextTubes = {};
  const lines = text.split(/\r?\n/);
  lines.forEach((line) => {
    const one = line.trim();
    if (one.startsWith("TUBE ")) {
      const tube = parseTubeLine(one);
      if (tube) {
        if (pendingTubeSave && tube.num === pendingTubeSave.num) {
          if (tubeMatches(tube, pendingTubeSave)) {
            pendingTubeSave = null;
          } else if (Date.now() < pendingTubeSave.ignoreUntilMs) {
            return;
          }
        }
        nextTubes[tube.num] = tube;
      }
    }
  });
  applyTubesMap(nextTubes);
}

function renderTubes() {
  const nums = Object.keys(tubes)
    .map((v) => Number(v))
    .sort((a, b) => a - b);
  tubeListEl.innerHTML = "";
  if (!nums.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = "No tube data.";
    row.appendChild(cell);
    tubeListEl.appendChild(row);
    return;
  }
  nums.forEach((num) => {
    const tube = tubes[num];
    const row = document.createElement("tr");
    const numCell = document.createElement("td");
    numCell.textContent = String(tube.num);
    const activeCell = document.createElement("td");
    activeCell.textContent = String(tube.active);
    const hourCell = document.createElement("td");
    hourCell.textContent = String(tube.hour);
    const minCell = document.createElement("td");
    minCell.textContent = String(tube.min);
    row.appendChild(numCell);
    row.appendChild(activeCell);
    row.appendChild(hourCell);
    row.appendChild(minCell);
    row.addEventListener("click", () => {
      setTubeEditorFromRecord(tube);
      renderTubes();
      setTubeEditorStatus(`Editing tube ${tube.num}`);
    });
    if (selectedTubeNum === tube.num) {
      row.classList.add("selected");
    }
    tubeListEl.appendChild(row);
  });
}

function parseTubeEditorValues(requireTubeNum) {
  const tubeNum = Number(tubeNumEl.value);
  const ageHour = Number(tubeHourEl.value);
  const ageMin = Number(tubeMinEl.value);
  const active = tubeActiveEl.value === "Y" ? "Y" : "N";

  if (requireTubeNum && (!Number.isInteger(tubeNum) || tubeNum < 1)) {
    return { ok: false, error: "Tube # must be >= 1." };
  }
  if (!Number.isInteger(ageHour) || ageHour < 0) {
    return { ok: false, error: "Hours must be >= 0." };
  }
  if (!Number.isInteger(ageMin) || ageMin < 0 || ageMin > 59) {
    return { ok: false, error: "Minutes must be 0-59." };
  }
  return {
    ok: true,
    tubeNum,
    active,
    ageHour,
    ageMin,
  };
}

function updateAmpStateView() {
  ampStateValueEl.classList.remove(
    "state-operate",
    "state-standby",
    "state-transition",
    "state-startup",
    "state-unknown",
  );

  if (currentAmp === null) {
    ampStateValueEl.textContent = "Unknown";
    ampStateValueEl.classList.add("state-unknown");
    return;
  }

  if (currentAmp === 3) {
    ampStateValueEl.classList.add("state-operate");
  } else if (currentAmp === 4) {
    ampStateValueEl.classList.add("state-standby");
  } else if (currentAmp === 1 || currentAmp === 2) {
    ampStateValueEl.classList.add("state-transition");
  } else if (currentAmp === 0) {
    ampStateValueEl.classList.add("state-startup");
  } else {
    ampStateValueEl.classList.add("state-unknown");
  }

  const label = ampStates[String(currentAmp)];
  ampStateValueEl.textContent = label || String(currentAmp);
}

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const wsUrl = `ws://${window.location.host}/ws`;
  const socket = new WebSocket(wsUrl);
  ws = socket;

  socket.addEventListener("open", () => {
    if (ws !== socket) {
      return;
    }
    debugWs("ws open");
    setStatus("Connected", true);
    wsLastMessageMs = Date.now();
    fallbackMetaPollCountdown = 0;
    suspendCloseInProgress = false;
    clearFallbackStartTimer();
    startWsHealthTimer();
    clearPollTimer();
    if (startupPollTimer) {
      clearTimeout(startupPollTimer);
      startupPollTimer = null;
    }
    if (pendingStatePollTimer) {
      clearTimeout(pendingStatePollTimer);
      pendingStatePollTimer = null;
    }
    flushQueuedLines();
  });

  socket.addEventListener("message", (event) => {
    if (ws !== socket) {
      return;
    }
    const line = String(event.data || "").trim();
    if (!line) return;
    wsLastMessageMs = Date.now();
    if (line.startsWith("STATE ")) {
      handleStateLine(line);
    } else if (line.startsWith("SELECTOR_LABELS")) {
      handleLabelsLine(line);
    } else if (line.startsWith("AMP_STATES")) {
      handleAmpStatesLine(line);
    } else if (line.startsWith("TUBE ")) {
      handleTubeLine(line);
    } else if (line === "TUBES_END" || line === "END TUBES") {
      if (pendingTubeSnapshot) {
        pendingTubeSnapshot = false;
        applyTubesMap(tubeSnapshot);
        tubeSnapshot = {};
      } else {
        renderTubes();
        completeManualTubeRefreshStatus();
      }
    } else if (
      line.startsWith("ACK MUTE START")
      || line.startsWith("ACK MUTE DONE")
      || line.startsWith("ACK STBY START")
      || line.startsWith("ACK STBY DONE")
    ) {
      debugWs(line);
      if (line.startsWith("ACK MUTE START")) {
        // consumed for reliability/debug; no UI annunciator needed
      } else if (line.startsWith("ACK MUTE DONE")) {
        // consumed for reliability/debug; no UI annunciator needed
      } else if (line.startsWith("ACK STBY START")) {
        // consumed for reliability/debug; no UI annunciator needed
      } else if (line.startsWith("ACK STBY DONE")) {
        // consumed for reliability/debug; no UI annunciator needed
      }
    } else if (
      line.startsWith("ACK TUBE")
      || line.startsWith("ACK ADD")
      || line.startsWith("ACK DEL")
    ) {
      setTubeEditorStatus(line);
      if (line.startsWith("ACK DEL")) {
        clearPendingTubeDelete();
        setTimeout(requestTubesSnapshot, 150);
      }
    } else if (line.startsWith("DONE SAVE")) {
      const num = parseIntField(line, "NUM");
      if (num !== null) {
        setTubeEditorStatus(`Tube ${num} save completed.`);
        if (selectedTubeNum === num) {
          clearTubeEditorDirty();
        }
        if (pendingTubeSave && pendingTubeSave.num === num) {
          pendingTubeSave.ignoreUntilMs = Date.now() + 1200;
        }
      } else {
        setTubeEditorStatus("Tube save completed.");
        clearTubeEditorDirty();
      }
      setTimeout(requestTubesSnapshot, 250);
    } else if (line.startsWith("ERR")) {
      pendingManualTubeRefresh = false;
      if (pendingManualTubeRefreshTimer) {
        clearTimeout(pendingManualTubeRefreshTimer);
        pendingManualTubeRefreshTimer = null;
      }
      pendingTubeSave = null;
      clearPendingTubeDelete();
      pendingStandbyTarget = null;
      pendingStandbyRetriesLeft = 0;
      standbyInFlight = false;
      if (standbyInFlightTimer) {
        clearTimeout(standbyInFlightTimer);
        standbyInFlightTimer = null;
      }
      if (pendingStandbyRetryTimer) {
        clearTimeout(pendingStandbyRetryTimer);
        pendingStandbyRetryTimer = null;
      }
      setTubeEditorStatus(line);
    }
  });

  socket.addEventListener("close", (event) => {
    if (ws !== socket) {
      return;
    }
    ws = null;
    debugWs("ws close");
    setStatus("Disconnected", false);
    stopWsHealthTimer();
    const code = Number((event && event.code) || 0);
    const intentional = suspendCloseInProgress || !isPageVisible();
    const wsOnlyReconnect = code === 1001;
    if (!intentional && !wsOnlyReconnect) {
      scheduleFallbackStart();
    }
    if (!intentional && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket();
      }, WS_RECONNECT_DELAY_MS);
    }
    debugWs(
      `ws close code=${code} intentional=${intentional ? 1 : 0} ws-only=${wsOnlyReconnect ? 1 : 0}`,
    );
    suspendCloseInProgress = false;
  });

  socket.addEventListener("error", () => {
    if (ws !== socket) {
      return;
    }
    debugWs("ws error");
    setStatus("Error", false);
    stopWsHealthTimer();
  });
}

function forceReconnectWebSocket() {
  clearReconnectTimer();
  clearFallbackStartTimer();
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  } catch (err) {
    // ignore close errors
  }
  ws = null;
  connectWebSocket();
}

volumeEl.addEventListener("input", (event) => {
  const value = event.target.value;
  volumeValueEl.textContent = value;
  scheduleSend("vol", `SET VOL ${value}`, UI_DEBOUNCE_VOL_MS);
});

balanceEl.addEventListener("input", (event) => {
  const value = event.target.value;
  balanceValueEl.textContent = value;
  scheduleSend("bal", `SET BAL ${value}`, UI_DEBOUNCE_BAL_MS);
});

brightnessEl.addEventListener("input", (event) => {
  const value = event.target.value;
  brightnessValueEl.textContent = value;
  scheduleSend("bri", `SET BRI ${value}`, UI_DEBOUNCE_BRI_MS);
});

muteEl.addEventListener("click", () => {
  const next = currentMute === null
    ? (muteEl.classList.contains("on") ? 0 : 1)
    : (currentMute === 1 ? 0 : 1);
  sendMuteCommand(next);
});

standbyEl.addEventListener("click", () => {
  if (standbyInFlight) {
    return;
  }
  let next = null;
  if (currentAmp === 4) {
    next = 0;
  } else if (currentAmp === 3) {
    next = 1;
  } else {
    next = getStandbyIntentFromUi();
  }
  if (next === null) {
    sendLine("GET STATE");
    return;
  }
  sendStandbyCommand(next);
});

refreshEl.addEventListener("click", () => {
  requestFullSync(0, "refresh-btn");
});

refreshTubesEl.addEventListener("click", () => {
  pendingManualTubeRefresh = true;
  if (pendingManualTubeRefreshTimer) {
    clearTimeout(pendingManualTubeRefreshTimer);
  }
  pendingManualTubeRefreshTimer = setTimeout(() => {
    if (!pendingManualTubeRefresh) {
      return;
    }
    pendingManualTubeRefresh = false;
    pendingManualTubeRefreshTimer = null;
    setTubeEditorStatus("Tube refresh timed out.", 1800);
  }, 3500);
  setTubeEditorStatus("Refreshing tube list...");
  clearTubeEditorDirty();
  requestTubesSnapshot();
});

tubeLoadEl.addEventListener("click", () => {
  const tubeNum = Number(tubeNumEl.value);
  if (!Number.isInteger(tubeNum) || tubeNum < 1) {
    setTubeEditorStatus("Tube # must be >= 1.");
    return;
  }
  selectedTubeNum = tubeNum;
  clearTubeEditorDirty();
  setTubeEditorStatus(`Loading tube ${tubeNum}...`);
  sendLine(`GET TUBE ${tubeNum}`);
});

tubeSaveEl.addEventListener("click", () => {
  const parsed = parseTubeEditorValues(true);
  if (!parsed.ok) {
    setTubeEditorStatus(parsed.error);
    return;
  }
  selectedTubeNum = parsed.tubeNum;
  pendingTubeSave = {
    num: parsed.tubeNum,
    active: parsed.active,
    hour: parsed.ageHour,
    min: parsed.ageMin,
    ignoreUntilMs: Date.now() + 1200,
  };
  setTubeEditorStatus(`Saving tube ${parsed.tubeNum}...`);
  sendLine(
    `SET TUBE ${parsed.tubeNum} ACT=${parsed.active} HOUR=${parsed.ageHour} MIN=${parsed.ageMin}`,
  );
});

tubeAddEl.addEventListener("click", () => {
  const parsed = parseTubeEditorValues(true);
  if (!parsed.ok) {
    setTubeEditorStatus(parsed.error);
    return;
  }
  setTubeEditorStatus("Adding tube...");
  sendLine(
    `ADD TUBE NUM=${parsed.tubeNum} ACT=${parsed.active} HOUR=${parsed.ageHour} MIN=${parsed.ageMin}`,
  );
});

tubeDeleteEl.addEventListener("click", () => {
  const tubeNum = Number(tubeNumEl.value);
  if (!Number.isInteger(tubeNum) || tubeNum < 1) {
    clearPendingTubeDelete();
    setTubeEditorStatus("Tube # must be >= 1.");
    return;
  }
  const now = Date.now();
  if (pendingTubeDeleteNum === tubeNum && now <= pendingTubeDeleteUntilMs) {
    selectedTubeNum = tubeNum;
    clearTubeEditorDirty();
    clearPendingTubeDelete();
    setTubeEditorStatus(`Deleting tube ${tubeNum}...`);
    sendLine(`DEL TUBE ${tubeNum}`);
    return;
  }
  pendingTubeDeleteNum = tubeNum;
  pendingTubeDeleteUntilMs = now + 7000;
  tubeDeleteEl.textContent = "Confirm Delete";
  setTubeEditorStatus(`Click Confirm Delete again within 7s to delete tube ${tubeNum}.`);
});

tubeNumEl.addEventListener("input", () => {
  const tubeNum = Number(tubeNumEl.value);
  selectedTubeNum = Number.isInteger(tubeNum) && tubeNum > 0 ? tubeNum : null;
  clearPendingTubeDelete();
  markTubeEditorDirty();
  renderTubes();
});

tubeActiveEl.addEventListener("change", markTubeEditorDirty);
tubeHourEl.addEventListener("input", markTubeEditorDirty);
tubeMinEl.addEventListener("input", markTubeEditorDirty);

updateInputOptions();
updateStandbyButtonStyle(false);
connectWebSocket();
startupPollTimer = setTimeout(() => {
  startupPollTimer = null;
  if (isPageVisible() && (!ws || ws.readyState !== WebSocket.OPEN)) {
    pollState();
  }
}, 1200);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    suspendCloseInProgress = false;
    syncOnResume();
    return;
  }
  clearPollTimer();
  clearReconnectTimer();
  clearFallbackStartTimer();
});

window.addEventListener("focus", () => {
  syncOnResume();
});

window.addEventListener("pageshow", () => {
  suspendCloseInProgress = false;
  syncOnResume();
});

window.addEventListener("pagehide", () => {
  suspendCloseInProgress = true;
  clearPollTimer();
  clearReconnectTimer();
  clearFallbackStartTimer();
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  } catch (err) {
    // ignore close errors on backgrounding
  }
});
