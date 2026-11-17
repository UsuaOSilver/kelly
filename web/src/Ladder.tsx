import type { Analysis } from "./api";

/** Market's price band (bid–ask) against the model's probability, one column per strike. */
export function Ladder({ a, pick }: { a: Analysis; pick: string | null }) {
  const rows = a.rows.filter((r) => r.bid != null || r.ask != null);
  if (!rows.length) return null;
  // Long ladders (Zcash has 60 strikes) are thinned around the money so the chart stays readable.
  const centre = rows.reduce((best, r, i) => (Math.abs(r.model - 0.5) < Math.abs(rows[best].model - 0.5) ? i : best), 0);
  const from = Math.max(0, Math.min(rows.length - 14, centre - 7));
  const shown = rows.length > 14 ? rows.slice(from, from + 14) : rows;
  const W = 640, H = 250, L = 36, R = 12, T = 14, B = 44;
  const cw = (W - L - R) / shown.length;
  const x = (i: number) => L + cw * (i + 0.5);
  const y = (p: number) => T + (1 - p) * (H - T - B);
  const fmt = (k: number) => (k >= 1000 ? `${+(k / 1000).toFixed(2)}k` : String(k));
  const line = shown.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(r.model).toFixed(1)}`).join(" ");

  return (
    <figure className="ladder">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Market odds versus model for ${a.title}`}>
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <g key={p}>
            <line x1={L} x2={W - R} y1={y(p)} y2={y(p)} className={p === 0.5 ? "grid mid" : "grid"} />
            <text x={L - 6} y={y(p) + 3.5} textAnchor="end" className="tick">{p * 100}%</text>
          </g>
        ))}
        {shown.map((r, i) => {
          const lo = r.bid ?? r.ask!;
          const hi = r.ask ?? r.bid!;
          const picked = r.symbol === pick;
          const bw = Math.min(18, cw * 0.56);
          return (
            <g key={r.symbol}>
              {picked && <rect x={x(i) - cw / 2 + 1} y={T} width={cw - 2} height={H - T - B} className="pickbg" />}
              <rect x={x(i) - bw / 2} y={y(hi)} width={bw} height={Math.max(2, y(lo) - y(hi))} rx="2" className="band">
                <title>{`${r.label}: market ${lo.toFixed(2)}–${hi.toFixed(2)}, model ${(r.model * 100).toFixed(0)}%`}</title>
              </rect>
              <text x={x(i)} y={H - B + 15} textAnchor="middle" className="tick">{fmt(r.strike)}</text>
              {picked && <text x={x(i)} y={H - B + 31} textAnchor="middle" className="picklabel">{r.side === "yes" ? "BUY YES" : "BUY NO"}</text>}
            </g>
          );
        })}
        <path d={line} className="modelline" />
        {shown.map((r, i) => (
          <circle key={r.symbol} cx={x(i)} cy={y(r.model)} r={r.symbol === pick ? 4.5 : 3} className="modeldot" />
        ))}
      </svg>
      <figcaption>
        <span><i className="key band" /> Gemini bid–ask</span>
        <span><i className="key model" /> Kelly's model</span>
        <span className="muted">chance the price finishes above each strike</span>
      </figcaption>
    </figure>
  );
}
