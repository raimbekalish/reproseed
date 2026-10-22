import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

export type DemoRecord = {
  id: string;
  email: string;
  note: string;
  createdAt: number;
};

export type DemoServerOptions = {
  host?: string;
  port?: number;
  appId?: string;
  resetAuthorization?: string;
};

export type DemoServer = {
  origin: string;
  appId: string | undefined;
  close: () => Promise<void>;
};

const BODY_LIMIT = 64 * 1024;
const PAGE_HTML = readFileSync(fileURLToPath(new URL("./public/index.html", import.meta.url)), "utf8");

export async function startDemoServer(options: DemoServerOptions = {}): Promise<DemoServer> {
  const host = bindAddress(options.host ?? "127.0.0.1");
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("port must be an integer from 0 through 65535");
  }
  const appId = blankToUndefined(options.appId);
  const resetAuthorization = blankToUndefined(options.resetAuthorization);
  const records: DemoRecord[] = [];

  const server = createServer((request, response) => {
    void handleRequest(request, response, { records, appId, resetAuthorization }).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 400, { error: "bad request" });
      } else {
        response.destroy();
      }
    });
  });

  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      server.close();
      reject(error);
    };
    server.once("error", fail);
    server.listen(port, host, () => {
      server.removeListener("error", fail);
      const address = server.address();
      if (address === null || typeof address === "string") {
        fail(new Error("demo server did not bind a TCP port"));
        return;
      }
      if (!isLoopbackAddress(address.address)) {
        fail(new Error(`demo server refuses non-loopback address ${address.address}`));
        return;
      }
      resolve({
        origin: `http://${formatHost(address.address)}:${address.port}`,
        appId,
        close: () => closeServer(server),
      });
    });
  });
}

function bindAddress(host: string): string {
  if (host === "127.0.0.1" || host === "localhost") {
    return "127.0.0.1";
  }
  if (host === "::1") {
    return "::1";
  }
  throw new Error(`demo server refuses non-loopback host ${host}`);
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1";
}

function formatHost(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value;
}

type AppState = {
  records: DemoRecord[];
  appId: string | undefined;
  resetAuthorization: string | undefined;
};

async function handleRequest(request: IncomingMessage, response: ServerResponse, state: AppState): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/") {
    sendHtml(response, PAGE_HTML);
    return;
  }
  if (method === "GET" && url.pathname === "/api/records") {
    sendJson(response, 200, state.records);
    return;
  }
  if (method === "POST" && url.pathname === "/api/records") {
    await createRecord(request, response, state.records);
    return;
  }
  if (method === "GET" && url.pathname === "/__reproseed/identity") {
    if (state.appId === undefined) {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    sendJson(response, 200, { appId: state.appId });
    return;
  }
  if (method === "POST" && url.pathname === "/__reproseed/reset") {
    resetRecords(request, response, state);
    return;
  }
  sendJson(response, 404, { error: "not found" });
}

async function createRecord(request: IncomingMessage, response: ServerResponse, records: DemoRecord[]): Promise<void> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.startsWith("application/json")) {
    sendJson(response, 415, { error: "content type must be application/json" });
    return;
  }
  const record = parseRecord(await readBody(request, BODY_LIMIT));
  if (record === undefined) {
    sendJson(response, 400, { error: "email is required" });
    return;
  }
  const stored: DemoRecord = {
    id: randomUUID(),
    email: record.email,
    note: record.note,
    createdAt: Date.now(),
  };
  records.push(stored);
  sendJson(response, 201, stored);
}

function resetRecords(request: IncomingMessage, response: ServerResponse, state: AppState): void {
  if (state.appId === undefined || state.resetAuthorization === undefined) {
    sendJson(response, 404, { error: "not found" });
    return;
  }
  const presentedAppId = singleHeader(request.headers["x-reproseed-app-id"]);
  const presentedAuthorization = singleHeader(request.headers["x-reproseed-reset-authorization"]);
  const appMatches = presentedAppId !== undefined && tokensMatch(state.appId, presentedAppId);
  const authMatches = presentedAuthorization !== undefined && tokensMatch(state.resetAuthorization, presentedAuthorization);
  if (!appMatches || !authMatches) {
    sendJson(response, 403, { error: "reset refused" });
    return;
  }
  state.records.splice(0, state.records.length);
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

function parseRecord(body: string): { email: string; note: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const candidate = parsed as { email?: unknown; note?: unknown };
  if (typeof candidate.email !== "string") {
    return undefined;
  }
  const email = candidate.email.trim();
  if (email === "" || email.length > 320) {
    return undefined;
  }
  if (candidate.note !== undefined && (typeof candidate.note !== "string" || candidate.note.length > 2_000)) {
    return undefined;
  }
  return { email, note: typeof candidate.note === "string" ? candidate.note : "" };
}

function tokensMatch(expected: string, presented: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: Error | undefined, body?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (error !== undefined) {
        request.destroy();
        reject(error);
        return;
      }
      resolve(body ?? "");
    };
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        finish(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => finish(undefined, Buffer.concat(chunks).toString("utf8")));
    request.on("error", (error) => finish(error));
  });
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function runningAsCli(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

function cliPort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return 4010;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer from 0 through 65535");
  }
  return port;
}

if (runningAsCli()) {
  const appId = process.env.REPROSEED_APP_ID;
  const resetAuthorization = process.env.REPROSEED_RESET_AUTHORIZATION;
  const demo = await startDemoServer({
    host: process.env.HOST ?? "127.0.0.1",
    port: cliPort(process.env.PORT),
    ...(appId !== undefined ? { appId } : {}),
    ...(resetAuthorization !== undefined ? { resetAuthorization } : {}),
  });
  console.log(`duplicate-submit demo listening on ${demo.origin}`);
  if (demo.appId === undefined || blankToUndefined(resetAuthorization) === undefined) {
    console.log("reset is disabled until REPROSEED_APP_ID and REPROSEED_RESET_AUTHORIZATION are set");
  }
}
