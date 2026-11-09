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
  sel: null, edit: null, period: "12m", search: "", recon: false, dueShown: false
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
  await Promise.all([loadAccounts(), loadSchedules(), loadLists(), api("GET", "/api/settings").then(s => { S.settings = s; })]);
  if (!curAcc()) S.cur = (S.accounts.find(a => norm(a.name) === "ccp") || S.accounts.find(a => !a.closed) || {}).id || null;
  await loadOps(true);
  resetEntry();
  if (!S.dueShown && dueAll().length) { S.dueShown = true; openDue(); }
  if (!S.accounts.length) openImport();
}

/* ---------- chargements ---------- */
async function loadAccounts() { S.accounts = await api("GET", "/api/accounts"); renderTree(); renderStatus(); }
async function loadSchedules() { S.schedules = await api("GET", "/api/schedules"); renderDueBadge(); }
async function loadLists() {
  S.lists = await api("GET", "/api/lists");
  $("#dlModes").innerHTML = S.lists.modes.map(m => `<option value="${esc(m)}">`).join("");
  $("#dlTiers").innerHTML = S.lists.tiers.map(t => `<option value="${esc(t.tiers)}">`).join("");
  $("#dlCats").innerHTML = [...new Set(S.lists.categories.map(c => c.category))].map(c => `<option value="${esc(c)}">`).join("");
  fillSubs("");
}
function fillSubs(cat) {
  const subs = S.lists.categories.filter(c => c.subcategory && (!cat || norm(c.category) === norm(cat))).map(c => c.subcategory);
  $("#dlSubs").innerHTML = [...new Set(subs)].map(s => `<option value="${esc(s)}">`).join("");
}
async function loadOps(scrollEnd) {
  try { localStorage.setItem("registre.cur", S.cur || ""); localStorage.setItem("registre.period", S.period); } catch (e) {}
  if (!S.cur) { S.ops = []; renderGrid(); return; }
  const qs = new URLSearchParams({ period: S.period, q: S.search });
  S.ops = await api("GET", `/api/accounts/${S.cur}/operations?${qs}`);
  renderHead(); renderGrid(); renderStatus();
  if (scrollEnd) { const g = $("#gridwrap"); g.scrollTop = g.scrollHeight; }
}
async function refresh(opts = {}) {
  await Promise.all([loadAccounts(), loadSchedules(), opts.lists ? loadLists() : null]);
  await loadOps(opts.scrollEnd);
}

/* ---------- arborescence des comptes ---------- */
const iconHtml = (a, big) => a && a.icon ? `<img class="acc-icon${big ? " big" : ""}" src="${esc(a.icon)}" alt="">` : `<span class="acc-icon none"></span>`;
function renderTree() {
  let html = "", all = 0;
  const fams = [...new Map(S.accounts.filter(a => !a.closed).map(a => [a.family_id, a.family_name || "Autres comptes"])).entries()];
  for (const [fid, label] of fams) {
    const list = S.accounts.filter(a => a.family_id === fid && !a.closed);
    if (!list.length) continue;
    const tot = list.reduce((s, a) => s + a.today_balance, 0); all += tot;
    html += `<div class="grp"><div class="grp-h"><span>${esc(label)}</span></div>` +
      list.map(a => `<button class="acc ${a.id === S.cur ? "sel" : ""}" data-id="${a.id}" title="${esc(a.name)} : ${a.n} opérations · prévu au ${fmtDate(a.cycle_end)} : ${eur(a.forecast)}">
        <span class="nm">${iconHtml(a)}<span>${esc(a.name)}</span></span>
        <span class="vals"><span class="num ${cls(a.today_balance)}">${eur(a.today_balance)}</span>${a.forecast !== a.today_balance ? `<span class="fc">au ${fmtDate(a.cycle_end).slice(0, 5)} : <span class="${cls(a.forecast)}">${eur(a.forecast)}</span></span>` : ""}</span></button>`).join("") +
      `<div class="grp-total"><span>Total</span><span class="num ${cls(tot)}">${eur(tot)}</span></div></div>`;
  }
  const closed = S.accounts.filter(a => a.closed);
  if (closed.length) html += `<div class="grp"><div class="grp-h"><span>Clôturés</span></div>` + closed.map(a => `<button class="acc closed ${a.id === S.cur ? "sel" : ""}" data-id="${a.id}"><span class="nm">${iconHtml(a)}<span>${esc(a.name)}</span></span><span class="num">${eur(a.today_balance)}</span></button>`).join("") + `</div>`;
  if (S.accounts.length) html += `<div class="total-all"><span>Total général</span><span class="num ${cls(all)}">${eur(all)}</span></div>`;
  else html = `<p class="muted side-empty">Aucun compte. Utilisez « Importer » ou « Paramètres » pour commencer.</p>`;
  $("#accountTree").innerHTML = html;
}
$("#accountTree").addEventListener("click", async ev => {
  const b = ev.target.closest(".acc"); if (!b) return;
  S.cur = Number(b.dataset.id); S.sel = null; closeRecon(); resetEntry(); renderTree();
  await loadOps(true).catch(fail);
});

/* ---------- grille ---------- */
function renderHead() {
  const a = curAcc();
  const cb = $("#classBadge"); cb.textContent = a ? a.unclassified : 0; cb.hidden = !(a && a.unclassified);
  $("#accTitle").textContent = a ? a.name : "Aucun compte";
  const ic = $("#accIcon"); if (a && a.icon) { ic.src = a.icon; ic.hidden = false; } else ic.hidden = true;
  $("#accSub").textContent = a ? `${a.n} opérations · solde de départ ${eur(a.initial)}` : "";
  $("#tbExport").href = a ? `/api/accounts/${a.id}/export` : "#";
}
function upcomingFor(id) {
  const lim = new Date(); lim.setDate(lim.getDate() + Number(S.settings.horizon ?? 7));
  const l = iso(lim);
  return S.schedules.filter(s => (s.account_id === id || s.to_account_id === id) && s.next_date <= l);
}
function opRow(o) {
  const t = todayIso(), x = o.transfer_account ? ` <span class="xfer" title="Virement interne">⇄</span>` : "";
  const c = ["op", o.date > t ? "future" : "", o.pointage === "R" ? "rec" : "", o.id === S.sel ? "sel" : "", o.id === S.edit ? "editing" : ""].join(" ");
  return `<tr class="${c}" data-id="${o.id}">
    <td class="pt ${o.pointage}" title="${o.pointage === "R" ? "Rapprochée" : o.pointage === "P" ? "Pointée : cliquez pour dépointer" : "Cliquez pour pointer"}">${o.pointage === "-" ? "" : o.pointage}</td>
    <td class="num">${fmtDate(o.date)}</td>
    <td title="${esc(o.mode)}">${esc(o.mode)}</td>
    <td title="${esc(o.tiers)}">${esc(o.tiers)}${x}</td>
    <td title="${esc(o.details)}">${esc(o.details)}</td>
    <td title="${esc(o.category)}">${esc(o.category)}</td>
    <td title="${esc(o.subcategory)}">${esc(o.subcategory)}</td>
    <td class="r num deb">${o.amount < 0 ? plain(o.amount) : ""}</td>
    <td class="r num cre">${o.amount > 0 ? plain(o.amount) : ""}</td>
    <td class="r num sol ${cls(o.solde)}">${S.search ? "" : eur(o.solde)}</td>
  </tr>`;
}
function renderGrid() {
  const body = $("#gridBody");
  if (!S.cur) { body.innerHTML = `<tr class="empty"><td colspan="10">Aucun compte. Cliquez sur « Importer » pour reprendre vos données Bank Perfect, ou créez un compte dans « Paramètres ».</td></tr>`; return; }
  let html = S.ops.length ? S.ops.map(opRow).join("") :
    `<tr class="empty"><td colspan="10">${S.search ? "Aucune opération ne correspond à « " + esc(S.search) + " »." : "Aucune opération sur cette période."}</td></tr>`;
  const up = S.search ? [] : upcomingFor(S.cur);
  if (up.length) {
    const t = todayIso();
    html += `<tr class="sep-up"><td colspan="10">Échéances à valider</td></tr>` + up.map(s => {
      const amt = s.account_id === S.cur ? s.amount : -s.amount;
      const tiers = s.to_account_id ? (s.account_id === S.cur ? "Vers " + s.to_account_name : "Depuis " + s.account_name) + " · " + s.tiers : s.tiers;
      return `<tr class="up" data-sid="${s.id}">
        <td class="pt">${s.next_date < t ? "!" : ""}</td><td class="num">${fmtDate(s.next_date)}</td><td>${esc(s.mode)}</td>
        <td title="${esc(tiers)}">${esc(tiers)}</td><td class="acts" colspan="1"><span class="up-acts">${s.account_id === S.cur ? `<button class="btn mini primary" data-act="val">Valider</button><button class="btn mini" data-act="skip">Sauter</button>` : `<span class="muted">sur ${esc(s.account_name)}</span>`}</span></td>
        <td>${esc(s.category)}</td><td>${esc(s.subcategory)}</td>
        <td class="r num deb">${amt < 0 ? plain(amt) : ""}</td><td class="r num cre">${amt > 0 ? plain(amt) : ""}</td><td></td></tr>`;
    }).join("");
  }
  body.innerHTML = html;
}
function selRow(id, scroll) {
  S.sel = id;
  $$("#gridBody tr.sel").forEach(r => r.classList.remove("sel"));
  const tr = $(`#gridBody tr[data-id="${id}"]`);
  if (tr) { tr.classList.add("sel"); if (scroll) tr.scrollIntoView({ block: "nearest" }); }
}
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
  selRow(id);
  if (ev.target.closest("td.pt")) await togglePoint(id);
});
$("#gridBody").addEventListener("dblclick", ev => { const tr = ev.target.closest("tr.op"); if (tr && !ev.target.closest("td.pt")) startEdit(Number(tr.dataset.id)); });

async function togglePoint(id) {
  const o = S.ops.find(x => x.id === id); if (!o) return;
  if (o.pointage === "R") { toast("Opération déjà rapprochée : elle n'est plus modifiable par pointage."); return; }
  const p = o.pointage === "P" ? "-" : "P";
  try {
    await api("PUT", `/api/operations/${id}`, { pointage: p });
    o.pointage = p;
    const tr = $(`#gridBody tr[data-id="${id}"] td.pt`);
    if (tr) { tr.className = "pt " + p; tr.textContent = p === "-" ? "" : p; }
    await loadAccounts(); renderRecon();
  } catch (e) { fail(e); }
}
async function deleteSelected() {
  const o = S.ops.find(x => x.id === S.sel); if (!o) { toast("Sélectionnez d'abord une opération"); return; }
  const ok = await confirmBox("Supprimer l'opération", `Supprimer « ${o.tiers || o.details || "sans libellé"} » du ${fmtDate(o.date)} (${eur(o.amount)}) ?${o.transfer_account ? " Le virement correspondant sur " + (acc(o.transfer_account) || {}).name + " sera aussi supprimé." : ""}`);
  if (!ok) return;
  try { await api("DELETE", `/api/operations/${o.id}`); S.sel = null; if (S.edit === o.id) resetEntry(); toast("Opération supprimée"); await refresh(); } catch (e) { fail(e); }
}

/* ---------- saisie ---------- */
function fillToSelect(sel, exclude, value) {
  sel.innerHTML = `<option value="">—</option>` + S.accounts.filter(a => a.id !== exclude && !a.closed).map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  sel.value = value || "";
}
function resetEntry() {
  S.edit = null;
  $("#entry").reset(); $("#entry").classList.remove("editing");
  $("#entryTitle").textContent = "Nouvelle opération";
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
  $("#entryTitle").textContent = "Modifier l'opération du " + fmtDate(o.date);
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
  if (!$("#fCat").value) $("#fCat").value = t.category || "";
  if (!$("#fSc").value) $("#fSc").value = t.subcategory || "";
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
    `<span>Pointé : <b class="num ${cls(a.pointed)}">${eur(a.pointed)}</b></span>` +
    `<span>Rapproché : <b class="num ${cls(a.reconciled)}">${eur(a.reconciled)}</b></span>` +
    `<span>Prévu au ${fmtDate(a.cycle_end)}${a.cycle_day ? " (fin de cycle)" : ""} : <b class="num ${cls(a.forecast)}">${eur(a.forecast)}</b>${a.forecast_low < a.forecast ? ` · point bas <b class="num ${cls(a.forecast_low)}">${eur(a.forecast_low)}</b> le ${fmtDate(a.forecast_low_date).slice(0, 5)}` : ""}</span>` +
    `<span>${a.unpointed} non pointée${a.unpointed > 1 ? "s" : ""}</span>` +
    `<span>${S.ops.length} affichée${S.ops.length > 1 ? "s" : ""}</span>`;
}

/* ---------- rapprochement ---------- */
function openRecon() { if (!curAcc()) return; S.recon = true; $("#reconBar").hidden = false; $("#tbRecon").classList.add("on"); renderRecon(); $("#reconStmt").focus(); }
function closeRecon() { S.recon = false; $("#reconBar").hidden = true; $("#tbRecon").classList.remove("on"); $("#reconStmt").value = ""; }
function renderRecon() {
  if (!S.recon) return;
  const a = curAcc(); if (!a) return;
  const stmt = parseAmount($("#reconStmt").value);
  $("#reconPointed").textContent = eur(a.pointed);
  const diff = isNaN(stmt) ? null : stmt - a.pointed;
  $("#reconDiff").textContent = diff === null ? "—" : eur(diff);
  $("#reconDiff").className = "num " + (diff ? "neg" : "pos");
  $("#reconOk").disabled = diff !== 0;
}
$("#reconStmt").addEventListener("input", renderRecon);
$("#reconClose").addEventListener("click", closeRecon);
$("#reconOk").addEventListener("click", async () => {
  try { const r = await api("POST", `/api/accounts/${S.cur}/reconcile`, {}); toast(`${r.reconciled} opération${r.reconciled > 1 ? "s" : ""} rapprochée${r.reconciled > 1 ? "s" : ""}`); closeRecon(); await refresh(); }
  catch (e) { fail(e); }
});

/* ---------- échéances à valider ---------- */
function dueAll() {
  const lim = new Date(); lim.setDate(lim.getDate() + Number(S.settings.horizon ?? 7));
  const l = iso(lim);
  return S.schedules.filter(s => s.next_date <= l);
}
function renderDueBadge() { const n = dueAll().length, b = $("#dueBadge"); b.textContent = n; b.hidden = !n; }
function openDue() { renderDue(); $("#dlgDue").showModal(); }
function renderDue() {
  const due = dueAll(), t = todayIso();
  $("#dueIntro").textContent = due.length ? `${due.length} échéance${due.length > 1 ? "s" : ""} arrive${due.length > 1 ? "nt" : ""} dans les ${S.settings.horizon} jours ou sont dépassées. Ajustez la date ou le montant si besoin, puis validez.` : "Aucune échéance à valider pour le moment.";
  $("#dueAll").disabled = !due.length;
  $("#dueTable").innerHTML = `<thead><tr><th>Échéance</th><th>Compte</th><th>Tiers</th><th>Catégorie</th><th>Date de l'opération</th><th class="r">Montant</th><th></th></tr></thead><tbody>` +
    (due.length ? due.map(s => `<tr data-sid="${s.id}" class="${s.next_date < t ? "late" : ""}">
      <td class="num">${fmtDate(s.next_date)}${s.next_date < t ? " · en retard" : ""}</td>
      <td>${esc(s.account_name)}${s.to_account_name ? " → " + esc(s.to_account_name) : ""}</td>
      <td>${esc(s.tiers)}${s.details ? `<div class="muted">${esc(s.details)}</div>` : ""}</td>
      <td>${esc([s.category, s.subcategory].filter(Boolean).join(" / "))}</td>
      <td><input type="date" value="${s.next_date}" data-f="date" aria-label="Date de l'opération"></td>
      <td class="r"><input class="amt" value="${(s.amount < 0 ? "-" : "") + plain(s.amount)}" data-f="amount" aria-label="Montant"></td>
      <td class="acts"><button class="btn mini primary" data-act="val">Valider</button> <button class="btn mini" data-act="skip">Sauter</button></td>
    </tr>`).join("") : `<tr><td colspan="7" class="empty">Rien à valider.</td></tr>`) + "</tbody>";
}
async function validateRow(tr) {
  const sid = Number(tr.dataset.sid);
  const amount = parseAmount(tr.querySelector('[data-f="amount"]').value);
  if (isNaN(amount)) throw new Error("Montant illisible");
  await api("POST", `/api/schedules/${sid}/validate`, { date: tr.querySelector('[data-f="date"]').value, amount });
}
$("#dueTable").addEventListener("click", async ev => {
  const act = ev.target.dataset.act, tr = ev.target.closest("tr[data-sid]"); if (!act || !tr) return;
  try {
    if (act === "val") { await validateRow(tr); toast("Échéance validée"); }
    else { await api("POST", `/api/schedules/${tr.dataset.sid}/skip`, {}); toast("Échéance sautée"); }
    await refresh(); renderDue();
  } catch (e) { fail(e); }
});
$("#dueAll").addEventListener("click", async () => {
  const trs = $$("#dueTable tr[data-sid]"); let n = 0;
  try { for (const tr of trs) { await validateRow(tr); n++; } toast(`${n} échéance${n > 1 ? "s" : ""} validée${n > 1 ? "s" : ""}`); }
  catch (e) { fail(e); }
  await refresh(); renderDue();
});

/* ---------- échéancier ---------- */
let schedEdit = null;
function openSched() {
  fillAccSelect($("#sAcc"), S.cur); fillToSelect($("#sTo"), Number($("#sAcc").value));
  const f = $("#schedFilter"); f.innerHTML = `<option value="">Tous les comptes</option>` + S.accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  f.value = S.cur || "";
  resetSched(); renderSched(); $("#dlgSched").showModal();
}
function fillAccSelect(sel, value) { sel.innerHTML = S.accounts.filter(a => !a.closed).map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join(""); if (value) sel.value = value; }
function resetSched() {
  schedEdit = null; $("#schedForm").reset(); $("#sEvery").value = 1; $("#sUnit").value = "m"; $("#sNext").value = todayIso();
  if (S.cur) $("#sAcc").value = S.cur;
  fillToSelect($("#sTo"), Number($("#sAcc").value));
  $("#schedFormTitle").textContent = "Nouvelle échéance"; $("#sSubmit").textContent = "Ajouter";
}
function renderSched() {
  const f = Number($("#schedFilter").value) || null, t = todayIso();
  const list = S.schedules.filter(s => !f || s.account_id === f || s.to_account_id === f);
  let rec = 0, dep = 0;
  list.forEach(s => { const v = (f && s.account_id !== f) ? -s.per_month : s.per_month; if (v > 0) rec += v; else dep += v; });
  $("#schedTotals").innerHTML = list.length ? `Par mois en moyenne : entrées <b class="num pos">${eur(rec)}</b> · sorties <b class="num neg">${eur(-dep)}</b> · reste <b class="num ${cls(rec + dep)}">${eur(rec + dep)}</b>` : "";
  $("#schedTable").innerHTML = `<thead><tr><th>Prochaine</th><th>Compte</th><th>Tiers</th><th>Catégorie</th><th>Fréquence</th><th>Fin</th><th class="r">Montant</th><th></th></tr></thead><tbody>` +
    (list.length ? list.map(s => `<tr data-sid="${s.id}" class="${s.id === schedEdit ? "editing" : ""} ${s.next_date < t ? "late" : ""}">
      <td class="num">${fmtDate(s.next_date)}</td>
      <td>${esc(s.account_name)}${s.to_account_name ? " → " + esc(s.to_account_name) : ""}</td>
      <td>${esc(s.tiers)}${s.details ? ` <span class="muted">· ${esc(s.details)}</span>` : ""}</td>
      <td>${esc([s.category, s.subcategory].filter(Boolean).join(" / "))}</td>
      <td>${freqLabel(s.unit, s.every)}</td>
      <td class="num">${fmtDate(s.end_date)}</td>
      <td class="r num ${s.amount < 0 ? "neg" : "pos"}">${eur(s.amount)}</td>
      <td class="acts"><button class="btn mini" data-act="edit">Modifier</button> <button class="btn mini danger" data-act="del">Supprimer</button></td>
    </tr>`).join("") : `<tr><td colspan="8" class="empty">Aucune échéance.</td></tr>`) + "</tbody>";
}
$("#schedFilter").addEventListener("change", renderSched);
$("#sAcc").addEventListener("change", () => fillToSelect($("#sTo"), Number($("#sAcc").value), $("#sTo").value));
$("#sCat").addEventListener("change", () => fillSubs($("#sCat").value));
$("#sDeb").addEventListener("input", () => { if ($("#sDeb").value) $("#sCre").value = ""; });
$("#sCre").addEventListener("input", () => { if ($("#sCre").value) $("#sDeb").value = ""; });
$("#sTiers").addEventListener("change", () => {
  const t = S.lists.tiers.find(x => norm(x.tiers) === norm($("#sTiers").value)); if (!t || schedEdit) return;
  if (!$("#sCat").value) $("#sCat").value = t.category || ""; if (!$("#sSc").value) $("#sSc").value = t.subcategory || ""; if (!$("#sMode").value) $("#sMode").value = t.mode || "";
});
$("#sCancel").addEventListener("click", () => { resetSched(); renderSched(); });
$("#schedTable").addEventListener("click", async ev => {
  const act = ev.target.dataset.act, tr = ev.target.closest("tr[data-sid]"); if (!act || !tr) return;
  const s = S.schedules.find(x => x.id === Number(tr.dataset.sid)); if (!s) return;
  if (act === "del") {
    if (!(await confirmBox("Supprimer l'échéance", `Supprimer l'échéance « ${s.tiers} » (${eur(s.amount)}, ${freqLabel(s.unit, s.every).toLowerCase()}) ?`))) return;
    try { await api("DELETE", `/api/schedules/${s.id}`); toast("Échéance supprimée"); await refresh(); renderSched(); } catch (e) { fail(e); }
    return;
  }
  schedEdit = s.id;
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
    resetSched(); await refresh(); renderSched();
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
    const ok = r.bank_balance === null || r.bank_balance === r.balance;
    out.innerHTML = `<p class="ok">${esc(r.account)} : ${r.added} opération${r.added > 1 ? "s" : ""} ajoutée${r.added > 1 ? "s" : ""}${r.duplicates ? `, ${r.duplicates} déjà présente${r.duplicates > 1 ? "s" : ""}` : ""}${r.classified ? `, dont ${r.classified} classée${r.classified > 1 ? "s" : ""} automatiquement` : ""}.</p>` +
      (r.skipped ? `<p class="muted">${r.skipped} ligne${r.skipped > 1 ? "s" : ""} ignorée${r.skipped > 1 ? "s" : ""} (en attente, annulées ou coffres d'épargne).</p>` : "") +
      (r.other_currencies.length ? `<p class="muted">Lignes en ${esc(r.other_currencies.join(", "))} ignorées : seul l'euro est repris.</p>` : "") +
      (r.bank_balance !== null ? `<p class="${ok ? "ok" : "neg"}">Solde Revolut ${eur(r.bank_balance)} · solde Registre ${eur(r.balance)}${ok ? " : concordants." : " : écart à vérifier."}</p>` : "") +
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
      <td><input data-f="cat" list="dlCats" aria-label="Catégorie"></td><td><input data-f="sc" list="dlSubs" aria-label="Sous-catégorie"></td>
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
async function openSettings() {
  FAMS = await api("GET", "/api/families");
  renderAccTable(); renderFams(); renderBackup();
  $("#appVersion").textContent = "Registre, version " + (S.version || "?");
  $("#setHorizon").value = String(S.settings.horizon); $("#dlgSettings").showModal();
}
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
    el.innerHTML = `<p>${b.error ? `<b class="bk-err">${esc(b.error)}</b>` : `<b class="bk-ok">Sauvegarde automatique active</b>`} · une copie par jour, les ${b.keep} dernières sont gardées.</p>
      <p class="muted">Dernière copie : ${b.last ? esc(b.last) : "aucune pour l'instant"} · ${b.count} fichier${b.count > 1 ? "s" : ""} dans le dossier.</p>
      <p>${!b.cloud ? `<span class="muted">Envoi vers OneDrive : pas encore de nouvelles du service de synchronisation.</span>` : b.cloud.ok ? `<b class="bk-ok">Envoyé sur OneDrive</b> le ${esc(b.cloud.when)}` : `<b class="bk-err">Échec de l'envoi sur OneDrive</b> le ${esc(b.cloud.when)} : ${esc(b.cloud.detail)}`}</p>
      <div><button class="btn" id="bkNow">Sauvegarder maintenant</button></div>`;
  } catch (e) { el.innerHTML = ""; }
}
$("#autoBackup").addEventListener("click", async ev => {
  if (ev.target.id !== "bkNow") return;
  try { await api("POST", "/api/backup/now", {}); toast("Copie enregistrée dans le dossier de sauvegarde"); } catch (e) { fail(e); }
  renderBackup();
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
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(f); });
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
$("#tbPoint").addEventListener("click", () => S.sel ? togglePoint(S.sel) : toast("Sélectionnez d'abord une opération"));
$("#tbRecon").addEventListener("click", () => S.recon ? closeRecon() : openRecon());
$("#tbDue").addEventListener("click", openDue);
$("#tbSched").addEventListener("click", openSched);
$("#tbImport").addEventListener("click", openImport);
$("#tbSettings").addEventListener("click", openSettings);
$("#tbExport").addEventListener("click", ev => { if (!curAcc()) { ev.preventDefault(); toast("Aucun compte à exporter"); } });
$("#tbLogout").addEventListener("click", async () => { try { await api("POST", "/api/logout", {}); } catch (e) {} showLogin(false); });
$("#period").addEventListener("change", () => { S.period = $("#period").value; loadOps(true).catch(fail); });
let searchT;
$("#search").addEventListener("input", () => { clearTimeout(searchT); searchT = setTimeout(() => { S.search = $("#search").value.trim(); loadOps(true).catch(fail); }, 250); });
document.addEventListener("keydown", ev => {
  if (document.querySelector("dialog[open]")) return;
  const inField = ev.target.closest("input, select, textarea");
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "n") { ev.preventDefault(); resetEntry(); $("#fDate").focus(); return; }
  if (ev.key === "Escape" && S.edit) { resetEntry(); return; }
  if (inField) return;
  const ids = S.ops.map(o => o.id), i = ids.indexOf(S.sel);
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); const j = i < 0 ? ids.length - 1 : Math.max(0, Math.min(ids.length - 1, i + (ev.key === "ArrowDown" ? 1 : -1))); if (ids[j]) selRow(ids[j], true); }
  else if (ev.key === " " && S.sel) { ev.preventDefault(); togglePoint(S.sel); }
  else if (ev.key === "Delete" && S.sel) { ev.preventDefault(); deleteSelected(); }
  else if (ev.key === "Enter" && S.sel) { ev.preventDefault(); startEdit(S.sel); }
});

boot();
