export default function About() {
  return (
    <div className="container page">
      <h1>About OBULU</h1>

      <section className="card" aria-labelledby="what-heading">
        <h2 id="what-heading">What OBULU is</h2>
        <p>
          OBULU is an informational football comparison and statistical
          prediction platform. It lets you compare teams, explore recent form,
          head-to-head records, league positions and other match statistics,
          and view the statistical likelihood of each match outcome.
        </p>
        <p>
          <strong>
            OBULU is an informational football analysis tool only. It is not a
            betting platform and offers no betting, staking, or gambling
            features.
          </strong>
        </p>
      </section>

      <section className="card" aria-labelledby="how-heading">
        <h2 id="how-heading">How predictions work</h2>
        <p>
          Predictions are made with a statistical model based on the Poisson
          distribution — a standard way to estimate how many goals each team is
          likely to score. In plain terms:
        </p>
        <ul className="factors">
          <li>
            The model looks at how many goals each team scores and concedes on
            average, split into home and away performances.
          </li>
          <li>
            It combines those scoring rates with head-to-head history, recent
            form and league context to estimate the chance of each possible
            scoreline.
          </li>
          <li>
            Adding up the chances of all scorelines where the home team wins,
            where it's a draw, or where the away team wins gives the three
            outcome probabilities.
          </li>
          <li>
            The model also considers market odds where available, purely as one
            input among many.
          </li>
        </ul>
        <p className="disclaimer">Predictions are statistical estimates based on available data and are not guarantees of match results.</p>
      </section>

      <section className="card" aria-labelledby="data-heading">
        <h2 id="data-heading">Data sources</h2>
        <p>
          This build ships with real 2024/25 season data for the Premier
          League, La Liga, Serie A, Bundesliga and Ligue 1 — 98 clubs,
          1,756 matches — bundled on-device, so every comparison and
          prediction runs on genuine results. (The free API-Football plan
          only covers seasons up to 2024, so the current season is not
          included.)
        </p>
      </section>

      <section className="card" aria-labelledby="creator-heading">
        <h2 id="creator-heading">Creator</h2>
        <p>
          OBULU was created by <strong>Chiakwa Peter</strong> —{" "}
          <a href="mailto:chiakwapeter@gmail.com">chiakwapeter@gmail.com</a>
        </p>
      </section>
    </div>
  );
}
