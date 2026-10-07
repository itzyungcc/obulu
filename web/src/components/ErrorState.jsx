export default function ErrorState({ error, onRetry }) {
  const code = error?.code;
  const message = error?.message || "Something went wrong while loading this page.";

  return (
    <div className="card error-card" role="alert">
      <h2>Couldn't load this</h2>
      <p>{message}</p>
      {code === "DATA_PROVIDER_NOT_CONFIGURED" && (
        <p className="hint">
          The OBULU server doesn't have a football data provider configured yet.
          If you run the server yourself, add your data provider credentials to
          the server configuration and restart it, then try again.
        </p>
      )}
      {code === "NETWORK_ERROR" &&
        (String(message).includes("waking up") ? (
          <p className="hint">
            The free server sleeps when idle and can take up to a minute to
            wake. It usually connects on its own — otherwise tap Try again.
          </p>
        ) : (
          <p className="hint">
            Make sure the API server is running (dev default:{" "}
            <code>http://localhost:3001</code>) and reachable from this device.
          </p>
        ))}
      {onRetry && (
        <button className="btn btn-secondary" type="button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
