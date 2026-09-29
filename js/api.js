// Communication avec le script Apps Script (serveur/Code.gs),
// session, cache hors connexion et file d'attente des appels.
var Api = (function() {
  var CLE_SESSION = 'fri-appel-session';
  var CLE_FILE = 'fri-appel-file';
  var PREFIXE_CACHE = 'fri-appel-cache:';
  var DELAI_MS = 45000;

  // localStorage peut être indisponible (navigation privée) : on ne plante jamais.
  function lire(cle) {
    try { return JSON.parse(localStorage.getItem(cle)); } catch (e) { return null; }
  }
  function ecrire(cle, valeur) {
    try { localStorage.setItem(cle, JSON.stringify(valeur)); } catch (e) { /* stockage plein ou bloqué */ }
  }
  function supprimer(cle) {
    try { localStorage.removeItem(cle); } catch (e) { /* ignore */ }
  }

  // ── Session : jeton signé renvoyé par le serveur (le code n'est jamais stocké) ──
  function session() { return lire(CLE_SESSION); }

  function fermerSession() {
    supprimer(CLE_SESSION);
    try {
      Object.keys(localStorage)
        .filter(function(k) { return k.indexOf(PREFIXE_CACHE) === 0; })
        .forEach(function(k) { localStorage.removeItem(k); });
    } catch (e) { /* ignore */ }
  }

  // Le téléphone a du réseau mais le script ne répond pas correctement :
  // le plus souvent un déploiement Apps Script avec l'ancien code, ou dont
  // l'accès n'est pas « Tout le monde » (Google renvoie alors une page que
  // le navigateur bloque). On le signale clairement au lieu de « pas de réseau ».
  var MESSAGE_SERVEUR = 'Le serveur Apps Script ne répond pas correctement. Vérifier le déploiement : ' +
    'nouvelle version de Code.gs déployée, et accès « Tout le monde ».';

  function erreurHorsLigne() {
    var enLigne = navigator.onLine !== false;
    var err = new Error(enLigne ? MESSAGE_SERVEUR : 'Pas de connexion au serveur.');
    err.horsLigne = true; // l'appel reste en file d'attente dans les deux cas
    err.serveur = enLigne;
    return err;
  }

  // Requête POST en texte brut : pas de requête CORS préalable,
  // ce qu'Apps Script ne sait pas gérer.
  async function appeler(action, params, jeton) {
    var url = (window.APPEL_CONFIG || {}).API_URL;
    if (!url) throw new Error('Adresse du serveur non configurée (js/config.js).');
    var s = session();
    var corps = Object.assign({ action: action, jeton: jeton || (s && s.jeton) }, params || {});

    var ctrl = new AbortController();
    var minuterie = setTimeout(function() { ctrl.abort(); }, DELAI_MS);
    var reponse;
    try {
      reponse = await fetch(url, { method: 'POST', body: JSON.stringify(corps), redirect: 'follow', signal: ctrl.signal });
    } catch (e) {
      throw erreurHorsLigne();
    } finally {
      clearTimeout(minuterie);
    }
    if (!reponse.ok) throw erreurHorsLigne();

    var data;
    try {
      data = await reponse.json();
    } catch (e) {
      throw new Error(MESSAGE_SERVEUR);
    }
    if (data.sessionExpiree) {
      if (!jeton) fermerSession(); // seulement si c'est la session en cours qui a expiré
      var err = new Error(data.message);
      err.sessionExpiree = true;
      throw err;
    }
    return data;
  }

  async function connecter(pin) {
    var res = await appeler('connecter', { pin: pin });
    if (res.ok) {
      fermerSession();
      ecrire(CLE_SESSION, { jeton: res.jeton, animateur: res.animateur, role: res.role });
    }
    return res;
  }

  // Lecture : la dernière réponse est gardée sur le téléphone
  // pour pouvoir faire l'appel même sans réseau.
  async function lireAvecCache(action, params) {
    var cle = PREFIXE_CACHE + action + ':' + JSON.stringify(params || {});
    try {
      var res = await appeler(action, params);
      if (res.ok) ecrire(cle, res);
      return res;
    } catch (e) {
      var cache = e.horsLigne ? lire(cle) : null;
      if (!cache) throw e;
      cache.depuisCache = true;
      return cache;
    }
  }

  // Met à jour une réponse gardée en cache (ex. après un appel fait hors connexion).
  function modifierCache(action, params, modifier) {
    var cle = PREFIXE_CACHE + action + ':' + JSON.stringify(params || {});
    var cache = lire(cle);
    if (cache) { modifier(cache); ecrire(cle, cache); }
  }

  // ── File d'attente des appels ──
  // Un appel validé est d'abord rangé sur le téléphone puis envoyé :
  // rien n'est perdu si le réseau coupe.
  function file() { return lire(CLE_FILE) || []; }

  // Chaque appel garde le jeton de l'animateur qui l'a fait : il sera
  // envoyé en son nom même si quelqu'un d'autre se connecte entre-temps.
  function mettreEnFile(appel) {
    var s = session();
    var f = file();
    appel.id = Date.now() + '-' + Math.random().toString(36).slice(2);
    appel.jeton = s && s.jeton;
    appel.animateur = s && s.animateur;
    f.push(appel);
    ecrire(CLE_FILE, f);
    return appel.id;
  }

  function retirerDeFile(id) {
    ecrire(CLE_FILE, file().filter(function(a) { return a.id !== id; }));
  }

  var envoiEnCours = null;

  // Renvoie { envoyes: [...], erreurs: [...], restants: n }.
  function envoyerFile() {
    if (envoiEnCours) return envoiEnCours;
    envoiEnCours = (async function() {
      var bilan = { envoyes: [], erreurs: [], restants: 0 };
      var aTraiter = file();
      for (var i = 0; i < aTraiter.length; i++) {
        var appel = aTraiter[i];
        var s = session();
        // Jeton expiré mais le même animateur est reconnecté : on prend son nouveau jeton.
        var jetons = [appel.jeton];
        if (s && s.animateur === appel.animateur && s.jeton !== appel.jeton) jetons.push(s.jeton);
        try {
          var res = null;
          for (var j = 0; j < jetons.length && !res; j++) {
            try {
              res = await appeler('enregistrerAppel', appel.params, jetons[j]);
            } catch (e) {
              if (!e.sessionExpiree || j === jetons.length - 1) throw e;
            }
          }
          bilan[res.ok ? 'envoyes' : 'erreurs'].push({ appel: appel, res: res });
          retirerDeFile(appel.id); // traité : succès ou refus définitif du serveur
        } catch (e) {
          if (e.horsLigne) break; // on réessaiera plus tard
          // Session expirée ou réponse illisible : l'appel reste en attente
          // (il sera renvoyé à la prochaine tentative ou reconnexion).
          if (!e.sessionExpiree) bilan.erreurs.push({ appel: appel, res: { ok: false, message: e.message }, garde: true });
        }
      }
      bilan.restants = file().length;
      return bilan;
    })();
    envoiEnCours.finally(function() { envoiEnCours = null; });
    return envoiEnCours;
  }

  return {
    session: session,
    fermerSession: fermerSession,
    connecter: connecter,
    appeler: appeler,
    lireAvecCache: lireAvecCache,
    modifierCache: modifierCache,
    file: file,
    mettreEnFile: mettreEnFile,
    envoyerFile: envoyerFile
  };
})();
