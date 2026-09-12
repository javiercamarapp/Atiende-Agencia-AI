// Shell mínimo de apps/web para esta fase — solo lo necesario para que la pantalla
// de login del vertical restaurantes sea real y navegable, sin portar el resto del
// dashboard visual (fuera de alcance explícito de Fase 1, ver el brief).
import { useNavigate, useParams } from "react-router-dom";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { RestaurantesLoginPage } from "./verticals/restaurantes/pages/Login.tsx";
import { RestaurantesDashboardPage } from "./verticals/restaurantes/pages/Dashboard.tsx";
import { HotelesLoginPage } from "./verticals/hoteles/pages/Login.tsx";
import { RentasLoginPage } from "./verticals/rentas/pages/Login.tsx";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787";

function RestaurantesLoginRoute() {
  const navigate = useNavigate();
  return (
    <RestaurantesLoginPage
      apiBaseUrl={API_BASE_URL}
      onLoggedIn={(_session, landingPath) => navigate(landingPath)}
    />
  );
}

function RestaurantesDashboardRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/restaurantes/login" replace />;
  return (
    <RestaurantesDashboardPage
      apiBaseUrl={API_BASE_URL}
      orgSlug={orgSlug}
      onRequireLogin={() => navigate("/restaurantes/login", { replace: true })}
    />
  );
}

function HotelesLoginRoute() {
  const navigate = useNavigate();
  return (
    <HotelesLoginPage
      apiBaseUrl={API_BASE_URL}
      onLoggedIn={(_session, landingPath) => navigate(landingPath)}
    />
  );
}

function RentasLoginRoute() {
  const navigate = useNavigate();
  return (
    <RentasLoginPage
      apiBaseUrl={API_BASE_URL}
      onLoggedIn={(_session, landingPath) => navigate(landingPath)}
    />
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/restaurantes/login" element={<RestaurantesLoginRoute />} />
        <Route path="/restaurantes/:orgSlug" element={<RestaurantesDashboardRoute />} />
        <Route path="/hoteles/login" element={<HotelesLoginRoute />} />
        <Route path="/rentas/login" element={<RentasLoginRoute />} />
        <Route path="/" element={<Navigate to="/restaurantes/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
