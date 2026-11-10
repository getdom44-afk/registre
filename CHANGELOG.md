# Nouveautés

## 1.3.1 — 10 novembre 2026

- **Fusionner une sous-catégorie dans une autre**, y compris dans une autre catégorie. Va dans Paramètres › Catégories, colonne « Déplacer / fusionner vers ». La liste propose toutes les sous-catégories existantes, rangées par catégorie. Une confirmation indique le nombre d'opérations qui seront reclassées.

## 1.3.0 — 10 novembre 2026

- **Changer la catégorie de plusieurs opérations à la fois.** Sélectionnez-les, puis cliquez sur « Catégorie… » dans la barre d'outils. Indiquez la nouvelle catégorie et la sous-catégorie, puis « Appliquer ».
- **Sélection multiple dans la liste** :
  - Ctrl+clic ajoute ou retire une ligne ;
  - Maj+clic (ou Maj+flèches) sélectionne une plage ;
  - Ctrl+A sélectionne tout ;
  - Échap revient à une seule ligne.
  La barre d'état affiche le nombre de lignes sélectionnées et leur total. « Pointer » (ou Espace) et « Supprimer » agissent sur toute la sélection.
- **Archiver une catégorie ou une sous-catégorie** (Paramètres › Catégories, bouton « Archiver »). Une catégorie archivée n'est plus proposée quand vous saisissez une nouvelle opération ou échéance. Elle reste utilisable pour modifier une opération, pour « Catégorie… » et pour « Classer ». « Réactiver » annule l'archivage.

## 1.2.0 — 10 novembre 2026

- **Opérations les plus récentes en haut.** Les échéances à valider s'affichent au-dessus de la liste.
- **Colonne « Tiers / Détails »** : le tiers et les détails sont réunis dans une seule colonne. Les détails apparaissent en gris.
- **Prévision fin de mois** : elle ne concerne plus que le CCP (au 19). Elle indique le solde prévu, le nombre d'échéances d'ici là et le point bas.
- **Gestion des catégories** dans Paramètres, onglet Catégories :
  - renommer une catégorie ou une sous-catégorie, avec fusion si le nom existe déjà ;
  - déplacer une sous-catégorie vers une autre catégorie ;
  - créer et supprimer des catégories ;
  - rechercher.

  Toutes les opérations et échéances concernées sont mises à jour.

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
