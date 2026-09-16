// Pantalla real de login del panel de restaurantes — SOLO Google o "Continuar
// con correo" (magic link, sin contraseña), mismo criterio de UX que Likida:
// Google arriba, un solo campo de correo abajo. `POST /auth/login` (email+
// password) sigue existiendo en el backend, pero esta pantalla nunca lo expone
// — instrucción explícita: el login es exclusivamente passwordless.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { AtiendeMark, AtiendeWordmark } from "@atiende/ui";
import type { LoginSession } from "../../../lib/auth-client.ts";
import { useDocumentTitle } from "../../../shell/use-document-title.ts";
import { iniciarMagicLink, mensajeGoogleError, mensajeMagicLinkError, urlIniciarGoogleLogin, verificarGoogleConfigurado } from "../../../lib/google-auth.ts";
import "../../../pages/login.css";

export interface LoginPageProps {
  readonly apiBaseUrl: string;
  /** Nunca se llama desde aquí (login 100% passwordless) — se conserva porque
   *  `App.tsx` sigue pasándolo. */
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
}

export function RestaurantesLoginPage({ apiBaseUrl }: LoginPageProps) {
  useDocumentTitle("Restaurantes");
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
    window.location.href = urlIniciarGoogleLogin(apiBaseUrl, "restaurantes");
  }

  async function handleMagicLinkSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEnviandoMagicLink(true);
    try {
      await iniciarMagicLink(apiBaseUrl, correoMagicLink, "restaurantes");
      setMagicLinkEnviado(correoMagicLink);
    } finally {
      setEnviandoMagicLink(false);
    }
  }

  return (
    <div className="login min-h-screen grid grid-cols-1 md:grid-cols-2">
      <main className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-[400px] flex flex-col gap-6">
          <div className="login-entra" style={{ animationDelay: "0ms" }}>
            <AtiendeWordmark className="h-7 w-auto" />
          </div>

          <div className="login-entra flex flex-col gap-2" style={{ animationDelay: "60ms" }}>
            <p className="login-kicker">Acceso al panel</p>
            <h1 className="login-serif text-[44px] sm:text-[54px] leading-[1.02] m-0">
              Bienvenido
              <br />a atiende restaurantes
            </h1>
            <p className="m-0 text-sm text-muted-foreground">Entra con Google o con un enlace a tu correo — sin contraseña.</p>
          </div>

          <div className="login-entra h-px bg-border" style={{ animationDelay: "100ms" }} />

          {googleError && (
            <p role="alert" className="login-entra m-0 text-[13px] text-destructive" style={{ animationDelay: "120ms" }}>
              {mensajeGoogleError(googleError)}
            </p>
          )}
          {magicLinkError && !googleError && (
            <p role="alert" className="login-entra m-0 text-[13px] text-destructive" style={{ animationDelay: "120ms" }}>
              {mensajeMagicLinkError(magicLinkError)}
            </p>
          )}

          <button
            type="button"
            onClick={irAGoogle}
            disabled={!googleHabilitado}
            title={!googleHabilitado ? (comprobandoGoogle ? "Comprobando Google…" : "Google: pendiente de configurar en este entorno.") : undefined}
            className="login-entra login-btn login-btn-borde"
            style={{ animationDelay: "140ms" }}
          >
            <span className="login-glifo" aria-hidden>
              G
            </span>
            Continuar con Google
          </button>
          {!googleHabilitado && (
            <p className="login-entra m-0 text-[12px] leading-relaxed text-muted-foreground" style={{ animationDelay: "150ms" }}>
              {comprobandoGoogle ? "Comprobando Google…" : "Google: pendiente de configurar en este entorno."}
            </p>
          )}

          <div className="login-entra flex items-center gap-4" style={{ animationDelay: "160ms" }}>
            <span className="h-px flex-1 bg-border" />
            <span className="text-[13px] lowercase text-muted-foreground">o</span>
            <span className="h-px flex-1 bg-border" />
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
              <label htmlFor="email" className="block text-xs text-muted-foreground mb-1.5">
                Correo
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={correoMagicLink}
                onChange={(e) => setCorreoMagicLink(e.target.value)}
                required
                placeholder="tu@restaurante.com"
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

      <aside className="login-lamina hidden md:block relative m-3">
        <img
          src={`${import.meta.env.BASE_URL}images/login-hero-restaurantes.png`}
          alt="Comedor de un restaurante vacío en la hora azul."
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
