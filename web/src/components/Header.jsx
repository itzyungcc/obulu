import { useState } from "react";
import { NavLink, Link } from "react-router-dom";
import LogoMark from "./LogoMark.jsx";

const LINKS = [
  { to: "/", label: "Home", end: true },
  { to: "/upcoming", label: "Upcoming Matches" },
  { to: "/search", label: "Search" },
  { to: "/leagues", label: "Leagues" },
  { to: "/about", label: "About OBULU" },
  { to: "/automation", label: "Automation" },
];

export default function Header() {
  const [open, setOpen] = useState(false);

  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link to="/" className="brand" aria-label="OBULU — home">
          <span className="brand-mark" aria-hidden="true">
            <LogoMark size={34} />
          </span>
          <span className="brand-name">OBULU</span>
        </Link>
        <button
          type="button"
          className="nav-toggle"
          aria-expanded={open}
          aria-controls="primary-nav"
          aria-label={open ? "Close navigation menu" : "Open navigation menu"}
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden="true">{open ? "✕" : "☰"}</span>
        </button>
        <nav
          id="primary-nav"
          className={`site-nav${open ? " open" : ""}`}
          aria-label="Primary"
        >
          {LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                isActive ? "nav-link active" : "nav-link"
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}
