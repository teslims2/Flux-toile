// Flux-toile Indexer dashboard — plain JS, no build step, no dependencies.
// Polls the indexer's REST API and renders a live feed of recent events.

const state = {
  timer: null,
  paused: false,
  knownTypes: new Set(),
};

const el = {
  connectionDot: document.getElementById("connectionDot"),
  connectionLabel: document.getElementById("connectionLabel"),
  statContract: document.getElementById("statContract"),
  statLedger: document.getElementById("statLedger"),
  statTotal: document.getElementById("statTotal"),
  statRange: document.getElementById("statRange"),
  statGaps: document.getElementById("statGaps"),
  statMalformed: document.getElementById("statMalformed"),
  filterType: document.getElementById("filterType"),
  filterFrom: document.getElementById("filterFrom"),
  filterTo: document.getElementById("filterTo"),
  refreshInterval: document.getElementById("refreshInterval"),
  pauseButton: document.getElementById("pauseButton"),
  lastUpdated: document.getElementById("lastUpdated"),
  eventsBody: document.getElementById("eventsBody"),
};

function setConnection(ok) {
  el.connectionDot.className = `dot ${ok ? "dot-ok" : "dot-bad"}`;
  el.connectionLabel.textContent = ok ? "connected" : "connection lost";
}

function truncateMiddle(str, keep = 8) {
  if (!str || str.length <= keep * 2 + 3) return str ?? "";
  return `${str.slice(0, keep)}…${str.slice(-keep)}`;
}

function formatValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value, null, 0);
  return String(value);
}

function renderTopics(topics) {
  if (!Array.isArray(topics) || topics.length === 0) return "—";
  return topics
    .map((t) => `<span class="topic-chip" title="${escapeHtml(formatValue(t))}">${escapeHtml(truncateMiddle(formatValue(t), 14))}</span>`)
    .join("");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderStats(stats) {
  el.statContract.textContent = stats.contractLabel ? `${stats.contractLabel} (${truncateMiddle(stats.contractId, 6)})` : truncateMiddle(stats.contractId, 10);
  el.statContract.title = stats.contractId;
  el.statLedger.textContent = stats.lastProcessedLedger ?? "—";
  el.statTotal.textContent = stats.totalEvents ?? "—";
  const range = stats.indexedLedgerRange;
  el.statRange.textContent = range && range.min !== null ? `${range.min} – ${range.max}` : "—";
  el.statGaps.textContent = stats.gaps ? `${stats.gaps.open} open / ${stats.gaps.unrecoverable} lost` : "—";
  el.statMalformed.textContent = stats.malformedEvents ?? "0";
}

function updateTypeOptions(events) {
  let changed = false;
  for (const e of events) {
    if (e.eventName && !state.knownTypes.has(e.eventName)) {
      state.knownTypes.add(e.eventName);
      changed = true;
    }
  }
  if (!changed) return;
  const current = el.filterType.value;
  el.filterType.innerHTML = '<option value="">all</option>' + [...state.knownTypes].sort().map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
  el.filterType.value = current;
}

function renderEvents(events) {
  if (events.length === 0) {
    el.eventsBody.innerHTML = '<tr><td colspan="7" class="empty">No events match the current filters.</td></tr>';
    return;
  }
  el.eventsBody.innerHTML = events
    .map((e) => {
      const statusBadge = e.decodeStatus === "malformed"
        ? `<span class="badge badge-malformed" title="${escapeHtml(e.decodeError ?? "")}">malformed</span>`
        : '<span class="badge badge-ok">ok</span>';
      const time = e.ledgerClosedAt ? new Date(e.ledgerClosedAt).toLocaleTimeString() : "—";
      return `<tr>
        <td class="mono">${e.ledger}</td>
        <td>${escapeHtml(time)}</td>
        <td><strong>${escapeHtml(e.eventName ?? e.rpcType)}</strong></td>
        <td class="tx-hash" title="${escapeHtml(e.txHash)}">${escapeHtml(truncateMiddle(e.txHash, 8))}</td>
        <td>${renderTopics(e.topics)}</td>
        <td class="value-cell">${escapeHtml(truncateMiddle(formatValue(e.value), 60))}</td>
        <td>${statusBadge}</td>
      </tr>`;
    })
    .join("");
}

function buildQuery() {
  const params = new URLSearchParams();
  params.set("n", "50");
  if (el.filterType.value) params.set("type", el.filterType.value);
  if (el.filterFrom.value) params.set("fromLedger", el.filterFrom.value);
  if (el.filterTo.value) params.set("toLedger", el.filterTo.value);
  return params.toString();
}

async function refresh() {
  try {
    const [statsRes, eventsRes] = await Promise.all([
      fetch("/stats"),
      fetch(`/events/latest?${buildQuery()}`),
    ]);
    if (!statsRes.ok || !eventsRes.ok) throw new Error("bad response");

    const stats = await statsRes.json();
    const eventsPayload = await eventsRes.json();

    setConnection(true);
    renderStats(stats);
    updateTypeOptions(eventsPayload.data);
    renderEvents(eventsPayload.data);
    el.lastUpdated.textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    setConnection(false);
    el.lastUpdated.textContent = `last update failed: ${err.message}`;
  }
}

function scheduleRefresh() {
  if (state.timer) clearInterval(state.timer);
  if (state.paused) return;
  const ms = Number(el.refreshInterval.value);
  state.timer = setInterval(refresh, ms);
}

el.pauseButton.addEventListener("click", () => {
  state.paused = !state.paused;
  el.pauseButton.textContent = state.paused ? "Resume" : "Pause";
  scheduleRefresh();
});

el.refreshInterval.addEventListener("change", scheduleRefresh);
el.filterType.addEventListener("change", refresh);
el.filterFrom.addEventListener("change", refresh);
el.filterTo.addEventListener("change", refresh);

refresh();
scheduleRefresh();
