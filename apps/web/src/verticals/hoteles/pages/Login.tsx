// Pantalla real de login del panel de hoteles — mismo mecanismo que
// verticals/restaurantes/pages/Login.tsx (email+password contra el JWT propio de
// @atiende/core-auth, ver diseño Fase 1 hoteles §5), pero con su propia sesión de
// storage y su propio landing path (hoteles/lib/auth-client.ts) para no chocar con
// una sesión de restaurantes abierta en el mismo navegador. Real, no un stub: maneja
// error real, loading real, y redirección real según cuántas organizaciones (hoteles)
// tiene el staff — el caso multi-hotel es precisamente el que motivó el diseño de
// `POST /auth/select-org` en core-auth (ver diseño Fase 1 hoteles §5, punto 2).
import { useState } from "react";
import type { FormEvent } from "react";
import { decideHotelesLandingPath, login, LoginError, persistHotelesSession } from "../lib/auth-client.ts";
import type { LoginSession } from "../lib/auth-client.ts";

export interface HotelesLoginPageProps {
  readonly apiBaseUrl: string;
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
}

export function HotelesLoginPage({ apiBaseUrl, onLoggedIn }: HotelesLoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = await login(fetch, apiBaseUrl, email, password);
      persistHotelesSession(window.localStorage, session);
      onLoggedIn(session, decideHotelesLandingPath(session));
    } catch (err) {
      setError(err instanceof LoginError ? err.message : "Ocurrió un error inesperado. Intenta de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif" }}>
      <form onSubmit={handleSubmit} style={{ width: "min(360px, 90vw)", display: "flex", flexDirection: "column", gap: 12 }} noValidate>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Entrar a tu hotel</h1>
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
      </form>
    </main>
  );
}
