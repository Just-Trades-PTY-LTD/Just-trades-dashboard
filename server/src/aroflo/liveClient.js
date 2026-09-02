import crypto from 'node:crypto';

/**
 * AroFlo REST API client.
 *
 * AroFlo gates API access per account (enabled by an AroFlo support request)
 * and issues three credentials used together: an SDK key identifying the
 * integration, an account Access key, and a paired Secret key used to sign
 * every request with HMAC-SHA256.
 *
 * IMPORTANT — verify before relying on this in production:
 * The exact canonical-string layout, header names, and resource paths below
 * follow AroFlo's documented request-signing pattern, but AroFlo's full API
 * reference (https://apidocs.aroflo.com) sits behind account login and ships
 * an account-specific Postman collection with a signing pre-request script.
 * This environment could not reach that portal to byte-for-byte confirm the
 * header names and endpoint paths. Before going live, open that collection
 * once with your account's credentials, diff it against `sign()` and
 * `ENDPOINTS` below, and adjust the few marked spots — the rest of the
 * dashboard (aggregation, UI) does not need to change.
 */

const ENDPOINTS = {
  jobs: '/jobs',
  staff: '/staff',
  timesheets: '/timesheets',
};

function sign({ secretKey, method, path, timestamp, body }) {
  // VERIFY: canonical string layout against your AroFlo Postman collection.
  const canonical = `${method.toUpperCase()}\n${path}\n${timestamp}\n${body || ''}`;
  return crypto.createHmac('sha256', secretKey).update(canonical).digest('base64');
}

export class AroFloLiveClient {
  constructor({ baseUrl, sdkKey, accessKey, secretKey }) {
    if (!sdkKey || !accessKey || !secretKey) {
      throw new Error(
        'AROFLO_MODE=live requires AROFLO_SDK_KEY, AROFLO_ACCESS_KEY and AROFLO_SECRET_KEY to be set.'
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.sdkKey = sdkKey;
    this.accessKey = accessKey;
    this.secretKey = secretKey;
  }

  async request(path, { method = 'GET', query, body } = {}) {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, value);
      }
    }

    const timestamp = new Date().toISOString();
    const bodyString = body ? JSON.stringify(body) : '';
    const signature = sign({
      secretKey: this.secretKey,
      method,
      path: url.pathname + url.search,
      timestamp,
      body: bodyString,
    });

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // VERIFY: header names against your AroFlo Postman collection.
        'X-AroFlo-SDK-Key': this.sdkKey,
        'X-AroFlo-Access-Key': this.accessKey,
        'X-AroFlo-Timestamp': timestamp,
        'X-AroFlo-Signature': signature,
      },
      body: bodyString || undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`AroFlo API ${method} ${path} failed: ${response.status} ${text}`);
    }
    return response.json();
  }

  async listJobs(params = {}) {
    const data = await this.request(ENDPOINTS.jobs, { query: params });
    return data.items || data.jobs || data;
  }

  async listStaff(params = {}) {
    const data = await this.request(ENDPOINTS.staff, { query: params });
    return data.items || data.staff || data;
  }

  async listTimesheets(params = {}) {
    const data = await this.request(ENDPOINTS.timesheets, { query: params });
    return data.items || data.timesheets || data;
  }
}
