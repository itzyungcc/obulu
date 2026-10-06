/**
 * Dual progress bars comparing one stat across the two teams.
 */
export default function StatBar({
  label,
  homeValue,
  awayValue,
  homeLabel = "Home",
  awayLabel = "Away",
  format,
}) {
  const h = Number(homeValue) || 0;
  const a = Number(awayValue) || 0;
  const total = h + a;
  const share = total > 0 ? (h / total) * 100 : 50;
  const fmt = format || ((v) => String(Math.round(v * 10) / 10));

  return (
    <div className="stat-bar">
      <div className="stat-bar-top">
        <span className="stat-side">{homeLabel}</span>
        <strong className="stat-label">{label}</strong>
        <span className="stat-side stat-side-right">{awayLabel}</span>
      </div>
      <div
        className="dual-bar"
        role="img"
        aria-label={`${label}: ${homeLabel} ${fmt(h)}, ${awayLabel} ${fmt(a)}`}
      >
        <div className="dual-bar-home" style={{ width: `${share}%` }}>
          <span>{fmt(h)}</span>
        </div>
        <div className="dual-bar-away" style={{ width: `${100 - share}%` }}>
          <span>{fmt(a)}</span>
        </div>
      </div>
    </div>
  );
}
