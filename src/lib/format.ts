// Numeric / date formatting helpers used across the terminal UI.

export function fmtUsd(v: number | undefined | null, digits = 2): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function fmtSignedUsd(v: number | undefined | null, digits = 2): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "—";
  const s = fmtUsd(Math.abs(v), digits);
  return v > 0 ? `+${s}` : v < 0 ? `-${s}` : s;
}

/** price in cents notation, e.g. 0.515 -> "51.5¢" */
export function fmtCents(v: number | undefined | null, digits = 1): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(digits)}¢`;
}

export function fmtPct(v: number | undefined | null, digits = 1): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtSignedPct(v: number | undefined | null, digits = 1): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "—";
  const s = `${(Math.abs(v) * 100).toFixed(digits)}%`;
  return v > 0 ? `+${s}` : v < 0 ? `-${s}` : s;
}

export function fmtNum(v: number | undefined | null, digits = 0): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function shortAddr(addr: string | undefined | null): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function fmtTime(ts: number | undefined | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function fmtDateTime(ts: number | string | undefined | null): string {
  if (!ts) return "—";
  const d = typeof ts === "string" ? new Date(ts) : new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** e.g. "2d 4h", "3h 12m", "42m" — time until a close date */
export function fmtTimeUntil(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  let ms = t - now;
  if (ms <= 0) return "closed";
  const mins = Math.floor(ms / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rem = mins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rem}m`;
  return `${rem}m`;
}

export function fmtAgo(ts: number | undefined | null, now = Date.now()): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
