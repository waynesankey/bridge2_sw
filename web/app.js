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
const tubeEditorStatusEl = document.getElementById("tubeEditorStatus");

let ws = null;
let reconnectTimer = null;
let pendingSend = {};
let labels = {};
let ampStates = {};
let tubes = {};
let currentAmp = null;
let pollTimer = null;
let selectedTubeNum = null;
let tubeEditorDirty = false;
let pendingTubeSave = null;
let pendingTubeDeleteNum = null;
let pendingTubeDeleteUntilMs = 0;
let pendingTubeSnapshot = false;
let tubeSnapshot = {};

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

function sendLine(line) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    postCommand(line);
    return;
  }
  ws.send(line);
}

async function postCommand(line) {
  try {
    const res = await fetch("/api/cmd", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: line,
    });
    if (res.ok) {
      // In HTTP fallback mode, pull fresh state after command ACK/STATE settles.
      setTimeout(pollState, 180);
    }
  } catch (err) {
    // keep UI responsive; status already reflects disconnect
  }
}

async function pollState() {
  try {
    const [stateRes, labelsRes, ampStatesRes, tubesRes] = await Promise.all([
      fetch("/api/state"),
      fetch("/api/labels"),
      fetch("/api/amp_states"),
      fetch("/api/tubes"),
    ]);
    const stateLine = (await stateRes.text()).trim();
    const labelsLine = (await labelsRes.text()).trim();
    const ampStatesLine = (await ampStatesRes.text()).trim();
    const tubesText = (await tubesRes.text()).trim();
    if (stateLine.startsWith("STATE ")) {
      handleStateLine(stateLine);
    }
    if (labelsLine.startsWith("SELECTOR_LABELS")) {
      handleLabelsLine(labelsLine);
    }
    if (ampStatesLine.startsWith("AMP_STATES")) {
      handleAmpStatesLine(ampStatesLine);
    }
    if (tubesText) {
      handleTubesText(tubesText);
    }
  } catch (err) {
    // best-effort polling fallback
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
    muteEl.textContent = isMuted ? "Mute On" : "Mute Off";
    muteEl.classList.toggle("on", isMuted);
  }
  if (state.AMP !== undefined) {
    const amp = Number(state.AMP);
    if (!Number.isNaN(amp)) {
      currentAmp = amp;
      updateAmpStateView();
      const isStandby = amp === 4;
      standbyEl.textContent = isStandby ? "Standby On" : "Standby Off";
      standbyEl.classList.toggle("on", isStandby);
    }
  }
  if (state.TEMP !== undefined) {
    tempValueEl.textContent = `Temperature: ${state.TEMP}`;
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

function setTubeEditorStatus(text) {
  tubeEditorStatusEl.textContent = text;
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
  if (currentAmp === null) {
    ampStateValueEl.textContent = "Unknown";
    return;
  }
  const label = ampStates[String(currentAmp)];
  ampStateValueEl.textContent = label || String(currentAmp);
}

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const wsUrl = `ws://${window.location.host}/ws`;
  ws = new WebSocket(wsUrl);

  ws.addEventListener("open", () => {
    setStatus("Connected", true);
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    sendLine("GET STATE");
    sendLine("GET SELECTOR_LABELS");
    sendLine("GET AMP_STATES");
    requestTubesSnapshot();
  });

  ws.addEventListener("message", (event) => {
    const line = String(event.data || "").trim();
    if (!line) return;
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
      pendingTubeSave = null;
      clearPendingTubeDelete();
      setTubeEditorStatus(line);
    }
  });

  ws.addEventListener("close", () => {
    setStatus("Disconnected", false);
    if (!pollTimer) {
      pollTimer = setInterval(pollState, 1000);
    }
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket();
      }, 2000);
    }
  });

  ws.addEventListener("error", () => {
    setStatus("Error", false);
  });
}

function forceReconnectWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
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
  scheduleSend("vol", `SET VOL ${value}`, 100);
});

balanceEl.addEventListener("input", (event) => {
  const value = event.target.value;
  balanceValueEl.textContent = value;
  scheduleSend("bal", `SET BAL ${value}`, 100);
});

brightnessEl.addEventListener("input", (event) => {
  const value = event.target.value;
  brightnessValueEl.textContent = value;
  scheduleSend("bri", `SET BRI ${value}`, 150);
});

muteEl.addEventListener("click", () => {
  const isMuted = muteEl.classList.contains("on");
  const next = isMuted ? 0 : 1;
  sendLine(`SET MUTE ${next}`);
});

standbyEl.addEventListener("click", () => {
  const isStandby = standbyEl.classList.contains("on");
  const next = isStandby ? 0 : 1;
  sendLine(`SET STBY ${next}`);
});

refreshEl.addEventListener("click", () => {
  sendLine("GET STATE");
  sendLine("GET SELECTOR_LABELS");
  sendLine("GET AMP_STATES");
});

refreshTubesEl.addEventListener("click", () => {
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
connectWebSocket();
pollState();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    forceReconnectWebSocket();
    pollState();
  }
});

window.addEventListener("focus", () => {
  forceReconnectWebSocket();
  pollState();
});

window.addEventListener("pageshow", () => {
  forceReconnectWebSocket();
  pollState();
});
