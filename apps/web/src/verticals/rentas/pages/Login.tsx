// Pantalla real de login del panel de rentas — SOLO Google o "Continuar con
// correo" (magic link, sin contraseña), mismo criterio de UX que Likida:
// Google arriba, un solo campo de correo abajo. Sin formulario de contraseña
// en absoluto — instrucción explícita: el login es exclusivamente passwordless
// (Google + enlace mágico). `POST /auth/login` (email+password) sigue
// existiendo en el backend (lo sigue usando `accept-invite`/tests), pero esta
// pantalla nunca lo expone.
//
// Visual: mismo layout split-screen que el resto de verticales (login.css
// compartido) — kicker mono, titular serif grande, píldoras de 999px, lámina
// con foto real (propia de rentas) + Ken Burns. Rentas es la única vertical con
// alta autoservicio (`/rentas/registro`), así que conserva ese enlace.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AtiendeMark, AtiendeWordmark } from "@atiende/ui";
import type { LoginSession } from "../lib/auth-client.ts";
import { iniciarMagicLink, mensajeGoogleError, mensajeMagicLinkError, urlIniciarGoogleLogin, verificarGoogleConfigurado } from "../../../lib/google-auth.ts";
import "../../../pages/login.css";

export interface RentasLoginPageProps {
  readonly apiBaseUrl: string;
  /** Nunca se llama desde aquí (login es 100% passwordless: Google/magic link
   *  redirigen la página completa vía `GoogleCallbackPage`, no una navegación de
   *  React Router) — se conserva en el tipo porque `App.tsx` sigue pasándolo. */
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
}

export function RentasLoginPage({ apiBaseUrl }: RentasLoginPageProps) {
  const [correoMagicLink, setCorreoMagicLink] = useState("");
  const [enviandoMagicLink, setEnviandoMagicLink] = useState(false);
  const [magicLinkEnviado, setMagicLinkEnviado] = useState<string | null>(null);

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
  const magicLinkError = searchParams.get("magic_link_error");
  const googleHabilitado = googleConfigurado && !comprobandoGoogle;

  function irAGoogle() {
    if (!googleHabilitado) return;
    window.location.href = urlIniciarGoogleLogin(apiBaseUrl, "rentas");
  }

  async function handleMagicLinkSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEnviandoMagicLink(true);
    try {
      await iniciarMagicLink(apiBaseUrl, correoMagicLink, "rentas");
      setMagicLinkEnviado(correoMagicLink);
    } finally {
      setEnviandoMagicLink(false);
    }
  }

  return (
    <main className="login min-h-screen lg:grid lg:grid-cols-2">
      <section className="flex min-h-screen flex-col px-6 py-7 sm:px-10 lg:px-14 lg:py-10">
        <div className="mx-auto flex w-full max-w-[420px] flex-col pt-10 lg:pt-16">
          <header className="login-entra flex items-center">
            <AtiendeWordmark />
          </header>

          <div className="mt-10">
            <div className="w-full">
              <p className="login-entra login-kicker" style={{ animationDelay: "40ms" }}>
                Acceso al panel
              </p>
              <h1 className="login-entra login-serif mt-3 text-[38px] sm:text-[46px] leading-[1.05] text-foreground" style={{ animationDelay: "90ms" }}>
                Bienvenido
                <br />a atiende rentas
              </h1>
              <p className="login-entra mt-2 text-[15px] leading-[1.6] text-muted-foreground" style={{ animationDelay: "140ms" }}>
                El panel de operación de tus propiedades.
              </p>

              <div className="login-entra mt-5 h-px bg-border" style={{ animationDelay: "160ms" }} />

              {googleError && (
                <div role="alert" className="login-entra mt-7 rounded-[18px] p-5 bg-destructive/5 border border-destructive/30" style={{ animationDelay: "180ms" }}>
                  <p className="text-[14px] leading-relaxed text-foreground">{mensajeGoogleError(googleError)}</p>
                </div>
              )}
              {magicLinkError && !googleError && (
                <div role="alert" className="login-entra mt-7 rounded-[18px] p-5 bg-destructive/5 border border-destructive/30" style={{ animationDelay: "180ms" }}>
                  <p className="text-[14px] leading-relaxed text-foreground">{mensajeMagicLinkError(magicLinkError)}</p>
                </div>
              )}

              {/* Google primero — mismo criterio que Likida: el método más rápido va arriba. */}
              <button
                type="button"
                onClick={irAGoogle}
                disabled={!googleHabilitado}
                title={!googleHabilitado ? (comprobandoGoogle ? "Comprobando Google…" : "Google: pendiente de configurar en este entorno.") : undefined}
                className="login-entra mt-5 login-btn login-btn-borde"
                style={{ animationDelay: "200ms" }}
              >
                <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
                  <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z" />
                  <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
                  <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
                  <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
                </svg>
                Continuar con Google
              </button>
              {!googleHabilitado && (
                <p className="login-entra mt-2 text-[12px] leading-relaxed text-muted-foreground" style={{ animationDelay: "210ms" }}>
                  {comprobandoGoogle ? "Comprobando Google…" : "Google: pendiente de configurar en este entorno."}
                </p>
              )}

              <div className="login-entra my-4 flex items-center gap-4" style={{ animationDelay: "230ms" }}>
                <span className="h-px flex-1 bg-border" />
                <span className="text-[13px] lowercase text-muted-foreground">o</span>
                <span className="h-px flex-1 bg-border" />
              </div>

              {/* "Continuar con correo" -- magic link, sin contraseña. Único segundo método. */}
              {magicLinkEnviado ? (
                <div className="login-entra rounded-[18px] p-5 bg-primary/5 border border-primary/20" style={{ animationDelay: "250ms" }}>
                  <p className="text-[14px] leading-relaxed text-foreground">
                    Te enviamos un enlace a <span className="font-semibold">{magicLinkEnviado}</span>. Ábrelo desde este mismo dispositivo para entrar — expira
                    en 15 minutos.
                  </p>
                  <button type="button" onClick={() => setMagicLinkEnviado(null)} className="mt-3 text-[13px] font-semibold text-foreground underline underline-offset-2">
                    Usar otro correo
                  </button>
                </div>
              ) : (
                <form onSubmit={handleMagicLinkSubmit} className="login-entra flex flex-col gap-3" style={{ animationDelay: "250ms" }} noValidate>
                  <label htmlFor="login-email-magic" className="sr-only">
                    Tu correo
                  </label>
                  <input
                    id="login-email-magic"
                    type="email"
                    required
                    placeholder="tu@propiedad.com"
                    autoComplete="email"
                    value={correoMagicLink}
                    onChange={(e) => setCorreoMagicLink(e.target.value)}
                    className="login-campo"
                  />
                  <button type="submit" disabled={enviandoMagicLink} className="login-btn login-btn-tinta">
                    <span aria-hidden className="login-glifo">
                      <AtiendeMark className="h-[17px] w-auto brightness-0 invert" />
                    </span>
                    <span>{enviandoMagicLink ? "Enviando…" : "Continuar con correo"}</span>
                  </button>
                </form>
              )}

              <p className="login-entra mt-5 text-pretty text-[14px] leading-relaxed text-muted-foreground" style={{ animationDelay: "320ms" }}>
                ¿No tienes cuenta?{" "}
                <Link to="/rentas/registro" className="font-semibold text-foreground underline underline-offset-2">
                  Créala aquí
                </Link>
                .
              </p>

              <p className="login-entra mt-6 text-pretty text-[12px] leading-[1.7] text-muted-foreground" style={{ animationDelay: "340ms" }}>
                Al continuar, aceptas los{" "}
                <a href="/terminos" className="underline underline-offset-2 text-foreground hover:opacity-70 transition-opacity">
                  Términos de Servicio
                </a>{" "}
                y el{" "}
                <a href="/privacidad" className="underline underline-offset-2 text-foreground hover:opacity-70 transition-opacity">
                  Aviso de Privacidad
                </a>{" "}
                de atiende.ai.
              </p>
            </div>
          </div>
        </div>
      </section>

      <aside className="hidden lg:flex lg:flex-col lg:py-10 lg:pl-6 lg:pr-10">
        <figure className="login-lamina min-h-0 flex-1 flex items-center justify-center">
          <img
            src={`${import.meta.env.BASE_URL}images/login-hero-rentas.png`}
            alt="Casas victorianas de San Francisco al atardecer."
            className="login-foto-marca absolute inset-0 w-full h-full object-cover"
          />
          <div className="login-velo" />
          <figcaption className="absolute inset-x-0 bottom-0 p-9 z-10">
            <p className="login-kicker" style={{ color: "color-mix(in srgb, white 78%, transparent)" }}>
              Operación multi-propiedad
            </p>
            <p className="login-serif mt-3.5 text-white" style={{ fontSize: "clamp(20px, 1.9vw, 27px)" }}>
              Sincronía con Booking, Airbnb y Vrbo, en un solo panel.
            </p>
          </figcaption>
        </figure>
      </aside>
    </main>
  );
}
