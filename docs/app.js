const DATA = "data/";
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

let state = {
  scope: "stadt",
  city: null,
  bundesland: null,
  range: "7d",
  customFrom: null,
  customTo: null,
};

let db = {}; // meta, stations, cities, bundeslaender, daily, hourly

async function loadJSON(name) {
  const r = await fetch(DATA + name, { cache: "no-cache" });
  return r.json();
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function parseYMD(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(d, n) {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

function dayIndex(dateStr) {
  const d = parseYMD(dateStr);
  const start = parseYMD(db.meta.daily_start);
  return Math.round((d - start) / 86400000);
}

function stationsForScope() {
  if (state.scope === "stadt" && state.city) return [db.cities[state.city]];
  if (state.scope === "bundesland" && state.bundesland) return db.bundeslaender[state.bundesland] || [];
  if (state.scope === "deutschland") return Object.keys(db.stations);
  return [];
}

function scopeLabel() {
  if (state.scope === "stadt") return state.city || "";
  if (state.scope === "bundesland") return state.bundesland || "";
  return "Deutschland";
}

function lastDate() {
  return parseYMD(db.meta.daily_end);
}

function rangeDates() {
  const last = lastDate();
  switch (state.range) {
    case "24h":
      return null; // hourly handled separately
    case "7d":
      return [addDays(last, -6), last];
    case "week": {
      const dow = last.getUTCDay() || 7; // Sun=0 -> 7
      const monday = addDays(last, -(dow - 1));
      return [monday, last];
    }
    case "month": {
      const start = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1));
      return [start, last];
    }
    case "halfyear": {
      const half = last.getUTCMonth() < 6 ? 0 : 6;
      const start = new Date(Date.UTC(last.getUTCFullYear(), half, 1));
      return [start, last];
    }
    case "season": {
      const m = last.getUTCMonth(); // 0-11
      let startY = last.getUTCFullYear(), startM;
      if (m === 11) startM = 11;
      else if (m <= 1) { startM = 11; startY -= 1; }
      else if (m <= 4) startM = 2;
      else if (m <= 7) startM = 5;
      else startM = 8;
      return [new Date(Date.UTC(startY, startM, 1)), last];
    }
    case "year": {
      return [new Date(Date.UTC(last.getUTCFullYear(), 0, 1)), last];
    }
    case "decade": {
      const start = new Date(last);
      start.setUTCFullYear(start.getUTCFullYear() - 10);
      start.setUTCDate(start.getUTCDate() + 1);
      return [start, last];
    }
    case "custom": {
      if (!state.customFrom || !state.customTo) return null;
      return [parseYMD(state.customFrom), parseYMD(state.customTo)];
    }
  }
}

function seasonName(d) {
  const m = d.getUTCMonth();
  if (m === 11 || m <= 1) return "Winter";
  if (m <= 4) return "Frühling";
  if (m <= 7) return "Sommer";
  return "Herbst";
}

function dailyAverageSeries(sids, fromIdx, toIdx) {
  const out = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    let sum = 0, n = 0;
    for (const sid of sids) {
      const arr = db.daily[sid];
      if (!arr) continue;
      const v = arr[i];
      if (v !== null && v !== undefined) { sum += v; n++; }
    }
    out.push(n > 0 ? sum / n : null);
  }
  return out;
}

function hourlyAverageLast24(sids) {
  const arrs = sids.map((s) => db.hourly[s]).filter(Boolean);
  if (!arrs.length) return { total: null, series: [] };
  const len = arrs[0].length;
  const last24start = Math.max(0, len - 24);
  const series = [];
  let total = 0, totalN = 0;
  for (let i = last24start; i < len; i++) {
    let sum = 0, n = 0;
    for (const arr of arrs) {
      const v = arr[i];
      if (v !== null && v !== undefined) { sum += v; n++; }
    }
    const avg = n > 0 ? sum / n : null;
    series.push(avg);
    if (avg !== null) { total += avg; totalN++; }
  }
  return { total: totalN > 0 ? total : null, series };
}

function fmtMM(v) {
  if (v === null || v === undefined || isNaN(v)) return "–";
  return v.toFixed(1).replace(".", ",");
}

let chart;

function render() {
  const sids = stationsForScope();
  const label = scopeLabel();
  const statValue = document.getElementById("statValue");
  const statLabel = document.getElementById("statLabel");
  const infoStations = document.getElementById("infoStations");
  const infoRange = document.getElementById("infoRange");

  if (!sids.length) {
    statValue.textContent = "–";
    statLabel.textContent = "Keine Auswahl";
    return;
  }

  let chartLabels = [], chartValues = [], total = null, rangeText = "";

  if (state.range === "24h") {
    const { total: t, series } = hourlyAverageLast24(sids);
    total = t;
    for (let i = 0; i < series.length; i++) {
      chartLabels.push((i - series.length + 1) + "h");
      chartValues.push(series[i]);
    }
    rangeText = `letzte 24 Stunden (Stand: ${new Date(db.meta.last_observation.slice(0,4)+"-"+db.meta.last_observation.slice(4,6)+"-"+db.meta.last_observation.slice(6,8)+"T"+db.meta.last_observation.slice(8,10)+":00:00Z").toLocaleString("de-DE", {timeZone:"UTC", dateStyle:"medium", timeStyle:"short"})} UTC)`;
  } else {
    const rd = rangeDates();
    if (!rd) {
      statValue.textContent = "–";
      statLabel.textContent = "Bitte Zeitraum wählen";
      if (chart) chart.destroy();
      return;
    }
    let [from, to] = rd;
    const dataStart = parseYMD(db.meta.daily_start);
    if (from < dataStart) from = dataStart;
    if (to > lastDate()) to = lastDate();
    const fromIdx = dayIndex(fmtDate(from));
    const toIdx = dayIndex(fmtDate(to));
    const series = dailyAverageSeries(sids, fromIdx, toIdx);
    total = series.reduce((a, b) => a + (b || 0), 0);
    const nDays = series.length;

    const bucket = nDays <= 62 ? "day" : nDays <= 730 ? "week" : "month";
    const buckets = new Map();
    for (let i = 0; i < nDays; i++) {
      const d = addDays(from, i);
      let key, sortKey;
      if (bucket === "day") { key = d.getUTCDate() + ". " + MONTHS[d.getUTCMonth()]; sortKey = fmtDate(d); }
      else if (bucket === "week") {
        const monday = addDays(d, -((d.getUTCDay() || 7) - 1));
        key = "KW " + isoWeek(monday);
        sortKey = fmtDate(monday);
      } else { key = MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear(); sortKey = d.getUTCFullYear() + "-" + String(d.getUTCMonth()).padStart(2,"0"); }
      if (!buckets.has(sortKey)) buckets.set(sortKey, { key, sum: 0, has: false });
      const b = buckets.get(sortKey);
      if (series[i] !== null) { b.sum += series[i]; b.has = true; }
    }
    for (const [, b] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      chartLabels.push(b.key);
      chartValues.push(b.has ? Math.round(b.sum * 10) / 10 : null);
    }

    const fromStr = from.toLocaleDateString("de-DE");
    const toStr = to.toLocaleDateString("de-DE");
    const prefix = state.range === "season" ? seasonName(to) + " · " : "";
    rangeText = `${prefix}${fromStr} – ${toStr}`;
  }

  statValue.textContent = fmtMM(total);
  statLabel.textContent = `${label} · ${rangeText}`;

  const stationNames = sids.filter((s) => db.stations[s]).map((s) => db.stations[s].name);
  infoStations.textContent = state.scope === "stadt"
    ? `Station: ${stationNames[0] || "–"}`
    : `${sids.length} Stationen im Mittel`;
  infoRange.textContent = `Datenstand Tageswerte: ${new Date(db.meta.daily_end).toLocaleDateString("de-DE")}`;

  drawChart(chartLabels, chartValues);
}

function isoWeek(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function drawChart(labels, values) {
  const ctx = document.getElementById("chart").getContext("2d");
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const gridColor = isDark ? "#2a2c30" : "#eee";
  const barColor = isDark ? "#5b9bff" : "#2563eb";
  const textColor = isDark ? "#9aa0a6" : "#6b7280";

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: barColor, borderRadius: 3, maxBarThickness: 28 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: {
        callbacks: { label: (c) => fmtMM(c.raw) + " mm" }
      } },
      scales: {
        x: { grid: { display: false }, ticks: { color: textColor, maxRotation: 0, autoSkip: true } },
        y: { grid: { color: gridColor }, ticks: { color: textColor }, title: { display: true, text: "mm", color: textColor } },
      },
    },
  });
}

function setupControls() {
  const scopeButtons = document.querySelectorAll(".scope-toggle button");
  const citySel = document.getElementById("citySelect");
  const landSel = document.getElementById("landSelect");
  const rangeButtons = document.querySelectorAll(".ranges button");
  const fromInput = document.getElementById("fromDate");
  const toInput = document.getElementById("toDate");

  scopeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      scopeButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.scope = btn.dataset.scope;
      citySel.classList.toggle("hidden", state.scope !== "stadt");
      landSel.classList.toggle("hidden", state.scope !== "bundesland");
      render();
    });
  });

  citySel.addEventListener("change", () => { state.city = citySel.value; render(); });
  landSel.addEventListener("change", () => { state.bundesland = landSel.value; render(); });

  rangeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      rangeButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.range = btn.dataset.range;
      render();
    });
  });

  [fromInput, toInput].forEach((el) => {
    el.addEventListener("change", () => {
      state.customFrom = fromInput.value || null;
      state.customTo = toInput.value || null;
      if (state.customFrom && state.customTo) {
        rangeButtons.forEach((b) => b.classList.remove("active"));
        state.range = "custom";
        render();
      }
    });
  });
}

function populateSelects() {
  const citySel = document.getElementById("citySelect");
  const landSel = document.getElementById("landSelect");

  Object.keys(db.cities).sort((a, b) => a.localeCompare(b, "de")).forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    citySel.appendChild(opt);
  });
  state.city = citySel.value;

  Object.keys(db.bundeslaender).sort((a, b) => a.localeCompare(b, "de")).forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    landSel.appendChild(opt);
  });
  state.bundesland = landSel.options[0] ? landSel.options[0].value : null;

  const maxD = db.meta.daily_end;
  const minD = db.meta.daily_start;
  document.getElementById("fromDate").max = maxD;
  document.getElementById("fromDate").min = minD;
  document.getElementById("toDate").max = maxD;
  document.getElementById("toDate").min = minD;
}

async function init() {
  const [meta, stations, cities, bundeslaender, daily, hourly] = await Promise.all([
    loadJSON("meta.json"),
    loadJSON("stations.json"),
    loadJSON("cities.json"),
    loadJSON("bundeslaender.json"),
    loadJSON("daily.json"),
    loadJSON("hourly_recent.json"),
  ]);
  db = { meta, stations, cities, bundeslaender, daily, hourly };

  document.getElementById("footerInfo").textContent =
    `Quelle: Deutscher Wetterdienst (Open Data), ${meta.n_stations} Stationen · zuletzt aktualisiert ${new Date(meta.generated_at).toLocaleString("de-DE")}`;

  populateSelects();
  setupControls();
  render();
}

init();
