// Interface de l'application d'appel (écrans, navigation).
// Les textes venant des classeurs sont toujours insérés avec textContent
// (jamais innerHTML) pour qu'un nom ne puisse pas injecter de code.
(function() {
  var etat = { creneau: null, date: null };
  var etatConsult = { type: null, tousCreneaux: [], creneau: null };

  var $ = function(id) { return document.getElementById(id); };

  function el(tag, className, texte) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (texte !== undefined) e.textContent = texte;
    return e;
  }

  function vider(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function chargement(node) {
    vider(node);
    node.appendChild(el('div', 'carte chargement', 'Chargement...'));
  }

  // ── Bannières ──
  function afficherErreur(msg) {
    var b = $('banniere-erreur');
    b.textContent = msg;
    b.classList.add('visible');
    console.error(msg);
  }

  function effacerErreur() { $('banniere-erreur').classList.remove('visible'); }

  function majEtatReseau(depuisCache) {
    var enAttente = Api.file().length;
    var textes = [];
    if (!navigator.onLine) textes.push('📴 Hors connexion.');
    else if (depuisCache) textes.push('📴 Serveur injoignable : affichage des dernières données chargées.');
    if (enAttente) textes.push('⏳ ' + enAttente + ' appel(s) en attente d\'envoi.');
    var b = $('banniere-hors-ligne');
    b.textContent = textes.join(' ');
    b.classList.toggle('visible', textes.length > 0);

    var lien = $('lien-envoyer-file');
    lien.textContent = '↻ Renvoyer les appels en attente (' + enAttente + ')';
    lien.style.display = enAttente ? 'inline-block' : 'none';
  }

  // ── Navigation ──
  // Pour chaque écran : ce que fait le lien retour du haut de page.
  // Écran absent de cette liste = pas de lien retour.
  var RETOURS = {
    'ecran-consult-types': function() {
      var s = Api.session();
      return s && s.role === 'animateur' ? { texte: '‹ Retour à mes créneaux', action: chargerCreneaux } : null;
    },
    'ecran-consult-liste': function() { return { texte: '‹ Changer de type d\'activité', action: ouvrirConsultation }; },
    'ecran-consult-dates': function() { return { texte: '‹ Retour à la recherche', action: retourListeConsult }; },
    'ecran-consult-presences': function() { return { texte: '‹ Changer de date', action: function() { afficherEcran('ecran-consult-dates'); } }; },
    'ecran-dates': function() { return { texte: '‹ Retour aux créneaux', action: chargerCreneaux }; },
    'ecran-appel': function() { return { texte: '‹ Changer de date', action: function() { choisirCreneau(etat.creneau); } }; }
  };

  function afficherEcran(id) {
    document.querySelectorAll('.ecran').forEach(function(e) { e.classList.remove('actif'); });
    $(id).classList.add('actif');
    effacerErreur();

    var lienHaut = $('lien-retour-haut');
    var config = RETOURS[id] && RETOURS[id]();
    if (config) {
      lienHaut.textContent = config.texte;
      lienHaut.onclick = config.action;
      lienHaut.style.display = 'inline-block';
    } else {
      lienHaut.style.display = 'none';
    }
    $('lien-deconnexion').style.display = Api.session() ? 'inline-block' : 'none';
    window.scrollTo(0, 0);
  }

  // Exécute une requête et gère les erreurs communes.
  async function requete(promesse, surSucces) {
    try {
      var res = await promesse;
      majEtatReseau(res.depuisCache);
      if (!res.ok) { afficherErreur(res.message); return; }
      surSucces(res);
    } catch (e) {
      majEtatReseau();
      if (e.sessionExpiree) {
        afficherEcran('ecran-pin');
        $('erreur-pin').textContent = e.message;
      } else if (e.horsLigne) {
        afficherErreur('Pas de réseau, et cet écran n\'a encore jamais été chargé sur ce téléphone.');
      } else {
        afficherErreur('Erreur : ' + e.message);
      }
    }
  }

  function ligneDate(d, aujourdhui, surClic) {
    var div = el('div', 'date-item');
    if (d.texte === aujourdhui) div.appendChild(document.createTextNode('⭐ '));
    div.appendChild(el('b', '', d.texte));
    div.onclick = surClic;
    return div;
  }

  function ligneCreneau(c, avecAnimateur, surClic) {
    var div = el('div', 'creneau-item');
    div.appendChild(el('b', '', c.activite));
    div.appendChild(el('br'));
    div.appendChild(document.createTextNode(c.jour + ' ' + c.heure + (avecAnimateur ? ' — ' + c.animateurFichier : '')));
    div.onclick = surClic;
    return div;
  }

  // ── Écran 1 : connexion ──
  async function connecter() {
    var pin = $('input-pin').value.trim();
    $('erreur-pin').textContent = '';
    if (!/^\d{6}$/.test(pin)) {
      $('erreur-pin').textContent = 'Le code doit contenir 6 chiffres.';
      return;
    }
    $('btn-connecter').disabled = true;
    try {
      var res = await Api.connecter(pin);
      if (!res.ok) { $('erreur-pin').textContent = res.message; return; }
      $('input-pin').value = '';
      demarrerSession();
      envoyerFileEnFond();
    } catch (e) {
      $('erreur-pin').textContent = e.horsLigne ? 'Pas de réseau : la connexion nécessite Internet.' : 'Erreur : ' + e.message;
    } finally {
      $('btn-connecter').disabled = false;
    }
  }

  function demarrerSession() {
    var s = Api.session();
    if (!s) afficherEcran('ecran-pin');
    else if (s.role === 'consultation') ouvrirConsultation();
    else chargerCreneaux();
  }

  function deconnecter() {
    var enAttente = Api.file().length;
    if (enAttente && !confirm(enAttente + ' appel(s) pas encore envoyé(s). Ils resteront sur ce téléphone et partiront à la prochaine connexion. Se déconnecter quand même ?')) return;
    Api.fermerSession();
    afficherEcran('ecran-pin');
  }

  // ── Écran 2 : créneaux ──
  function chargerCreneaux() {
    var liste = $('liste-creneaux');
    chargement(liste);
    afficherEcran('ecran-creneaux');
    $('bonjour-animateur').textContent = 'Bonjour ' + Api.session().animateur;
    requete(Api.lireAvecCache('listerCreneaux'), function(res) {
      vider(liste);
      res.creneaux.forEach(function(c) {
        liste.appendChild(ligneCreneau(c, false, function() { choisirCreneau(c); }));
      });
    });
  }

  // ── Écran 3 : dates ──
  function choisirCreneau(c) {
    etat.creneau = c;
    $('titre-creneau-dates').textContent = c.activite + ' — ' + c.jour + ' ' + c.heure;
    var liste = $('liste-dates');
    chargement(liste);
    afficherEcran('ecran-dates');
    requete(Api.lireAvecCache('listerDates', { animateurFichier: c.animateurFichier, code: c.code }), function(res) {
      vider(liste);
      if (res.dates.length === 0) liste.appendChild(el('div', 'carte', 'Aucune date dans ce créneau.'));
      res.dates.forEach(function(d) {
        liste.appendChild(ligneDate(d, res.aujourdhui, function() { choisirDate(d); }));
      });
      // Faire défiler jusqu'à la date du jour.
      var etoile = Array.prototype.find.call(liste.children, function(n) { return n.textContent.indexOf('⭐') === 0; });
      if (etoile && etoile.scrollIntoView) etoile.scrollIntoView({ block: 'center' });
    });
  }

  // ── Écran 4 : appel ──
  function paramsMembres() {
    return { animateurFichier: etat.creneau.animateurFichier, code: etat.creneau.code, colonne: etat.date.colonne };
  }

  function majToggle(row, valeur) {
    row.dataset.valeur = valeur;
    row.querySelector('.btn-present').classList.toggle('on-present', valeur === 1);
    row.querySelector('.btn-absent').classList.toggle('on-absent', valeur === 0);
  }

  function creerLigneMembre(m, present) {
    var row = el('div', 'membre-row');
    row.dataset.ligne = m.ligne;
    row.dataset.nom = m.nom || '';
    row.dataset.prenom = m.prenom || '';

    var nom = el('span', 'membre-nom', m.prenom + ' ' + m.nom);
    if (m.telephone) {
      var tel = el('a', 'telephone', '📞 ' + m.telephone);
      tel.href = 'tel:' + String(m.telephone).replace(/[^\d+]/g, '');
      nom.appendChild(tel);
    }

    var toggle = el('span', 'toggle');
    var btnP = el('button', 'btn-present', 'Présent');
    var btnA = el('button', 'btn-absent', 'Absent');
    btnP.type = btnA.type = 'button';
    btnP.onclick = function() { majToggle(row, 1); };
    btnA.onclick = function() { majToggle(row, 0); };
    toggle.appendChild(btnP);
    toggle.appendChild(btnA);

    row.appendChild(nom);
    row.appendChild(toggle);
    majToggle(row, present);
    return row;
  }

  function choisirDate(d) {
    etat.date = d;
    $('titre-creneau-appel').textContent = etat.creneau.activite + ' — ' + d.texte;
    fermerFormulaireAjout();
    var liste = $('liste-membres');
    chargement(liste);
    afficherEcran('ecran-appel');
    requete(Api.lireAvecCache('listerMembres', paramsMembres()), function(res) {
      vider(liste);
      if (res.membres.length === 0) liste.appendChild(el('div', 'carte', 'Aucun adhérent dans ce créneau.'));
      res.membres.forEach(function(m) {
        liste.appendChild(creerLigneMembre(m, m.present === null ? 1 : m.present)); // par défaut présent
      });
    });
  }

  // ── Ajout manuel d'un membre (nécessite le réseau) ──
  function ouvrirFormulaireAjout() {
    effacerErreur();
    $('form-ajout-membre').style.display = 'block';
    ['ajout-nom', 'ajout-prenom', 'ajout-telephone', 'ajout-email'].forEach(function(id) { $(id).value = ''; });
    $('ajout-nom').focus();
  }

  function fermerFormulaireAjout() { $('form-ajout-membre').style.display = 'none'; }

  async function confirmerAjoutMembre() {
    var m = {
      nom: $('ajout-nom').value.trim(),
      prenom: $('ajout-prenom').value.trim(),
      telephone: $('ajout-telephone').value.trim(),
      email: $('ajout-email').value.trim()
    };
    if (!m.nom && !m.prenom) { afficherErreur('Renseigne au moins un nom ou un prénom.'); return; }

    var btn = $('btn-confirmer-ajout');
    btn.disabled = true;
    try {
      var res = await Api.appeler('ajouterMembre', Object.assign({ animateurFichier: etat.creneau.animateurFichier, code: etat.creneau.code }, m));
      if (!res.ok) { afficherErreur(res.message); return; }
      m.ligne = res.ligne;
      $('liste-membres').appendChild(creerLigneMembre(m, 1)); // présent par défaut
      Api.modifierCache('listerMembres', paramsMembres(), function(cache) {
        cache.membres.push({ ligne: m.ligne, nom: m.nom, prenom: m.prenom, telephone: m.telephone, present: null });
      });
      fermerFormulaireAjout();
    } catch (e) {
      if (e.sessionExpiree) { afficherEcran('ecran-pin'); $('erreur-pin').textContent = e.message; return; }
      afficherErreur(e.horsLigne ? 'Pas de réseau : l\'ajout d\'un membre nécessite une connexion. Tu peux faire l\'appel des autres et ajouter ce membre plus tard.' : 'Erreur : ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ── Validation : l'appel est rangé sur le téléphone puis envoyé ──
  async function validerAppel() {
    var presences = [];
    document.querySelectorAll('#liste-membres .membre-row').forEach(function(row) {
      presences.push({
        ligne: parseInt(row.dataset.ligne, 10),
        valeur: parseInt(row.dataset.valeur, 10),
        nom: row.dataset.nom,
        prenom: row.dataset.prenom
      });
    });
    if (presences.length === 0) { afficherErreur('Aucun adhérent à enregistrer.'); return; }

    var params = Object.assign(paramsMembres(), { date: etat.date.texte, presences: presences });
    var id = Api.mettreEnFile({ params: params, libelle: etat.creneau.activite + ' du ' + etat.date.texte });

    // Garde localement l'appel pour le retrouver tel quel, même hors connexion.
    Api.modifierCache('listerMembres', paramsMembres(), function(cache) {
      var parLigne = {};
      presences.forEach(function(p) { parLigne[p.ligne] = p.valeur; });
      cache.membres.forEach(function(m) { if (parLigne.hasOwnProperty(m.ligne)) m.present = parLigne[m.ligne]; });
    });

    $('btn-valider').disabled = true;
    var bilan;
    try {
      bilan = await Api.envoyerFile();
    } finally {
      $('btn-valider').disabled = false;
    }
    majEtatReseau();

    var envoye = bilan.envoyes.filter(function(x) { return x.appel.id === id; })[0];
    var erreur = bilan.erreurs.filter(function(x) { return x.appel.id === id; })[0];
    signalerAutresResultats(bilan, id);

    if (erreur && !erreur.garde) { afficherErreur(erreur.res.message); return; }

    var texte;
    if (envoye) {
      $('coche-confirmation').textContent = '✅';
      texte = 'Appel enregistré pour ' + envoye.res.nombre + ' adhérent(s).';
      if (envoye.res.nonTrouves) texte += '\n⚠️ Introuvable(s) dans le classeur, non enregistré(s) : ' + envoye.res.nonTrouves.join(', ') + '.';
    } else {
      $('coche-confirmation').textContent = '⏳';
      texte = 'Pas de connexion au serveur : l\'appel est gardé sur ce téléphone et sera envoyé automatiquement dès le retour du réseau.';
    }
    $('texte-confirmation').textContent = texte;
    $('texte-confirmation').style.whiteSpace = 'pre-line';
    afficherEcran('ecran-confirmation');
  }

  // Résultats des appels en attente envoyés en même temps (ou en arrière-plan).
  function signalerAutresResultats(bilan, saufId) {
    var messages = [];
    bilan.envoyes.forEach(function(x) {
      if (x.appel.id !== saufId) messages.push('Appel en attente envoyé : ' + x.appel.libelle + '.');
    });
    bilan.erreurs.forEach(function(x) {
      if (x.appel.id !== saufId) messages.push('Appel « ' + x.appel.libelle + ' » ' + (x.garde ? 'toujours en attente' : 'refusé') + ' : ' + x.res.message);
    });
    if (bilan.erreurs.some(function(x) { return x.appel.id !== saufId; })) afficherErreur(messages.join('\n'));
    else if (messages.length) console.info(messages.join('\n'));
  }

  function envoyerFileEnFond() {
    if (!Api.file().length) { majEtatReseau(); return; }
    Api.envoyerFile().then(function(bilan) {
      majEtatReseau();
      signalerAutresResultats(bilan, null);
    });
  }

  // ── MODE CONSULTATION (lecture seule) ──
  function ouvrirConsultation() {
    var liste = $('consult-liste-types');
    chargement(liste);
    afficherEcran('ecran-consult-types');
    requete(Api.lireAvecCache('listerTypesActivite'), function(res) {
      vider(liste);
      res.types.forEach(function(type) {
        var div = el('div', 'creneau-item');
        div.appendChild(el('b', '', type));
        div.onclick = function() { choisirType(type); };
        liste.appendChild(div);
      });
    });
  }

  function choisirType(type) {
    etatConsult.type = type;
    etatConsult.tousCreneaux = [];
    $('consult-titre-type').textContent = type;
    $('consult-recherche').value = '';
    chargement($('consult-liste-creneaux'));
    afficherEcran('ecran-consult-liste');
    requete(Api.lireAvecCache('listerTousLesCreneaux', { type: type }), function(res) {
      etatConsult.tousCreneaux = res.creneaux;
      afficherListeConsult(res.creneaux);
    });
  }

  function retourListeConsult() {
    afficherEcran('ecran-consult-liste');
    filtrerConsult();
  }

  function afficherListeConsult(creneaux) {
    var liste = $('consult-liste-creneaux');
    vider(liste);
    if (creneaux.length === 0) {
      liste.appendChild(el('div', 'carte', 'Aucun créneau trouvé.'));
      return;
    }
    creneaux.forEach(function(c) {
      liste.appendChild(ligneCreneau(c, true, function() { choisirCreneauConsult(c); }));
    });
  }

  function filtrerConsult() {
    var q = $('consult-recherche').value.trim().toLowerCase();
    afficherListeConsult(etatConsult.tousCreneaux.filter(function(c) {
      return (c.activite + ' ' + c.jour + ' ' + c.heure + ' ' + c.animateurFichier).toLowerCase().indexOf(q) !== -1;
    }));
  }

  function choisirCreneauConsult(c) {
    etatConsult.creneau = c;
    $('consult-titre-dates').textContent = c.activite + ' — ' + c.jour + ' ' + c.heure;
    var liste = $('consult-liste-dates');
    chargement(liste);
    afficherEcran('ecran-consult-dates');
    requete(Api.lireAvecCache('listerDatesConsult', { animateurFichier: c.animateurFichier, code: c.code }), function(res) {
      vider(liste);
      if (res.dates.length === 0) liste.appendChild(el('div', 'carte', 'Aucune date dans ce créneau.'));
      res.dates.forEach(function(d) {
        liste.appendChild(ligneDate(d, res.aujourdhui, function() { choisirDateConsult(d); }));
      });
    });
  }

  function choisirDateConsult(d) {
    var c = etatConsult.creneau;
    $('consult-titre-presences').textContent = c.activite + ' — ' + d.texte;
    var liste = $('consult-liste-presences');
    chargement(liste);
    afficherEcran('ecran-consult-presences');
    requete(Api.lireAvecCache('listerPresencesConsult', { animateurFichier: c.animateurFichier, code: c.code, colonne: d.colonne }), function(res) {
      vider(liste);
      if (res.membres.length === 0) liste.appendChild(el('div', 'carte', 'Aucun adhérent dans ce créneau.'));
      res.membres.forEach(function(m) {
        var texte = m.present === 1 ? 'Présent' : m.present === 0 ? 'Absent' : 'Non renseigné';
        var classe = m.present === 1 ? 'present' : m.present === 0 ? 'absent' : 'inconnu';
        var row = el('div', 'membre-row');
        row.appendChild(el('span', 'membre-nom', m.prenom + ' ' + m.nom));
        row.appendChild(el('span', 'badge-lecture ' + classe, texte));
        liste.appendChild(row);
      });
    });
  }

  // ── Branchements ──
  $('btn-connecter').onclick = connecter;
  $('input-pin').addEventListener('keyup', function(e) { if (e.key === 'Enter') connecter(); });
  $('btn-consulter').onclick = ouvrirConsultation;
  $('btn-ouvrir-ajout').onclick = ouvrirFormulaireAjout;
  $('btn-confirmer-ajout').onclick = confirmerAjoutMembre;
  $('btn-annuler-ajout').onclick = fermerFormulaireAjout;
  $('btn-valider').onclick = validerAppel;
  $('btn-autre-appel').onclick = chargerCreneaux;
  $('consult-recherche').addEventListener('input', filtrerConsult);
  $('lien-deconnexion').onclick = deconnecter;
  $('lien-envoyer-file').onclick = envoyerFileEnFond;

  // Envoi automatique des appels en attente dès que possible.
  window.addEventListener('online', envoyerFileEnFond);
  window.addEventListener('offline', function() { majEtatReseau(); });
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') envoyerFileEnFond();
  });
  setInterval(function() { if (Api.file().length && navigator.onLine) envoyerFileEnFond(); }, 60000);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(function(e) { console.warn('Service worker non installé', e); });
    });
  }

  if (!(window.APPEL_CONFIG || {}).API_URL) {
    afficherEcran('ecran-pin');
    afficherErreur('Application non configurée : renseigner l\'adresse du script Apps Script dans js/config.js.');
  } else {
    demarrerSession();
    envoyerFileEnFond();
  }
})();
