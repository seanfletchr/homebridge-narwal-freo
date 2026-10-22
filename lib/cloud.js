// Narwal cloud REST client (the US app endpoint used by the official app).

const REGIONS = {
  us: { base: 'https://us-app.narwaltech.com', country: 'US' },
};

const APP_HEADERS = {
  'aiot-application-id': '2E3t5It3Dr',
  'app-language': 'en-US',
  'app-version': '2.7.03',
  'app_type': 'normal',
  'app_version': '2.7.03',
  'is_app': 'true',
  'is_beta': 'false',
  'ismainland': '0',
  'language_code': 'en-US',
  'platform': 'android',
  'version_code': '175',
};

export class NarwalAuthError extends Error {}

/** Read the JWT payload without verifying it (we only need uuid and exp). */
export function jwtClaims(token) {
  try {
    const part = token.split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

export class NarwalCloud {
  /**
   * @param {object} opts
   * @param {string} opts.email
   * @param {string} opts.password
   * @param {string} [opts.region]
   * @param {string} [opts.appVersion] Narwal app version to present (default: the built-in one)
   * @param {string|number} [opts.versionCode] Narwal app version code to present
   * @param {{accessToken?: string, refreshToken?: string}} [opts.tokens] tokens saved from a previous run
   * @param {(tokens: {accessToken: string, refreshToken: string}) => void} [opts.onTokens] called when tokens rotate
   * @param {import('homebridge').Logging} opts.log
   */
  constructor({ email, password, region = 'us', appVersion, versionCode, tokens = {}, onTokens, log }) {
    this.email = email;
    this.password = password;
    this.region = REGIONS[region] ?? REGIONS.us;
    // The app version is sent with every request; the settings can override it if Narwal starts
    // refusing the built-in one.
    this.appHeaders = { ...APP_HEADERS };
    if (appVersion) {
      this.appHeaders['app-version'] = String(appVersion);
      this.appHeaders.app_version = String(appVersion);
    }
    if (versionCode) {
      this.appHeaders.version_code = String(versionCode);
    }
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
    this.onTokens = onTokens;
    this.log = log;
    this.refreshing = undefined;
  }

  get uuid() {
    return jwtClaims(this.accessToken ?? '').uuid ?? '';
  }

  get country() {
    return this.region.country;
  }

  headers() {
    const uuid = this.uuid;
    const h = { ...this.appHeaders, country_code: this.region.country, did: uuid, uuid, 'content-type': 'application/json; charset=utf-8' };
    if (this.accessToken) {
      h['auth-token'] = this.accessToken;
      h.authorization = this.accessToken;
    }
    return h;
  }

  /** Return a valid access token, refreshing or logging in when it is missing or near expiry. */
  async ensureToken() {
    const exp = jwtClaims(this.accessToken ?? '').exp;
    if (this.accessToken && (!exp || exp * 1000 - Date.now() > 10 * 60 * 1000)) {
      return this.accessToken;
    }
    await this.renew();
    return this.accessToken;
  }

  /** Refresh the session (single flight); fall back to a fresh login. */
  async renew() {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          if (this.refreshToken) {
            try {
              const payload = await this.raw('POST', '/user-authentication-server/v1/token/refresh', {
                body: { refreshToken: this.refreshToken },
              });
              if (this.storeTokens(payload)) {
                this.log.debug('Narwal session refreshed');
                return;
              }
            } catch (error) {
              this.log.debug(`Token refresh failed (${error.message}); signing in again`);
            }
          }
          await this.login();
        } finally {
          this.refreshing = undefined;
        }
      })();
    }
    return this.refreshing;
  }

  async login() {
    if (!this.email || !this.password) {
      throw new NarwalAuthError('Narwal email and password are not configured');
    }
    this.accessToken = undefined;
    const payload = await this.raw('POST', '/user-authentication-server/v2/login/loginByEmail', {
      body: { email: this.email, password: this.password },
    });
    if (!this.storeTokens(payload)) {
      throw new NarwalAuthError(`Narwal sign-in failed: ${payload?.msg ?? payload?.message ?? 'no token returned'}`);
    }
    this.log.info('Signed in to Narwal');
  }

  storeTokens(payload) {
    const result = payload?.result;
    const candidates = [result, result?.userInfo, result?.authInfo, result?.data, payload];
    for (const c of candidates) {
      if (c && typeof c === 'object') {
        const access = c.token ?? c.accessToken;
        const refresh = c.refreshToken ?? c.refresh_token;
        if (typeof access === 'string' && typeof refresh === 'string') {
          this.accessToken = access;
          this.refreshToken = refresh;
          this.onTokens?.({ accessToken: access, refreshToken: refresh });
          return true;
        }
      }
    }
    return false;
  }

  async raw(method, path, { params, body } = {}) {
    const url = new URL(this.region.base + path);
    for (const [k, v] of Object.entries(params ?? {})) {
      url.searchParams.set(k, String(v));
    }
    const response = await fetch(url, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new NarwalAuthError(`Narwal rejected the session (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new Error(`Narwal HTTP ${response.status} for ${path}`);
    }
    return response.json();
  }

  /** Authenticated request; renews the session once if Narwal rejects the token. */
  async request(method, path, opts = {}, retry = true) {
    await this.ensureToken();
    let payload;
    try {
      payload = await this.raw(method, path, opts);
    } catch (error) {
      if (error instanceof NarwalAuthError && retry) {
        await this.renew();
        return this.request(method, path, opts, false);
      }
      throw error;
    }
    const message = String(payload?.msg ?? payload?.message ?? '');
    if (payload?.code === -1 && /token/i.test(message) && retry) {
      await this.renew();
      return this.request(method, path, opts, false);
    }
    if (payload?.success === false) {
      throw new Error(`Narwal API ${path} failed: ${message || payload?.code}`);
    }
    return payload;
  }

  async getDevices() {
    const payload = await this.request('GET', '/user-device-platform-server/device-info/getDeviceInfoList');
    return payload?.result?.deviceInfoList ?? [];
  }

  async getBrokerUrl() {
    const payload = await this.request('GET', '/iot-broker-discover/app/v1/broker/discover', {
      params: { country: this.region.country },
    });
    const url = payload?.result;
    if (typeof url !== 'string' || !url.includes('://')) {
      throw new Error('Narwal did not return an MQTT broker');
    }
    return url;
  }

  /** Cloud work state; we use it for fault reporting. */
  async getWorkStatus(deviceId, productId) {
    const payload = await this.request('GET', '/device-task/work-status/get', {
      params: { device_id: deviceId, product_id: productId, source: '0' },
    });
    return payload?.result ?? {};
  }

  /**
   * Consumables as the app's maintenance page lists them: `{ type, name, subtitle,
   * total_duration, usage_duration, progress_bar_switch, … }`, durations in seconds.
   */
  async getConsumables(deviceId, productId) {
    const payload = await this.request('POST', '/consumables-management-app-server/v3/consumables/list', {
      body: { deviceId, productId },
    });
    return Array.isArray(payload?.result) ? payload.result : [];
  }
}
