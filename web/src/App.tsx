import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import ProtectedRoute from "./components/ProtectedRoute";
import CandidateProtectedRoute from "./components/CandidateProtectedRoute";
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import PublicJobs from "./pages/PublicJobs";
import PublicJobDetail from "./pages/PublicJobDetail";
import Dashboard from "./pages/Dashboard";
import Jobs from "./pages/Jobs";
import JobDetail from "./pages/JobDetail";
import Candidates from "./pages/Candidates";
import CandidateDetail from "./pages/CandidateDetail";
import Duplicates from "./pages/Duplicates";
import Interviews from "./pages/Interviews";
import NotificationsPage from "./pages/NotificationsPage";
import CandidateLogin from "./pages/CandidateLogin";
import CandidateRegister from "./pages/CandidateRegister";
import CandidateForgotPassword from "./pages/CandidateForgotPassword";
import CandidateResetPassword from "./pages/CandidateResetPassword";
import CandidateDashboard from "./pages/CandidateDashboard";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/public/:orgSlug" element={<PublicJobs />} />
      <Route path="/public/:orgSlug/:jobSlug" element={<PublicJobDetail />} />

      <Route path="/candidate/login" element={<CandidateLogin />} />
      <Route path="/candidate/register" element={<CandidateRegister />} />
      <Route path="/candidate/forgot-password" element={<CandidateForgotPassword />} />
      <Route path="/candidate/reset-password" element={<CandidateResetPassword />} />
      <Route
        path="/candidate/dashboard"
        element={
          <CandidateProtectedRoute>
            <CandidateDashboard />
          </CandidateProtectedRoute>
        }
      />

      <Route
        path="/app"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="jobs" element={<Jobs />} />
        <Route path="jobs/:jobId" element={<JobDetail />} />
        <Route path="candidates" element={<Candidates />} />
        <Route path="candidates/:candidateId" element={<CandidateDetail />} />
        <Route path="duplicates" element={<Duplicates />} />
        <Route path="interviews" element={<Interviews />} />
        <Route path="notifications" element={<NotificationsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
