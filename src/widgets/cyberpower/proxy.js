import { Buffer } from "node:buffer";

import getServiceWidget from "utils/config/service-helpers";
import createLogger from "utils/logger";
import { formatApiCall } from "utils/proxy/api-helpers";

import widgets from "widgets/widgets";
import http from 'http';

const logger = createLogger("cyberpowerProxyHandler");

// API Documentation => https://www.cyberpowersystems.com/product/ups/hardware/rmcard205/#tab-documents

function cyberpowerRequest({ hostname, port = 80, path, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname,
      port,
      path,
      method,
      headers: {
        ...(bodyStr && { 
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        }),
        'Connection': 'close',
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch (e) {
          reject(new Error(`Failed to parse response: ${raw}`));
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

export default async function cyberpowerProxyHandler(req, res) {
  const { group, service, endpoint, index } = req.query;

  if (!group || !service) {
    logger.debug("Invalid or missing service '%s' or group '%s'", service, group);
    return res.status(400).json({ error: "Invalid proxy service type" });
  }

  const widget = await getServiceWidget(group, service, index);
  if (!widget) {
    logger.debug("Invalid or missing widget for service '%s' in group '%s'", service, group);
    return res.status(400).json({ error: "Invalid proxy service type" });
  }

  const { hostname, port } = new URL(widget.url);
  let token = null;

  try {
    // Step 1: Initial login to get an initial temp token.
    const { data: loginData } = await cyberpowerRequest({
      hostname,
      port,
      path: '/api/login/',
      method: 'POST',
      body: { username: widget.username, passwd: widget.password },
    });
    logger.debug("Cyberpower login response: %s", JSON.stringify(loginData));

    const tempToken = loginData.temp_token;
    if (!tempToken) {
      return res.status(500).json({ error: `Login failed: ${JSON.stringify(loginData)}` });
    }

    // Step 2: Finalize login - We have to poll because the RMCARD205 may not be ready immediately for the login to work.
    const maxAttempts = 10;
    const pollIntervalMs = 500;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { data: statusData } = await cyberpowerRequest({
        hostname,
        port,
        path: '/api/login/status/',
        headers: { Authorization: `Bearer ${tempToken}` },
      });
      logger.debug("Cyberpower status poll %d: %s", attempt + 1, JSON.stringify(statusData));

      if (statusData.result === 'fail') {
        return res.status(401).json({ error: `Login status failed: ${JSON.stringify(statusData)}` });
      }

      if (statusData.result === 'success' && statusData.token) {
        token = statusData.token;
        break;
      }

      // Still processing — wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    if (!token) {
      return res.status(500).json({ error: 'Timed out waiting for login token' });
    }

    // Step 3: Actual API call
    const apiPath = new URL(
      formatApiCall(widgets[widget.type].api, { endpoint, ...widget })
    ).pathname;

    const { data: apiData } = await cyberpowerRequest({
      hostname,
      port,
      path: apiPath,
      headers: { Authorization: `Bearer ${token}` },
    });

    // Step 4: Logout - We have to logout immediately or the UPS will not allow regular logins because a user is still logged in.
    await cyberpowerRequest({
      hostname,
      port,
      path: '/api/logout/',
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: { logout: 'true' },
    }).catch((e) => logger.debug("Cyberpower logout failed (non-fatal): %s", e.message));

    return res.status(200).json(apiData);

  } catch (err) {
    logger.debug("Cyberpower proxy error: %s", err.message);

    if (token) {
      await cyberpowerRequest({
        hostname,
        port,
        path: '/api/logout/',
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: { logout: 'true' },
      }).catch(() => {});
    }

    return res.status(500).json({ error: err.message });
  }
}