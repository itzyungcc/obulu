export default function Methodology() {
  return (
    <div className="container page">
      <h1>Methodology</h1>

      <section className="card" aria-labelledby="model-heading">
        <h2 id="model-heading">How OBULU analyses a match</h2>
        <p>
          OBULU estimates the likelihood of each match outcome — home win,
          draw, or away win — using a statistical model built on the Poisson
          distribution, extended with the Dixon–Coles adjustment that better
          captures low-scoring football realities. The model does not guess:
          it converts each team's demonstrated scoring behaviour into
          probabilities.
        </p>
        <p>
          For every fixture, the model weighs factors including:
        </p>
        <ul className="factors">
          <li>Recent form across each team's latest matches</li>
          <li>Home and away performance splits</li>
          <li>Head-to-head history between the two sides</li>
          <li>Goals scored and goals conceded</li>
          <li>League position and points</li>
          <li>Overall team strength ratings derived from results</li>
          <li>Available team and player statistics</li>
          <li>Other relevant football data where reliably available</li>
        </ul>
        <p>
          Where bookmaker odds are available, they are blended in as one
          input among many — the statistical model always remains the core
          of every prediction.
        </p>
      </section>

      <section className="card" aria-labelledby="limits-heading">
        <h2 id="limits-heading">What the numbers mean — and don't</h2>
        <p>
          A prediction of 65% for a home win means the model estimates that
          outcome occurs about 65 times in 100 similar situations. It does
          not mean the result is certain, and it is never presented as a
          guarantee. Football is inherently uncertain: red cards, injuries,
          weather, and simple variance all move real matches away from the
          statistical expectation.
        </p>
        <p>
          OBULU also tracks its own predictions against actual results over
          time — the Prediction Calendar records every forecast immutably
          before kickoff, so the model's track record is open to inspection
          rather than claimed.
        </p>
        <p className="disclaimer">
          Predictions are statistical estimates based on available data and
          are not guarantees of match results.
        </p>
      </section>
    </div>
  );
}
