const http = require('http');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
axios.defaults.headers.common['ngrok-skip-browser-warning'] = 'true';
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 4000);
const AUTO_HEAL_PARTITIONS = process.env.AUTO_HEAL_PARTITIONS !== 'false';
const REPLICAS = (process.env.REPLICA_URLS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let leader = {
  url: null,
  nodeId: null,
  term: 0
};

const committedLog = [];
const committedIndexSet = new Set();
let wsHeartbeatTimer = null;

const eventFeed = [];
const MAX_EVENTS = 200;

function addEvent(nodeId, eventType, detail) {
  const evt = {
    ts: new Date().toISOString(),
    nodeId,
    eventType,
    detail
  };
  eventFeed.push(evt);
  if (eventFeed.length > MAX_EVENTS) {
    eventFeed.splice(0, eventFeed.length - MAX_EVENTS);
  }
  broadcast({ type: 'event-feed', event: evt });
}

function log(msg) {
  console.log(`[gateway] ${new Date().toISOString()} ${msg}`);
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function entryKey(entry) {
  return `${entry.term}:${entry.index}`;
}

function recordCommit(entry) {
  const key = entryKey(entry);
  if (committedIndexSet.has(key)) {
    return false;
  }
  committedIndexSet.add(key);
  committedLog.push(entry);
  return true;
}

async function queryStatus(replicaUrl) {
  try {
    const res = await axios.get(`${replicaUrl}/status`, { timeout: 350 });
    return { ok: true, url: replicaUrl, status: res.data };
  } catch (_err) {
    return { ok: false, url: replicaUrl };
  }
}

async function discoverLeader() {
  if (REPLICAS.length === 0) {
    return null;
  }

  const statuses = await Promise.all(REPLICAS.map((url) => queryStatus(url)));
  const leaderCandidates = statuses
    .filter((x) => x.ok && x.status.role === 'leader')
    .sort((a, b) => Number(b.status.currentTerm || 0) - Number(a.status.currentTerm || 0));
  const leaderStatus = leaderCandidates[0] || null;

  if (leaderStatus) {
    const nextTerm = Number(leaderStatus.status.currentTerm || 0);
    const currentTerm = Number(leader.term || 0);

    // Keep gateway leader cache monotonic by term to avoid stale leader regressions.
    if (leader.url && nextTerm < currentTerm) {
      return leader.url;
    }

    const changed =
      leader.url !== leaderStatus.url ||
      leader.nodeId !== leaderStatus.status.nodeId ||
      currentTerm !== nextTerm;
    leader = {
      url: leaderStatus.url,
      nodeId: leaderStatus.status.nodeId,
      term: nextTerm
    };
    if (changed) {
      log(`leader updated to ${leader.nodeId} at ${leader.url} (term ${leader.term})`);
      addEvent(leader.nodeId, 'LEADER_ELECTED', `Became leader | Term: ${leader.term}`);
    }
    return leader.url;
  }

  return null;
}

function maybeReplicaUrlByNodeId(nodeId) {
  if (!nodeId) {
    return null;
  }
  const host = String(nodeId);
  return REPLICAS.find((x) => x.includes(host)) || null;
}

async function forwardCommand(command) {
  let target = leader.url;
  if (!target) {
    target = await discoverLeader();
  }

  if (!target) {
    throw new Error('no leader available');
  }

  try {
    const res = await axios.post(`${target}/client-entry`, { command }, { timeout: 900 });
    if (res.data && (res.data.committed === false || res.data.success === false)) {
      await discoverLeader();
      throw new Error(res.data.error || 'not-committed');
    }
    return res.data;
  } catch (err) {
    const response = err.response;
    if (response && response.status === 409 && response.data?.leaderId) {
      const hinted = maybeReplicaUrlByNodeId(response.data.leaderId);
      if (hinted) {
        const hintedTerm = Number(response.data.term || 0);
        const currentTerm = Number(leader.term || 0);
        if (leader.url && hintedTerm > 0 && hintedTerm < currentTerm) {
          await discoverLeader();
          throw new Error('stale-leader-hint');
        }

        leader = {
          url: hinted,
          nodeId: response.data.leaderId,
          term: hintedTerm > 0 ? hintedTerm : leader.term
        };
        const retry = await axios.post(`${hinted}/client-entry`, { command }, { timeout: 900 });
        return retry.data;
      }
    }

    await discoverLeader();
    throw err;
  }
}

async function clusterStatusSnapshot() {
  const statuses = await Promise.all(REPLICAS.map((url) => queryStatus(url)));
  return {
    leader,
    replicas: statuses.map((item) => ({
      url: item.url,
      ok: item.ok,
      status: item.ok ? item.status : null
    }))
  };
}

async function postPartition(nodeId, isolated, blockedPeers) {
  const targetUrl = maybeReplicaUrlByNodeId(nodeId);
  if (!targetUrl) {
    throw new Error(`replica ${nodeId} not found`);
  }
  const res = await axios.post(
    `${targetUrl}/admin/partition`,
    {
      isolated,
      blockedPeers
    },
    { timeout: 600 }
  );
  return res.data;
}

async function healAllPartitions() {
  const updates = await Promise.all(
    REPLICAS.map(async (url) => {
      const nodeId = url.replace(/^https?:\/\//, '').split(':')[0];
      const result = await postPartition(nodeId, false, []);
      return result;
    })
  );
  return updates;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/leader', (_req, res) => {
  res.json({ leader, replicas: REPLICAS });
});

app.get('/committed-log', (_req, res) => {
  res.json({
    count: committedLog.length,
    entries: committedLog
  });
});

app.get('/cluster-status', async (_req, res) => {
  const snapshot = await clusterStatusSnapshot();
  snapshot.gateway = {
    nodeId: 'gateway',
    role: 'gateway',
    currentTerm: leader.term,
    logLength: committedLog.length,
    commitIndex: committedLog.length - 1,
    leaderId: leader.nodeId,
    url: `http://gateway:${PORT}`,
    wsClients: wss.clients.size
  };
  res.json(snapshot);
});

app.get('/event-feed', (_req, res) => {
  const limit = Math.min(Number(_req.query?.limit) || 50, MAX_EVENTS);
  res.json({ events: eventFeed.slice(-limit) });
});

app.post('/submit-command', async (req, res) => {
  const { command, stroke } = req.body || {};
  const effectiveCommand = command || (stroke ? { action: 'draw', stroke } : null);

  if (!effectiveCommand) {
    return res.status(400).json({ success: false, error: 'missing-command' });
  }

  try {
    const result = await forwardCommand(effectiveCommand);
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(502).json({ success: false, error: err.message || 'submit-failed' });
  }
});

app.post('/admin/partition', async (req, res) => {
  const { nodeId, isolated = false, blockedPeers = [] } = req.body || {};
  if (!nodeId) {
    return res.status(400).json({ success: false, error: 'missing-nodeId' });
  }

  try {
    const result = await postPartition(nodeId, isolated, blockedPeers);
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(502).json({ success: false, error: err.message });
  }
});

app.post('/admin/partition/heal-all', async (_req, res) => {
  try {
    const updates = await healAllPartitions();
    return res.json({ success: true, updates });
  } catch (err) {
    return res.status(502).json({ success: false, error: err.message });
  }
});

app.post('/committed-entry', (req, res) => {
  const { entry, leaderId, term } = req.body || {};
  if (!entry) {
    return res.status(400).json({ success: false, error: 'missing-entry' });
  }

  const inserted = recordCommit(entry);
  if (inserted) {
    broadcast({ type: 'entry-committed', entry, leaderId, term });
    addEvent(leaderId || 'unknown', 'ENTRY_COMMITTED', `Committed index ${entry.index} | Term: ${term}`);
  }

  return res.json({ success: true, inserted });
});

wss.on('connection', (ws) => {
  log('client connected');
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.send(
    JSON.stringify({
      type: 'snapshot',
      entries: committedLog
    })
  );

  ws.on('message', async (raw) => {
    try {
      const payload = JSON.parse(raw.toString());
      if (payload.type === 'stroke' && payload.stroke) {
        await forwardCommand({ action: 'draw', ...payload.strokeMeta, stroke: payload.stroke });
        return;
      }
      if (payload.type === 'undo') {
        await forwardCommand({ action: 'undo', ...payload.data });
        return;
      }
      if (payload.type === 'redo') {
        await forwardCommand({ action: 'redo', ...payload.data });
        return;
      }
      if (payload.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        return;
      }
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: err.message || 'failed to forward event'
        })
      );
    }
  });

  ws.on('close', () => {
    log('client disconnected');
  });
});

function startWsHeartbeatLoop() {
  if (wsHeartbeatTimer) {
    clearInterval(wsHeartbeatTimer);
  }

  wsHeartbeatTimer = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      if (client.isAlive === false) {
        client.terminate();
        continue;
      }

      client.isAlive = false;
      client.ping();
    }
  }, 15000);
}

setInterval(() => {
  discoverLeader().catch(() => {
    // Ignore periodic discovery errors; failover can still recover on demand.
  });
}, 800);

server.listen(PORT, () => {
  log(`gateway listening on port ${PORT}`);
  discoverLeader().catch(() => {
    log('no leader available at startup');
  });

  if (AUTO_HEAL_PARTITIONS) {
    healAllPartitions()
      .then(() => {
        log('startup partition auto-heal completed');
      })
      .catch(() => {
        log('startup partition auto-heal skipped');
      });
  }

  startWsHeartbeatLoop();
});
