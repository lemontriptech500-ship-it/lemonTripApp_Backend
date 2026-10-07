type Entry = { hits: number[]; expiresAt: number };

const windows = new Map<string, Entry>();

// Returns true if the action is allowed, false when the limit is reached.
// Example: rateAllowed(`password:${userId}`, 5, 15 * 60 * 1000) = 5 tries per 15 minutes.
// Counts live in memory: they reset when the server restarts.
export function rateAllowed(key: string, limit: number, periodMs: number) {
  const now = Date.now();
  const hits = (windows.get(key)?.hits ?? []).filter((at) => at > now - periodMs);
  if (hits.length >= limit) {
    windows.set(key, { hits, expiresAt: now + periodMs });
    return false;
  }
  hits.push(now);
  windows.set(key, { hits, expiresAt: now + periodMs });
  if (windows.size > 5000) {
    for (const [storedKey, entry] of windows) {
      if (entry.expiresAt < now) windows.delete(storedKey);
    }
  }
  return true;
}