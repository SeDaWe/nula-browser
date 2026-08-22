'use strict';

/*
 * Omnibox input handling: decide whether what the user typed is an address or a
 * search. Getting this wrong is loud (a search for "example.com", or a failed
 * navigation to "wie spät ist es"), so it lives on its own and is tested.
 */

const SEARCH_ENGINES = {
  duckduckgo: 'https://duckduckgo.com/?q=%s',
  startpage: 'https://www.startpage.com/sp/search?query=%s',
  brave: 'https://search.brave.com/search?q=%s',
  google: 'https://www.google.com/search?q=%s',
};

const NEW_TAB = 'nula://newtab';

// A bare host: localhost with optional port, an IPv6 literal, an IPv4 address,
// or something.tld. Anything with whitespace is a search, never an address.
const HOST_PATTERN =
  /^(localhost(:\d+)?|\[[0-9a-fA-F:]+\](:\d+)?|(\d{1,3}\.){3}\d{1,3}(:\d+)?|[^\s/?#@]+\.[a-zA-Z]{2,}(:\d+)?)([/?#].*)?$/;

function resolveInput(input, settings) {
  const raw = (input || '').trim();
  if (!raw) return NEW_TAB;

  // Explicit schemes are taken at face value, with one exception below.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^nula:/i.test(raw)) {
    return raw;
  }

  // Scheme-like but not a real URL, e.g. "javascript:alert(1)" pasted into the
  // bar. Never navigate to those; treat them as a search instead.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !HOST_PATTERN.test(raw)) {
    return search(raw, settings);
  }

  if (HOST_PATTERN.test(raw)) return 'https://' + raw;

  return search(raw, settings);
}

function search(query, settings) {
  const engine = SEARCH_ENGINES[settings?.searchEngine] || SEARCH_ENGINES.duckduckgo;
  return engine.replace('%s', encodeURIComponent(query));
}

module.exports = { resolveInput, SEARCH_ENGINES, NEW_TAB };
