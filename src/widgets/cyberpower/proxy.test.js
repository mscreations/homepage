import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ------------------------------------------------------------------
// Hoist mocks before any imports
// ------------------------------------------------------------------

const { getServiceWidget } = vi.hoisted(() => ({ getServiceWidget: vi.fn() }));

vi.mock("utils/config/service-helpers", () => ({ default: getServiceWidget }));
vi.mock("utils/logger", () => ({
  default: () => ({ debug: vi.fn(), error: vi.fn() }),
}));
vi.mock("utils/proxy/api-helpers", () => ({
  formatApiCall: vi.fn((_template, params) => `${params.url}/${params.endpoint}`),
}));
vi.mock("widgets/widgets", () => ({
  default: { cyberpower: { api: "{url}/api/{endpoint}" } },
}));

// Mock the http module so we never touch the network
vi.mock("http", () => {
  const request = vi.fn();
  return { default: { request } };
});

import http from "http";
import cyberpowerProxyHandler from "./proxy";

// ------------------------------------------------------------------
// Test helpers
// ------------------------------------------------------------------

function createMockRes() {
  const res = {
    statusCode: undefined,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(data) {
      res.body = data;
      return res;
    },
    send(data) {
      res.body = data;
      return res;
    },
  };
  return res;
}

/**
 * Enqueue one fake HTTP response to be returned by the next http.request call.
 * Calls are consumed FIFO via mockImplementationOnce, matching the order that
 * cyberpowerRequest makes them: login → status poll(s) → API call → logout.
 */
function enqueueHttpResponse(body, statusCode = 200) {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);

  http.request.mockImplementationOnce((_options, callback) => {
    const handlers = new Map();

    const res = {
      statusCode,
      on(event, cb) {
        const set = handlers.get(event) ?? new Set();
        set.add(cb);
        handlers.set(event, set);
      },
    };

    const emit = (event, ...args) =>
      (handlers.get(event) ?? new Set()).forEach((cb) => cb(...args));

    return {
      on: vi.fn(),
      write: vi.fn(),
      // Simulate async I/O: deliver response after two microtask ticks so that
      // the surrounding Promise chain behaves as it would in production.
      end: vi.fn(() => {
        queueMicrotask(() => {
          callback(res);
          queueMicrotask(() => {
            emit("data", bodyStr);
            emit("end");
          });
        });
      }),
    };
  });
}

// ------------------------------------------------------------------
// Shared fixtures
// ------------------------------------------------------------------

const WIDGET = {
  type: "cyberpower",
  url: "http://ups.example.com",
  username: "admin",
  password: "secret",
};

const VALID_REQ = {
  query: { group: "g", service: "svc", endpoint: "upsstatus/", index: "0" },
};

const UPS_DATA = {
  input: { status: "Normal", phase: 1, voltage: 119.8, frequency: 60.0 },
  output: { status: "Normal", load: 26 },
  battery: { status: "Fully Charged", capacity: 100, runtime: 39, voltage: 52.9 },
  system: { status: "Normal", tempc: 26, tempf: 78 },
};

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe("widgets/cyberpower/proxy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- Guard rails ------------------------------------------------

  it("returns 400 when group or service is missing from the query", async () => {
    const req = { query: { endpoint: "upsstatus/", index: "0" } };
    const res = createMockRes();

    await cyberpowerProxyHandler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Invalid proxy service type" });
  });

  it("returns 400 when the widget cannot be resolved", async () => {
    getServiceWidget.mockResolvedValue(null);
    const res = createMockRes();

    await cyberpowerProxyHandler(VALID_REQ, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Invalid proxy service type" });
  });

  it("handles a fatal error and gracefully ignores a failed emergency logout (Line 146 function coverage)", async () => {
    getServiceWidget.mockResolvedValue(WIDGET);

    enqueueHttpResponse({ temp_token: "TEMP123" });
    enqueueHttpResponse({ result: "success", token: "TOKEN456", expires_in: 600 });
    
    // 1. Force the main API call to break, driving execution into the global catch block
    http.request.mockImplementationOnce((_options, _callback) => {
      return {
        on: vi.fn((event, cb) => { if (event === "error") cb(new Error("Main API crashed")); }),
        write: vi.fn(),
        end: vi.fn(),
      };
    });

    // 2. Force the emergency logout call inside that catch block to break as well
    http.request.mockImplementationOnce((_options, _callback) => {
      return {
        on: vi.fn((event, cb) => { if (event === "error") cb(new Error("Emergency logout network down")); }),
        write: vi.fn(),
        end: vi.fn(),
      };
    });

    const res = createMockRes();
    await cyberpowerProxyHandler(VALID_REQ, res);

    // Assertions ensure the function executed completely without throwing unhandled rejections
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("Main API crashed");
  });
  
  it("returns 500 when the server returns malformed non-JSON data (Line 39)", async () => {
    getServiceWidget.mockResolvedValue(WIDGET);
    
    // Step 1: Return raw HTML or text instead of valid JSON string to trigger JSON.parse failure
    enqueueHttpResponse("Internal Server Error HTML or Plain Text", 200);

    const res = createMockRes();
    await cyberpowerProxyHandler(VALID_REQ, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/Failed to parse response/i);
  });

  it("handles errors when no token is present and returns 500 (Lines 138-151 global catch without token)", async () => {
    getServiceWidget.mockResolvedValue(WIDGET);

    // Force cyberpowerRequest to throw an error immediately during step 1 (login)
    http.request.mockImplementationOnce((_options, _callback) => {
      const req = {
        on: vi.fn((event, cb) => {
          if (event === "error") {
            // Simulate a low-level network failure like connection refused
            cb(new Error("connect ECONNREFUSED"));
          }
        }),
        write: vi.fn(),
        end: vi.fn(),
      };
      return req;
    });

    const res = createMockRes();
    await cyberpowerProxyHandler(VALID_REQ, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("connect ECONNREFUSED");
    
    // Ensure no logout was attempted since token was never acquired
    // Only 1 call should have happened (the failed login request)
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it("handles errors when a token is present, runs cleanup logout, and returns 500 (Lines 138-151 global catch with token)", async () => {
    getServiceWidget.mockResolvedValue(WIDGET);

    enqueueHttpResponse({ temp_token: "TEMP123" });                                  // Step 1: Login
    enqueueHttpResponse({ result: "success", token: "TOKEN456", expires_in: 600 }); // Step 2: Poll status success (Token exists!)
    
    // Step 3: API call fails with raw network error, triggering the global catch block
    http.request.mockImplementationOnce((_options, _callback) => {
      return {
        on: vi.fn((event, cb) => { if (event === "error") cb(new Error("API network failure")); }),
        write: vi.fn(),
        end: vi.fn(),
      };
    });

    // Enqueue response for the fallback logout loop inside the catch block
    enqueueHttpResponse({ result: "success" });

    const res = createMockRes();
    await cyberpowerProxyHandler(VALID_REQ, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("API network failure");

    // Let's verify the catch block's emergency logout request was fired
    const calls = http.request.mock.calls;
    const lastCall = calls.at(-1)[0];
    expect(lastCall.path).toBe("/api/logout/");
    expect(lastCall.method).toBe("PUT");
    expect(lastCall.headers.Authorization).toBe("Bearer TOKEN456");
  });

  // ---- Step 1: initial login --------------------------------------

  it("returns 500 when step 1 login does not return a temp_token", async () => {
    getServiceWidget.mockResolvedValue(WIDGET);
    enqueueHttpResponse({ result: "fail" }); // no temp_token field

    const res = createMockRes();
    await cyberpowerProxyHandler(VALID_REQ, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/login failed/i);
  });

  it("sends the widget username and password in the login body", async () => {
    getServiceWidget.mockResolvedValue(WIDGET);
    enqueueHttpResponse({ temp_token: "TEMP123" });
    enqueueHttpResponse({ result: "success", token: "TOKEN456", expires_in: 600 });
    enqueueHttpResponse(UPS_DATA);
    enqueueHttpResponse({ result: "success" });

    const res = createMockRes();
    await cyberpowerProxyHandler(VALID_REQ, res);

    // The first http.request call is the login POST
    const loginCall = http.request.mock.calls[0];
    const [options, _callback] = loginCall;
    expect(options.method).toBe("POST");
    expect(options.path).toBe("/api/login/");

    // The body written to the request should contain the credentials
    const loginReq = http.request.mock.results[0].value;
    const writtenBody = JSON.parse(loginReq.write.mock.calls[0][0]);
    expect(writtenBody).toEqual({ username: "admin", passwd: "secret" });
  });

  // ---- Step 2: login status polling -------------------------------

  it("returns 401 when the status check immediately returns result: fail", async () => {
    getServiceWidget.mockResolvedValue(WIDGET);
    enqueueHttpResponse({ temp_token: "TEMP123" });
    enqueueHttpResponse({ result: "fail" });

    const res = createMockRes();
    await cyberpowerProxyHandler(VALID_REQ, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/login status failed/i);
  });

  it("returns 500 when login status polling times out after all attempts", async () => {
    vi.useFakeTimers();
    getServiceWidget.mockResolvedValue(WIDGET);

    enqueueHttpResponse({ temp_token: "TEMP123" }); // step 1
    // Saturate all 10 polling attempts with "processing"
    for (let i = 0; i < 10; i++) {
      enqueueHttpResponse({ status: "processing" });
    }

    const res = createMockRes();
    const handlerPromise = cyberpowerProxyHandler(VALID_REQ, res);

    // Advance through all the 500ms polling delays
    await vi.runAllTimersAsync();
    await handlerPromise;

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/timed out/i);
    // Exactly: 1 login + 10 status polls — no API call or logout should occur
    expect(http.request).toHaveBeenCalledTimes(11);
  });

  // ---- Happy path -------------------------------------------------

  it("returns API data after completing the full auth flow (immediate status success)", async () => {
    getServiceWidget.mockResolvedValue(WIDGET);

    enqueueHttpResponse({ temp_token: "TEMP123" });                                  // step 1
    enqueueHttpResponse({ result: "success", token: "TOKEN456", expires_in: 600 }); // step 2
    enqueueHttpResponse(UPS_DATA);                                                   // step 3
    enqueueHttpResponse({ result: "success" });                                      // step 4 logout

    const res = createMockRes();
    await cyberpowerProxyHandler(VALID_REQ, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(UPS_DATA);
  });

  it("polls login status multiple times before proceeding when the API returns processing", async () => {
    vi.useFakeTimers();
    getServiceWidget.mockResolvedValue(WIDGET);

    enqueueHttpResponse({ temp_token: "TEMP123" });                                  // step 1
    enqueueHttpResponse({ status: "processing" });                                   // step 2 poll 1
    enqueueHttpResponse({ status: "processing" });                                   // step 2 poll 2
    enqueueHttpResponse({ result: "success", token: "TOKEN456", expires_in: 600 }); // step 2 poll 3
    enqueueHttpResponse(UPS_DATA);                                                   // step 3
    enqueueHttpResponse({ result: "success" });                                      // step 4 logout

    const res = createMockRes();
    const handlerPromise = cyberpowerProxyHandler(VALID_REQ, res);

    await vi.runAllTimersAsync();
    await handlerPromise;

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(UPS_DATA);
    // 1 login + 3 status polls + 1 API call + 1 logout = 6 total requests
    expect(http.request).toHaveBeenCalledTimes(6);
  });

  // ---- Authorization headers --------------------------------------

  it("uses the temp token for the status check and the final token for subsequent requests", async () => {
    getServiceWidget.mockResolvedValue(WIDGET);

    enqueueHttpResponse({ temp_token: "TEMP123" });
    enqueueHttpResponse({ result: "success", token: "TOKEN456", expires_in: 600 });
    enqueueHttpResponse(UPS_DATA);
    enqueueHttpResponse({ result: "success" });

    const res = createMockRes();
    await cyberpowerProxyHandler(VALID_REQ, res);

    const calls = http.request.mock.calls;
    expect(calls[1][0].headers.Authorization).toBe("Bearer TEMP123"); // step 2 status
    expect(calls[2][0].headers.Authorization).toBe("Bearer TOKEN456"); // step 3 API
    expect(calls[3][0].headers.Authorization).toBe("Bearer TOKEN456"); // step 4 logout
  });

  // ---- Logout -----------------------------------------------------

  it("sends a PUT logout request with the final token after a successful API response", async () => {
    getServiceWidget.mockResolvedValue(WIDGET);

    enqueueHttpResponse({ temp_token: "TEMP123" });
    enqueueHttpResponse({ result: "success", token: "TOKEN456", expires_in: 600 });
    enqueueHttpResponse(UPS_DATA);
    enqueueHttpResponse({ result: "success" });

    const res = createMockRes();
    await cyberpowerProxyHandler(VALID_REQ, res);

    const logoutOptions = http.request.mock.calls.at(-1)[0];
    expect(logoutOptions.method).toBe("PUT");
    expect(logoutOptions.path).toBe("/api/logout/");

    const logoutReq = http.request.mock.results.at(-1).value;
    const logoutBody = JSON.parse(logoutReq.write.mock.calls[0][0]);
    expect(logoutBody).toEqual({ logout: "true" });
  });

  it("still returns 200 API data even when the logout call fails", async () => {
    getServiceWidget.mockResolvedValue(WIDGET);

    enqueueHttpResponse({ temp_token: "TEMP123" });
    enqueueHttpResponse({ result: "success", token: "TOKEN456", expires_in: 600 });
    enqueueHttpResponse(UPS_DATA);

    // Simulate a network error on logout
    http.request.mockImplementationOnce((_options, _callback) => ({
      on: vi.fn((_event, cb) => { if (_event === "error") cb(new Error("socket hang up")); }),
      write: vi.fn(),
      end: vi.fn(),
    }));

    const res = createMockRes();
    await cyberpowerProxyHandler(VALID_REQ, res);

    // The logout failure must not affect the response already sent
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(UPS_DATA);
  });
});
