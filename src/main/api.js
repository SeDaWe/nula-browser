'use strict';

/* Thin HTTP client for the Nula sync server (see nula-server/API.md). */

class ApiError extends Error {
  constructor(status, message, payload) {
    super(message);
    this.status = status;
    this.payload = payload || null;
  }
}

class NulaApi {
  constructor(serverUrl) {
    this.base = serverUrl.replace(/\/+$/, '');
    this.authKeyHex = null;
  }

  async request(method, path, body, { timeoutMs = 10000, extraHeaders = {} } = {}) {
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (this.authKeyHex) headers['Authorization'] = `Bearer ${this.authKeyHex}`;
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ApiError(0, `Server nicht erreichbar (${err.cause?.code || err.name})`);
    }
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      throw new ApiError(res.status, payload?.error || `HTTP ${res.status}`, payload);
    }
    return payload;
  }

  health() {
    return this.request('GET', '/api/health', undefined, { timeoutMs: 5000 });
  }

  info() {
    return this.request('GET', '/api/info');
  }

  setup(clientSalt, authKey, argon2, setupToken) {
    return this.request(
      'POST',
      '/api/setup',
      { clientSalt, authKey, argon2 },
      setupToken ? { extraHeaders: { 'X-Nula-Setup-Token': setupToken } } : undefined
    );
  }

  verify() {
    return this.request('POST', '/api/verify');
  }

  registerIdentity(x25519Public, kemPublic, setupToken) {
    return this.request(
      'POST',
      '/api/identity',
      { x25519Public, kemPublic },
      setupToken ? { extraHeaders: { 'X-Nula-Setup-Token': setupToken } } : undefined
    );
  }

  getVault(since) {
    return this.request('GET', `/api/vault?since=${since}`);
  }

  putVault(baseVersion, blob) {
    return this.request('PUT', '/api/vault', { baseVersion, blob });
  }

  listTokens() {
    return this.request('GET', '/api/tokens');
  }

  createToken(name) {
    return this.request('POST', '/api/tokens', { name });
  }

  deleteToken(id) {
    return this.request('DELETE', `/api/tokens/${id}`);
  }

  getInbox() {
    return this.request('GET', '/api/inbox');
  }

  deleteInboxItem(id) {
    return this.request('DELETE', `/api/inbox/${id}`);
  }
}

module.exports = { NulaApi, ApiError };
