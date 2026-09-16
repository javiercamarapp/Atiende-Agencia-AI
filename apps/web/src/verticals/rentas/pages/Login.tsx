// Pantalla real de login del panel de rentas — mismo mecanismo que
// verticals/hoteles/pages/Login.tsx (email+password contra el JWT propio de
// @atiende/core-auth, ver diseño Fase 1 rentas §5), pero con su propia sesión de
// storage y su propio landing path (rentas/lib/auth-client.ts) para no chocar con una
// sesión de hoteles/restaurantes abierta en el mismo navegador. Real, no un stub:
// maneja error real, loading real, y redirección real según cuántas organizaciones
// (empresas gestoras/anfitriones) tiene el staff.
//
// Capa visual (ronda de portado del sistema de diseño real, ver
// apps/web/src/pages/login.css): reemplaza el <form> con estilos inline mínimos por
// la lámina partida real compartida con el resto de verticales -- MISMA lógica de
// negocio de arriba, cero cambios de comportamiento. El botón "Continuar con Google"
// es deliberadamente honesto: no existe todavía un endpoint de OAuth de Google en
// apps/api para este vertical (se revisó antes de escribir este archivo), así que el
// botón queda visible pero inerte (aria-disabled + toast) en vez de simular un login
// que no funciona -- mismo criterio que BotonChatDatos.tsx.
import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { AtiendeWordmark, toast } from "@atiende/ui";
import { decideRentasLandingPath, login, LoginError, persistRentasSession } from "../lib/auth-client.ts";
import type { LoginSession } from "../lib/auth-client.ts";
import "../../../pages/login.css";

export interface RentasLoginPageProps {
  readonly apiBaseUrl: string;
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
}

function avisoGoogleNoConfigurado() {
  toast("Google: pendiente de configurar en este entorno", {
    description: "El inicio de sesión con Google todavía no tiene un backend de OAuth real en atiende rentas.",
  });
}

export function RentasLoginPage({ apiBaseUrl, onLoggedIn }: RentasLoginPageProps) {
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
      persistRentasSession(window.localStorage, session);
      onLoggedIn(session, decideRentasLandingPath(session));
    } catch (err) {
      setError(err instanceof LoginError ? err.message : "Ocurrió un error inesperado. Intenta de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login min-h-screen w-full flex flex-col md:flex-row">
      {/* Columna izquierda: formulario real */}
      <div className="w-full md:w-[46%] flex flex-col justify-center px-6 sm:px-10 lg:px-16 py-12">
        <div className="mx-auto w-full max-w-sm flex flex-col gap-7">
          <div className="login-entra" style={{ animationDelay: "0s" }}>
            <AtiendeWordmark className="h-7 w-auto" />
          </div>

          <div className="login-entra flex flex-col gap-2" style={{ animationDelay: "0.05s" }}>
            <span className="login-kicker">Acceso al panel</span>
            <h1 className="login-serif text-foreground text-[32px] sm:text-[38px]">Bienvenido a atiende rentas</h1>
            <p className="text-[14px] text-muted-foreground leading-snug">
              Entra con tu correo y contraseña para gestionar calendarios, precios y mensajería de tus propiedades.
            </p>
          </div>

          <form onSubmit={handleSubmit} noValidate className="login-entra flex flex-col gap-3" style={{ animationDelay: "0.1s" }}>
            <label htmlFor="email" className="flex flex-col gap-1.5 text-[13px] font-medium text-foreground">
              Correo
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="login-campo"
              />
            </label>
            <label htmlFor="password" className="flex flex-col gap-1.5 text-[13px] font-medium text-foreground">
              Contraseña
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="login-campo"
              />
            </label>

            {error && (
              <p role="alert" className="text-[13px] text-destructive m-0">
                {error}
              </p>
            )}

            <button type="submit" disabled={submitting} className="login-btn login-btn-tinta mt-1">
              {submitting ? "Entrando…" : "Entrar"}
              <svg className="login-glifo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </form>

          <div className="login-entra flex flex-col gap-3" style={{ animationDelay: "0.15s" }}>
            <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
              o
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
            </div>
            <button
              type="button"
              aria-disabled="true"
              title="Google: pendiente de configurar en este entorno."
              onClick={avisoGoogleNoConfigurado}
              className="login-btn login-btn-borde opacity-70"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0" aria-hidden="true">
                <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.54-5.17 3.54-8.87z" />
                <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3c-1.07.72-2.45 1.15-4.05 1.15-3.11 0-5.75-2.1-6.69-4.93H1.3v3.09A12 12 0 0 0 12 24z" />
                <path fill="#FBBC05" d="M5.31 14.31A7.2 7.2 0 0 1 4.93 12c0-.8.14-1.58.38-2.31V6.6H1.3A12 12 0 0 0 0 12c0 1.94.46 3.77 1.3 5.4z" />
                <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44C17.94 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.3 6.6l4.01 3.09C6.25 6.85 8.89 4.75 12 4.75z" />
              </svg>
              Continuar con Google
              <span className="login-glifo" />
            </button>
          </div>

          <p className="login-entra text-center text-[13px] text-muted-foreground m-0" style={{ animationDelay: "0.2s" }}>
            ¿No tienes cuenta?{" "}
            <Link to="/rentas/registro" className="text-foreground font-medium underline underline-offset-2">
              Créala aquí
            </Link>
          </p>
        </div>
      </div>

      {/* Columna derecha: lámina con foto real (Ken Burns) -- oculta en mobile */}
      <aside className="login-lamina hidden md:block md:w-[54%] relative m-3 rounded-[22px] overflow-hidden">
        <img src="/images/login-hero.png" alt="" className="login-foto-marca absolute inset-0 h-full w-full object-cover" />
        <div className="login-velo" />
        <div className="absolute inset-x-0 bottom-0 p-10 lg:p-14 text-white">
          <p className="login-kicker text-white/70 mb-3">Operación multi-propiedad</p>
          <p className="login-serif text-2xl lg:text-3xl leading-snug max-w-md">
            Calendarios de varias unidades, sincronía con Booking, Airbnb y Vrbo, y toda tu operación de rentas vacacionales en un solo panel.
          </p>
        </div>
      </aside>
    </div>
  );
}
