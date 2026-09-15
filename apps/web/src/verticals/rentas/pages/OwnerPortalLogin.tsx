// Login del portal de propietario (Fase 3 backend, UI de esta fase) — cierra el
// hallazgo "el backend de owner-portal.ts existe pero ninguna superficie de apps/web
// lo consume". Mismo patrón visual que verticals/rentas/pages/Login.tsx (el login de
// STAFF), pero llama al endpoint del portal de propietario
// (`POST /rentas/owner-portal/auth/login`, ver lib/owner-portal-client.ts) y persiste
// su propia sesión bajo su propia llave de storage — nunca comparte sesión ni
// endpoint con el login de staff (identidades y JWT/secreto completamente distintos,
// ver la cabecera de owner-portal.ts).
import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { OwnerPortalError, ownerPortalLogin, persistOwnerPortalSession } from "../lib/owner-portal-client.ts";
import type { OwnerPortalSession } from "../lib/owner-portal-client.ts";

export interface OwnerPortalLoginPageProps {
  readonly apiBaseUrl: string;
  readonly onLoggedIn: (session: OwnerPortalSession) => void;
}

export function OwnerPortalLoginPage({ apiBaseUrl, onLoggedIn }: OwnerPortalLoginPageProps) {
  // `state.activada` lo pone OwnerPortalActivarPage tras un set-password exitoso (ver
  // su navigate()) -- puramente informativo, nunca afecta el submit.
  const location = useLocation();
  const activada = Boolean((location.state as { activada?: boolean } | null)?.activada);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = await ownerPortalLogin(fetch, apiBaseUrl, email, password);
      persistOwnerPortalSession(window.localStorage, session);
      onLoggedIn(session);
    } catch (err) {
      setError(err instanceof OwnerPortalError ? err.message : "Ocurrió un error inesperado. Intenta de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif" }}>
      <form onSubmit={handleSubmit} style={{ width: "min(360px, 90vw)", display: "flex", flexDirection: "column", gap: 12 }} noValidate>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Portal de propietario</h1>
        <p style={{ margin: "0 0 4px", fontSize: 13, color: "#6b7280" }}>Consulta tus unidades y tus statements de renta.</p>
        {activada && (
          <p style={{ margin: 0, fontSize: 13, color: "#065f46", background: "#d1fae5", padding: "6px 10px", borderRadius: 8 }}>
            Cuenta activada. Ya puedes iniciar sesión con tu correo y la contraseña que acabas de fijar.
          </p>
        )}
        <label htmlFor="email">
          Correo
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
        <label htmlFor="password">
          Contraseña
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
        {error && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={submitting} style={{ padding: 10, fontWeight: 600 }}>
          {submitting ? "Entrando…" : "Entrar"}
        </button>
        <p style={{ margin: 0, fontSize: 13, color: "#6b7280" }}>
          ¿Recibiste una invitación de tu administrador? <Link to="/rentas/portal-propietario/activar">Activa tu cuenta aquí</Link>.
        </p>
      </form>
    </main>
  );
}
