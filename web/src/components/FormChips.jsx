/**
 * Recent-form W/D/L chips, most recent first.
 */
export default function FormChips({ results = [] }) {
  if (!results.length) {
    return <p className="muted">No recent results available.</p>;
  }
  return (
    <ul className="form-chips" aria-label="Recent form, most recent first">
      {results.map((r, i) => {
        const k = String(r).toUpperCase();
        const cls =
          k === "W" ? "chip-w" : k === "D" ? "chip-d" : k === "L" ? "chip-l" : "";
        const word = k === "W" ? "win" : k === "D" ? "draw" : k === "L" ? "loss" : k;
        return (
          <li key={i} className={`chip ${cls}`} aria-label={word} title={word}>
            {k}
          </li>
        );
      })}
    </ul>
  );
}
