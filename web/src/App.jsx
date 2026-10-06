import { useEffect } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import Header from "./components/Header.jsx";
import Footer from "./components/Footer.jsx";
import Home from "./pages/Home.jsx";
import Upcoming from "./pages/Upcoming.jsx";
import Search from "./pages/Search.jsx";
import Leagues from "./pages/Leagues.jsx";
import MatchAnalysis from "./pages/MatchAnalysis.jsx";
import About from "./pages/About.jsx";
import Automation from "./pages/Automation.jsx";
import Jackpot from "./pages/Jackpot.jsx";

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <div className="app">
      <Header />
      <main className="main-content">
        <ScrollToTop />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/upcoming" element={<Upcoming />} />
          <Route path="/search" element={<Search />} />
          <Route path="/leagues" element={<Leagues />} />
          <Route path="/match/:id" element={<MatchAnalysis />} />
          <Route path="/about" element={<About />} />
          <Route path="/automation" element={<Automation />} />
          <Route path="/jackpot" element={<Jackpot />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}
