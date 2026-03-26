import { createServer, Server } from "node:http";
import { GatewayConfig } from "./types.js";

export function createGateway(config: GatewayConfig): Server {
  const server = createServer((req, res) => {
    res.writeHead(501);
    res.end("not implemented");
  });

  return server;
}

export function startGateway(
  config: GatewayConfig
): Promise<{ server: Server; close: () => Promise<void> }> {
  const server = createGateway(config);
  return new Promise((resolve) => {
    server.listen(config.gateway.port, () => {
      resolve({
        server,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
