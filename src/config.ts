import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { GatewayConfig } from "./types.js";

export function parseConfig(filePath: string): GatewayConfig {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parse(raw) as GatewayConfig;

  if (!parsed.gateway) {
    throw new Error("Missing 'gateway' section in config");
  }
  if (!parsed.routes || !Array.isArray(parsed.routes)) {
    throw new Error("Missing or invalid 'routes' section in config");
  }

  return parsed;
}
