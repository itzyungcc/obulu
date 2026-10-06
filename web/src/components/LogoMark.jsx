/**
 * OBULU brand mark — classic gold football on black.
 * Inline SVG so it works everywhere with no asset fetches.
 */
export default function LogoMark({ size = 34 }) {
  const gold = "#c9a227";
  const goldLight = "#e6c76a";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role="img"
      aria-label="OBULU logo"
    >
      <circle cx="20" cy="20" r="17" fill="#0d0d0c" stroke={gold} strokeWidth="2.5" />
      <circle cx="20" cy="20" r="17" fill="none" stroke={goldLight} strokeWidth="0.75" opacity="0.6" />
      {/* central pentagon */}
      <polygon
        points="20,13 26.5,17.7 24,25.3 16,25.3 13.5,17.7"
        fill={gold}
      />
      {/* seams to the edge */}
      <g stroke={gold} strokeWidth="1.6" opacity="0.85">
        <line x1="20" y1="13" x2="20" y2="6" />
        <line x1="26.5" y1="17.7" x2="32.5" y2="15.5" />
        <line x1="24" y1="25.3" x2="28" y2="31" />
        <line x1="16" y1="25.3" x2="12" y2="31" />
        <line x1="13.5" y1="17.7" x2="7.5" y2="15.5" />
      </g>
    </svg>
  );
}
