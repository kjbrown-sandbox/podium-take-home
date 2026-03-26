import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";

export interface MockUpstream {
  server: Server;
  port: number;
  /** All requests received by this mock */
  requests: ReceivedRequest[];
  close: () => Promise<void>;
}

export interface ReceivedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

type MockHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Default handler: echoes back request info as JSON.
 */
const echoHandler: MockHandler = (req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body || undefined,
      })
    );
  });
};

/**
 * Creates a mock upstream server on the given port.
 * By default echoes back request details as JSON.
 */
export function createMockUpstream(
  port: number,
  handler?: MockHandler
): Promise<MockUpstream> {
  const requests: ReceivedRequest[] = [];
  const effectiveHandler = handler ?? echoHandler;

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
      });
    });
    effectiveHandler(req, res);
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      resolve({
        server,
        port,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * Creates a mock upstream that delays responding by the given ms.
 */
export function createSlowUpstream(
  port: number,
  delayMs: number
): Promise<MockUpstream> {
  return createMockUpstream(port, (req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ slow: true, delay: delayMs }));
    }, delayMs);
  });
}
