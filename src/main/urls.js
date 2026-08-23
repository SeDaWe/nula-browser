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

function isSafeNavigationUrl(value) {
  if (value === NEW_TAB) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// A bare host: localhost with optional port, an IPv6 literal, an IPv4 address,
// or something.tld. Anything with whitespace is a search, never an address.
const HOST_PATTERN =
  /^(localhost(:\d+)?|\[[0-9a-fA-F:]+\](:\d+)?|(\d{1,3}\.){3}\d{1,3}(:\d+)?|[^\s/?#@]+\.[a-zA-Z]{2,}(:\d+)?)([/?#].*)?$/;

function resolveInput(input, settings) {
  const raw = (input || '').trim();
  if (!raw) return NEW_TAB;

  if (isSafeNavigationUrl(raw)) return raw;
  if (HOST_PATTERN.test(raw)) return 'https://' + raw;

  // Explicit non-web schemes can expose local files or invoke handlers. Search
  // them as text instead; only HTTP(S) and Nula's exact new-tab URL are allowed.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return search(raw, settings);
  }

  return search(raw, settings);
}

function search(query, settings) {
  const engine = SEARCH_ENGINES[settings?.searchEngine] || SEARCH_ENGINES.google;
  return engine.replace('%s', encodeURIComponent(query));
}

module.exports = { resolveInput, isSafeNavigationUrl, SEARCH_ENGINES, NEW_TAB };
