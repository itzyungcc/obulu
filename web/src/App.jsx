import { useEffect } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import Header from "./components/Header.jsx";
import Footer from "./components/Footer.jsx";
import RoseBackground from "./components/RoseBackground.jsx";
import Home from "./pages/Home.jsx";
import Upcoming from "./pages/Upcoming.jsx";
import Search from "./pages/Search.jsx";
import Leagues from "./pages/Leagues.jsx";
import MatchAnalysis from "./pages/MatchAnalysis.jsx";
import About from "./pages/About.jsx";

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
      <RoseBackground />
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
          <Route path="*" element={<Home />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}
