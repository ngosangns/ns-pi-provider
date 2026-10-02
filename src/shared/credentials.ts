/**
 * Shared credential resolution helpers (env + optional command).
 * Never logs secret values.
 */

export function readEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function firstEnv(names: readonly string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of names) {
    const value = readEnv(name, env);
    if (value) return value;
  }
  return undefined;
}

export function redact(value: string | undefined, keep = 4): string {
  if (!value) return "(empty)";
  if (value.length <= keep * 2) return "***";
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}
