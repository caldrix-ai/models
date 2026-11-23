// The e2e server's port: models.js's own (caldrix-js's is 4173, aerix-js's 4183), unless
// MODELS_JS_E2E_PORT names another (Bazel's launcher does, so that two runs never bind the same one).
// Read by playwright.config.ts.
type Env = Record<string, string | undefined>;

export function e2ePort(env: Env): number {
  const raw = env.MODELS_JS_E2E_PORT;
  if (raw === undefined || raw === "") return 4193;
  const port = /^[0-9]+$/.test(raw) ? Number(raw) : 0;
  if (port < 1 || port > 65535) throw new Error(`MODELS_JS_E2E_PORT must be a port number (1-65535), got ${JSON.stringify(raw)}`);
  return port;
}

export const PORT = e2ePort(process.env);
