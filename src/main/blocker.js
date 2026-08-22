'use strict';

/*
 * Lightweight tracker blocker. Not a full adblock engine: a curated host list of
 * the highest-volume trackers and analytics endpoints, matched on registrable
 * domain. Fast, no rule compilation, no external list downloads (which would
 * themselves leak a request on every start).
 */

const TRACKER_HOSTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'googlesyndication.com',
  'googleadservices.com',
  'doubleclick.net',
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
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
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
];

const blockedSet = new Set(TRACKER_HOSTS);

function hostMatches(hostname) {
  const parts = hostname.toLowerCase().split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (blockedSet.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

/** Attach the blocker to a session. Returns a stats object that keeps counting. */
function attach(session, isEnabled) {
  const stats = { blocked: 0 };
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (!isEnabled()) return callback({ cancel: false });
    try {
      const { hostname } = new URL(details.url);
      if (hostMatches(hostname)) {
        stats.blocked++;
        return callback({ cancel: true });
      }
    } catch {
      /* malformed URL, let Chromium deal with it */
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

module.exports = { attach, hostMatches, TRACKER_HOSTS };
