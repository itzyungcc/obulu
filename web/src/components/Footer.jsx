import { Link } from "react-router-dom";

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div className="footer-brand-col">
          <p className="footer-logo">OBULU</p>
          <p className="footer-tagline">
            Football intelligence powered by statistical analysis and
            football data.
          </p>
        </div>
        <nav className="footer-col" aria-label="Product">
          <p className="footer-heading">Product</p>
          <Link to="/upcoming">Predictions</Link>
          <Link to="/search">Match Analysis</Link>
          <Link to="/calendar">Prediction Calendar</Link>
          <Link to="/live">Live Prediction Engine</Link>
        </nav>
        <nav className="footer-col" aria-label="Information">
          <p className="footer-heading">Information</p>
          <Link to="/about">About OBULU</Link>
          <Link to="/methodology">Methodology</Link>
          <Link to="/about#data">Data Sources</Link>
          <Link to="/disclaimer">Disclaimer</Link>
        </nav>
      </div>
      <div className="container footer-bottom">
        <p>© 2026 OBULU. All rights reserved.</p>
      </div>
    </footer>
  );
}
