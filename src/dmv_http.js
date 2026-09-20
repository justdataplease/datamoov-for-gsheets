function dmvHost_(url) {
  var match = /^https:\/\/([a-z0-9.-]+)(?::443)?(?:\/[^\s]*)?$/i.exec(String(url));
  if (!match) throw new Error('Only HTTPS provider URLs are allowed.');
  return match[1].toLowerCase();
}

function dmvHttp_(request, hosts, deadline, errorMessage) {
  var host = dmvHost_(request.url);
  if (hosts.indexOf(host) === -1)
    throw new Error('The connector requested a URL outside its provider.');
  var method = (request.method || 'get').toLowerCase();
  var retrySafe = method === 'get' || request.retrySafe === true;
  var attempts = retrySafe ? 3 : 1;
  var options = {
    method: method,
    headers: request.headers || {},
    muteHttpExceptions: true,
    followRedirects: false,
    validateHttpsCertificates: true,
  };
  if (request.body !== undefined) {
    options.contentType = request.contentType || 'application/json';
    options.payload =
      options.contentType === 'application/json' ? JSON.stringify(request.body) : request.body;
  }
  for (var attempt = 0; attempt < attempts; attempt++) {
    if (Date.now() > deadline - 10000)
      throw new Error('The refresh reached its time limit. Use a smaller report.');
    var response;
    try {
      response = UrlFetchApp.fetch(request.url, options);
    } catch (error) {
      if (attempt + 1 < attempts && Date.now() + 1000 < deadline - 10000) {
        Utilities.sleep(1000);
        continue;
      }
      throw new Error('Could not reach the data provider. Check connectivity and try again.');
    }
    var code = response.getResponseCode();
    if (code >= 200 && code < 300) {
      if (request.responseType === 'blob') {
        // Compressed report downloads; the caller decodes and validates the bytes.
        var blob = response.getBlob();
        if (blob.getBytes().length > DMV_LIMITS.maxBytes)
          throw new Error('The provider returned too much data. Narrow the report.');
        return blob;
      }
      var text = response.getContentText();
      if (text.length > DMV_LIMITS.maxBytes)
        throw new Error('The provider returned too much data. Narrow the report.');
      try {
        return text ? JSON.parse(text) : {};
      } catch (error) {
        throw new Error('The provider returned an unreadable response.');
      }
    }
    // A connector may translate the provider's error body into actionable guidance.
    var guidance = dmvHttpGuidance_(response, code, errorMessage);
    if (code === 401 || code === 403) {
      throw new Error(
        guidance ||
          'Access denied by the provider (HTTP ' +
            code +
            '). Check credentials, permissions, and API access.'
      );
    }
    if (code >= 300 && code < 400)
      throw new Error('The provider redirected the request. Check the configured account or host.');
    if ((code === 429 || code >= 500) && attempt + 1 < attempts) {
      var headers = response.getAllHeaders();
      var retryAfter = headers['Retry-After'] || headers['retry-after'];
      var delay = retryAfter
        ? /^\d+(?:\.\d+)?$/.test(String(retryAfter))
          ? Number(retryAfter) * 1000
          : Date.parse(String(retryAfter)) - Date.now()
        : Math.pow(2, attempt) * 1000;
      if (!Number.isFinite(delay) || delay < 0) delay = 1000;
      if (delay > 10000 || Date.now() + delay > deadline - 10000)
        throw new Error('The provider is busy or rate-limited. Try again later.');
      Utilities.sleep(delay);
      continue;
    }
    throw new Error(
      guidance ||
        'Provider request failed (HTTP ' + code + '). Check report settings and account access.'
    );
  }
}

function dmvHttpGuidance_(response, code, errorMessage) {
  if (typeof errorMessage !== 'function') return '';
  var guidance;
  try {
    var errorText = response.getContentText();
    if (errorText.length <= 100000) guidance = errorMessage(code, JSON.parse(errorText));
  } catch (ignored) {
    guidance = '';
  }
  return typeof guidance === 'string' && guidance.length > 0 && guidance.length <= 400
    ? guidance
    : '';
}

function dmvGoogleOAuthToken_(credentials, scopes, deadline) {
  return dmvOAuthRefreshToken_(
    {
      label: 'Google OAuth',
      endpoint: 'https://oauth2.googleapis.com/token',
      scopes: scopes || [],
    },
    credentials,
    deadline
  );
}

// Exchange a user-supplied refresh token at a provider's fixed token endpoint. Access tokens are
// cached per user until shortly before expiry; the refresh token itself is never cached or logged.
// Providers that rotate refresh tokens (Microsoft, LinkedIn) hand the replacement to onRotate.
function dmvOAuthRefreshToken_(provider, credentials, deadline, onRotate) {
  var names = ['clientId', 'clientSecret', 'refreshToken'];
  var values = names.map(function (name) {
    var value = credentials[name];
    if (typeof value !== 'string' || !value.trim() || value.length > 12000)
      throw new Error(provider.label + ' needs a client ID, client secret, and refresh token.');
    return value.trim();
  });
  var host = dmvHost_(provider.endpoint);
  var cacheKey =
    'dmv:oauth:' +
    Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_256,
        JSON.stringify([
          'oauth',
          provider.endpoint,
          values[0],
          values[1],
          values[2],
          provider.scopes || [],
        ])
      )
    ).replace(/=+$/, '');
  var validToken = function (value) {
    return (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 12000 &&
      !/[\s\u0000-\u001f\u007f]/.test(value)
    );
  };
  var cache = CacheService.getUserCache();
  var cached;
  try {
    cached = cache.get(cacheKey);
  } catch (ignored) {
    cached = null;
  }
  if (validToken(cached)) return cached;
  var startedAt = Date.now();
  var body =
    'client_id=' +
    encodeURIComponent(values[0]) +
    '&client_secret=' +
    encodeURIComponent(values[1]) +
    '&refresh_token=' +
    encodeURIComponent(values[2]) +
    '&grant_type=refresh_token';
  if (provider.scopeParameter && (provider.scopes || []).length)
    body += '&scope=' + encodeURIComponent(provider.scopes.join(' '));
  var token;
  try {
    token = dmvHttp_(
      {
        url: provider.endpoint,
        method: 'post',
        contentType: 'application/x-www-form-urlencoded',
        body: body,
      },
      [host],
      deadline
    );
  } catch (error) {
    if (error && typeof error.message === 'string' && /time limit|rate-limited/.test(error.message))
      throw error;
    if (error && typeof error.message === 'string' && /HTTP 429/.test(error.message))
      throw new Error(provider.label + ' is rate-limited. Try again later.');
    throw new Error(
      provider.label +
        ' credentials could not be refreshed. Check the client ID, client secret, and refresh token; reauthorize if access expired or was revoked.'
    );
  }
  if (
    !token ||
    typeof token !== 'object' ||
    Array.isArray(token) ||
    !validToken(token.access_token)
  )
    throw new Error(
      provider.label + ' did not return a valid access token. Check the OAuth credentials.'
    );
  if (
    typeof onRotate === 'function' &&
    validToken(token.refresh_token) &&
    token.refresh_token !== values[2]
  )
    onRotate({ refreshToken: token.refresh_token });
  var elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
  var expiry =
    typeof token.expires_in === 'number'
      ? token.expires_in
      : typeof token.expires_in === 'string' && /^-?\d+(?:\.\d+)?$/.test(token.expires_in)
        ? Number(token.expires_in)
        : NaN;
  if (Number.isFinite(expiry) && (expiry <= 0 || expiry <= elapsed))
    throw new Error(provider.label + ' returned an expired access token. Try authorizing again.');
  if (typeof token.expires_in === 'number' && Number.isInteger(expiry) && expiry > 0) {
    var ttl = Math.min(3300, Math.floor(expiry - elapsed - 120));
    if (ttl > 0) {
      try {
        cache.put(cacheKey, token.access_token, ttl);
      } catch (ignored) {
        /* Cache is optional. */
      }
    }
  }
  return token.access_token;
}

// The add-on holds no Google API scopes of its own; every Google token comes from the user's own
// service-account key, OAuth client, or pasted access token.
function dmvGoogleToken_(credentials, scopes, deadline) {
  var mode = credentials.authMode;
  if (mode === 'token')
    return dmvText_(credentials.accessToken, 'Google access token', 12000, true);
  if (mode === 'oauth') return dmvGoogleOAuthToken_(credentials, scopes, deadline);
  if (mode !== 'service_account')
    throw new Error(
      'Edit this connection and choose a Google authorization method: service account key, OAuth client credentials, or access token.'
    );
  var key;
  try {
    key = JSON.parse(credentials.serviceAccountJson || '');
  } catch (error) {
    throw new Error('Paste a valid service-account JSON key.');
  }
  if (key.type !== 'service_account' || !key.client_email || !key.private_key)
    throw new Error('The service-account JSON needs client_email and private_key.');
  var cacheKey =
    'dmv:token:' +
    Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_256,
        key.client_email + key.private_key + scopes.join(' ')
      )
    ).slice(0, 80);
  var cached = CacheService.getUserCache().get(cacheKey);
  if (cached) return cached;
  var now = Math.floor(Date.now() / 1000);
  var encode = function (value) {
    return Utilities.base64EncodeWebSafe(JSON.stringify(value)).replace(/=+$/, '');
  };
  var payload =
    encode({ alg: 'RS256', typ: 'JWT' }) +
    '.' +
    encode({
      iss: key.client_email,
      scope: scopes.join(' '),
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    });
  var signature;
  try {
    signature = Utilities.base64EncodeWebSafe(
      Utilities.computeRsaSha256Signature(payload, key.private_key)
    ).replace(/=+$/, '');
  } catch (error) {
    throw new Error('The service-account private key could not be read.');
  }
  var token = dmvHttp_(
    {
      url: 'https://oauth2.googleapis.com/token',
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      body:
        'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' +
        encodeURIComponent(payload + '.' + signature),
    },
    ['oauth2.googleapis.com'],
    deadline
  );
  if (!token.access_token)
    throw new Error('Google did not issue an access token. Check the service account.');
  CacheService.getUserCache().put(
    cacheKey,
    token.access_token,
    Math.max(1, Math.min(3300, Number(token.expires_in || 3600) - 120))
  );
  return token.access_token;
}

// A saved connection may receive replacement secrets from a provider (rotated refresh tokens).
// The revision stays the same: only the secret changed, not the account the connection points at.
function dmvContext_(connector, connection, report, dates, deadline) {
  deadline = deadline || Date.now() + 240000;
  var hosts =
    typeof connector.allowedHosts === 'function'
      ? connector.allowedHosts(connection.credentials)
      : connector.allowedHosts || [];
  var count = 0;
  return {
    credentials: connection.credentials,
    config: report.config || {},
    fields: report.fields || [],
    startDate: dates.startDate,
    endDate: dates.endDate,
    maxRows: report.maxRows || DMV_LIMITS.defaultRows,
    deadline: deadline,
    checkDeadline: function () {
      if (Date.now() > deadline - 10000)
        throw new Error('The refresh reached its time limit. Use a smaller report.');
    },
    http: function (request) {
      if (++count > 100) throw new Error('This report needs too many requests. Narrow its scope.');
      return dmvHttp_(request, hosts, deadline, connector.errorMessage);
    },
    accessToken: function () {
      return dmvGoogleToken_(connection.credentials, connector.googleScopes || [], deadline);
    },
    rotateCredentials: function (patch) {
      Object.keys(patch).forEach(function (key) {
        connection.credentials[key] = patch[key];
      });
      if (connection.id) dmvRotateCredentials_(connection, patch);
    },
  };
}
