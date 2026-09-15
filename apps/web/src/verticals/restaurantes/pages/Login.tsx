// Pantalla real de login del panel de restaurantes — reemplaza el formulario de
// magic-link + "Continuar con Google" de restaurantes/src/pages/AdminLogin.tsx por un
// formulario simple email+password contra el JWT propio de @atiende/core-auth (ver
// diseño Fase 1 §5). El Supabase de producción de restaurantes ya fue borrado, así
// que no hay usuarios reales de OAuth/magic-link que preservar.
//
// Fase 1 es sobre todo backend/dominio (ver el brief) — este componente es real, no
// un stub (maneja error real, loading real, redirección real según cuántas
// organizaciones tiene el staff), pero deliberadamente NO porta el resto del
// dashboard visual (AtiendeMark/login.css/lámina con foto, que hoy tampoco existen
// todavía en apps/web/src/shell — ver ese README).
import { useState } from "react";
import type { FormEvent } from "react";
import { decideLandingPath, login, LoginError, persistSession } from "../../../lib/auth-client.ts";
import type { LoginSession } from "../../../lib/auth-client.ts";
import { useDocumentTitle } from "../../../shell/use-document-title.ts";

export interface LoginPageProps {
  readonly apiBaseUrl: string;
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
}

export function RestaurantesLoginPage({ apiBaseUrl, onLoggedIn }: LoginPageProps) {
  // Hallazgo de auditoría (severidad MEDIA/BRANDING, "Título de pestaña fijo en
  // 'Restaurantes' para las 6 verticales") — ver use-document-title.ts. Sin sesión
  // todavía, así que sin orgSlug.
  useDocumentTitle("Restaurantes");
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
      persistSession(window.localStorage, session);
      onLoggedIn(session, decideLandingPath(session));
    } catch (err) {
      setError(err instanceof LoginError ? err.message : "Ocurrió un error inesperado. Intenta de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif" }}>
      <form onSubmit={handleSubmit} style={{ width: "min(360px, 90vw)", display: "flex", flexDirection: "column", gap: 12 }} noValidate>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Entrar a tu restaurante</h1>
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
