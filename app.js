"use strict";
/* Kylskåpsdörren – hushållsapp för två. Ingen byggprocess: den här filen körs som den är.
   Struktur: lagring (store) → synk (put/del/merge) → hjälpare → vyer → bottenark → händelser → start. */

const CFG = window.HUSH_CONFIG || {};
const DEMO = new URLSearchParams(location.search).has("demo");
const COLS = ["shopping","meals","recipes","chores","budget","events"];
const K = (c,i) => c + "/" + i;
const newId = () => Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,9);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lsGet = k => { try { return localStorage.getItem(k) } catch (e) { return null } };
const lsSet = (k,v) => { try { localStorage.setItem(k,v) } catch (e) {} };
const lsDel = k => { try { localStorage.removeItem(k) } catch (e) {} };
const DEVICE = lsGet("hush-device") || (() => { const d = newId(); lsSet("hush-device", d); return d })();
const CACHE_KEY = DEMO ? "hush-demo-cache" : "hush-cache";

/* ---------- Lagring ----------
   Allt går genom tabellen public.items (collection, id, data jsonb, ts, device). Se supabase/schema.sql.
   Båda lagren har samma gränssnitt, så resten av appen bryr sig inte om vilket som används. */
function mkErr(error, status) {
  const e = new Error(error && error.message || "Okänt fel");
  e.code = error && error.code; e.status = status;
  return e;
}
const supaStore = {
  sb: null,
  init() {
    this.sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: "hush-auth" },
    });
  },
  async session() { const { data } = await this.sb.auth.getSession(); return data.session },
  async signIn(password) {
    const { error } = await this.sb.auth.signInWithPassword({ email: CFG.householdEmail, password });
    if (error) throw mkErr(error, error.status);
  },
  async signOut() { try { await this.sb.auth.signOut() } catch (e) {} },
  onSignOut(cb) { this.sb.auth.onAuthStateChange(ev => { if (ev === "SIGNED_OUT") cb() }) },
  async loadAll() {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error, status } = await this.sb.from("items")
        .select("collection,id,data,ts,device").order("collection").order("id").range(from, from + 999);
      if (error) throw mkErr(error, status);
      out.push(...data);
      if (data.length < 1000) return out;
    }
  },
  live(onRow, onDel, onStatus) {
    this.sb.channel("hush-items")
      .on("postgres_changes", { event: "*", schema: "public", table: "items" }, p => {
        if (p.eventType === "DELETE") { if (p.old && p.old.collection) onDel(p.old.collection, p.old.id) }
        else if (p.new) onRow(p.new);
      })
      .subscribe(s => onStatus(s));
  },
  async set(row) {
    const { error, status } = await this.sb.from("items").upsert(row);
    if (error) throw mkErr(error, status);
  },
  async delete(col, id) {
    const { error, status } = await this.sb.from("items").delete().eq("collection", col).eq("id", id);
    if (error) throw mkErr(error, status);
  },
};
/* Demoläge (?demo): samma gränssnitt, men allt sparas bara i den här webbläsaren. För test och utveckling. */
const demoStore = {
  rows: new Map(), cb: null,
  init() { try { JSON.parse(lsGet("hush-demo") || "[]").forEach(r => this.rows.set(K(r.collection, r.id), r)) } catch (e) {} },
  save() { lsSet("hush-demo", JSON.stringify([...this.rows.values()])) },
  async session() { return { demo: true } },
  async signIn() {}, async signOut() {}, onSignOut() {},
  async loadAll() { return [...this.rows.values()].map(r => ({ ...r })) },
  live(onRow, onDel, onStatus) { this.cb = { onRow, onDel }; setTimeout(() => onStatus("SUBSCRIBED"), 0) },
  async set(r) { this.rows.set(K(r.collection, r.id), r); this.save(); setTimeout(() => this.cb && this.cb.onRow({ ...r }), 60) },
  async delete(c, i) { this.rows.delete(K(c, i)); this.save(); setTimeout(() => this.cb && this.cb.onDel(c, i), 60) },
};
const store = DEMO ? demoStore : supaStore;

/* ---------- Data och synk ----------
   Ändringar visas direkt (optimistiskt) och skickas sedan. `pending` håller våra egna osparade/obekräftade
   skrivningar så att ett sent eko eller en äldre hämtning inte skriver över det man just gjort. */
const data = { shopping:[], meals:[], recipes:[], chores:[], budget:[], events:[] };
const pending = new Map(); // nyckel → ts för vår senaste upsert, eller "del"
function byId(col, id) { return data[col].find(x => x.id === id) }
function plain(x) { const { id, ...r } = x; return r }
function setLocal(col, id, body) { const i = data[col].findIndex(x => x.id === id); const row = { id, ...body }; if (i < 0) data[col].push(row); else data[col][i] = row }
function dropLocal(col, id) { data[col] = data[col].filter(x => x.id !== id) }
let cacheTimer;
function changed() { render(); clearTimeout(cacheTimer); cacheTimer = setTimeout(() => lsSet(CACHE_KEY, JSON.stringify(data)), 400) }
function loadCache() {
  try { const c = JSON.parse(lsGet(CACHE_KEY) || "null"); if (!c) return false; COLS.forEach(k => { if (Array.isArray(c[k])) data[k] = c[k] }); return true }
  catch (e) { return false }
}

function onRow(r) {
  if (!data[r.collection]) return;
  const k = K(r.collection, r.id); const p = pending.get(k); const ts = Number(r.ts);
  if (p !== undefined) { if (r.device === DEVICE && ts === p) pending.delete(k); else return }
  setLocal(r.collection, r.id, r.data || {}); changed();
}
function onDel(col, id) {
  if (!data[col]) return;
  const k = K(col, id); const p = pending.get(k);
  if (p !== undefined && p !== "del") return;
  pending.delete(k); dropLocal(col, id); changed();
}
function mergeAll(rows) {
  const next = {}; COLS.forEach(c => next[c] = []);
  const seen = new Set();
  for (const r of rows) {
    if (!next[r.collection]) continue;
    const k = K(r.collection, r.id); seen.add(k);
    const p = pending.get(k);
    if (p !== undefined && !(r.device === DEVICE && Number(r.ts) === p)) { const loc = byId(r.collection, r.id); if (loc) next[r.collection].push(loc); continue }
    if (p !== undefined) pending.delete(k);
    next[r.collection].push({ id: r.id, ...(r.data || {}) });
  }
  for (const c of COLS) for (const x of data[c]) if (!seen.has(K(c, x.id)) && typeof pending.get(K(c, x.id)) === "number") next[c].push(x);
  Object.assign(data, next); changed();
}

const isNetwork = e => e && (e.status === 0 || (!e.status && /fetch|network|load failed/i.test(e.message || "")));
const isAuth = e => e && (e.status === 401 || e.code === "PGRST301" || e.code === "PGRST303");
function writeError(e) {
  if (isAuth(e)) return "Ändringen sparades inte eftersom inloggningen har gått ut. Logga in igen.";
  if (e && e.status === 403) return "Ändringen sparades inte. Databasen nekade åtkomst, kontrollera inställningarna i Supabase.";
  if (e && e.status === 429) return "För många ändringar på kort tid. Vänta en stund och försök igen.";
  return "Ändringen sparades inte eftersom anslutningen inte fungerar. Kontrollera nätet och försök igen.";
}
async function attempt(fn) {
  try { await fn() }
  catch (e) { if (!isNetwork(e)) throw e; await sleep(500 + Math.random() * 700); await fn() }
}
function failed(e) { toast(writeError(e)); if (isAuth(e)) store.signOut() }

async function put(col, id, body) {
  if (ui.phase !== "app") { toast("Ändringen sparades inte. Logga in först."); return false }
  const k = K(col, id); const prev = byId(col, id); const ts = Date.now();
  pending.set(k, ts); setLocal(col, id, body); changed();
  try {
    await attempt(() => store.set({ collection: col, id, data: body, ts, device: DEVICE }));
    setTimeout(() => { if (pending.get(k) === ts) pending.delete(k) }, 8000);
    return true;
  } catch (e) {
    if (pending.get(k) === ts) { pending.delete(k); if (prev) setLocal(col, id, plain(prev)); else dropLocal(col, id); changed() }
    failed(e); return false;
  }
}
async function del(col, id) {
  if (ui.phase !== "app") { toast("Ändringen sparades inte. Logga in först."); return false }
  const k = K(col, id); const prev = byId(col, id);
  pending.set(k, "del"); dropLocal(col, id); changed();
  try {
    await attempt(() => store.delete(col, id));
    setTimeout(() => { if (pending.get(k) === "del") pending.delete(k) }, 8000);
    return true;
  } catch (e) {
    if (pending.get(k) === "del") { pending.delete(k); if (prev) setLocal(col, id, plain(prev)); changed() }
    failed(e); return false;
  }
}
async function removeWithUndo(col, id, msg) {
  const old = byId(col, id); if (!old) return;
  const body = plain(old);
  if (await del(col, id)) toast(msg, () => put(col, id, body));
}

/* ---------- Hjälpare ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const iso = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const parse = s => { const [y,m,d] = s.split("-").map(Number); return new Date(y, m - 1, d, 12) };
const addDays = (s,n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d) };
const today = () => iso(new Date());
const monday = s => { const d = parse(s); return addDays(s, -((d.getDay() + 6) % 7)) };
const isoWeek = s => { const d = parse(s); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); const j = new Date(d.getFullYear(), 0, 4, 12); return 1 + Math.round(((d - j) / 864e5 - 3 + ((j.getDay() + 6) % 7)) / 7) };
const diffDays = (a,b) => Math.round((parse(a) - parse(b)) / 864e5);
const fmt = (s,o) => parse(s).toLocaleDateString("sv-SE", o);
const cap = s => s[0].toUpperCase() + s.slice(1);
const monthKey = s => s.slice(0, 7);
const shiftMonth = (k,n) => { const [y,m] = k.split("-").map(Number); const d = new Date(y, m - 1 + n, 1, 12); return d.getFullYear() + "-" + pad(d.getMonth() + 1) };
const monthName = k => parse(k + "-01").toLocaleDateString("sv-SE", { month:"long", year:"numeric" });
const monthCells = k => { const start = monday(k + "-01"); const out = []; let c = start; do { for (let i = 0; i < 7; i++) { out.push(c); c = addDays(c, 1) } } while (monthKey(c) === k); return out };
const kr = n => new Intl.NumberFormat("sv-SE", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n) + " kr";
const parseAmount = s => { const n = parseFloat(String(s).replace(/[\s ]/g, "").replace(",", ".")); return isFinite(n) ? Math.round(n * 100) / 100 : NaN };
const WD = ["Mån","Tis","Ons","Tor","Fre","Lör","Sön"];

const CATS = ["Frukt & grönt","Bröd","Mejeri & ägg","Kött & fisk","Fryst","Skafferi","Hushåll","Övrigt"];
const KW = {
 "Fryst":["fryst","frysta","glass","fiskpinnar"],
 "Hushåll":["toalettpapper","toapapper","hushållspapper","diskmedel","tvättmedel","sopsäckar","tandkräm","schampo","tvål","disktabletter","blöjor"],
 "Bröd":["bröd","bullar","tortilla","knäckebröd","limpa","baguette","fralla","frallor","wraps"],
 "Mejeri & ägg":["mjölk","grädde","ost","smör","yoghurt","fil","ägg","crème","kvarg","fraiche","mozzarella","parmesan","fetaost","halloumi"],
 "Kött & fisk":["kött","köttfärs","färs","kyckling","fläsk","bacon","korv","lax","torsk","fisk","räkor","skinka","biff","kassler"],
 "Frukt & grönt":["äpple","äpplen","banan","bananer","citron","lime","apelsin","tomat","gurka","sallad","lök","vitlök","morot","morötter","potatis","paprika","broccoli","spenat","avokado","svamp","champinjon","purjolök","zucchini","päron","druvor","bär","persilja","basilika","dill","ingefära","kål","blomkål","vitkål"],
 "Skafferi":["pasta","spaghetti","ris","mjöl","socker","salt","peppar","olja","vinäger","krossade","konserv","bönor","linser","kaffe","te","müsli","flingor","havregryn","buljong","ketchup","senap","kryddor","tacokrydda","nudlar","honung","sylt","soja"],
};
function guessCat(name) {
  const toks = name.toLowerCase().split(/[^a-zåäöé]+/).filter(Boolean);
  for (const cat of ["Fryst","Hushåll","Bröd","Mejeri & ägg","Kött & fisk","Frukt & grönt","Skafferi"])
    for (const k of KW[cat]) for (const t of toks)
      if (t === k || t.endsWith(k) && k.length >= 3 || (k.length >= 4 && t.startsWith(k))) return cat;
  return "Övrigt";
}
const BCATS = { expense:["Boende","Mat","Transport","Försäkringar","Abonnemang","Barn & husdjur","Nöje","Sparande","Övrigt"], income:["Lön","Bidrag","Sidoinkomst","Övrigt"] };
const INTERVALS = [[1,"Varje dag"],[3,"Var tredje dag"],[7,"Varje vecka"],[14,"Varannan vecka"],[30,"Varje månad"],[90,"Var tredje månad"],[182,"Varje halvår"],[365,"Varje år"]];

/* ---------- Tillstånd ---------- */
const TABS = [
 ["inkop","Inköp",'<path d="M3 4h2l2.5 11h10L20 7H6"/><circle cx="9" cy="19" r="1.4"/><circle cx="16" cy="19" r="1.4"/>'],
 ["mat","Mat",'<path d="M7 3v8M4 3v5a3 3 0 0 0 6 0V3M7 11v10M17 3c-2 1-3 4-3 7 0 2 1 3 3 3v8"/>'],
 ["recept","Recept",'<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11M9 8h6"/>'],
 ["stad","Städ",'<path d="M15 3l-4 8M8 11h7l3 3-1 7H6l-1-7z"/>'],
 ["budget","Budget",'<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 15h2"/>'],
 ["kalender","Kalender",'<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/>'],
];
const ui = {
  phase: "loading", // loading | setup | login | app
  tab: "inkop", status: null, loginError: null, busy: false,
  mealMode: "week", week: monday(today()), mealMonth: monthKey(today()),
  q: "", budgetMonth: monthKey(today()), calMonth: monthKey(today()), calSel: today(),
};
{ const t = location.hash.slice(1) || lsGet("tab"); if (TABS.some(x => x[0] === t)) ui.tab = t }

let toastTimer;
function toast(msg, undo) {
  const t = $("#toast"); t.innerHTML = '<span>' + esc(msg) + '</span>' + (undo ? '<button type="button" id="undo">Ångra</button>' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true }, undo ? 7000 : 5000);
  if (undo) $("#undo").onclick = () => { t.hidden = true; undo() };
}

/* ---------- Vyer ---------- */
function statusBar() {
  let h = "";
  if (DEMO) h += '<div class="status">Demoläge: allt sparas bara i den här webbläsaren och delas inte.</div>';
  if (ui.status) h += '<div class="status">' + esc(ui.status) + '</div>';
  return h;
}
function header(title, sub) { return '<header class="head"><div><h1>' + esc(title) + '</h1><p class="date">' + esc(sub) + '</p></div></header>' }
function empty(t, s) { return '<div class="empty"><strong>' + esc(t) + '</strong><span>' + esc(s) + '</span></div>' }
const nowLine = () => { const t = today(); return cap(fmt(t, { weekday:"long", day:"numeric", month:"long" })) + " · v. " + isoWeek(t) };

function vLoading() { return header("Kylskåpsdörren", "Öppnar…") }
function vSetup() {
  return header("Kylskåpsdörren", "Appen är inte kopplad till någon databas än") +
  '<div class="paper"><p>Fyll i <code>supabaseUrl</code>, <code>supabaseKey</code> och <code>householdEmail</code> i <code>config.js</code>. Stegen står i README.md i repot.</p>' +
  '<p class="sub">Vill du bara prova? Öppna <a href="?demo">demoläget</a>, där allt sparas lokalt i webbläsaren.</p></div>';
}
function vLogin() {
  return header("Kylskåpsdörren", "Hushållets lista, matsedel och kalender") +
  '<form class="paper" data-f="login"><h2>Logga in</h2><p class="sub">Ni delar ett gemensamt lösenord för hushållet. Du behöver bara logga in en gång per telefon.</p>' +
  '<input class="vh" name="username" autocomplete="username" tabindex="-1" aria-hidden="true" value="' + esc(CFG.householdEmail) + '" readonly>' +
  '<label>Hushållets lösenord<input id="pw" name="password" type="password" autocomplete="current-password" required></label>' +
  (ui.loginError ? '<p class="err" role="alert">' + esc(ui.loginError) + '</p>' : '') +
  '<button class="primary"' + (ui.busy ? ' disabled' : '') + '>' + (ui.busy ? 'Loggar in…' : 'Logga in') + '</button></form>';
}

function vInkop() {
  const items = data.shopping; const open = items.filter(i => !i.done); const done = items.filter(i => i.done);
  const row = i => '<li class="item ' + (i.done ? 'done' : '') + '"><button type="button" class="check" data-a="toggleItem" data-id="' + esc(i.id) + '" aria-pressed="' + (!!i.done) + '"><span class="box">' + (i.done ? '✓' : '') + '</span><span class="lbl">' + esc(i.name) + '</span></button><button type="button" class="edit" data-a="editItem" data-id="' + esc(i.id) + '" aria-label="Ändra ' + esc(i.name) + '">Ändra</button></li>';
  let list = "";
  if (!items.length) list = empty("Listan är tom", "Skriv en vara ovan, eller lägg till veckans middagar från fliken Mat.");
  for (const c of CATS) {
    const g = open.filter(i => (CATS.includes(i.category) ? i.category : "Övrigt") === c).sort((a,b) => a.name.localeCompare(b.name, "sv"));
    if (g.length) list += '<section class="group"><h3>' + esc(c) + '</h3><ul>' + g.map(row).join("") + '</ul></section>';
  }
  if (items.length && !open.length) list += empty("Allt är inhandlat", "Rensa de avbockade varorna när ni är hemma.");
  if (done.length) list += '<section class="group"><h3>Avbockat (' + done.length + ')</h3><ul>' + done.map(row).join("") + '</ul><button type="button" data-a="clearDone">Rensa avbockade</button></section>';
  return header("Inköpslista", open.length ? open.length + " kvar att handla" : nowLine()) + statusBar() +
  '<div class="paper"><form class="group" data-f="addItem" style="gap:8px"><div class="addrow"><input id="itemName" name="name" placeholder="Lägg till vara, t.ex. mjölk" aria-label="Vara" autocomplete="off" enterkeyhint="done"><button class="primary">Lägg till</button></div><label>Kategori<select id="itemCat" name="category"><option value="">Välj automatiskt</option>' + CATS.map(c => '<option>' + esc(c) + '</option>').join("") + '</select></label></form></div>' +
  '<div class="paper">' + list + '</div>';
}

function mealLabel(m) { if (!m) return ""; if (m.recipeId) { const r = byId("recipes", m.recipeId); return r ? r.name : (m.text || "Borttaget recept") } return m.text || "" }
function vMat() {
  const t = today(); const tm = byId("meals", t);
  let body;
  if (ui.mealMode === "week") {
    const days = Array.from({ length: 7 }, (_, i) => addDays(ui.week, i));
    const end = days[6];
    body = '<div class="nav"><button type="button" data-a="weekPrev" aria-label="Föregående vecka">‹</button><strong>Vecka ' + isoWeek(ui.week) + '</strong><button type="button" data-a="weekNext" aria-label="Nästa vecka">›</button></div>' +
    '<p class="sub" style="text-align:center">' + esc(fmt(ui.week, { day:"numeric", month:"short" })) + ' till ' + esc(fmt(end, { day:"numeric", month:"short" })) + '</p><div>' +
    days.map(d => { const l = mealLabel(byId("meals", d)); return '<button type="button" class="day" data-a="mealDay" data-d="' + d + '"><span><b>' + esc(fmt(d, { weekday:"short" }).replace(".", "")) + '</b><small>' + esc(fmt(d, { day:"numeric", month:"numeric" })) + (d === t ? ' idag' : '') + '</small></span><span class="' + (l ? 'meal' : 'none') + '">' + esc(l || "Lägg till middag") + '</span></button>' }).join("") + '</div>' +
    '<button type="button" class="primary" data-a="weekToList">Lägg veckans ingredienser på inköpslistan</button>';
  } else {
    const k = ui.mealMonth;
    body = '<div class="nav"><button type="button" data-a="mealMonthPrev" aria-label="Föregående månad">‹</button><strong>' + esc(monthName(k)) + '</strong><button type="button" data-a="mealMonthNext" aria-label="Nästa månad">›</button></div><div class="grid">' + WD.map(w => '<div class="wd">' + w + '</div>').join("") +
    monthCells(k).map(d => { const l = mealLabel(byId("meals", d)); return '<button type="button" class="cell ' + (monthKey(d) !== k ? 'out ' : '') + (d === t ? 'today' : '') + '" data-a="mealDay" data-d="' + d + '" aria-label="' + esc(fmt(d, { day:"numeric", month:"long" }) + (l ? ": " + l : ", ingen middag")) + '"><span>' + parse(d).getDate() + '</span><span class="m">' + esc(l) + '</span></button>' }).join("") + '</div>';
  }
  const note = tm && mealLabel(tm) ? '<div class="today-note"><small>Ikväll</small><strong>' + esc(mealLabel(tm)) + '</strong></div>' : "";
  return header("Matsedel", nowLine()) + statusBar() + note +
  '<div class="seg"><button type="button" class="' + (ui.mealMode === "week" ? "on" : "") + '" data-a="mealMode" data-m="week">Vecka</button><button type="button" class="' + (ui.mealMode === "month" ? "on" : "") + '" data-a="mealMode" data-m="month">Månad</button></div>' +
  '<div class="paper">' + body + '</div>';
}

function vRecept() {
  const q = ui.q.trim().toLowerCase();
  const all = [...data.recipes].sort((a,b) => a.name.localeCompare(b.name, "sv"));
  const f = all.filter(r => !q || r.name.toLowerCase().includes(q) || (r.ingredients || []).some(i => i.toLowerCase().includes(q)));
  let list;
  if (!all.length) list = empty("Inga recept ännu", "Spara era vanligaste rätter här. Sedan kan ni välja dem i matsedeln med ett tryck.");
  else if (!f.length) list = empty("Inget recept matchar", "Prova ett annat ord. Sökningen letar i namn och ingredienser.");
  else list = '<ul>' + f.map(r => '<li class="item"><button type="button" class="rowbtn" data-a="viewRecipe" data-id="' + esc(r.id) + '"><span class="lbl">' + esc(r.name) + '</span><span class="sub">' + (r.servings ? esc(r.servings) + ' portioner · ' : '') + (r.ingredients || []).length + ' ingredienser</span></button></li>').join("") + '</ul>';
  return header("Receptbok", all.length + " recept") + statusBar() +
  '<div class="addrow"><input id="recipeQ" data-i="q" type="search" placeholder="Sök recept eller ingrediens" aria-label="Sök recept" value="' + esc(ui.q) + '"><button type="button" class="primary" data-a="newRecipe">Nytt</button></div>' +
  '<div class="paper">' + list + '</div>';
}

function choreNext(c) { return c.lastDone ? addDays(c.lastDone, c.intervalDays || 7) : (c.startDate || today()) }
function choreStatus(next) {
  const n = diffDays(next, today());
  if (n < 0) return ['bad', (-n) + (n === -1 ? ' dag sen' : ' dagar sen')];
  if (n === 0) return ['warn', 'Idag'];
  if (n === 1) return ['good', 'Imorgon'];
  return ['good', 'Om ' + n + ' dagar'];
}
const intervalText = n => (INTERVALS.find(x => x[0] === n) || [0, "Var " + n + ":e dag"])[1];
function vStad() {
  const cs = data.chores.map(c => ({ ...c, next: choreNext(c) })).sort((a,b) => a.next.localeCompare(b.next));
  const late = cs.filter(c => c.next <= today()).length;
  let list;
  if (!cs.length) list = empty("Inga sysslor ännu", "Lägg till det som återkommer, som dammsugning eller att byta lakan. Appen räknar ut nästa gång.");
  else list = '<ul>' + cs.map(c => { const [k, txt] = choreStatus(c.next); return '<li class="item"><button type="button" class="rowbtn" data-a="editChore" data-id="' + esc(c.id) + '"><span class="lbl">' + esc(c.name) + '</span><span class="sub">' + esc(intervalText(c.intervalDays)) + ' · ' + esc(c.assignee || "Båda") + '</span><span class="sub">Nästa: ' + esc(fmt(c.next, { weekday:"short", day:"numeric", month:"short" })) + '</span></button><span class="pill ' + k + '">' + esc(txt) + '</span><button type="button" data-a="choreDone" data-id="' + esc(c.id) + '" aria-label="Markera ' + esc(c.name) + ' som klar">Klar</button></li>' }).join("") + '</ul>';
  return header("Städschema", late ? late + " att göra nu" : "Inget försenat") + statusBar() +
  '<button type="button" class="primary" data-a="newChore">Lägg till syssla</button><div class="paper">' + list + '</div>';
}

function vBudget() {
  const k = ui.budgetMonth; const rows = data.budget.filter(b => b.month === k);
  const inc = rows.filter(r => r.type === "income"); const exp = rows.filter(r => r.type !== "income");
  const si = inc.reduce((a,r) => a + (+r.amount || 0), 0); const se = exp.reduce((a,r) => a + (+r.amount || 0), 0); const left = si - se;
  const cats = {}; exp.forEach(r => { cats[r.category || "Övrigt"] = (cats[r.category || "Övrigt"] || 0) + (+r.amount || 0) });
  const bars = Object.entries(cats).sort((a,b) => b[1] - a[1]).map(([c,v]) => '<div class="bar"><div><span>' + esc(c) + '</span><span>' + kr(v) + '</span></div><div class="track"><i style="width:' + (se ? Math.round(v / se * 100) : 0) + '%"></i></div></div>').join("");
  const row = r => '<li class="item"><button type="button" class="rowbtn" data-a="editBudget" data-id="' + esc(r.id) + '"><span class="lbl">' + esc(r.label || r.category) + '</span><span class="sub">' + esc(r.category || "") + '</span></button><span class="money ' + (r.type === "income" ? "in" : "") + '">' + (r.type === "income" ? "+" : "−") + kr(+r.amount || 0) + '</span></li>';
  const prev = data.budget.filter(b => b.month === shiftMonth(k, -1));
  let list = "";
  if (!rows.length) list = empty("Inget inlagt för " + monthName(k), "Lägg till inkomster och utgifter för att se vad som blir kvar.") + (prev.length ? '<button type="button" data-a="copyBudget">Kopiera ' + prev.length + ' poster från förra månaden</button>' : '');
  else {
    if (inc.length) list += '<section class="group"><h3>Inkomster</h3><ul>' + inc.map(row).join("") + '</ul></section>';
    if (exp.length) list += '<section class="group"><h3>Utgifter</h3><ul>' + exp.map(row).join("") + '</ul></section>';
  }
  return header("Hushållsbudget", nowLine()) + statusBar() +
  '<div class="paper"><div class="nav"><button type="button" data-a="budPrev" aria-label="Föregående månad">‹</button><strong>' + esc(monthName(k)) + '</strong><button type="button" data-a="budNext" aria-label="Nästa månad">›</button></div>' +
  '<div class="sum"><div><small>Inkomster</small><b>' + kr(si) + '</b></div><div><small>Utgifter</small><b>' + kr(se) + '</b></div><div class="left"><small>Kvar att spendera</small><b class="' + (left < 0 ? 'neg' : '') + '">' + (left < 0 ? "−" : "") + kr(Math.abs(left)) + '</b></div></div></div>' +
  (bars ? '<div class="paper"><h2>Utgifter per kategori</h2>' + bars + '</div>' : '') +
  '<button type="button" class="primary" data-a="newBudget">Lägg till post</button><div class="paper">' + list + '</div>';
}

function vKalender() {
  const k = ui.calMonth; const t = today();
  const on = d => data.events.filter(e => e.date === d).sort((a,b) => (a.time || "").localeCompare(b.time || ""));
  const evRow = e => '<li class="item"><button type="button" class="rowbtn" data-a="editEvent" data-id="' + esc(e.id) + '"><span class="lbl">' + esc(e.title) + '</span><span class="sub">' + esc(fmt(e.date, { weekday:"short", day:"numeric", month:"short" })) + (e.time ? ' kl. ' + esc(e.time) : '') + '</span>' + (e.note ? '<span class="sub prewrap">' + esc(e.note) + '</span>' : '') + '</button></li>';
  const dayEv = on(ui.calSel);
  const up = data.events.filter(e => e.date >= t).sort((a,b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || ""))).slice(0, 15);
  return header("Kalender", nowLine()) + statusBar() +
  '<div class="paper"><div class="nav"><button type="button" data-a="calPrev" aria-label="Föregående månad">‹</button><strong>' + esc(monthName(k)) + '</strong><button type="button" data-a="calNext" aria-label="Nästa månad">›</button></div><div class="grid">' + WD.map(w => '<div class="wd">' + w + '</div>').join("") +
  monthCells(k).map(d => { const n = on(d).length; return '<button type="button" class="cell ' + (monthKey(d) !== k ? 'out ' : '') + (d === t ? 'today ' : '') + (d === ui.calSel ? 'sel' : '') + '" style="min-height:50px" data-a="calDay" data-d="' + d + '" aria-label="' + esc(fmt(d, { day:"numeric", month:"long" })) + ', ' + n + ' händelser"><span>' + parse(d).getDate() + '</span><span class="dots">' + '<i></i>'.repeat(Math.min(n, 3)) + '</span></button>' }).join("") + '</div></div>' +
  '<div class="paper"><div class="nav" style="gap:10px"><h2 class="grow">' + esc(cap(fmt(ui.calSel, { weekday:"long", day:"numeric", month:"long" }))) + '</h2><button type="button" class="primary" data-a="newEvent">Lägg till</button></div>' +
  (dayEv.length ? '<ul>' + dayEv.map(evRow).join("") + '</ul>' : '<p class="sub">Inget inplanerat den här dagen.</p>') + '</div>' +
  '<div class="paper"><h2>På gång</h2>' + (up.length ? '<ul>' + up.map(evRow).join("") + '</ul>' : empty("Inget på gång", "Tryck på en dag och lägg till en händelse. Den syns direkt hos er båda.")) + '<p class="sub">Kalendern skickar inga påminnelser.</p></div>' +
  (DEMO ? '' : '<button type="button" class="quiet" data-a="logout">Logga ut från den här telefonen</button>');
}

const VIEWS = { inkop:vInkop, mat:vMat, recept:vRecept, stad:vStad, budget:vBudget, kalender:vKalender };
function render() {
  const root = $("#app");
  const a = document.activeElement; const aid = a && root.contains(a) && a.id ? a.id : null;
  let sel = null; try { if (aid && a.selectionStart != null) sel = [a.selectionStart, a.selectionEnd] } catch (e) {}
  const vals = {}; root.querySelectorAll("input[id],select[id]").forEach(el => { vals[el.id] = el.value });
  const inApp = ui.phase === "app";
  root.innerHTML = inApp ? VIEWS[ui.tab]() : ui.phase === "setup" ? vSetup() : ui.phase === "login" ? vLogin() : vLoading();
  Object.entries(vals).forEach(([id, v]) => { const el = document.getElementById(id); if (el && root.contains(el)) el.value = v });
  if (aid) { const el = document.getElementById(aid); if (el) { el.focus(); try { if (sel) el.setSelectionRange(sel[0], sel[1]) } catch (e) {} } }
  $("#tabs").hidden = !inApp;
  if (inApp) $("#tabbar").innerHTML = TABS.map(([id, l, ic]) => '<button type="button" data-a="tab" data-t="' + id + '" ' + (ui.tab === id ? 'aria-current="page"' : '') + '><svg viewBox="0 0 24 24" aria-hidden="true">' + ic + '</svg>' + l + '</button>').join("");
}
function setTab(t) { ui.tab = t; lsSet("tab", t); try { history.replaceState(null, "", location.search + "#" + t) } catch (e) {} render(); window.scrollTo(0, 0) }

/* ---------- Bottenark ---------- */
const sheet = $("#sheet");
function openSheet(html) { sheet.innerHTML = html; if (!sheet.open) sheet.showModal() }
function closeSheet() { if (sheet.open) sheet.close(); sheet.innerHTML = "" }
sheet.addEventListener("click", e => { if (e.target === sheet) closeSheet() });
const foot = (delAct, id) => '<div class="btnrow"><button class="primary grow">Spara</button><button type="button" data-a="closeSheet">Avbryt</button>' + (delAct ? '<button type="button" class="danger" data-a="' + delAct + '" data-id="' + esc(id) + '">Ta bort</button>' : '') + '</div>';

function sheetItem(id) { const i = byId("shopping", id); if (!i) return; openSheet('<form data-f="saveItem" data-id="' + esc(id) + '"><h2>Ändra vara</h2><label>Vara<input name="name" required value="' + esc(i.name) + '"></label><label>Kategori<select name="category">' + CATS.map(c => '<option ' + (c === i.category ? 'selected' : '') + '>' + esc(c) + '</option>').join("") + '</select></label>' + foot("delItem", id) + '</form>') }
function sheetMeal(d) {
  const m = byId("meals", d); const rs = [...data.recipes].sort((a,b) => a.name.localeCompare(b.name, "sv"));
  openSheet('<form data-f="saveMeal" data-d="' + d + '"><h2>' + esc(cap(fmt(d, { weekday:"long", day:"numeric", month:"long" }))) + '</h2>' +
  '<label>Välj recept<select name="recipeId"><option value="">Inget recept</option>' + rs.map(r => '<option value="' + esc(r.id) + '" ' + (m && m.recipeId === r.id ? 'selected' : '') + '>' + esc(r.name) + '</option>').join("") + '</select></label>' +
  (rs.length ? '' : '<p class="sub">Receptboken är tom. Skriv rätten nedan, eller spara recept under fliken Recept.</p>') +
  '<label>Eller skriv fritt<input name="text" placeholder="T.ex. rester eller pizza" value="' + esc(m && !m.recipeId ? m.text : "") + '"></label>' + foot(m ? "delMeal" : null, d) + '</form>');
}
function sheetRecipeView(id) {
  const r = byId("recipes", id); if (!r) return;
  openSheet('<div class="body"><h2>' + esc(r.name) + '</h2>' + (r.servings ? '<p class="sub">' + esc(r.servings) + ' portioner</p>' : '') +
  '<section class="group"><h3>Ingredienser</h3><ul class="ings">' + (r.ingredients || []).map(i => '<li>' + esc(i) + '</li>').join("") + '</ul></section>' +
  (r.instructions ? '<section class="group"><h3>Gör så här</h3><p class="prewrap">' + esc(r.instructions) + '</p></section>' : '') +
  '<button type="button" class="primary" data-a="recipeToList" data-id="' + esc(id) + '">Lägg ingredienserna på inköpslistan</button><div class="btnrow"><button type="button" class="grow" data-a="editRecipe" data-id="' + esc(id) + '">Redigera</button><button type="button" data-a="closeSheet">Stäng</button></div></div>');
}
function sheetRecipe(id) {
  const r = id ? byId("recipes", id) : null;
  openSheet('<form data-f="saveRecipe" data-id="' + esc(id || "") + '"><h2>' + (r ? 'Redigera recept' : 'Nytt recept') + '</h2><label>Namn<input name="name" required value="' + esc(r ? r.name : "") + '"></label><label>Portioner<input name="servings" type="number" min="1" inputmode="numeric" value="' + esc(r ? r.servings : 4) + '"></label><label>Ingredienser, en per rad<textarea name="ingredients" required placeholder="400 g köttfärs&#10;1 gul lök">' + esc(r ? (r.ingredients || []).join("\n") : "") + '</textarea></label><label>Gör så här<textarea name="instructions">' + esc(r ? r.instructions : "") + '</textarea></label>' + foot(r ? "delRecipe" : null, id) + '</form>');
}
function sheetChore(id) {
  const c = id ? byId("chores", id) : null; const iv = c ? c.intervalDays : 7;
  const opts = INTERVALS.some(x => x[0] === iv) ? INTERVALS : [...INTERVALS, [iv, "Var " + iv + ":e dag"]];
  const names = [...new Set(data.chores.map(x => x.assignee).filter(Boolean))];
  openSheet('<form data-f="saveChore" data-id="' + esc(id || "") + '"><h2>' + (c ? 'Ändra syssla' : 'Ny syssla') + '</h2><label>Syssla<input name="name" required placeholder="T.ex. dammsuga" value="' + esc(c ? c.name : "") + '"></label><label>Hur ofta<select name="intervalDays">' + opts.map(([n, l]) => '<option value="' + n + '" ' + (n === iv ? 'selected' : '') + '>' + esc(l) + '</option>').join("") + '</select></label><label>Ansvarig<input name="assignee" list="assignees" placeholder="Namn, eller tomt för båda" value="' + esc(c ? c.assignee : "") + '"><datalist id="assignees">' + names.map(n => '<option value="' + esc(n) + '"></option>').join("") + '</datalist></label><label>' + (c && c.lastDone ? 'Senast gjord' : 'Första gången') + '<input name="date" type="date" required value="' + esc(c ? (c.lastDone || c.startDate) : today()) + '"></label>' + foot(c ? "delChore" : null, id) + '</form>');
}
function sheetBudget(id, type) {
  const b = id ? byId("budget", id) : null; const t = type || (b ? (b.type === "income" ? "income" : "expense") : "expense");
  openSheet('<form data-f="saveBudget" data-id="' + esc(id || "") + '" data-type="' + t + '"><h2>' + (b ? 'Ändra post' : 'Ny post') + '</h2><div class="seg"><button type="button" class="' + (t === "expense" ? "on" : "") + '" data-a="budType" data-t="expense">Utgift</button><button type="button" class="' + (t === "income" ? "on" : "") + '" data-a="budType" data-t="income">Inkomst</button></div><label>Vad gäller det?<input name="label" required value="' + esc(b ? b.label : "") + '" placeholder="' + (t === "income" ? "T.ex. lön" : "T.ex. hyra") + '"></label><div class="row2"><label>Kategori<select name="category">' + BCATS[t].map(c => '<option ' + (b && b.category === c ? 'selected' : '') + '>' + esc(c) + '</option>').join("") + '</select></label><label>Belopp i kr<input name="amount" required inputmode="decimal" placeholder="0" value="' + esc(b ? String(b.amount).replace(".", ",") : "") + '"></label></div>' + foot(b ? "delBudget" : null, id) + '</form>');
}
function sheetEvent(id) {
  const e = id ? byId("events", id) : null;
  openSheet('<form data-f="saveEvent" data-id="' + esc(id || "") + '"><h2>' + (e ? 'Ändra händelse' : 'Ny händelse') + '</h2><label>Vad händer?<input name="title" required value="' + esc(e ? e.title : "") + '"></label><div class="row2"><label>Datum<input name="date" type="date" required value="' + esc(e ? e.date : ui.calSel) + '"></label><label>Tid<input name="time" type="time" value="' + esc(e ? e.time : "") + '"></label></div><label>Anteckning<textarea name="note" style="min-height:70px">' + esc(e ? e.note : "") + '</textarea></label>' + foot(e ? "delEvent" : null, id) + '</form>');
}

/* ---------- Inköp från recept ---------- */
async function addIngredients(lines, weekKey) {
  const tally = new Map();
  lines.map(s => s.trim()).filter(Boolean).forEach(s => tally.set(s, (tally.get(s) || 0) + 1));
  let added = 0, skipped = 0;
  for (const [ing, n] of tally) {
    const name = n > 1 ? ing + " ×" + n : ing; const low = name.toLowerCase();
    const exists = data.shopping.some(i => i.name.toLowerCase() === low && (!i.done || (weekKey && i.weekKey === weekKey)));
    if (exists) { skipped++; continue }
    const ok = await put("shopping", newId(), { name, category: guessCat(ing), done: false, createdAt: Date.now(), ...(weekKey ? { weekKey } : {}) });
    if (!ok) return;
    added++;
  }
  toast(added ? added + (added === 1 ? " vara" : " varor") + " tillagd" + (added === 1 ? "" : "a") + (skipped ? ", " + skipped + " fanns redan" : "") : "Alla varor finns redan på listan.");
}

/* ---------- Händelser ---------- */
const A = {
  tab: el => setTab(el.dataset.t), closeSheet,
  logout: async () => { if (confirm("Logga ut från den här telefonen? Datan finns kvar för er båda.")) await store.signOut() },
  toggleItem: el => { const i = byId("shopping", el.dataset.id); if (i) put("shopping", i.id, { ...plain(i), done: !i.done }) },
  editItem: el => sheetItem(el.dataset.id),
  delItem: el => { closeSheet(); removeWithUndo("shopping", el.dataset.id, "Varan togs bort.") },
  clearDone: async () => { const ds = data.shopping.filter(i => i.done).map(i => ({ id: i.id, b: plain(i) })); for (const d of ds) if (!await del("shopping", d.id)) return; toast(ds.length + " varor rensades.", async () => { for (const d of ds) await put("shopping", d.id, d.b) }) },
  mealMode: el => { ui.mealMode = el.dataset.m; render() },
  weekPrev: () => { ui.week = addDays(ui.week, -7); render() }, weekNext: () => { ui.week = addDays(ui.week, 7); render() },
  mealMonthPrev: () => { ui.mealMonth = shiftMonth(ui.mealMonth, -1); render() }, mealMonthNext: () => { ui.mealMonth = shiftMonth(ui.mealMonth, 1); render() },
  mealDay: el => sheetMeal(el.dataset.d),
  delMeal: el => { closeSheet(); removeWithUndo("meals", el.dataset.id, "Middagen togs bort.") },
  weekToList: () => {
    const lines = []; let rs = 0;
    for (let i = 0; i < 7; i++) { const m = byId("meals", addDays(ui.week, i)); const r = m && m.recipeId && byId("recipes", m.recipeId); if (r) { rs++; lines.push(...(r.ingredients || [])) } }
    if (!rs) { toast("Veckan har inga rätter från receptboken ännu. Fritexträtter har inga ingredienser att lägga till."); return }
    addIngredients(lines, ui.week);
  },
  newRecipe: () => sheetRecipe(null), viewRecipe: el => sheetRecipeView(el.dataset.id), editRecipe: el => sheetRecipe(el.dataset.id),
  delRecipe: el => { closeSheet(); removeWithUndo("recipes", el.dataset.id, "Receptet togs bort.") },
  recipeToList: el => { const r = byId("recipes", el.dataset.id); closeSheet(); if (r) addIngredients(r.ingredients || [], "recipe-" + r.id + "-" + today()) },
  newChore: () => sheetChore(null), editChore: el => sheetChore(el.dataset.id),
  delChore: el => { closeSheet(); removeWithUndo("chores", el.dataset.id, "Sysslan togs bort.") },
  choreDone: async el => { const c = byId("chores", el.dataset.id); if (!c) return; const old = plain(c); if (await put("chores", c.id, { ...old, lastDone: today() })) toast(c.name + " är klar. Nästa gång: " + fmt(addDays(today(), c.intervalDays || 7), { day:"numeric", month:"short" }).replace(/\.$/, "") + ".", () => put("chores", c.id, old)) },
  budPrev: () => { ui.budgetMonth = shiftMonth(ui.budgetMonth, -1); render() }, budNext: () => { ui.budgetMonth = shiftMonth(ui.budgetMonth, 1); render() },
  newBudget: () => sheetBudget(null), editBudget: el => sheetBudget(el.dataset.id),
  budType: el => {
    const f = el.closest("form"); const keep = { label: f.elements.label.value, amount: f.elements.amount.value };
    sheetBudget(f.dataset.id || null, el.dataset.t);
    const nf = sheet.querySelector("form"); nf.elements.label.value = keep.label; nf.elements.amount.value = keep.amount;
  },
  delBudget: el => { closeSheet(); removeWithUndo("budget", el.dataset.id, "Posten togs bort.") },
  copyBudget: async () => { const k = ui.budgetMonth; const src = data.budget.filter(b => b.month === shiftMonth(k, -1)); for (const b of src) if (!await put("budget", newId(), { ...plain(b), month: k })) return; toast(src.length + " poster kopierades.") },
  calPrev: () => { ui.calMonth = shiftMonth(ui.calMonth, -1); render() }, calNext: () => { ui.calMonth = shiftMonth(ui.calMonth, 1); render() },
  calDay: el => { ui.calSel = el.dataset.d; render() },
  newEvent: () => sheetEvent(null), editEvent: el => sheetEvent(el.dataset.id),
  delEvent: el => { closeSheet(); removeWithUndo("events", el.dataset.id, "Händelsen togs bort.") },
};
document.addEventListener("click", e => { const el = e.target.closest("[data-a]"); if (el && A[el.dataset.a]) A[el.dataset.a](el) });
document.addEventListener("input", e => { if (e.target.dataset && e.target.dataset.i === "q") { ui.q = e.target.value; render() } });
const F = {
  login: async v => {
    if (ui.busy) return;
    ui.busy = true; ui.loginError = null; render();
    try { await store.signIn(v.password); ui.busy = false; await connect() }
    catch (e) {
      ui.busy = false;
      ui.loginError = e.code === "email_not_confirmed" ? "Användaren " + CFG.householdEmail + " är inte bekräftad. Bekräfta den i Supabase under Authentication → Users."
        : e.code === "invalid_credentials" ? "Fel lösenord, eller så finns ingen användare med e-posten " + CFG.householdEmail + " i Supabase."
        : e.status === 400 ? "Inloggningen nekades (" + (e.code || e.message) + ")." : isNetwork(e) ? "Kunde inte nå servern. Kontrollera nätet och försök igen." : "Inloggningen misslyckades: " + e.message;
      render();
    }
  },
  addItem: async (v, f) => { const name = v.name.trim(); if (!name) return; f.reset(); $("#itemName").focus(); await put("shopping", newId(), { name, category: v.category || guessCat(name), done: false, createdAt: Date.now() }) },
  saveItem: async (v, f) => { const i = byId("shopping", f.dataset.id); closeSheet(); if (i) await put("shopping", i.id, { ...plain(i), name: v.name.trim(), category: v.category }) },
  saveMeal: async (v, f) => { const d = f.dataset.d; const text = v.text.trim(); closeSheet(); if (v.recipeId) await put("meals", d, { date: d, recipeId: v.recipeId, text: "" }); else if (text) await put("meals", d, { date: d, recipeId: "", text }); else if (byId("meals", d)) await del("meals", d) },
  saveRecipe: async (v, f) => { const id = f.dataset.id || newId(); const old = byId("recipes", id); closeSheet(); await put("recipes", id, { name: v.name.trim(), servings: parseInt(v.servings, 10) || 0, ingredients: v.ingredients.split("\n").map(s => s.trim()).filter(Boolean), instructions: v.instructions.trim(), createdAt: old ? old.createdAt : Date.now() }) },
  saveChore: async (v, f) => { const id = f.dataset.id || newId(); const old = byId("chores", id); closeSheet(); const b = { name: v.name.trim(), intervalDays: parseInt(v.intervalDays, 10) || 7, assignee: v.assignee.trim(), createdAt: old ? old.createdAt : Date.now() }; if (old && old.lastDone) { b.lastDone = v.date; b.startDate = old.startDate || v.date } else { b.startDate = v.date; b.lastDone = "" } await put("chores", id, b) },
  saveBudget: async (v, f) => { const amount = parseAmount(v.amount); if (!(amount >= 0)) { toast("Skriv beloppet som ett tal, till exempel 1250 eller 1250,50."); return } const id = f.dataset.id || newId(); const old = byId("budget", id); closeSheet(); await put("budget", id, { month: old ? old.month : ui.budgetMonth, type: f.dataset.type, label: v.label.trim(), category: v.category, amount }) },
  saveEvent: async (v, f) => { const id = f.dataset.id || newId(); closeSheet(); ui.calSel = v.date; ui.calMonth = monthKey(v.date); await put("events", id, { title: v.title.trim(), date: v.date, time: v.time || "", note: v.note.trim() }) },
};
document.addEventListener("submit", e => { const f = e.target.closest("[data-f]"); if (!f) return; e.preventDefault(); F[f.dataset.f](Object.fromEntries(new FormData(f)), f) });
window.addEventListener("hashchange", () => { const t = location.hash.slice(1); if (VIEWS[t] && t !== ui.tab) { ui.tab = t; render() } });

/* ---------- Anslutning ---------- */
const MSG_STALE = "Kunde inte hämta det senaste. Det som visas kan vara inaktuellt. Kontrollera nätet.";
const MSG_LIVE = "Ändringar från den andra telefonen visas inte direkt just nu. Det ni sparar sparas ändå.";
let refreshing = null, liveTimer = null, liveStarted = false;
async function refresh() {
  if (ui.phase !== "app") return;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      mergeAll(await store.loadAll());
      if (ui.status === MSG_STALE || ui.status === "Hämtar hushållets data…") { ui.status = null; render() }
    } catch (e) {
      if (isAuth(e)) { store.signOut(); return }
      ui.status = MSG_STALE; render();
    } finally { refreshing = null }
  })();
  return refreshing;
}
function onLiveStatus(s) {
  if (s === "SUBSCRIBED") {
    clearTimeout(liveTimer); liveTimer = null;
    if (ui.status === MSG_LIVE) { ui.status = null; render() }
    refresh(); // fångar upp det som hände medan anslutningen var nere
  } else if (!liveTimer) {
    liveTimer = setTimeout(() => { liveTimer = null; if (!ui.status) { ui.status = MSG_LIVE; render() } }, 15000);
  }
}
async function connect() {
  ui.phase = "app";
  if (!loadCache()) ui.status = "Hämtar hushållets data…";
  render();
  if (!liveStarted) { liveStarted = true; store.live(onRow, onDel, onLiveStatus) }
  await refresh();
}
function signedOut() {
  ui.phase = "login"; ui.status = null; pending.clear();
  COLS.forEach(c => data[c] = []); lsDel(CACHE_KEY);
  closeSheet(); render();
  location.reload(); // nollställer realtidskanalen så nästa inloggning börjar rent
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh() });
window.addEventListener("online", () => refresh());

/* ---------- Start ---------- */
render();
(async () => {
  if (!DEMO && !(CFG.supabaseUrl && CFG.supabaseKey && CFG.householdEmail && window.supabase)) { ui.phase = "setup"; render(); return }
  store.init();
  store.onSignOut(() => { if (ui.phase === "app") signedOut() });
  let s = null; try { s = await store.session() } catch (e) {}
  if (!s) { ui.phase = "login"; render(); return }
  await connect();
})();
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
