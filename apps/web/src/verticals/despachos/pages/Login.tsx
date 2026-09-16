// Pantalla real de login del panel de despachos — mismo mecanismo que
// verticals/hoteles/pages/Login.tsx y verticals/restaurantes/pages/Login.tsx
// (email+password contra el JWT propio de @atiende/core-auth), con su propia sesión
// de storage y su propio landing path (despachos/lib/auth-client.ts) para no chocar
// con una sesión de otro vertical abierta en el mismo navegador. Real, no un stub:
// maneja error real, loading real, y redirección real según cuántas organizaciones
// (despachos) tiene el staff.
//
// Presentación — puerto de la lámina de login real y compartida (ver
// ../../../pages/login.css: kicker mono, titular serif, píldoras de 999px, lámina
// con foto y Ken Burns, entrada escalonada) ya usada por el login del shell
// principal. Solo se reemplaza el JSX/CSS de presentación: la lógica de arriba
// (handleSubmit/login/persistDespachosSession/decideDespachosLandingPath) no
// cambia una sola línea.
import { useState } from "react";
import type { FormEvent } from "react";
import { ArrowRight } from "lucide-react";
import { AtiendeWordmark, toast } from "@atiende/ui";
import { decideDespachosLandingPath, login, LoginError, persistDespachosSession } from "../lib/auth-client.ts";
import type { LoginSession } from "../lib/auth-client.ts";
import "../../../pages/login.css";

export interface DespachosLoginPageProps {
  readonly apiBaseUrl: string;
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
}

/** Ícono "G" de Google — lucide-react no trae logos de marca, así que se porta
 * inline el glifo de 4 colores estándar de Google (solo presentación, no un
 * botón funcional: ver el aviso honesto más abajo). */
function GoogleGlifo() {
  return (
    <svg viewBox="0 0 18 18" className="w-4 h-4 shrink-0" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.85 2.09-1.8 2.73v2.27h2.92c1.71-1.57 2.68-3.88 2.68-6.64z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.17l-2.92-2.27c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.34C2.44 15.98 5.48 18 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.71A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.71V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.34z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.59-2.59C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.95l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

export function DespachosLoginPage({ apiBaseUrl, onLoggedIn }: DespachosLoginPageProps) {
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
      persistDespachosSession(window.localStorage, session);
      onLoggedIn(session, decideDespachosLandingPath(session));
    } catch (err) {
      setError(err instanceof LoginError ? err.message : "Ocurrió un error inesperado. Intenta de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  // Google OAuth: el backend de fusion todavía no expone el endpoint real
  // (se está construyendo por separado) — se deja el botón visible, en el
  // mismo estilo `login-btn-borde` que el resto del panel, pero honestamente
  // deshabilitado (aria-disabled + title explicando por qué, mismo criterio
  // que BotonChatDatos.tsx). Nunca simula un login que no existe.
  function handleGoogleClick() {
    toast("Continuar con Google todavía no está disponible", {
      description: "El proveedor OAuth de Google está en configuración; por ahora entra con tu correo y contraseña.",
    });
  }

  return (
    <main className="login flex min-h-screen">
      <div className="flex-1 flex items-center justify-center px-6 py-12 sm:px-10">
        <div className="w-full max-w-sm">
          <div className="login-entra" style={{ animationDelay: "0ms" }}>
            <AtiendeWordmark className="mb-10" />
          </div>

          <div className="login-entra mb-8" style={{ animationDelay: "70ms" }}>
            <p className="login-kicker mb-3">Acceso al panel</p>
            <h1 className="login-serif text-3xl sm:text-4xl text-foreground">Bienvenido a atiende despachos</h1>
          </div>

          <form onSubmit={handleSubmit} className="login-entra flex flex-col gap-3" style={{ animationDelay: "140ms" }} noValidate>
            <label htmlFor="email" className="sr-only">
              Correo
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="tu@despacho.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="login-campo"
            />
            <label htmlFor="password" className="sr-only">
              Contraseña
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="Contraseña"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="login-campo"
            />

            {error && (
              <p role="alert" className="text-sm text-destructive m-0">
                {error}
              </p>
            )}

            <button type="submit" disabled={submitting} className="login-btn login-btn-tinta mt-1">
              {submitting ? "Entrando…" : "Entrar"}
              <span className="login-glifo">
                <ArrowRight className="w-4 h-4" />
              </span>
            </button>
          </form>

          <div className="login-entra mt-3" style={{ animationDelay: "210ms" }}>
            <button
              type="button"
              aria-disabled="true"
              title="Google: pendiente de configurar en este entorno."
              onClick={handleGoogleClick}
              className="login-btn login-btn-borde opacity-60 hover:opacity-60"
            >
              <GoogleGlifo />
              Continuar con Google
              <span className="login-glifo">
                <ArrowRight className="w-4 h-4" />
              </span>
            </button>
          </div>
        </div>
      </div>

      <aside className="login-lamina hidden lg:flex flex-col flex-1 m-3 ml-0 relative overflow-hidden">
        <img
          src="/images/login-hero.png"
          alt=""
          aria-hidden="true"
          className="login-foto-marca absolute inset-0 h-full w-full object-cover"
        />
        <div className="login-velo" />
        <div className="relative z-10 mt-auto flex flex-col gap-3 p-10 text-white">
          <p className="login-kicker text-white/70">CFDI · Contabilidad electrónica · Cierres mensuales</p>
          <p className="login-serif text-2xl sm:text-[28px] max-w-md text-white">
            Cada CFDI conciliado, cada nómina timbrada y cada cierre mensual cerrado a tiempo, en un solo panel para tu despacho.
          </p>
        </div>
      </aside>
    </main>
  );
}
