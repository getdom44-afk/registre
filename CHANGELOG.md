# Nouveautés

## 1.0.2 — 10 novembre 2026

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
