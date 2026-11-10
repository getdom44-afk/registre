# Registre

Gestion de vos comptes bancaires, hébergée sur votre serveur Docker, dans l'esprit de Bank Perfect :

- **Saisie manuelle** de vos opérations, sans connexion à vos banques.
- **Familles de comptes avec icônes** :
  - Comptes courants : CCP, CE Joint, Revolut Perso, Revolut Joint.
  - Livrets : Livret A, Livret A - Tess, Livret A - Yona, LDDS.
- **Échéancier** : vos opérations récurrentes vous sont proposées à la validation, et les virements entre comptes sont inscrits des deux côtés.
- **Solde prévisionnel** à la date de votre choix, avec le point bas. Le CCP raisonne en cycle de salaire : sa fin de cycle est le 19.
- **Revolut** : import des relevés CSV, sans doublons, puis classement des dépenses par commerçant.
- **Pointage et rapprochement** avec vos relevés.
- **Reprise de Bank Perfect** : vos comptes et votre échéancier.
- **Sauvegarde quotidienne envoyée sur OneDrive.**
- **Connecteur MCP** pour que Claude, sur votre PC Windows, consulte et mette à jour vos comptes.
- **Accès protégé** par un mot de passe.

L'installation en résumé :
- **Sur le serveur** : deux conteneurs. `registre` (l'application) et `registre-onedrive` (l'envoi des sauvegardes).
- **Sur le PC Windows** : rien à installer. Vous utilisez votre navigateur, et Claude pour ordinateur si vous voulez le connecteur.

Dans ce guide, remplacez **SERVEUR** par l'adresse de votre machine Docker (par exemple `192.168.1.50`) et **UTILISATEUR** par votre identifiant sur cette machine.

---

## 1. Installer sur le serveur (une seule fois)

L'application est publiée sous forme d'image Docker privée sur GitHub. Le serveur n'a besoin que d'un seul fichier : `docker-compose.yml`.

1. **Autoriser le serveur à télécharger vos images privées.**
   1. Sur GitHub, ouvrez <https://github.com/settings/tokens/new>. C'est un « Personal access token (classic) ».
   2. Dans **Note**, écrivez `serveur registre`. Dans **Expiration**, choisissez **No expiration**. Cochez uniquement **read:packages**.
   3. Cliquez sur **Generate token**, puis copiez la clé qui commence par `ghp_`.
   4. Sur le serveur, tapez la commande ci-dessous. Collez la clé quand le mot de passe est demandé ; rien ne s'affiche pendant la saisie, c'est normal.

      ```
      docker login ghcr.io -u getdom44-afk
      ```
2. **Créer le dossier et le fichier.**

   ```
   mkdir ~/registre && cd ~/registre
   nano docker-compose.yml
   ```

   Collez le contenu du fichier `docker-compose.yml` de ce dépôt, puis enregistrez : Ctrl+O, Entrée, Ctrl+X. Gardez le nom de dossier `registre` : il sert à retrouver vos données.
3. **Lancer.**

   ```
   docker compose up -d
   ```
4. Depuis votre PC, ouvrez **http://SERVEUR:8080** et choisissez votre mot de passe (8 caractères minimum).

Lancez les commandes `docker` avec votre utilisateur habituel, sans `sudo`. Si Docker refuse, tapez `sudo usermod -aG docker $USER`, puis déconnectez-vous et reconnectez-vous.

Le service `registre-onedrive` indiquera « non configuré » tant que l'étape 4 n'est pas faite. C'est normal.

## 2. Reprendre vos données Bank Perfect

1. Ouvrez **Paramètres**, onglet **Importer / Exporter**, puis cliquez sur **Importer des fichiers…**.
2. **Les comptes** : sélectionnez vos 6 fichiers CSV en une fois. Chaque compte se range à sa place, avec son icône.
3. **L'échéancier** : choisissez `Echeances.bpsched`. Vérifiez les correspondances proposées (n° 1 → CCP, n° 3 → CE Joint, n° 0 → Livret A), puis importez.

Si vous réimportez un fichier, les opérations déjà présentes sont ignorées.

## 3. Revolut

Vos comptes Revolut Perso et Revolut Joint sont des porte-monnaie : pas d'échéancier, vous récupérez seulement les dépenses pour les classer.

1. **Exportez le relevé** depuis l'app Revolut : ouvrez le compte, choisissez **Relevé**, format **Excel/CSV**, sur la période voulue.
2. **Importez-le** : dans Registre, ouvrez **Paramètres**, onglet **Importer / Exporter**, puis **Importer des fichiers…**, rubrique **3. Revolut**. Choisissez le compte (Perso ou Joint), puis le fichier. À l'import :
   - les opérations arrivent **déjà pointées**, puisqu'elles viennent de la banque ;
   - les doublons sont ignorés, même si deux relevés se chevauchent ;
   - les opérations en attente, annulées, ou passées par vos coffres d'épargne sont ignorées ;
   - les frais (retrait, change) sont inscrits en ligne séparée ;
   - au premier import, le solde de départ est déduit du relevé. Registre vérifie ensuite que son solde est bien celui de Revolut.
3. **Classez** avec le bouton **Classer** (le badge indique combien d'opérations restent sans catégorie). Les opérations sans catégorie y sont regroupées par commerçant. Choisissez une catégorie et une sous-catégorie, puis **Appliquer** (ou Entrée) : toutes les opérations de ce commerçant sont classées d'un coup. La prochaine fois, ce commerçant sera classé automatiquement à l'import.

Le filtre **Afficher : À classer** de la barre d'outils montre aussi ces opérations dans la grille.

## 4. Sauvegarde automatique sur OneDrive (une seule fois)

Chaque jour, Registre fait une copie de ses données (les 30 dernières sont gardées). Le conteneur `registre-onedrive` les envoie toutes les heures dans votre OneDrive, dans le dossier `Sauvegardes/Registre`. Vous pouvez changer ce dossier avec la ligne `DEST` du fichier `docker-compose.yml`.

Il faut autoriser l'accès à votre OneDrive une seule fois, avec l'outil gratuit **rclone**.

**a) Sur votre PC Windows**, pour obtenir l'autorisation Microsoft :
1. Téléchargez rclone pour Windows : <https://rclone.org/downloads/> (fichier zip « Windows, Intel/AMD 64 bit »). Décompressez-le.
2. Ouvrez PowerShell dans le dossier décompressé et tapez :

   ```
   .\rclone.exe authorize "onedrive"
   ```
3. Votre navigateur s'ouvre : connectez-vous avec votre compte Microsoft et acceptez.
4. PowerShell affiche un long texte qui commence par `{"access_token":` et se termine par `}`. **Copiez tout ce texte.**

**b) Sur le serveur**, dans `~/registre` :
1. Lancez :

   ```
   docker run --rm -it -v ~/registre/rclone:/config/rclone rclone/rclone:1.68 config
   ```
2. Répondez aux questions :

   | Question | Réponse |
   |---|---|
   | `n/s/q>` | `n` (nouveau) |
   | `name>` | `onedrive` (exactement ce nom) |
   | `Storage>` | `onedrive` |
   | `client_id>` et `client_secret>` | Entrée (laisser vide) |
   | `region>` | `1` (Microsoft Cloud Global) |
   | `Edit advanced config?` | `n` |
   | `Use web browser to automatically authenticate?` | `n` |
   | `config_token>` | collez le texte copié à l'étape a) |
   | `config_type>` | `1` (OneDrive Personal or Business) |
   | `config_driveid>` | `1` (votre OneDrive) |
   | `Is that okay?` puis `Keep this remote?` | `y`, puis `q` pour quitter |
3. Relancez le service d'envoi :

   ```
   docker compose restart registre-onedrive
   ```

**Vérifier que ça marche.** Cliquez sur **Sauvegarde Cloud** dans la barre d'outils. Une copie est faite et envoyée sur OneDrive dans les secondes qui suivent ; un message confirme l'envoi. L'état est aussi visible dans **Paramètres**, onglet **Sauvegardes**.

**Restaurer.** Récupérez un fichier `registre-AAAA-MM-JJ.db` dans votre OneDrive. Ouvrez **Paramètres**, onglet **Sauvegardes**, puis **Restaurer un fichier…**.

## 5. Connecteur MCP : Claude sur votre PC, Registre sur le serveur

Claude pour ordinateur, sur votre PC Windows, se connecte au serveur par **SSH**. SSH est intégré à Windows : il n'y a rien à installer.

**a) Une seule fois, sur le serveur :** votre utilisateur doit pouvoir utiliser Docker sans `sudo`. Tapez :

```
sudo usermod -aG docker UTILISATEUR
```

Déconnectez-vous puis reconnectez-vous pour que ce soit pris en compte.

**b) Sur votre PC, dans PowerShell :** créez une clé SSH, pour que la connexion se fasse sans mot de passe.

```
ssh-keygen -t ed25519
```

Appuyez sur Entrée à chaque question. Puis envoyez la clé au serveur ; il vous demandera votre mot de passe une dernière fois.

```
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh UTILISATEUR@SERVEUR "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

Vérifiez que la commande répond sans demander de mot de passe ; elle doit afficher le conteneur `registre` :

```
ssh UTILISATEUR@SERVEUR docker ps --filter name=registre
```

**c) Dans Claude pour ordinateur :**
1. Ouvrez **Paramètres**, puis **Développeur**, puis **Modifier la configuration**.
2. Ajoutez le contenu de `claude_desktop_config.exemple.json`, en remplaçant `UTILISATEUR@ADRESSE-DU-SERVEUR`. Si une rubrique `mcpServers` existe déjà, ajoutez seulement le bloc `"registre": {…}` à l'intérieur.
3. Quittez complètement Claude, puis relancez-le.

**Lecture seule** : pour que Claude puisse seulement consulter, remplacez la dernière ligne par :

```
"docker exec -i registre python /app/mcp_stdio.py --lecture-seule"
```

**Ce que Claude peut faire**

| Lecture | Écriture (si autorisée) |
|---|---|
| Comptes, soldes, prévision fin de cycle | Ajouter une opération ou un virement |
| Rechercher des opérations | Modifier, supprimer une opération |
| Statistiques par catégorie, tiers ou mois | Pointer / dépointer |
| Solde prévisionnel à une date | Valider ou sauter une échéance |
| Échéancier, échéances à valider | Classer les dépenses par tiers |
| Opérations à classer | Importer un relevé Revolut |

Quelques exemples de demandes :
- « Voici mon relevé Revolut : importe-le sur Revolut Joint et propose-moi un classement des dépenses. »
- « Quel sera le solde du CCP le 19 ? »
- « Combien ai-je dépensé en restaurants ce trimestre, tous comptes confondus ? »

## 5 bis. Accès en HTTPS (https://debian.home:6001)

Le service `registre-https` (Caddy) sert Registre en HTTPS sur le port 6001. Le certificat est émis par une autorité de certification locale, créée au premier démarrage. Il faut l'installer **une fois** sur chaque PC, sinon le navigateur affiche un avertissement.

1. Sur le serveur, récupérer le certificat de l'autorité :
   `docker cp registre-https:/data/caddy/pki/authorities/local/root.crt ~/registre-ca.crt`
2. Sur le PC Windows, dans PowerShell :
   `scp olivier@192.168.1.4:registre-ca.crt $HOME\Downloads\`
3. Double-cliquer sur `registre-ca.crt`, puis :
   - « Installer le certificat » › « Ordinateur local » ;
   - « Placer tous les certificats dans le magasin suivant » › « Autorités de certification racines de confiance ».
4. Fermer complètement le navigateur, puis ouvrir https://debian.home:6001.

Derrière HTTPS, le cookie de session est automatiquement marqué « Secure ». Le HTTPS est aussi le prérequis des passkeys.

## 6. Utilisation au quotidien

| Action | Comment |
|---|---|
| Saisir | Zone **Nouvelle opération**. Un tiers connu remplit sa catégorie. |
| Virement entre comptes | Champ **Virement vers**. |
| Modifier / Pointer / Supprimer | Double-clic / clic en colonne **P** ou Espace / Suppr |
| Échéances | Bouton **Échéancier** : échéances des 30 prochains jours ; celles à valider sont surlignées, avec **Valider** et **Sauter**. Elles apparaissent aussi en bas de la grille du compte. |
| Prévision | Bouton **Prévision** : date au choix, point bas, détail par compte. |
| Couleurs | Lignes **vertes** : pointées. Lignes **orangées** : non pointées. |
| Sauvegarder | Bouton **Sauvegarder** (ou Ctrl+S) : crée un point de sauvegarde, comme un commit. La barre d'état indique les modifications faites depuis ; « Annuler » y revient. Les points précédents sont dans **Paramètres**, onglet **Sauvegardes**. |
| Sauvegarde Cloud | Envoie tout de suite une copie complète sur OneDrive. |
| Prévision fin de mois | En bas de la liste des comptes (le CCP au 19). Un clic ouvre la prévision détaillée. |
| Classer | Bouton **Classer** : par commerçant, en un clic. |
| Comptes, familles, icônes, fin de cycle | **Paramètres** |
| Catégories | **Paramètres**, onglet **Catégories** : renommer, fusionner, déplacer, créer, supprimer. |

## 7. Questions pratiques

**Mises à jour.** Elles sont automatiques : chaque nuit à 4 h, le service `registre-watchtower` installe la dernière version publiée. Juste avant, Registre fait une copie de sécurité `registre-avant-VERSION-….db`, envoyée sur OneDrive comme les autres. La version installée s'affiche en bas de **Paramètres**. Pour installer tout de suite, tapez :

```
cd ~/registre && docker compose pull && docker compose up -d
```

**Revenir à une version précédente.** Dans `docker-compose.yml`, remplacez `:stable` par le numéro voulu, par exemple `:1.0.0`, puis lancez `docker compose up -d`. Remettez `:stable` pour reprendre les mises à jour automatiques.

**Le port 8080 est pris.** Dans `docker-compose.yml`, remplacez `"8080:8080"` par `"8090:8080"`, relancez `docker compose up -d`, puis utilisez http://SERVEUR:8090.

**J'ai oublié mon mot de passe.**
1. Dans `docker-compose.yml`, retirez le `#` devant `RESET_PASSWORD: "1"`.
2. Lancez `docker compose up -d`, puis choisissez un nouveau mot de passe dans l'application.
3. Remettez le `#` devant la ligne, puis relancez `docker compose up -d`.

**Accès depuis l'extérieur (téléphone en 4G…).** N'ouvrez pas le port sur Internet. Passez par un VPN comme Tailscale, installé sur le serveur et le téléphone, ou par un proxy inverse en HTTPS avec `COOKIE_SECURE: "1"`.

**L'envoi OneDrive indique une erreur.** Consultez le détail avec `docker logs registre-onedrive`, ou dans **Paramètres**. L'autorisation Microsoft se renouvelle automatiquement. Si elle a été révoquée, refaites l'étape 4.
