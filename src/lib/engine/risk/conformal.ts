export interface ConformalInterval {
  n: number;
  alpha: number;
  point: number;
  radius: number;
  lower: number;
  upper: number;
  confidence: number;
  sampleReady: boolean;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round(n: number, places = 4): number {
  return Number(n.toFixed(places));
}

export function conformalInterval(
  samples: number[],
  pointPrediction = samples.length
    ? samples.reduce((sum, n) => sum + n, 0) / samples.length
    : 0,
  alpha = 0.1,
): ConformalInterval {
  const clean = samples.filter((n) => Number.isFinite(n));
  if (!clean.length) {
    return {
      n: 0,
      alpha,
      point: round(pointPrediction),
      radius: 0,
      lower: round(pointPrediction),
      upper: round(pointPrediction),
      confidence: 0,
      sampleReady: false,
    };
  }
  const residuals = clean
    .map((n) => Math.abs(n - pointPrediction))
    .sort((a, b) => a - b);
  const qIndex = Math.min(
    residuals.length - 1,
    Math.ceil((residuals.length + 1) * (1 - alpha)) - 1,
  );
  const radius = residuals[Math.max(0, qIndex)] ?? 0;
  const confidence = clamp(Math.sqrt(clean.length / 60), 0, 1);
  return {
    n: clean.length,
    alpha,
    point: round(pointPrediction),
    radius: round(radius),
    lower: round(pointPrediction - radius),
    upper: round(pointPrediction + radius),
    confidence: round(confidence),
    sampleReady: clean.length >= 12,
  };
}

export function conformalEdgePass(
  samples: number[],
  requiredEdge = 0,
  alpha = 0.1,
): { allow: boolean; interval: ConformalInterval; reason: string } {
  const point = samples.length ? samples.reduce((sum, n) => sum + n, 0) / samples.length : 0;
  const interval = conformalInterval(samples, point, alpha);
  if (!interval.sampleReady) {
    return {
      allow: true,
      interval,
      reason: `conformal shadow-only: ${interval.n} samples`,
    };
  }
  const allow = interval.lower > requiredEdge;
  return {
    allow,
    interval,
    reason: allow
      ? `conformal lower ${(interval.lower * 100).toFixed(2)}c clears ${(requiredEdge * 100).toFixed(2)}c`
      : `conformal lower ${(interval.lower * 100).toFixed(2)}c does not clear ${(requiredEdge * 100).toFixed(2)}c`,
  };
}
