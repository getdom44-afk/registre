#!/usr/bin/env python3
"""Connecteur MCP du Registre (transport stdio).

Lancé par l'application Claude pour ordinateur via :
    docker exec -i registre python /app/mcp_stdio.py              (lecture et écriture)
    docker exec -i registre python /app/mcp_stdio.py --lecture-seule

Il lit et écrit directement dans la base du Registre, avec les mêmes règles que l'interface.
Les montants sont exprimés en euros : négatifs pour une dépense, positifs pour une recette.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server as R  # noqa: E402

READ_ONLY = "--lecture-seule" in sys.argv or os.environ.get("MCP_READONLY") == "1"
VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]


# ---------------------------------------------------------------- utilitaires

class UserError(Exception):
    pass


def euros(c):
    return round(c / 100, 2)


def cents(v):
    if v is None or v == "":
        raise UserError("Montant manquant")
    if isinstance(v, (int, float)):
        return int(round(float(v) * 100))
    try:
        return R.parse_amount(v)
    except ValueError:
        raise UserError("Montant illisible : %s" % v)


def find_account(ref):
    if ref in (None, ""):
        raise UserError("Indiquez un compte (nom ou numéro)")
    accs = R.rows("SELECT * FROM accounts")
    if isinstance(ref, int) or str(ref).isdigit():
        a = next((a for a in accs if a["id"] == int(ref)), None)
        if a:
            return a
    n = R.norm(ref)
    exact = [a for a in accs if R.norm(a["name"]) == n]
    if exact:
        return exact[0]
    part = [a for a in accs if n in R.norm(a["name"])]
    if len(part) == 1:
        return part[0]
    names = ", ".join(a["name"] for a in accs)
    raise UserError("Compte « %s » introuvable ou ambigu. Comptes existants : %s" % (ref, names))


def op_out(o):
    return {"id": o["id"], "compte_id": o["account_id"], "date": o["date"], "mode": o["mode"], "tiers": o["tiers"], "details": o["details"],
            "categorie": o["category"], "sous_categorie": o["subcategory"], "montant": euros(o["amount"]), "pointage": o["pointage"],
            **({"solde_apres": euros(o["solde"])} if "solde" in o and o["solde"] is not None else {}),
            **({"virement_interne": True} if o.get("transfer_id") else {})}


def sched_out(s):
    return {"id": s["id"], "compte": s["account_name"], "vers_compte": s["to_account_name"], "tiers": s["tiers"], "details": s["details"],
            "categorie": s["category"], "sous_categorie": s["subcategory"], "mode": s["mode"], "montant": euros(s["amount"]),
            "frequence": {"d": "jours", "w": "semaines", "m": "mois", "y": "ans"}[s["unit"]], "tous_les": s["every"],
            "prochaine_date": s["next_date"], "date_fin": s["end_date"] or None, "moyenne_mensuelle": euros(s["per_month"])}


# ---------------------------------------------------------------- outils de lecture

def t_comptes(args):
    out = []
    for a in R.list_accounts():
        out.append({"id": a["id"], "nom": a["name"], "famille": a["family_name"], "cloture": bool(a["closed"]),
                    "solde_aujourdhui": euros(a["today_balance"]), "solde_avec_operations_futures": euros(a["balance"]),
                    "solde_pointe": euros(a["pointed"]), "solde_rapproche": euros(a["reconciled"]), "operations_non_pointees": a["unpointed"],
                    "fin_de_cycle": a["cycle_end"], "solde_prevu_fin_de_cycle": euros(a["forecast"]),
                    "point_bas_prevu": euros(a["forecast_low"]), "date_point_bas": a["forecast_low_date"], "nombre_operations": a["n"]})
    return {"date_du_jour": R.today(), "comptes": out}


def t_operations(args):
    a = find_account(args.get("compte"))
    where, prm = ["account_id = ?"], [a["id"]]
    if args.get("du"):
        where.append("date >= ?"); prm.append(R.valid_date(args["du"]))
    if args.get("au"):
        where.append("date <= ?"); prm.append(R.valid_date(args["au"]))
    if args.get("non_pointees"):
        where.append("pointage = '-'")
    if args.get("sans_categorie"):
        where.append("category = ''")
    if args.get("categorie"):
        where.append("(category = ? COLLATE NOCASE OR subcategory = ? COLLATE NOCASE)"); prm += [args["categorie"]] * 2
    if args.get("recherche"):
        like = "%" + args["recherche"] + "%"
        where.append("(tiers LIKE ? OR details LIKE ? OR category LIKE ? OR subcategory LIKE ? OR mode LIKE ?)"); prm += [like] * 5
    if args.get("montant") not in (None, ""):
        c = abs(cents(args["montant"]))
        where.append("abs(amount) = ?"); prm.append(c)
    limit = max(1, min(2000, int(args.get("limite") or 200)))
    sql = """SELECT * FROM (SELECT o.*, ? + SUM(o.amount) OVER (ORDER BY o.date, o.id ROWS UNBOUNDED PRECEDING) AS solde
             FROM operations o WHERE o.account_id = ?) WHERE """ + " AND ".join(where) + " ORDER BY date DESC, id DESC LIMIT ?"
    ops = R.rows(sql, [a["initial"], a["id"]] + prm + [limit])
    total = sum(o["amount"] for o in ops)
    return {"compte": a["name"], "nombre": len(ops), "limite_atteinte": len(ops) == limit, "total": euros(total),
            "operations": [op_out(o) for o in ops]}


def t_statistiques(args):
    du = R.valid_date(args.get("du") or (R.today()[:4] + "-01-01"))
    au = R.valid_date(args.get("au") or R.today())
    by = args.get("regrouper_par") or "categorie"
    col = {"categorie": "category", "sous_categorie": "category || ' / ' || subcategory", "tiers": "tiers", "mois": "substr(date, 1, 7)"}.get(by)
    if not col:
        raise UserError("regrouper_par doit valoir categorie, sous_categorie, tiers ou mois")
    where, prm = ["date >= ?", "date <= ?"], [du, au]
    if args.get("compte"):
        a = find_account(args["compte"])
        where.append("account_id = ?"); prm.append(a["id"])
    if args.get("exclure_virements_internes", True):
        where.append("transfer_id IS NULL AND tiers NOT LIKE 'Transfert %'")
    sens = args.get("sens") or "depenses"
    if sens == "depenses":
        where.append("amount < 0")
    elif sens == "recettes":
        where.append("amount > 0")
    if args.get("categorie"):
        where.append("(category = ? COLLATE NOCASE)"); prm.append(args["categorie"])
    rows = R.rows("SELECT " + col + " AS cle, SUM(amount) AS total, COUNT(*) AS n FROM operations WHERE " + " AND ".join(where) +
                  " GROUP BY cle ORDER BY " + ("cle" if by == "mois" else "ABS(SUM(amount)) DESC"), prm)
    return {"du": du, "au": au, "sens": sens, "regroupement": by, "total": euros(sum(r["total"] for r in rows)),
            "lignes": [{"cle": r["cle"] or "(sans)", "total": euros(r["total"]), "nombre": r["n"]} for r in rows]}


def t_prevision(args):
    until = R.valid_date(args.get("date") or R.end_of_month())
    if until < R.today():
        raise UserError("Choisissez une date à venir")
    accs = R.rows("SELECT a.* FROM accounts a LEFT JOIN families f ON f.id = a.family_id WHERE a.closed = 0 ORDER BY COALESCE(f.position, 999), a.position")
    if args.get("compte"):
        accs = [find_account(args["compte"])]
    out = []
    for a in accs:
        f = R.forecast_detail(a["id"], until)
        item = {"compte": f["name"], "solde_aujourdhui": euros(f["start"]), "entrees": euros(f["in"]), "sorties": euros(f["out"]),
                "solde_prevu": euros(f["end"]), "point_bas": euros(f["low"]), "date_point_bas": f["low_date"]}
        if args.get("compte"):
            item["mouvements"] = [{"date": i["date"], "libelle": i["tiers"], "categorie": " / ".join(x for x in (i["category"], i["subcategory"]) if x),
                                   "montant": euros(i["amount"]), "solde_apres": euros(i["solde"]), "origine": i["kind"], "en_retard": i["late"]} for i in f["items"]]
        out.append(item)
    return {"date_du_jour": R.today(), "jusquau": until, "comptes": out}


def t_echeances(args):
    scheds = R.list_schedules()
    if args.get("a_valider_seulement"):
        jours = int(args.get("jours") if args.get("jours") is not None else (R.setting("horizon", "7")))
        import datetime as dt
        lim = (dt.date.today() + dt.timedelta(days=jours)).isoformat()
        scheds = [s for s in scheds if s["next_date"] <= lim]
    if args.get("compte"):
        a = find_account(args["compte"])
        scheds = [s for s in scheds if s["account_id"] == a["id"] or s["to_account_id"] == a["id"]]
    return {"date_du_jour": R.today(), "nombre": len(scheds), "echeances": [sched_out(s) for s in scheds]}


def t_categories(args):
    return {"categories": [{"categorie": c["category"], "sous_categorie": c["subcategory"], "utilisations": c["n"]} for c in R.lists()["categories"]]}


def t_a_classer(args):
    acc = find_account(args["compte"])["id"] if args.get("compte") else None
    g = R.unclassified(acc)
    return {"nombre_operations": sum(x["n"] for x in g), "groupes_par_tiers": [
        {"tiers": x["tiers"], "nombre": x["n"], "total": euros(x["total"]), "derniere_date": x["last"], "comptes": x["accounts"]} for x in g]}


# ---------------------------------------------------------------- outils d'écriture

def t_classer(args):
    acc = find_account(args["compte"])["id"] if args.get("compte") else None
    with R.Tx():
        n = R.classify(args.get("tiers"), args.get("categorie"), args.get("sous_categorie"), acc)
    return {"ok": True, "operations_classees": n}


def t_importer_revolut(args):
    a = find_account(args.get("compte"))
    r = R.import_revolut(a["id"], str(args.get("contenu_csv") or ""))
    return {"ok": True, "compte": r["account"], "ajoutees": r["added"], "deja_presentes": r["duplicates"], "ignorees": r["skipped"],
            "classees_automatiquement": r["classified"], "reste_a_classer": r["to_classify"],
            "solde_revolut": euros(r["bank_balance"]) if r["bank_balance"] is not None else None, "solde_registre": euros(r["balance"])}



def t_ajouter_operation(args):
    a = find_account(args.get("compte"))
    o = R.clean_op({"date": args.get("date") or R.today(), "amount": cents(args.get("montant")), "tiers": args.get("tiers", ""),
                    "details": args.get("details", ""), "category": args.get("categorie", ""), "subcategory": args.get("sous_categorie", ""),
                    "mode": args.get("mode", ""), "pointage": "P" if args.get("pointee") else "-"})
    if not o["category"] and o["tiers"]:
        last = R.one("SELECT category, subcategory, mode FROM operations WHERE tiers = ? COLLATE NOCASE AND category <> '' ORDER BY date DESC LIMIT 1", (o["tiers"],))
        if last:
            o["category"], o["subcategory"] = last["category"], last["subcategory"]
            o["mode"] = o["mode"] or last["mode"]
    to = find_account(args["virement_vers"])["id"] if args.get("virement_vers") else None
    with R.Tx():
        op_id = R.create_operation(a["id"], o, to)
    return {"ok": True, "operation": op_out(R.one("SELECT * FROM operations WHERE id = ?", (op_id,))),
            "solde_compte": euros(next(x["today_balance"] for x in R.list_accounts() if x["id"] == a["id"]))}


def t_modifier_operation(args):
    op_id = int(args["id"])
    body = {}
    for k_in, k in (("date", "date"), ("tiers", "tiers"), ("details", "details"), ("categorie", "category"), ("sous_categorie", "subcategory"), ("mode", "mode")):
        if k_in in args:
            body[k] = args[k_in]
    if "montant" in args:
        body["amount"] = cents(args["montant"])
    if not body:
        raise UserError("Rien à modifier")
    with R.Tx():
        R.update_operation(op_id, body)
    return {"ok": True, "operation": op_out(R.one("SELECT * FROM operations WHERE id = ?", (op_id,)))}


def t_pointer(args):
    ids = [int(i) for i in (args.get("ids") or [])]
    etat = args.get("etat", "P")
    if etat not in ("P", "-"):
        raise UserError("etat doit valoir P (pointer) ou - (dépointer)")
    if not ids:
        raise UserError("Aucune opération indiquée")
    done, skipped = [], []
    with R.Tx():
        for i in ids:
            o = R.one("SELECT id, pointage FROM operations WHERE id = ?", (i,))
            if not o or o["pointage"] == "R":
                skipped.append(i)
                continue
            R.q("UPDATE operations SET pointage = ? WHERE id = ?", (etat, i))
            done.append(i)
    return {"ok": True, "modifiees": done, "ignorees_introuvables_ou_rapprochees": skipped}


def t_supprimer_operation(args):
    op_id = int(args["id"])
    o = R.one("SELECT * FROM operations WHERE id = ?", (op_id,))
    if not o:
        raise UserError("Opération introuvable")
    with R.Tx():
        R.delete_operation(op_id)
    return {"ok": True, "supprimee": op_out(o), "virement_lie_supprime": bool(o["transfer_id"])}


def t_valider_echeance(args):
    body = {}
    if args.get("date"):
        body["date"] = args["date"]
    if args.get("montant") not in (None, ""):
        body["amount"] = cents(args["montant"])
    s = R.one("SELECT * FROM schedules WHERE id = ?", (int(args["id"]),))
    if not s:
        raise UserError("Échéance introuvable")
    r = R.validate_schedule(int(args["id"]), body)
    return {"ok": True, "operation": op_out(R.one("SELECT * FROM operations WHERE id = ?", (r["operation_id"],))),
            "prochaine_date": r["next_date"] or "échéance terminée"}


def t_sauter_echeance(args):
    s = R.one("SELECT * FROM schedules WHERE id = ?", (int(args["id"]),))
    if not s:
        raise UserError("Échéance introuvable")
    return {"ok": True, "prochaine_date": R.advance_schedule(s) or "échéance terminée"}


# ---------------------------------------------------------------- déclaration des outils

S = lambda **p: p  # noqa: E731
STR, NUM, BOOL, DATE = {"type": "string"}, {"type": ["number", "string"]}, {"type": "boolean"}, {"type": "string", "description": "AAAA-MM-JJ"}
COMPTE = {"type": ["string", "integer"], "description": "Nom du compte (ex. CCP, CE Joint, Livret A) ou son numéro"}

TOOLS = [
    ("comptes", t_comptes, False, "Liste les comptes avec leur solde du jour, pointé, rapproché, et le solde prévu en fin de cycle (CCP : la veille du salaire).",
     S(type="object", properties={})),
    ("operations", t_operations, False, "Cherche des opérations d'un compte, les plus récentes d'abord, avec le solde après chaque opération.",
     S(type="object", properties={"compte": COMPTE, "du": DATE, "au": DATE, "recherche": dict(STR, description="Texte cherché dans tiers, détails, catégorie, mode"),
                                  "categorie": dict(STR, description="Catégorie ou sous-catégorie exacte"), "montant": dict(NUM, description="Montant exact en euros, sans signe"),
                                  "non_pointees": dict(BOOL, description="Seulement les opérations non pointées"),
                                  "sans_categorie": dict(BOOL, description="Seulement les opérations à classer"), "limite": {"type": "integer", "description": "200 par défaut"}},
       required=["compte"])),
    ("statistiques", t_statistiques, False, "Totaux par catégorie, sous-catégorie, tiers ou mois sur une période (par défaut : dépenses depuis le 1er janvier, virements internes exclus).",
     S(type="object", properties={"du": DATE, "au": DATE, "compte": COMPTE, "regrouper_par": {"type": "string", "enum": ["categorie", "sous_categorie", "tiers", "mois"]},
                                  "sens": {"type": "string", "enum": ["depenses", "recettes", "tout"]}, "categorie": STR,
                                  "exclure_virements_internes": dict(BOOL, description="true par défaut")})),
    ("prevision", t_prevision, False, "Solde prévisionnel à une date : solde du jour, entrées et sorties prévues (échéances et opérations futures), solde prévu et point bas. Avec un compte, donne aussi le détail des mouvements.",
     S(type="object", properties={"date": DATE, "compte": COMPTE})),
    ("echeances", t_echeances, False, "Liste l'échéancier, ou seulement les échéances arrivées à validation.",
     S(type="object", properties={"a_valider_seulement": BOOL, "jours": {"type": "integer", "description": "Horizon en jours (réglage de l'application par défaut)"}, "compte": COMPTE})),
    ("categories", t_categories, False, "Liste les catégories et sous-catégories déjà utilisées.", S(type="object", properties={})),
    ("a_classer", t_a_classer, False, "Opérations sans catégorie, regroupées par tiers (commerçant), avec nombre et total.",
     S(type="object", properties={"compte": COMPTE})),
    ("classer", t_classer, True, "Donne une catégorie (et sous-catégorie) à toutes les opérations sans catégorie d'un tiers. Les imports suivants la reprendront automatiquement.",
     S(type="object", properties={"tiers": STR, "categorie": STR, "sous_categorie": STR, "compte": COMPTE}, required=["tiers", "categorie"])),
    ("importer_releve_revolut", t_importer_revolut, True, "Importe un relevé CSV exporté de l'app Revolut dans un compte (Revolut Perso ou Revolut Joint). Sans doublons ; opérations pointées ; catégories reprises quand le commerçant est connu.",
     S(type="object", properties={"compte": COMPTE, "contenu_csv": dict(STR, description="Contenu texte complet du fichier CSV")}, required=["compte", "contenu_csv"])),
    ("ajouter_operation", t_ajouter_operation, True, "Ajoute une opération. Montant négatif pour une dépense. Si la catégorie est omise, celle du dernier usage du tiers est reprise. Avec virement_vers, l'opération est inscrite sur les deux comptes.",
     S(type="object", properties={"compte": COMPTE, "date": DATE, "tiers": STR, "montant": NUM, "categorie": STR, "sous_categorie": STR, "mode": STR, "details": STR,
                                  "virement_vers": COMPTE, "pointee": BOOL}, required=["compte", "montant", "tiers"])),
    ("modifier_operation", t_modifier_operation, True, "Modifie une opération (seuls les champs fournis changent). Un virement interne est mis à jour des deux côtés.",
     S(type="object", properties={"id": {"type": "integer"}, "date": DATE, "tiers": STR, "montant": NUM, "categorie": STR, "sous_categorie": STR, "mode": STR, "details": STR},
       required=["id"])),
    ("pointer", t_pointer, True, "Pointe (P) ou dépointe (-) des opérations, par exemple après comparaison avec un relevé. Les opérations rapprochées (R) ne changent pas.",
     S(type="object", properties={"ids": {"type": "array", "items": {"type": "integer"}}, "etat": {"type": "string", "enum": ["P", "-"]}}, required=["ids"])),
    ("valider_echeance", t_valider_echeance, True, "Valide une échéance : crée l'opération (date et montant ajustables) et passe l'échéance à sa prochaine date.",
     S(type="object", properties={"id": {"type": "integer"}, "date": DATE, "montant": NUM}, required=["id"])),
    ("sauter_echeance", t_sauter_echeance, True, "Ignore l'occurrence en cours d'une échéance et la passe à sa prochaine date.",
     S(type="object", properties={"id": {"type": "integer"}}, required=["id"])),
    ("supprimer_operation", t_supprimer_operation, True, "Supprime définitivement une opération (et son virement lié s'il y en a un).",
     S(type="object", properties={"id": {"type": "integer"}}, required=["id"])),
]
TITLES = {"comptes": "Comptes et soldes", "operations": "Rechercher des opérations", "statistiques": "Statistiques de dépenses",
          "prevision": "Solde prévisionnel", "a_classer": "Opérations à classer", "classer": "Classer par tiers", "importer_releve_revolut": "Importer un relevé Revolut", "echeances": "Échéancier", "categories": "Catégories", "ajouter_operation": "Ajouter une opération",
          "modifier_operation": "Modifier une opération", "pointer": "Pointer des opérations", "valider_echeance": "Valider une échéance",
          "sauter_echeance": "Sauter une échéance", "supprimer_operation": "Supprimer une opération"}


def tool_list():
    out = []
    for name, _, write, desc, schema in TOOLS:
        if write and READ_ONLY:
            continue
        out.append({"name": name, "title": TITLES[name], "description": desc, "inputSchema": schema,
                    "annotations": {"title": TITLES[name], "readOnlyHint": not write, "destructiveHint": name == "supprimer_operation",
                                    "idempotentHint": not write, "openWorldHint": False}})
    return out


def call_tool(name, args):
    t = next((t for t in TOOLS if t[0] == name), None)
    if not t or (t[2] and READ_ONLY):
        return {"content": [{"type": "text", "text": "Outil inconnu ou désactivé (lecture seule) : %s" % name}], "isError": True}
    try:
        with R.LOCK:
            R.db()
            res = t[1](args or {})
        return {"content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False, indent=1)}], "structuredContent": res}
    except (UserError, R.ApiError) as e:
        return {"content": [{"type": "text", "text": getattr(e, "message", None) or str(e)}], "isError": True}
    except (ValueError, KeyError, TypeError) as e:
        return {"content": [{"type": "text", "text": "Paramètre invalide : %s" % e}], "isError": True}


INSTRUCTIONS = ("Registre : comptes bancaires personnels tenus à la main (pas de connexion bancaire). Montants en euros, négatifs pour les dépenses. "
                "Comptes courants : CCP (compte principal, salaire le 20 : son cycle se termine le 19), CE Joint, Revolut Perso et Revolut Joint (porte-monnaie électroniques, sans échéancier, alimentés par import de relevé) ; Livrets : Livret A, Livret A - Tess, "
                "Livret A - Yona, LDDS. Pointage : '-' non pointée, 'P' pointée, 'R' rapprochée avec un relevé. "
                "Avant toute écriture, présenter ce qui va être fait et obtenir l'accord de l'utilisateur. "
                "Pour pointer à partir d'un relevé, rechercher chaque ligne par date et montant avec l'outil operations, puis pointer les identifiants trouvés.")


def handle(msg):
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:
        return None
    if method == "initialize":
        want = (msg.get("params") or {}).get("protocolVersion")
        return {"protocolVersion": want if want in VERSIONS else VERSIONS[0], "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "registre", "title": "Registre", "version": "1.1"},
                "instructions": INSTRUCTIONS + (" Ce connecteur est en lecture seule." if READ_ONLY else "")}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": tool_list()}
    if method == "tools/call":
        p = msg.get("params") or {}
        return call_tool(p.get("name"), p.get("arguments") or {})
    if method in ("resources/list", "prompts/list"):
        return {method.split("/")[0]: []}
    raise LookupError(method)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            out = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "JSON invalide"}}
        else:
            try:
                res = handle(msg)
                if res is None:
                    continue
                out = {"jsonrpc": "2.0", "id": msg["id"], "result": res}
            except LookupError as e:
                out = {"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": -32601, "message": "Méthode inconnue : %s" % e}}
            except Exception as e:  # pragma: no cover
                out = {"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": -32603, "message": str(e)}}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
