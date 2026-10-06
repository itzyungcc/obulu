import { Link } from "react-router-dom";

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <p className="footer-brand">
          <span aria-hidden="true">🌹</span> <strong>OBULU</strong> — Football
          Comparison &amp; Prediction
        </p>
        <p className="footer-note">
          Created by Chiakwa Peter —{" "}
          <a href="mailto:chiakwapeter@gmail.com">chiakwapeter@gmail.com</a>
        </p>
        <p className="footer-note">
          Predictions are statistical estimates for informational purposes only.
        </p>
        <p className="footer-note footer-emph">
          Informational tool only — not a betting platform.
        </p>
        <nav className="footer-nav" aria-label="Footer">
          <Link to="/about">About OBULU</Link>
          <span aria-hidden="true"> · </span>
          <Link to="/upcoming">Upcoming Matches</Link>
          <span aria-hidden="true"> · </span>
          <Link to="/leagues">Leagues</Link>
        </nav>
      </div>
    </footer>
  );
}
