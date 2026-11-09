# Registre — notes pour Claude

Application personnelle de gestion de comptes (remplace Bank Perfect), auto-hébergée sur le serveur Docker de l'utilisateur. Interface et textes en français.

## Structure
- `app/server.py` : serveur HTTP + API JSON, bibliothèque standard Python 3.12 et SQLite uniquement (aucune dépendance). Les migrations de schéma sont dans `migrate()` et doivent rester non destructives.
- `app/static/` : interface (HTML/CSS/JS sans framework, CSP `'self'` : pas de script ni de style en ligne).
- `app/mcp_stdio.py` : connecteur MCP (stdio), lancé par `ssh … docker exec -i registre python /app/mcp_stdio.py`.
- `docker-compose.yml` : fichier d'installation côté serveur (image `ghcr.io/getdom44-afk/registre:stable`, rclone vers OneDrive, Watchtower).
- `.github/workflows/publier.yml` : construit et publie l'image quand la branche `stable` avance (numéro dans `VERSION`, étiquettes `X.Y.Z` et `stable`).

## Publier une version
1. Tester localement (`DATA_DIR=/tmp/x BACKUP_DIR=/tmp/y python3 app/server.py`) avec de vraies données si possible.
2. Ajouter une entrée en haut de `CHANGELOG.md` (en français, orientée utilisateur).
3. Mettre à jour `VERSION`, commit et push sur `main`, puis `git push origin main:stable` : l'image est construite par GitHub Actions et Watchtower l'installe la nuit suivante (sauvegarde automatique avant mise à niveau). Les étiquettes git ne peuvent pas être poussées depuis les sessions Claude.
4. Ne publier qu'après validation par l'utilisateur.

## Plan de comptes
Défini dans `LAYOUT` / `FAMILIES` de `server.py`. CCP : fin de cycle le 19 (salaire le 20).
