import { Navigate } from "react-router-dom";
import { useAdmin } from "./AdminContext.jsx";

export default function ProtectedRoute({ children }) {
  const { admin, loading } = useAdmin();
  if (loading) {
    return (
      <div className="admin-loading">
        <p>Checking session…</p>
      </div>
    );
  }
  if (!admin) {
    return <Navigate to="/admin/login" replace />;
  }
  return children;
}
