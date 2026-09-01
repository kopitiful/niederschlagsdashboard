const DATA = "data/";
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const MONTHS_FULL = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

let state = {
  country: "DE", // "DE" oder "FR"
  scope: "stadt", // "stadt" | "region" (Bundesland/Departement) | "land" (ganzes Land)
  city: null,
  region: null,
  range: "7d",
  month: null, // null = aktueller Monat
  customFrom: null,
  customTo: null,
};

let db = {}; // meta, stations, cities, regions, daily, hourly

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
  if (state.scope === "stadt" && state.city) {
    const sid = (db.citiesByCountry[state.country] || {})[state.city];
    return sid ? [sid] : [];
  }
  if (state.scope === "region" && state.region) {
    return (db.regions[state.country] && db.regions[state.country][state.region]) || [];
  }
  if (state.scope === "land") {
    return Object.keys(db.stations).filter((sid) => db.stations[sid].country === state.country);
  }
  return [];
}

function countryName(country) {
  return country === "FR" ? "Frankreich" : "Deutschland";
}

function scopeLabel() {
  if (state.scope === "stadt") return state.city || "";
  if (state.scope === "region") return state.region || "";
  return countryName(state.country);
}

function lastDate() {
  return parseYMD(db.meta.daily_end);
}

function shiftYears(d, n) {
  const r = new Date(d);
  r.setUTCFullYear(r.getUTCFullYear() - n);
  return r;
}

function yearsAgoPlus1(date, n) {
  const r = shiftYears(date, n);
  r.setUTCDate(r.getUTCDate() + 1);
  return r;
}

function nYearRange(end, n) {
  return [yearsAgoPlus1(end, n), end];
}

// monthIndex 0-11, oder null/undefined = aktueller Monat der letzten Datenperiode.
// Liegt der gewaehlte Monat im laufenden Jahr noch in der Zukunft, wird das Vorjahr
// genommen (letzte abgeschlossene Ausgabe dieses Monats); der aktuelle Monat selbst
// laeuft nur bis "last" (zum-Datum), alle anderen Monate sind vollstaendig.
function monthBounds(monthIndex, last) {
  if (monthIndex === null || monthIndex === undefined) monthIndex = last.getUTCMonth();
  let year = last.getUTCFullYear();
  if (monthIndex > last.getUTCMonth()) year -= 1;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const isCurrent = monthIndex === last.getUTCMonth() && year === last.getUTCFullYear();
  const end = isCurrent ? last : new Date(Date.UTC(year, monthIndex + 1, 0));
  return [start, end];
}

function presetBounds(kind, last, monthIndex) {
  switch (kind) {
    case "week": {
      const dow = last.getUTCDay() || 7; // Sun=0 -> 7
      return [addDays(last, -(dow - 1)), last];
    }
    case "month":
      return monthBounds(monthIndex, last);
    case "halfyear": {
      const half = last.getUTCMonth() < 6 ? 0 : 6;
      return [new Date(Date.UTC(last.getUTCFullYear(), half, 1)), last];
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
    case "year":
      return [new Date(Date.UTC(last.getUTCFullYear(), 0, 1)), last];
    case "decade":
      return nYearRange(last, 10);
  }
}

function rangeDates() {
  const last = lastDate();
  switch (state.range) {
    case "24h":
      return null; // hourly handled separately
    case "7d":
      return [addDays(last, -6), last];
    case "custom": {
      if (!state.customFrom || !state.customTo) return null;
      return [parseYMD(state.customFrom), parseYMD(state.customTo)];
    }
    default:
      return presetBounds(state.range, last, state.month);
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
    const prefix = state.range === "season" ? seasonName(to) + " · "
      : state.range === "month" ? `${MONTHS_FULL[from.getUTCMonth()]} ${from.getUTCFullYear()} · `
      : "";
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

// Bucketed nach Position-innerhalb-der-Periode statt Kalenderdatum, damit zwei
// gleich lange Perioden (z.B. dieses vs. voriges Jahr) Bucket-fuer-Bucket
// nebeneinander vergleichbar sind.
function bucketizeOffset(sids, from, to) {
  const dataStart = parseYMD(db.meta.daily_start);
  const last = lastDate();
  const clampedFrom = from < dataStart ? dataStart : from;
  const clampedTo = to > last ? last : to;
  const totalSpanDays = Math.round((to - from) / 86400000) + 1;
  if (clampedFrom > clampedTo) return { values: [], total: null, bucketType: null, bucketCount: 0, coverage: 0 };

  const fromIdx = dayIndex(fmtDate(clampedFrom));
  const toIdx = dayIndex(fmtDate(clampedTo));
  const series = dailyAverageSeries(sids, fromIdx, toIdx);
  const validDays = series.filter((v) => v !== null).length;
  const total = validDays > 0 ? series.reduce((a, b) => a + (b || 0), 0) : null;
  const coverage = totalSpanDays > 0 ? validDays / totalSpanDays : 0;

  const bucketType = totalSpanDays <= 62 ? "day" : totalSpanDays <= 400 ? "week" : totalSpanDays <= 1500 ? "month" : "year";
  const bucketSizeDays = { day: 1, week: 7, month: 30, year: 365.25 }[bucketType];
  const offsetStart = Math.round((clampedFrom - from) / 86400000);

  const sums = new Map();
  for (let i = 0; i < series.length; i++) {
    const bIdx = Math.floor((offsetStart + i) / bucketSizeDays);
    if (!sums.has(bIdx)) sums.set(bIdx, { sum: 0, has: false });
    const b = sums.get(bIdx);
    if (series[i] !== null) { b.sum += series[i]; b.has = true; }
  }
  const bucketCount = Math.floor((totalSpanDays - 1) / bucketSizeDays) + 1;
  const values = [];
  for (let b = 0; b < bucketCount; b++) {
    const bucket = sums.get(b);
    values.push(bucket && bucket.has ? Math.round(bucket.sum * 10) / 10 : null);
  }
  return { values, total, bucketType, bucketCount, coverage };
}

function bucketLabel(type, i) {
  const names = { day: "Tag", week: "Wo", month: "Monat", year: "Jahr" };
  return `${names[type] || "#"} ${i + 1}`;
}

let compareState = { kind: "month", years: 5, month: null, extra: new Set() };
let compareChart;
const MAX_EXTRA = 20;

function clampYears(n) {
  n = Math.round(Number(n));
  if (!Number.isFinite(n)) n = 5;
  return Math.max(1, Math.min(15, n));
}

// offsetUnits 0 = aktuelle Periode, 1 = Vorperiode (Vorjahr/Vorjahrzehnt/...),
// 2+ = zusaetzliche Perioden weiter zurueck, in derselben Einheit wie die Vorperiode.
function periodForOffset(kind, offsetUnits) {
  const last = lastDate();
  if (kind === "decade") return nYearRange(shiftYears(last, offsetUnits * 10), 10);
  if (kind === "nyears") {
    const n = clampYears(compareState.years);
    return nYearRange(shiftYears(last, offsetUnits * n), n);
  }
  const base = presetBounds(kind, last, kind === "month" ? compareState.month : undefined);
  return [shiftYears(base[0], offsetUnits), shiftYears(base[1], offsetUnits)];
}

function compareBounds() {
  return { current: periodForOffset(compareState.kind, 0), prior: periodForOffset(compareState.kind, 1) };
}

function extraUnitLabel() {
  if (compareState.kind === "decade") return "Jahrzehnte";
  if (compareState.kind === "nyears") return `${clampYears(compareState.years)}-Jahres-Zeiträume`;
  return "Jahre";
}

function periodLegendLabel(kind, offsetUnits, range) {
  if (offsetUnits === 0 || offsetUnits === 1) return compareSeriesLabels()[offsetUnits];
  if (kind === "decade" || kind === "nyears") return `${range[0].getUTCFullYear()}–${range[1].getUTCFullYear()}`;
  return String(range[1].getUTCFullYear());
}

function compareSeriesLabels() {
  if (compareState.kind === "decade") return ["Letzte 10 Jahre", "Die 10 Jahre davor"];
  if (compareState.kind === "nyears") {
    const n = clampYears(compareState.years);
    return [`Letzte ${n} Jahre`, `Die ${n} Jahre davor`];
  }
  if (compareState.kind === "month") {
    const name = MONTHS_FULL[compareState.month ?? lastDate().getUTCMonth()];
    return [`${name} aktuell`, `${name} Vorjahr`];
  }
  const names = { season: "Saison", year: "Jahr" };
  return [`${names[compareState.kind]} aktuell`, `${names[compareState.kind]} Vorjahr`];
}

function fmtRangeShort(range) {
  return `${range[0].toLocaleDateString("de-DE")} – ${range[1].toLocaleDateString("de-DE")}`;
}

function renderCompare() {
  const sids = stationsForScope();
  const elCur = document.getElementById("cmpCurrentValue");
  const elPrior = document.getElementById("cmpPriorValue");
  const elCurLabel = document.getElementById("cmpCurrentLabel");
  const elPriorLabel = document.getElementById("cmpPriorLabel");
  const elDelta = document.getElementById("cmpDelta");

  if (!sids.length) {
    elCur.textContent = "–";
    elPrior.textContent = "–";
    elDelta.textContent = "–";
    document.getElementById("cmpCoverageNote").classList.add("hidden");
    document.querySelector("#compareTable thead").replaceChildren();
    document.querySelector("#compareTable tbody").replaceChildren();
    renderExtraPills();
    return;
  }

  const { current, prior } = compareBounds();
  const [curLabel, priorLabel] = compareSeriesLabels();
  const curB = bucketizeOffset(sids, current[0], current[1]);
  const priorB = bucketizeOffset(sids, prior[0], prior[1]);
  const minCoverage = Math.min(curB.coverage, priorB.coverage);

  elCur.textContent = fmtMM(curB.total);
  elPrior.textContent = fmtMM(priorB.total);
  elCurLabel.textContent = `${curLabel} · ${fmtRangeShort(current)}`;
  elPriorLabel.textContent = `${priorLabel} · ${fmtRangeShort(prior)}`;

  if (minCoverage < 0.5) {
    elDelta.textContent = "–";
  } else if (curB.total !== null && priorB.total !== null && priorB.total !== 0) {
    const delta = ((curB.total - priorB.total) / priorB.total) * 100;
    elDelta.textContent = (delta >= 0 ? "+" : "−") + Math.abs(delta).toFixed(0) + " %";
  } else {
    elDelta.textContent = "–";
  }

  const coverageNote = document.getElementById("cmpCoverageNote");
  if (minCoverage < 0.98) {
    const pct = Math.round(minCoverage * 100);
    coverageNote.textContent = minCoverage < 0.5
      ? `Zu wenig Daten für diesen Vergleich (nur ${pct}% Abdeckung) – vermutlich ist die Station für einen Teil des Zeitraums noch nicht aktiv gewesen.`
      : `Hinweis: unvollständige Datenabdeckung für diesen Zeitraum (${pct}%) – Vergleich mit Vorsicht interpretieren.`;
    coverageNote.classList.remove("hidden");
  } else {
    coverageNote.classList.add("hidden");
  }

  const extraOffsets = [...compareState.extra].sort((a, b) => a - b).map((k) => k + 1);
  const extraSeries = extraOffsets.map((offset) => {
    const range = periodForOffset(compareState.kind, offset);
    const b = bucketizeOffset(sids, range[0], range[1]);
    return { label: periodLegendLabel(compareState.kind, offset, range), values: b.values, bucketCount: b.bucketCount, bucketType: b.bucketType };
  });

  const bucketType = curB.bucketType || priorB.bucketType;
  const n = Math.max(curB.bucketCount, priorB.bucketCount, ...extraSeries.map((s) => s.bucketCount));
  const labels = [];
  for (let i = 0; i < n; i++) labels.push(bucketLabel(bucketType, i));

  const series = [
    { label: curLabel, values: curB.values },
    { label: priorLabel, values: priorB.values },
    ...extraSeries,
  ];
  const avgValues = averageAcrossSeries(series, labels.length);
  drawCompareChart(labels, series, avgValues);
  renderCompareTable(labels, series, avgValues);
  renderExtraPills();
}

function colorForOffset(offset, maxOffset, isDark) {
  const c0 = isDark ? [91, 155, 255] : [37, 99, 235];
  const c1 = isDark ? [58, 61, 66] : [223, 227, 232];
  const t = maxOffset > 0 ? Math.min(1, offset / maxOffset) : 0;
  const mix = c0.map((v, i) => Math.round(v + (c1[i] - v) * t));
  return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
}

function averageAcrossSeries(series, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let sum = 0, count = 0;
    for (const s of series) {
      const v = s.values[i];
      if (v !== null && v !== undefined) { sum += v; count++; }
    }
    out.push(count > 0 ? Math.round((sum / count) * 10) / 10 : null);
  }
  return out;
}

function renderCompareTable(labels, series, avgValues) {
  const thead = document.querySelector("#compareTable thead");
  const tbody = document.querySelector("#compareTable tbody");

  const headRow = document.createElement("tr");
  headRow.appendChild(el("th", "Zeitraum"));
  series.forEach((s) => headRow.appendChild(el("th", s.label)));
  headRow.appendChild(el("th", "Durchschnitt", "avg-col"));
  thead.replaceChildren(headRow);

  const rows = labels.map((label, i) => {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", label));
    series.forEach((s) => tr.appendChild(el("td", fmtMM(s.values[i]))));
    tr.appendChild(el("td", fmtMM(avgValues[i]), "avg-col"));
    return tr;
  });
  tbody.replaceChildren(...rows);

  const totalRow = document.createElement("tr");
  totalRow.className = "total-row";
  totalRow.appendChild(el("td", "Summe"));
  series.forEach((s) => {
    const has = s.values.some((v) => v !== null);
    const sum = has ? s.values.reduce((a, b) => a + (b || 0), 0) : null;
    totalRow.appendChild(el("td", fmtMM(sum)));
  });
  const avgHas = avgValues.some((v) => v !== null);
  const avgSum = avgHas ? avgValues.reduce((a, b) => a + (b || 0), 0) : null;
  totalRow.appendChild(el("td", fmtMM(avgSum), "avg-col"));
  tbody.appendChild(totalRow);
}

function el(tag, text, className) {
  const e = document.createElement(tag);
  e.textContent = text;
  if (className) e.className = className;
  return e;
}

function drawCompareChart(labels, series, avgValues) {
  const ctx = document.getElementById("compareChart").getContext("2d");
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const gridColor = isDark ? "#2a2c30" : "#eee";
  const textColor = isDark ? "#9aa0a6" : "#6b7280";
  const maxOffset = Math.max(1, series.length - 1);

  if (compareChart) compareChart.destroy();
  compareChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        ...series.map((s, i) => ({
          label: s.label,
          data: s.values,
          backgroundColor: colorForOffset(i, maxOffset, isDark),
          borderRadius: 3,
          maxBarThickness: 20,
          order: 1,
        })),
        {
          type: "line",
          label: "Durchschnitt",
          data: avgValues,
          borderColor: "#e02424",
          backgroundColor: "#e02424",
          borderWidth: 2,
          pointRadius: 2,
          pointBackgroundColor: "#e02424",
          fill: false,
          tension: 0.2,
          spanGaps: true,
          order: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { color: textColor, boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtMM(c.raw)} mm` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: textColor, maxRotation: 0, autoSkip: true } },
        y: { grid: { color: gridColor }, ticks: { color: textColor }, title: { display: true, text: "mm", color: textColor } },
      },
    },
  });
}

function renderExtraPills() {
  const label = document.getElementById("cmpExtraLabel");
  label.textContent = `Weitere ${extraUnitLabel()} vergleichen:`;

  const pillsWrap = document.getElementById("cmpExtraPills");
  if (pillsWrap.childElementCount !== MAX_EXTRA) {
    pillsWrap.innerHTML = "";
    for (let k = 1; k <= MAX_EXTRA; k++) {
      const btn = document.createElement("button");
      btn.textContent = "+" + k;
      btn.dataset.k = k;
      btn.addEventListener("click", () => {
        if (compareState.extra.has(k)) compareState.extra.delete(k);
        else compareState.extra.add(k);
        renderCompare();
      });
      pillsWrap.appendChild(btn);
    }
  }
  [...pillsWrap.children].forEach((btn) => {
    btn.classList.toggle("active", compareState.extra.has(Number(btn.dataset.k)));
  });
}

function setupCompareControls() {
  const buttons = document.querySelectorAll(".cmp-ranges button");
  const yearsWrap = document.getElementById("cmpYearsWrap");
  const yearsInput = document.getElementById("cmpYears");
  const extraToggle = document.getElementById("cmpExtraToggle");
  const extraPanel = document.getElementById("cmpExtraPanel");
  const cmpMonthSel = document.getElementById("cmpMonthSelect");

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      compareState.kind = btn.dataset.cmp;
      compareState.extra.clear();
      yearsWrap.classList.toggle("hidden", compareState.kind !== "nyears");
      cmpMonthSel.classList.toggle("hidden", compareState.kind !== "month");
      renderCompare();
    });
  });

  yearsInput.addEventListener("input", () => {
    compareState.years = clampYears(yearsInput.value);
    compareState.extra.clear();
    renderCompare();
  });

  cmpMonthSel.addEventListener("change", () => {
    compareState.month = parseInt(cmpMonthSel.value, 10);
    renderCompare();
  });

  extraToggle.addEventListener("click", () => {
    extraPanel.classList.toggle("hidden");
  });
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
  const countryButtons = document.querySelectorAll("#countryToggle button");
  const scopeButtons = document.querySelectorAll("#levelToggle button");
  const citySel = document.getElementById("citySelect");
  const regionSel = document.getElementById("regionSelect");
  const rangeButtons = document.querySelectorAll(".ranges button");
  const fromInput = document.getElementById("fromDate");
  const toInput = document.getElementById("toDate");
  const monthSel = document.getElementById("monthSelect");
  const range24h = document.querySelector('.ranges button[data-range="24h"]');

  function updateCountryLabels() {
    const isFR = state.country === "FR";
    document.querySelector('#levelToggle button[data-scope="region"]').textContent = isFR ? "Département" : "Bundesland";
    document.querySelector('#levelToggle button[data-scope="land"]').textContent = countryName(state.country);
  }

  countryButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      countryButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.country = btn.dataset.country;
      updateCountryLabels();
      populateCitySelect();
      populateRegionSelect();
      range24h.classList.toggle("hidden", state.country === "FR");
      if (state.country === "FR" && state.range === "24h") {
        rangeButtons.forEach((b) => b.classList.remove("active"));
        document.querySelector('.ranges button[data-range="7d"]').classList.add("active");
        state.range = "7d";
      }
      render();
      renderCompare();
    });
  });
  updateCountryLabels();

  scopeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      scopeButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.scope = btn.dataset.scope;
      citySel.classList.toggle("hidden", state.scope !== "stadt");
      regionSel.classList.toggle("hidden", state.scope !== "region");
      render();
      renderCompare();
    });
  });

  citySel.addEventListener("change", () => { state.city = citySel.value; render(); renderCompare(); });
  regionSel.addEventListener("change", () => { state.region = regionSel.value; render(); renderCompare(); });

  rangeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      rangeButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.range = btn.dataset.range;
      monthSel.classList.toggle("hidden", state.range !== "month");
      render();
    });
  });

  monthSel.addEventListener("change", () => {
    state.month = parseInt(monthSel.value, 10);
    render();
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

function populateCitySelect() {
  const citySel = document.getElementById("citySelect");
  citySel.innerHTML = "";
  const names = Object.keys(db.citiesByCountry[state.country] || {})
    .sort((a, b) => a.localeCompare(b, state.country === "FR" ? "fr" : "de"));
  names.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    citySel.appendChild(opt);
  });
  state.city = citySel.value || null;
}

function populateRegionSelect() {
  const regionSel = document.getElementById("regionSelect");
  regionSel.innerHTML = "";
  const names = Object.keys(db.regions[state.country] || {})
    .sort((a, b) => a.localeCompare(b, state.country === "FR" ? "fr" : "de"));
  names.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    regionSel.appendChild(opt);
  });
  state.region = regionSel.options[0] ? regionSel.options[0].value : null;
}

function populateSelects() {
  populateCitySelect();
  populateRegionSelect();

  const maxD = db.meta.daily_end;
  const minD = db.meta.daily_start;
  document.getElementById("fromDate").max = maxD;
  document.getElementById("fromDate").min = minD;
  document.getElementById("toDate").max = maxD;
  document.getElementById("toDate").min = minD;

  const currentMonth = lastDate().getUTCMonth();
  ["monthSelect", "cmpMonthSelect"].forEach((id) => {
    const sel = document.getElementById(id);
    MONTHS_FULL.forEach((name, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    sel.value = currentMonth;
  });
}

async function init() {
  const [meta, stations, cities, regions, daily, hourly] = await Promise.all([
    loadJSON("meta.json"),
    loadJSON("stations.json"),
    loadJSON("cities.json"),
    loadJSON("regions.json"),
    loadJSON("daily.json"),
    loadJSON("hourly_recent.json"),
  ]);
  const citiesByCountry = { DE: {}, FR: {} };
  cities.forEach((c) => { citiesByCountry[c.country][c.name] = c.stationId; });
  db = { meta, stations, cities, citiesByCountry, regions, daily, hourly };

  document.getElementById("footerInfo").textContent =
    `Quelle: Deutscher Wetterdienst & Météo-France (Open Data), ${meta.n_stations_de ?? "?"} DE- + ${meta.n_stations_fr ?? "?"} FR-Stationen · zuletzt aktualisiert ${new Date(meta.generated_at).toLocaleString("de-DE")}`;

  populateSelects();
  setupControls();
  setupCompareControls();
  render();
  renderCompare();
}

init();
