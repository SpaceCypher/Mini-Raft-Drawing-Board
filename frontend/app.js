const board = document.getElementById('board');
const ctx = board.getContext('2d');
const colorPicker = document.getElementById('colorPicker');
const widthPicker = document.getElementById('widthPicker');
const eraserBtn = document.getElementById('eraserBtn');
const lineBtn = document.getElementById('lineBtn');
const rectBtn = document.getElementById('rectBtn');
const circleBtn = document.getElementById('circleBtn');
const gridBtn = document.getElementById('gridBtn');
const saveBtn = document.getElementById('saveBtn');
const backgroundPreset = document.getElementById('backgroundPreset');
const backgroundTint = document.getElementById('backgroundTint');
const textureStrength = document.getElementById('textureStrength');
const randomThemeBtn = document.getElementById('randomThemeBtn');
const backgroundUpload = document.getElementById('backgroundUpload');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const clearLocalBtn = document.getElementById('clearLocalBtn');
const connectionStatus = document.getElementById('connectionStatus');
const leaderStatus = document.getElementById('leaderStatus');
const syncStatus = document.getElementById('syncStatus');
const toolStatus = document.getElementById('toolStatus');
const strokeCount = document.getElementById('strokeCount');
const activeUsers = document.getElementById('activeUsers');
const dashboardLink = document.getElementById('dashboardLink');
const swatchButtons = Array.from(document.querySelectorAll('.swatch[data-color]'));
const API_BASE = new URLSearchParams(window.location.search).get('api') || `${window.location.protocol}//${window.location.host}/api`;
const LOOK_STORAGE_KEY = 'miniraft-board-look-v1';

const seenKeys = new Set();
const committedEntries = [];
const optimisticDrawById = new Map();
let ws = null;
let reconnectTimer = null;
let pingTimer = null;
let pollTimer = null;
let reconnectAttempt = 0;
const outboundQueue = [];
const httpCommandQueue = [];
let httpCommandSending = false;
let drawing = false;
let previousPoint = null;
let nextClientCommandId = 1;
let latestLeaderNodeId = null;
let eraserEnabled = false;
let gridEnabled = false;
let shapeMode = null;
let shapeStartPoint = null;
let shapeCurrentPoint = null;
let uploadedBackgroundDataUrl = null;

const boardBackgroundPresets = {
  paper: {
    base: '#f8fbfd',
    overlay: 'linear-gradient(180deg, rgba(255,255,255,0.9), rgba(245,249,252,0.96))',
    bodyTheme: ''
  },
  mint: {
    base: '#e9f7f1',
    overlay: 'radial-gradient(circle at 22% 16%, rgba(255,255,255,0.65), transparent 44%), linear-gradient(180deg, rgba(236,253,245,0.82), rgba(217,244,234,0.95))',
    bodyTheme: ''
  },
  sunset: {
    base: '#fdf0e8',
    overlay: 'radial-gradient(circle at 80% 20%, rgba(255,183,122,0.25), transparent 40%), linear-gradient(180deg, rgba(255,241,229,0.9), rgba(244,225,216,0.96))',
    bodyTheme: 'theme-sunset'
  },
  ocean: {
    base: '#e7f3fb',
    overlay: 'radial-gradient(circle at 74% 26%, rgba(91,163,220,0.16), transparent 38%), linear-gradient(180deg, rgba(232,247,255,0.9), rgba(217,236,250,0.96))',
    bodyTheme: ''
  },
  slate: {
    base: '#e5ecf2',
    overlay: 'radial-gradient(circle at 20% 80%, rgba(109,132,168,0.14), transparent 40%), linear-gradient(180deg, rgba(235,241,247,0.9), rgba(219,229,239,0.96))',
    bodyTheme: 'theme-slate'
  }
};

function wsUrl() {
  const fromQuery = new URLSearchParams(window.location.search).get('ws');
  if (fromQuery) {
    return fromQuery;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = window.location.host || 'localhost:8080';
  return `${protocol}://${host}/ws`;
}

function dashboardUrl() {
  const protocol = window.location.protocol;
  const host = window.location.hostname || 'localhost';
  return `${protocol}//${host}:8090`;
}

async function pollCommittedLog() {
  try {
    const res = await fetch(`${API_BASE}/committed-log`, { cache: 'no-store' });
    if (!res.ok) {
      return;
    }
    const data = await res.json();
    if (Array.isArray(data.entries)) {
      data.entries.forEach(commitEntry);
    }
  } catch (_err) {
    // Polling is best-effort fallback.
  }
}

async function pollLeader() {
  let leaderNodeId = null;
  let leaderTerm = null;

  try {
    const clusterRes = await fetch(`${API_BASE}/cluster-status`, { cache: 'no-store' });
    if (clusterRes.ok) {
      const cluster = await clusterRes.json();
      if (cluster?.leader?.nodeId) {
        leaderNodeId = cluster.leader.nodeId;
        leaderTerm = cluster.leader.term;
      } else if (Array.isArray(cluster?.replicas)) {
        const elected = cluster.replicas.find((x) => x.ok && x.status && x.status.role === 'leader');
        if (elected?.status?.nodeId) {
          leaderNodeId = elected.status.nodeId;
          leaderTerm = elected.status.currentTerm;
        }
      }

      if (cluster?.gateway?.wsClients !== undefined) {
        updateActiveUsers(cluster.gateway.wsClients);
      }
    }

    if (!leaderNodeId) {
      const res = await fetch(`${API_BASE}/leader`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data?.leader?.nodeId) {
          leaderNodeId = data.leader.nodeId;
          leaderTerm = data.leader.term;
        }
      }
    }

    if (leaderNodeId) {
      updateLeaderChip(leaderNodeId, leaderTerm);
    }
  } catch (_err) {
    // Ignore leader poll errors.
  }
}

function updateLeaderChip(nodeId, term) {
  leaderStatus.textContent = `Leader: ${nodeId} (term ${term ?? '?'})`;
  if (nodeId !== latestLeaderNodeId) {
    latestLeaderNodeId = nodeId;
    leaderStatus.classList.remove('leader-changed');
    // Restart animation on leader transitions.
    void leaderStatus.offsetWidth;
    leaderStatus.classList.add('leader-changed');
  }
}

function updateSyncChip() {
  if (!syncStatus) {
    return;
  }

  const pending = optimisticDrawById.size + httpCommandQueue.length + (httpCommandSending ? 1 : 0);
  syncStatus.classList.remove('ok', 'pending', 'warn', 'ghost');

  if (pending === 0) {
    syncStatus.textContent = 'Sync: up to date';
    syncStatus.classList.add('ok');
    return;
  }

  if (reconnectTimer || !ws || ws.readyState !== WebSocket.OPEN) {
    syncStatus.textContent = `Sync: waiting (${pending})`;
    syncStatus.classList.add('warn');
    return;
  }

  syncStatus.textContent = `Sync: pending ${pending}`;
  syncStatus.classList.add('pending');
}

function startPollLoop() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  pollTimer = setInterval(() => {
    pollCommittedLog();
    pollLeader();
  }, 2000);
}

function clearTimers() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  reconnectAttempt += 1;
  const delay = Math.min(5000, 400 + reconnectAttempt * 250);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSocket();
  }, delay);
}

function startPingLoop() {
  if (pingTimer) {
    clearInterval(pingTimer);
  }
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify({ type: 'ping' }));
  }, 12000);
}

function flushOutboundQueue() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  while (outboundQueue.length > 0) {
    const payload = outboundQueue.shift();
    ws.send(JSON.stringify(payload));
  }
}

function sendMessage(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return;
  }

  outboundQueue.push(payload);
}

async function flushHttpCommandQueue() {
  if (httpCommandSending || httpCommandQueue.length === 0) {
    return;
  }

  httpCommandSending = true;
  const command = httpCommandQueue.shift();

  try {
    const res = await fetch(`${API_BASE}/submit-command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
      keepalive: true
    });

    // During leader election, gateway can return non-2xx while no leader is available.
    // Treat those responses as transient send failures so the command is retried.
    if (!res.ok) {
      throw new Error(`submit-failed-${res.status}`);
    }
  } catch (_err) {
    // Put the command back at the front and retry shortly.
    httpCommandQueue.unshift(command);
    httpCommandSending = false;
    setTimeout(flushHttpCommandQueue, 120);
    updateSyncChip();
    return;
  }

  httpCommandSending = false;
  updateSyncChip();
  if (httpCommandQueue.length > 0) {
    setTimeout(flushHttpCommandQueue, 0);
  }
}

function enqueueCommandHttp(command) {
  httpCommandQueue.push(command);

  // Bound memory if the network pauses for a while.
  if (httpCommandQueue.length > 1500) {
    httpCommandQueue.splice(0, httpCommandQueue.length - 1500);
  }

  updateSyncChip();
  flushHttpCommandQueue();
}

function updateConnectionChip(isConnected, msg) {
  connectionStatus.textContent = msg;
  connectionStatus.style.background = isConnected
    ? 'rgba(30, 143, 94, 0.13)'
    : 'rgba(212, 69, 46, 0.14)';
  connectionStatus.style.color = isConnected ? '#1e8f5e' : '#d4452e';
  connectionStatus.style.setProperty('--dot-color', isConnected ? '#1e8f5e' : '#d4452e');
}

function fitCanvas() {
  const ratio = window.devicePixelRatio || 1;
  const rect = board.getBoundingClientRect();
  board.width = Math.floor(rect.width * ratio);
  board.height = Math.floor(rect.height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  renderCommittedState();
}

function drawGrid() {
  if (!gridEnabled) {
    return;
  }

  const ratio = window.devicePixelRatio || 1;
  const width = board.width / ratio;
  const height = board.height / ratio;
  const step = 28;

  ctx.save();
  ctx.strokeStyle = 'rgba(21, 32, 34, 0.08)';
  ctx.lineWidth = 1;

  for (let x = step; x < width; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  for (let y = step; y < height; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.restore();
}

function activeStrokeColor() {
  return eraserEnabled ? '#ffffff' : colorPicker.value;
}

function updateToolChip() {
  if (!toolStatus) {
    return;
  }

  const mode = shapeMode || (eraserEnabled ? 'eraser' : 'brush');
  const width = Number(widthPicker.value || 3);
  const color = eraserEnabled ? '#ffffff' : colorPicker.value;
  toolStatus.textContent = `Tool: ${mode} ${color} / ${width}px${gridEnabled ? ' / grid' : ''}`;
}

function saveLookState() {
  if (!backgroundPreset || !backgroundTint || !textureStrength) {
    return;
  }

  const payload = {
    preset: backgroundPreset.value,
    tint: backgroundTint.value,
    texture: Number(textureStrength.value || 18),
    uploadedBackgroundDataUrl
  };

  try {
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify(payload));
  } catch (_err) {
    // Ignore storage failures (private mode / quota).
  }
}

function applyBoardLook(options = {}) {
  if (!board) {
    return;
  }

  const preset = options.preset || 'paper';
  const tint = options.tint || '#f8fbfd';
  const texture = Number(options.texture ?? 18);
  const presetConfig = boardBackgroundPresets[preset] || boardBackgroundPresets.paper;

  document.body.classList.remove('theme-slate', 'theme-sunset');
  if (presetConfig.bodyTheme) {
    document.body.classList.add(presetConfig.bodyTheme);
  }

  board.style.setProperty('--canvas-base', tint);
  board.style.setProperty('--canvas-texture-opacity', String(Math.max(0, Math.min(100, texture)) / 100));

  if (preset === 'custom' && uploadedBackgroundDataUrl) {
    const escaped = uploadedBackgroundDataUrl.replace(/"/g, '\\"');
    board.style.setProperty(
      '--canvas-overlay',
      `linear-gradient(180deg, rgba(255,255,255,0.16), rgba(255,255,255,0.26)), url("${escaped}")`
    );
  } else {
    board.style.setProperty('--canvas-overlay', presetConfig.overlay);
  }

  renderCommittedState();
  saveLookState();
}

function loadLookState() {
  try {
    const raw = localStorage.getItem(LOOK_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const data = JSON.parse(raw);

    if (typeof data.uploadedBackgroundDataUrl === 'string' && data.uploadedBackgroundDataUrl.startsWith('data:image/')) {
      uploadedBackgroundDataUrl = data.uploadedBackgroundDataUrl;
    }

    if (backgroundPreset && typeof data.preset === 'string') {
      updateBgPreset(data.preset);
    }
    if (backgroundTint && typeof data.tint === 'string') {
      backgroundTint.value = data.tint;
    }
    if (textureStrength && Number.isFinite(Number(data.texture))) {
      textureStrength.value = String(Math.max(0, Math.min(100, Number(data.texture))));
    }
  } catch (_err) {
    // Ignore malformed storage payloads.
  }
}

function updateStrokeCount(count) {
  if (!strokeCount) {
    return;
  }
  strokeCount.textContent = `Strokes: ${count}`;
}

function updateActiveUsers(count) {
  if (!activeUsers) {
    return;
  }
  activeUsers.textContent = `Users: ${Number(count) || 0}`;
}

function setShapeMode(mode) {
  shapeMode = mode;
  if (mode) {
    setEraserMode(false);
  }

  [lineBtn, rectBtn, circleBtn].forEach((btn) => {
    if (!btn) {
      return;
    }
    const active = btn.id === `${mode}Btn`;
    btn.classList.toggle('active-shape', active);
  });

  updateToolChip();
}

function setEraserMode(enabled) {
  eraserEnabled = Boolean(enabled);
  if (eraserEnabled) {
    shapeMode = null;
  }
  if (eraserBtn) {
    eraserBtn.classList.toggle('active', eraserEnabled);
  }
  [lineBtn, rectBtn, circleBtn].forEach((btn) => {
    if (btn) {
      btn.classList.remove('active-shape');
    }
  });
  updateToolChip();
}

function setGridMode(enabled) {
  gridEnabled = Boolean(enabled);
  if (gridBtn) {
    gridBtn.classList.toggle('active', gridEnabled);
  }
  renderCommittedState();
  updateToolChip();
}

function saveBoardImage() {
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = board.width;
  tempCanvas.height = board.height;
  const tCtx = tempCanvas.getContext('2d');

  // Draw the underlying board Tint
  tCtx.fillStyle = window.getComputedStyle(board).backgroundColor || '#f8fbfd';
  tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

  const finishSave = () => {
    tCtx.drawImage(board, 0, 0);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.href = tempCanvas.toDataURL('image/png');
    link.download = `miniraft-board-${stamp}.png`;
    link.click();
  };

  const preset = backgroundPreset ? backgroundPreset.value : 'paper';
  if (preset === 'custom' && typeof uploadedBackgroundDataUrl === 'string') {
    const bgImg = new Image();
    bgImg.onload = () => {
      const pattern = tCtx.createPattern(bgImg, 'repeat');
      if (pattern) {
        tCtx.fillStyle = pattern;
        tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
        tCtx.fillStyle = 'rgba(255,255,255,0.2)'; // Mimic CSS overlay blend
        tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
      }
      finishSave();
    };
    bgImg.src = uploadedBackgroundDataUrl;
  } else {
    // Recreate the CSS visual linear gradient over the tint for export accuracy
    const presetGradients = {
      paper:  ['rgba(255,255,255,0.9)', 'rgba(245,249,252,0.96)'],
      mint:   ['rgba(236,253,245,0.82)', 'rgba(217,244,234,0.95)'],
      sunset: ['rgba(255,241,229,0.9)', 'rgba(244,225,216,0.96)'],
      ocean:  ['rgba(232,247,255,0.9)', 'rgba(217,236,250,0.96)'],
      slate:  ['rgba(235,241,247,0.9)', 'rgba(219,229,239,0.96)']
    };
    const overlay = presetGradients[preset] || presetGradients.paper;
    const grad = tCtx.createLinearGradient(0, 0, 0, tempCanvas.height);
    grad.addColorStop(0, overlay[0]);
    grad.addColorStop(1, overlay[1]);
    tCtx.fillStyle = grad;
    tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    
    finishSave();
  }
}

function drawShapePreview(mode, start, end, color, width) {
  if (!mode || !start || !end) {
    return;
  }

  ctx.save();
  if (color === '#ffffff' || eraserEnabled) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color;
  }
  
  ctx.lineWidth = width;
  ctx.lineDashOffset = (Date.now() / 20) % 14;
  ctx.setLineDash([8, 6]);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (mode === 'line') {
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (mode === 'rect') {
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);
    ctx.strokeRect(left, top, w, h);
    ctx.restore();
    return;
  }

  if (mode === 'circle') {
    const cx = (start.x + end.x) / 2;
    const cy = (start.y + end.y) / 2;
    const rx = Math.max(1, Math.abs(end.x - start.x) / 2);
    const ry = Math.max(1, Math.abs(end.y - start.y) / 2);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function buildShapeStrokes(mode, start, end, color, width) {
  if (!mode || !start || !end) {
    return [];
  }

  if (mode === 'line') {
    return [{ from: start, to: end, color, width }];
  }

  if (mode === 'rect') {
    const left = Math.min(start.x, end.x);
    const right = Math.max(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const bottom = Math.max(start.y, end.y);

    const p1 = { x: left, y: top };
    const p2 = { x: right, y: top };
    const p3 = { x: right, y: bottom };
    const p4 = { x: left, y: bottom };

    return [
      { from: p1, to: p2, color, width },
      { from: p2, to: p3, color, width },
      { from: p3, to: p4, color, width },
      { from: p4, to: p1, color, width }
    ];
  }

  if (mode === 'circle') {
    const cx = (start.x + end.x) / 2;
    const cy = (start.y + end.y) / 2;
    const rx = Math.max(1, Math.abs(end.x - start.x) / 2);
    const ry = Math.max(1, Math.abs(end.y - start.y) / 2);
    const segments = 36;
    const strokes = [];

    for (let i = 0; i < segments; i += 1) {
      const a1 = (Math.PI * 2 * i) / segments;
      const a2 = (Math.PI * 2 * (i + 1)) / segments;
      strokes.push({
        from: { x: cx + rx * Math.cos(a1), y: cy + ry * Math.sin(a1) },
        to: { x: cx + rx * Math.cos(a2), y: cy + ry * Math.sin(a2) },
        color,
        width
      });
    }

    return strokes;
  }

  return [];
}

function drawStroke(stroke) {
  if (!stroke || !stroke.from || !stroke.to) {
    return;
  }

  ctx.save();
  if (stroke.color === '#ffffff' || stroke.isEraser) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = stroke.color || '#1e8f5e';
  }
  
  ctx.lineWidth = Number(stroke.width || 3);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  ctx.beginPath();
  ctx.moveTo(stroke.from.x, stroke.from.y);
  ctx.lineTo(stroke.to.x, stroke.to.y);
  ctx.stroke();
  ctx.restore();
}

function clearCanvas() {
  const ratio = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, board.width / ratio, board.height / ratio);
}

function normalizedCommand(entry) {
  if (!entry) {
    return null;
  }
  if (entry.command && entry.command.action) {
    return entry.command;
  }
  if (entry.stroke) {
    return { action: 'draw', stroke: entry.stroke };
  }
  return null;
}

function renderCommittedState() {
  const ordered = committedEntries
    .slice()
    .sort((a, b) => {
      const indexDelta = Number(a.index) - Number(b.index);
      if (indexDelta !== 0) {
        return indexDelta;
      }
      return Number(a.term) - Number(b.term);
    });

  const active = [];
  const undone = [];

  for (const entry of ordered) {
    const command = entry.command;
    if (!command || !command.action) {
      continue;
    }

    if (command.action === 'draw' && command.stroke) {
      active.push(command.stroke);
      undone.length = 0;
      continue;
    }

    if (command.action === 'undo') {
      if (active.length > 0) {
        undone.push(active.pop());
      }
      continue;
    }

    if (command.action === 'redo') {
      if (undone.length > 0) {
        active.push(undone.pop());
      }
    }
  }

  clearCanvas();
  drawGrid();
  active.forEach(drawStroke);
  optimisticDrawById.forEach((stroke) => drawStroke(stroke));

  if (shapeMode && shapeStartPoint && shapeCurrentPoint) {
    drawShapePreview(shapeMode, shapeStartPoint, shapeCurrentPoint, activeStrokeColor(), Number(widthPicker.value));
  }

  updateStrokeCount(active.length + optimisticDrawById.size);
}

function commitEntry(entry) {
  if (!entry) {
    return;
  }

  const key = `${entry.term}:${entry.index}`;
  if (seenKeys.has(key)) {
    return;
  }

  seenKeys.add(key);

  const command = normalizedCommand(entry);
  if (!command) {
    return;
  }

  committedEntries.push({
    index: entry.index,
    term: entry.term,
    command
  });

  if (command.action === 'draw' && command.clientCommandId) {
    optimisticDrawById.delete(command.clientCommandId);
    updateSyncChip();
  }

  renderCommittedState();
}

function openSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  clearTimers();
  ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    reconnectAttempt = 0;
    updateConnectionChip(true, 'Connected');
    startPingLoop();
    flushOutboundQueue();
    updateSyncChip();
  };

  ws.onclose = () => {
    updateConnectionChip(false, 'Disconnected - retrying');
    scheduleReconnect();
    updateSyncChip();
  };

  ws.onerror = () => {
    updateConnectionChip(false, 'Connection error');
    updateSyncChip();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'snapshot' && Array.isArray(data.entries)) {
        data.entries.forEach(commitEntry);
        return;
      }

      if (data.type === 'stroke-committed' || data.type === 'entry-committed') {
        commitEntry(data.entry);
        if (data.leaderId) {
          updateLeaderChip(data.leaderId, data.term);
        }
        return;
      }

      if (data.type === 'error') {
        updateConnectionChip(false, data.message || 'Gateway rejected stroke');
      }
    } catch (_err) {
      // Ignore malformed payloads.
    }
  };
}

function boardPoint(evt) {
  const rect = board.getBoundingClientRect();
  return {
    x: evt.clientX - rect.left,
    y: evt.clientY - rect.top
  };
}

function sendStroke(stroke) {
  // Write path intentionally uses HTTP queue so drawing keeps committing
  // even when mobile websocket sessions flap.
  const clientCommandId = `${Date.now()}-${nextClientCommandId}`;
  nextClientCommandId += 1;

  optimisticDrawById.set(clientCommandId, stroke);
  enqueueCommandHttp({ action: 'draw', stroke, clientCommandId });
}

function sendUndo() {
  enqueueCommandHttp({ action: 'undo' });
}

function sendRedo() {
  enqueueCommandHttp({ action: 'redo' });
}

function beginDrawing(point) {
  if (shapeMode) {
    drawing = true;
    shapeStartPoint = point;
    shapeCurrentPoint = point;
    renderCommittedState();
    return;
  }

  drawing = true;
  previousPoint = point;
}

function moveDrawing(point) {
  if (shapeMode) {
    if (!drawing || !shapeStartPoint) {
      return;
    }

    shapeCurrentPoint = point;
    renderCommittedState();
    return;
  }

  if (!drawing || !previousPoint) {
    return;
  }

  const stroke = {
    from: previousPoint,
    to: point,
    color: activeStrokeColor(),
    width: Number(widthPicker.value),
    isEraser: eraserEnabled
  };

  drawStroke(stroke);
  sendStroke(stroke);
  previousPoint = point;
}

function endDrawing() {
  if (shapeMode && drawing && shapeStartPoint && shapeCurrentPoint) {
    const color = activeStrokeColor();
    const width = Number(widthPicker.value);
    const strokes = buildShapeStrokes(shapeMode, shapeStartPoint, shapeCurrentPoint, color, width);

    strokes.forEach((stroke) => {
      drawStroke(stroke);
      sendStroke(stroke);
    });

    shapeStartPoint = null;
    shapeCurrentPoint = null;
    drawing = false;
    renderCommittedState();
    return;
  }

  drawing = false;
  previousPoint = null;
}

function installInputHandlers() {
  if (window.PointerEvent) {
    board.addEventListener('pointerdown', (evt) => {
      beginDrawing(boardPoint(evt));
      if (board.setPointerCapture) {
        board.setPointerCapture(evt.pointerId);
      }
    });

    board.addEventListener('pointermove', (evt) => {
      moveDrawing(boardPoint(evt));
    });

    board.addEventListener('pointerup', endDrawing);
    board.addEventListener('pointercancel', endDrawing);
    return;
  }

  const touchPoint = (touch) => {
    const rect = board.getBoundingClientRect();
    return {
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top
    };
  };

  board.addEventListener('touchstart', (evt) => {
    if (!evt.touches || evt.touches.length === 0) {
      return;
    }
    evt.preventDefault();
    beginDrawing(touchPoint(evt.touches[0]));
  }, { passive: false });

  board.addEventListener('touchmove', (evt) => {
    if (!evt.touches || evt.touches.length === 0) {
      return;
    }
    evt.preventDefault();
    moveDrawing(touchPoint(evt.touches[0]));
  }, { passive: false });

  board.addEventListener('touchend', endDrawing, { passive: true });
  board.addEventListener('touchcancel', endDrawing, { passive: true });

  board.addEventListener('mousedown', (evt) => beginDrawing(boardPoint(evt)));
  board.addEventListener('mousemove', (evt) => moveDrawing(boardPoint(evt)));
  board.addEventListener('mouseup', endDrawing);
  board.addEventListener('mouseleave', endDrawing);
}

clearLocalBtn.addEventListener('click', () => {
  clearCanvas();
  drawGrid();
  optimisticDrawById.clear();
  updateSyncChip();
});

if (eraserBtn) {
  eraserBtn.addEventListener('click', () => {
    setEraserMode(!eraserEnabled);
  });
}

if (lineBtn) {
  lineBtn.addEventListener('click', () => {
    setShapeMode(shapeMode === 'line' ? null : 'line');
  });
}

if (rectBtn) {
  rectBtn.addEventListener('click', () => {
    setShapeMode(shapeMode === 'rect' ? null : 'rect');
  });
}

if (circleBtn) {
  circleBtn.addEventListener('click', () => {
    setShapeMode(shapeMode === 'circle' ? null : 'circle');
  });
}

if (gridBtn) {
  gridBtn.addEventListener('click', () => {
    setGridMode(!gridEnabled);
  });
}

if (saveBtn) {
  saveBtn.addEventListener('click', () => {
    saveBoardImage();
  });
}

if (backgroundPreset) {
  backgroundPreset.addEventListener('change', () => {
    applyBoardLook({
      preset: backgroundPreset.value,
      tint: backgroundTint ? backgroundTint.value : '#f8fbfd',
      texture: textureStrength ? Number(textureStrength.value) : 18
    });
  });
}

if (backgroundTint) {
  backgroundTint.addEventListener('input', () => {
    applyBoardLook({
      preset: backgroundPreset ? backgroundPreset.value : 'paper',
      tint: backgroundTint.value,
      texture: textureStrength ? Number(textureStrength.value) : 18
    });
  });
}

if (textureStrength) {
  textureStrength.addEventListener('input', () => {
    applyBoardLook({
      preset: backgroundPreset ? backgroundPreset.value : 'paper',
      tint: backgroundTint ? backgroundTint.value : '#f8fbfd',
      texture: Number(textureStrength.value)
    });
  });
}

if (randomThemeBtn) {
  randomThemeBtn.addEventListener('click', () => {
    const keys = Object.keys(boardBackgroundPresets);
    const nextPreset = keys[Math.floor(Math.random() * keys.length)];
    const randomTint = `#${Math.floor(Math.random() * 0xffffff)
      .toString(16)
      .padStart(6, '0')}`;
    const texture = 10 + Math.floor(Math.random() * 50);

    if (backgroundPreset) {
      updateBgPreset(nextPreset);
    }
    if (backgroundTint) {
      backgroundTint.value = randomTint;
    }
    if (textureStrength) {
      textureStrength.value = String(texture);
    }

    applyBoardLook({
      preset: nextPreset,
      tint: randomTint,
      texture
    });
  });
}

if (backgroundUpload) {
  backgroundUpload.addEventListener('change', () => {
    const file = backgroundUpload.files && backgroundUpload.files[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        return;
      }
      uploadedBackgroundDataUrl = reader.result;
      if (backgroundPreset) {
        updateBgPreset('custom');
      }
      applyBoardLook({
        preset: 'custom',
        tint: backgroundTint ? backgroundTint.value : '#f8fbfd',
        texture: textureStrength ? Number(textureStrength.value) : 18
      });
    };
    reader.readAsDataURL(file);
  });
}

if (colorPicker) {
  colorPicker.addEventListener('input', () => {
    if (eraserEnabled) {
      setEraserMode(false);
    }
    updateToolChip();
  });
}

if (widthPicker) {
  widthPicker.addEventListener('input', () => {
    updateToolChip();
  });
}

swatchButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const color = btn.dataset.color;
    if (!color) {
      return;
    }
    colorPicker.value = color;
    if (eraserEnabled) {
      setEraserMode(false);
    }
    updateToolChip();
  });
});

if (undoBtn) {
  undoBtn.addEventListener('click', () => {
    sendUndo();
  });
}

if (redoBtn) {
  redoBtn.addEventListener('click', () => {
    sendRedo();
  });
}

document.addEventListener('keydown', (evt) => {
  if (evt.key.toLowerCase() === 'e' && !evt.metaKey && !evt.ctrlKey) {
    setEraserMode(!eraserEnabled);
    return;
  }

  if (evt.key.toLowerCase() === 'b' && !evt.metaKey && !evt.ctrlKey) {
    setShapeMode(null);
    setEraserMode(false);
    return;
  }

  if (evt.key.toLowerCase() === 'l' && !evt.metaKey && !evt.ctrlKey) {
    setShapeMode(shapeMode === 'line' ? null : 'line');
    return;
  }

  if (evt.key.toLowerCase() === 'r' && !evt.metaKey && !evt.ctrlKey) {
    setShapeMode(shapeMode === 'rect' ? null : 'rect');
    return;
  }

  if (evt.key.toLowerCase() === 'c' && !evt.metaKey && !evt.ctrlKey) {
    setShapeMode(shapeMode === 'circle' ? null : 'circle');
    return;
  }

  if (evt.key.toLowerCase() === 'g' && !evt.metaKey && !evt.ctrlKey) {
    setGridMode(!gridEnabled);
    return;
  }

  if (evt.key.toLowerCase() === 's' && (evt.metaKey || evt.ctrlKey)) {
    evt.preventDefault();
    saveBoardImage();
    return;
  }

  const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  const modKey = isMac ? evt.metaKey : evt.ctrlKey;
  if (!modKey || evt.key.toLowerCase() !== 'z') {
    return;
  }

  evt.preventDefault();
  if (evt.shiftKey) {
    sendRedo();
  } else {
    sendUndo();
  }
});

window.addEventListener('resize', () => {
  fitCanvas();
  renderCommittedState();
  updateSyncChip();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    openSocket();
    pollCommittedLog();
    pollLeader();
  }
});

function makePanelsDraggable() {
  const panels = document.querySelectorAll('.panel');
  panels.forEach(panel => {
    const handle = document.createElement('div');
    handle.className = 'drag-handle';
    panel.prepend(handle);

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    handle.addEventListener('pointerdown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = panel.getBoundingClientRect();
      panel.style.position = 'fixed';
      panel.style.margin = '0';
      panel.style.transform = 'none';
      panel.style.bottom = 'auto';
      panel.style.right = 'auto';
      
      initialLeft = rect.left;
      initialTop = rect.top;
      
      panel.style.left = initialLeft + 'px';
      panel.style.top = initialTop + 'px';

      handle.setPointerCapture(e.pointerId);
      panel.style.zIndex = '100'; // bring to front while dragging
      e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panel.style.left = (initialLeft + dx) + 'px';
      panel.style.top = (initialTop + dy) + 'px';
      e.preventDefault();
    });

    handle.addEventListener('pointerup', (e) => {
      if (!isDragging) return;
      isDragging = false;
      handle.releasePointerCapture(e.pointerId);
      panel.style.zIndex = '10'; // reset Z-index
    });

    handle.addEventListener('pointercancel', (e) => {
      if (!isDragging) return;
      isDragging = false;
      handle.releasePointerCapture(e.pointerId);
      panel.style.zIndex = '10';
    });
  });
}

fitCanvas();
makePanelsDraggable();

function updateBgPreset(val) {
  if (backgroundPreset) backgroundPreset.value = val;
  document.querySelectorAll('.bg-swatch').forEach(s => {
    if (s.dataset.preset === val) s.classList.add('active');
    else s.classList.remove('active');
  });
}

document.querySelectorAll('.bg-swatch').forEach(sw => {
  sw.addEventListener('click', (e) => {
    e.preventDefault();
    updateBgPreset(sw.dataset.preset);
    if (backgroundPreset) {
      backgroundPreset.dispatchEvent(new Event('change'));
    }
  });
});

loadLookState();
applyBoardLook({
  preset: backgroundPreset ? backgroundPreset.value : 'paper',
  tint: backgroundTint ? backgroundTint.value : '#f8fbfd',
  texture: textureStrength ? Number(textureStrength.value) : 18
});
if (dashboardLink) {
  dashboardLink.href = dashboardUrl();
}
installInputHandlers();
openSocket();
startPollLoop();
updateSyncChip();
updateToolChip();
pollCommittedLog();
pollLeader();

