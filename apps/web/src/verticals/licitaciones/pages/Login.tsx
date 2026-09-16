// Pantalla real de login del panel de licitaciones — SOLO Google o "Continuar
// con correo" (magic link, sin contraseña), mismo criterio de UX que Likida:
// Google arriba, un solo campo de correo abajo. `POST /auth/login` (email+
// password) sigue existiendo en el backend, pero esta pantalla nunca lo expone
// — instrucción explícita: el login es exclusivamente passwordless.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { AtiendeMark, AtiendeWordmark } from "@atiende/ui";
import type { LoginSession } from "../lib/auth-client.ts";
import { LICITACIONES_TAB_TITLE } from "../lib/brand.ts";
import { iniciarMagicLink, mensajeGoogleError, mensajeMagicLinkError, urlIniciarGoogleLogin, verificarGoogleConfigurado } from "../../../lib/google-auth.ts";
import "../../../pages/login.css";

export interface LicitacionesLoginPageProps {
  readonly apiBaseUrl: string;
  /** Nunca se llama desde aquí (login 100% passwordless) — se conserva porque
   *  `App.tsx` sigue pasándolo. */
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
}

export function LicitacionesLoginPage({ apiBaseUrl }: LicitacionesLoginPageProps) {
  const [correoMagicLink, setCorreoMagicLink] = useState("");
  const [enviandoMagicLink, setEnviandoMagicLink] = useState(false);
  const [magicLinkEnviado, setMagicLinkEnviado] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const [googleConfigurado, setGoogleConfigurado] = useState(false);
  const [comprobandoGoogle, setComprobandoGoogle] = useState(true);

  // Hallazgo de auditoría ("título de pestaña fijo en 'Restaurantes'") — ver
  // el comentario de `LICITACIONES_TAB_TITLE` en lib/brand.ts.
  useEffect(() => {
    document.title = LICITACIONES_TAB_TITLE;
  }, []);

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
    window.location.href = urlIniciarGoogleLogin(apiBaseUrl, "licitaciones");
  }

  async function handleMagicLinkSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEnviandoMagicLink(true);
    try {
      await iniciarMagicLink(apiBaseUrl, correoMagicLink, "licitaciones");
      setMagicLinkEnviado(correoMagicLink);
    } finally {
      setEnviandoMagicLink(false);
    }
  }

  return (
    <div className="login grid min-h-screen lg:grid-cols-2">
      <main className="flex items-center justify-center px-6 py-16 sm:px-10 lg:px-16 bg-background">
        <div className="w-full max-w-[400px] flex flex-col gap-7">
          <div className="login-entra" style={{ animationDelay: "0ms" }}>
            <AtiendeWordmark className="h-7 w-auto" />
          </div>

          <div className="login-entra flex flex-col gap-2" style={{ animationDelay: "70ms" }}>
            <p className="login-kicker">Acceso al panel</p>
            <h1 className="login-serif text-[44px] sm:text-[54px] leading-[1.02] text-foreground">
              Bienvenido
              <br />a atiende licitaciones
            </h1>
            <p className="text-[14px] text-muted-foreground leading-relaxed">
              Da seguimiento a cada convocatoria pública, evalúa tu matching y no pierdas ninguna fecha límite de presentación.
            </p>
          </div>

          <div className="login-entra h-px bg-border" style={{ animationDelay: "100ms" }} />

          {googleError && (
            <p role="alert" className="login-entra text-[13px] text-destructive" style={{ animationDelay: "120ms" }}>
              {mensajeGoogleError(googleError)}
            </p>
          )}
          {magicLinkError && !googleError && (
            <p role="alert" className="login-entra text-[13px] text-destructive" style={{ animationDelay: "120ms" }}>
              {mensajeMagicLinkError(magicLinkError)}
            </p>
          )}

          <div className="login-entra flex flex-col gap-3" style={{ animationDelay: "140ms" }}>
            <button
              type="button"
              onClick={irAGoogle}
              disabled={!googleHabilitado}
              title={!googleHabilitado ? (comprobandoGoogle ? "Comprobando Google…" : "Google: pendiente de configurar en este entorno.") : undefined}
              className="login-btn login-btn-borde"
            >
              Continuar con Google
              <span className="login-glifo" aria-hidden="true">
                G
              </span>
            </button>
            {!googleHabilitado && (
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                {comprobandoGoogle ? "Comprobando Google…" : "Google: pendiente de configurar en este entorno."}
              </p>
            )}
          </div>

          <div className="login-entra flex items-center gap-3 text-[11px] uppercase tracking-[0.1em] text-muted-foreground" style={{ animationDelay: "160ms" }}>
            <span className="h-px flex-1 bg-border" />o<span className="h-px flex-1 bg-border" />
          </div>

          {magicLinkEnviado ? (
            <div className="login-entra rounded-[18px] p-5 bg-primary/5 border border-primary/20" style={{ animationDelay: "180ms" }}>
              <p className="text-[14px] leading-relaxed text-foreground">
                Te enviamos un enlace a <span className="font-semibold">{magicLinkEnviado}</span>. Ábrelo desde este mismo dispositivo — expira en 15 minutos.
              </p>
              <button type="button" onClick={() => setMagicLinkEnviado(null)} className="mt-3 text-[13px] font-semibold text-foreground underline underline-offset-2">
                Usar otro correo
              </button>
            </div>
          ) : (
            <form onSubmit={handleMagicLinkSubmit} noValidate className="login-entra flex flex-col gap-3" style={{ animationDelay: "180ms" }}>
              <label htmlFor="email" className="flex flex-col gap-1.5 text-[13px] font-medium text-foreground">
                Correo
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={correoMagicLink}
                  onChange={(e) => setCorreoMagicLink(e.target.value)}
                  required
                  placeholder="tu@empresa.com"
                  className="login-campo"
                />
              </label>
              <button type="submit" disabled={enviandoMagicLink} className="login-btn login-btn-tinta">
                <span aria-hidden className="login-glifo">
                  <AtiendeMark className="h-[17px] w-auto brightness-0 invert" />
                </span>
                <span>{enviandoMagicLink ? "Enviando…" : "Continuar con correo"}</span>
              </button>
            </form>
          )}

          <p className="login-entra mt-2 text-pretty text-[12px] leading-[1.7] text-muted-foreground" style={{ animationDelay: "220ms" }}>
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
      </main>

      <aside className="login-lamina hidden lg:block relative m-3">
        <img
          src={`${import.meta.env.BASE_URL}images/login-hero-licitaciones.png`}
          alt="Archivo de expedientes gubernamentales vacío en la hora azul."
          className="login-foto-marca absolute inset-0 h-full w-full object-cover"
        />
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
