# Nouveautés

## 1.1.0 — 10 novembre 2026

- **Couleurs** : les lignes pointées sont vertes, les lignes non pointées sont orangées.
- **Bouton Sauvegarder** (ou Ctrl+S) : il crée un point de sauvegarde, comme un commit. La barre d'état indique les modifications faites depuis, et le lien « Annuler » permet d'y revenir. Les 50 derniers points sont dans Paramètres, onglet Sauvegardes.
- **Bouton Sauvegarde Cloud** : il envoie tout de suite une copie sur OneDrive. Il faut remettre à jour une fois le fichier docker-compose.yml.
- **Échéancier** : il montre les échéances à venir. Celles à valider y sont surlignées, avec Valider et Sauter.
- **Prévision fin de mois** : elle s'affiche en bas de la liste des comptes.
- **Barre d'outils allégée** : les boutons Rapprocher et À valider sont retirés, ainsi que le total général.
- **Paramètres** : la fenêtre est plus grande et organisée en onglets (Comptes, Importer / Exporter, Sauvegardes, Préférences). L'import et l'export y sont rangés.

## 1.0.2 — 10 novembre 2026 (intégrée à la 1.1.0)

- **Import Revolut corrigé** : les opérations annulées, marquées « RENVOYÉ » dans le relevé en français, ne sont plus comptées. Elles faussaient le solde.
- **Paiements en attente** : ils sont inscrits sans être pointés, comme dans l'app Revolut. Le solde de Registre est donc celui qu'affiche Revolut. À l'import suivant, un paiement finalisé est pointé, et un paiement annulé est retiré.
- **Arrondis vers la Pocket** : ils sont classés automatiquement en Epargne / Arrondis Revolut.

## 1.0.1 — 9 novembre 2026

- **Icônes de compte** : le bouton « Choisir » dans Paramètres fonctionne. L'image était bloquée par la protection du navigateur.
- **Noms de comptes** : « Livret A Tess » et « Livret A - Tess » sont reconnus comme le même compte. Les comptes concernés reprennent leur famille, leur ordre et leur icône, et un nouvel import ne crée plus de doublon.

## 1.0.0 — 9 novembre 2026

Première version publiée :

- **Comptes et familles** : Comptes courants (CCP, CE Joint, Revolut Perso, Revolut Joint) et Livrets, avec leurs icônes.
- **Saisie et virements** : saisie manuelle des opérations ; les virements entre comptes sont inscrits des deux côtés.
- **Échéancier** : les échéances arrivées sont proposées à la validation.
- **Pointage et rapprochement** avec les relevés.
- **Solde prévisionnel** à une date au choix, avec le point bas ; le cycle du CCP se termine le 19.
- **Reprise de Bank Perfect** : comptes en CSV et échéancier.
- **Revolut** : import des relevés CSV et classement des dépenses par commerçant.
- **Sauvegardes** : copie quotidienne envoyée sur OneDrive, et copie de sécurité avant chaque mise à jour.
- **Connecteur MCP** pour Claude, via SSH.
