/**
 * Unmissable banner shown on any page whose API response contained sampleData:true.
 */
export default function SampleBadge() {
  return (
    <div className="sample-banner" role="note" aria-label="Sample data warning">
      <strong>⚠ SAMPLE DATA</strong>
      <span> — for development only. These figures are placeholders, not live data.</span>
    </div>
  );
}
