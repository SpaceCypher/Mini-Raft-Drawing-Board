const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '2mb' }));

const NODE_ID = process.env.NODE_ID || 'replica1';
const PORT = Number(process.env.PORT || 5001);
const PEERS = (process.env.PEERS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://gateway:4000';

const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 150);
const ELECTION_TIMEOUT_MIN_MS = Number(process.env.ELECTION_TIMEOUT_MIN_MS || 500);
const ELECTION_TIMEOUT_MAX_MS = Number(process.env.ELECTION_TIMEOUT_MAX_MS || 800);

let role = 'follower';
let currentTerm = 0;
let votedFor = null;
let leaderId = null;

let logEntries = [];
let commitIndex = -1;

let electionTimer = null;
let heartbeatTimer = null;

const partitionState = {
  isolated: false,
  blockedPeers: new Set()
};

function majority() {
  return Math.floor((PEERS.length + 1) / 2) + 1;
}

function now() {
  return new Date().toISOString();
}

function logEvent(message) {
  console.log(`[${now()}] [${NODE_ID}] [term=${currentTerm}] [${role}] ${message}`);
}

function getElectionTimeout() {
  const span = ELECTION_TIMEOUT_MAX_MS - ELECTION_TIMEOUT_MIN_MS;
  return ELECTION_TIMEOUT_MIN_MS + Math.floor(Math.random() * (span + 1));
}

function clearHeartbeatLoop() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function resetElectionTimer() {
  if (electionTimer) {
    clearTimeout(electionTimer);
  }
  electionTimer = setTimeout(() => {
    if (role !== 'leader') {
      startElection().catch((err) => {
        logEvent(`election failed: ${err.message}`);
      });
    }
  }, getElectionTimeout());
}

function becomeFollower(term, nextLeaderId = null) {
  const termChanged = term > currentTerm;
  if (termChanged) {
    currentTerm = term;
    votedFor = null;
  }
  role = 'follower';
  if (nextLeaderId) {
    leaderId = nextLeaderId;
  }
  clearHeartbeatLoop();
  resetElectionTimer();
}

function lastLogTerm() {
  if (logEntries.length === 0) {
    return 0;
  }
  return logEntries[logEntries.length - 1].term;
}

function candidateLogIsUpToDate(candidateLastIndex, candidateLastTerm) {
  const myLastIndex = logEntries.length - 1;
  const myLastTerm = lastLogTerm();
  if (candidateLastTerm !== myLastTerm) {
    return candidateLastTerm > myLastTerm;
  }
  return candidateLastIndex >= myLastIndex;
}

function peerNameFromUrl(peerUrl) {
  const cleaned = peerUrl.replace(/^https?:\/\//, '');
  return cleaned.split(':')[0];
}

function inferSenderNodeId(reqBody, headers) {
  return (
    headers['x-node-id'] ||
    reqBody?.candidateId ||
    reqBody?.leaderId ||
    reqBody?.requesterId ||
    null
  );
}

function isSenderBlocked(senderId) {
  return Boolean(senderId) && partitionState.blockedPeers.has(senderId);
}

function isOutboundBlocked(peerUrl) {
  if (partitionState.isolated) {
    return true;
  }
  const peerNodeId = peerNameFromUrl(peerUrl);
  return partitionState.blockedPeers.has(peerNodeId);
}

function setPartition(isolated, blockedPeers) {
  partitionState.isolated = Boolean(isolated);
  partitionState.blockedPeers = new Set(
    Array.isArray(blockedPeers) ? blockedPeers.filter(Boolean) : []
  );
}

function rpcRejectedByPartition(req, res) {
  const senderId = inferSenderNodeId(req.body, req.headers);
  if (partitionState.isolated || isSenderBlocked(senderId)) {
    return res.status(503).json({
      success: false,
      error: 'partitioned',
      nodeId: NODE_ID,
      isolated: partitionState.isolated,
      blockedPeers: Array.from(partitionState.blockedPeers)
    });
  }
  return null;
}

async function sendRequestVote(peerUrl, payload) {
  if (isOutboundBlocked(peerUrl)) {
    return { voteGranted: false, unreachable: true, term: currentTerm };
  }
  try {
    const res = await axios.post(`${peerUrl}/request-vote`, payload, {
      timeout: 300,
      headers: { 'x-node-id': NODE_ID }
    });
    return res.data;
  } catch (_err) {
    return { voteGranted: false, unreachable: true, term: currentTerm };
  }
}

async function becomeLeader() {
  role = 'leader';
  leaderId = NODE_ID;
  if (electionTimer) {
    clearTimeout(electionTimer);
    electionTimer = null;
  }
  logEvent('became leader');

  clearHeartbeatLoop();
  heartbeatTimer = setInterval(() => {
    sendHeartbeats().catch((err) => {
      logEvent(`heartbeat loop error: ${err.message}`);
    });
  }, HEARTBEAT_INTERVAL_MS);

  await sendHeartbeats();
}

async function startElection() {
  role = 'candidate';
  currentTerm += 1;
  votedFor = NODE_ID;
  leaderId = null;

  const electionTerm = currentTerm;
  let votes = 1;

  logEvent(`starting election for term ${electionTerm}`);
  resetElectionTimer();

  const payload = {
    term: electionTerm,
    candidateId: NODE_ID,
    lastLogIndex: logEntries.length - 1,
    lastLogTerm: lastLogTerm()
  };

  const results = await Promise.all(PEERS.map((peerUrl) => sendRequestVote(peerUrl, payload)));

  for (const result of results) {
    if (result.term > currentTerm) {
      logEvent(`discovered higher term ${result.term}, stepping down`);
      becomeFollower(result.term);
      return;
    }
    if (result.voteGranted && role === 'candidate' && currentTerm === electionTerm) {
      votes += 1;
    }
  }

  if (role === 'candidate' && currentTerm === electionTerm && votes >= majority()) {
    await becomeLeader();
    return;
  }

  if (role === 'candidate') {
    logEvent(`election term ${electionTerm} ended with ${votes} vote(s), retrying`);
  }
}

async function sendHeartbeats() {
  if (role !== 'leader') {
    return;
  }

  let acks = 1;

  await Promise.all(
    PEERS.map(async (peerUrl) => {
      if (isOutboundBlocked(peerUrl)) {
        return;
      }
      try {
        const res = await axios.post(
          `${peerUrl}/heartbeat`,
          {
            term: currentTerm,
            leaderId: NODE_ID,
            leaderCommit: commitIndex
          },
          {
            timeout: 300,
            headers: { 'x-node-id': NODE_ID }
          }
        );

        if (res.data.term > currentTerm) {
          logEvent(`heartbeat saw higher term ${res.data.term}, stepping down`);
          becomeFollower(res.data.term, res.data.leaderId || null);
          return;
        }

        acks++;

        const followerCommitIndex = Number(res.data.commitIndex ?? -1);
        if (Number.isFinite(followerCommitIndex) && followerCommitIndex < commitIndex) {
          await pushSyncToFollower(peerUrl, followerCommitIndex + 1);
        }
      } catch (_err) {
        logEvent(`heartbeat failed to ${peerNameFromUrl(peerUrl)}`);
      }
    })
  );

  if (role === 'leader' && acks < majority()) {
    logEvent(`lost quorum during heartbeats (only ${acks} acks), stepping down`);
    becomeFollower(currentTerm, null);
  }
}

async function pushSyncToFollower(peerUrl, fromIndex) {
  if (role !== 'leader' || isOutboundBlocked(peerUrl)) {
    return;
  }

  const boundedFrom = Math.max(0, fromIndex);
  const entries = logEntries.slice(boundedFrom, commitIndex + 1);
  if (entries.length === 0) {
    return;
  }

  try {
    await axios.post(
      `${peerUrl}/sync-log`,
      {
        apply: true,
        term: currentTerm,
        leaderId: NODE_ID,
        fromIndex: boundedFrom,
        leaderCommit: commitIndex,
        entries
      },
      {
        timeout: 500,
        headers: { 'x-node-id': NODE_ID }
      }
    );
    logEvent(`synced ${entries.length} entries to ${peerNameFromUrl(peerUrl)} from index ${boundedFrom}`);
  } catch (_err) {
    logEvent(`sync push failed to ${peerNameFromUrl(peerUrl)}`);
  }
}

async function notifyGatewayCommitted(entry) {
  try {
    await axios.post(
      `${GATEWAY_URL}/committed-entry`,
      {
        entry,
        term: currentTerm,
        leaderId: NODE_ID
      },
      { timeout: 400 }
    );
  } catch (_err) {
    logEvent(`failed to notify gateway for committed index ${entry.index}`);
  }
}

app.get('/status', (_req, res) => {
  res.json({
    nodeId: NODE_ID,
    role,
    currentTerm,
    votedFor,
    leaderId,
    logLength: logEntries.length,
    commitIndex,
    majority: majority(),
    partition: {
      isolated: partitionState.isolated,
      blockedPeers: Array.from(partitionState.blockedPeers)
    }
  });
});

app.get('/partition', (_req, res) => {
  res.json({
    nodeId: NODE_ID,
    isolated: partitionState.isolated,
    blockedPeers: Array.from(partitionState.blockedPeers)
  });
});

app.post('/admin/partition', (req, res) => {
  const { isolated = false, blockedPeers = [] } = req.body || {};
  setPartition(isolated, blockedPeers);
  logEvent(`partition updated: isolated=${partitionState.isolated}, blocked=${Array.from(partitionState.blockedPeers).join(',') || 'none'}`);
  res.json({
    success: true,
    nodeId: NODE_ID,
    isolated: partitionState.isolated,
    blockedPeers: Array.from(partitionState.blockedPeers)
  });
});

app.post('/request-vote', (req, res) => {
  const blocked = rpcRejectedByPartition(req, res);
  if (blocked) {
    return;
  }

  const { term, candidateId, lastLogIndex = -1, lastLogTerm = 0 } = req.body || {};

  if (term < currentTerm) {
    return res.json({ term: currentTerm, voteGranted: false });
  }

  if (term > currentTerm) {
    becomeFollower(term);
  }

  const canVote = votedFor === null || votedFor === candidateId;
  const upToDate = candidateLogIsUpToDate(lastLogIndex, lastLogTerm);

  if (canVote && upToDate) {
    votedFor = candidateId;
    leaderId = null;
    resetElectionTimer();
    logEvent(`voted for ${candidateId} in term ${term}`);
    return res.json({ term: currentTerm, voteGranted: true });
  }

  return res.json({ term: currentTerm, voteGranted: false });
});

app.post('/heartbeat', (req, res) => {
  const blocked = rpcRejectedByPartition(req, res);
  if (blocked) {
    return;
  }

  const { term, leaderId: incomingLeaderId, leaderCommit = -1 } = req.body || {};

  if (term < currentTerm) {
    return res.json({ success: false, term: currentTerm, commitIndex });
  }

  if (term > currentTerm || role !== 'follower') {
    becomeFollower(term, incomingLeaderId);
  } else {
    leaderId = incomingLeaderId;
    resetElectionTimer();
  }

  if (leaderCommit > commitIndex) {
    commitIndex = Math.min(leaderCommit, logEntries.length - 1);
  }

  return res.json({ success: true, term: currentTerm, commitIndex });
});

app.post('/append-entries', (req, res) => {
  const blocked = rpcRejectedByPartition(req, res);
  if (blocked) {
    return;
  }

  const {
    term,
    leaderId: incomingLeaderId,
    prevLogIndex = -1,
    prevLogTerm = 0,
    entry,
    leaderCommit = -1
  } = req.body || {};

  if (term < currentTerm) {
    return res.json({ success: false, term: currentTerm, needSyncFrom: logEntries.length });
  }

  if (term > currentTerm || role !== 'follower') {
    becomeFollower(term, incomingLeaderId);
  } else {
    leaderId = incomingLeaderId;
    resetElectionTimer();
  }

  if (prevLogIndex >= 0) {
    const localPrev = logEntries[prevLogIndex];
    if (!localPrev) {
      return res.json({ success: false, term: currentTerm, needSyncFrom: logEntries.length });
    }

    if (localPrev.term !== prevLogTerm) {
      // Return the first index of the conflicting term to let leader backtrack correctly.
      let conflictFrom = prevLogIndex;
      while (conflictFrom > 0 && logEntries[conflictFrom - 1]?.term === localPrev.term) {
        conflictFrom -= 1;
      }
      return res.json({ success: false, term: currentTerm, needSyncFrom: conflictFrom });
    }
  }

  if (entry) {
    if (entry.index > logEntries.length) {
      return res.json({ success: false, term: currentTerm, needSyncFrom: logEntries.length });
    }

    const existing = logEntries[entry.index];
    if (existing && existing.term !== entry.term) {
      logEntries = logEntries.slice(0, entry.index);
    }

    if (!logEntries[entry.index]) {
      logEntries.push(entry);
    }
  }

  if (leaderCommit > commitIndex) {
    commitIndex = Math.min(leaderCommit, logEntries.length - 1);
  }

  return res.json({ success: true, term: currentTerm, matchIndex: entry ? entry.index : logEntries.length - 1, commitIndex });
});

app.post('/sync-log', (req, res) => {
  const blocked = rpcRejectedByPartition(req, res);
  if (blocked) {
    return;
  }

  const {
    apply = false,
    term,
    requesterId,
    fromIndex = 0,
    entries = [],
    leaderId: incomingLeaderId,
    leaderCommit = -1
  } = req.body || {};

  if (apply) {
    if (term < currentTerm) {
      return res.json({ success: false, term: currentTerm });
    }

    if (term > currentTerm || role !== 'follower') {
      becomeFollower(term, incomingLeaderId);
    } else {
      leaderId = incomingLeaderId;
      resetElectionTimer();
    }

    const boundedFrom = Math.max(0, Number(fromIndex));
    logEntries = logEntries.slice(0, boundedFrom).concat(entries);
    if (leaderCommit > commitIndex) {
      commitIndex = Math.min(leaderCommit, logEntries.length - 1);
    }

    logEvent(`applied sync with ${entries.length} entries from index ${boundedFrom}`);
    return res.json({ success: true, term: currentTerm, logLength: logEntries.length, commitIndex });
  }

  if (role !== 'leader') {
    return res.status(409).json({ success: false, error: 'not-leader', term: currentTerm, leaderId });
  }

  const boundedFrom = Math.max(0, Number(fromIndex));
  const committedEntries = logEntries.slice(boundedFrom, commitIndex + 1);
  logEvent(`serving sync request from ${requesterId || 'unknown'} starting at ${boundedFrom}`);

  return res.json({
    success: true,
    term: currentTerm,
    leaderId: NODE_ID,
    fromIndex: boundedFrom,
    entries: committedEntries,
    leaderCommit: commitIndex
  });
});

app.post('/client-entry', async (req, res) => {
  if (role !== 'leader') {
    return res.status(409).json({
      success: false,
      error: 'not-leader',
      leaderId,
      term: currentTerm
    });
  }

  const { stroke, command } = req.body || {};
  const normalizedCommand = command || (stroke ? { action: 'draw', stroke } : null);
  const leaderTermAtStart = currentTerm;

  if (!normalizedCommand || !normalizedCommand.action) {
    return res.status(400).json({ success: false, error: 'missing-command' });
  }

  const entry = {
    index: logEntries.length,
    term: leaderTermAtStart,
    command: normalizedCommand,
    timestamp: Date.now()
  };
  logEntries.push(entry);

  let acks = 1;

  await Promise.all(
    PEERS.map(async (peerUrl) => {
      if (isOutboundBlocked(peerUrl)) {
        return;
      }
      try {
        const result = await axios.post(
          `${peerUrl}/append-entries`,
          {
            term: leaderTermAtStart,
            leaderId: NODE_ID,
            prevLogIndex: entry.index - 1,
            prevLogTerm: entry.index - 1 >= 0 ? logEntries[entry.index - 1].term : 0,
            entry,
            leaderCommit: commitIndex
          },
          {
            timeout: 500,
            headers: { 'x-node-id': NODE_ID }
          }
        );

        if (result.data.term > currentTerm) {
          becomeFollower(result.data.term, result.data.leaderId || null);
          return;
        }

        if (result.data.success) {
          acks += 1;
          return;
        }

        if (Number.isFinite(result.data.needSyncFrom)) {
          await pushSyncToFollower(peerUrl, result.data.needSyncFrom);
        }
      } catch (_err) {
        logEvent(`append failed to ${peerNameFromUrl(peerUrl)}`);
      }
    })
  );

  if (role !== 'leader' || currentTerm !== leaderTermAtStart) {
    return res.status(409).json({ success: false, error: 'leadership-lost' });
  }

  if (acks >= majority()) {
    commitIndex = entry.index;
    logEvent(`committed entry index ${entry.index} with ${acks} ack(s)`);

    await notifyGatewayCommitted(entry);
    await sendHeartbeats();

    return res.json({ success: true, committed: true, index: entry.index, term: currentTerm });
  }

  logEvent(`entry index ${entry.index} not committed, only ${acks} ack(s)`);
  // Avoid advertising leadership after quorum loss; this prevents stale-leader routing.
  becomeFollower(currentTerm, null);
  return res.status(503).json({
    success: false,
    committed: false,
    error: 'no-quorum',
    retryable: true,
    index: entry.index,
    term: currentTerm
  });
});

async function catchUpOnStartup() {
  try {
    const statuses = await Promise.all(
      PEERS.map(async (peerUrl) => {
        if (isOutboundBlocked(peerUrl)) {
          return { peerUrl, ok: false };
        }
        try {
          const res = await axios.get(`${peerUrl}/status`, {
            timeout: 350,
            headers: { 'x-node-id': NODE_ID }
          });
          return { peerUrl, ok: true, status: res.data };
        } catch (_err) {
          return { peerUrl, ok: false };
        }
      })
    );

    const leaderPeer = statuses.find((x) => x.ok && x.status.role === 'leader');
    if (!leaderPeer) {
      return;
    }

    const fromIndex = Math.max(0, commitIndex + 1);
    const res = await axios.post(
      `${leaderPeer.peerUrl}/sync-log`,
      {
        requesterId: NODE_ID,
        term: currentTerm,
        fromIndex
      },
      {
        timeout: 700,
        headers: { 'x-node-id': NODE_ID }
      }
    );

    const payload = res.data;
    if (!payload.success || !Array.isArray(payload.entries) || payload.entries.length === 0) {
      return;
    }

    logEntries = logEntries.slice(0, payload.fromIndex).concat(payload.entries);
    commitIndex = Math.max(commitIndex, payload.leaderCommit ?? commitIndex);
    leaderId = payload.leaderId || leaderId;

    logEvent(`startup catch-up received ${payload.entries.length} entries from leader ${leaderId}`);
  } catch (_err) {
    logEvent('startup catch-up skipped');
  }
}

app.get('/log', (_req, res) => {
  res.json({
    nodeId: NODE_ID,
    currentTerm,
    role,
    commitIndex,
    entries: logEntries
  });
});

app.listen(PORT, async () => {
  logEvent(`replica listening on port ${PORT}`);
  resetElectionTimer();
  await catchUpOnStartup();
});
