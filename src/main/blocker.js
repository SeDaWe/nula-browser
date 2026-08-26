'use strict';

/*
 * Netzwerk-Blocker fuer Werbung und Tracking.
 *
 * Bewusst keine EasyList-Engine: Regellisten muessten bei jedem Start
 * nachgeladen werden, und genau dieser Request waere die erste Spur, die Nula
 * hinterlaesst. Stattdessen eine gepflegte Liste von Hosts, gematcht auf der
 * registrierbaren Domain, plus eine kleine Zahl sehr eng gefasster Pfadmuster.
 *
 * Die Liste ist in drei Gruppen geteilt, weil der Popup-Waechter sie anders
 * gewichtet als der Request-Filter:
 *
 *   POPUP_HOSTS   Pop-under- und Interstitial-Netze. Ein Klick auf so einen
 *                 Host ist nie gewollt, deshalb werden sie auch als Ziel einer
 *                 Navigation im Hauptframe gestoppt, nicht nur als Subrequest.
 *   AD_HOSTS      Anzeigenauslieferung und Auktionen. Ebenfalls nie ein Ziel,
 *                 das jemand von Hand ansteuert.
 *   TRACKER_HOSTS Analyse und Messung. Nur als Subrequest relevant.
 */

// Pop-under-, Popup- und Interstitial-Netze. Diese Hosts sind die Ursache fuer
// das klassische "jeder Klick oeffnet erst einen Werbe-Tab".
const POPUP_HOSTS = [
  'popads.net',
  'popcash.net',
  'popmyads.com',
  'popunder.net',
  'poptm.com',
  'popupads.net',
  'propellerads.com',
  'propellerclick.com',
  'propu.sh',
  'monetag.com',
  'adsterra.com',
  'adsterratech.com',
  'hilltopads.net',
  'hilltopads.com',
  'clickadu.com',
  'clickaine.com',
  'adcash.com',
  'adcdnx.com',
  'exoclick.com',
  'exosrv.com',
  'exdynsrv.com',
  'realsrv.com',
  'juicyads.com',
  'juicyads.rocks',
  'trafficjunky.net',
  'trafficjunky.com',
  'trafficforce.com',
  'zeropark.com',
  'onclickalgo.com',
  'onclickmega.com',
  'onclicksuper.com',
  'onclickpredictiv.com',
  'ad-maven.com',
  'admaven.com',
  'clksite.com',
  'clkmon.com',
  'adservme.com',
  'adnium.com',
  'adspyglass.com',
  'pub2srv.com',
  'galaksion.com',
  'adskeeper.com',
  'adskeeper.co.uk',
  'bidvertiser.com',
  'popunderjs.com',
  'push-vibes.com',
  'pushwhy.com',
  'pushnest.com',
  'notix.io',
  'linkvertise.com',
  'shorte.st',
  'adf.ly',
  'ouo.io',
  'adfoc.us',
  'exe.io',
];

// Anzeigenauslieferung, Auktionen und Identitaetsabgleich.
const AD_HOSTS = [
  'googlesyndication.com',
  'googleadservices.com',
  'doubleclick.net',
  'amazon-adsystem.com',
  'adnxs.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'casalemedia.com',
  'sharethrough.com',
  'smartadserver.com',
  'teads.tv',
  'moatads.com',
  'adsrvr.org',
  'bidswitch.net',
  'everesttech.net',
  'demdex.net',
  'omtrdc.net',
  '2o7.net',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'mgid.com',
  'dt07.net',
  'revcontent.com',
  'adform.net',
  '3lift.com',
  'yieldmo.com',
  'indexww.com',
  'districtm.io',
  'sovrn.com',
  'lijit.com',
  'gumgum.com',
  'media.net',
  'servedbyadbutler.com',
  'adroll.com',
  'rlcdn.com',
  'crwdcntrl.net',
  'agkn.com',
  'bluekai.com',
  'eyeota.net',
  'exelator.com',
  'mathtag.com',
  'simpli.fi',
  'adsymptotic.com',
  'tapad.com',
  'id5-sync.com',
  'adlooxtracking.com',
  'doubleverify.com',
  'adsafeprotected.com',
  'zedo.com',
  'revjet.com',
  'adzerk.net',
  'adition.com',
  'yieldlab.net',
  'emetriq.de',
  'theadex.com',
  'plista.com',
  'vidoomy.com',
  'aniview.com',
  'smaato.net',
  'inmobi.com',
  'applovin.com',
  'unityads.unity3d.com',
  'flashtalking.com',
  'serving-sys.com',
  'contextweb.com',
  'gammaplatform.com',
  'sonobi.com',
  'spotxchange.com',
  'spotx.tv',
  'freewheel.tv',
  'stickyadstv.com',
];

// Analyse, Messung, Session-Aufzeichnung.
const TRACKER_HOSTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'adservice.google.com',
  'facebook.net',
  'connect.facebook.net',
  'graph.facebook.com',
  'analytics.tiktok.com',
  'ads-twitter.com',
  'analytics.twitter.com',
  'static.ads-twitter.com',
  'scorecardresearch.com',
  'quantserve.com',
  'hotjar.com',
  'hotjar.io',
  'mixpanel.com',
  'segment.io',
  'segment.com',
  'amplitude.com',
  'fullstory.com',
  'clarity.ms',
  'branch.io',
  'appsflyer.com',
  'adjust.com',
  'onesignal.com',
  'bugsnag.com',
  'newrelic.com',
  'nr-data.net',
  'optimizely.com',
  'crazyegg.com',
  'mouseflow.com',
  'luckyorange.com',
  'inspectlet.com',
  'yandex.ru',
  'mc.yandex.ru',
  'matomo.cloud',
  'chartbeat.com',
  'parsely.com',
  'sentry-cdn.com',
  'ioam.de',
  'iocnt.net',
  'meetrics.net',
  'emsservice.de',
  'kameleoon.eu',
  'contentsquare.net',
  'heapanalytics.com',
  'smartlook.com',
  'statcounter.com',
];

/*
 * Pfadmuster fuer Hosts, die nicht komplett gesperrt werden koennen, weil auf
 * ihnen auch echte Inhalte liegen. Absichtlich winzig und eng gefasst: jedes
 * Muster hier ist ein potenzieller Fehlalarm auf einer harmlosen Seite, und
 * eine kaputte Seite ist schlimmer als ein durchgelassener Banner.
 */
const AD_PATHS = [
  /\/pagead\//i,
  /\/adsbygoogle\.js/i,
  /\/prebid[\w.-]*\.js/i,
  /\/popunder[\w.-]*\.js/i,
  /\/pop-under[\w.-]*\.js/i,
  /\/popads[\w.-]*\.js/i,
  /\/adserver[/.]/i,
  /\/adframe[\w.-]*\.(js|html?)/i,
];

const popupSet = new Set(POPUP_HOSTS);
const adSet = new Set(AD_HOSTS);
const trackerSet = new Set(TRACKER_HOSTS);

/*
 * Match auf Suffix-Ebene: fuer a.b.example.com werden example.com, b.example.com
 * und a.b.example.com geprueft. Die letzte Komponente allein wird nie geprueft,
 * damit eine Liste mit einem Tippfehler nicht versehentlich eine ganze TLD
 * sperrt.
 */
function lookup(set, hostname) {
  const parts = String(hostname || '').toLowerCase().split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (set.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

/** Pop-under-Netz: als Ziel einer Navigation nie gewollt. */
function isPopupHost(hostname) {
  return lookup(popupSet, hostname);
}

/** Werbung im weiteren Sinn, also Auslieferung oder Pop-under. */
function isAdHost(hostname) {
  return lookup(popupSet, hostname) || lookup(adSet, hostname);
}

function isTrackerHost(hostname) {
  return lookup(trackerSet, hostname);
}

/** Rueckwaertskompatibler Name: irgendeine der drei Listen trifft zu. */
function hostMatches(hostname) {
  return isAdHost(hostname) || isTrackerHost(hostname);
}

/**
 * Entscheidet ueber einen einzelnen Request.
 * @returns {'popup'|'ad'|'tracker'|'path'|null} Grund, oder null fuer erlaubt.
 */
function classify(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null; // kaputte URL, damit soll Chromium umgehen
  }
  const host = parsed.hostname;
  if (lookup(popupSet, host)) return 'popup';
  if (lookup(adSet, host)) return 'ad';
  if (lookup(trackerSet, host)) return 'tracker';

  const path = parsed.pathname + parsed.search;
  for (const pattern of AD_PATHS) {
    if (pattern.test(path)) return 'path';
  }
  return null;
}

/** Attach the blocker to a session. Returns a stats object that keeps counting. */
function attach(session, isEnabled) {
  const stats = { blocked: 0, popups: 0 };
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (!isEnabled()) return callback({ cancel: false });
    if (classify(details.url)) {
      stats.blocked++;
      return callback({ cancel: true });
    }
    callback({ cancel: false });
  });

  // Strip the referrer down to origin and drop client hints that fingerprint.
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    delete headers['X-Client-Data'];
    if (headers['Referer']) {
      try {
        headers['Referer'] = new URL(headers['Referer']).origin + '/';
      } catch {
        delete headers['Referer'];
      }
    }
    callback({ requestHeaders: headers });
  });

  return stats;
}

module.exports = {
  attach,
  classify,
  hostMatches,
  isAdHost,
  isPopupHost,
  isTrackerHost,
  POPUP_HOSTS,
  AD_HOSTS,
  TRACKER_HOSTS,
  AD_PATHS,
};
