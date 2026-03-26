import { parseConfig } from "./config.js";
import { startGateway } from "./server.js";

const configPath = process.argv[2] || process.env.GATEWAY_CONFIG;

if (!configPath) {
  console.error("Usage: gatewaykit <config.yaml>");
  console.error("  or set GATEWAY_CONFIG environment variable");
  process.exit(1);
}

try {
  const config = parseConfig(configPath);
  const { server } = await startGateway(config);

  console.log(`GatewayKit listening on port ${config.gateway.port}`);
  console.log(`Routes: ${config.routes.map((r) => r.path).join(", ")}`);

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    server.close(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });
} catch (err) {
  console.error("Failed to start gateway:", (err as Error).message);
  process.exit(1);
}
