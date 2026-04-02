const nodesRow = document.getElementById('nodesRow');
const eventFeedEl = document.getElementById('eventFeed');

const API = 'http://localhost:4000';
let lastEventCount = 0;

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function roleBadgeClass(role) {
  if (role === 'leader') return 'leader';
  if (role === 'follower') return 'follower';
  if (role === 'candidate') return 'candidate';
  return 'follower';
}

function roleBadgeText(role) {
  if (role === 'leader') return 'LEADER';
  if (role === 'follower') return 'FOLLOWER';
  if (role === 'candidate') return 'CANDIDATE';
  return 'FOLLOWER';
}

function renderGatewayCard(gw) {
  return `
    <div class="node-card glass-panel gateway-card">
      <span class="role-badge gateway">GATEWAY</span>
      <div class="node-name">gateway</div>
      <div class="node-stats">
        <div class="stat"><span class="stat-label">Term</span><span class="stat-value">${gw.currentTerm ?? '-'}</span></div>
        <div class="stat"><span class="stat-label">Log</span><span class="stat-value">${gw.logLength ?? '-'}</span></div>
        <div class="stat"><span class="stat-label">Commit</span><span class="stat-value">${gw.commitIndex ?? '-'}</span></div>
        <div class="stat"><span class="stat-label">Leader</span><span class="stat-value">${gw.leaderId ?? '-'}</span></div>
        <div class="stat"><span class="stat-label">Clients</span><span class="stat-value">${gw.wsClients ?? 0}</span></div>
        <div class="stat stat-url"><span class="stat-label">URL</span><span class="stat-value url-value" title="${gw.url || '-'}">${gw.url || '-'}</span></div>
      </div>
    </div>
  `;
}

function renderReplicaCard(rep, leaderId) {
  const s = rep.status || {};
  const isLeader = s.role === 'leader';
  const isIsolated = s.partition?.isolated;
  const cardClass = isLeader ? 'leader-card' : (isIsolated ? 'isolated-card' : '');

  const heartbeat = isLeader ? 'active' : (s.leaderId ? `to ${s.leaderId}` : 'election timeout');

  return `
    <div class="node-card glass-panel ${cardClass}">
      <span class="role-badge ${roleBadgeClass(s.role)}">${roleBadgeText(s.role)}</span>
      <div class="node-name">${s.nodeId || rep.url.split(':').pop()}</div>
      <div class="node-stats">
        <div class="stat"><span class="stat-label">Term</span><span class="stat-value">${s.currentTerm ?? '-'}</span></div>
        <div class="stat"><span class="stat-label">Log</span><span class="stat-value">${s.logLength ?? '-'}</span></div>
        <div class="stat"><span class="stat-label">Commit</span><span class="stat-value">${s.commitIndex ?? '-'}</span></div>
        <div class="stat"><span class="stat-label">Leader</span><span class="stat-value">${s.leaderId ?? '-'}</span></div>
        <div class="stat stat-heartbeat"><span class="stat-label">Heartbeat</span><span class="stat-value">${heartbeat}</span></div>
        <div class="stat stat-url"><span class="stat-label">URL</span><span class="stat-value url-value" title="${rep.url}">${rep.url}</span></div>
      </div>
    </div>
  `;
}

function renderOfflineCard(rep) {
  const name = rep.url.replace(/^https?:\/\//, '').split(':')[0];
  return `
    <div class="node-card glass-panel isolated-card">
      <span class="role-badge offline">OFFLINE</span>
      <div class="node-name">${name}</div>
      <div class="node-stats">
        <div class="stat stat-url"><span class="stat-label">URL</span><span class="stat-value url-value" title="${rep.url}">${rep.url}</span></div>
      </div>
    </div>
  `;
}

async function fetchStatus() {
  try {
    const res = await fetch(`${API}/cluster-status`);
    const data = await res.json();

    let html = '';

    // Gateway card
    if (data.gateway) {
      html += renderGatewayCard(data.gateway);
    }

    // Replica cards
    for (const rep of data.replicas) {
      if (rep.ok) {
        html += renderReplicaCard(rep, data.leader?.nodeId);
      } else {
        html += renderOfflineCard(rep);
      }
    }

    nodesRow.innerHTML = html;
  } catch (err) {
    nodesRow.innerHTML = `<div class="node-card glass-panel isolated-card"><span class="role-badge offline">ERROR</span><div class="node-name">Cannot reach gateway</div></div>`;
  }
}

async function fetchEvents() {
  try {
    const res = await fetch(`${API}/event-feed?limit=100`);
    const data = await res.json();
    const events = data.events || [];

    if (events.length === 0) {
      eventFeedEl.innerHTML = '<p class="feed-empty">Waiting for events...</p>';
      return;
    }

    const shouldScroll = eventFeedEl.scrollHeight - eventFeedEl.scrollTop - eventFeedEl.clientHeight < 40;

    let html = '';
    for (let i = events.length - 1; i >= 0; i--) {
      const evt = events[i];
      html += `
        <div class="feed-entry">
          <span class="feed-ts">${formatTime(evt.ts)}</span>
          <span class="feed-node ${evt.nodeId}">${evt.nodeId}</span>
          <span class="feed-type ${evt.eventType}">${evt.eventType}</span>
          <span class="feed-detail">${evt.detail}</span>
        </div>
      `;
    }

    eventFeedEl.innerHTML = html;

    if (shouldScroll) {
      eventFeedEl.scrollTop = 0;
    }
  } catch (err) {
    // silently ignore
  }
}

// Toast Notification System
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerText = message;
  container.appendChild(toast);
  
  // Trigger animation
  requestAnimationFrame(() => toast.classList.add('show'));
  
  // Remove after 5s
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 5000);
}

// Partition actions
async function isolate(nodeId) {
  // Before partitioning, get current leader
  let wasLeader = false;
  let currentLeader = null;
  try {
    const res = await fetch(`${API}/cluster-status`);
    const data = await res.json();
    currentLeader = data.leader?.nodeId;
    wasLeader = (currentLeader === nodeId);
  } catch(e) {}

  await fetch(`${API}/admin/partition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, isolated: true, blockedPeers: [] })
  });
  
  if (wasLeader) {
    showToast(`Isolating ${nodeId}... waiting for election!`, 'danger');
    fetchStatus();
    
    // Poll for new leader
    let attempts = 0;
    const pollInterval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(`${API}/cluster-status`);
        const data = await res.json();
        const pollerLeader = data.leader?.nodeId;
        
        if (pollerLeader && pollerLeader !== nodeId) {
          clearInterval(pollInterval);
          showToast(`Isolated ${nodeId}. New leader is ${pollerLeader}!`, 'leader');
          fetchStatus();
        } else if (attempts > 10) { // wait ~5s max
          clearInterval(pollInterval);
          showToast(`Isolated ${nodeId}. No new leader emerged yet.`, 'danger');
        }
      } catch(e) {}
    }, 500);

  } else {
    showToast(`Isolated ${nodeId}. Leader remains ${currentLeader || 'none'}.`, 'danger');
    fetchStatus();
  }
}

async function splitBrain() {
  const requests = [
    { nodeId: 'replica1', blockedPeers: ['replica3', 'replica4'] },
    { nodeId: 'replica2', blockedPeers: ['replica3', 'replica4'] },
    { nodeId: 'replica3', blockedPeers: ['replica1', 'replica2'] },
    { nodeId: 'replica4', blockedPeers: ['replica1', 'replica2'] }
  ];
  for (const item of requests) {
    await fetch(`${API}/admin/partition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: item.nodeId, isolated: false, blockedPeers: item.blockedPeers })
    });
  }
  showToast('Network partitioned: Split Brain initiated (2 vs 2).', 'danger');
  fetchStatus();
}

async function healAll() {
  await fetch(`${API}/admin/partition/heal-all`, { method: 'POST' });
  showToast('Network healed. Awaiting cluster reconciliation...', 'info');
  fetchStatus();
}

document.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.action;
    const node = btn.dataset.node;
    if (action === 'isolate') return isolate(node);
    if (action === 'split') return splitBrain();
    if (action === 'heal') return healAll();
  });
});

// Poll
fetchStatus();
fetchEvents();
setInterval(fetchStatus, 1500);
setInterval(fetchEvents, 1000);
