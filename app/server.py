#!/usr/bin/env python3
"""Registre — gestion de comptes personnels, à héberger soi-même.

Serveur sans dépendance externe : bibliothèque standard Python + SQLite.
Les données sont dans DATA_DIR/registre.db (un volume Docker).
"""
import base64
import calendar
import datetime as dt
import hashlib
import hmac
import io
import json
import mimetypes
import os
import pickle
import re
import secrets
import sqlite3
import tempfile
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DATA_DIR = os.environ.get("DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "registre.db")
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
PORT = int(os.environ.get("PORT", "8080"))
SESSION_DAYS = int(os.environ.get("SESSION_DAYS", "30"))
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "") == "1"
COOKIE = "registre_session"
APP_VERSION = os.environ.get("APP_VERSION", "dev")

LOCK = threading.RLock()
_conn = None


# ---------------------------------------------------------------- base de données

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS categories (category TEXT NOT NULL, subcategory TEXT NOT NULL DEFAULT '', PRIMARY KEY (category, subcategory));
CREATE TABLE IF NOT EXISTS families (id INTEGER PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'courant',
  initial INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS operations (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT '',
  tiers TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  subcategory TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  pointage TEXT NOT NULL DEFAULT '-',
  transfer_id INTEGER,
  schedule_id INTEGER
);
CREATE INDEX IF NOT EXISTS ix_ops_account_date ON operations(account_id, date, id);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  tiers TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  subcategory TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  unit TEXT NOT NULL DEFAULT 'm',
  every INTEGER NOT NULL DEFAULT 1,
  next_date TEXT NOT NULL,
  end_date TEXT NOT NULL DEFAULT '',
  day INTEGER NOT NULL DEFAULT 1
);
"""


def db():
    global _conn
    if _conn is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None, timeout=15)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode = WAL")
        _conn.execute("PRAGMA busy_timeout = 15000")
        _conn.executescript(SCHEMA)
        backup_before_upgrade()
        migrate()
        _conn.execute("INSERT INTO settings(key, value) VALUES('app_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (APP_VERSION,))
    return _conn


def backup_before_upgrade():
    """Copie de sécurité quand une nouvelle version démarre sur des données existantes, avant toute mise à niveau."""
    bdir = os.environ.get("BACKUP_DIR", "")
    prev = _conn.execute("SELECT value FROM settings WHERE key = 'app_version'").fetchone()
    has_data = _conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'accounts'").fetchone() and \
        _conn.execute("SELECT 1 FROM accounts LIMIT 1").fetchone()
    if not bdir or not has_data or (prev and prev[0] == APP_VERSION):
        return
    try:
        name = "registre-avant-%s-%s.db" % (re.sub(r"[^A-Za-z0-9.]", "", APP_VERSION) or "maj", dt.datetime.now().strftime("%Y-%m-%d-%H%M"))
        dst = sqlite3.connect(os.path.join(bdir, name))
        _conn.backup(dst)
        dst.close()
        print("Sauvegarde avant mise à jour : %s" % name, flush=True)
    except Exception as e:
        print("Sauvegarde avant mise à jour impossible : %s" % e, flush=True)


def migrate():
    """Mises à niveau du fichier de données, sans perte."""
    cols = {r[1] for r in _conn.execute("PRAGMA table_info(accounts)")}
    for col, ddl in (("family_id", "INTEGER"), ("icon", "TEXT NOT NULL DEFAULT ''"), ("cycle_day", "INTEGER NOT NULL DEFAULT 0")):
        if col not in cols:
            _conn.execute("ALTER TABLE accounts ADD COLUMN %s %s" % (col, ddl))
    if "ext_id" not in {r[1] for r in _conn.execute("PRAGMA table_info(operations)")}:
        _conn.execute("ALTER TABLE operations ADD COLUMN ext_id TEXT")
    _conn.execute("CREATE INDEX IF NOT EXISTS ix_ops_ext ON operations(ext_id)")
    if "archived" not in {r[1] for r in _conn.execute("PRAGMA table_info(categories)")}:
        _conn.execute("ALTER TABLE categories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
    if not _conn.execute("SELECT 1 FROM families LIMIT 1").fetchone():
        for i, name in enumerate(FAMILIES):
            _conn.execute("INSERT INTO families(name, position) VALUES(?, ?)", (name, i))
    if not _conn.execute("SELECT 1 FROM settings WHERE key = 'layout_v2'").fetchone():
        apply_layout()
        _conn.execute("INSERT INTO settings(key, value) VALUES('layout_v2', '1')")


def q(sql, args=()):
    return db().execute(sql, args)


def rows(sql, args=()):
    return [dict(r) for r in q(sql, args).fetchall()]


def one(sql, args=()):
    r = q(sql, args).fetchone()
    return dict(r) if r else None


def setting(key, default=None):
    r = one("SELECT value FROM settings WHERE key = ?", (key,))
    return r["value"] if r else default


def set_setting(key, value):
    q("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


class Tx:
    """Transaction explicite (la connexion est en autocommit)."""

    def __enter__(self):
        q("BEGIN")

    def __exit__(self, exc_type, *_):
        q("ROLLBACK" if exc_type else "COMMIT")


# ---------------------------------------------------------------- utilitaires

class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def today():
    return dt.date.today().isoformat()


def norm(s):
    s = unicodedata.normalize("NFD", str(s or ""))
    return "".join(c for c in s if unicodedata.category(c) != "Mn").lower().strip()


def parse_amount(s):
    s = re.sub(r"[\s €]", "", str(s or "")).replace("−", "-")
    if not s:
        raise ValueError("montant vide")
    lc, ld = s.rfind(","), s.rfind(".")
    if lc > -1 and ld > -1:
        s = s.replace(".", "").replace(",", ".") if lc > ld else s.replace(",", "")
    elif lc > -1:
        s = s.replace(",", ".")
    return int(round(float(s) * 100))


def valid_date(s):
    try:
        return dt.date.fromisoformat(str(s)).isoformat()
    except ValueError:
        raise ApiError(400, "Date invalide : " + str(s))


def advance(date_iso, unit, every, day):
    d = dt.date.fromisoformat(date_iso)
    every = max(1, int(every or 1))
    if unit == "d":
        return (d + dt.timedelta(days=every)).isoformat()
    if unit == "w":
        return (d + dt.timedelta(weeks=every)).isoformat()
    months = every * (12 if unit == "y" else 1)
    m0 = d.month - 1 + months
    y, m = d.year + m0 // 12, m0 % 12 + 1
    last = calendar.monthrange(y, m)[1]
    return dt.date(y, m, min(int(day or d.day), last)).isoformat()


def end_of_month(d=None):
    d = d or dt.date.today()
    return dt.date(d.year, d.month, calendar.monthrange(d.year, d.month)[1]).isoformat()


def per_month(amount, unit, every):
    every = max(1, int(every or 1))
    if unit == "d":
        return round(amount * 365 / 12 / every)
    if unit == "w":
        return round(amount * 52 / 12 / every)
    return round(amount / (every * (12 if unit == "y" else 1)))


# ---------------------------------------------------------------- authentification

def hash_password(pw, salt=None):
    salt = salt or secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(h).decode()


def check_password(pw, stored):
    try:
        _, salt, h = stored.split("$")
        return hmac.compare_digest(hash_password(pw, base64.b64decode(salt)), stored)
    except Exception:
        return False


_failures = []


def new_session():
    token = secrets.token_urlsafe(32)
    q("DELETE FROM sessions WHERE expires < ?", (int(time.time()),))
    q("INSERT INTO sessions(token, expires) VALUES(?, ?)", (token, int(time.time()) + SESSION_DAYS * 86400))
    return token


def session_ok(token):
    if not token:
        return False
    r = one("SELECT expires FROM sessions WHERE token = ?", (token,))
    return bool(r and r["expires"] > time.time())


# ---------------------------------------------------------------- comptes

def account_or_404(acc_id):
    a = one("SELECT * FROM accounts WHERE id = ?", (acc_id,))
    if not a:
        raise ApiError(404, "Compte introuvable")
    return a


def cycle_end(cycle_day, ref=None):
    """Date de fin de cycle : la veille du salaire (jour donné) ou la fin du mois."""
    t = ref or dt.date.today()
    if not cycle_day:
        return end_of_month(t)
    day = min(int(cycle_day), 28)
    if t.day <= day:
        return dt.date(t.year, t.month, day).isoformat()
    y, m = (t.year + 1, 1) if t.month == 12 else (t.year, t.month + 1)
    return dt.date(y, m, day).isoformat()


def forecast_detail(acc_id, until):
    """Mouvements prévus d'aujourd'hui (exclu) jusqu'à la date donnée : opérations déjà saisies
    à une date future, puis occurrences des échéances (y compris les virements reçus d'autres comptes)."""
    a = account_or_404(acc_id)
    t = today()
    start = a["initial"] + (one("SELECT COALESCE(SUM(amount), 0) AS s FROM operations WHERE account_id = ? AND date <= ?", (acc_id, t))["s"])
    items = []
    for o in rows("SELECT * FROM operations WHERE account_id = ? AND date > ? AND date <= ? ORDER BY date, id", (acc_id, t, until)):
        items.append({"date": o["date"], "tiers": o["tiers"], "details": o["details"], "category": o["category"],
                      "subcategory": o["subcategory"], "amount": o["amount"], "kind": "saisie", "late": False})
    for sc in rows("""SELECT s.*, a.name AS account_name, b.name AS to_account_name FROM schedules s
                      JOIN accounts a ON a.id = s.account_id LEFT JOIN accounts b ON b.id = s.to_account_id
                      WHERE s.account_id = ? OR s.to_account_id = ?""", (acc_id, acc_id)):
        own = sc["account_id"] == acc_id
        d, guard = sc["next_date"], 0
        while d <= until and (not sc["end_date"] or d <= sc["end_date"]) and guard < 1200:
            label = sc["tiers"] if own else "Depuis %s · %s" % (sc["account_name"], sc["tiers"])
            if own and sc["to_account_name"]:
                label = "Vers %s · %s" % (sc["to_account_name"], sc["tiers"])
            items.append({"date": d, "tiers": label, "details": sc["details"], "category": sc["category"], "subcategory": sc["subcategory"],
                          "amount": sc["amount"] if own else -sc["amount"], "kind": "echeance", "schedule_id": sc["id"], "late": d < t})
            d = advance(d, sc["unit"], sc["every"], sc["day"])
            guard += 1
    items.sort(key=lambda i: (max(i["date"], t), 0 if i["amount"] > 0 else 1))
    bal, low, low_date = start, start, t
    for i in items:
        bal += i["amount"]
        i["solde"] = bal
        if bal < low:
            low, low_date = bal, max(i["date"], t)
    return {"account_id": acc_id, "name": a["name"], "until": until, "start": start, "end": bal, "low": low, "low_date": low_date,
            "count": len(items), "in": sum(i["amount"] for i in items if i["amount"] > 0), "out": sum(i["amount"] for i in items if i["amount"] < 0),
            "items": items}


def list_accounts():
    accs = rows("""
      SELECT a.*, f.name AS family_name, f.position AS family_position, COUNT(o.id) AS n,
        a.initial + COALESCE(SUM(o.amount), 0) AS balance,
        a.initial + COALESCE(SUM(CASE WHEN o.pointage IN ('P','R') THEN o.amount END), 0) AS pointed,
        a.initial + COALESCE(SUM(CASE WHEN o.pointage = 'R' THEN o.amount END), 0) AS reconciled,
        COALESCE(SUM(CASE WHEN o.pointage = '-' THEN 1 END), 0) AS unpointed,
        COALESCE(SUM(CASE WHEN o.category = '' THEN 1 END), 0) AS unclassified,
        COALESCE(SUM(CASE WHEN o.date > ? THEN o.amount END), 0) AS future
      FROM accounts a LEFT JOIN operations o ON o.account_id = a.id LEFT JOIN families f ON f.id = a.family_id
      GROUP BY a.id ORDER BY a.closed, COALESCE(f.position, 999), a.position, a.id""", (today(),))
    for a in accs:
        a["today_balance"] = a["balance"] - a["future"]
        a["cycle_end"] = cycle_end(a["cycle_day"])
        f = forecast_detail(a["id"], a["cycle_end"])
        a["forecast"], a["forecast_count"], a["forecast_low"], a["forecast_low_date"] = f["end"], f["count"], f["low"], f["low_date"]
    return accs


def list_families():
    return rows("""SELECT f.*, COUNT(a.id) AS n FROM families f LEFT JOIN accounts a ON a.family_id = f.id
                   GROUP BY f.id ORDER BY f.position, f.id""")


def name_key(s):
    """Nom de compte comparable : sans accents, casse, espaces ni ponctuation (« Livret A - Tess » = « Livret A Tess »)."""
    return re.sub(r"[^a-z0-9]", "", norm(s))


def account_by_name(name):
    for a in rows("SELECT * FROM accounts"):
        if name_key(a["name"]) == name_key(name):
            return a
    return None


# Plan de comptes voulu : familles, ordre, icônes et fin de cycle.
FAMILIES = ["Comptes courants", "Livrets"]
LAYOUT = [
    # (nom affiché, famille, position, icône, jour de fin de cycle, créer s'il manque)
    ("CCP", "Comptes courants", 1, "/icons/banque-postale.png", 19, False),
    ("CE Joint", "Comptes courants", 2, "/icons/banque-postale.png", 0, False),
    ("Revolut Perso", "Comptes courants", 3, "/icons/revolut.png", 0, True),
    ("Revolut Joint", "Comptes courants", 4, "/icons/revolut.png", 0, True),
    ("Livret A", "Livrets", 1, "/icons/banque-postale.png", 0, False),
    ("Livret A - Tess", "Livrets", 2, "/icons/banque-postale.png", 0, False),
    ("Livret A - Yona", "Livrets", 3, "/icons/banque-postale.png", 0, False),
    ("LDDS", "Livrets", 4, "/icons/banque-postale.png", 0, False),
]


def family_id(name):
    r = _conn.execute("SELECT id FROM families WHERE name = ?", (name,)).fetchone()
    if r:
        return r[0]
    pos = _conn.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM families").fetchone()[0]
    return _conn.execute("INSERT INTO families(name, position) VALUES(?, ?)", (name, pos)).lastrowid


def layout_for(name):
    return next((l for l in LAYOUT if name_key(l[0]) == name_key(name)), None)


def place_account(acc_id, name):
    """Range un compte selon le plan de comptes, ou dans la famille la plus probable."""
    l = layout_for(name)
    if l:
        _conn.execute("UPDATE accounts SET name = ?, family_id = ?, position = ?, icon = CASE WHEN icon = '' THEN ? ELSE icon END, cycle_day = ? WHERE id = ?",
                      (l[0], family_id(l[1]), l[2], l[3], l[4], acc_id))
    else:
        n = norm(name)
        fam = "Livrets" if any(w in n for w in ("livret", "ldd", "pel", "cel", "epargne")) else "Comptes courants"
        pos = _conn.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM accounts WHERE family_id = ?", (family_id(fam),)).fetchone()[0]
        _conn.execute("UPDATE accounts SET family_id = ?, position = ? WHERE id = ?", (family_id(fam), pos, acc_id))


def apply_layout():
    for (acc_id, name) in _conn.execute("SELECT id, name FROM accounts").fetchall():
        place_account(acc_id, name)
    for l in LAYOUT:
        if l[5] and not any(name_key(r[0]) == name_key(l[0]) for r in _conn.execute("SELECT name FROM accounts")):
            acc_id = _conn.execute("INSERT INTO accounts(name, kind, initial, position) VALUES(?, 'courant', 0, 0)", (l[0],)).lastrowid
            place_account(acc_id, l[0])


def create_account(name, kind="courant", initial=0, family=None):
    name = (name or "").strip()
    if not name:
        raise ApiError(400, "Donnez un nom au compte")
    cur = q("INSERT INTO accounts(name, kind, initial, position) VALUES(?, ?, ?, 0)", (name, kind, int(initial or 0)))
    place_account(cur.lastrowid, name)
    if family:
        pos = one("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM accounts WHERE family_id = ?", (int(family),))["p"]
        q("UPDATE accounts SET family_id = ?, position = ? WHERE id = ?", (int(family), pos, cur.lastrowid))
    return cur.lastrowid


# ---------------------------------------------------------------- opérations

OP_FIELDS = ("date", "mode", "tiers", "details", "category", "subcategory", "amount", "pointage")


def clean_op(d, partial=False):
    out = {}
    for k in OP_FIELDS:
        if k not in d:
            if not partial and k in ("date", "amount"):
                raise ApiError(400, "Champ manquant : " + k)
            continue
        v = d[k]
        if k == "date":
            v = valid_date(v)
        elif k == "amount":
            try:
                v = int(v) if isinstance(v, int) else parse_amount(v)
            except ValueError:
                raise ApiError(400, "Montant invalide")
        elif k == "pointage":
            v = v if v in ("-", "P", "R") else "-"
        else:
            v = str(v or "").strip()[:300]
        out[k] = v
    return out


def insert_op(acc_id, o, schedule_id=None):
    cur = q("""INSERT INTO operations(account_id, date, mode, tiers, details, category, subcategory, amount, pointage, schedule_id)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (acc_id, o["date"], o.get("mode", ""), o.get("tiers", ""), o.get("details", ""), o.get("category", ""),
             o.get("subcategory", ""), o["amount"], o.get("pointage", "-"), schedule_id))
    return cur.lastrowid


def create_operation(acc_id, o, to_acc=None, schedule_id=None):
    src = account_or_404(acc_id)
    if not to_acc or int(to_acc) == int(acc_id):
        return insert_op(acc_id, o, schedule_id)
    dst = account_or_404(to_acc)
    out = o["amount"] < 0
    label = o.get("details") or (o.get("tiers") if not o.get("tiers", "").startswith("Transfert ") else "")
    a = dict(o, tiers=("Transfert vers le compte " if out else "Transfert depuis le compte ") + dst["name"],
             details=label, mode=o.get("mode") or ("Virement émis" if out else "Virement reçu"))
    b = dict(o, tiers=("Transfert depuis le compte " if out else "Transfert vers le compte ") + src["name"],
             details=label, amount=-o["amount"], pointage="-", mode="Virement reçu" if out else "Virement émis")
    ida = insert_op(acc_id, a, schedule_id)
    idb = insert_op(dst["id"], b, schedule_id)
    q("UPDATE operations SET transfer_id = ? WHERE id = ?", (idb, ida))
    q("UPDATE operations SET transfer_id = ? WHERE id = ?", (ida, idb))
    return ida


def list_operations(acc_id, period="12m", search=""):
    a = account_or_404(acc_id)
    base = """SELECT o.*, ? + SUM(o.amount) OVER (ORDER BY o.date, o.id ROWS UNBOUNDED PRECEDING) AS solde,
                     t.account_id AS transfer_account
              FROM operations o LEFT JOIN operations t ON t.id = o.transfer_id
              WHERE o.account_id = ?"""
    args = [a["initial"], acc_id]
    where, wargs = [], []
    if search:
        like = "%" + search.strip() + "%"
        where.append("(tiers LIKE ? OR details LIKE ? OR category LIKE ? OR subcategory LIKE ? OR mode LIKE ? OR printf('%.2f', abs(amount)/100.0) LIKE ?)")
        wargs += [like] * 5 + ["%" + search.strip().replace(",", ".") + "%"]
    else:
        start = None
        t = dt.date.today()
        if period == "1m":
            start = dt.date(t.year, t.month, 1)
        elif period == "3m":
            start = (t.replace(day=1) - dt.timedelta(days=62)).replace(day=1)
        elif period == "12m":
            start = dt.date(t.year - 1, t.month, 1)
        elif period == "year":
            start = dt.date(t.year, 1, 1)
        elif period == "lastyear":
            start = dt.date(t.year - 1, 1, 1)
            where.append("date < ?")
            wargs.append(dt.date(t.year, 1, 1).isoformat())
        elif period == "unclassified":
            where.append("category = ''")
        elif period == "unpointed":
            where.append("pointage = '-'")
        if start:
            where.append("date >= ?")
            wargs.append(start.isoformat())
    sql = "SELECT * FROM (" + base + ")" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY date, id"
    ops = rows(sql, args + wargs)
    return ops


def update_operation(op_id, d):
    op = one("SELECT * FROM operations WHERE id = ?", (op_id,))
    if not op:
        raise ApiError(404, "Opération introuvable")
    o = clean_op(d, partial=True)
    if o:
        q("UPDATE operations SET " + ", ".join(k + " = ?" for k in o) + " WHERE id = ?", list(o.values()) + [op_id])
    if op["transfer_id"]:
        mirror = {}
        if "date" in o:
            mirror["date"] = o["date"]
        if "amount" in o:
            mirror["amount"] = -o["amount"]
        if "details" in o:
            mirror["details"] = o["details"]
        if mirror:
            q("UPDATE operations SET " + ", ".join(k + " = ?" for k in mirror) + " WHERE id = ?", list(mirror.values()) + [op["transfer_id"]])


def delete_operation(op_id):
    op = one("SELECT * FROM operations WHERE id = ?", (op_id,))
    if not op:
        raise ApiError(404, "Opération introuvable")
    q("DELETE FROM operations WHERE id IN (?, ?)", (op_id, op["transfer_id"] or -1))


def lists():
    cats = rows("""SELECT category, subcategory, SUM(n) AS n FROM (
                     SELECT category, subcategory, COUNT(*) AS n FROM operations WHERE category <> '' GROUP BY category, subcategory
                     UNION ALL SELECT category, subcategory, 0 FROM categories WHERE category <> '')
                   GROUP BY category, subcategory ORDER BY category COLLATE NOCASE, subcategory COLLATE NOCASE""")
    arch = archived_keys()
    for c in cats:
        c["cat_archived"] = 1 if (c["category"], "") in arch else 0
        c["archived"] = 1 if c["cat_archived"] or (c["category"], c["subcategory"]) in arch else 0
    tiers = rows("""SELECT tiers, category, subcategory, mode, MAX(date) AS last FROM operations
                    WHERE tiers <> '' AND tiers NOT LIKE 'Transfert %' GROUP BY tiers ORDER BY last DESC LIMIT 1500""")
    modes = [r["mode"] for r in rows("SELECT mode, COUNT(*) n FROM operations WHERE mode <> '' AND mode NOT LIKE 'Chq %' GROUP BY mode ORDER BY n DESC LIMIT 20")]
    return {"categories": cats, "tiers": tiers, "modes": modes}


# ---------------------------------------------------------------- échéancier

SCHED_FIELDS = ("account_id", "to_account_id", "tiers", "details", "category", "subcategory", "mode", "amount", "unit", "every", "next_date", "end_date")


def clean_schedule(d, partial=False):
    out = {}
    for k in SCHED_FIELDS:
        if k not in d:
            if not partial and k in ("account_id", "amount", "next_date"):
                raise ApiError(400, "Champ manquant : " + k)
            continue
        v = d[k]
        if k in ("account_id", "to_account_id"):
            v = int(v) if v not in (None, "", 0, "0") else None
            if v:
                account_or_404(v)
        elif k == "amount":
            try:
                v = int(v) if isinstance(v, int) else parse_amount(v)
            except ValueError:
                raise ApiError(400, "Montant invalide")
        elif k == "unit":
            v = v if v in ("d", "w", "m", "y") else "m"
        elif k == "every":
            v = max(1, min(366, int(v or 1)))
        elif k == "next_date":
            v = valid_date(v)
        elif k == "end_date":
            v = valid_date(v) if v else ""
        else:
            v = str(v or "").strip()[:300]
        out[k] = v
    if "next_date" in out:
        out["day"] = int(out["next_date"][8:10])
    if out.get("to_account_id") and out.get("to_account_id") == out.get("account_id"):
        out["to_account_id"] = None
    return out


def list_schedules():
    out = rows("""SELECT s.*, a.name AS account_name, b.name AS to_account_name FROM schedules s
                  JOIN accounts a ON a.id = s.account_id LEFT JOIN accounts b ON b.id = s.to_account_id
                  ORDER BY s.next_date, a.position, s.id""")
    for s in out:
        s["per_month"] = per_month(s["amount"], s["unit"], s["every"])
    return out


def advance_schedule(s):
    nxt = advance(s["next_date"], s["unit"], s["every"], s["day"])
    if s["end_date"] and nxt > s["end_date"]:
        q("DELETE FROM schedules WHERE id = ?", (s["id"],))
        return None
    q("UPDATE schedules SET next_date = ? WHERE id = ?", (nxt, s["id"]))
    return nxt


def validate_schedule(sid, d):
    s = one("SELECT * FROM schedules WHERE id = ?", (sid,))
    if not s:
        raise ApiError(404, "Échéance introuvable")
    o = {"date": valid_date(d.get("date") or s["next_date"]), "mode": s["mode"], "tiers": s["tiers"], "details": s["details"],
         "category": s["category"], "subcategory": s["subcategory"], "pointage": "-",
         "amount": parse_amount(d["amount"]) if d.get("amount") not in (None, "") and not isinstance(d.get("amount"), int) else int(d.get("amount") or s["amount"])}
    with Tx():
        op_id = create_operation(s["account_id"], o, s["to_account_id"], schedule_id=sid)
        nxt = advance_schedule(s)
    return {"operation_id": op_id, "next_date": nxt}


# ---------------------------------------------------------------- imports Bank Perfect

def split_csv_line(line):
    out, cur, quoted, i = [], "", False, 0
    while i < len(line):
        c = line[i]
        if quoted:
            if c == '"':
                if i + 1 < len(line) and line[i + 1] == '"':
                    cur += '"'
                    i += 1
                else:
                    quoted = False
            else:
                cur += c
        elif c == '"':
            quoted = True
        elif c == ";":
            out.append(cur)
            cur = ""
        else:
            cur += c
        i += 1
    out.append(cur)
    return out


def parse_bp_csv(text):
    lines = [l for l in text.lstrip("﻿").splitlines() if l.strip()]
    if not lines:
        raise ApiError(400, "Fichier vide")
    head = [norm(h) for h in split_csv_line(lines[0])]

    def ix(n):
        return head.index(n) if n in head else -1

    I = {k: ix(n) for k, n in (("d", "date"), ("mode", "mode"), ("t", "tiers"), ("det", "details"), ("cat", "categorie"),
                                ("sc", "sous-categorie"), ("mt", "montant"), ("p", "pointage"))}
    if I["d"] < 0 or I["mt"] < 0:
        raise ApiError(400, "Ce fichier n'a pas le format d'un export de compte Bank Perfect")

    def col(c, k):
        return c[I[k]].strip() if 0 <= I[k] < len(c) else ""

    initial, ops = None, []
    for line in lines[1:]:
        c = split_csv_line(line)
        m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", col(c, "d"))
        if not m:
            continue
        try:
            amount = parse_amount(col(c, "mt"))
        except ValueError:
            continue
        d = "%s-%02d-%02d" % (m.group(3), int(m.group(2)), int(m.group(1)))
        tiers = re.sub(r"^\[auto\]\s*", "", col(c, "t"), flags=re.I)
        if tiers == "Solde initial" and initial is None and not ops:
            initial = amount
            continue
        p = col(c, "p").upper()[:1]
        ops.append({"date": d, "mode": col(c, "mode"), "tiers": tiers, "details": col(c, "det"), "category": col(c, "cat"),
                    "subcategory": col(c, "sc"), "amount": amount, "pointage": p if p in ("P", "R") else "-"})
    return initial or 0, ops


def op_key(o):
    return (o["date"], o["amount"], o["tiers"], o["details"], o["category"], o["subcategory"])


def import_csv(name, text):
    initial, ops = parse_bp_csv(text)
    with Tx():
        a = account_by_name(name)
        created = not a
        if created:
            acc_id = create_account(name, guess_kind(name), initial)
        else:
            acc_id = a["id"]
            if not one("SELECT 1 FROM operations WHERE account_id = ? LIMIT 1", (acc_id,)):
                q("UPDATE accounts SET initial = ? WHERE id = ?", (initial, acc_id))
        have = {}
        for o in rows("SELECT * FROM operations WHERE account_id = ?", (acc_id,)):
            have[op_key(o)] = have.get(op_key(o), 0) + 1
        added = dup = 0
        for o in ops:
            k = op_key(o)
            if have.get(k, 0) > 0:
                have[k] -= 1
                dup += 1
                continue
            insert_op(acc_id, o)
            added += 1
    return {"account_id": acc_id, "created": created, "added": added, "duplicates": dup}


def guess_kind(name):
    n = norm(name)
    return "epargne" if any(w in n for w in ("livret", "ldd", "pel", "cel", "epargne", "assurance")) else "courant"


class SafeUnpickler(pickle.Unpickler):
    """N'accepte que les types de base : aucune classe ne peut être chargée."""

    def find_class(self, module, name):
        raise pickle.UnpicklingError("contenu non autorisé")


def parse_bpsched(raw):
    data = raw.replace(b"\r\n", b"\n")
    try:
        items = SafeUnpickler(io.BytesIO(data), encoding="latin1").load()
    except Exception:
        raise ApiError(400, "Ce fichier n'est pas un échéancier Bank Perfect lisible")
    out = []
    for r in items if isinstance(items, list) else []:
        if not isinstance(r, dict) or not r.get("nextdate") or not r["nextdate"][0]:
            continue
        unit = {0: "d", 1: "m", 2: "y", 3: "w"}.get(int(r.get("deltaunit", 1)), "m")
        y, m, d = r["nextdate"]
        ey, em, ed = r.get("enddate") or (0, 0, 0)
        out.append({
            "bp_account": int(r.get("account", -1)),
            "bp_transfer": int(r["transfer"]) if int(r.get("transfer", -1)) >= 0 else None,
            "tiers": str(r.get("tiers") or ""), "details": str(r.get("details") or ""),
            "amount": int(round(float(r.get("montant", 0)) * 100)),
            "unit": unit, "every": int(r.get("delta") or 1),
            "next_date": "%04d-%02d-%02d" % (y, m, d), "end_date": "%04d-%02d-%02d" % (ey, em, ed) if ey else "",
            "mode": {3: "Prélèvement", 4: "Virement émis"}.get(int(r.get("mode", 0)), "Virement reçu" if float(r.get("montant", 0)) > 0 else ""),
        })
    return out


def guess_bp_mapping(items):
    accs = rows("SELECT * FROM accounts")

    def by_name(n):
        return next((a["id"] for a in accs if norm(a["name"]) == n), None)

    g = {}
    for num in sorted({i["bp_account"] for i in items}):
        t = [norm(i["tiers"]) for i in items if i["bp_account"] == num]
        if "salaire" in t:
            g[num] = by_name("ccp")
        elif any(w in x for x in t for w in ("adeline", "edf", "saur")):
            g[num] = by_name("ce joint") or next((a["id"] for a in accs if "joint" in norm(a["name"]) and "revolut" not in norm(a["name"])), None)
    if 1 not in g and by_name("ccp"):
        g[1] = by_name("ccp")
    for i in items:
        to = i["bp_transfer"]
        if to is None or g.get(to) or not g.get(i["bp_account"]):
            continue
        hit = one("""SELECT tiers FROM operations WHERE account_id = ? AND amount = ? AND tiers LIKE 'Transfert vers le compte %'
                     ORDER BY date DESC LIMIT 1""", (g[i["bp_account"]], i["amount"]))
        if hit:
            g[to] = by_name(norm(hit["tiers"][len("Transfert vers le compte "):]))
    return {str(k): v for k, v in g.items() if v}


def import_bpsched(raw, mapping):
    items = parse_bpsched(raw)
    mapping = {int(k): int(v) for k, v in (mapping or {}).items() if v}
    added = dup = with_cat = 0
    with Tx():
        have = {(s["account_id"], s["tiers"], s["amount"], s["next_date"]) for s in rows("SELECT * FROM schedules")}
        for i in items:
            acc = mapping.get(i["bp_account"])
            if not acc:
                continue
            to = mapping.get(i["bp_transfer"]) if i["bp_transfer"] is not None else None
            if to == acc:
                to = None
            if (acc, i["tiers"], i["amount"], i["next_date"]) in have:
                dup += 1
                continue
            cat = one("""SELECT category, subcategory FROM operations WHERE account_id = ? AND category <> ''
                         AND (tiers = ? COLLATE NOCASE OR (tiers = ? COLLATE NOCASE AND amount = ?)) ORDER BY date DESC LIMIT 1""",
                      (acc, i["tiers"], "Transfert vers le compte " + (one("SELECT name FROM accounts WHERE id = ?", (to,)) or {"name": ""})["name"], i["amount"]))
            if cat:
                with_cat += 1
            q("""INSERT INTO schedules(account_id, to_account_id, tiers, details, category, subcategory, mode, amount, unit, every, next_date, end_date, day)
                 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
              (acc, to, i["tiers"], i["details"], (cat or {}).get("category", ""), (cat or {}).get("subcategory", ""), i["mode"],
               i["amount"], i["unit"], i["every"], i["next_date"], i["end_date"], int(i["next_date"][8:10])))
            added += 1
    return {"added": added, "duplicates": dup, "with_category": with_cat}


# ---------------------------------------------------------------- Revolut et classement

REVOLUT_COLS = {
    "type": ("type",), "product": ("product", "produit"), "started": ("started date", "date de debut", "date de début"),
    "completed": ("completed date", "date de fin", "date de realisation", "date d'execution"), "description": ("description",),
    "amount": ("amount", "montant"), "fee": ("fee", "frais"), "currency": ("currency", "devise"), "state": ("state", "etat", "statut"),
    "balance": ("balance", "solde"),
}
REVOLUT_MODES = {
    "card_payment": "Carte", "paiement par carte": "Carte", "card_refund": "Remboursement carte", "remboursement de carte": "Remboursement carte",
    "topup": "Rechargement", "rechargement": "Rechargement", "transfer": "Virement", "virement": "Virement", "exchange": "Change", "change": "Change",
    "atm": "Retrait", "retrait": "Retrait", "fee": "Frais", "frais": "Frais", "reward": "Récompense", "cashback": "Cashback",
}
REVOLUT_SKIP_STATES = ("pending", "reverted", "declined", "failed", "en attente", "annule", "refuse", "rejete", "echoue", "renvoye", "rembourse", "expire")


def split_any(line, sep):
    if sep == ";":
        return split_csv_line(line)
    out, cur, quoted, i = [], "", False, 0
    while i < len(line):
        c = line[i]
        if quoted:
            if c == '"':
                if i + 1 < len(line) and line[i + 1] == '"':
                    cur += '"'; i += 1
                else:
                    quoted = False
            else:
                cur += c
        elif c == '"':
            quoted = True
        elif c == sep:
            out.append(cur); cur = ""
        else:
            cur += c
        i += 1
    out.append(cur)
    return out


REVOLUT_PENDING_STATES = ("pending", "en attente")
REVOLUT_REVERTED_STATES = ("reverted", "renvoye", "rembourse", "annule", "declined", "refuse", "rejete", "failed", "echoue", "expire")


def parse_revolut_csv(text):
    """Lit un relevé Revolut (anglais ou français). Renvoie les opérations terminées et les paiements en attente
    (marqués pending), ainsi que les clés des opérations annulées, pour retirer un paiement en attente qui n'a jamais abouti."""
    lines = [l for l in text.lstrip("\ufeff").splitlines() if l.strip()]
    if not lines:
        raise ApiError(400, "Fichier vide")
    sep = ";" if lines[0].count(";") > lines[0].count(",") else ","
    head = [norm(h) for h in split_any(lines[0], sep)]
    idx = {}
    for key, names in REVOLUT_COLS.items():
        idx[key] = next((head.index(norm(n)) for n in names if norm(n) in head), -1)
    if idx["amount"] < 0 or idx["description"] < 0 or (idx["completed"] < 0 and idx["started"] < 0):
        raise ApiError(400, "Ce fichier n'a pas le format d'un relevé Revolut (colonnes Date, Description, Montant attendues)")
    out, reverted, skipped, other_cur = [], set(), 0, set()
    for line in lines[1:]:
        c = split_any(line, sep)
        col = lambda k: c[idx[k]].strip() if 0 <= idx[k] < len(c) else ""
        if any(w in norm(col("product")) for w in ("savings", "deposit", "epargne", "coffre", "vault", "pocket")):
            skipped += 1          # mouvements internes aux coffres / Pockets
            continue
        cur = col("currency").upper()
        if cur and cur != "EUR":
            other_cur.add(cur)
            continue
        state = norm(col("state"))
        pkey = "attente-" + hashlib.sha1("|".join([col("started"), col("description"), col("amount")]).encode()).hexdigest()
        if any(state.startswith(x) for x in REVOLUT_REVERTED_STATES):
            reverted.add(pkey)
            skipped += 1
            continue
        pending = any(state.startswith(x) for x in REVOLUT_PENDING_STATES) or (idx["completed"] >= 0 and not col("completed"))
        raw_date = col("started") if pending else (col("completed") or col("started"))
        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", raw_date) or re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})", raw_date)
        if not m:
            skipped += 1
            continue
        date = raw_date[:10] if "-" in raw_date[:10] else "%s-%02d-%02d" % (m.group(3), int(m.group(2)), int(m.group(1)))
        try:
            amount = parse_amount(col("amount"))
            fee = abs(parse_amount(col("fee"))) if col("fee") else 0
            balance = parse_amount(col("balance")) if col("balance") and not pending else None
        except ValueError:
            skipped += 1
            continue
        typ = col("type")
        out.append({"date": date, "started": col("started"), "completed": "" if pending else col("completed"), "tiers": col("description"),
                    "amount": amount, "fee": 0 if pending else fee, "balance": balance, "pending": pending, "pkey": pkey,
                    "mode": REVOLUT_MODES.get(norm(typ), typ.capitalize() if typ else ""),
                    "ext": pkey if pending else hashlib.sha1("|".join([col("started"), col("completed"), col("description"), col("amount"), col("fee"), col("balance")]).encode()).hexdigest()})
    return out, reverted, skipped, sorted(other_cur)


def guess_category(tiers):
    if not tiers:
        return None
    r = one("""SELECT category, subcategory FROM operations WHERE tiers = ? COLLATE NOCASE AND category <> ''
               ORDER BY date DESC, id DESC LIMIT 1""", (tiers,))
    return r


POCKET_RE = re.compile(r"^(sur la pocket|depuis la pocket|vers la pocket|to pocket|from pocket|pocket withdrawal|pocket top-up)", re.I)


def revolut_category(tiers):
    cat = guess_category(tiers)
    if cat:
        return cat
    if POCKET_RE.match(tiers or ""):
        return {"category": "Epargne", "subcategory": "Arrondis Revolut"}
    return None


def import_revolut(acc_id, text):
    """Importe un relevé Revolut sans doublons. Les paiements en attente sont inscrits non pointés ;
    à l'import suivant, ils sont finalisés (date, montant, pointage) ou retirés s'ils ont été annulés."""
    a = account_or_404(acc_id)
    rows_in, reverted, skipped, other_cur = parse_revolut_csv(text)
    rows_in.sort(key=lambda r: (r["date"], r["started"]))
    done_rows = sorted((r for r in rows_in if not r["pending"]), key=lambda r: (r["completed"] or r["date"], r["started"]))
    added = dup = classified = finalised = cancelled = pending_n = 0
    initial_set = False
    with Tx():
        empty = not one("SELECT 1 FROM operations WHERE account_id = ? LIMIT 1", (acc_id,))
        if empty and done_rows and done_rows[0]["balance"] is not None:
            f = done_rows[0]
            q("UPDATE accounts SET initial = ? WHERE id = ?", (f["balance"] - f["amount"] + f["fee"], acc_id))
            initial_set = True
        for k in reverted:
            cancelled += q("DELETE FROM operations WHERE account_id = ? AND ext_id = ?", (acc_id, k)).rowcount
        for r in rows_in:
            if one("SELECT 1 FROM operations WHERE account_id = ? AND ext_id = ?", (acc_id, r["ext"])):
                dup += 1
                continue
            if not r["pending"]:
                prev = one("SELECT id FROM operations WHERE account_id = ? AND ext_id = ?", (acc_id, r["pkey"]))
                if prev:
                    q("UPDATE operations SET date = ?, amount = ?, pointage = 'P', ext_id = ? WHERE id = ?", (r["date"], r["amount"], r["ext"], prev["id"]))
                    finalised += 1
                    continue
            cat = revolut_category(r["tiers"])
            if cat:
                classified += 1
            o = {"date": r["date"], "mode": r["mode"], "tiers": r["tiers"], "details": "", "amount": r["amount"],
                 "pointage": "-" if r["pending"] else "P",
                 "category": (cat or {}).get("category", ""), "subcategory": (cat or {}).get("subcategory", "")}
            op_id = insert_op(acc_id, o)
            q("UPDATE operations SET ext_id = ? WHERE id = ?", (r["ext"], op_id))
            added += 1
            pending_n += r["pending"]
            if r["fee"]:
                fid = insert_op(acc_id, {"date": r["date"], "mode": "Frais", "tiers": "Revolut", "details": "Frais : " + r["tiers"],
                                         "amount": -r["fee"], "pointage": "P", "category": "Banque", "subcategory": "Frais Revolut"})
                q("UPDATE operations SET ext_id = ? WHERE id = ?", (r["ext"] + "-frais", fid))
    acc = next(x for x in list_accounts() if x["id"] == acc_id)
    bank = done_rows[-1]["balance"] if done_rows and done_rows[-1]["balance"] is not None else None
    pend_total = sum(r["amount"] for r in rows_in if r["pending"])
    return {"account": a["name"], "added": added, "duplicates": dup, "skipped": skipped, "other_currencies": other_cur,
            "classified": classified, "to_classify": acc["unclassified"], "initial_set": initial_set,
            "pending": sum(1 for r in rows_in if r["pending"]), "pending_added": pending_n, "finalised": finalised, "cancelled": cancelled,
            "bank_balance": bank, "bank_available": bank + pend_total if bank is not None else None, "balance": acc["balance"]}


def unclassified(acc_id=None):
    where, prm = ["o.category = ''"], []
    if acc_id:
        where.append("o.account_id = ?"); prm.append(acc_id)
    groups = rows("""SELECT o.tiers, COUNT(*) AS n, SUM(o.amount) AS total, MAX(o.date) AS last, GROUP_CONCAT(DISTINCT a.name) AS accounts
                     FROM operations o JOIN accounts a ON a.id = o.account_id WHERE """ + " AND ".join(where) +
                  " GROUP BY lower(o.tiers) ORDER BY n DESC, last DESC LIMIT 500", prm)
    return groups


def classify(tiers, category, subcategory, acc_id=None):
    category, subcategory = str(category or "").strip(), str(subcategory or "").strip()
    if not category:
        raise ApiError(400, "Indiquez une catégorie")
    sql, prm = "UPDATE operations SET category = ?, subcategory = ? WHERE category = '' AND tiers = ? COLLATE NOCASE", [category, subcategory, str(tiers or "")]
    if acc_id:
        sql += " AND account_id = ?"; prm.append(int(acc_id))
    return q(sql, prm).rowcount


# ---------------------------------------------------------------- export et sauvegarde

def export_csv(acc_id):
    a = account_or_404(acc_id)
    ops = rows("SELECT * FROM operations WHERE account_id = ? ORDER BY date, id", (acc_id,))

    def f(s):
        s = str(s or "")
        return '"' + s.replace('"', '""') + '"' if re.search(r'[;"\n]', s) else s

    def d(iso):
        return iso[8:10] + "/" + iso[5:7] + "/" + iso[0:4]

    def m(c):
        return ("%.2f" % (c / 100)).replace(".", ",")

    first = ops[0]["date"] if ops else today()
    lines = ["Date;Mode;Tiers;Détails;Catégorie;Sous-catégorie;Montant;Pointage",
             ";".join([d(first), "Virement reçu", "Solde initial", "", "", "", m(a["initial"]), "R"])]
    for o in ops:
        lines.append(";".join([d(o["date"]), f(o["mode"]), f(o["tiers"]), f(o["details"]), f(o["category"]), f(o["subcategory"]), m(o["amount"]), o["pointage"]]))
    return a["name"], ("﻿" + "\r\n".join(lines) + "\r\n").encode("utf-8")


def backup_bytes():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        dst = sqlite3.connect(path)
        db().backup(dst)
        dst.close()
        with open(path, "rb") as fh:
            return fh.read()
    finally:
        os.unlink(path)


# ---------------------------------------------------------------- sauvegarde automatique

BACKUP_DIR = os.environ.get("BACKUP_DIR", "")
BACKUP_KEEP = int(os.environ.get("BACKUP_KEEP", "30"))
BACKUP_RE = re.compile(r"^registre-(\d{4}-\d{2}-\d{2})\.db$")


def backup_status():
    if not BACKUP_DIR:
        return {"enabled": False}
    files = sorted(f for f in os.listdir(BACKUP_DIR) if BACKUP_RE.match(f)) if os.path.isdir(BACKUP_DIR) else []
    return {"enabled": True, "dir_ok": os.path.isdir(BACKUP_DIR), "count": len(files), "keep": BACKUP_KEEP,
            "last": setting("backup_last"), "error": setting("backup_error") or "", "files": files[-5:], "cloud": cloud_status()}


def cloud_status():
    """État du dernier envoi vers OneDrive, écrit par le conteneur rclone dans le dossier des sauvegardes."""
    path = os.path.join(BACKUP_DIR, ".onedrive-status")
    try:
        with open(path, encoding="utf-8") as fh:
            line = fh.read().strip()
    except OSError:
        return None
    ok = line.startswith("ok")
    parts = line.split(" ", 3)
    return {"ok": ok, "when": " ".join(parts[1:3]) if len(parts) >= 3 else "", "detail": parts[3] if len(parts) > 3 and not ok else "",
            "pending": os.path.exists(os.path.join(BACKUP_DIR, CLOUD_TRIGGER))}


def auto_backup(force=False):
    """Une copie par jour (registre-AAAA-MM-JJ.db) dans BACKUP_DIR, en gardant les BACKUP_KEEP plus récentes."""
    if not BACKUP_DIR:
        return
    with LOCK:
        name = "registre-%s.db" % today()
        target = os.path.join(BACKUP_DIR, name)
        try:
            if not os.path.isdir(BACKUP_DIR):
                raise OSError("le dossier %s n'est pas accessible depuis le conteneur" % BACKUP_DIR)
            if os.path.exists(target) and not force:
                return
            tmp = target + ".tmp"
            dst = sqlite3.connect(tmp)
            db().backup(dst)
            dst.close()
            os.replace(tmp, target)
            for old in sorted(f for f in os.listdir(BACKUP_DIR) if BACKUP_RE.match(f))[:-BACKUP_KEEP]:
                os.remove(os.path.join(BACKUP_DIR, old))
            set_setting("backup_last", dt.datetime.now().strftime("%Y-%m-%d %H:%M"))
            set_setting("backup_error", "")
        except Exception as e:
            set_setting("backup_error", "Sauvegarde automatique impossible : %s" % e)


def backup_loop():
    while True:
        try:
            auto_backup()
        except Exception:
            pass
        time.sleep(1800)


# ---------------------------------------------------------------- HTTP

ROUTES = []


NOT_TRACKED = {"/api/setup", "/api/login", "/api/logout", "/api/password", "/api/backup/now", "/api/cloud",
               "/api/points", "/api/points/revert", "/api/restore", "/api/import/bpsched/preview"}


def route(method, pattern, public=False):
    rx = re.compile("^" + pattern + "$")

    def deco(fn):
        ROUTES.append((method, rx, fn, public))
        return fn
    return deco


def mark_changed():
    """Compte les modifications faites depuis le dernier point de sauvegarde (bouton Sauvegarder)."""
    q("""INSERT INTO settings(key, value) VALUES('changes', '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)""")


@route("GET", "/api/auth", public=True)
def r_auth(h, body, qs):
    return {"setup": setting("password") is None, "logged": session_ok(h.cookie()), "version": APP_VERSION}


@route("POST", "/api/setup", public=True)
def r_setup(h, body, qs):
    if setting("password") is not None:
        raise ApiError(403, "Le mot de passe est déjà défini")
    pw = str(body.get("password") or "")
    if len(pw) < 8:
        raise ApiError(400, "Choisissez un mot de passe d'au moins 8 caractères")
    set_setting("password", hash_password(pw))
    h.set_cookie(new_session())
    return {"ok": True}


@route("POST", "/api/login", public=True)
def r_login(h, body, qs):
    now = time.time()
    _failures[:] = [t for t in _failures if now - t < 300]
    if len(_failures) >= 10:
        raise ApiError(429, "Trop d'essais. Réessayez dans quelques minutes.")
    stored = setting("password")
    if not stored or not check_password(str(body.get("password") or ""), stored):
        _failures.append(now)
        time.sleep(1)
        raise ApiError(401, "Mot de passe incorrect")
    h.set_cookie(new_session())
    return {"ok": True}


@route("POST", "/api/logout")
def r_logout(h, body, qs):
    q("DELETE FROM sessions WHERE token = ?", (h.cookie(),))
    h.set_cookie("", clear=True)
    return {"ok": True}


@route("POST", "/api/password")
def r_password(h, body, qs):
    if not check_password(str(body.get("old") or ""), setting("password") or ""):
        raise ApiError(400, "L'ancien mot de passe est incorrect")
    new = str(body.get("new") or "")
    if len(new) < 8:
        raise ApiError(400, "Choisissez un mot de passe d'au moins 8 caractères")
    set_setting("password", hash_password(new))
    q("DELETE FROM sessions WHERE token <> ?", (h.cookie(),))
    return {"ok": True}


@route("GET", "/api/accounts")
def r_accounts(h, body, qs):
    return list_accounts()


@route("POST", "/api/accounts")
def r_account_new(h, body, qs):
    initial = parse_amount(body["initial"]) if body.get("initial") not in (None, "") else 0
    return {"id": create_account(body.get("name"), body.get("kind") or "courant", initial, body.get("family_id") or None)}


@route("PUT", r"/api/accounts/(\d+)")
def r_account_put(h, body, qs, acc_id):
    account_or_404(acc_id)
    sets = {}
    if "name" in body:
        if not str(body["name"]).strip():
            raise ApiError(400, "Donnez un nom au compte")
        sets["name"] = str(body["name"]).strip()
    if "kind" in body:
        sets["kind"] = "epargne" if body["kind"] == "epargne" else "courant"
    if "initial" in body:
        sets["initial"] = parse_amount(body["initial"]) if not isinstance(body["initial"], int) else body["initial"]
    if "closed" in body:
        sets["closed"] = 1 if body["closed"] else 0
    if "position" in body:
        sets["position"] = int(body["position"])
    if "family_id" in body:
        if not one("SELECT 1 FROM families WHERE id = ?", (int(body["family_id"]),)):
            raise ApiError(400, "Famille inconnue")
        sets["family_id"] = int(body["family_id"])
    if "cycle_day" in body:
        sets["cycle_day"] = max(0, min(28, int(body["cycle_day"] or 0)))
    if "icon" in body:
        icon = str(body["icon"] or "")
        if icon and not (icon.startswith("data:image/") or re.match(r"^/icons/[a-z0-9-]+\.png$", icon)):
            raise ApiError(400, "Icône invalide")
        if len(icon) > 300000:
            raise ApiError(400, "Image trop lourde")
        sets["icon"] = icon
    if sets:
        q("UPDATE accounts SET " + ", ".join(k + " = ?" for k in sets) + " WHERE id = ?", list(sets.values()) + [acc_id])
    return {"ok": True}


@route("DELETE", r"/api/accounts/(\d+)")
def r_account_del(h, body, qs, acc_id):
    account_or_404(acc_id)
    with Tx():
        q("UPDATE operations SET transfer_id = NULL WHERE transfer_id IN (SELECT id FROM operations WHERE account_id = ?)", (acc_id,))
        q("DELETE FROM accounts WHERE id = ?", (acc_id,))
    return {"ok": True}


@route("POST", r"/api/accounts/(\d+)/reconcile")
def r_reconcile(h, body, qs, acc_id):
    account_or_404(acc_id)
    n = q("UPDATE operations SET pointage = 'R' WHERE account_id = ? AND pointage = 'P'", (acc_id,)).rowcount
    return {"reconciled": n}


@route("GET", r"/api/accounts/(\d+)/operations")
def r_ops(h, body, qs, acc_id):
    return list_operations(int(acc_id), qs.get("period", "12m"), qs.get("q", ""))


@route("POST", r"/api/accounts/(\d+)/operations")
def r_op_new(h, body, qs, acc_id):
    o = clean_op(body)
    with Tx():
        op_id = create_operation(int(acc_id), o, body.get("to_account_id") or None)
    return {"id": op_id}


@route("PUT", r"/api/operations/(\d+)")
def r_op_put(h, body, qs, op_id):
    with Tx():
        update_operation(int(op_id), body)
    return {"ok": True}


@route("POST", "/api/operations/bulk")
def r_op_bulk(h, body, qs):
    """Modifie plusieurs opérations à la fois : catégorie / sous-catégorie et/ou pointage."""
    ids = [int(i) for i in (body.get("ids") or [])]
    if not ids:
        raise ApiError(400, "Aucune opération sélectionnée")
    d = {}
    if "category" in body:
        d["category"] = str(body.get("category") or "").strip()
        d["subcategory"] = str(body.get("subcategory") or "").strip()
    elif "subcategory" in body:
        d["subcategory"] = str(body.get("subcategory") or "").strip()
    if body.get("pointage") in ("P", "-"):
        d["pointage"] = body["pointage"]
    if not d:
        raise ApiError(400, "Rien à modifier")
    n = 0
    with Tx():
        for i in ids:
            sql = "UPDATE operations SET " + ", ".join(k + " = ?" for k in d) + " WHERE id = ?"
            if "pointage" in d:
                sql += " AND pointage <> 'R'"
            n += q(sql, list(d.values()) + [i]).rowcount
    return {"updated": n}


@route("DELETE", r"/api/operations/(\d+)")
def r_op_del(h, body, qs, op_id):
    with Tx():
        delete_operation(int(op_id))
    return {"ok": True}


# ---------------------------------------------------------------- catégories

def archived_keys():
    """Couples (catégorie, sous-catégorie) archivés ; (catégorie, '') = toute la catégorie."""
    return {(r["category"], r["subcategory"]) for r in rows("SELECT category, subcategory FROM categories WHERE archived = 1")}


def category_tree():
    """Catégories et sous-catégories utilisées (opérations, échéances) ou créées à l'avance, avec leurs effectifs
    et leur état d'archivage (archived : la ligne elle-même, cat_archived : la catégorie entière)."""
    out = rows("""SELECT category, subcategory, SUM(ops) AS ops, SUM(sched) AS sched FROM (
                     SELECT category, subcategory, COUNT(*) AS ops, 0 AS sched FROM operations WHERE category <> '' GROUP BY category, subcategory
                     UNION ALL SELECT category, subcategory, 0, COUNT(*) FROM schedules WHERE category <> '' GROUP BY category, subcategory
                     UNION ALL SELECT category, subcategory, 0, 0 FROM categories WHERE category <> '')
                   GROUP BY category, subcategory ORDER BY category COLLATE NOCASE, subcategory COLLATE NOCASE""")
    arch = archived_keys()
    for r in out:
        r["cat_archived"] = 1 if (r["category"], "") in arch else 0
        r["archived"] = 1 if r["subcategory"] and (r["category"], r["subcategory"]) in arch else 0
    return out


def set_archived(cat, sub, flag):
    cat, sub = str(cat or "").strip(), str(sub or "").strip()
    if not cat:
        raise ApiError(400, "Indiquez la catégorie")
    q("""INSERT INTO categories(category, subcategory, archived) VALUES(?, ?, ?)
         ON CONFLICT(category, subcategory) DO UPDATE SET archived = excluded.archived""", (cat, sub, 1 if flag else 0))


def rename_category(cat, sub, new_cat, new_sub):
    """Renomme une catégorie entière (sub None) ou une sous-catégorie, dans les opérations, les échéances et la liste.
    Si le nouveau nom existe déjà, les deux sont fusionnées."""
    cat, new_cat = str(cat or "").strip(), str(new_cat or "").strip()
    if not cat or not new_cat:
        raise ApiError(400, "Indiquez la catégorie")
    n = 0
    for table in ("operations", "schedules"):
        if sub is None:
            n += q("UPDATE %s SET category = ? WHERE category = ?" % table, (new_cat, cat)).rowcount
        else:
            n += q("UPDATE %s SET category = ?, subcategory = ? WHERE category = ? AND subcategory = ?" % table,
                   (new_cat, str(new_sub or "").strip(), cat, str(sub).strip())).rowcount
    if sub is None:
        if new_cat != cat:
            for r in rows("SELECT subcategory, archived FROM categories WHERE category = ?", (cat,)):
                q("INSERT OR IGNORE INTO categories(category, subcategory, archived) VALUES(?, ?, ?)", (new_cat, r["subcategory"], r["archived"]))
            q("DELETE FROM categories WHERE category = ?", (cat,))
    else:
        key, new_key = (cat, str(sub).strip()), (new_cat, str(new_sub or "").strip())
        if key != new_key:
            old = one("SELECT archived FROM categories WHERE category = ? AND subcategory = ?", key)
            q("DELETE FROM categories WHERE category = ? AND subcategory = ?", key)
            q("INSERT OR IGNORE INTO categories(category, subcategory, archived) VALUES(?, ?, ?)",
              new_key + ((old["archived"] if old and new_key[1] else 0),))
    return n


@route("GET", "/api/categories")
def r_categories(h, body, qs):
    return category_tree()


@route("POST", "/api/categories")
def r_category_new(h, body, qs):
    cat, sub = str(body.get("category") or "").strip(), str(body.get("subcategory") or "").strip()
    if not cat:
        raise ApiError(400, "Indiquez un nom de catégorie")
    q("INSERT OR IGNORE INTO categories(category, subcategory) VALUES(?, ?)", (cat, sub))
    return {"ok": True}


@route("POST", "/api/categories/rename")
def r_category_rename(h, body, qs):
    with Tx():
        n = rename_category(body.get("category"), body.get("subcategory"), body.get("new_category"), body.get("new_subcategory"))
    return {"updated": n}


@route("POST", "/api/categories/archive")
def r_category_archive(h, body, qs):
    """Archive (ou réactive) une catégorie entière (subcategory absente) ou une sous-catégorie.
    Archivée, elle n'est plus proposée à la saisie d'une nouvelle opération, mais reste utilisable."""
    with Tx():
        set_archived(body.get("category"), body.get("subcategory"), bool(body.get("archived", True)))
    return {"ok": True}


@route("POST", "/api/categories/delete")
def r_category_delete(h, body, qs):
    """Supprime une catégorie (ou une sous-catégorie) : les opérations et échéances concernées redeviennent « à classer »."""
    cat, sub = str(body.get("category") or "").strip(), body.get("subcategory")
    with Tx():
        n = 0
        for table in ("operations", "schedules"):
            if sub is None:
                n += q("UPDATE %s SET category = '', subcategory = '' WHERE category = ?" % table, (cat,)).rowcount
            else:
                n += q("UPDATE %s SET subcategory = '' WHERE category = ? AND subcategory = ?" % table, (cat, str(sub))).rowcount
        if sub is None:
            q("DELETE FROM categories WHERE category = ?", (cat,))
        else:
            q("DELETE FROM categories WHERE category = ? AND subcategory = ?", (cat, str(sub)))
    return {"updated": n}


@route("GET", "/api/families")
def r_families(h, body, qs):
    return list_families()


@route("POST", "/api/families")
def r_family_new(h, body, qs):
    name = str(body.get("name") or "").strip()
    if not name:
        raise ApiError(400, "Donnez un nom à la famille")
    pos = one("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM families")["p"]
    return {"id": q("INSERT INTO families(name, position) VALUES(?, ?)", (name, pos)).lastrowid}


@route("PUT", r"/api/families/(\d+)")
def r_family_put(h, body, qs, fid):
    if "name" in body and str(body["name"]).strip():
        q("UPDATE families SET name = ? WHERE id = ?", (str(body["name"]).strip(), fid))
    if "position" in body:
        q("UPDATE families SET position = ? WHERE id = ?", (int(body["position"]), fid))
    return {"ok": True}


@route("DELETE", r"/api/families/(\d+)")
def r_family_del(h, body, qs, fid):
    if one("SELECT 1 FROM accounts WHERE family_id = ?", (fid,)):
        raise ApiError(400, "Déplacez d'abord les comptes de cette famille")
    q("DELETE FROM families WHERE id = ?", (fid,))
    return {"ok": True}


@route("GET", "/api/forecast")
def r_forecast(h, body, qs):
    until = valid_date(qs.get("until") or end_of_month())
    if until < today():
        raise ApiError(400, "Choisissez une date à venir")
    accs = [a for a in rows("SELECT a.id FROM accounts a LEFT JOIN families f ON f.id = a.family_id WHERE a.closed = 0 ORDER BY COALESCE(f.position, 999), a.position, a.id")]
    out = []
    for a in accs:
        f = forecast_detail(a["id"], until)
        if qs.get("account") and int(qs["account"]) != a["id"]:
            f.pop("items")
        out.append(f)
    return {"until": until, "today": today(), "accounts": out}


@route("GET", "/api/backup/status")
def r_backup_status(h, body, qs):
    return backup_status()


@route("POST", "/api/backup/now")
def r_backup_now(h, body, qs):
    if not BACKUP_DIR:
        raise ApiError(400, "Aucun dossier de sauvegarde n'est configuré (voir le mode d'emploi)")
    auto_backup(force=True)
    st = backup_status()
    if st.get("error"):
        raise ApiError(500, st["error"])
    return st


@route("GET", "/api/lists")
def r_lists(h, body, qs):
    return lists()


@route("GET", "/api/schedules")
def r_scheds(h, body, qs):
    return list_schedules()


@route("POST", "/api/schedules")
def r_sched_new(h, body, qs):
    s = clean_schedule(body)
    cur = q("INSERT INTO schedules(" + ", ".join(s) + ") VALUES(" + ", ".join("?" * len(s)) + ")", list(s.values()))
    return {"id": cur.lastrowid}


@route("PUT", r"/api/schedules/(\d+)")
def r_sched_put(h, body, qs, sid):
    if not one("SELECT 1 FROM schedules WHERE id = ?", (sid,)):
        raise ApiError(404, "Échéance introuvable")
    s = clean_schedule(body, partial=True)
    if s:
        q("UPDATE schedules SET " + ", ".join(k + " = ?" for k in s) + " WHERE id = ?", list(s.values()) + [sid])
    return {"ok": True}


@route("DELETE", r"/api/schedules/(\d+)")
def r_sched_del(h, body, qs, sid):
    q("DELETE FROM schedules WHERE id = ?", (sid,))
    return {"ok": True}


@route("POST", r"/api/schedules/(\d+)/validate")
def r_sched_validate(h, body, qs, sid):
    return validate_schedule(int(sid), body)


@route("POST", r"/api/schedules/(\d+)/skip")
def r_sched_skip(h, body, qs, sid):
    s = one("SELECT * FROM schedules WHERE id = ?", (sid,))
    if not s:
        raise ApiError(404, "Échéance introuvable")
    return {"next_date": advance_schedule(s)}


@route("GET", "/api/settings")
def r_settings(h, body, qs):
    return {"horizon": int(setting("horizon", "7"))}


@route("PUT", "/api/settings")
def r_settings_put(h, body, qs):
    if "horizon" in body:
        set_setting("horizon", str(max(0, min(60, int(body["horizon"])))))
    return {"ok": True}


@route("POST", "/api/import/revolut")
def r_import_revolut(h, body, qs):
    return import_revolut(int(body.get("account_id") or 0), str(body.get("text") or ""))


@route("GET", "/api/unclassified")
def r_unclassified(h, body, qs):
    return unclassified(int(qs["account"]) if qs.get("account") else None)


@route("POST", "/api/classify")
def r_classify(h, body, qs):
    with Tx():
        n = classify(body.get("tiers"), body.get("category"), body.get("subcategory"), body.get("account_id") or None)
    return {"updated": n}


@route("POST", "/api/import/csv")
def r_import_csv(h, body, qs):
    return import_csv(str(body.get("name") or "Compte"), str(body.get("text") or ""))


@route("POST", "/api/import/bpsched/preview")
def r_bps_preview(h, body, qs):
    items = parse_bpsched(base64.b64decode(body.get("data") or ""))
    return {"items": items, "guess": guess_bp_mapping(items)}


@route("POST", "/api/import/bpsched")
def r_bps_import(h, body, qs):
    return import_bpsched(base64.b64decode(body.get("data") or ""), body.get("mapping") or {})


@route("GET", r"/api/accounts/(\d+)/export")
def r_export(h, body, qs, acc_id):
    name, data = export_csv(int(acc_id))
    safe = re.sub(r'[^A-Za-z0-9 ._-]', "_", norm(name)) or "compte"
    h.send_bytes(200, data, "text/csv; charset=utf-8", "Registre - %s - %s.csv" % (safe, today()))


POINTS_DIR = os.path.join(DATA_DIR, "points")
POINTS_KEEP = int(os.environ.get("POINTS_KEEP", "50"))
POINT_RE = re.compile(r"^point-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})\.db$")


def list_points():
    if not os.path.isdir(POINTS_DIR):
        return []
    out = []
    for f in sorted((f for f in os.listdir(POINTS_DIR) if POINT_RE.match(f)), reverse=True):
        m = POINT_RE.match(f)
        out.append({"name": f, "when": "%s %s:%s:%s" % m.groups(), "size": os.path.getsize(os.path.join(POINTS_DIR, f))})
    return out


def points_status():
    pts = list_points()
    return {"changes": int(setting("changes", "0") or 0), "last": pts[0]["when"] if pts else None, "points": pts[:15]}


def make_point():
    os.makedirs(POINTS_DIR, exist_ok=True)
    name = "point-%s.db" % dt.datetime.now().strftime("%Y-%m-%d-%H%M%S")
    path = os.path.join(POINTS_DIR, name)
    tmp = path + ".tmp"
    dst = sqlite3.connect(tmp)
    db().backup(dst)
    dst.close()
    os.replace(tmp, path)
    for old in [p["name"] for p in list_points()][POINTS_KEEP:]:
        os.remove(os.path.join(POINTS_DIR, old))
    set_setting("changes", "0")
    return name


def restore_file(path, keep_access=True):
    """Remplace les données par celles d'un fichier, en conservant le mot de passe et les sessions en cours."""
    pw = setting("password")
    sessions = rows("SELECT * FROM sessions")
    src = sqlite3.connect(path)
    try:
        names = {r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        if not {"accounts", "operations", "schedules", "settings"} <= names:
            raise ApiError(400, "Ce fichier n'est pas une sauvegarde du Registre")
        src.backup(db())
    except sqlite3.DatabaseError:
        raise ApiError(400, "Ce fichier n'est pas une sauvegarde du Registre")
    finally:
        src.close()
    db().executescript(SCHEMA)
    migrate()
    if keep_access:
        if pw:
            set_setting("password", pw)
        for se in sessions:
            q("INSERT OR IGNORE INTO sessions(token, expires) VALUES(?, ?)", (se["token"], se["expires"]))


@route("GET", "/api/points")
def r_points(h, body, qs):
    return points_status()


@route("POST", "/api/points")
def r_point_new(h, body, qs):
    name = make_point()
    st = points_status()
    st["created"] = name
    return st


@route("POST", "/api/points/revert")
def r_point_revert(h, body, qs):
    pts = list_points()
    name = str(body.get("name") or (pts[0]["name"] if pts else ""))
    if not name or not POINT_RE.match(name) or not os.path.isfile(os.path.join(POINTS_DIR, name)):
        raise ApiError(400, "Aucun point de sauvegarde : cliquez d'abord sur « Sauvegarder »")
    restore_file(os.path.join(POINTS_DIR, name))
    set_setting("changes", "0")
    return points_status()


CLOUD_TRIGGER = ".envoyer-maintenant"


@route("POST", "/api/cloud")
def r_cloud(h, body, qs):
    if not BACKUP_DIR:
        raise ApiError(400, "Aucun dossier de sauvegarde n'est configuré")
    auto_backup(force=True)
    st = backup_status()
    if st.get("error"):
        raise ApiError(500, st["error"])
    with open(os.path.join(BACKUP_DIR, CLOUD_TRIGGER), "w") as fh:
        fh.write(dt.datetime.now().isoformat())
    st["requested"] = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return st


@route("POST", "/api/restore")
def r_restore(h, body, qs):
    raw = base64.b64decode(body.get("data") or "")
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        with open(path, "wb") as fh:
            fh.write(raw)
        restore_file(path, keep_access=False)
    finally:
        os.unlink(path)
    set_setting("changes", "0")
    h.set_cookie(new_session())
    return {"ok": True}


@route("GET", "/api/backup")
def r_backup(h, body, qs):
    h.send_bytes(200, backup_bytes(), "application/octet-stream", "registre-sauvegarde-%s.db" % today())


class Handler(BaseHTTPRequestHandler):
    server_version = "Registre"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("ACCESS_LOG") == "1":
            super().log_message(fmt, *args)

    def cookie(self):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE:
                return v
        return None

    def set_cookie(self, token, clear=False):
        secure = COOKIE_SECURE or self.headers.get("X-Forwarded-Proto") == "https"
        c = "%s=%s; Path=/; HttpOnly; SameSite=Strict%s; Max-Age=%d" % (COOKIE, token, "; Secure" if secure else "", 0 if clear else SESSION_DAYS * 86400)
        self._cookies.append(c)

    def security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'")

    def send_json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for c in self._cookies:
            self.send_header("Set-Cookie", c)
        self.security_headers()
        self.end_headers()
        self.wfile.write(data)

    def send_bytes(self, status, data, ctype, filename=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if filename:
            self.send_header("Content-Disposition", "attachment; filename=\"%s\"" % filename)
        self.security_headers()
        self.end_headers()
        self.wfile.write(data)
        self._sent = True

    def serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.normpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            full = os.path.join(STATIC_DIR, "index.html")
        with open(full, "rb") as fh:
            data = fh.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.security_headers()
        self.end_headers()
        self.wfile.write(data)

    def handle_any(self, method):
        self._cookies, self._sent = [], False
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            if method != "GET":
                return self.send_json(405, {"error": "Méthode non autorisée"})
            return self.serve_static(url.path)
        qs = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 60 * 1024 * 1024:
                raise ApiError(413, "Fichier trop volumineux")
            raw = self.rfile.read(length) if length else b""
            body = json.loads(raw.decode("utf-8")) if raw else {}
            if method != "GET" and self.headers.get("X-Registre") != "1":
                raise ApiError(403, "Requête refusée")
            for m, rx, fn, public in ROUTES:
                mt = rx.match(url.path)
                if m == method and mt:
                    with LOCK:
                        if not public and not session_ok(self.cookie()):
                            raise ApiError(401, "Session expirée, reconnectez-vous")
                        res = fn(self, body, qs, *mt.groups())
                        if method != "GET" and url.path not in NOT_TRACKED:
                            mark_changed()
                    if not self._sent:
                        self.send_json(200, res)
                    return
            raise ApiError(404, "Adresse inconnue")
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
        except (ValueError, KeyError) as e:
            self.send_json(400, {"error": "Requête invalide : " + str(e)})
        except Exception as e:  # pragma: no cover
            import traceback
            traceback.print_exc()
            self.send_json(500, {"error": "Erreur interne : " + str(e)})

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_PUT(self):
        self.handle_any("PUT")

    def do_DELETE(self):
        self.handle_any("DELETE")


def main():
    with LOCK:
        db()
        if os.environ.get("RESET_PASSWORD") == "1":
            q("DELETE FROM settings WHERE key = 'password'")
            q("DELETE FROM sessions")
            print("Mot de passe effacé : il sera redemandé à la prochaine ouverture de l'application.")
    if BACKUP_DIR:
        threading.Thread(target=backup_loop, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("Registre démarré sur le port %d, données dans %s" % (PORT, DB_PATH), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
