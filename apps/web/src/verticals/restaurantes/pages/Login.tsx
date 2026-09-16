// Pantalla real de login del panel de restaurantes — reemplaza el formulario de
// magic-link + "Continuar con Google" de restaurantes/src/pages/AdminLogin.tsx por un
// formulario simple email+password contra el JWT propio de @atiende/core-auth (ver
// diseño Fase 1 §5). El Supabase de producción de restaurantes ya fue borrado, así
// que no hay usuarios reales de OAuth/magic-link que preservar.
//
// Fase 1 era sobre todo backend/dominio — este componente ya era real, no un stub
// (maneja error real, loading real, redirección real según cuántas organizaciones
// tiene el staff). Esta ronda solo reemplaza la presentación: login.css/AtiendeMark/
// lámina con foto ya existen en apps/web (ver el README de esa fase), y restaurantes
// es justo la vertical ORIGEN de ese sistema de diseño (docs/referencia/
// 05-frontend-restaurantes.md) — 100% del mismo props/lógica de negocio de abajo,
// nada más cambia el JSX/CSS.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { AtiendeWordmark } from "@atiende/ui";
import { decideLandingPath, login, LoginError, persistSession } from "../../../lib/auth-client.ts";
import type { LoginSession } from "../../../lib/auth-client.ts";
import { useDocumentTitle } from "../../../shell/use-document-title.ts";
import { mensajeGoogleError, urlIniciarGoogleLogin, verificarGoogleConfigurado } from "../../../lib/google-auth.ts";
import "../../../pages/login.css";

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
  const [searchParams] = useSearchParams();
  const [googleConfigurado, setGoogleConfigurado] = useState(false);
  const [comprobandoGoogle, setComprobandoGoogle] = useState(true);

  useEffect(() => {
    let vivo = true;
    verificarGoogleConfigurado(apiBaseUrl).then((ok) => {
      if (vivo) {
        setGoogleConfigurado(ok);
        setComprobandoGoogle(false);
      }
    });
    return () => {
      vivo = false;
    };
  }, [apiBaseUrl]);

  const googleError = searchParams.get("google_error");
  const googleHabilitado = googleConfigurado && !comprobandoGoogle;

  function irAGoogle() {
    if (!googleHabilitado) return;
    window.location.href = urlIniciarGoogleLogin(apiBaseUrl, "restaurantes");
  }

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
    <div className="login min-h-screen grid grid-cols-1 md:grid-cols-2">
      <main className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-[380px] flex flex-col gap-6">
          <div className="login-entra" style={{ animationDelay: "0ms" }}>
            <AtiendeWordmark className="h-7 w-auto" />
          </div>

          <div className="login-entra flex flex-col gap-2" style={{ animationDelay: "60ms" }}>
            <p className="login-kicker">Acceso al panel</p>
            <h1 className="login-serif text-[32px] m-0">Bienvenido a atiende restaurantes</h1>
            <p className="m-0 text-sm text-muted-foreground">
              Entra con tu correo y contraseña para ver pedidos, catálogo y sucursales.
            </p>
          </div>

          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-3">
            <div className="login-entra" style={{ animationDelay: "120ms" }}>
              <label htmlFor="email" className="block text-xs text-muted-foreground mb-1.5">
                Correo
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="tu@restaurante.com"
                className="login-campo"
              />
            </div>

            <div className="login-entra" style={{ animationDelay: "160ms" }}>
              <label htmlFor="password" className="block text-xs text-muted-foreground mb-1.5">
                Contraseña
              </label>
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
            </div>

            {googleError && !error && (
              <p role="alert" className="m-0 text-[13px]" style={{ color: "#b91c1c" }}>
                {mensajeGoogleError(googleError)}
              </p>
            )}

            {error && (
              <p role="alert" className="m-0 text-[13px]" style={{ color: "#b91c1c" }}>
                {error}
              </p>
            )}

            <div className="login-entra flex flex-col gap-2.5" style={{ animationDelay: "200ms" }}>
              <button type="submit" disabled={submitting} className="login-btn login-btn-tinta">
                {submitting ? "Entrando…" : "Entrar"}
              </button>

              <button
                type="button"
                onClick={irAGoogle}
                disabled={!googleHabilitado}
                title={!googleHabilitado ? (comprobandoGoogle ? "Comprobando Google…" : "Google: pendiente de configurar en este entorno.") : undefined}
                className="login-btn login-btn-borde"
              >
                <span className="login-glifo" aria-hidden>
                  G
                </span>
                Continuar con Google
              </button>
              {!googleHabilitado && (
                <p className="m-0 text-[12px] leading-relaxed text-muted-foreground">
                  {comprobandoGoogle ? "Comprobando Google…" : "Google: pendiente de configurar en este entorno."}
                </p>
              )}
            </div>
          </form>
        </div>
      </main>

      <aside className="login-lamina hidden md:block relative m-3">
        <img
          src="/images/login-hero.png"
          alt=""
          className="login-foto-marca absolute inset-0 w-full h-full object-cover"
        />
        <div className="login-velo" />
        <div className="relative h-full flex flex-col justify-end p-8 text-white">
          <p className="login-kicker" style={{ color: "rgba(255,255,255,0.75)" }}>
            Pedidos por WhatsApp, sin fricción
          </p>
          <p className="login-serif text-[26px] mt-2 mb-0 text-white">
            Tus meseros y tu agente de IA, tomando el mismo pedido.
          </p>
        </div>
      </aside>
    </div>
  );
}
