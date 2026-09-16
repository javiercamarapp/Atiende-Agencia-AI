// Pantalla real de login del panel de rentas — SOLO Google o "Continuar con
// correo" (magic link, sin contraseña), mismo criterio de UX que Likida:
// Google arriba, un solo campo de correo abajo. `POST /auth/login` (email+
// password) sigue existiendo en el backend, pero esta pantalla nunca lo expone
// — instrucción explícita: el login es exclusivamente passwordless.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AtiendeMark, AtiendeWordmark } from "@atiende/ui";
import type { LoginSession } from "../lib/auth-client.ts";
import { iniciarMagicLink, mensajeGoogleError, mensajeMagicLinkError, urlIniciarGoogleLogin, verificarGoogleConfigurado } from "../../../lib/google-auth.ts";
import "../../../pages/login.css";

export interface RentasLoginPageProps {
  readonly apiBaseUrl: string;
  /** Nunca se llama desde aquí (login 100% passwordless) — se conserva porque
   *  `App.tsx` sigue pasándolo. */
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
    <div className="login min-h-screen w-full flex flex-col md:flex-row">
      {/* Columna izquierda: formulario real */}
      <div className="w-full md:w-[46%] flex flex-col justify-center px-6 sm:px-10 lg:px-16 py-12">
        <div className="mx-auto w-full max-w-sm flex flex-col gap-7">
          <div className="login-entra" style={{ animationDelay: "0s" }}>
            <AtiendeWordmark className="h-7 w-auto" />
          </div>

          <div className="login-entra flex flex-col gap-2" style={{ animationDelay: "0.05s" }}>
            <span className="login-kicker">Acceso al panel</span>
            <h1 className="login-serif text-foreground text-[42px] sm:text-[50px] leading-[1.02]">
              Bienvenido
              <br />a atiende rentas
            </h1>
            <p className="text-[14px] text-muted-foreground leading-snug">Entra con Google o con un enlace a tu correo — sin contraseña.</p>
          </div>

          {googleError && (
            <p role="alert" className="login-entra text-[13px] text-destructive m-0" style={{ animationDelay: "0.08s" }}>
              {mensajeGoogleError(googleError)}
            </p>
          )}
          {magicLinkError && !googleError && (
            <p role="alert" className="login-entra text-[13px] text-destructive m-0" style={{ animationDelay: "0.08s" }}>
              {mensajeMagicLinkError(magicLinkError)}
            </p>
          )}

          <button
            type="button"
            onClick={irAGoogle}
            disabled={!googleHabilitado}
            title={!googleHabilitado ? (comprobandoGoogle ? "Comprobando Google…" : "Google: pendiente de configurar en este entorno.") : undefined}
            className="login-entra login-btn login-btn-borde"
            style={{ animationDelay: "0.1s" }}
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0" aria-hidden="true">
              <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.54-5.17 3.54-8.87z" />
              <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3c-1.07.72-2.45 1.15-4.05 1.15-3.11 0-5.75-2.1-6.69-4.93H1.3v3.09A12 12 0 0 0 12 24z" />
              <path fill="#FBBC05" d="M5.31 14.31A7.2 7.2 0 0 1 4.93 12c0-.8.14-1.58.38-2.31V6.6H1.3A12 12 0 0 0 0 12c0 1.94.46 3.77 1.3 5.4z" />
              <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44C17.94 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.3 6.6l4.01 3.09C6.25 6.85 8.89 4.75 12 4.75z" />
            </svg>
            Continuar con Google
          </button>
          {!googleHabilitado && (
            <p className="login-entra text-[12px] leading-relaxed text-muted-foreground" style={{ animationDelay: "0.12s" }}>
              {comprobandoGoogle ? "Comprobando Google…" : "Google: pendiente de configurar en este entorno."}
            </p>
          )}

          <div className="login-entra flex items-center gap-3 text-[10px] uppercase tracking-[0.14em] text-muted-foreground" style={{ animationDelay: "0.14s" }}>
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
            o
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
          </div>

          {magicLinkEnviado ? (
            <div className="login-entra rounded-[18px] p-5 bg-primary/5 border border-primary/20" style={{ animationDelay: "0.16s" }}>
              <p className="text-[14px] leading-relaxed text-foreground">
                Te enviamos un enlace a <span className="font-semibold">{magicLinkEnviado}</span>. Ábrelo desde este mismo dispositivo — expira en 15 minutos.
              </p>
              <button type="button" onClick={() => setMagicLinkEnviado(null)} className="mt-3 text-[13px] font-semibold text-foreground underline underline-offset-2">
                Usar otro correo
              </button>
            </div>
          ) : (
            <form onSubmit={handleMagicLinkSubmit} noValidate className="login-entra flex flex-col gap-3" style={{ animationDelay: "0.16s" }}>
              <label htmlFor="email" className="flex flex-col gap-1.5 text-[13px] font-medium text-foreground">
                Correo
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={correoMagicLink}
                  onChange={(e) => setCorreoMagicLink(e.target.value)}
                  required
                  className="login-campo"
                />
              </label>
              <button type="submit" disabled={enviandoMagicLink} className="login-btn login-btn-tinta mt-1">
                <span aria-hidden className="login-glifo">
                  <AtiendeMark className="h-[17px] w-auto brightness-0 invert" />
                </span>
                <span>{enviandoMagicLink ? "Enviando…" : "Continuar con correo"}</span>
              </button>
            </form>
          )}

          <p className="login-entra text-center text-[13px] text-muted-foreground m-0" style={{ animationDelay: "0.2s" }}>
            ¿No tienes cuenta?{" "}
            <Link to="/rentas/registro" className="text-foreground font-medium underline underline-offset-2">
              Créala aquí
            </Link>
          </p>

          <p className="login-entra text-pretty text-[12px] leading-[1.7] text-muted-foreground" style={{ animationDelay: "0.24s" }}>
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

      {/* Columna derecha: lámina con foto real (Ken Burns) -- oculta en mobile */}
      <aside className="login-lamina hidden md:block md:w-[54%] relative m-3 rounded-[22px] overflow-hidden">
        <img
          src={`${import.meta.env.BASE_URL}images/login-hero-rentas.png`}
          alt="Rooftops de una costa de rentas vacacionales en la hora azul."
          className="login-foto-marca absolute inset-0 h-full w-full object-cover"
        />
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
