/**
 * ============================================================
 * FRI — Application d'appel (présent/absent) par animateur
 * API JSON Apps Script utilisée par l'application mobile (PWA)
 * hébergée séparément (dépôt GitHub appelFRI).
 * Écrit directement dans les classeurs déjà créés dans
 * "11-Classeurs adhérents par animateur" (1 = présent, 0 = absent).
 * ============================================================
 *
 * MISE EN PLACE (voir aussi README.md) :
 * 1. Dans le projet Apps Script existant, remplacer tout le contenu
 *    de Code.gs par ce fichier. Le fichier HTML "Index" peut être
 *    supprimé : l'interface est désormais la PWA.
 * 2. Vérifier CONFIG.DEST_FOLDER_ID_ANIMATEURS ci-dessous.
 * 3. PIN des animateurs — AUCUN code ne doit être écrit dans ce fichier :
 *    - si des PIN existent déjà (ancienne version) : exécuter une fois
 *      migrerPinsExistants() → ils sont chiffrés (hachés) et l'ancienne
 *      liste en clair est supprimée des propriétés du script ;
 *    - pour créer ou renouveler des PIN : renseigner uniquement les NOMS
 *      dans genererPins() puis l'exécuter ; les codes tirés au hasard
 *      s'affichent une seule fois dans le journal d'exécution.
 * 4. Code de consultation (lecture seule, sans droit d'écriture) :
 *    exécuter genererCodeConsultation() et noter le code affiché.
 * 5. Déployer > Gérer les déploiements > modifier le déploiement
 *    "Application Web" existant > Nouvelle version.
 *    Exécuter en tant que : Moi. Qui a accès : Tout le monde.
 * 6. Copier l'URL (se termine par /exec) dans js/config.js.
 *
 * Sécurité :
 * - Les PIN ne sont stockés que sous forme hachée (SHA-256 salé)
 *   dans les propriétés du script, jamais en clair.
 * - Après connexion, l'application reçoit un jeton signé valable
 *   30 jours ; le PIN n'est jamais conservé sur le téléphone.
 *   Changer le PIN d'un animateur invalide ses jetons ;
 *   deconnecterToutLeMonde() les invalide tous.
 * - Toutes les lectures (y compris la consultation) exigent un jeton.
 * - Au-delà de 20 codes faux en 15 minutes, les connexions sont
 *   bloquées 15 minutes (protection contre les essais au hasard).
 * ============================================================
 */

var CONFIG = {
  DEST_FOLDER_ID_ANIMATEURS: '1ShdHxXvGdU0wim2xbyPxShZ8Zan3uOC6', // 11-Classeurs adhérents par animateur
  DUREE_JETON_JOURS: 30,
  MAX_ECHECS: 20,
  DUREE_BLOCAGE_SEC: 900
};

// Mêmes préfixes que le script des classeurs — sert à filtrer le mode
// consultation par type d'activité sans avoir à tout charger.
var TYPES = {
  'APA': 'APA', 'Country': 'COUN', 'Couture': 'COUT', 'Fitness': 'FIT',
  'Guitare': 'GUIT', 'Gym': 'GYM', 'Jazz': 'JAZ', 'Meditation': 'MED',
  'MarcheNordique': 'MNO', 'Peinture': 'PEIN', 'Pilates': 'PIL',
  'FFTT': 'PING', 'Sophrologie': 'SOPH', 'Theatre': 'THE', 'Yoga': 'YOGA'
};

var ROLE_ANIMATEUR = 'animateur';
var ROLE_CONSULTATION = 'consultation';

// ── Point d'entrée de l'API ─────────────────────────────────────
// L'application envoie un POST avec un corps texte JSON :
// { action: "...", jeton: "...", ...paramètres }
// (texte brut volontairement : évite la requête CORS préalable).

// Actions disponibles. role : null = sans jeton, 'animateur' = animateur
// uniquement, 'lecture' = animateur ou code de consultation.
var ACTIONS = {
  connecter: { role: null, fn: actionConnecter_ },
  listerCreneaux: { role: ROLE_ANIMATEUR, fn: actionListerCreneaux_ },
  listerDates: { role: ROLE_ANIMATEUR, fn: actionListerDates_ },
  listerMembres: { role: ROLE_ANIMATEUR, fn: actionListerMembres_ },
  ajouterMembre: { role: ROLE_ANIMATEUR, fn: actionAjouterMembre_ },
  enregistrerAppel: { role: ROLE_ANIMATEUR, fn: actionEnregistrerAppel_ },
  listerTypesActivite: { role: 'lecture', fn: actionListerTypesActivite_ },
  listerTousLesCreneaux: { role: 'lecture', fn: actionListerTousLesCreneaux_ },
  listerDatesConsult: { role: 'lecture', fn: actionListerDatesConsult_ },
  listerPresencesConsult: { role: 'lecture', fn: actionListerPresencesConsult_ }
};

function doPost(e) {
  return repondre_(traiter_(e && e.postData ? e.postData.contents : ''));
}

// Simple vérification que le déploiement répond (ouvrir l'URL /exec dans un navigateur).
function doGet() {
  return repondre_({ ok: true, service: 'FRI — Appel', version: 2 });
}

function repondre_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function traiter_(corps) {
  var req;
  try {
    req = JSON.parse(corps || '{}');
  } catch (err) {
    return { ok: false, message: 'Requête illisible.' };
  }
  var action = ACTIONS[req.action];
  if (!action) return { ok: false, message: 'Action inconnue.' };

  var session = null;
  if (action.role) {
    session = verifierJeton_(req.jeton);
    if (!session) return { ok: false, sessionExpiree: true, message: 'Session expirée, reconnecte-toi.' };
    if (action.role === ROLE_ANIMATEUR && session.role !== ROLE_ANIMATEUR) {
      return { ok: false, message: 'Action réservée aux animateurs.' };
    }
  }

  try {
    return action.fn(req, session);
  } catch (err) {
    return { ok: false, message: 'Erreur serveur (' + req.action + ') : ' + err.message };
  }
}

// ── Hachage et secrets (propriétés du script, jamais dans le code) ──

function props_() {
  return PropertiesService.getScriptProperties();
}

// Crée à la première utilisation une valeur aléatoire conservée dans les propriétés.
function secret_(cle) {
  var p = props_();
  var v = p.getProperty(cle);
  if (!v) {
    v = Utilities.getUuid() + Utilities.getUuid();
    p.setProperty(cle, v);
  }
  return v;
}

function hex_(octets) {
  return octets.map(function(b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function hacherPin_(pin) {
  var octets = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    secret_('SEL_PIN') + ':' + String(pin), Utilities.Charset.UTF_8);
  return hex_(octets);
}

function getPinsHash_() {
  var raw = props_().getProperty('PINS_HASH');
  return raw ? JSON.parse(raw) : {};
}

function setPinsHash_(pins) {
  props_().setProperty('PINS_HASH', JSON.stringify(pins));
}

function verifierFormatPin_(pin, libelle) {
  pin = String(pin).trim();
  if (!/^\d{6}$/.test(pin)) throw new Error('PIN invalide pour "' + libelle + '" — doit être exactement 6 chiffres.');
  return pin;
}

// ── Jetons de session signés (HMAC) ─────────────────────────────
// Contenu : nom, rôle, date d'expiration et empreinte du PIN utilisé.
// Si le PIN change, l'empreinte ne correspond plus et le jeton est refusé.

function signer_(texte) {
  var octets = Utilities.computeHmacSha256Signature(texte, secret_('SECRET_JETON'));
  return Utilities.base64EncodeWebSafe(octets).replace(/=+$/, '');
}

function creerJeton_(nom, role, hashPin) {
  var contenu = {
    n: nom,
    r: role,
    e: Date.now() + CONFIG.DUREE_JETON_JOURS * 24 * 3600 * 1000,
    v: hashPin.slice(0, 16)
  };
  var corps = Utilities.base64EncodeWebSafe(JSON.stringify(contenu), Utilities.Charset.UTF_8).replace(/=+$/, '');
  return corps + '.' + signer_(corps);
}

function verifierJeton_(jeton) {
  if (!jeton || typeof jeton !== 'string') return null;
  var parties = jeton.split('.');
  if (parties.length !== 2 || signer_(parties[0]) !== parties[1]) return null;
  var contenu;
  try {
    var b64 = parties[0] + '===='.slice(0, (4 - parties[0].length % 4) % 4);
    contenu = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(b64)).getDataAsString('UTF-8'));
  } catch (err) {
    return null;
  }
  if (!contenu || contenu.e < Date.now()) return null;

  var hashActuel = contenu.r === ROLE_CONSULTATION
    ? props_().getProperty('CONSULTATION_HASH')
    : getPinsHash_()[contenu.n];
  if (!hashActuel || hashActuel.slice(0, 16) !== contenu.v) return null;

  return { nom: contenu.n, role: contenu.r };
}

// ── Limitation des essais de code ───────────────────────────────

function tropDEchecs_() {
  return Number(CacheService.getScriptCache().get('ECHECS_PIN') || 0) >= CONFIG.MAX_ECHECS;
}

function noterEchec_() {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get('ECHECS_PIN') || 0) + 1;
  cache.put('ECHECS_PIN', String(n), CONFIG.DUREE_BLOCAGE_SEC);
}

// ── Connexion ───────────────────────────────────────────────────

function actionConnecter_(req) {
  var pin = String(req.pin || '').trim();
  if (!/^\d{6}$/.test(pin)) return { ok: false, message: 'Le code doit contenir 6 chiffres.' };
  if (tropDEchecs_()) return { ok: false, message: 'Trop de codes erronés. Réessaie dans 15 minutes.' };

  var hash = hacherPin_(pin);

  var pins = getPinsHash_();
  for (var nom in pins) {
    if (pins[nom] === hash) {
      return { ok: true, role: ROLE_ANIMATEUR, animateur: nom, jeton: creerJeton_(nom, ROLE_ANIMATEUR, hash) };
    }
  }

  if (props_().getProperty('CONSULTATION_HASH') === hash) {
    return { ok: true, role: ROLE_CONSULTATION, animateur: 'Consultation', jeton: creerJeton_('Consultation', ROLE_CONSULTATION, hash) };
  }

  noterEchec_();
  return { ok: false, message: 'Code incorrect.' };
}

// ── Accès aux classeurs ─────────────────────────────────────────

function parties_(nom) {
  return String(nom || '').split('/').map(function(p) { return p.trim(); });
}

// Trouve tous les classeurs concernant un animateur : le sien en
// propre, ET tout classeur co-animé (nom de fichier du style
// "G. LEBOURG/J. BREMAUD") dont il/elle fait partie.
// nomAnimateur peut lui-même être un nom composé (ex: "C. MAURICE/X. TRUSSART")
// quand seul un PIN commun existe pour ce binôme, sans PIN individuel.
function fichiersPourAnimateur_(nomAnimateur) {
  var it = DriveApp.getFolderById(CONFIG.DEST_FOLDER_ID_ANIMATEURS).getFiles();
  var fichiers = [];
  while (it.hasNext()) {
    var file = it.next();
    if (file.getMimeType() !== MimeType.GOOGLE_SHEETS) continue;
    if (autoriseAcces_(nomAnimateur, file.getName())) fichiers.push(file.getName());
  }
  return fichiers;
}

// Vérifie qu'un animateur a bien le droit d'accéder à un classeur
// donné (le sien en propre, ou un classeur co-animé dont il fait partie).
function autoriseAcces_(nomAnimateur, animateurFichier) {
  if (nomAnimateur === animateurFichier) return true;
  var partiesAnimateur = parties_(nomAnimateur);
  return parties_(animateurFichier).some(function(p) { return partiesAnimateur.indexOf(p) !== -1; });
}

function ouvrirClasseurAnimateur_(nomAnimateur) {
  var it = DriveApp.getFolderById(CONFIG.DEST_FOLDER_ID_ANIMATEURS).getFilesByName(nomAnimateur);
  if (!it.hasNext()) return null;
  return SpreadsheetApp.open(it.next());
}

// Ouvre l'onglet demandé, ou renvoie un message d'erreur.
function ouvrirOnglet_(animateurFichier, code) {
  var ss = ouvrirClasseurAnimateur_(animateurFichier);
  if (!ss) return { erreur: 'Classeur introuvable (' + animateurFichier + ').' };
  var sheet = ss.getSheetByName(code);
  if (!sheet) return { erreur: 'Créneau introuvable (' + code + ').' };
  return { sheet: sheet };
}

function decrireOnglet_(nomFichier, sheet) {
  var titreBrut = String(sheet.getRange(1, 1).getValue() || '');
  return {
    animateurFichier: nomFichier,
    code: sheet.getName(),
    activite: titreBrut.split(' — Animateur')[0],
    jour: sheet.getRange(1, 6).getDisplayValue() || '',
    heure: sheet.getRange(1, 7).getDisplayValue() || ''
  };
}

// Colonnes fixes A-E, puis une colonne par date (en-têtes en ligne 3).
// getDisplayValues() : toujours le texte affiché (dd/MM/yyyy), même si
// Sheets a stocké la cellule comme une vraie date en interne.
function lireDates_(sheet) {
  var nDateCols = sheet.getLastColumn() - 5;
  if (nDateCols <= 0) return { ok: true, dates: [], aujourdhui: '' };
  var headers = sheet.getRange(3, 6, 1, nDateCols).getDisplayValues()[0];
  var dates = [];
  for (var i = 0; i < headers.length; i++) {
    if (headers[i]) dates.push({ texte: headers[i], colonne: 6 + i });
  }
  return { ok: true, dates: dates, aujourdhui: Utilities.formatDate(new Date(), 'Europe/Paris', 'dd/MM/yyyy') };
}

function valeurPresence_(v) {
  return (v === 1 || v === '1') ? 1 : (v === 0 || v === '0') ? 0 : null;
}

function lireMembres_(sheet, colonne, avecTelephone) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 4) return [];
  var noms = sheet.getRange(4, 1, lastRow - 3, 3).getDisplayValues(); // A:C (Nom, Prénom, Téléphone tel qu'affiché)
  var valeurs = sheet.getRange(4, colonne, lastRow - 3, 1).getValues();
  var membres = [];
  for (var i = 0; i < noms.length; i++) {
    if (!noms[i][0] && !noms[i][1]) continue;
    var m = { ligne: 4 + i, nom: noms[i][0], prenom: noms[i][1], present: valeurPresence_(valeurs[i][0]) };
    if (avecTelephone) m.telephone = noms[i][2];
    membres.push(m);
  }
  return membres;
}

function colonneValide_(colonne) {
  colonne = Number(colonne);
  return (colonne === Math.floor(colonne) && colonne >= 6) ? colonne : null;
}

// ── Actions animateur ───────────────────────────────────────────

function actionListerCreneaux_(req, session) {
  var fichiers = fichiersPourAnimateur_(session.nom);
  if (fichiers.length === 0) return { ok: false, message: 'Aucun classeur trouvé pour ' + session.nom + '.' };
  var creneaux = [];
  fichiers.forEach(function(nomFichier) {
    var ss = ouvrirClasseurAnimateur_(nomFichier);
    if (!ss) return;
    ss.getSheets().forEach(function(sheet) { creneaux.push(decrireOnglet_(nomFichier, sheet)); });
  });
  return { ok: true, animateur: session.nom, creneaux: creneaux };
}

function actionListerDates_(req, session) {
  if (!autoriseAcces_(session.nom, req.animateurFichier)) return { ok: false, message: 'Accès non autorisé à ce classeur.' };
  var o = ouvrirOnglet_(req.animateurFichier, req.code);
  if (o.erreur) return { ok: false, message: o.erreur };
  return lireDates_(o.sheet);
}

function actionListerMembres_(req, session) {
  if (!autoriseAcces_(session.nom, req.animateurFichier)) return { ok: false, message: 'Accès non autorisé à ce classeur.' };
  var colonne = colonneValide_(req.colonne);
  if (!colonne) return { ok: false, message: 'Date invalide.' };
  var o = ouvrirOnglet_(req.animateurFichier, req.code);
  if (o.erreur) return { ok: false, message: o.erreur };
  return { ok: true, membres: lireMembres_(o.sheet, colonne, true) };
}

// Ajoute manuellement un membre (ex. essai, inscription de dernière
// minute) directement dans l'onglet. Utilise un N° Dossier synthétique
// (préfixe "MANUEL-") pour ne jamais être touché ni écrasé par les
// synchros automatiques depuis le fichier source.
function actionAjouterMembre_(req, session) {
  if (!autoriseAcces_(session.nom, req.animateurFichier)) return { ok: false, message: 'Accès non autorisé à ce classeur.' };
  var nom = String(req.nom || '').trim();
  var prenom = String(req.prenom || '').trim();
  if (!nom && !prenom) return { ok: false, message: 'Nom ou prénom requis.' };

  var o = ouvrirOnglet_(req.animateurFichier, req.code);
  if (o.erreur) return { ok: false, message: o.erreur };
  var sheet = o.sheet;

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var telDigits = String(req.telephone || '').replace(/\D/g, '');
    var ligne = Math.max(sheet.getLastRow() + 1, 4);
    sheet.getRange(ligne, 1, 1, 5).setValues([[
      nom,
      prenom,
      telDigits ? Number(telDigits) : '',
      String(req.email || '').trim(),
      'MANUEL-' + new Date().getTime()
    ]]);
    SpreadsheetApp.flush();
    return { ok: true, ligne: ligne };
  } finally {
    lock.releaseLock();
  }
}

// Un appel peut avoir été fait hors connexion et envoyé plus tard :
// entre-temps une synchro a pu déplacer des lignes ou des colonnes.
// On vérifie donc la date (texte de l'en-tête) et le nom de chaque
// adhérent avant d'écrire, et on retrouve la bonne case sinon.
function actionEnregistrerAppel_(req, session) {
  if (!autoriseAcces_(session.nom, req.animateurFichier)) return { ok: false, message: 'Accès non autorisé à ce classeur.' };
  var presences = Array.isArray(req.presences) ? req.presences : [];
  if (presences.length === 0) return { ok: false, message: 'Aucune présence à enregistrer.' };

  var o = ouvrirOnglet_(req.animateurFichier, req.code);
  if (o.erreur) return { ok: false, message: o.erreur };
  var sheet = o.sheet;

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var colonne = colonneValide_(req.colonne);
    var infoDates = lireDates_(sheet);
    if (req.date) {
      var dateTrouvee = infoDates.dates.filter(function(d) { return d.texte === req.date; })[0];
      if (!dateTrouvee) return { ok: false, message: 'La date ' + req.date + ' n\'existe plus dans ce créneau.' };
      colonne = dateTrouvee.colonne;
    }
    if (!colonne) return { ok: false, message: 'Date invalide.' };

    var lastRow = sheet.getLastRow();
    if (lastRow < 4) return { ok: false, message: 'Aucun adhérent dans ce créneau.' };
    var noms = sheet.getRange(4, 1, lastRow - 3, 2).getDisplayValues();

    var cle = function(nom, prenom) { return String(nom || '').trim().toLowerCase() + '|' + String(prenom || '').trim().toLowerCase(); };
    var ligneParNom = {};
    noms.forEach(function(n, i) { ligneParNom[cle(n[0], n[1])] = i; });

    var nonTrouves = [];
    var aEcrire = {}; // index de ligne → valeur
    presences.forEach(function(p) {
      var valeur = Number(p.valeur);
      if (valeur !== 0 && valeur !== 1) return;
      var idx = Number(p.ligne) - 4;
      var nomConnu = p.nom !== undefined || p.prenom !== undefined;
      if (nomConnu && !(idx >= 0 && idx < noms.length && cle(noms[idx][0], noms[idx][1]) === cle(p.nom, p.prenom))) {
        idx = ligneParNom.hasOwnProperty(cle(p.nom, p.prenom)) ? ligneParNom[cle(p.nom, p.prenom)] : -1;
      }
      if (!(idx >= 0 && idx < noms.length)) {
        nonTrouves.push(((p.prenom || '') + ' ' + (p.nom || '')).trim() || ('ligne ' + p.ligne));
        return;
      }
      aEcrire[idx] = valeur;
    });

    // Écriture par blocs de lignes consécutives : les autres cases de la
    // colonne ne sont jamais touchées.
    var indices = Object.keys(aEcrire).map(Number).sort(function(a, b) { return a - b; });
    var debut = 0;
    for (var i = 1; i <= indices.length; i++) {
      if (i === indices.length || indices[i] !== indices[i - 1] + 1) {
        var bloc = indices.slice(debut, i).map(function(idx) { return [aEcrire[idx]]; });
        sheet.getRange(4 + indices[debut], colonne, bloc.length, 1).setValues(bloc);
        debut = i;
      }
    }

    var res = { ok: true, nombre: indices.length };
    if (nonTrouves.length) res.nonTrouves = nonTrouves;
    return res;
  } finally {
    lock.releaseLock();
  }
}

// ── Actions de consultation (lecture seule, jeton obligatoire) ──

function actionListerTypesActivite_() {
  return { ok: true, types: Object.keys(TYPES).sort() };
}

// Liste tous les créneaux de tous les animateurs pour un type d'activité.
function actionListerTousLesCreneaux_(req) {
  var type = req.type;
  if (!type || !TYPES.hasOwnProperty(type)) return { ok: false, message: 'Type d\'activité manquant ou invalide.' };
  var prefixe = TYPES[type];

  var cache = CacheService.getScriptCache();
  var cleCache = 'CRENEAUX_' + type;
  var cached = cache.get(cleCache);
  if (cached) return { ok: true, creneaux: JSON.parse(cached) };

  var it = DriveApp.getFolderById(CONFIG.DEST_FOLDER_ID_ANIMATEURS).getFiles();
  var tout = [];
  while (it.hasNext()) {
    var file = it.next();
    if (file.getMimeType() !== MimeType.GOOGLE_SHEETS) continue;
    var nomAnimateur = file.getName();
    SpreadsheetApp.open(file).getSheets().forEach(function(sheet) {
      // Filtre sur le nom d'onglet AVANT toute lecture de cellule.
      if (sheet.getName().indexOf(prefixe) !== 0) return;
      tout.push(decrireOnglet_(nomAnimateur, sheet));
    });
  }
  tout.sort(function(a, b) { return a.activite.localeCompare(b.activite); });

  try { cache.put(cleCache, JSON.stringify(tout), 1800); } catch (e) { /* cache plein, on continue sans */ }
  return { ok: true, creneaux: tout };
}

function actionListerDatesConsult_(req) {
  var o = ouvrirOnglet_(req.animateurFichier, req.code);
  if (o.erreur) return { ok: false, message: o.erreur };
  return lireDates_(o.sheet);
}

// Lecture seule, sans téléphone ni ligne : juste l'état des présences.
function actionListerPresencesConsult_(req) {
  var colonne = colonneValide_(req.colonne);
  if (!colonne) return { ok: false, message: 'Date invalide.' };
  var o = ouvrirOnglet_(req.animateurFichier, req.code);
  if (o.erreur) return { ok: false, message: o.erreur };
  var membres = lireMembres_(o.sheet, colonne, false).map(function(m) {
    return { nom: m.nom, prenom: m.prenom, present: m.present };
  });
  return { ok: true, membres: membres };
}

// ============================================================
// ADMINISTRATION — à exécuter depuis l'éditeur Apps Script
// (sélectionner la fonction dans le menu déroulant puis ▶️ Exécuter).
// ⚠️ N'écrire AUCUN code PIN dans ce fichier.
// ============================================================

// À exécuter UNE fois après la mise à jour si des PIN avaient été créés
// avec l'ancienne version (propriété "PINS" en clair) : les convertit en
// empreintes et supprime la liste en clair. Les animateurs gardent leur code.
function migrerPinsExistants() {
  var raw = props_().getProperty('PINS');
  if (!raw) {
    Logger.log('Rien à migrer (aucune liste de PIN en clair trouvée).');
    return;
  }
  var anciens = JSON.parse(raw);
  var pins = getPinsHash_();
  Object.keys(anciens).forEach(function(nom) {
    pins[nom] = hacherPin_(verifierFormatPin_(anciens[nom], nom));
  });
  setPinsHash_(pins);
  props_().deleteProperty('PINS');
  Logger.log('✅ ' + Object.keys(anciens).length + ' PIN migrés : ' + Object.keys(anciens).join(', '));
  Logger.log('⚠️ Ces codes figuraient en clair dans l\'ancien code source : il est conseillé de les renouveler avec genererPins().');
}

// Crée (ou renouvelle) un PIN aléatoire pour chaque nom de la liste.
// Les noms doivent correspondre EXACTEMENT aux noms de classeurs du dossier
// Drive "11-Classeurs adhérents par animateur" (majuscules/accents inclus).
// Les codes générés s'affichent UNE seule fois dans le journal d'exécution :
// les transmettre aux animateurs, puis vider la liste ci-dessous si besoin.
function genererPins() {
  var noms = [
    // "B. CARRERE",
    // "C. MAURICE/X. TRUSSART",
  ];
  if (noms.length === 0) {
    Logger.log('Ajoute au moins un nom dans la liste de genererPins() (uniquement les noms, jamais les codes).');
    return;
  }

  var pins = getPinsHash_();
  var hashConsultation = props_().getProperty('CONSULTATION_HASH');
  var classeurs = listerNomsClasseurs_();
  var lignes = [];

  noms.forEach(function(nom) {
    var pin, hash;
    do {
      pin = pinAleatoire_();
      hash = hacherPin_(pin);
    } while (hashDejaUtilise_(pins, hash, nom) || hash === hashConsultation);
    pins[nom] = hash;
    var avertissement = classeurs.some(function(c) { return autoriseAcces_(nom, c); }) ? '' : '   ⚠️ aucun classeur ne correspond à ce nom';
    lignes.push(nom + ' → ' + pin + avertissement);
  });

  setPinsHash_(pins);
  Logger.log('Nouveaux codes (à transmettre, ils ne seront plus affichables) :\n' + lignes.join('\n'));
}

// Définit un code précis pour un animateur (usage depuis un autre script,
// sans jamais écrire le code en dur ici).
function definirPin(nomAnimateur, pin) {
  if (!nomAnimateur || pin === undefined) {
    throw new Error('definirPin ne se lance pas directement depuis le menu : ajouter temporairement ' +
      'function tmp() { definirPin("NOM EXACT DU CLASSEUR", "123456"); } puis exécuter tmp et la supprimer. ' +
      'Pour un code tiré au hasard, utiliser plutôt genererPins().');
  }
  pin = verifierFormatPin_(pin, nomAnimateur);
  var pins = getPinsHash_();
  var hash = hacherPin_(pin);
  if (hashDejaUtilise_(pins, hash, nomAnimateur) || hash === props_().getProperty('CONSULTATION_HASH')) {
    throw new Error('Ce code est déjà utilisé par quelqu\'un d\'autre.');
  }
  pins[nomAnimateur] = hash;
  setPinsHash_(pins);
  Logger.log('PIN défini pour ' + nomAnimateur);
}

function supprimerPin(nomAnimateur) {
  var pins = getPinsHash_();
  delete pins[nomAnimateur];
  setPinsHash_(pins);
}

// Utilitaire pour voir qui a déjà un PIN attribué (les codes eux-mêmes ne sont pas lisibles).
function listerAnimateursAvecPin() {
  Logger.log(Object.keys(getPinsHash_()).join('\n') || '(aucun)');
}

// Code partagé donnant accès à la consultation en lecture seule
// (présences de tous les créneaux, sans téléphone, sans écriture).
// Relancer pour en changer : l'ancien code et ses sessions ne marchent plus.
function genererCodeConsultation() {
  var pins = getPinsHash_();
  var pin, hash;
  do {
    pin = pinAleatoire_();
    hash = hacherPin_(pin);
  } while (hashDejaUtilise_(pins, hash, null));
  props_().setProperty('CONSULTATION_HASH', hash);
  Logger.log('Code de consultation (lecture seule) : ' + pin);
}

function supprimerCodeConsultation() {
  props_().deleteProperty('CONSULTATION_HASH');
  Logger.log('Consultation désactivée.');
}

// Invalide toutes les sessions ouvertes : chacun devra retaper son code.
function deconnecterToutLeMonde() {
  props_().deleteProperty('SECRET_JETON');
  Logger.log('Toutes les sessions sont invalidées.');
}

// À exécuter manuellement si un créneau vient de changer (nouvel
// animateur, titre modifié) et que tu ne veux pas attendre 30 min
// que le cache expire tout seul. Vide le cache de TOUS les types.
function viderCacheCreneaux() {
  var cache = CacheService.getScriptCache();
  Object.keys(TYPES).forEach(function(type) { cache.remove('CRENEAUX_' + type); });
  Logger.log('Cache vidé pour tous les types.');
}

function debloquerConnexions() {
  CacheService.getScriptCache().remove('ECHECS_PIN');
  Logger.log('Compteur de codes erronés remis à zéro.');
}

function pinAleatoire_() {
  var octets = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid());
  var n = 0;
  for (var i = 0; i < 6; i++) n = (n * 256 + (octets[i] & 0xff)) % 1000000;
  return ('00000' + n).slice(-6);
}

function hashDejaUtilise_(pins, hash, saufNom) {
  return Object.keys(pins).some(function(nom) { return nom !== saufNom && pins[nom] === hash; });
}

function listerNomsClasseurs_() {
  var it = DriveApp.getFolderById(CONFIG.DEST_FOLDER_ID_ANIMATEURS).getFiles();
  var noms = [];
  while (it.hasNext()) {
    var f = it.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS) noms.push(f.getName());
  }
  return noms;
}
