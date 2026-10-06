/**
 * Tiny hand-rolled SVG donut for goal distribution (scored vs conceded).
 * No chart library.
 */
export default function Donut({ scored = 0, conceded = 0, size = 104 }) {
  const total = scored + conceded;
  const R = 40;
  const C = 2 * Math.PI * R;
  const seg = total > 0 ? (scored / total) * C : 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className="donut"
      role="img"
      aria-label={`Goals scored ${scored}, conceded ${conceded}`}
    >
      <circle cx="50" cy="50" r={R} fill="none" stroke="#E9E2D8" strokeWidth="16" />
      <circle
        cx="50"
        cy="50"
        r={R}
        fill="none"
        stroke="#0E7A3D"
        strokeWidth="16"
        strokeDasharray={`${seg} ${C - seg}`}
        transform="rotate(-90 50 50)"
      />
      <text x="50" y="47" textAnchor="middle" className="donut-num">
        {scored}
      </text>
      <text x="50" y="63" textAnchor="middle" className="donut-sub">
        scored
      </text>
    </svg>
  );
}
