/** Runtime, doctor and configuration output share one policy without opening a database. */
export function readMcpCachePolicy(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 必须为 ${min}–${max} 的整数。`);
    return value;
  };
  return { ttlHours: integer("RESUME_LIFE_MCP_CACHE_TTL_HOURS", 168, 1, 8760),
    maxBytes: integer("RESUME_LIFE_MCP_CACHE_MAX_BYTES", 256 * 1024 * 1024, 1024 * 1024, 4 * 1024 * 1024 * 1024), orphanGraceHours: 1, maxEntries: 10_000 };
}
