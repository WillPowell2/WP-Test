// Morning Markets - front end. No dependencies; charts are hand-built SVG.

const RANGES = { "1M": 1, "3M": 3, "6M": 6, YTD: "ytd", "1Y": 12, "2Y": 24 };
const SVG_NS = "http://www.w3.org/2000/svg";

const state = {
  range: load("range", "1M"),
  curveTab: load("curveTab", "US"),
  history: null,
  quotes: null,
  series: {}, // id -> {meta..., data: [[iso, v]], liveTime}
  detailId: null,
};

// ---------------------------------------------------------------- utilities

function load(key, fallback) {
  try { return localStorage.getItem("mm." + key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem("mm." + key, value); } catch { /* storage unavailable */ }
}
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}
function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}
const parseDate = (iso) => new Date(iso + "T00:00:00Z");
const fmtDate = (iso, opts = { day: "numeric", month: "short" }) =>
  parseDate(iso).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
const fmtDateLong = (iso) => fmtDate(iso, { day: "numeric", month: "short", year: "numeric" });

function rangeStart(lastIso, range) {
  const d = parseDate(lastIso);
  const r = RANGES[range];
  if (r === "ytd") return new Date(Date.UTC(d.getUTCFullYear(), 0, 1)).toISOString().slice(0, 10);
  const s = new Date(d);
  s.setUTCMonth(s.getUTCMonth() - r);
  return s.toISOString().slice(0, 10);
}

// Points within the range, starting with the last observation on/before the start date
// so that "change over range" is measured from a real base value.
function sliceRange(data, startIso) {
  if (!data.length) return [];
  let i = data.findIndex(([d]) => d >= startIso);
  if (i === -1) return data.slice(-1);
  if (i > 0 && data[i][0] > startIso) i -= 1;
  return data.slice(i);
}
function valueAt(data, iso) {
  let found = null;
  for (const p of data) { if (p[0] <= iso) found = p; else break; }
  return found;
}

// ---------------------------------------------------------------- formatting

function fmtValue(s, v) {
  if (v == null || Number.isNaN(v)) return "–";
  const dp = s.dp ?? 2;
  switch (s.unit) {
    case "pct": return v.toFixed(dp) + "%";
    case "bp": return Math.round(v) + "bp";
    case "fx": return v.toFixed(dp);
    default: return v.toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
}

// Returns {text, dir: -1|0|1, cls}
function fmtChange(s, from, to) {
  if (from == null || to == null) return { text: "–", dir: 0, cls: "" };
  let delta, text;
  if (s.change === "bp") {
    delta = s.unit === "pct" ? (to - from) * 100 : to - from;
    text = `${sign(delta)}${Math.abs(delta).toFixed(Math.abs(delta) < 10 ? 1 : 0)}bp`;
  } else if (s.change === "pct") {
    delta = (to / from - 1) * 100;
    text = `${sign(delta)}${Math.abs(delta).toFixed(2)}%`;
  } else {
    delta = to - from;
    text = `${sign(delta)}${Math.abs(delta).toFixed(2)}`;
  }
  const rounded = Number(text.replace(/[^\d.]/g, ""));
  const dir = rounded === 0 ? 0 : Math.sign(delta);
  if (dir === 0) text = text.replace(/^[+−]/, "");
  let cls = "";
  if (dir !== 0 && s.good !== "none") cls = (dir > 0) === (s.good === "up") ? "good" : "bad";
  return { text: (dir > 0 ? "▲ " : dir < 0 ? "▼ " : "") + text, dir, cls };
}
const sign = (x) => (x > 0 ? "+" : x < 0 ? "−" : "");

// ---------------------------------------------------------------- data

async function fetchJSON(url, fresh) {
  const res = await fetch(url, { cache: fresh ? "no-store" : "default" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function loadData(fresh = false) {
  const [history, quotes] = await Promise.all([
    fetchJSON("data/history.json", fresh),
    fetchJSON("data/quotes.json", fresh).catch(() => ({ quotes: {}, errors: [] })),
  ]);
  state.history = history;
  state.quotes = quotes;
  state.series = {};
  for (const [id, s] of Object.entries(history.series)) {
    const data = s.data.slice();
    let liveTime = null;
    const q = s.live && quotes.quotes?.[s.live];
    if (q && q.time && Number.isFinite(q.price)) {
      const qDate = q.time.slice(0, 10);
      const last = data[data.length - 1];
      if (!last || qDate >= last[0]) {
        if (last && last[0] === qDate) data[data.length - 1] = [qDate, q.price];
        else data.push([qDate, q.price]);
        liveTime = q.time;
      }
    }
    state.series[id] = { ...s, id, data, liveTime };
  }
}

// ---------------------------------------------------------------- tooltip

const tooltip = document.getElementById("tooltip");
const dialog = document.getElementById("detail");
function showTooltip(clientX, clientY, title, rows) {
  tooltip.replaceChildren(el("div", { class: "t-date", text: title }));
  for (const r of rows) {
    const key = el("span", { class: "k" });
    if (r.color) {
      const i = el("i");
      i.style.borderTopColor = r.color;
      if (r.dash) i.style.borderTopStyle = "dashed";
      key.append(i);
    }
    key.append(document.createTextNode(r.label));
    tooltip.append(el("div", { class: "row" }, key, el("b", { text: r.value })));
  }
  // A modal <dialog> sits in the top layer, so the tooltip must live inside it to be seen.
  const host = dialog.open ? dialog : document.body;
  if (tooltip.parentNode !== host) host.append(tooltip);
  tooltip.hidden = false;
  const { width, height } = tooltip.getBoundingClientRect();
  let x = clientX + 14, y = clientY - height - 12;
  if (x + width > window.innerWidth - 8) x = clientX - width - 14;
  if (x < 8) x = 8;
  if (y < 8) y = clientY + 16;
  tooltip.style.left = x + "px";
  tooltip.style.top = y + "px";
}
const hideTooltip = () => { tooltip.hidden = true; };

// ---------------------------------------------------------------- charts

function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? 10 * mag;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) ticks.push(+t.toFixed(10));
  return ticks;
}

function sparkline(points) {
  const w = 160, h = 34, pad = 3;
  const node = svg("svg", { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none", class: "spark", "aria-hidden": "true" });
  if (points.length < 2) return node;
  const vals = points.map((p) => p[1]);
  const min = Math.min(...vals), max = Math.max(...vals);
  const x = (i) => (i / (points.length - 1)) * w;
  const y = (v) => (max === min ? h / 2 : pad + (1 - (v - min) / (max - min)) * (h - 2 * pad));
  node.append(svg("line", { x1: 0, x2: w, y1: y(vals[0]), y2: y(vals[0]), class: "gridline", "stroke-dasharray": "2 3", "vector-effect": "non-scaling-stroke" }));
  node.append(svg("path", {
    d: points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(""),
    fill: "none", stroke: "var(--s1)", "stroke-width": 1.75, "stroke-linejoin": "round",
    "vector-effect": "non-scaling-stroke",
  }));
  return node;
}

// Time-series line chart with crosshair + tooltip.
function lineChart(container, s, points) {
  container.replaceChildren();
  const W = Math.max(280, container.clientWidth || 320);
  const H = W < 500 ? 220 : 280;
  const m = { l: 6, r: 52, t: 12, b: 24 };
  const node = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${s.name} chart` });
  container.append(node);
  if (points.length < 2) return;

  const vals = points.map((p) => p[1]);
  const ticks = niceTicks(Math.min(...vals), Math.max(...vals), 4);
  const yMin = Math.min(ticks[0], ...vals), yMax = Math.max(ticks[ticks.length - 1], ...vals);
  const t0 = parseDate(points[0][0]).getTime(), t1 = parseDate(points[points.length - 1][0]).getTime();
  const X = (iso) => m.l + ((parseDate(iso).getTime() - t0) / Math.max(1, t1 - t0)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - m.t - m.b);

  for (const t of ticks) {
    node.append(svg("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), class: "gridline" }));
    const lab = svg("text", { x: W - m.r + 6, y: Y(t) + 4 });
    lab.textContent = fmtValue({ ...s, dp: s.unit === "pct" ? 2 : s.unit === "fx" ? s.dp : Math.min(s.dp, 1) }, t);
    node.append(lab);
  }
  // x ticks: about one label per 90px
  const nX = Math.max(2, Math.floor((W - m.l - m.r) / 90));
  const spanDays = (t1 - t0) / 864e5;
  for (let k = 0; k <= nX; k++) {
    const p = points[Math.round((k / nX) * (points.length - 1))];
    const lab = svg("text", { x: X(p[0]), y: H - 6, "text-anchor": k === 0 ? "start" : k === nX ? "end" : "middle" });
    lab.textContent = fmtDate(p[0], spanDays > 200 ? { month: "short", year: "2-digit" } : { day: "numeric", month: "short" });
    node.append(lab);
  }
  // base line at range start value
  node.append(svg("line", { x1: m.l, x2: W - m.r, y1: Y(vals[0]), y2: Y(vals[0]), class: "baseline", "stroke-dasharray": "3 3" }));
  node.append(svg("path", {
    d: points.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(""),
    fill: "none", stroke: "var(--s1)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round",
  }));
  const last = points[points.length - 1];
  node.append(svg("circle", { cx: X(last[0]), cy: Y(last[1]), r: 4, fill: "var(--s1)", stroke: "var(--surface)", "stroke-width": 2 }));

  // hover layer
  const cross = svg("line", { y1: m.t, y2: H - m.b, class: "crosshair", visibility: "hidden" });
  const dot = svg("circle", { r: 4, fill: "var(--s1)", stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" });
  const hit = svg("rect", { x: 0, y: 0, width: W, height: H, fill: "transparent", tabindex: 0 });
  node.append(cross, dot, hit);
  let idx = points.length - 1;
  const show = (i, cx, cy) => {
    idx = Math.max(0, Math.min(points.length - 1, i));
    const p = points[idx];
    cross.setAttribute("x1", X(p[0])); cross.setAttribute("x2", X(p[0]));
    dot.setAttribute("cx", X(p[0])); dot.setAttribute("cy", Y(p[1]));
    cross.setAttribute("visibility", "visible"); dot.setAttribute("visibility", "visible");
    const ch = fmtChange(s, points[0][1], p[1]);
    showTooltip(cx, cy, fmtDateLong(p[0]), [
      { label: s.short || s.name, value: fmtValue(s, p[1]), color: "var(--s1)" },
      { label: `vs ${fmtDate(points[0][0], { day: "numeric", month: "short", year: "2-digit" })}`, value: ch.text },
    ]);
  };
  const nearest = (clientX) => {
    const r = node.getBoundingClientRect();
    const xs = ((clientX - r.left) / r.width) * W;
    let best = 0, bd = Infinity;
    points.forEach((p, i) => { const d = Math.abs(X(p[0]) - xs); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  const clear = () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideTooltip(); };
  hit.addEventListener("pointermove", (e) => show(nearest(e.clientX), e.clientX, e.clientY));
  hit.addEventListener("pointerdown", (e) => show(nearest(e.clientX), e.clientX, e.clientY));
  hit.addEventListener("pointerleave", clear);
  hit.addEventListener("blur", clear);
  hit.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = idx + (e.key === "ArrowRight" ? 1 : -1);
    const r = node.getBoundingClientRect();
    const p = points[Math.max(0, Math.min(points.length - 1, i))];
    show(i, r.left + (X(p[0]) / W) * r.width, r.top + (Y(p[1]) / H) * r.height);
  });
}

// Yield curve: latest vs. range-start curve, plus change-by-tenor bars.
function curveChart(container, ids) {
  container.replaceChildren();
  const pts = ids.map((id) => state.series[id]).filter((s) => s && s.data.length);
  if (pts.length < 2) {
    container.append(el("p", { class: "muted", text: "Curve data unavailable." }));
    return null;
  }
  const lastIso = pts.reduce((a, s) => (s.data[s.data.length - 1][0] > a ? s.data[s.data.length - 1][0] : a), "");
  const startIso = rangeStart(lastIso, state.range);
  const rows = pts.map((s) => {
    const now = s.data[s.data.length - 1];
    const then = valueAt(s.data, startIso);
    return { s, now: now[1], then: then ? then[1] : null, nowDate: now[0], thenDate: then?.[0] };
  });

  const W = Math.max(280, container.clientWidth || 320);
  const H1 = W < 500 ? 190 : 230, gap = 18, H2 = 64;
  const H = H1 + gap + H2 + 18;
  const m = { l: 8, r: 46, t: 12 };
  const node = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Yield curve, latest versus range start, with change by tenor" });
  container.append(node);

  const xRaw = (y) => Math.log(1 + 4 * y);
  const xMin = xRaw(rows[0].s.tenor ?? 0), xMax = xRaw(rows[rows.length - 1].s.tenor ?? 30);
  const X = (s) => m.l + 10 + ((xRaw(s.tenor) - xMin) / (xMax - xMin || 1)) * (W - m.l - m.r - 20);

  const all = rows.flatMap((r) => [r.now, r.then]).filter((v) => v != null);
  const ticks = niceTicks(Math.min(...all), Math.max(...all), 4);
  const yMin = Math.min(ticks[0], ...all), yMax = Math.max(ticks[ticks.length - 1], ...all);
  const Y = (v) => m.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H1 - m.t - 6);
  for (const t of ticks) {
    node.append(svg("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), class: "gridline" }));
    const lab = svg("text", { x: W - m.r + 6, y: Y(t) + 4 });
    lab.textContent = t.toFixed(t % 1 === 0 ? 0 : t * 10 % 1 === 0 ? 1 : 2) + "%";
    node.append(lab);
  }

  const path = (key) => rows.filter((r) => r[key] != null)
    .map((r, i) => `${i ? "L" : "M"}${X(r.s).toFixed(1)},${Y(r[key]).toFixed(1)}`).join("");
  node.append(svg("path", { d: path("then"), fill: "none", stroke: "var(--s2)", "stroke-width": 2, "stroke-dasharray": "5 4", "stroke-linejoin": "round" }));
  node.append(svg("path", { d: path("now"), fill: "none", stroke: "var(--s1)", "stroke-width": 2, "stroke-linejoin": "round" }));
  for (const r of rows) {
    if (r.then != null) node.append(svg("circle", { cx: X(r.s), cy: Y(r.then), r: 3.5, fill: "var(--s2)", stroke: "var(--surface)", "stroke-width": 2 }));
    node.append(svg("circle", { cx: X(r.s), cy: Y(r.now), r: 4, fill: "var(--s1)", stroke: "var(--surface)", "stroke-width": 2 }));
  }

  // change bars (diverging: rise vs fall), labelled
  const top2 = H1 + gap;
  const sub = svg("text", { x: m.l, y: top2 - 4 });
  sub.textContent = "Change (bp)";
  node.append(sub);
  const chg = rows.map((r) => (r.then == null ? null : (r.now - r.then) * 100));
  const maxAbs = Math.max(5, ...chg.filter((c) => c != null).map(Math.abs));
  const zero = top2 + H2 / 2;
  node.append(svg("line", { x1: m.l, x2: W - m.r, y1: zero, y2: zero, class: "baseline" }));
  const barW = Math.max(6, Math.min(14, (W - m.l - m.r) / rows.length / 2.2));
  rows.forEach((r, i) => {
    const c = chg[i];
    if (c == null) return;
    const h = Math.max(1, (Math.abs(c) / maxAbs) * (H2 / 2 - 12));
    const y = c >= 0 ? zero - h : zero;
    const x = X(r.s) - barW / 2;
    node.append(svg("rect", { x, y, width: barW, height: h, rx: Math.min(3, h / 2), fill: c >= 0 ? "var(--div-pos)" : "var(--div-neg)" }));
  });

  // tenor labels with collision skipping (always keep first/last)
  let lastRight = -Infinity;
  rows.forEach((r, i) => {
    const label = r.s.short === "Bank Rate" ? "BR" : r.s.short;
    const x = X(r.s), w = label.length * 6.5;
    const isEdge = i === 0 || i === rows.length - 1;
    const nextX = i < rows.length - 1 ? X(rows[rows.length - 1].s) - w : Infinity;
    if (!isEdge && (x - w / 2 < lastRight + 4 || x + w / 2 > nextX - 4)) return;
    const t = svg("text", { x, y: H - 4, "text-anchor": "middle" });
    t.textContent = label;
    node.append(t);
    lastRight = x + w / 2;
  });

  // hover: snap to nearest tenor
  const cross = svg("line", { y1: m.t, y2: H - 16, class: "crosshair", visibility: "hidden" });
  const hit = svg("rect", { x: 0, y: 0, width: W, height: H, fill: "transparent", tabindex: 0 });
  node.append(cross, hit);
  let idx = rows.length - 1;
  const show = (i, cx, cy) => {
    idx = Math.max(0, Math.min(rows.length - 1, i));
    const r = rows[idx];
    cross.setAttribute("x1", X(r.s)); cross.setAttribute("x2", X(r.s)); cross.setAttribute("visibility", "visible");
    const ch = fmtChange(r.s, r.then, r.now);
    showTooltip(cx, cy, r.s.name, [
      { label: fmtDate(r.nowDate), value: fmtValue(r.s, r.now), color: "var(--s1)" },
      { label: r.thenDate ? fmtDate(r.thenDate) : "start", value: fmtValue(r.s, r.then), color: "var(--s2)", dash: true },
      { label: "Change", value: ch.text },
    ]);
  };
  const nearest = (clientX) => {
    const b = node.getBoundingClientRect();
    const xs = ((clientX - b.left) / b.width) * W;
    let best = 0, bd = Infinity;
    rows.forEach((r, i) => { const d = Math.abs(X(r.s) - xs); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  const clear = () => { cross.setAttribute("visibility", "hidden"); hideTooltip(); };
  hit.addEventListener("pointermove", (e) => show(nearest(e.clientX), e.clientX, e.clientY));
  hit.addEventListener("pointerdown", (e) => show(nearest(e.clientX), e.clientX, e.clientY));
  hit.addEventListener("pointerleave", clear);
  hit.addEventListener("blur", clear);
  hit.addEventListener("click", () => openDetail(rows[idx].s.id));
  hit.addEventListener("keydown", (e) => {
    if (e.key === "Enter") return openDetail(rows[idx].s.id);
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const b = node.getBoundingClientRect();
    const i = Math.max(0, Math.min(rows.length - 1, idx + (e.key === "ArrowRight" ? 1 : -1)));
    show(i, b.left + (X(rows[i].s) / W) * b.width, b.top + (Y(rows[i].now) / H) * b.height);
  });

  return { lastIso, thenIso: rows.find((r) => r.thenDate)?.thenDate };
}

// ---------------------------------------------------------------- rendering

function tile(id) {
  const s = state.series[id];
  if (!s) return null;
  const node = el("button", { class: "card tile", type: "button", "aria-label": `${s.name}, open chart` });
  node.addEventListener("click", () => openDetail(id));
  node.append(el("span", { class: "name", text: s.name }));
  if (!s.data.length) {
    node.classList.add("empty");
    node.append(el("span", { class: "value", text: "No data" }), el("span", { class: "when", text: s.source }));
    return node;
  }
  const last = s.data[s.data.length - 1];
  const prev = s.data[s.data.length - 2];
  const pts = sliceRange(s.data, rangeStart(last[0], state.range));
  const d1 = fmtChange(s, prev?.[1], last[1]);
  const dR = fmtChange(s, pts[0]?.[1], last[1]);
  node.append(el("span", { class: "value", text: fmtValue(s, last[1]) }));
  node.append(el("span", { class: "deltas" },
    el("span", { class: `delta ${d1.cls}` }, el("span", { class: "lbl", text: "1D" }), el("b", { text: d1.text })),
    el("span", { class: `delta ${dR.cls}` }, el("span", { class: "lbl", text: state.range }), el("b", { text: dR.text })),
  ));
  const when = el("span", { class: "when" });
  if (s.liveTime) {
    when.append(el("span", { class: "live-dot", "aria-hidden": "true" }),
      document.createTextNode("Delayed " + new Date(s.liveTime).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })));
  } else {
    when.textContent = "Close " + fmtDate(last[0]);
  }
  node.append(when, sparkline(pts));
  return node;
}

function curveCard(section) {
  const card = el("div", { class: "card curve-card" });
  const tabs = el("div", { class: "tabs", role: "tablist", "aria-label": "Curve" });
  const legend = el("div", { class: "legend" });
  const chart = el("div", { class: "chart" });
  const head = el("div", { class: "curve-head" }, tabs, legend);
  card.append(head, chart);
  if (!section.curves.some((c) => c.id === state.curveTab)) state.curveTab = section.curves[0].id;

  const draw = () => {
    const c = section.curves.find((x) => x.id === state.curveTab);
    const info = curveChart(chart, c.points);
    legend.replaceChildren(
      el("span", {}, el("i", { style: "border-top-color: var(--s1)" }), document.createTextNode(info ? `Latest ${fmtDate(info.lastIso)}` : "Latest")),
      el("span", {}, el("i", { class: "dash", style: "border-top-color: var(--s2)" }), document.createTextNode(info?.thenIso ? fmtDate(info.thenIso, { day: "numeric", month: "short", year: "2-digit" }) : state.range + " ago")),
    );
  };
  for (const c of section.curves) {
    const b = el("button", { type: "button", role: "tab", "aria-selected": String(c.id === state.curveTab), text: c.id === "EA" ? "EUR" : c.id, title: c.title });
    b.addEventListener("click", () => {
      state.curveTab = c.id; save("curveTab", c.id);
      tabs.querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      draw();
    });
    tabs.append(b);
  }
  card._draw = draw;
  return card;
}

let curveCards = [];
function render() {
  const app = document.getElementById("app");
  app.replaceChildren();
  curveCards = [];
  for (const section of state.history.layout) {
    const sec = el("section", { "aria-labelledby": `h-${section.id}` }, el("h2", { id: `h-${section.id}`, text: section.title }));
    const grid = el("div", { class: "grid" });
    if (section.curves) {
      const card = curveCard(section);
      curveCards.push(card);
      grid.append(card);
    }
    grid.append(...section.tiles.map(tile).filter(Boolean));
    sec.append(grid);
    app.append(sec);
  }
  curveCards.forEach((c) => c._draw()); // after insertion so widths are known
  renderMeta();
}

function renderMeta() {
  const h = state.history, q = state.quotes;
  const ref = state.series.US_10Y?.data.at(-1)?.[0];
  const bits = [];
  if (ref) bits.push(`Closes to ${fmtDate(ref, { weekday: "short", day: "numeric", month: "short" })}`);
  const liveCount = Object.keys(q?.quotes || {}).length;
  if (liveCount && q.generated) bits.push(`quotes ${new Date(q.generated).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`);
  bits.push(`updated ${new Date(q?.generated || h.generated).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`);
  document.getElementById("asof").textContent = bits.join(" · ");

  const banner = document.getElementById("banner");
  banner.hidden = !h.demo;
  banner.textContent = h.demo ? "Demo data: these numbers are synthetic placeholders, not market prices. Real data appears once the GitHub Action has run." : "";

  const errs = [...(h.errors || []), ...(q?.errors || [])];
  const box = document.getElementById("errors");
  box.hidden = errs.length === 0;
  box.querySelector("ul").replaceChildren(...errs.map((e) => el("li", { text: e })));
}

function syncRangeButtons() {
  document.querySelectorAll(".ranges button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.range === state.range)));
}
function setRange(r) {
  state.range = r; save("range", r);
  syncRangeButtons();
  render();
  if (state.detailId) drawDetail();
}

// ---------------------------------------------------------------- detail sheet

function openDetail(id) {
  state.detailId = id;
  hideTooltip();
  if (!dialog.open) dialog.showModal();
  drawDetail();
}
function drawDetail() {
  const s = state.series[state.detailId];
  document.getElementById("detail-title").textContent = s.name;
  const statsEl = document.getElementById("detail-stats");
  const chartEl = document.getElementById("detail-chart");
  document.getElementById("detail-source").textContent = "Source: " + s.source + (s.liveTime ? " · latest point is a delayed live quote" : "");
  if (!s.data.length) {
    document.getElementById("detail-sub").textContent = "No data available";
    chartEl.replaceChildren(); statsEl.replaceChildren();
    return;
  }
  const last = s.data[s.data.length - 1];
  const pts = sliceRange(s.data, rangeStart(last[0], state.range));
  const ch = fmtChange(s, pts[0][1], last[1]);
  const sub = document.getElementById("detail-sub");
  sub.replaceChildren(document.createTextNode(fmtValue(s, last[1]) + "  "), el("span", { class: `delta ${ch.cls}`, text: `${ch.text} over ${state.range}` }));
  lineChart(chartEl, s, pts);
  const vals = pts.map((p) => p[1]);
  const hi = pts[vals.indexOf(Math.max(...vals))], lo = pts[vals.indexOf(Math.min(...vals))];
  const yr = { day: "numeric", month: "short", year: "2-digit" };
  const stat = (k, v) => el("div", {}, el("dt", { text: k }), el("dd", { text: v }));
  statsEl.replaceChildren(
    stat(`Start ${fmtDate(pts[0][0], yr)}`, fmtValue(s, pts[0][1])),
    stat(`Latest ${fmtDate(last[0], yr)}`, fmtValue(s, last[1])),
    stat(`High ${fmtDate(hi[0], yr)}`, fmtValue(s, hi[1])),
    stat(`Low ${fmtDate(lo[0], yr)}`, fmtValue(s, lo[1])),
  );
}
dialog.addEventListener("click", (e) => {
  if (e.target === dialog || e.target.closest("[data-close]")) dialog.close();
});
dialog.addEventListener("close", () => { state.detailId = null; hideTooltip(); });

// ---------------------------------------------------------------- boot

function buildSheetRanges() {
  const box = dialog.querySelector(".ranges.in-sheet");
  for (const r of Object.keys(RANGES)) box.append(el("button", { type: "button", role: "radio", "data-range": r, text: r }));
}

async function refresh(fresh) {
  const btn = document.getElementById("refresh");
  const app = document.getElementById("app");
  btn.classList.add("spin");
  app.classList.add("loading");
  try {
    await loadData(fresh);
    render();
  } catch (err) {
    document.getElementById("asof").textContent = "Could not load data: " + err.message;
  } finally {
    btn.classList.remove("spin");
    app.classList.remove("loading");
  }
}

buildSheetRanges();
if (!RANGES[state.range]) state.range = "1M";
syncRangeButtons();
document.addEventListener("click", (e) => {
  const b = e.target.closest(".ranges button");
  if (b) setRange(b.dataset.range);
});
document.getElementById("refresh").addEventListener("click", () => refresh(true));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.history) refresh(true); });
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.history) { curveCards.forEach((c) => c._draw()); if (state.detailId) drawDetail(); } }, 150);
});

refresh(false);

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
