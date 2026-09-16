// Pantalla real de login del panel de citas — mismo mecanismo que
// verticals/hoteles/pages/Login.tsx (email+password contra el JWT propio de
// @atiende/core-auth), con su propia sesión de storage y su propio landing path
// (citas/lib/auth-client.ts) para no chocar con una sesión de restaurantes/hoteles
// abierta en el mismo navegador. Real, no un stub: maneja error real, loading real,
// y redirección real según cuántas organizaciones (negocios de citas) tiene el
// staff.
//
// Presentación real (Fase de diseño): mismo layout de dos columnas que
// apps/web/src/pages/Login.tsx (atiende-hoteles) — login.css compartido
// (kicker mono, titular serif, píldoras, lámina con foto + Ken Burns). El botón
// "Continuar con Google" de abajo es el de INICIO DE SESIÓN de staff (distinto
// de la sincronización con Google Calendar de citas, que ya es real en
// apps/api/src/routes/verticals/citas/google-calendar-*.ts): ese endpoint de
// OAuth para login de staff todavía no existe en fusion, así que el botón se dejar
// honestamente deshabilitado (aria-disabled + title) en vez de fingir un login que
// no puede completarse.
import { useState } from "react";
import type { FormEvent } from "react";
import { AtiendeMark, AtiendeWordmark, toast } from "@atiende/ui";
import { decideCitasLandingPath, login, LoginError, persistCitasSession } from "../lib/auth-client.ts";
import type { LoginSession } from "../lib/auth-client.ts";
import "../../../pages/login.css";

export interface CitasLoginPageProps {
  readonly apiBaseUrl: string;
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
}

const GOOGLE_DESHABILITADO_TITULO = "Google: pendiente de configurar en este entorno.";

export function CitasLoginPage({ apiBaseUrl, onLoggedIn }: CitasLoginPageProps) {
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
      persistCitasSession(window.localStorage, session);
      onLoggedIn(session, decideCitasLandingPath(session));
    } catch (err) {
      setError(err instanceof LoginError ? err.message : "Ocurrió un error inesperado. Intenta de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleGoogleClick() {
    toast("Continuar con Google todavía no está disponible", {
      description: GOOGLE_DESHABILITADO_TITULO,
    });
  }

  return (
    <main className="login min-h-screen lg:grid lg:grid-cols-2">
      <section className="flex min-h-screen flex-col px-6 py-7 sm:px-10 lg:px-14 lg:py-10">
        <div className="mx-auto flex w-full max-w-[392px] flex-1 flex-col">
          <header className="login-entra flex items-center">
            <AtiendeWordmark />
          </header>

          <div className="flex flex-1 items-center py-12">
            <div className="w-full">
              <p className="login-entra login-kicker" style={{ animationDelay: "40ms" }}>
                Acceso al panel
              </p>
              <h1 className="login-entra login-serif mt-5 text-[38px] sm:text-[44px] text-foreground" style={{ animationDelay: "90ms" }}>
                Bienvenido a atiende citas
              </h1>
              <p className="login-entra mt-4 text-[15px] leading-[1.6] text-muted-foreground" style={{ animationDelay: "140ms" }}>
                El panel de operación de tu negocio de citas.
              </p>

              {error && (
                <div role="alert" className="login-entra mt-9 rounded-[18px] p-5 bg-destructive/5 border border-destructive/30" style={{ animationDelay: "180ms" }}>
                  <p className="text-[14px] leading-relaxed text-foreground">{error}</p>
                </div>
              )}

              <form onSubmit={handleSubmit} className="login-entra mt-9 flex flex-col gap-3" style={{ animationDelay: "220ms" }} noValidate>
                <label htmlFor="citas-login-email" className="sr-only">
                  Tu correo
                </label>
                <input
                  id="citas-login-email"
                  type="email"
                  required
                  placeholder="tu@negocio.com"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="login-campo"
                />
                <label htmlFor="citas-login-password" className="sr-only">
                  Contraseña
                </label>
                <input
                  id="citas-login-password"
                  type="password"
                  required
                  placeholder="Contraseña"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="login-campo"
                />
                <button type="submit" disabled={submitting} className="login-btn login-btn-tinta mt-1">
                  <span aria-hidden className="login-glifo">
                    <AtiendeMark className="h-[17px] w-auto brightness-0 invert" />
                  </span>
                  <span>{submitting ? "Entrando…" : "Entrar"}</span>
                </button>
              </form>

              <div className="login-entra my-6 flex items-center gap-4" style={{ animationDelay: "250ms" }}>
                <span className="h-px flex-1 bg-border" />
                <span className="text-[13px] lowercase text-muted-foreground">o</span>
                <span className="h-px flex-1 bg-border" />
              </div>

              <button
                type="button"
                onClick={handleGoogleClick}
                aria-disabled="true"
                title={GOOGLE_DESHABILITADO_TITULO}
                className="login-entra login-btn login-btn-borde opacity-60"
                style={{ animationDelay: "280ms" }}
              >
                <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
                  <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z" />
                  <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
                  <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
                  <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
                </svg>
                Continuar con Google
              </button>
              <p className="login-entra mt-2 text-[12px] leading-relaxed text-muted-foreground" style={{ animationDelay: "300ms" }}>
                {GOOGLE_DESHABILITADO_TITULO}
              </p>

              <p className="login-entra mt-7 text-pretty text-[14px] leading-relaxed text-muted-foreground" style={{ animationDelay: "320ms" }}>
                ¿No tienes acceso?{" "}
                <span className="font-semibold text-foreground">Pídele a quien administra tu negocio que te dé de alta.</span>
              </p>
            </div>
          </div>
        </div>
      </section>

      <aside className="hidden lg:flex lg:flex-col lg:py-10 lg:pl-6 lg:pr-10">
        <figure className="login-lamina min-h-0 flex-1 flex items-end">
          <img
            src={`${import.meta.env.BASE_URL}images/login-hero.png`}
            alt="Espacio de recepción iluminado en la hora azul."
            className="login-foto-marca absolute inset-0 w-full h-full object-cover"
          />
          <div className="login-velo" />
          <figcaption className="p-9 z-10">
            <p className="login-kicker" style={{ color: "color-mix(in srgb, white 78%, transparent)" }}>
              Citas y turnos por WhatsApp
            </p>
            <p className="login-serif mt-3.5 text-white" style={{ fontSize: "clamp(20px, 1.9vw, 27px)" }}>
              Reservas sincronizadas con Google Calendar.
              <br />
              Sin dobles citas, sin agenda perdida.
            </p>
          </figcaption>
        </figure>
      </aside>
    </main>
  );
}
