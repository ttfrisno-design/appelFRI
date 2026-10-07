# Appel FRI — application mobile (PWA)

Application d'appel (présent / absent) du Foyer Rural d'Isneauville, installable sur téléphone
(Android et iPhone) depuis le navigateur. Elle écrit directement dans les classeurs Google Sheets
du dossier « 11-Classeurs adhérents par animateur » (1 = présent, 0 = absent).

## Architecture

| Partie | Emplacement | Rôle |
|---|---|---|
| Interface (PWA) | racine du dépôt (hébergée sur GitHub Pages) | Écrans, fonctionnement hors connexion, file d'attente des appels |
| Serveur (API JSON) | `serveur/Code.gs` (à coller dans Apps Script) | Vérifie les codes, lit et écrit dans les classeurs |

L'interface appelle le script Apps Script avec `fetch` (POST en texte brut, ce qui évite la requête
CORS préalable qu'Apps Script ne gère pas). Le fichier HTML « Index » de l'ancienne version n'est plus utilisé.

## Mise en place

1. **Serveur** : dans le projet Apps Script existant, remplacer tout le contenu de `Code.gs` par
   `serveur/Code.gs`, puis supprimer le fichier HTML « Index ».
2. **Codes des animateurs** (aucun code n'est plus écrit dans le script) :
   - exécuter une fois `migrerPinsExistants()` : les codes actuels restent valables, ils sont stockés
     sous forme hachée et l'ancienne liste en clair est effacée des propriétés du script ;
   - **conseillé** : les anciens codes ayant été écrits en clair dans le code source, les renouveler :
     mettre uniquement les **noms** dans la liste de `genererPins()` et l'exécuter. Les nouveaux codes
     s'affichent une seule fois dans le journal d'exécution.
3. **Code de consultation** (lecture seule) : exécuter `genererCodeConsultation()` et noter le code
   affiché. Il remplace l'ancien mode « Consulter sans code ».
4. **E-mails** : exécuter une fois `autoriserEnvoiEmails()` et accepter l'autorisation Google
   (envoyer des e-mails en votre nom).
5. **Déploiement** : *Déployer > Gérer les déploiements*, modifier le déploiement « Application Web »,
   choisir *Nouvelle version*. Exécuter en tant que : *Moi* ; accès : *Tout le monde*.
   Ouvrir l'URL `/exec` dans un navigateur doit afficher `{"ok":true,...}`.
6. **Interface** : coller cette URL `/exec` dans `js/config.js` (`API_URL`), puis publier
   (tout envoi sur `main` redéploie automatiquement ; activer une fois *Settings > Pages > Source : GitHub Actions*).
   L'application est alors disponible à l'adresse `https://ttfrisno-design.github.io/appelFRI/`.
7. **Installation sur le téléphone** : ouvrir l'adresse, puis
   - Android (Chrome) : menu ⋮ > *Installer l'application* / *Ajouter à l'écran d'accueil* ;
   - iPhone (Safari) : bouton Partager > *Sur l'écran d'accueil*.

## Fonctionnement

- **Connexion** : un seul champ, qui accepte un code animateur (appel + consultation) ou le code de
  consultation (lecture seule). Le serveur renvoie un jeton signé valable 30 jours : on ne retape pas
  son code à chaque ouverture, et le code lui-même n'est jamais conservé sur le téléphone.
- **Hors connexion** : l'application s'ouvre sans réseau. Les créneaux, dates et listes déjà consultés
  restent disponibles. Un appel validé est d'abord rangé sur le téléphone puis envoyé ; sans réseau
  il part automatiquement au retour de la connexion (bannière « appel(s) en attente d'envoi »).
  L'ajout d'un membre nécessite le réseau.
- **Sécurité des écritures différées** : à l'envoi, le serveur retrouve la colonne par le texte de la
  date et chaque adhérent par son nom ; si une synchronisation a déplacé des lignes entre-temps,
  l'appel est quand même écrit au bon endroit. Les cases qui ne font pas partie de l'appel ne sont jamais modifiées.
- **Prévenir le groupe** (écran d'appel, après choix de la date) : message prérempli
  (annulation pour absence de l'animateur), modifiable, envoyé au choix :
  - **par e-mail** : envoyé par le compte Google du script (fri.inscri@gmail.com) à toutes les adresses
    de la colonne Email du créneau, **un e-mail individuel par adhérent** ; le compte du script reçoit
    un récapitulatif avec la liste des destinataires. Hors connexion, l'e-mail part au retour du réseau.
    Limite Gmail gratuite : environ 100 destinataires par jour (`autoriserEnvoiEmails()` affiche le quota restant) ;
  - **par SMS** : depuis le téléphone de l'animateur, **un adhérent à la fois** : personne ne voit
    le numéro des autres.
- **Déconnexion** : efface le jeton et les listes gardées sur le téléphone (les appels en attente sont conservés).

## Sécurité

- Codes stockés uniquement sous forme d'empreinte (SHA-256 salé) dans les propriétés du script.
- Toutes les lectures exigent un jeton, y compris la consultation (qui ne renvoie jamais les téléphones).
- Changer le code d'un animateur invalide ses sessions ; `deconnecterToutLeMonde()` les invalide toutes.
- Au-delà de 20 codes faux en 15 minutes, les connexions sont bloquées 15 minutes
  (`debloquerConnexions()` pour lever le blocage).

## Fonctions d'administration (éditeur Apps Script)

| Fonction | Usage |
|---|---|
| `migrerPinsExistants()` | Une seule fois, pour reprendre les codes de l'ancienne version |
| `genererPins()` | Crée ou renouvelle les codes des noms listés dans la fonction |
| `listerAnimateursAvecPin()` | Liste les noms ayant un code |
| `supprimerPin(nom)` | Retire l'accès d'un animateur (à appeler avec le nom, depuis une petite fonction temporaire) |
| `genererCodeConsultation()` / `supprimerCodeConsultation()` | Crée (au hasard) ou supprime le code de lecture seule |
| `definirCodeConsultation(code)` | Choisit soi-même le code de lecture seule (via une fonction temporaire) |
| `deconnecterToutLeMonde()` | Invalide toutes les sessions ouvertes |
| `autoriserEnvoiEmails()` | Autorise l'envoi d'e-mails (une fois) et affiche le quota restant du jour |
| `viderCacheCreneaux()` | Rafraîchit immédiatement la liste des créneaux en consultation |
| `debloquerConnexions()` | Lève le blocage après trop de codes faux |

## Aller plus loin : application sur les stores

Le même code peut être emballé avec [Capacitor](https://capacitorjs.com/) pour produire une application
Android / iOS publiable sur Google Play et l'App Store, sans réécrire l'interface.
