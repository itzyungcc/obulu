import { Link } from "react-router-dom";

export function formatKickoff(kickoff) {
  const d = new Date(kickoff);
  if (Number.isNaN(d.getTime())) return { date: kickoff, time: "" };
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
  return { date, time };
}

function TeamBadge({ team }) {
  return (
    <span className="team-badge">
      {team.logo ? (
        <img src={team.logo} alt={`${team.name} logo`} width="28" height="28" />
      ) : null}
      <span className="team-name">{team.name}</span>
    </span>
  );
}

export default function MatchCard({ fixture }) {
  const { home, away, league, kickoff, venue, status } = fixture;
  const { date, time } = formatKickoff(kickoff);
  return (
    <article className="card match-card">
      <p className="match-league">
        {league?.name}
        {league?.country ? ` · ${league.country}` : ""}
      </p>
      <div className="match-teams">
        <TeamBadge team={home} />
        <span className="match-vs">vs</span>
        <TeamBadge team={away} />
      </div>
      <p className="match-kickoff">
        {date}
        {time ? (
          <>
            {" · "}
            <time dateTime={kickoff}>{time}</time>
          </>
        ) : null}
        {venue ? ` · ${venue}` : ""}
        {status ? ` · ${status}` : ""}
      </p>
      <Link className="btn btn-primary match-link" to={`/match/${fixture.id}`}>
        View analysis
      </Link>
    </article>
  );
}
