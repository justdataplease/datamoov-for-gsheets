function dmvHost_(url) {
  var match = /^https:\/\/([a-z0-9.-]+)(?::443)?(?:\/[^\s]*)?$/i.exec(String(url));
  if (!match) throw new Error('Only HTTPS provider URLs are allowed.');
  return match[1].toLowerCase();
}

function dmvHttp_(request, hosts, deadline) {
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
      var text = response.getContentText();
      if (text.length > DMV_LIMITS.maxBytes)
        throw new Error('The provider returned too much data. Narrow the report.');
      try {
        return text ? JSON.parse(text) : {};
      } catch (error) {
        throw new Error('The provider returned an unreadable response.');
      }
    }
    if (code === 401 || code === 403)
      throw new Error(
        'Access denied by the provider (HTTP ' +
          code +
          '). Check credentials, permissions, and API access.'
      );
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
      'Provider request failed (HTTP ' + code + '). Check report settings and account access.'
    );
  }
}

function dmvGoogleToken_(credentials, scopes, deadline) {
  var mode = credentials.authMode || 'native';
  if (mode === 'native') return ScriptApp.getOAuthToken();
  if (mode === 'token')
    return dmvText_(credentials.accessToken, 'Google access token', 12000, true);
  if (mode !== 'service_account') throw new Error('Choose a Google authorization method.');
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

function dmvContext_(connector, connection, report, dates) {
  var deadline = Date.now() + 240000;
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
      return dmvHttp_(request, hosts, deadline);
    },
    accessToken: function () {
      return dmvGoogleToken_(connection.credentials, connector.googleScopes || [], deadline);
    },
  };
}
