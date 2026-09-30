// Painel de gastos na nuvem — lê data/costs.json (gerado por collect.py) e
// desenha tudo em SVG/HTML puro, sem dependências.
//
// Linha de dados: [data, provedor, uso, serviço, recurso, usd]
"use strict";

const PROVIDERS = ["gcp", "r2", "magalu"]; // ordem fixa = ordem das cores
const PROV_VAR = { gcp: "--s-gcp", r2: "--s-r2", magalu: "--s-magalu" };
const DAY = 86400000;

const state = { period: "30d", scope: "", usecase: "", cur: "BRL", resAll: false };
let DATA = null;

// ── utilidades ────────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = tag.startsWith("svg:")
    ? document.createElementNS("http://www.w3.org/2000/svg", tag.slice(4))
    : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.setAttribute("class", v);
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const color = (p) => `var(${PROV_VAR[p]})`;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (d, n) => iso(Date.parse(d) + n * DAY);
const daysIn = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const fmtDay = (d) => `${+d.slice(8)} ${MONTHS[+d.slice(5, 7) - 1]}`;
const fmtDayLong = (d) => {
  const wd = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][new Date(d + "T12:00:00Z").getUTCDay()];
  return `${wd}, ${fmtDay(d)} ${d.slice(0, 4)}`;
};
const fmtMonth = (ym) => `${MONTHS[+ym.slice(5) - 1]} ${ym.slice(0, 4)}`;

const nf = {};
function money(v, { compact = false, digits } = {}) {
  const d = digits ?? (Math.abs(v) < 1000 ? 2 : 0);
  const key = `${state.cur}|${compact}|${d}`;
  nf[key] ??= new Intl.NumberFormat("pt-BR", {
    style: "currency", currency: state.cur,
    notation: compact ? "compact" : "standard",
    minimumFractionDigits: compact ? 0 : d, maximumFractionDigits: compact ? 1 : d,
  });
  return nf[key].format(v);
}
// valor em USD → moeda escolhida, no câmbio do dia
const conv = (usd, day) => (state.cur === "USD" ? usd : usd * DATA.fx[day]);

// ── estado ⇄ URL ──────────────────────────────────────────────────────────
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  for (const k of ["period", "scope", "usecase", "cur"]) if (h.has(k)) state[k] = h.get(k);
  try { if (!h.has("cur")) state.cur = localStorage.getItem("gastos.cur") || state.cur; } catch {}
}
function writeHash() {
  const h = new URLSearchParams();
  if (state.period !== "30d") h.set("period", state.period);
  if (state.scope) h.set("scope", state.scope);
  if (state.usecase) h.set("usecase", state.usecase);
  if (state.cur !== "BRL") h.set("cur", state.cur);
  const s = h.toString();
  history.replaceState(null, "", s ? `#${s}` : location.pathname + location.search);
  try { localStorage.setItem("gastos.cur", state.cur); } catch {}
}

// ── recortes ──────────────────────────────────────────────────────────────
function periodRange() {
  const last = DATA.last;
  const ym = last.slice(0, 7);
  switch (state.period) {
    case "7d": return [addDays(last, -6), last];
    case "90d": return [addDays(last, -89), last];
    case "mtd": return [`${ym}-01`, last];
    case "lm": {
      const prev = addDays(`${ym}-01`, -1);
      return [`${prev.slice(0, 7)}-01`, prev];
    }
    case "all": return [DATA.first, last];
    default: return [addDays(last, -29), last];
  }
}
const scopeOf = (uc) => DATA.usecases[uc]?.scope ?? "outros";
function matchFilters(r) {
  if (state.usecase) return r[2] === state.usecase;
  if (state.scope) return scopeOf(r[2]) === state.scope;
  return true;
}
function filtered(from, to) {
  return DATA.rows.filter((r) => r[0] >= from && r[0] <= to && matchFilters(r));
}

// ── tooltip ───────────────────────────────────────────────────────────────
const tip = () => $("#tip");
function showTip(ev, title, rows, total) {
  const t = tip();
  t.replaceChildren(el("div", { class: "t" }, title));
  for (const [key, label, v] of rows) {
    t.append(el("div", { class: "r" },
      key ? el("i", { class: "k", style: { background: key } }) : null,
      el("b", {}, money(v)), el("span", {}, label)));
  }
  if (total != null) t.append(el("div", { class: "r tot" }, el("b", {}, money(total)), el("span", {}, "total")));
  t.hidden = false;
  moveTip(ev);
}
function moveTip(ev) {
  const t = tip();
  let x, y;
  if (ev.clientX != null && ev.type !== "focus") { x = ev.clientX; y = ev.clientY; }
  else { const b = ev.target.getBoundingClientRect(); x = b.left + b.width / 2; y = b.top; }
  const w = t.offsetWidth, h = t.offsetHeight;
  let left = x + 14, top = y - h - 10;
  if (left + w > innerWidth - 8) left = x - w - 14;
  if (left < 8) left = 8;
  if (top < 8) top = y + 16;
  t.style.left = `${left}px`; t.style.top = `${top}px`;
}
const hideTip = () => { tip().hidden = true; };

// ── escala ────────────────────────────────────────────────────────────────
function niceTicks(max, n = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(+v.toFixed(10));
  if (ticks[ticks.length - 1] < max) ticks.push(+(ticks[ticks.length - 1] + step).toFixed(10));
  return ticks;
}
// retângulo com os cantos de cima arredondados (ponta de dado), base reta
function topRounded(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  if (r <= 0.5) return `M${x},${y}h${w}v${h}h${-w}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

// ── render ────────────────────────────────────────────────────────────────
function render() {
  writeHash();
  syncControls();
  const [from, to] = periodRange();
  const rows = filtered(from, to);
  renderKpis(rows, from, to);
  renderDaily(rows, from, to);
  renderUsecases(from, to);
  renderMonths();
  renderResources(rows);
}

function syncControls() {
  for (const [id, key] of [["#f-period", "period"], ["#f-cur", "cur"]]) {
    for (const b of document.querySelectorAll(`${id} button`)) {
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(b.dataset.v === state[key]));
    }
  }
  const sc = $("#f-scope");
  if (!sc.options.length) {
    sc.append(el("option", { value: "" }, "Tudo"));
    for (const [id, label] of Object.entries(DATA.scopes)) sc.append(el("option", { value: id }, label));
  }
  sc.value = state.scope;
  const uc = $("#f-usecase");
  uc.replaceChildren(el("option", { value: "" }, "Todos"));
  const present = new Set(DATA.rows.map((r) => r[2]));
  for (const [id, u] of Object.entries(DATA.usecases)) {
    if (!present.has(id) || (state.scope && u.scope !== state.scope)) continue;
    uc.append(el("option", { value: id }, u.label));
  }
  uc.value = state.usecase;
}

function sumBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    m.set(k, (m.get(k) ?? 0) + conv(r[5], r[0]));
  }
  return m;
}

function renderKpis(rows, from, to) {
  const box = $("#kpis");
  const total = rows.reduce((a, r) => a + conv(r[5], r[0]), 0);
  const ndays = (Date.parse(to) - Date.parse(from)) / DAY + 1;
  const byProv = sumBy(rows, (r) => r[1]);

  // mês corrente (ignora o período, respeita escopo/uso)
  const last = DATA.last;
  const ym = last.slice(0, 7);
  const mRows = filtered(`${ym}-01`, last);
  const mtd = mRows.reduce((a, r) => a + conv(r[5], r[0]), 0);
  // projeção: dias completos do mês + média dos últimos 7 dias completos × dias restantes
  const lastFull = addDays(last, -1);
  const wRows = filtered(addDays(lastFull, -6), lastFull);
  const avg7 = wRows.reduce((a, r) => a + conv(r[5], r[0]), 0) / 7;
  const fullDone = mRows.filter((r) => r[0] <= lastFull).reduce((a, r) => a + conv(r[5], r[0]), 0);
  const doneDays = +lastFull.slice(8) * (lastFull.slice(0, 7) === ym ? 1 : 0);
  const proj = fullDone + avg7 * (daysIn(ym) - doneDays);

  const periodLabel = { "7d": "últimos 7 dias", "30d": "últimos 30 dias", "90d": "últimos 90 dias",
    mtd: "mês atual", lm: "mês passado", all: "todo o histórico" }[state.period];
  const bar = el("div", { class: "bar", "aria-hidden": "true" },
    PROVIDERS.filter((p) => (byProv.get(p) ?? 0) > 0).map((p) =>
      el("span", { style: { background: color(p), flex: `${byProv.get(p)} 1 0` } })));

  box.replaceChildren(
    el("div", { class: "kpi hero" },
      el("div", { class: "label" }, `Total · ${periodLabel}`),
      el("div", { class: "value" }, money(total)),
      el("div", { class: "foot" }, `${fmtDay(from)} – ${fmtDay(to)} · ${ndays} dias`),
      total > 0 ? bar : null),
    el("div", { class: "kpi" },
      el("div", { class: "label" }, "Média diária"),
      el("div", { class: "value" }, money(total / ndays)),
      el("div", { class: "foot" }, "no período")),
    el("div", { class: "kpi" },
      el("div", { class: "label" }, `${fmtMonth(ym)} até agora`),
      el("div", { class: "value" }, money(mtd)),
      el("div", { class: "foot" }, `até ${fmtDay(last)} (parcial)`)),
    el("div", { class: "kpi" },
      el("div", { class: "label" }, `Projeção de ${MONTHS[+ym.slice(5) - 1]}`),
      el("div", { class: "value" }, money(proj)),
      el("div", { class: "foot" }, `ritmo dos últimos 7 dias: ${money(avg7)}/dia`)),
  );

  const lg = $("#legend-daily");
  lg.replaceChildren(...PROVIDERS.map((p) => el("li", {},
    el("i", { class: "sw", style: { background: color(p) } }),
    DATA.providers[p].label, " ", el("b", {}, money(byProv.get(p) ?? 0)))));
}

function renderDaily(rows, from, to) {
  const box = $("#chart-daily");
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const val = new Map(days.map((d) => [d, Object.fromEntries(PROVIDERS.map((p) => [p, 0]))]));
  for (const r of rows) val.get(r[0])[r[1]] += conv(r[5], r[0]);
  const totals = days.map((d) => PROVIDERS.reduce((a, p) => a + val.get(d)[p], 0));

  const W = Math.max(280, box.clientWidth || 600);
  const H = W < 560 ? 200 : 260;
  const m = { l: 52, r: 4, t: 8, b: 24 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const ticks = niceTicks(Math.max(...totals, 0));
  const ymax = ticks[ticks.length - 1];
  const y = (v) => m.t + ih - (v / ymax) * ih;
  const band = iw / days.length;
  const bw = Math.max(1, Math.min(24, band * (band > 6 ? 0.7 : 0.85)));
  const gap = band > 5 ? 2 : 0;

  const svg = el("svg:svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img",
    "aria-label": `Custo diário por provedor, ${fmtDay(from)} a ${fmtDay(to)}` });
  const g = el("svg:g", { class: "grid" });
  for (const t of ticks) {
    g.append(el("svg:line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
    g.append(el("svg:text", { x: m.l - 8, y: y(t) + 4, "text-anchor": "end" }, money(t, { compact: true })));
  }
  svg.append(g);

  // rótulos do eixo x: ~6-8 datas, preferindo o dia 1 do mês
  const every = Math.max(1, Math.ceil(days.length / Math.floor(iw / 64)));
  days.forEach((d, i) => {
    const lbl = days.length <= 10 || (every > 7 ? d.endsWith("-01") : i % every === 0);
    if (lbl) svg.append(el("svg:text", { x: m.l + band * (i + 0.5), y: H - 6, "text-anchor": "middle" }, fmtDay(d)));
  });

  const bars = el("svg:g");
  days.forEach((d, i) => {
    const x = m.l + band * i + (band - bw) / 2;
    const segs = PROVIDERS.filter((p) => val.get(d)[p] > 0);
    let acc = 0;
    const cls = d === DATA.last ? "partial" : null;
    segs.forEach((p, j) => {
      const v = val.get(d)[p];
      const y0 = y(acc), y1 = y(acc + v);
      acc += v;
      let h = y0 - y1 - (j > 0 ? gap : 0);
      if (h <= 0) return;
      const top = j === segs.length - 1;
      bars.append(el("svg:path", { d: topRounded(x, y1, bw, h, top ? 4 : 0), fill: color(p), class: cls }));
    });
  });
  svg.append(bars);
  svg.append(el("svg:line", { class: "base", x1: m.l, x2: W - m.r, y1: m.t + ih + 0.5, y2: m.t + ih + 0.5 }));

  // alvos de hover: a faixa inteira do dia
  const hits = el("svg:g");
  days.forEach((d, i) => {
    const r = el("svg:rect", { class: "hit", x: m.l + band * i, y: m.t, width: band, height: ih, tabindex: band >= 8 ? 0 : null });
    const show = (ev) => showTip(ev, fmtDayLong(d) + (d === DATA.last ? " · parcial" : ""),
      PROVIDERS.map((p) => [color(p), DATA.providers[p].label, val.get(d)[p]]), totals[i]);
    r.addEventListener("pointerenter", show);
    r.addEventListener("focus", show);
    r.addEventListener("pointermove", moveTip);
    r.addEventListener("pointerleave", hideTip);
    r.addEventListener("blur", hideTip);
    hits.append(r);
  });
  svg.insertBefore(hits, bars);
  if (!totals.some((t) => t > 0)) {
    svg.append(el("svg:text", { class: "empty", x: m.l + iw / 2, y: m.t + ih / 2, "text-anchor": "middle" }, "sem custos neste recorte"));
  }
  box.replaceChildren(svg);

  // tabela equivalente
  const tb = $("#table-daily");
  tb.replaceChildren(
    el("thead", {}, el("tr", {}, el("th", {}, "dia"),
      PROVIDERS.map((p) => el("th", { class: "n" }, DATA.providers[p].label)), el("th", { class: "n" }, "total"))),
    el("tbody", {}, [...days].reverse().map((d) => el("tr", {},
      el("td", {}, fmtDayLong(d)),
      PROVIDERS.map((p) => el("td", { class: "n" }, money(val.get(d)[p]))),
      el("td", { class: "n" }, money(totals[days.indexOf(d)]))))));
}

function renderUsecases(from, to) {
  const box = $("#chart-usecase");
  // ignora o filtro de uso (mostra o escopo inteiro), destacando o escolhido
  const rows = DATA.rows.filter((r) => r[0] >= from && r[0] <= to && (!state.scope || scopeOf(r[2]) === state.scope));
  const by = new Map();
  for (const r of rows) {
    const o = by.get(r[2]) ?? Object.fromEntries(PROVIDERS.map((p) => [p, 0]));
    o[r[1]] += conv(r[5], r[0]);
    by.set(r[2], o);
  }
  const list = [...by.entries()]
    .map(([uc, o]) => ({ uc, o, t: PROVIDERS.reduce((a, p) => a + o[p], 0) }))
    .filter((x) => x.t >= 0.005)
    .sort((a, b) => b.t - a.t);
  const grand = list.reduce((a, x) => a + x.t, 0);
  const max = list[0]?.t ?? 1;
  if (!list.length) { box.replaceChildren(el("div", { class: "empty" }, "sem custos neste recorte")); return; }

  box.replaceChildren(...list.map(({ uc, o, t }) => {
    const u = DATA.usecases[uc] ?? { label: uc };
    const pick = () => { state.usecase = state.usecase === uc ? "" : uc; render(); };
    const segs = PROVIDERS.filter((p) => o[p] > 0);
    return el("div", { class: `row${state.usecase === uc ? " sel" : ""}` },
      el("div", { class: "name", onclick: pick, title: [u.desc, u.repo].filter(Boolean).join(" · ") },
        el("b", {}, el("a", { href: "#", onclick: (e) => { e.preventDefault(); } }, u.label)),
        el("small", {}, state.scope ? (u.repo ?? "") : DATA.scopes[u.scope])),
      el("div", { class: "track", onclick: pick, style: { width: `${(t / max) * 100}%` } },
        segs.map((p) => {
          const s = el("span", { style: { background: color(p), flex: `${o[p]} 1 0` } });
          const show = (ev) => showTip(ev, u.label, segs.map((q) => [color(q), DATA.providers[q].label, o[q]]), t);
          s.addEventListener("pointerenter", show);
          s.addEventListener("pointermove", moveTip);
          s.addEventListener("pointerleave", hideTip);
          return s;
        })),
      el("div", { class: "val" }, money(t), el("small", {}, `${((t / grand) * 100).toFixed(0)}%`)));
  }));
}

function renderMonths() {
  const rows = DATA.rows.filter(matchFilters);
  const by = new Map();
  for (const r of rows) {
    const k = r[0].slice(0, 7);
    const o = by.get(k) ?? Object.fromEntries(PROVIDERS.map((p) => [p, 0]));
    o[r[1]] += conv(r[5], r[0]);
    by.set(k, o);
  }
  const months = [...by.keys()].sort().reverse();
  const partial = (ym) => ym === DATA.last.slice(0, 7) || ym === DATA.first.slice(0, 7) && !DATA.first.endsWith("-01");
  $("#table-month").replaceChildren(
    el("thead", {}, el("tr", {}, el("th", {}, "mês"),
      PROVIDERS.map((p) => el("th", { class: "n" }, el("i", { class: "key", style: { background: color(p) } }), DATA.providers[p].short)),
      el("th", { class: "n" }, "total"))),
    el("tbody", {}, months.map((ym) => {
      const o = by.get(ym);
      return el("tr", {}, el("td", {}, fmtMonth(ym), partial(ym) ? el("small", { style: { color: "var(--muted)" } }, " parcial") : null),
        PROVIDERS.map((p) => el("td", { class: "n" }, o[p] ? money(o[p]) : "—")),
        el("td", { class: "n" }, el("b", {}, money(PROVIDERS.reduce((a, p) => a + o[p], 0)))));
    })));
}

function renderResources(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r[1]}\u0000${r[2]}\u0000${r[3]}\u0000${r[4]}`;
    by.set(k, (by.get(k) ?? 0) + conv(r[5], r[0]));
  }
  const list = [...by.entries()].map(([k, v]) => [...k.split("\u0000"), v])
    .filter((x) => Math.abs(x[4]) >= 0.005).sort((a, b) => b[4] - a[4]);
  const total = list.reduce((a, x) => a + x[4], 0);
  const LIMIT = 12;
  const shown = state.resAll ? list : list.slice(0, LIMIT);
  $("#table-res").replaceChildren(
    el("thead", {}, el("tr", {}, el("th", {}, "recurso"), el("th", {}, "uso"), el("th", { class: "hide-sm" }, "serviço"), el("th", { class: "n" }, "valor"), el("th", { class: "n" }, "%"))),
    el("tbody", {}, shown.map(([p, uc, svc, res, v]) => el("tr", {},
      el("td", { class: "res", title: res }, el("i", { class: "key", style: { background: color(p) } }), res.replace(/^(buckets|services|secrets|instances|disk)\//, "")),
      el("td", {}, DATA.usecases[uc]?.label ?? uc),
      el("td", { class: "hide-sm" }, svc),
      el("td", { class: "n" }, money(v)),
      el("td", { class: "n" }, total ? `${((v / total) * 100).toFixed(1)}` : "")))),
  );
  const more = $("#res-more");
  more.hidden = list.length <= LIMIT;
  more.textContent = state.resAll ? "mostrar menos" : `mostrar todos (${list.length})`;
}

function renderHeader() {
  const upd = new Date(DATA.generated_at);
  const fmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Sao_Paulo" });
  $("#sub").textContent = `Google Cloud · Cloudflare R2 · Magalu Cloud — atualizado em ${fmt.format(upd)}`;
  const warn = [];
  for (const p of PROVIDERS) {
    const info = DATA.providers[p];
    if (!info.last) warn.push(`${info.label}: ainda sem dados coletados.`);
    else if (Date.parse(DATA.last) - Date.parse(info.last) > 2 * DAY) warn.push(`${info.label}: dados só até ${fmtDay(info.last)}.`);
  }
  for (const p of PROVIDERS) {
    const c = DATA.providers[p].covered_from;
    if (c && c > DATA.first) warn.push(`${DATA.providers[p].label}: histórico só a partir de ${fmtDay(c)}.`);
  }
  const w = $("#warnings");
  w.hidden = !warn.length;
  w.replaceChildren(...warn.map((t) => el("p", {}, t)));
}

// ── init ──────────────────────────────────────────────────────────────────
function bind() {
  for (const [id, key] of [["#f-period", "period"], ["#f-cur", "cur"]]) {
    $(id).addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) { state[key] = b.dataset.v; render(); }
    });
  }
  $("#f-scope").addEventListener("change", (e) => {
    state.scope = e.target.value;
    if (state.usecase && scopeOf(state.usecase) !== state.scope && state.scope) state.usecase = "";
    render();
  });
  $("#f-usecase").addEventListener("change", (e) => { state.usecase = e.target.value; render(); });
  $("#res-more").addEventListener("click", () => { state.resAll = !state.resAll; render(); });
  let w = 0;
  new ResizeObserver(([e]) => {
    const nw = Math.round(e.contentRect.width);
    if (DATA && nw !== w) { w = nw; const [f, t] = periodRange(); renderDaily(filtered(f, t), f, t); }
  }).observe($("#chart-daily"));
  addEventListener("hashchange", () => { readHash(); render(); });
  addEventListener("scroll", hideTip, { passive: true });
}

(async function main() {
  readHash();
  try {
    const res = await fetch("data/costs.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
  } catch (e) {
    $("#sub").textContent = `não consegui carregar os dados (${e.message}).`;
    return;
  }
  if (!DATA.usecases[state.usecase]) state.usecase = "";
  if (state.scope && !DATA.scopes[state.scope]) state.scope = "";
  renderHeader();
  bind();
  render();
})();
