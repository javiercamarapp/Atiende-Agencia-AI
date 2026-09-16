// Pantalla real de login del panel de licitaciones — mismo mecanismo que
// verticals/hoteles/pages/Login.tsx y verticals/restaurantes/pages/Login.tsx
// (email+password contra el JWT propio de @atiende/core-auth, ver diseño
// Fase 1 licitaciones §5), con su propia sesión de storage y su propio
// landing path (licitaciones/lib/auth-client.ts) para no chocar con una
// sesión de otra vertical abierta en el mismo navegador. Real, no un stub:
// maneja error real, loading real, y redirección real según cuántas
// organizaciones tiene el staff.
//
// Fase "sistema de diseño real" — reemplaza el formulario inline mínimo por
// la lámina split-screen real (apps/web/src/pages/login.css, ya portada
// byte-a-byte de atiende-restaurantes) y el logo real (AtiendeMark/
// AtiendeWordmark de @atiende/ui) en vez del data-URI duplicado de
// lib/brand.ts. Cero cambios de lógica: mismo estado, misma llamada a
// login()/persistLicitacionesSession()/decideLicitacionesLandingPath(), mismo
// manejo de error/loading.
import { useEffect, useState } from "react";
import type { FormEvent, MouseEvent } from "react";
import { AtiendeMark, AtiendeWordmark, toast } from "@atiende/ui";
import { decideLicitacionesLandingPath, login, LoginError, persistLicitacionesSession } from "../lib/auth-client.ts";
import type { LoginSession } from "../lib/auth-client.ts";
import { LICITACIONES_TAB_TITLE } from "../lib/brand.ts";
import "../../../pages/login.css";

export interface LicitacionesLoginPageProps {
  readonly apiBaseUrl: string;
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
}

export function LicitacionesLoginPage({ apiBaseUrl, onLoggedIn }: LicitacionesLoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hallazgo de auditoría ("título de pestaña fijo en 'Restaurantes'") — ver
  // el comentario de `LICITACIONES_TAB_TITLE` en lib/brand.ts.
  useEffect(() => {
    document.title = LICITACIONES_TAB_TITLE;
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = await login(fetch, apiBaseUrl, email, password);
      persistLicitacionesSession(window.localStorage, session);
      onLoggedIn(session, decideLicitacionesLandingPath(session));
    } catch (err) {
      setError(err instanceof LoginError ? err.message : "Ocurrió un error inesperado. Intenta de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  // "Continuar con Google" real de OAuth no existe todavía en fusion (se está
  // construyendo aparte) — se deja visible y honestamente deshabilitado, con
  // un toast en vez de simular un fetch a un endpoint que no existe. Mismo
  // criterio que BotonChatDatos.tsx.
  function handleGoogleClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    toast("Continuar con Google todavía no está disponible", {
      description: "El inicio de sesión con Google para licitaciones está pendiente de configurar en este entorno; usa tu correo y contraseña.",
    });
  }

  return (
    <div className="login grid min-h-screen lg:grid-cols-2">
      <main className="flex items-center justify-center px-6 py-16 sm:px-10 lg:px-16 bg-background">
        <form onSubmit={handleSubmit} noValidate className="w-full max-w-[380px] flex flex-col gap-7">
          <div className="login-entra" style={{ animationDelay: "0ms" }}>
            <AtiendeWordmark className="h-7 w-auto" />
          </div>

          <div className="login-entra flex flex-col gap-2" style={{ animationDelay: "70ms" }}>
            <p className="login-kicker">Acceso al panel</p>
            <h1 className="login-serif text-[32px] sm:text-[36px] text-foreground">Bienvenido a atiende licitaciones</h1>
            <p className="text-[14px] text-muted-foreground leading-relaxed">
              Da seguimiento a cada convocatoria pública, evalúa tu matching y no pierdas ninguna fecha límite de presentación.
            </p>
          </div>

          <div className="login-entra flex flex-col gap-3" style={{ animationDelay: "140ms" }}>
            <label htmlFor="email" className="flex flex-col gap-1.5 text-[13px] font-medium text-foreground">
              Correo
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="tu@empresa.com"
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
                placeholder="••••••••"
                className="login-campo"
              />
            </label>

            {error && (
              <p role="alert" className="text-[13px] text-destructive">
                {error}
              </p>
            )}

            <button type="submit" disabled={submitting} className="login-btn login-btn-tinta">
              {submitting ? "Entrando…" : "Entrar"}
              <span className="login-glifo" aria-hidden="true">
                →
              </span>
            </button>
          </div>

          <div className="login-entra flex flex-col gap-3" style={{ animationDelay: "210ms" }}>
            <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              <span className="h-px flex-1 bg-border" />o<span className="h-px flex-1 bg-border" />
            </div>
            <button
              type="button"
              aria-disabled="true"
              title="Google: pendiente de configurar en este entorno."
              onClick={handleGoogleClick}
              className="login-btn login-btn-borde opacity-60 hover:opacity-60"
            >
              Continuar con Google
              <span className="login-glifo" aria-hidden="true">
                G
              </span>
            </button>
          </div>
        </form>
      </main>

      <aside className="login-lamina hidden lg:block relative m-3">
        <img src="/images/login-hero.png" alt="" className="login-foto-marca absolute inset-0 h-full w-full object-cover" />
        <div className="login-velo" />
        <div className="relative z-10 flex h-full flex-col justify-end p-10">
          <AtiendeMark className="h-8 w-auto mb-6" />
          <p className="login-serif text-white text-[26px] leading-tight max-w-md">
            Convocatorias públicas rastreadas, evaluadas y respondidas a tiempo.
          </p>
          <p className="text-white/70 text-[13px] mt-3 max-w-sm leading-relaxed">
            Matching automático contra tu perfil, checklist de integridad documental y control de cada fecha límite, en un solo panel.
          </p>
        </div>
      </aside>
    </div>
  );
}
