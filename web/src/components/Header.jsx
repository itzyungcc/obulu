import { NavLink, Link } from "react-router-dom";
import LogoMark from "./LogoMark.jsx";

const LINKS = [
  { to: "/", label: "Home", end: true },
  { to: "/upcoming", label: "Upcoming" },
  { to: "/live", label: "Live" },
  { to: "/calendar", label: "Calendar" },
  { to: "/search", label: "Search" },
  { to: "/leagues", label: "Leagues" },
  { to: "/automation", label: "Automation" },
  { to: "/jackpot", label: "Jackpot" },
  { to: "/chat", label: "Assistant" },
  { to: "/about", label: "About" },
];

export default function Header() {
  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link to="/" className="brand" aria-label="OBULU — home">
          <span className="brand-mark" aria-hidden="true">
            <LogoMark size={34} />
          </span>
          <span className="brand-name">OBULU</span>
        </Link>
        <nav className="site-nav" aria-label="Primary">
          {LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
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
