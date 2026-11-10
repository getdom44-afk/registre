"use strict";
/* Registre — interface. Aucune dépendance. */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const iso = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const todayIso = () => iso(new Date());
const fmtDate = s => s ? s.slice(8, 10) + "/" + s.slice(5, 7) + "/" + s.slice(0, 4) : "";
const nf = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = c => (c < 0 ? "-" : "") + nf.format(Math.abs(c) / 100) + " €";
const plain = c => nf.format(Math.abs(c) / 100);
const cls = c => c < 0 ? "neg" : "";
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
function parseAmount(str) {
  let s = String(str || "").replace(/[\s €]/g, "").replace("−", "-");
  if (!s) return NaN;
  const lc = s.lastIndexOf(","), ld = s.lastIndexOf(".");
  if (lc > -1 && ld > -1) s = lc > ld ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (lc > -1) s = s.replace(",", ".");
  const v = Number(s);
  return isFinite(v) ? Math.round(v * 100) : NaN;
}
const UNITS = { d: ["jour", "jours"], w: ["semaine", "semaines"], m: ["mois", "mois"], y: ["an", "ans"] };
function freqLabel(unit, every) {
  if (every === 1) return { d: "Quotidienne", w: "Hebdomadaire", m: "Mensuelle", y: "Annuelle" }[unit];
  if (unit === "m" && every === 3) return "Trimestrielle";
  if (unit === "m" && every === 6) return "Semestrielle";
  return "Tous les " + every + " " + UNITS[unit][1];
}

/* ---------- API ---------- */
async function api(method, path, body) {
  const r = await fetch(path, {
    method, credentials: "same-origin",
    headers: { "X-Registre": "1", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await r.json(); } catch (e) {}
  if (r.status === 401 && !path.startsWith("/api/login")) { showLogin(false); throw new Error((data && data.error) || "Session expirée"); }
  if (!r.ok) throw new Error((data && data.error) || "Erreur " + r.status);
  return data;
}
let toastT;
function toast(t) { const el = $("#toast"); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 3200); }
const fail = e => toast(e.message || String(e));

/* ---------- état ---------- */
const S = {
  accounts: [], cur: null, ops: [], schedules: [], lists: { categories: [], tiers: [], modes: [] }, settings: { horizon: 7 },
  sel: null, selSet: new Set(), anchor: null, edit: null, period: "12m", search: "", points: { changes: 0, last: null, points: [] }
};
try { S.cur = Number(localStorage.getItem("registre.cur")) || null; S.period = localStorage.getItem("registre.period") || "12m"; } catch (e) {}
const acc = id => S.accounts.find(a => a.id === id);
const curAcc = () => acc(S.cur);

/* ---------- connexion ---------- */
let setupMode = false;
async function boot() {
  let a;
  try { a = await api("GET", "/api/auth"); } catch (e) { toast("Le serveur ne répond pas"); return; }
  S.version = a.version;
  if (!a.logged) return showLogin(a.setup);
  await startApp();
}
function showLogin(setup) {
  setupMode = !!setup;
  $("#app").hidden = true; $("#login").hidden = false;
  $("#loginIntro").textContent = setup ? "Bienvenue. Choisissez le mot de passe qui protégera vos comptes (8 caractères minimum)." : "Entrez votre mot de passe pour ouvrir vos comptes.";
  $("#loginPw2Row").hidden = !setup; $("#loginPw").autocomplete = setup ? "new-password" : "current-password";
  $("#loginBtn").textContent = setup ? "Créer et ouvrir" : "Ouvrir";
  $("#loginErr").hidden = true; $("#loginPw").value = ""; $("#loginPw2").value = "";
  setTimeout(() => $("#loginPw").focus(), 30);
}
$("#loginForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const pw = $("#loginPw").value, err = $("#loginErr");
  err.hidden = true;
  if (setupMode && pw !== $("#loginPw2").value) { err.textContent = "Les deux mots de passe ne sont pas identiques."; err.hidden = false; return; }
  $("#loginBtn").disabled = true;
  try { await api("POST", setupMode ? "/api/setup" : "/api/login", { password: pw }); await startApp(); }
  catch (e) { err.textContent = e.message; err.hidden = false; }
  finally { $("#loginBtn").disabled = false; }
});
async function startApp() {
  $("#login").hidden = true; $("#app").hidden = false;
  $("#period").value = S.period;
  await Promise.all([loadAccounts(), loadSchedules(), loadLists(), loadPoints(), api("GET", "/api/settings").then(s => { S.settings = s; })]);
  if (!curAcc()) S.cur = (S.accounts.find(a => norm(a.name) === "ccp") || S.accounts.find(a => !a.closed) || {}).id || null;
  await loadOps(true);
  resetEntry();
  if (!S.accounts.length) openImport();
}

/* ---------- chargements ---------- */
async function loadAccounts() { S.accounts = await api("GET", "/api/accounts"); renderTree(); renderStatus(); }
async function loadSchedules() { S.schedules = await api("GET", "/api/schedules"); renderDueBadge(); }
async function loadLists() {
  S.lists = await api("GET", "/api/lists");
  $("#dlModes").innerHTML = S.lists.modes.map(m => `<option value="${esc(m)}">`).join("");
  $("#dlTiers").innerHTML = S.lists.tiers.map(t => `<option value="${esc(t.tiers)}">`).join("");
  // dlCats / dlSubs : catégories actives (saisie d'une nouvelle opération ou échéance) ;
  // dlCatsAll / dlSubsAll : toutes, archivées comprises (modification, classement, déplacement).
  const cats = new Map();
  for (const c of S.lists.categories) cats.set(c.category, !!c.cat_archived);
  $("#dlCats").innerHTML = [...cats].filter(([, a]) => !a).map(([c]) => `<option value="${esc(c)}">`).join("");
  $("#dlCatsAll").innerHTML = [...cats].map(([c, a]) => `<option value="${esc(c)}"${a ? ' label="archivée"' : ""}>`).join("");
  fillSubs("");
}
function isArchived(cat, sub) {
  return (S.lists.categories || []).some(c => norm(c.category) === norm(cat) && (c.cat_archived || (sub && norm(c.subcategory) === norm(sub) && c.archived)));
}
function fillSubs(cat) {
  const all = new Map();
  for (const c of S.lists.categories) if (c.subcategory && (!cat || norm(c.category) === norm(cat))) all.set(c.subcategory, (all.get(c.subcategory) ?? true) && !!c.archived);
  $("#dlSubs").innerHTML = [...all].filter(([, a]) => !a).map(([s]) => `<option value="${esc(s)}">`).join("");
  $("#dlSubsAll").innerHTML = [...all].map(([s, a]) => `<option value="${esc(s)}"${a ? ' label="archivée"' : ""}>`).join("");
}
function entryLists(all) {
  $("#fCat").setAttribute("list", all ? "dlCatsAll" : "dlCats");
  $("#fSc").setAttribute("list", all ? "dlSubsAll" : "dlSubs");
}
async function loadOps(scrollEnd) {
  try { localStorage.setItem("registre.cur", S.cur || ""); localStorage.setItem("registre.period", S.period); } catch (e) {}
  if (!S.cur) { S.ops = []; renderGrid(); return; }
  const qs = new URLSearchParams({ period: S.period, q: S.search });
  S.ops = await api("GET", `/api/accounts/${S.cur}/operations?${qs}`);
  renderHead(); renderGrid(); renderStatus();
  if (scrollEnd) $("#gridwrap").scrollTop = 0;
}
async function refresh(opts = {}) {
  await Promise.all([loadAccounts(), loadSchedules(), loadPoints(), opts.lists ? loadLists() : null]);
  await loadOps(opts.scrollEnd);
}

/* ---------- arborescence des comptes ---------- */
const iconHtml = (a, big) => a && a.icon ? `<img class="acc-icon${big ? " big" : ""}" src="${esc(a.icon)}" alt="">` : `<span class="acc-icon none"></span>`;
function renderTree() {
  let html = "";
  const fams = [...new Map(S.accounts.filter(a => !a.closed).map(a => [a.family_id, a.family_name || "Autres comptes"])).entries()];
  for (const [fid, label] of fams) {
    const list = S.accounts.filter(a => a.family_id === fid && !a.closed);
    if (!list.length) continue;
    const tot = list.reduce((s, a) => s + a.today_balance, 0);
    html += `<div class="grp"><div class="grp-h"><span>${esc(label)}</span></div>` +
      list.map(a => `<button class="acc ${a.id === S.cur ? "sel" : ""}" data-id="${a.id}" title="${esc(a.name)} : ${a.n} opérations · prévu au ${fmtDate(a.cycle_end)} : ${eur(a.forecast)}">
        <span class="nm">${iconHtml(a)}<span>${esc(a.name)}</span></span>
        <span class="num ${cls(a.today_balance)}">${eur(a.today_balance)}</span></button>`).join("") +
      `<div class="grp-total"><span>Total</span><span class="num ${cls(tot)}">${eur(tot)}</span></div></div>`;
  }
  const closed = S.accounts.filter(a => a.closed);
  if (closed.length) html += `<div class="grp"><div class="grp-h"><span>Clôturés</span></div>` + closed.map(a => `<button class="acc closed ${a.id === S.cur ? "sel" : ""}" data-id="${a.id}"><span class="nm">${iconHtml(a)}<span>${esc(a.name)}</span></span><span class="num">${eur(a.today_balance)}</span></button>`).join("") + `</div>`;
  if (!S.accounts.length) html = `<p class="muted side-empty">Aucun compte. Ouvrez « Paramètres » pour importer vos données ou créer un compte.</p>`;
  $("#accountTree").innerHTML = html;
  renderSideFc();
}
function renderSideFc() {
  // Prévision affichée pour le compte principal : celui qui a une fin de cycle (CCP, le 19), sinon le CCP.
  const a = S.accounts.find(x => !x.closed && x.cycle_day) || S.accounts.find(x => norm(x.name) === "ccp");
  $("#sideFc").innerHTML = !a ? "" : `<div class="side-fc-h">Prévision fin de mois · ${esc(a.name)}</div>
    <div class="big-fc"><span>au ${fmtDate(a.cycle_end)}</span><span class="num ${cls(a.forecast)}">${eur(a.forecast)}</span></div>
    <div class="fc-sub">${a.forecast_count ? a.forecast_count + " échéance" + (a.forecast_count > 1 ? "s" : "") + " d'ici là" : "Aucune échéance d'ici là"}${a.forecast_low < Math.min(a.forecast, a.today_balance) ? ` · point bas ${eur(a.forecast_low)} le ${fmtDate(a.forecast_low_date).slice(0, 5)}` : ""}</div>`;
  $("#sideFc").dataset.acc = a ? a.id : "";
}
$("#sideFc").addEventListener("click", () => { const id = Number($("#sideFc").dataset.acc); if (id) { S.cur = id; renderTree(); loadOps(true).catch(fail); } openFc(); });
$("#accountTree").addEventListener("click", async ev => {
  const b = ev.target.closest(".acc"); if (!b) return;
  S.cur = Number(b.dataset.id); S.sel = null; S.selSet.clear(); resetEntry(); renderTree();
  await loadOps(true).catch(fail);
});

/* ---------- grille ---------- */
function renderHead() {
  const a = curAcc();
  const cb = $("#classBadge"); cb.textContent = a ? a.unclassified : 0; cb.hidden = !(a && a.unclassified);
  $("#accTitle").textContent = a ? a.name : "Aucun compte";
  const ic = $("#accIcon"); if (a && a.icon) { ic.src = a.icon; ic.hidden = false; } else ic.hidden = true;
  $("#accSub").textContent = a ? `${a.n} opérations · solde de départ ${eur(a.initial)}` : "";
}
function upcomingFor(id) {
  const lim = new Date(); lim.setDate(lim.getDate() + Number(S.settings.horizon ?? 7));
  const l = iso(lim);
  return S.schedules.filter(s => (s.account_id === id || s.to_account_id === id) && s.next_date <= l);
}
function opRow(o) {
  const t = todayIso(), x = o.transfer_account ? ` <span class="xfer" title="Virement interne">⇄</span>` : "";
  const c = ["op", o.pointage === "-" ? "pt-no" : "pt-ok", o.date > t ? "future" : "", o.pointage === "R" ? "rec" : "", S.selSet.has(o.id) ? "sel" : "", o.id === S.edit ? "editing" : ""].join(" ");
  return `<tr class="${c}" data-id="${o.id}">
    <td class="pt ${o.pointage}" title="${o.pointage === "R" ? "Rapprochée" : o.pointage === "P" ? "Pointée : cliquez pour dépointer" : "Cliquez pour pointer"}">${o.pointage === "-" ? "" : o.pointage}</td>
    <td class="num">${fmtDate(o.date)}</td>
    <td title="${esc(o.mode)}">${esc(o.mode)}</td>
    <td class="lib" title="${esc([o.tiers, o.details].filter(Boolean).join(" · "))}">${esc(o.tiers)}${o.details ? `<span class="det">${esc(o.details)}</span>` : ""}${x}</td>
    <td title="${esc(o.category)}">${esc(o.category)}</td>
    <td title="${esc(o.subcategory)}">${esc(o.subcategory)}</td>
    <td class="r num deb">${o.amount < 0 ? plain(o.amount) : ""}</td>
    <td class="r num cre">${o.amount > 0 ? plain(o.amount) : ""}</td>
    <td class="r num sol ${cls(o.solde)}">${S.search ? "" : eur(o.solde)}</td>
  </tr>`;
}
function renderGrid() {
  const body = $("#gridBody");
  if (!S.cur) { body.innerHTML = `<tr class="empty"><td colspan="9">Aucun compte. Cliquez sur « Importer » pour reprendre vos données Bank Perfect, ou créez un compte dans « Paramètres ».</td></tr>`; return; }
  let html = "";
  const up = S.search ? [] : upcomingFor(S.cur);
  if (up.length) {
    const t = todayIso();
    html += `<tr class="sep-up"><td colspan="9">Échéances à valider</td></tr>` + up.slice().reverse().map(s => {
      const amt = s.account_id === S.cur ? s.amount : -s.amount;
      const tiers = s.to_account_id ? (s.account_id === S.cur ? "Vers " + s.to_account_name : "Depuis " + s.account_name) + " · " + s.tiers : s.tiers;
      return `<tr class="up" data-sid="${s.id}">
        <td class="pt">${s.next_date < t ? "!" : ""}</td><td class="num">${fmtDate(s.next_date)}</td><td>${esc(s.mode)}</td>
        <td class="lib" title="${esc(tiers)}"><span class="up-acts">${s.account_id === S.cur ? `<button class="btn mini primary" data-act="val">Valider</button><button class="btn mini" data-act="skip">Sauter</button>` : `<span class="muted">sur ${esc(s.account_name)}</span>`}</span> ${esc(tiers)}</td>
        <td>${esc(s.category)}</td><td>${esc(s.subcategory)}</td>
        <td class="r num deb">${amt < 0 ? plain(amt) : ""}</td><td class="r num cre">${amt > 0 ? plain(amt) : ""}</td><td></td></tr>`;
    }).join("") + `<tr class="sep-up"><td colspan="9">Opérations</td></tr>`;
  }
  html += S.ops.length ? S.ops.slice().reverse().map(opRow).join("") :
    `<tr class="empty"><td colspan="9">${S.search ? "Aucune opération ne correspond à « " + esc(S.search) + " »." : "Aucune opération sur cette période."}</td></tr>`;
  body.innerHTML = html;
  const present = new Set(S.ops.map(o => o.id));
  for (const id of [...S.selSet]) if (!present.has(id)) S.selSet.delete(id);
  if (S.sel && !present.has(S.sel)) S.sel = null;
}
/* Sélection : clic = une ligne ; Ctrl+clic = ajouter / retirer ; Maj+clic (ou Maj+flèches) = plage ; Ctrl+A = tout. */
const displayIds = () => S.ops.map(o => o.id).reverse();
function selRow(id, scroll, mode) {
  if (mode === "toggle") { S.selSet.has(id) ? S.selSet.delete(id) : S.selSet.add(id); S.anchor = id; }
  else if (mode === "range" && S.anchor != null) {
    const ids = displayIds(), a = ids.indexOf(S.anchor), b = ids.indexOf(id);
    S.selSet = new Set(a < 0 || b < 0 ? [id] : ids.slice(Math.min(a, b), Math.max(a, b) + 1));
  }
  else { S.selSet = new Set([id]); S.anchor = id; }
  S.sel = S.selSet.has(id) ? id : (S.selSet.size ? [...S.selSet].pop() : null);
  paintSel();
  const tr = $(`#gridBody tr[data-id="${id}"]`);
  if (tr && scroll) tr.scrollIntoView({ block: "nearest" });
}
function selectAll() { S.selSet = new Set(S.ops.map(o => o.id)); paintSel(); }
function clearSel() { S.selSet.clear(); S.sel = null; S.anchor = null; paintSel(); }
function paintSel() {
  $$("#gridBody tr.op").forEach(r => r.classList.toggle("sel", S.selSet.has(Number(r.dataset.id))));
  renderStatus();
}
const selectedOps = () => S.ops.filter(o => S.selSet.has(o.id));
$("#gridBody").addEventListener("click", async ev => {
  const up = ev.target.closest("tr.up");
  if (up) {
    const act = ev.target.dataset.act; if (!act) return;
    const sid = Number(up.dataset.sid);
    try {
      if (act === "val") { const s = S.schedules.find(x => x.id === sid); await api("POST", `/api/schedules/${sid}/validate`, {}); toast(`${s.tiers} validée`); }
      else { await api("POST", `/api/schedules/${sid}/skip`, {}); toast("Échéance sautée"); }
      await refresh();
    } catch (e) { fail(e); }
    return;
  }
  const tr = ev.target.closest("tr.op"); if (!tr) return;
  const id = Number(tr.dataset.id);
  if (ev.ctrlKey || ev.metaKey) { selRow(id, false, "toggle"); return; }
  if (ev.shiftKey) { selRow(id, false, "range"); return; }
  if (ev.target.closest("td.pt") && S.selSet.size > 1 && S.selSet.has(id)) { await pointSelected(); return; }
  selRow(id);
  if (ev.target.closest("td.pt")) await togglePoint(id);
});
$("#gridBody").addEventListener("mousedown", ev => { if (ev.shiftKey && ev.target.closest("tr.op")) ev.preventDefault(); });
$("#gridBody").addEventListener("dblclick", ev => { const tr = ev.target.closest("tr.op"); if (tr && !ev.target.closest("td.pt")) startEdit(Number(tr.dataset.id)); });

async function togglePoint(id) {
  const o = S.ops.find(x => x.id === id); if (!o) return;
  if (o.pointage === "R") { toast("Opération déjà rapprochée : elle n'est plus modifiable par pointage."); return; }
  const p = o.pointage === "P" ? "-" : "P";
  try {
    await api("PUT", `/api/operations/${id}`, { pointage: p });
    o.pointage = p;
    const row = $(`#gridBody tr[data-id="${id}"]`);
    if (row) { const td = row.querySelector("td.pt"); td.className = "pt " + p; td.textContent = p === "-" ? "" : p; row.classList.toggle("pt-ok", p !== "-"); row.classList.toggle("pt-no", p === "-"); }
    await Promise.all([loadAccounts(), loadPoints()]);
  } catch (e) { fail(e); }
}
async function pointSelected() {
  const sel = selectedOps().filter(o => o.pointage !== "R");
  if (!sel.length) { toast(S.selSet.size ? "Opérations déjà rapprochées" : "Sélectionnez d'abord une opération"); return; }
  if (sel.length === 1 && S.selSet.size === 1) return togglePoint(sel[0].id);
  const p = sel.some(o => o.pointage === "-") ? "P" : "-";
  try {
    const r = await api("POST", "/api/operations/bulk", { ids: sel.map(o => o.id), pointage: p });
    toast(`${r.updated} opération${r.updated > 1 ? "s" : ""} ${p === "P" ? "pointée" : "dépointée"}${r.updated > 1 ? "s" : ""}`);
    await refresh();
  } catch (e) { fail(e); }
}
async function deleteSelected() {
  const many = selectedOps();
  if (many.length > 1) {
    const tot = many.reduce((t, o) => t + o.amount, 0);
    if (!(await confirmBox("Supprimer les opérations", `Supprimer les ${many.length} opérations sélectionnées (total ${eur(tot)}) ? Les virements correspondants sur les autres comptes seront aussi supprimés.`))) return;
    try {
      for (const o of many) { try { await api("DELETE", `/api/operations/${o.id}`); } catch (e) { if (!/introuvable/i.test(e.message)) throw e; } }
      clearSel(); resetEntry(); toast(`${many.length} opérations supprimées`); await refresh();
    } catch (e) { fail(e); await refresh(); }
    return;
  }
  const o = S.ops.find(x => x.id === S.sel); if (!o) { toast("Sélectionnez d'abord une opération"); return; }
  const ok = await confirmBox("Supprimer l'opération", `Supprimer « ${o.tiers || o.details || "sans libellé"} » du ${fmtDate(o.date)} (${eur(o.amount)}) ?${o.transfer_account ? " Le virement correspondant sur " + (acc(o.transfer_account) || {}).name + " sera aussi supprimé." : ""}`);
  if (!ok) return;
  try { await api("DELETE", `/api/operations/${o.id}`); clearSel(); if (S.edit === o.id) resetEntry(); toast("Opération supprimée"); await refresh(); } catch (e) { fail(e); }
}

/* ---------- changer la catégorie des opérations sélectionnées ---------- */
function openMove() {
  const sel = selectedOps();
  if (!sel.length) { toast("Sélectionnez d'abord une ou plusieurs opérations (Ctrl+clic, Maj+clic)"); return; }
  const tot = sel.reduce((t, o) => t + o.amount, 0);
  $("#mvIntro").innerHTML = `<b>${sel.length}</b> opération${sel.length > 1 ? "s" : ""} sélectionnée${sel.length > 1 ? "s" : ""} · total <b class="num ${cls(tot)}">${eur(tot)}</b>`;
  const cats = [...new Set(sel.map(o => o.category))], subs = [...new Set(sel.map(o => o.subcategory))];
  $("#mvCat").value = cats.length === 1 ? cats[0] : ""; $("#mvSub").value = cats.length === 1 && subs.length === 1 ? subs[0] : "";
  $("#mvNow").textContent = cats.length === 1 ? `Actuellement : ${cats[0] || "sans catégorie"}${cats[0] && subs.length === 1 && subs[0] ? " › " + subs[0] : subs.length > 1 ? " (plusieurs sous-catégories)" : ""}` : `Actuellement : ${cats.length} catégories différentes`;
  fillSubs($("#mvCat").value); moveHint();
  $("#dlgMove").showModal(); $("#mvCat").focus(); $("#mvCat").select();
}
function moveHint() {
  const c = $("#mvCat").value.trim(), sc = $("#mvSub").value.trim();
  $("#mvArch").hidden = !(c && isArchived(c, sc));
}
$("#mvCat").addEventListener("change", () => { fillSubs($("#mvCat").value); moveHint(); });
$("#mvCat").addEventListener("input", moveHint);
$("#mvSub").addEventListener("input", moveHint);
$("#mvSub").addEventListener("focus", () => fillSubs($("#mvCat").value));
$("#mvForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const c = $("#mvCat").value.trim(), sc = $("#mvSub").value.trim();
  if (!c && sc) { toast("Indiquez la catégorie"); $("#mvCat").focus(); return; }
  try {
    const r = await api("POST", "/api/operations/bulk", { ids: [...S.selSet], category: c, subcategory: sc });
    $("#dlgMove").close();
    toast(`${r.updated} opération${r.updated > 1 ? "s" : ""} ${c ? "classée" + (r.updated > 1 ? "s" : "") + " dans « " + c + (sc ? " › " + sc : "") + " »" : "remise" + (r.updated > 1 ? "s" : "") + " à classer"}`);
    await refresh({ lists: true });
  } catch (e) { fail(e); }
});

/* ---------- saisie ---------- */
function fillToSelect(sel, exclude, value) {
  sel.innerHTML = `<option value="">—</option>` + S.accounts.filter(a => a.id !== exclude && !a.closed).map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  sel.value = value || "";
}
function resetEntry() {
  S.edit = null;
  $("#entry").reset(); $("#entry").classList.remove("editing");
  $("#entryTitle").textContent = "Nouvelle opération"; entryLists(false);
  $("#fSubmit").textContent = "Ajouter";
  $("#fDate").value = todayIso();
  fillToSelect($("#fTo"), S.cur); $("#fTo").disabled = false;
  $$("#gridBody tr.editing").forEach(r => r.classList.remove("editing"));
}
function startEdit(id) {
  const o = S.ops.find(x => x.id === id); if (!o) return;
  S.edit = id; selRow(id);
  $$("#gridBody tr.editing").forEach(r => r.classList.remove("editing"));
  $(`#gridBody tr[data-id="${id}"]`)?.classList.add("editing");
  $("#entry").classList.add("editing");
  $("#entryTitle").textContent = "Modifier l'opération du " + fmtDate(o.date); entryLists(true);
  $("#fSubmit").textContent = "Enregistrer";
  $("#fDate").value = o.date; $("#fMode").value = o.mode; $("#fTiers").value = o.tiers; $("#fDet").value = o.details;
  $("#fCat").value = o.category; $("#fSc").value = o.subcategory; fillSubs(o.category);
  $("#fDeb").value = o.amount < 0 ? plain(o.amount) : ""; $("#fCre").value = o.amount > 0 ? plain(o.amount) : "";
  fillToSelect($("#fTo"), S.cur, o.transfer_account || ""); $("#fTo").disabled = true;
  $("#fTiers").focus();
}
$("#fTiers").addEventListener("change", () => {
  if (S.edit) return;
  const t = S.lists.tiers.find(x => norm(x.tiers) === norm($("#fTiers").value)); if (!t) return;
  if (!$("#fCat").value && t.category && !isArchived(t.category, t.subcategory)) { $("#fCat").value = t.category; if (!$("#fSc").value) $("#fSc").value = t.subcategory || ""; }
  if (!$("#fMode").value) $("#fMode").value = t.mode || "";
  fillSubs($("#fCat").value);
});
$("#fCat").addEventListener("change", () => fillSubs($("#fCat").value));
$("#fDeb").addEventListener("input", () => { if ($("#fDeb").value) $("#fCre").value = ""; });
$("#fCre").addEventListener("input", () => { if ($("#fCre").value) $("#fDeb").value = ""; });
$("#fCancel").addEventListener("click", resetEntry);
$("#entry").addEventListener("submit", async ev => {
  ev.preventDefault();
  if (!S.cur) { toast("Créez ou importez d'abord un compte"); return; }
  const deb = parseAmount($("#fDeb").value), cre = parseAmount($("#fCre").value);
  const amount = !isNaN(deb) && deb ? -Math.abs(deb) : !isNaN(cre) && cre ? Math.abs(cre) : NaN;
  if (isNaN(amount)) { toast("Indiquez un montant au débit ou au crédit"); $("#fDeb").focus(); return; }
  const body = { date: $("#fDate").value, mode: $("#fMode").value, tiers: $("#fTiers").value, details: $("#fDet").value, category: $("#fCat").value, subcategory: $("#fSc").value, amount };
  try {
    if (S.edit) { await api("PUT", `/api/operations/${S.edit}`, body); toast("Opération modifiée"); resetEntry(); await refresh({ lists: true }); }
    else {
      const to = $("#fTo").value;
      const r = await api("POST", `/api/accounts/${S.cur}/operations`, Object.assign(body, { pointage: "-", to_account_id: to || null }));
      toast(to ? "Virement enregistré sur les deux comptes" : "Opération ajoutée");
      const keepDate = $("#fDate").value; resetEntry(); $("#fDate").value = keepDate;
      await refresh({ lists: true }); selRow(r.id, true); $("#fTiers").focus();
    }
  } catch (e) { fail(e); }
});

/* ---------- barre d'état ---------- */
function renderStatus() {
  const a = curAcc();
  if (!a) { $("#status").innerHTML = ""; return; }
  $("#status").innerHTML =
    `<span>Solde au ${fmtDate(todayIso())} : <b class="num ${cls(a.today_balance)}">${eur(a.today_balance)}</b></span>` +
    (a.future ? `<span>Solde final : <b class="num ${cls(a.balance)}">${eur(a.balance)}</b></span>` : "") +
    `<span><i class="sw ok"></i>Pointé : <b class="num ${cls(a.pointed)}">${eur(a.pointed)}</b></span>` +
    `<span><i class="sw no"></i>${a.unpointed} non pointée${a.unpointed > 1 ? "s" : ""}</span>` +
    `<span>Prévu au ${fmtDate(a.cycle_end)}${a.cycle_day ? " (fin de cycle)" : ""} : <b class="num ${cls(a.forecast)}">${eur(a.forecast)}</b>${a.forecast_low < a.forecast ? ` · point bas <b class="num ${cls(a.forecast_low)}">${eur(a.forecast_low)}</b> le ${fmtDate(a.forecast_low_date).slice(0, 5)}` : ""}</span>` +
    (S.selSet.size > 1 ? `<span class="selinfo"><b>${S.selSet.size}</b> sélectionnées · total <b class="num ${cls(selectedOps().reduce((t, o) => t + o.amount, 0))}">${eur(selectedOps().reduce((t, o) => t + o.amount, 0))}</b></span>`
      : `<span>${S.ops.length} affichée${S.ops.length > 1 ? "s" : ""}</span>`) +
    `<span class="grow"></span>` +
    (S.points.changes ? `<span class="unsaved">${S.points.changes} modification${S.points.changes > 1 ? "s" : ""} non sauvegardée${S.points.changes > 1 ? "s" : ""} · <button class="linkbtn" id="stRevert">Annuler</button></span>`
      : `<span class="saved">${S.points.last ? "Sauvegardé le " + fmtDate(S.points.last.slice(0, 10)) + " à " + S.points.last.slice(11, 16) : "Aucun point de sauvegarde"}</span>`);
}
$("#status").addEventListener("click", ev => { if (ev.target.id === "stRevert") revertChanges(); });

/* ---------- Sauvegarder (point de sauvegarde) ---------- */
async function loadPoints() {
  try { S.points = await api("GET", "/api/points"); } catch (e) { return; }
  const b = $("#saveBadge"); b.textContent = S.points.changes; b.hidden = !S.points.changes;
  $("#tbSave").classList.toggle("dirty", !!S.points.changes);
  renderStatus();
}
async function saveNow() {
  try {
    S.points = await api("POST", "/api/points", {});
    toast("Sauvegardé : point de sauvegarde du " + fmtDate(S.points.last.slice(0, 10)) + " à " + S.points.last.slice(11, 16));
    await loadPoints(); if ($("#dlgSettings").open) renderPoints();
  } catch (e) { fail(e); }
}
async function revertChanges(name) {
  const pt = name ? S.points.points.find(p => p.name === name) : S.points.points[0];
  if (!pt) { toast("Aucun point de sauvegarde : cliquez d'abord sur « Sauvegarder »"); return; }
  const n = S.points.changes;
  const txt = name ? `Revenir au point de sauvegarde du ${fmtDate(pt.when.slice(0, 10))} à ${pt.when.slice(11, 16)} ? Tout ce qui a été saisi, modifié ou supprimé depuis sera annulé.`
    : `Annuler ${n ? "les " + n + " modification" + (n > 1 ? "s" : "") : "les modifications"} faite${n > 1 ? "s" : ""} depuis la dernière sauvegarde (${fmtDate(pt.when.slice(0, 10))} à ${pt.when.slice(11, 16)}) ?`;
  if (!(await confirmBox(name ? "Revenir à un point de sauvegarde" : "Annuler les modifications", txt))) return;
  try {
    await api("POST", "/api/points/revert", { name: pt.name });
    toast("Données revenues au " + fmtDate(pt.when.slice(0, 10)) + " à " + pt.when.slice(11, 16));
    resetEntry(); await refresh({ lists: true, scrollEnd: true }); if ($("#dlgSettings").open) { renderAccTable(); renderPoints(); }
  } catch (e) { fail(e); }
}

/* ---------- Sauvegarde Cloud ---------- */
let cloudPoll = null;
async function cloudNow() {
  const btn = $("#tbCloud"); btn.disabled = true;
  try {
    const before = await api("POST", "/api/cloud", {});
    const prev = before.cloud ? before.cloud.when : null;
    toast("Copie faite. Envoi vers OneDrive en cours…");
    let tries = 0;
    clearInterval(cloudPoll);
    cloudPoll = setInterval(async () => {
      tries++;
      let st; try { st = await api("GET", "/api/backup/status"); } catch (e) { return; }
      const c = st.cloud;
      if (c && !c.pending && c.when !== prev) {
        clearInterval(cloudPoll); btn.disabled = false;
        toast(c.ok ? "Sauvegarde envoyée sur OneDrive (" + c.when.slice(11, 16) + ")" : "Échec de l'envoi sur OneDrive : " + c.detail);
        if ($("#dlgSettings").open) renderBackup();
      } else if (tries >= 18) {
        clearInterval(cloudPoll); btn.disabled = false;
        toast(c && /configur/.test(c.detail || "") ? "OneDrive n'est pas encore configuré : la copie est prête sur le serveur." :
          "Copie prête sur le serveur. Elle partira sur OneDrive au prochain envoi automatique (dans l'heure).");
      }
    }, 5000);
  } catch (e) { btn.disabled = false; fail(e); }
}

/* ---------- échéances ---------- */
function dueAll() {
  const lim = new Date(); lim.setDate(lim.getDate() + Number(S.settings.horizon ?? 7));
  const l = iso(lim);
  return S.schedules.filter(s => s.next_date <= l);
}
function renderDueBadge() { const n = dueAll().length, b = $("#dueBadge"); b.textContent = n; b.hidden = !n; }

/* ---------- échéancier ---------- */
let schedEdit = null;
function openSched() {
  fillAccSelect($("#sAcc"), S.cur); fillToSelect($("#sTo"), Number($("#sAcc").value));
  const f = $("#schedFilter"); f.innerHTML = `<option value="">Tous les comptes</option>` + S.accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  f.value = "";
  resetSched(); $("#schedForm").hidden = true; renderSched(); $("#dlgSched").showModal();
}
function fillAccSelect(sel, value) { sel.innerHTML = S.accounts.filter(a => !a.closed).map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join(""); if (value) sel.value = value; }
function resetSched() {
  schedEdit = null; $("#schedForm").reset(); $("#sEvery").value = 1; $("#sUnit").value = "m"; $("#sNext").value = todayIso();
  if (S.cur) $("#sAcc").value = S.cur;
  fillToSelect($("#sTo"), Number($("#sAcc").value));
  $("#schedFormTitle").textContent = "Nouvelle échéance"; $("#sSubmit").textContent = "Ajouter";
}
function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); }
function renderSched() {
  const f = Number($("#schedFilter").value) || null, t = todayIso(), view = $("#schedView").value;
  const dueLim = addDays(Number(S.settings.horizon ?? 7)), lim = view === "all" ? "9999" : addDays(Number(view));
  const all = S.schedules.filter(s => !f || s.account_id === f || s.to_account_id === f);
  const list = all.filter(s => s.next_date <= lim);
  let rec = 0, dep = 0;
  all.forEach(s => { const v = (f && s.account_id !== f) ? -s.per_month : s.per_month; if (v > 0) rec += v; else dep += v; });
  $("#schedTotals").innerHTML = all.length ? `${all.length} échéance${all.length > 1 ? "s" : ""} · par mois en moyenne : entrées <b class="num pos">${eur(rec)}</b>, sorties <b class="num neg">${eur(-dep)}</b>` : "";
  const due = list.filter(s => s.next_date <= dueLim).length;
  $("#schedIntro").innerHTML = !S.schedules.length ? "" : due
    ? `<b>${due} échéance${due > 1 ? "s" : ""} à valider</b> (échues ou dans les ${S.settings.horizon} jours) : ajustez la date ou le montant si besoin, puis cliquez sur Valider.`
    : `Rien à valider pour le moment.`;
  if (!S.schedules.length) {
    $("#schedTable").innerHTML = `<tbody><tr><td class="empty">Aucune échéance enregistrée.<br><br>Pour reprendre celles de Bank Perfect : Paramètres › Importer / Exporter › Importer des fichiers, rubrique « L'échéancier ».<br><br>
      <button class="btn primary" id="schedGoImport">Importer l'échéancier Bank Perfect</button> <button class="btn" id="schedGoNew">Créer une échéance</button></td></tr></tbody>`;
    return;
  }
  $("#schedTable").innerHTML = `<thead><tr><th>Date</th><th>Compte</th><th>Tiers</th><th>Catégorie</th><th>Fréquence</th><th>Fin</th><th class="r">Montant</th><th></th></tr></thead><tbody>` +
    (list.length ? list.map(s => {
      const isDue = s.next_date <= dueLim, late = s.next_date < t;
      return `<tr data-sid="${s.id}" class="${s.id === schedEdit ? "editing" : ""} ${isDue ? "due" : ""} ${late ? "late" : ""}">
      <td class="num">${isDue ? `<input type="date" value="${s.next_date}" data-f="date" aria-label="Date de l'opération">${late ? `<div class="neg small">en retard</div>` : ""}` : fmtDate(s.next_date)}</td>
      <td>${esc(s.account_name)}${s.to_account_name ? " → " + esc(s.to_account_name) : ""}</td>
      <td>${esc(s.tiers)}${s.details ? ` <span class="muted">· ${esc(s.details)}</span>` : ""}</td>
      <td>${esc([s.category, s.subcategory].filter(Boolean).join(" / "))}</td>
      <td>${freqLabel(s.unit, s.every)}</td>
      <td class="num">${fmtDate(s.end_date)}</td>
      <td class="r num ${s.amount < 0 ? "neg" : "pos"}">${isDue ? `<input class="amt" value="${(s.amount < 0 ? "-" : "") + plain(s.amount)}" data-f="amount" aria-label="Montant">` : eur(s.amount)}</td>
      <td class="acts">${isDue ? `<button class="btn mini primary" data-act="val">Valider</button> <button class="btn mini" data-act="skip">Sauter</button> ` : ""}<button class="btn mini" data-act="edit">Modifier</button> <button class="btn mini danger" data-act="del" aria-label="Supprimer">×</button></td>
    </tr>`; }).join("") : `<tr><td colspan="8" class="empty">Aucune échéance sur cette période. Choisissez « Toutes les échéances » pour voir les suivantes.</td></tr>`) + "</tbody>";
}
$("#schedFilter").addEventListener("change", renderSched);
$("#schedView").addEventListener("change", renderSched);
$("#schedNew").addEventListener("click", () => { resetSched(); $("#schedForm").hidden = false; renderSched(); $("#sTiers").focus(); });
$("#sAcc").addEventListener("change", () => fillToSelect($("#sTo"), Number($("#sAcc").value), $("#sTo").value));
$("#sCat").addEventListener("change", () => fillSubs($("#sCat").value));
$("#sDeb").addEventListener("input", () => { if ($("#sDeb").value) $("#sCre").value = ""; });
$("#sCre").addEventListener("input", () => { if ($("#sCre").value) $("#sDeb").value = ""; });
$("#sTiers").addEventListener("change", () => {
  const t = S.lists.tiers.find(x => norm(x.tiers) === norm($("#sTiers").value)); if (!t || schedEdit) return;
  if (!$("#sCat").value) $("#sCat").value = t.category || ""; if (!$("#sSc").value) $("#sSc").value = t.subcategory || ""; if (!$("#sMode").value) $("#sMode").value = t.mode || "";
});
$("#sCancel").addEventListener("click", () => { resetSched(); $("#schedForm").hidden = true; renderSched(); });
$("#schedTable").addEventListener("click", async ev => {
  if (ev.target.id === "schedGoImport") { $("#dlgSched").close(); openImport(); return; }
  if (ev.target.id === "schedGoNew") { resetSched(); $("#schedForm").hidden = false; $("#sTiers").focus(); return; }
  const act = ev.target.dataset.act, tr = ev.target.closest("tr[data-sid]"); if (!act || !tr) return;
  const s = S.schedules.find(x => x.id === Number(tr.dataset.sid)); if (!s) return;
  try {
    if (act === "val") {
      const amount = parseAmount(tr.querySelector('[data-f="amount"]').value);
      if (isNaN(amount)) { toast("Montant illisible"); return; }
      await api("POST", `/api/schedules/${s.id}/validate`, { date: tr.querySelector('[data-f="date"]').value, amount });
      toast(`${s.tiers} validée sur ${s.account_name}`); await refresh(); renderSched(); return;
    }
    if (act === "skip") { await api("POST", `/api/schedules/${s.id}/skip`, {}); toast(`${s.tiers} : occurrence sautée`); await refresh(); renderSched(); return; }
    if (act === "del") {
      if (!(await confirmBox("Supprimer l'échéance", `Supprimer l'échéance « ${s.tiers} » (${eur(s.amount)}, ${freqLabel(s.unit, s.every).toLowerCase()}) ?`))) return;
      await api("DELETE", `/api/schedules/${s.id}`); toast("Échéance supprimée"); await refresh(); renderSched(); return;
    }
  } catch (e) { fail(e); return; }
  schedEdit = s.id; $("#schedForm").hidden = false;
  $("#sAcc").value = s.account_id; fillToSelect($("#sTo"), s.account_id, s.to_account_id || "");
  $("#sTiers").value = s.tiers; $("#sDet").value = s.details; $("#sMode").value = s.mode; $("#sCat").value = s.category; $("#sSc").value = s.subcategory;
  $("#sDeb").value = s.amount < 0 ? plain(s.amount) : ""; $("#sCre").value = s.amount > 0 ? plain(s.amount) : "";
  $("#sEvery").value = s.every; $("#sUnit").value = s.unit; $("#sNext").value = s.next_date; $("#sEnd").value = s.end_date || "";
  $("#schedFormTitle").textContent = "Modifier « " + s.tiers + " »"; $("#sSubmit").textContent = "Enregistrer";
  renderSched(); $("#sTiers").focus();
});
$("#schedForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const deb = parseAmount($("#sDeb").value), cre = parseAmount($("#sCre").value);
  const amount = !isNaN(deb) && deb ? -Math.abs(deb) : !isNaN(cre) && cre ? Math.abs(cre) : NaN;
  if (isNaN(amount)) { toast("Indiquez un montant au débit ou au crédit"); return; }
  const body = { account_id: Number($("#sAcc").value), to_account_id: $("#sTo").value || null, tiers: $("#sTiers").value, details: $("#sDet").value, mode: $("#sMode").value,
    category: $("#sCat").value, subcategory: $("#sSc").value, amount, unit: $("#sUnit").value, every: Number($("#sEvery").value) || 1, next_date: $("#sNext").value, end_date: $("#sEnd").value };
  try {
    if (schedEdit) { await api("PUT", `/api/schedules/${schedEdit}`, body); toast("Échéance modifiée"); }
    else { await api("POST", "/api/schedules", body); toast("Échéance ajoutée"); }
    resetSched(); $("#schedForm").hidden = true; await refresh(); renderSched();
  } catch (e) { fail(e); }
});

/* ---------- import ---------- */
let csvFiles = [], bpsData = null, bpsPreview = null;
function openImport() {
  $("#impCsvList").innerHTML = ""; $("#impBpsList").innerHTML = ""; $("#impRevRes").innerHTML = ""; $("#impCsv").value = ""; $("#impBps").value = ""; $("#impRev").value = "";
  const revs = S.accounts.filter(a => norm(a.name).includes("revolut")), others = S.accounts.filter(a => !norm(a.name).includes("revolut"));
  $("#impRevAcc").innerHTML = revs.concat(others).map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  if (curAcc() && norm(curAcc().name).includes("revolut")) $("#impRevAcc").value = S.cur;
  $("#dlgImport").showModal();
}
$("#impRev").addEventListener("change", async ev => {
  const f = ev.target.files[0]; if (!f) return;
  const out = $("#impRevRes"); out.innerHTML = `<p class="muted">Import en cours…</p>`;
  try {
    const r = await api("POST", "/api/import/revolut", { account_id: Number($("#impRevAcc").value), text: await decodeFile(f) });
    const ok = r.bank_available === null || r.bank_available === r.balance;
    out.innerHTML = `<p class="ok">${esc(r.account)} : ${r.added} opération${r.added > 1 ? "s" : ""} ajoutée${r.added > 1 ? "s" : ""}${r.duplicates ? `, ${r.duplicates} déjà présente${r.duplicates > 1 ? "s" : ""}` : ""}${r.classified ? `, dont ${r.classified} classée${r.classified > 1 ? "s" : ""} automatiquement` : ""}.</p>` +
      (r.skipped ? `<p class="muted">${r.skipped} ligne${r.skipped > 1 ? "s" : ""} ignorée${r.skipped > 1 ? "s" : ""} (opérations annulées ou mouvements internes à vos Pockets).</p>` : "") +
      (r.other_currencies.length ? `<p class="muted">Lignes en ${esc(r.other_currencies.join(", "))} ignorées : seul l'euro est repris.</p>` : "") +
      (r.pending ? `<p class="muted">${r.pending} paiement${r.pending > 1 ? "s" : ""} en attente inscrit${r.pending > 1 ? "s" : ""} non pointé${r.pending > 1 ? "s" : ""}${r.finalised ? ` · ${r.finalised} paiement${r.finalised > 1 ? "s" : ""} finalisé${r.finalised > 1 ? "s" : ""}` : ""}${r.cancelled ? ` · ${r.cancelled} annulé${r.cancelled > 1 ? "s" : ""} et retiré${r.cancelled > 1 ? "s" : ""}` : ""}.</p>` : (r.finalised || r.cancelled ? `<p class="muted">${r.finalised} paiement(s) en attente finalisé(s), ${r.cancelled} annulé(s) et retiré(s).</p>` : "")) +
      (r.bank_available !== null ? `<p class="${ok ? "ok" : "neg"}">Solde affiché par Revolut ${eur(r.bank_available)} · solde Registre ${eur(r.balance)}${ok ? " : concordants." : " : écart à vérifier."}</p>` : "") +
      (r.to_classify ? `<div class="btns"><button class="btn primary" id="goClass">Classer ${r.to_classify} opération${r.to_classify > 1 ? "s" : ""}</button></div>` : "");
    ev.target.value = ""; S.cur = Number($("#impRevAcc").value); await refresh({ lists: true, scrollEnd: true });
  } catch (e) { out.innerHTML = `<p class="neg">${esc(e.message)}</p>`; ev.target.value = ""; }
});
$("#impRevRes").addEventListener("click", ev => { if (ev.target.id === "goClass") { $("#dlgImport").close(); openClass(); } });

/* ---------- classement ---------- */
function openClass() {
  $("#classAcc").innerHTML = `<option value="">Tous les comptes</option>` + S.accounts.map(a => `<option value="${a.id}">${esc(a.name)}${a.unclassified ? " (" + a.unclassified + ")" : ""}</option>`).join("");
  $("#classAcc").value = S.cur || "";
  $("#dlgClass").showModal(); renderClass();
}
async function renderClass() {
  const accId = $("#classAcc").value;
  let groups; try { groups = await api("GET", "/api/unclassified" + (accId ? "?account=" + accId : "")); } catch (e) { fail(e); return; }
  const n = groups.reduce((s, g) => s + g.n, 0);
  $("#classIntro").textContent = n ? `${n} opération${n > 1 ? "s" : ""} sans catégorie, regroupée${n > 1 ? "s" : ""} par tiers` : "";
  $("#classTable").innerHTML = `<thead><tr><th>Tiers</th>${accId ? "" : "<th>Compte</th>"}<th class="r">Nb</th><th class="r">Total</th><th>Dernière</th><th>Catégorie</th><th>Sous-catégorie</th><th></th></tr></thead><tbody>` +
    (groups.length ? groups.map((g, i) => `<tr data-i="${i}">
      <td>${esc(g.tiers || "(sans tiers)")}</td>${accId ? "" : `<td>${esc(g.accounts)}</td>`}<td class="r">${g.n}</td>
      <td class="r num ${cls(g.total)}">${eur(g.total)}</td><td class="num">${fmtDate(g.last)}</td>
      <td><input data-f="cat" list="dlCatsAll" aria-label="Catégorie"></td><td><input data-f="sc" list="dlSubsAll" aria-label="Sous-catégorie"></td>
      <td class="acts"><button class="btn mini primary" data-act="apply">Appliquer</button></td></tr>`).join("") :
      `<tr><td colspan="8" class="empty">Tout est classé.</td></tr>`) + "</tbody>";
  S.classGroups = groups;
}
$("#classAcc").addEventListener("change", renderClass);
$("#classTable").addEventListener("focusin", ev => { if (ev.target.dataset.f === "sc") fillSubs(ev.target.closest("tr").querySelector('[data-f="cat"]').value); });
$("#classTable").addEventListener("keydown", ev => { if (ev.key === "Enter" && ev.target.matches("input")) { ev.preventDefault(); ev.target.closest("tr").querySelector('[data-act="apply"]').click(); } });
$("#classTable").addEventListener("click", async ev => {
  if (ev.target.dataset.act !== "apply") return;
  const tr = ev.target.closest("tr"), g = S.classGroups[tr.dataset.i];
  const cat = tr.querySelector('[data-f="cat"]').value.trim(), sc = tr.querySelector('[data-f="sc"]').value.trim();
  if (!cat) { toast("Indiquez une catégorie"); tr.querySelector('[data-f="cat"]').focus(); return; }
  try {
    const r = await api("POST", "/api/classify", { tiers: g.tiers, category: cat, subcategory: sc, account_id: $("#classAcc").value || null });
    toast(`${r.updated} opération${r.updated > 1 ? "s" : ""} classée${r.updated > 1 ? "s" : ""} en ${cat}${sc ? " / " + sc : ""}`);
    await refresh({ lists: true });
    const v = $("#classAcc").value;
    $("#classAcc").innerHTML = `<option value="">Tous les comptes</option>` + S.accounts.map(a => `<option value="${a.id}">${esc(a.name)}${a.unclassified ? " (" + a.unclassified + ")" : ""}</option>`).join("");
    $("#classAcc").value = v; await renderClass();
    const nxt = $('#classTable [data-f="cat"]'); if (nxt) nxt.focus();
  } catch (e) { fail(e); }
});
$("#tbClass").addEventListener("click", openClass);
async function decodeFile(f) { const buf = await f.arrayBuffer(); try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch (e) { return new TextDecoder("windows-1252").decode(buf); } }
const nameFromFile = n => n.replace(/\.[^.]+$/, "").replace(/^[0-9a-f]{8}-/i, "").replace(/_/g, " ").replace(/^Accounts\s*-\s*/i, "").trim() || "Compte";
$("#impCsv").addEventListener("change", async ev => {
  csvFiles = [];
  for (const f of ev.target.files) csvFiles.push({ name: nameFromFile(f.name), text: await decodeFile(f), file: f.name });
  $("#impCsvList").innerHTML = csvFiles.map((c, i) => {
    const n = Math.max(0, c.text.split(/\r?\n/).filter(l => /^\d{2}\/\d{2}\/\d{4};/.test(l)).length);
    const ex = S.accounts.find(a => norm(a.name) === norm(c.name));
    return `<div class="imp-item" data-i="${i}"><div class="row"><label class="fld"><span>Nom du compte</span><input data-f="name" value="${esc(c.name)}"></label><span class="muted">${n} lignes · ${ex ? "complète le compte existant" : "nouveau compte"}</span></div></div>`;
  }).join("") + (csvFiles.length ? `<div class="btns"><button class="btn primary" id="impCsvGo">Importer ${csvFiles.length} compte${csvFiles.length > 1 ? "s" : ""}</button></div>` : "");
});
$("#impCsvList").addEventListener("input", ev => { const it = ev.target.closest("[data-i]"); if (it) csvFiles[it.dataset.i].name = ev.target.value; });
$("#impCsvList").addEventListener("click", async ev => {
  if (ev.target.id !== "impCsvGo") return;
  ev.target.disabled = true; ev.target.textContent = "Import en cours…";
  const out = [];
  for (const c of csvFiles) {
    try { const r = await api("POST", "/api/import/csv", { name: c.name.trim() || "Compte", text: c.text }); out.push(`<li class="ok">${esc(c.name)} : ${r.added} opérations ajoutées${r.duplicates ? `, ${r.duplicates} déjà présentes` : ""}</li>`); }
    catch (e) { out.push(`<li class="neg">${esc(c.name)} : ${esc(e.message)}</li>`); }
  }
  $("#impCsvList").innerHTML = `<ul>${out.join("")}</ul>`; csvFiles = []; $("#impCsv").value = "";
  if (!curAcc()) S.cur = (S.accounts.find(a => norm(a.name) === "ccp") || {}).id || null;
  await refresh({ lists: true, scrollEnd: true });
  if (!curAcc()) { S.cur = (S.accounts.find(a => norm(a.name) === "ccp") || S.accounts[0] || {}).id || null; await loadOps(true); renderTree(); }
});
$("#impBps").addEventListener("change", async ev => {
  const f = ev.target.files[0]; if (!f) return;
  if (!S.accounts.length) { $("#impBpsList").innerHTML = `<p class="neg">Importez d'abord vos comptes.</p>`; return; }
  const bytes = new Uint8Array(await f.arrayBuffer()); let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  bpsData = btoa(bin);
  try { bpsPreview = await api("POST", "/api/import/bpsched/preview", { data: bpsData }); } catch (e) { $("#impBpsList").innerHTML = `<p class="neg">${esc(e.message)}</p>`; return; }
  const items = bpsPreview.items, nums = [...new Set(items.flatMap(i => [i.bp_account, i.bp_transfer]).filter(n => n !== null && n !== undefined))].sort((a, b) => a - b);
  const opts = v => `<option value="">Ne pas importer</option>` + S.accounts.map(a => `<option value="${a.id}" ${Number(v) === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("");
  $("#impBpsList").innerHTML = `<p>${items.length} échéances. Bank Perfect ne donne que le numéro de chaque compte : vérifiez les correspondances.</p>` +
    nums.map(n => { const own = items.filter(i => i.bp_account === n), inc = items.filter(i => i.bp_transfer === n), ex = own.length ? own : inc;
      return `<div class="imp-item"><div class="row"><label class="fld"><span>Compte n° ${n} · ${own.length ? own.length + " échéances" : "reçoit " + inc.length + " virement" + (inc.length > 1 ? "s" : "")}</span><select data-bp="${n}">${opts(bpsPreview.guess[n])}</select></label></div>
      <span class="muted">${ex.slice(0, 7).map(i => esc(i.tiers)).join(", ")}${ex.length > 7 ? "…" : ""}</span></div>`; }).join("") +
    `<div class="btns"><button class="btn primary" id="impBpsGo">Importer l'échéancier</button></div>`;
});
$("#impBpsList").addEventListener("click", async ev => {
  if (ev.target.id !== "impBpsGo") return;
  const mapping = {}; $$("#impBpsList select[data-bp]").forEach(s => { if (s.value) mapping[s.dataset.bp] = Number(s.value); });
  try {
    const r = await api("POST", "/api/import/bpsched", { data: bpsData, mapping });
    $("#impBpsList").innerHTML = `<p class="ok">${r.added} échéances importées, dont ${r.with_category} avec leur catégorie retrouvée${r.duplicates ? ` · ${r.duplicates} déjà présentes ignorées` : ""}.</p>`;
    $("#impBps").value = ""; await refresh();
  } catch (e) { fail(e); }
});

/* ---------- paramètres ---------- */
let FAMS = [];
async function openSettings(tab) {
  FAMS = await api("GET", "/api/families");
  renderAccTable(); renderFams(); renderBackup(); renderPoints(); renderExport(); loadCats().catch(fail);
  $("#appVersion").textContent = "Registre, version " + (S.version || "?");
  $("#setHorizon").value = String(S.settings.horizon);
  showTab(typeof tab === "string" ? tab : "comptes");
  $("#dlgSettings").showModal();
}
function showTab(name) {
  $$("#dlgSettings [role=tab]").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === name));
  $$("#dlgSettings .tabp").forEach(p => { p.hidden = p.id !== "tab-" + name; });
}
$("#dlgSettings .tabs").addEventListener("click", ev => { const b = ev.target.closest("[data-tab]"); if (b) showTab(b.dataset.tab); });
let CATS = [];
async function loadCats() { CATS = await api("GET", "/api/categories"); renderCats(); }
// Cibles possibles pour une sous-catégorie : une autre catégorie (en gardant son nom) ou une sous-catégorie existante (fusion).
function moveOptions(groups, cat, sub) {
  let h = "";
  for (const [c, subs] of groups) {
    const opts = [];
    if (c !== cat) opts.push(`<option value="${esc(JSON.stringify([c, sub]))}">${esc(c)} › ${esc(sub)} (nouvelle)</option>`);
    for (const x of subs) if (x.subcategory && !(c === cat && x.subcategory === sub))
      opts.push(`<option value="${esc(JSON.stringify([c, x.subcategory]))}">${esc(c)} › ${esc(x.subcategory)}</option>`);
    // si la catégorie cible a déjà une sous-catégorie du même nom, l'option « (nouvelle) » est inutile
    if (c !== cat && subs.some(x => x.subcategory === sub)) opts.shift();
    if (opts.length) h += `<optgroup label="${esc(c)}">${opts.join("")}</optgroup>`;
  }
  return h;
}
function renderCats() {
  const f = norm($("#catSearch").value), groups = new Map();
  for (const c of CATS) { if (!groups.has(c.category)) groups.set(c.category, []); groups.get(c.category).push(c); }
  const catNames = [...groups.keys()];
  let html = `<thead><tr><th>Catégorie / sous-catégorie</th><th>Déplacer / fusionner vers</th><th class="r">Opérations</th><th class="r">Échéances</th><th></th></tr></thead><tbody>`, shown = 0;
  for (const [cat, subs] of groups) {
    const hit = !f || norm(cat).includes(f) || subs.some(x => norm(x.subcategory).includes(f));
    if (!hit) continue;
    const ops = subs.reduce((s, x) => s + x.ops, 0), sch = subs.reduce((s, x) => s + x.sched, 0), ca = subs.some(x => x.cat_archived);
    html += `<tr class="cat-h${ca ? " archived" : ""}" data-cat="${esc(cat)}"><td><input data-f="cat" value="${esc(cat)}" aria-label="Nom de la catégorie">${ca ? `<span class="tag-arch">archivée</span>` : ""}</td><td></td>
      <td class="r cnt">${ops}</td><td class="r cnt">${sch}</td><td class="acts"><button class="btn mini" data-act="addsub">+ Sous-catégorie</button> <button class="btn mini" data-act="${ca ? "unarchcat" : "archcat"}" title="${ca ? "Proposer de nouveau cette catégorie à la saisie" : "Ne plus proposer cette catégorie à la saisie d'une nouvelle opération (elle reste utilisable)"}">${ca ? "Réactiver" : "Archiver"}</button> <button class="btn mini danger" data-act="delcat">Supprimer</button></td></tr>`;
    for (const x of subs.filter(x => x.subcategory && (!f || norm(cat).includes(f) || norm(x.subcategory).includes(f)))) {
      shown++;
      const a = x.archived || ca;
      html += `<tr class="${a ? "archived" : ""}" data-cat="${esc(cat)}" data-sub="${esc(x.subcategory)}"><td class="sub-indent"><input data-f="sub" value="${esc(x.subcategory)}" aria-label="Nom de la sous-catégorie">${x.archived ? `<span class="tag-arch">archivée</span>` : ""}</td>
        <td><select data-f="move" aria-label="Déplacer ou fusionner vers"><option value="">—</option>${moveOptions(groups, cat, x.subcategory)}</select></td>
        <td class="r cnt">${x.ops}</td><td class="r cnt">${x.sched}</td><td class="acts">${ca ? "" : `<button class="btn mini" data-act="${x.archived ? "unarchsub" : "archsub"}" title="${x.archived ? "Proposer de nouveau cette sous-catégorie à la saisie" : "Ne plus proposer cette sous-catégorie à la saisie d'une nouvelle opération (elle reste utilisable)"}">${x.archived ? "Réactiver" : "Archiver"}</button> `}<button class="btn mini danger" data-act="delsub">Supprimer</button></td></tr>`;
    }
  }
  $("#catTable").innerHTML = html + "</tbody>";
  const nArch = new Set(CATS.filter(c => c.cat_archived).map(c => c.category)).size + CATS.filter(c => c.archived && !c.cat_archived).length;
  $("#catIntro").textContent = `${catNames.length} catégories · ${CATS.filter(c => c.subcategory).length} sous-catégories${nArch ? ` · ${nArch} archivée${nArch > 1 ? "s" : ""}` : ""}`;
}
async function catAction(body, msg) {
  try { const r = await api("POST", "/api/categories/rename", body); toast(msg + (r.updated ? ` (${r.updated} ligne${r.updated > 1 ? "s" : ""} mise${r.updated > 1 ? "s" : ""} à jour)` : "")); await loadCats(); await refresh({ lists: true }); }
  catch (e) { fail(e); await loadCats(); }
}
async function moveSub(cat, sub, nc, ns, sel) {
  const exists = CATS.some(c => c.category === nc && c.subcategory === ns);
  const n = CATS.filter(c => c.category === cat && c.subcategory === sub).reduce((t, c) => t + c.ops + c.sched, 0);
  const ok = await confirmBox(exists ? "Fusionner les sous-catégories" : "Déplacer la sous-catégorie",
    `${exists ? "Fusionner" : "Déplacer"} « ${cat} › ${sub} » ${exists ? "dans" : "vers"} « ${nc} › ${ns} » ? ${n ? `${n} opération${n > 1 ? "s" : ""} ou échéance${n > 1 ? "s" : ""} ser${n > 1 ? "ont" : "a"} reclassée${n > 1 ? "s" : ""}` : "Aucune opération concernée"}${exists ? ` et « ${sub} » disparaîtra` : ""}.`);
  if (!ok) { sel.value = ""; return; }
  catAction({ category: cat, subcategory: sub, new_category: nc, new_subcategory: ns }, exists ? `« ${sub} » fusionnée dans « ${nc} › ${ns} »` : `« ${sub} » déplacée dans « ${nc} »`);
}
$("#catSearch").addEventListener("input", renderCats);
$("#catTable").addEventListener("change", ev => {
  const tr = ev.target.closest("tr[data-cat]"); if (!tr) return;
  const cat = tr.dataset.cat, sub = tr.dataset.sub, f = ev.target.dataset.f, v = ev.target.value.trim();
  if (f === "cat" && v && v !== cat) catAction({ category: cat, subcategory: null, new_category: v }, CATS.some(c => c.category === v) ? `« ${cat} » fusionnée dans « ${v} »` : `Catégorie renommée en « ${v} »`);
  if (f === "sub" && v !== sub) catAction({ category: cat, subcategory: sub, new_category: cat, new_subcategory: v }, `Sous-catégorie renommée en « ${v || "(aucune)"} »`);
  if (f === "move" && v) moveSub(cat, sub, ...JSON.parse(v), ev.target);
});
$("#catTable").addEventListener("click", async ev => {
  const act = ev.target.dataset.act, tr = ev.target.closest("tr[data-cat]"); if (!act || !tr) return;
  const cat = tr.dataset.cat, sub = tr.dataset.sub;
  if (act === "addsub") { $("#cnCat").value = cat; $("#cnSub").value = ""; $("#cnSub").focus(); return; }
  if (/arch/.test(act)) {
    const isCat = act.endsWith("cat"), on = !act.startsWith("un");
    try {
      await api("POST", "/api/categories/archive", { category: cat, subcategory: isCat ? null : sub, archived: on });
      toast(`${isCat ? "Catégorie « " + cat : "Sous-catégorie « " + sub} » ${on ? "archivée : elle n'est plus proposée pour une nouvelle opération" : "réactivée"}`);
      await loadCats(); await loadLists();
    } catch (e) { fail(e); }
    return;
  }
  const n = CATS.filter(c => c.category === cat && (act === "delcat" || c.subcategory === sub)).reduce((s, c) => s + c.ops + c.sched, 0);
  const what = act === "delcat" ? `la catégorie « ${cat} » et ses sous-catégories` : `la sous-catégorie « ${sub} »`;
  if (!(await confirmBox("Supprimer", `Supprimer ${what} ?${n ? ` ${n} opération${n > 1 ? "s" : ""} ou échéance${n > 1 ? "s" : ""} ${act === "delcat" ? "redeviendront « à classer »" : "garderont seulement la catégorie « " + cat + " »"}.` : ""}`))) return;
  try { await api("POST", "/api/categories/delete", { category: cat, subcategory: act === "delcat" ? null : sub }); toast("Supprimé"); await loadCats(); await refresh({ lists: true }); } catch (e) { fail(e); }
});
$("#catNewForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  try { await api("POST", "/api/categories", { category: $("#cnCat").value, subcategory: $("#cnSub").value }); toast("Catégorie ajoutée"); $("#cnSub").value = ""; await loadCats(); await loadLists(); } catch (e) { fail(e); }
});
function renderExport() {
  const sel = $("#expAcc"), v = sel.value || S.cur;
  sel.innerHTML = S.accounts.map(a => `<option value="${a.id}">${esc(a.name)} (${a.n} opérations)</option>`).join("");
  if (v) sel.value = v;
  $("#expGo").href = sel.value ? `/api/accounts/${sel.value}/export` : "#";
}
$("#expAcc").addEventListener("change", renderExport);
$("#openImport").addEventListener("click", () => { $("#dlgSettings").close(); openImport(); });
function renderPoints() {
  const pts = S.points.points || [];
  $("#pointsTable").innerHTML = `<thead><tr><th>Point de sauvegarde</th><th class="r">Taille</th><th></th></tr></thead><tbody>` +
    (pts.length ? pts.map((p, i) => `<tr><td>${fmtDate(p.when.slice(0, 10))} à ${p.when.slice(11, 16)}${i === 0 ? ` <span class="muted">· le plus récent${S.points.changes ? `, ${S.points.changes} modification${S.points.changes > 1 ? "s" : ""} depuis` : ""}</span>` : ""}</td>
      <td class="r muted">${Math.round(p.size / 1024)} Ko</td><td class="acts"><button class="btn mini" data-pt="${esc(p.name)}">Revenir à ce point</button></td></tr>`).join("")
      : `<tr><td colspan="3" class="empty">Aucun point pour l'instant : cliquez sur « Sauvegarder » dans la barre d'outils.</td></tr>`) + "</tbody>";
}
$("#pointsTable").addEventListener("click", ev => { const b = ev.target.closest("[data-pt]"); if (b) revertChanges(b.dataset.pt); });
function renderFams() {
  $("#naFam").innerHTML = FAMS.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join("");
  $("#famList").innerHTML = FAMS.map((f, i) => `<div class="fam" data-fid="${f.id}"><input data-f="name" value="${esc(f.name)}" aria-label="Nom de la famille">
    <button class="btn mini" data-act="fup" ${i ? "" : "disabled"} aria-label="Monter">↑</button><button class="btn mini" data-act="fdown" ${i < FAMS.length - 1 ? "" : "disabled"} aria-label="Descendre">↓</button>
    <button class="btn mini danger" data-act="fdel" ${f.n ? "disabled title=\"Famille non vide\"" : ""}>×</button></div>`).join("");
}
async function renderBackup() {
  const el = $("#autoBackup");
  try {
    const b = await api("GET", "/api/backup/status");
    if (!b.enabled) { el.innerHTML = `<p class="muted">Sauvegarde automatique : non configurée. Le mode d'emploi explique comment la relier à votre OneDrive.</p>`; return; }
    el.innerHTML = `<p>${b.error ? `<b class="bk-err">${esc(b.error)}</b>` : `<b class="bk-ok">Sauvegarde automatique active</b>`} : une copie par jour, envoyée sur OneDrive ; les ${b.keep} dernières sont gardées.</p>
      <p class="muted">Dernière copie : ${b.last ? esc(b.last) : "aucune pour l'instant"} · ${b.count} fichier${b.count > 1 ? "s" : ""} dans le dossier.</p>
      <p>${!b.cloud ? `<span class="muted">Envoi vers OneDrive : pas encore de nouvelles du service de synchronisation.</span>` : b.cloud.ok ? `<b class="bk-ok">Envoyé sur OneDrive</b> le ${esc(b.cloud.when)}` : `<b class="bk-err">Échec de l'envoi sur OneDrive</b> le ${esc(b.cloud.when)} : ${esc(b.cloud.detail)}`}</p>
      <div><button class="btn primary" id="bkNow">Sauvegarde Cloud maintenant</button></div>`;
  } catch (e) { el.innerHTML = ""; }
}
$("#autoBackup").addEventListener("click", async ev => {
  if (ev.target.id !== "bkNow") return;
  await cloudNow(); renderBackup();
});
$("#famList").addEventListener("change", async ev => {
  const f = ev.target.closest("[data-fid]"); if (!f) return;
  try { await api("PUT", `/api/families/${f.dataset.fid}`, { name: ev.target.value }); FAMS = await api("GET", "/api/families"); renderFams(); await loadAccounts(); renderAccTable(); toast("Famille renommée"); } catch (e) { fail(e); }
});
$("#famList").addEventListener("click", async ev => {
  const act = ev.target.dataset.act, f = ev.target.closest("[data-fid]"); if (!act || !f) return;
  const i = FAMS.findIndex(x => x.id === Number(f.dataset.fid));
  try {
    if (act === "fdel") await api("DELETE", `/api/families/${FAMS[i].id}`);
    else { const j = act === "fup" ? i - 1 : i + 1; const order = FAMS.map(x => x.id); [order[i], order[j]] = [order[j], order[i]];
      await Promise.all(order.map((id, k) => api("PUT", `/api/families/${id}`, { position: k }))); }
    FAMS = await api("GET", "/api/families"); renderFams(); await loadAccounts(); renderAccTable();
  } catch (e) { fail(e); }
});
$("#newFamForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  try { await api("POST", "/api/families", { name: $("#nfName").value }); $("#newFamForm").reset(); FAMS = await api("GET", "/api/families"); renderFams(); renderAccTable(); toast("Famille créée"); } catch (e) { fail(e); }
});
let iconTarget = null;
$("#iconFile").addEventListener("change", async ev => {
  const f = ev.target.files[0]; ev.target.value = ""; if (!f || !iconTarget) return;
  try {
    const src = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 64, 64);
    const r = Math.min(64 / img.width, 64 / img.height), w = img.width * r, h = img.height * r;
    g.drawImage(img, (64 - w) / 2, (64 - h) / 2, w, h);
    await api("PUT", `/api/accounts/${iconTarget}`, { icon: c.toDataURL("image/png") });
    toast("Icône mise à jour"); await loadAccounts(); renderHead(); renderAccTable();
  } catch (e) { fail(e.message ? e : new Error("Image illisible")); }
});
function renderAccTable() {
  const cyc = a => `<select data-f="cycle_day" aria-label="Fin de cycle"><option value="0">Fin du mois</option>${Array.from({ length: 28 }, (_, k) => `<option value="${k + 1}" ${a.cycle_day === k + 1 ? "selected" : ""}>Le ${k + 1}</option>`).join("")}</select>`;
  $("#accTable").innerHTML = `<thead><tr><th>Icône</th><th>Nom</th><th>Famille</th><th title="Date de fin de cycle pour le solde prévisionnel">Fin de cycle</th><th class="r">Solde de départ</th><th class="r">Solde</th><th>Ordre</th><th>Clôturé</th><th></th></tr></thead><tbody>` +
    S.accounts.map((a, i) => `<tr data-id="${a.id}">
      <td><span class="icon-cell">${iconHtml(a)}<button class="btn mini" data-act="icon">Choisir</button>${a.icon ? `<button class="btn mini" data-act="noicon" aria-label="Retirer l'icône">×</button>` : ""}</span></td>
      <td><input data-f="name" value="${esc(a.name)}" aria-label="Nom"></td>
      <td><select data-f="family_id" aria-label="Famille">${FAMS.map(f => `<option value="${f.id}" ${a.family_id === f.id ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select></td>
      <td>${cyc(a)}</td>
      <td class="r"><input class="amt" data-f="initial" value="${(a.initial < 0 ? "-" : "") + plain(a.initial)}" aria-label="Solde de départ"></td>
      <td class="r num ${cls(a.balance)}">${eur(a.balance)}</td>
      <td class="acts"><button class="btn mini" data-act="up" ${i ? "" : "disabled"} aria-label="Monter">↑</button> <button class="btn mini" data-act="down" ${i < S.accounts.length - 1 ? "" : "disabled"} aria-label="Descendre">↓</button></td>
      <td><input type="checkbox" data-f="closed" ${a.closed ? "checked" : ""} aria-label="Clôturé"></td>
      <td class="acts"><button class="btn mini danger" data-act="del">Supprimer</button></td></tr>`).join("") + "</tbody>";
}
$("#accTable").addEventListener("change", async ev => {
  const tr = ev.target.closest("tr[data-id]"), f = ev.target.dataset.f; if (!tr || !f) return;
  const v = f === "closed" ? ev.target.checked : f === "initial" ? parseAmount(ev.target.value) : (f === "family_id" || f === "cycle_day") ? Number(ev.target.value) : ev.target.value;
  if (f === "initial" && isNaN(v)) { toast("Montant illisible"); return; }
  try { await api("PUT", `/api/accounts/${tr.dataset.id}`, { [f]: v }); toast("Compte mis à jour"); await refresh(); renderAccTable(); } catch (e) { fail(e); }
});
$("#accTable").addEventListener("click", async ev => {
  const act = ev.target.dataset.act, tr = ev.target.closest("tr[data-id]"); if (!act || !tr) return;
  const id = Number(tr.dataset.id), i = S.accounts.findIndex(a => a.id === id), a = S.accounts[i];
  if (act === "icon") { iconTarget = id; $("#iconFile").click(); return; }
  try {
    if (act === "noicon") await api("PUT", `/api/accounts/${id}`, { icon: "" });
    if (act === "up" || act === "down") {
      const j = act === "up" ? i - 1 : i + 1, order = S.accounts.map(x => x.id); [order[i], order[j]] = [order[j], order[i]];
      await Promise.all(order.map((x, k) => api("PUT", `/api/accounts/${x}`, { position: k })));
    }
    if (act === "del") {
      if (!(await confirmBox("Supprimer le compte", `Supprimer définitivement « ${a.name} », ses ${a.n} opérations et ses échéances ? Pensez à télécharger une sauvegarde avant.`))) return;
      await api("DELETE", `/api/accounts/${id}`); if (S.cur === id) S.cur = null; toast("Compte supprimé");
    }
    await refresh(); if (!curAcc()) { S.cur = (S.accounts[0] || {}).id || null; await loadOps(true); } renderAccTable();
  } catch (e) { fail(e); }
});
$("#newAccForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  try {
    const r = await api("POST", "/api/accounts", { name: $("#naName").value, family_id: Number($("#naFam").value), initial: $("#naInit").value });
    $("#newAccForm").reset(); S.cur = r.id; toast("Compte créé"); await refresh({ scrollEnd: true }); renderAccTable(); resetEntry();
  } catch (e) { fail(e); }
});
$("#setHorizon").addEventListener("change", async () => {
  try { await api("PUT", "/api/settings", { horizon: Number($("#setHorizon").value) }); S.settings.horizon = Number($("#setHorizon").value); renderDueBadge(); renderGrid(); toast("Paramètre enregistré"); } catch (e) { fail(e); }
});
$("#pwForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  try { await api("POST", "/api/password", { old: $("#pwOld").value, new: $("#pwNew").value }); $("#pwForm").reset(); toast("Mot de passe changé"); } catch (e) { fail(e); }
});

$("#restoreFile").addEventListener("change", async ev => {
  const f = ev.target.files[0]; if (!f) return;
  if (!(await confirmBox("Restaurer une sauvegarde", `Remplacer toutes vos données actuelles par le contenu de « ${f.name} » ? Le mot de passe redevient celui de la sauvegarde.`))) { ev.target.value = ""; return; }
  const bytes = new Uint8Array(await f.arrayBuffer()); let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  try { await api("POST", "/api/restore", { data: btoa(bin) }); toast("Sauvegarde restaurée"); $("#dlgSettings").close(); S.cur = null; await startApp(); }
  catch (e) { fail(e); }
  ev.target.value = "";
});

/* ---------- prévisionnel ---------- */
let fcAcc = null;
function nextDay(day) { const t = new Date(); let d = new Date(t.getFullYear(), t.getMonth(), day); if (t.getDate() > day) d = new Date(t.getFullYear(), t.getMonth() + 1, day); return iso(d); }
function quickDates() {
  const t = new Date(), a = curAcc(), out = [];
  if (a && a.cycle_day) out.push(["Fin de cycle " + a.name + " (" + fmtDate(a.cycle_end).slice(0, 5) + ")", a.cycle_end]);
  out.push(["Fin du mois", iso(new Date(t.getFullYear(), t.getMonth() + 1, 0))]);
  if (a && a.cycle_day) { const [cy, cm] = a.cycle_end.split("-").map(Number), c = new Date(cy, cm - 1, 1); out.push(["Cycle suivant (" + fmtDate(iso(new Date(c.getFullYear(), c.getMonth() + 1, a.cycle_day))).slice(0, 5) + ")", iso(new Date(c.getFullYear(), c.getMonth() + 1, a.cycle_day))]); }
  out.push(["+3 mois", iso(new Date(t.getFullYear(), t.getMonth() + 3, t.getDate()))]);
  out.push(["31 décembre", t.getFullYear() + "-12-31"]);
  return out;
}
function openFc() {
  const a = curAcc(); fcAcc = a ? a.id : null;
  $("#fcDate").min = todayIso();
  $("#fcDate").value = a ? a.cycle_end : iso(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0));
  $("#dlgFc").showModal(); loadFc();
}
async function loadFc() {
  const until = $("#fcDate").value; if (!until) return;
  $("#fcQuick").innerHTML = quickDates().map(([l, d]) => `<button class="btn ${d === until ? "on" : ""}" data-d="${d}">${esc(l)}</button>`).join("");
  let r; try { r = await api("GET", `/api/forecast?until=${until}&account=${fcAcc || ""}`); } catch (e) { fail(e); return; }
  const fams = new Map(S.accounts.map(a => [a.id, a.family_name]));
  let html = `<thead><tr><th>Compte</th><th class="r">Aujourd'hui</th><th class="r">Entrées prévues</th><th class="r">Sorties prévues</th><th class="r">Solde au ${fmtDate(until)}</th><th class="r">Point bas</th></tr></thead><tbody>`;
  let curFam = null, tot = { start: 0, in: 0, out: 0, end: 0 };
  for (const f of r.accounts) {
    const fam = fams.get(f.account_id);
    if (fam !== curFam) { html += `<tr><td colspan="6" class="muted"><b>${esc(fam || "")}</b></td></tr>`; curFam = fam; }
    const a = acc(f.account_id);
    tot.start += f.start; tot.in += f.in; tot.out += f.out; tot.end += f.end;
    html += `<tr class="pick ${f.account_id === fcAcc ? "cur" : ""}" data-acc="${f.account_id}">
      <td><span class="icon-cell">${iconHtml(a)}${esc(f.name)}</span></td>
      <td class="r num ${cls(f.start)}">${eur(f.start)}</td>
      <td class="r num pos">${f.in ? "+" + plain(f.in) : ""}</td>
      <td class="r num neg">${f.out ? "-" + plain(f.out) : ""}</td>
      <td class="r num ${cls(f.end)}"><b>${eur(f.end)}</b></td>
      <td class="r num ${cls(f.low)}">${f.low < Math.min(f.start, f.end) ? eur(f.low) + ` <span class="lowc">le ${fmtDate(f.low_date).slice(0, 5)}</span>` : ""}</td></tr>`;
  }
  html += `<tr class="tot"><td>Total</td><td class="r num ${cls(tot.start)}">${eur(tot.start)}</td><td class="r num">+${plain(tot.in)}</td><td class="r num">-${plain(tot.out)}</td><td class="r num ${cls(tot.end)}">${eur(tot.end)}</td><td></td></tr></tbody>`;
  $("#fcTable").innerHTML = html;
  const d = r.accounts.find(f => f.account_id === fcAcc);
  $("#fcDetailTitle").textContent = d ? `Détail ${d.name} : ${d.count} mouvement${d.count > 1 ? "s" : ""} prévu${d.count > 1 ? "s" : ""} d'ici le ${fmtDate(until)}` : "Cliquez sur un compte pour voir le détail";
  $("#fcDetail").innerHTML = !d ? "" : `<thead><tr><th>Date</th><th>Tiers</th><th>Catégorie</th><th>Origine</th><th class="r">Montant</th><th class="r">Solde</th></tr></thead><tbody>
    <tr><td class="num">${fmtDate(r.today)}</td><td><i>Solde aujourd'hui</i></td><td></td><td></td><td></td><td class="r num ${cls(d.start)}">${eur(d.start)}</td></tr>` +
    d.items.map(i => `<tr class="${i.solde < 0 ? "below" : ""}"><td class="num">${fmtDate(i.date)}${i.late ? ` <span class="neg">en retard</span>` : ""}</td><td>${esc(i.tiers)}${i.details ? ` <span class="muted">· ${esc(i.details)}</span>` : ""}</td>
      <td>${esc([i.category, i.subcategory].filter(Boolean).join(" / "))}</td><td class="muted">${i.kind === "echeance" ? "Échéance" : "Déjà saisie"}</td>
      <td class="r num ${i.amount < 0 ? "neg" : "pos"}">${eur(i.amount)}</td><td class="r num sol ${cls(i.solde)}">${eur(i.solde)}</td></tr>`).join("") +
    (d.items.length ? "" : `<tr><td colspan="6" class="empty">Aucun mouvement prévu sur la période.</td></tr>`) + "</tbody>";
}
$("#fcDate").addEventListener("change", loadFc);
$("#fcQuick").addEventListener("click", ev => { const b = ev.target.closest("[data-d]"); if (!b) return; $("#fcDate").value = b.dataset.d; loadFc(); });
$("#fcTable").addEventListener("click", ev => { const tr = ev.target.closest("tr[data-acc]"); if (!tr) return; fcAcc = Number(tr.dataset.acc); loadFc(); });
$("#tbFc").addEventListener("click", openFc);

/* ---------- confirmation ---------- */
function confirmBox(title, text) {
  return new Promise(res => {
    const d = $("#dlgConfirm");
    $("#cfTitle").textContent = title; $("#cfText").textContent = text;
    const done = v => { d.close(); $("#cfOk").onclick = $("#cfNo").onclick = null; res(v); };
    $("#cfOk").onclick = () => done(true); $("#cfNo").onclick = () => done(false);
    d.oncancel = () => done(false);
    d.showModal(); $("#cfNo").focus();
  });
}

/* ---------- barre d'outils et clavier ---------- */
$$("dialog [data-close]").forEach(b => b.addEventListener("click", () => b.closest("dialog").close()));
$("#tbNew").addEventListener("click", () => { resetEntry(); $("#fDate").focus(); });
$("#tbDel").addEventListener("click", deleteSelected);
$("#tbPoint").addEventListener("click", pointSelected);
$("#tbMove").addEventListener("click", openMove);
$("#tbSave").addEventListener("click", saveNow);
$("#tbCloud").addEventListener("click", cloudNow);
$("#tbSched").addEventListener("click", openSched);
$("#tbSettings").addEventListener("click", openSettings);
$("#tbLogout").addEventListener("click", async () => { try { await api("POST", "/api/logout", {}); } catch (e) {} showLogin(false); });
$("#period").addEventListener("change", () => { S.period = $("#period").value; loadOps(true).catch(fail); });
let searchT;
$("#search").addEventListener("input", () => { clearTimeout(searchT); searchT = setTimeout(() => { S.search = $("#search").value.trim(); loadOps(true).catch(fail); }, 250); });
document.addEventListener("keydown", ev => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") { ev.preventDefault(); if (!document.querySelector("dialog[open]")) saveNow(); return; }
  if (document.querySelector("dialog[open]")) return;
  const inField = ev.target.closest("input, select, textarea");
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "n") { ev.preventDefault(); resetEntry(); $("#fDate").focus(); return; }
  if (ev.key === "Escape" && S.edit) { resetEntry(); return; }
  if (inField) return;
  if (ev.key === "Escape" && S.selSet.size > 1) { const k = S.sel; clearSel(); if (k) selRow(k); return; }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "a") { ev.preventDefault(); selectAll(); return; }
  const ids = displayIds(), i = ids.indexOf(S.sel);
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); const j = i < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, i + (ev.key === "ArrowDown" ? 1 : -1))); if (ids[j]) { if (ev.shiftKey && S.anchor == null) S.anchor = S.sel; selRow(ids[j], true, ev.shiftKey ? "range" : undefined); } }
  else if (ev.key === " " && S.sel) { ev.preventDefault(); pointSelected(); }
  else if (ev.key === "Delete" && S.sel) { ev.preventDefault(); deleteSelected(); }
  else if (ev.key === "Enter" && S.sel) { ev.preventDefault(); startEdit(S.sel); }
});

boot();
