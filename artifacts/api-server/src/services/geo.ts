/**
 * Where an IP address is. Looked up once per address through ipapi.co
 * (free tier, HTTPS, no key) and cached in memory and in the settings
 * table, so the audit log costs one request per new address, not per row.
 * Private and loopback addresses never leave the box.
 */
import type { Repo } from '../repo.js';

export interface GeoHit {
  city: string;
  region: string;
  country: string;
  org: string;
  /** "Brooklyn, New York, US" */
  label: string;
  at: string;
}

export type GeoLookup = (ip: string) => Promise<Omit<GeoHit, 'at' | 'label'> | null>;

const CACHE_KEY = 'geo.cache';
const NEGATIVE_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 3000;

export function isPrivateIp(ip: string): boolean {
  return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(ip) || ip === 'localhost' || ip === '';
}

export const ipapiLookup: GeoLookup = async (ip) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'greystone-portal/1.0' } });
    if (!res.ok) return null;
    const j = (await res.json()) as { city?: string; region?: string; country_code?: string; org?: string; error?: boolean };
    if (j.error) return null;
    return { city: j.city ?? '', region: j.region ?? '', country: j.country_code ?? '', org: j.org ?? '' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export interface Geo {
  locate(ip: string | null | undefined): Promise<GeoHit | null>;
  /** Resolve many at once (bounded concurrency); returns a map of ip → label. */
  labels(ips: Array<string | null | undefined>): Promise<Map<string, string>>;
  readonly enabled: boolean;
}

export function createGeo(repo: Repo, opts: { lookup?: GeoLookup | null } = {}): Geo {
  const lookup = opts.lookup === undefined ? ipapiLookup : opts.lookup;
  const memory = new Map<string, GeoHit | { miss: true; at: string }>();
  let loaded = false;
  let inflight = new Map<string, Promise<GeoHit | null>>();
  const load = async () => {
    if (loaded) return;
    loaded = true;
    const stored = await repo.getSetting<Record<string, GeoHit>>(CACHE_KEY).catch(() => null);
    if (stored) for (const [ip, hit] of Object.entries(stored)) memory.set(ip, hit);
  };
  const persist = async () => {
    const entries = [...memory.entries()].filter((e): e is [string, GeoHit] => !('miss' in e[1])).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, MAX_ENTRIES);
    await repo.putSetting(CACHE_KEY, Object.fromEntries(entries)).catch(() => undefined);
  };
  const locate = async (raw: string | null | undefined): Promise<GeoHit | null> => {
    const ip = (raw ?? '').trim();
    if (!ip) return null;
    if (isPrivateIp(ip)) return { city: '', region: '', country: '', org: '', label: 'local network', at: new Date().toISOString() };
    if (!lookup) return null;
    await load();
    const cached = memory.get(ip);
    if (cached) {
      if (!('miss' in cached)) return cached;
      if (Date.now() - Date.parse(cached.at) < NEGATIVE_TTL_MS) return null;
    }
    let p = inflight.get(ip);
    if (!p) {
      p = (async () => {
        const r = await lookup(ip);
        if (!r) {
          memory.set(ip, { miss: true, at: new Date().toISOString() });
          return null;
        }
        const hit: GeoHit = { ...r, label: [r.city, r.region, r.country].filter(Boolean).join(', ') || r.org || 'unknown', at: new Date().toISOString() };
        memory.set(ip, hit);
        void persist();
        return hit;
      })().finally(() => inflight.delete(ip));
      inflight.set(ip, p);
    }
    return p;
  };
  return {
    enabled: !!lookup,
    locate,
    async labels(ips) {
      const out = new Map<string, string>();
      const distinct = [...new Set(ips.filter((x): x is string => !!x))];
      let i = 0;
      const worker = async () => {
        while (i < distinct.length) {
          const ip = distinct[i++]!;
          const hit = await locate(ip);
          if (hit) out.set(ip, hit.label);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, distinct.length) }, worker));
      return out;
    },
  };
}
