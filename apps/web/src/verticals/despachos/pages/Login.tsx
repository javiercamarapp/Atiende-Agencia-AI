// Pantalla real de login del panel de despachos — SOLO Google o "Continuar con
// correo" (magic link, sin contraseña), mismo criterio de UX que Likida:
// Google arriba, un solo campo de correo abajo. `POST /auth/login` (email+
// password) sigue existiendo en el backend, pero esta pantalla nunca lo expone
// — instrucción explícita: el login es exclusivamente passwordless.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { AtiendeMark, AtiendeWordmark } from "@atiende/ui";
import type { LoginSession } from "../lib/auth-client.ts";
import { iniciarMagicLink, mensajeGoogleError, mensajeMagicLinkError, urlIniciarGoogleLogin, verificarGoogleConfigurado } from "../../../lib/google-auth.ts";
import "../../../pages/login.css";

export interface DespachosLoginPageProps {
  readonly apiBaseUrl: string;
  /** Nunca se llama desde aquí (login 100% passwordless) — se conserva porque
   *  `App.tsx` sigue pasándolo. */
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
}

/** Ícono "G" de Google — lucide-react no trae logos de marca, así que se porta
 * inline el glifo de 4 colores estándar de Google. */
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

export function DespachosLoginPage({ apiBaseUrl }: DespachosLoginPageProps) {
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
    window.location.href = urlIniciarGoogleLogin(apiBaseUrl, "despachos");
  }

  async function handleMagicLinkSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEnviandoMagicLink(true);
    try {
      await iniciarMagicLink(apiBaseUrl, correoMagicLink, "despachos");
      setMagicLinkEnviado(correoMagicLink);
    } finally {
      setEnviandoMagicLink(false);
    }
  }

  return (
    <main className="login flex min-h-screen">
      <div className="flex-1 flex items-center justify-center px-6 py-12 sm:px-10">
        <div className="w-full max-w-md">
          <div className="login-entra" style={{ animationDelay: "0ms" }}>
            <AtiendeWordmark className="mb-10" />
          </div>

          <div className="login-entra mb-8" style={{ animationDelay: "70ms" }}>
            <p className="login-kicker mb-3">Acceso al panel</p>
            <h1 className="login-serif text-[42px] sm:text-[50px] leading-[1.02] text-foreground">
              Bienvenido
              <br />a atiende despachos
            </h1>
          </div>

          {googleError && (
            <p role="alert" className="login-entra text-sm text-destructive m-0 mb-3" style={{ animationDelay: "100ms" }}>
              {mensajeGoogleError(googleError)}
            </p>
          )}
          {magicLinkError && !googleError && (
            <p role="alert" className="login-entra text-sm text-destructive m-0 mb-3" style={{ animationDelay: "100ms" }}>
              {mensajeMagicLinkError(magicLinkError)}
            </p>
          )}

          <button
            type="button"
            onClick={irAGoogle}
            disabled={!googleHabilitado}
            title={!googleHabilitado ? (comprobandoGoogle ? "Comprobando Google…" : "Google: pendiente de configurar en este entorno.") : undefined}
            className="login-entra login-btn login-btn-borde"
            style={{ animationDelay: "120ms" }}
          >
            <GoogleGlifo />
            Continuar con Google
            <span className="login-glifo">
              <ArrowRight className="w-4 h-4" />
            </span>
          </button>
          {!googleHabilitado && (
            <p className="login-entra mt-2 text-[12px] leading-relaxed text-muted-foreground" style={{ animationDelay: "130ms" }}>
              {comprobandoGoogle ? "Comprobando Google…" : "Google: pendiente de configurar en este entorno."}
            </p>
          )}

          <div className="login-entra my-5 flex items-center gap-4" style={{ animationDelay: "150ms" }}>
            <span className="h-px flex-1 bg-border" />
            <span className="text-[13px] lowercase text-muted-foreground">o</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          {magicLinkEnviado ? (
            <div className="login-entra rounded-[18px] p-5 bg-primary/5 border border-primary/20" style={{ animationDelay: "170ms" }}>
              <p className="text-[14px] leading-relaxed text-foreground">
                Te enviamos un enlace a <span className="font-semibold">{magicLinkEnviado}</span>. Ábrelo desde este mismo dispositivo — expira en 15 minutos.
              </p>
              <button type="button" onClick={() => setMagicLinkEnviado(null)} className="mt-3 text-[13px] font-semibold text-foreground underline underline-offset-2">
                Usar otro correo
              </button>
            </div>
          ) : (
            <form onSubmit={handleMagicLinkSubmit} className="login-entra flex flex-col gap-3" style={{ animationDelay: "170ms" }} noValidate>
              <label htmlFor="email" className="sr-only">
                Correo
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="tu@despacho.com"
                value={correoMagicLink}
                onChange={(e) => setCorreoMagicLink(e.target.value)}
                required
                className="login-campo"
              />
              <button type="submit" disabled={enviandoMagicLink} className="login-btn login-btn-tinta mt-1">
                <span aria-hidden className="login-glifo">
                  <AtiendeMark className="h-[17px] w-auto brightness-0 invert" />
                </span>
                <span>{enviandoMagicLink ? "Enviando…" : "Continuar con correo"}</span>
              </button>
            </form>
          )}

          <p className="login-entra mt-7 text-pretty text-[12px] leading-[1.7] text-muted-foreground" style={{ animationDelay: "220ms" }}>
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

      <aside className="login-lamina hidden lg:flex flex-col flex-1 m-3 ml-0 relative overflow-hidden">
        <img
          src={`${import.meta.env.BASE_URL}images/login-hero-despachos.png`}
          alt="Oficina contable vacía en la hora azul."
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
