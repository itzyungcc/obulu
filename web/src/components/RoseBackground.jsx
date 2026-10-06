/**
 * Decorative fixed rose line-art overlay.
 * Purely decorative: aria-hidden, pointer-events none, very low opacity,
 * and sits behind all content (z-index 0) so readability is unaffected.
 */
export default function RoseBackground() {
  return <div className="rose-bg" aria-hidden="true" />;
}
