// Login unificado de las verticales (PR-4 del plan de diseno-ux, 4.5): pantalla
// passwordless -- Google (si el entorno lo tiene configurado) y "Continuar con
// correo" (magic link) -- parametrizada por vertical. Sustituye a los Login.tsx
// casi gemelos de cada vertical. La logica de red vive en lib/google-auth.ts; el
// shell/hook de sesion NO interviene aqui (no hay sesion todavia).
//
// Los metodos son props: una vertical que no ofrece Google o magic link (o que
// agregue contrasena el dia de manana) los enciende/apaga sin copiar la pantalla.
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { AtiendeMark, AtiendeWordmark, Button, FormField, GoogleIcon, notify } from "@atiende/ui";
import { iniciarMagicLink, mensajeGoogleError, mensajeMagicLinkError, urlIniciarGoogleLogin, verificarGoogleConfigurado } from "../lib/google-auth.ts";
import "../pages/login.css";

export interface VerticalLoginHero {
  /** Ruta relativa a `import.meta.env.BASE_URL` (p. ej. "images/login-hero-citas.jpg"). */
  readonly imagen: string;
  readonly alt: string;
  readonly kicker: string;
  readonly texto: ReactNode;
}

export interface VerticalLoginProps {
  readonly apiBaseUrl: string;
  /** Identificador de la vertical que reciben el inicio con Google y el magic link ("citas"). */
  readonly vertical: string;
  /** Nombre visible en el titulo: "Bienvenido a atiende {nombre}". */
  readonly nombre: string;
  readonly descripcion: string;
  /** @default "Acceso al panel" */
  readonly kicker?: string;
  /** @default "tu@negocio.com" */
  readonly placeholderCorreo?: string;
  readonly metodos?: { readonly google?: boolean; readonly magicLink?: boolean };
  readonly hero: VerticalLoginHero;
}

const RETRASO = (ms: number) => ({ animationDelay: `${ms}ms` });

export function esCorreoValido(correo: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo.trim());
}

export function VerticalLogin({ apiBaseUrl, vertical, nombre, descripcion, kicker = "Acceso al panel", placeholderCorreo = "tu@negocio.com", metodos, hero }: VerticalLoginProps) {
  const conGoogle = metodos?.google ?? true;
  const conMagicLink = metodos?.magicLink ?? true;
  const [correo, setCorreo] = useState("");
  const [errorCorreo, setErrorCorreo] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [enviadoA, setEnviadoA] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const [googleConfigurado, setGoogleConfigurado] = useState(false);
  const [comprobandoGoogle, setComprobandoGoogle] = useState(conGoogle);

  useEffect(() => {
    if (!conGoogle) return;
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
  }, [apiBaseUrl, conGoogle]);

  const googleError = searchParams.get("google_error");
  const magicLinkError = searchParams.get("magic_link_error");
  const googleHabilitado = conGoogle && googleConfigurado && !comprobandoGoogle;
  const avisoGoogle = comprobandoGoogle ? "Comprobando Google…" : "Google: pendiente de configurar en este entorno.";

  function irAGoogle() {
    if (!googleHabilitado) return;
    window.location.href = urlIniciarGoogleLogin(apiBaseUrl, vertical);
  }

  async function enviarMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (enviando) return;
    if (!esCorreoValido(correo)) {
      setErrorCorreo("Escribe un correo válido, por ejemplo tu@negocio.com.");
      return;
    }
    setErrorCorreo(null);
    setEnviando(true);
    try {
      const resultado = await iniciarMagicLink(apiBaseUrl, correo.trim(), vertical);
      if (!resultado.ok) {
        notify.error("No se pudo enviar el enlace", { description: resultado.error ?? "Intenta de nuevo." });
        return;
      }
      setEnviadoA(correo.trim());
    } finally {
      setEnviando(false);
    }
  }

  const alerta = googleError ? mensajeGoogleError(googleError) : magicLinkError ? mensajeMagicLinkError(magicLinkError) : null;

  return (
    <main className="login min-h-screen lg:grid lg:grid-cols-2">
      <section className="flex min-h-screen flex-col px-6 py-7 sm:px-10 lg:px-14 lg:py-10">
        <div className="mx-auto flex w-full max-w-[420px] flex-col pt-10 lg:pt-16">
          <header className="login-entra flex items-center">
            <AtiendeWordmark />
          </header>

          <div className="mt-10">
            <div className="w-full">
              <p className="login-entra login-kicker" style={RETRASO(40)}>
                {kicker}
              </p>
              <h1 className="login-entra login-serif mt-3 text-[38px] sm:text-[46px] leading-[1.05] text-foreground" style={RETRASO(90)}>
                Bienvenido
                <br />a atiende {nombre}
              </h1>
              <p className="login-entra mt-2 text-[15px] leading-[1.6] text-muted-foreground" style={RETRASO(140)}>
                {descripcion}
              </p>

              <div className="login-entra mt-5 h-px bg-border" style={RETRASO(160)} />

              {alerta && (
                <div role="alert" className="login-entra mt-7 rounded-[18px] p-5 bg-destructive/5 border border-destructive/30" style={RETRASO(180)}>
                  <p className="text-[14px] leading-relaxed text-foreground">{alerta}</p>
                </div>
              )}

              {conGoogle && (
                <>
                  <button
                    type="button"
                    onClick={irAGoogle}
                    disabled={!googleHabilitado}
                    title={!googleHabilitado ? avisoGoogle : undefined}
                    className="login-entra mt-5 login-btn login-btn-borde"
                    style={RETRASO(200)}
                  >
                    <GoogleIcon />
                    Continuar con Google
                  </button>
                  {!googleHabilitado && (
                    <p className="login-entra mt-2 text-[12px] leading-relaxed text-muted-foreground" style={RETRASO(210)}>
                      {avisoGoogle}
                    </p>
                  )}
                </>
              )}

              {conGoogle && conMagicLink && (
                <div className="login-entra my-4 flex items-center gap-4" style={RETRASO(230)}>
                  <span className="h-px flex-1 bg-border" />
                  <span className="text-[13px] lowercase text-muted-foreground">o</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}

              {conMagicLink &&
                (enviadoA ? (
                  <div role="status" className="login-entra rounded-[18px] p-5 bg-primary/5 border border-primary/20" style={RETRASO(250)}>
                    <p className="text-[14px] leading-relaxed text-foreground">
                      Te enviamos un enlace a <span className="font-semibold">{enviadoA}</span>. Ábrelo desde este mismo dispositivo para entrar — expira en 15 minutos.
                    </p>
                    <Button type="button" variant="link" size="sm" onClick={() => setEnviadoA(null)} className="mt-2 h-auto px-0 text-foreground">
                      Usar otro correo
                    </Button>
                  </div>
                ) : (
                  <form onSubmit={enviarMagicLink} className="login-entra flex flex-col gap-3" style={RETRASO(250)} noValidate>
                    <FormField label={<span className="sr-only">Tu correo</span>} error={errorCorreo ?? undefined} required>
                      {(campo) => (
                        <input
                          {...campo}
                          type="email"
                          placeholder={placeholderCorreo}
                          autoComplete="email"
                          value={correo}
                          onChange={(e) => setCorreo(e.target.value)}
                          className="login-campo"
                        />
                      )}
                    </FormField>
                    <button type="submit" disabled={enviando} aria-busy={enviando || undefined} className="login-btn login-btn-tinta">
                      <span aria-hidden className="login-glifo">
                        <AtiendeMark className="h-[17px] w-auto brightness-0 invert" />
                      </span>
                      <span>{enviando ? "Enviando…" : "Continuar con correo"}</span>
                    </button>
                  </form>
                ))}

              <p className="login-entra mt-5 text-pretty text-[14px] leading-relaxed text-muted-foreground" style={RETRASO(320)}>
                ¿Tu correo no tiene acceso? <span className="font-semibold text-foreground">Pídele a tu negocio que te dé de alta.</span>
              </p>

              <p className="login-entra mt-6 text-pretty text-[12px] leading-[1.7] text-muted-foreground" style={RETRASO(340)}>
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
          <img src={`${import.meta.env.BASE_URL}${hero.imagen}`} alt={hero.alt} className="login-foto-marca absolute inset-0 w-full h-full object-cover" />
          <div className="login-velo" />
          <figcaption className="absolute inset-x-0 bottom-0 p-9 z-10">
            <p className="login-kicker" style={{ color: "color-mix(in srgb, white 78%, transparent)" }}>
              {hero.kicker}
            </p>
            <p className="login-serif mt-3.5 text-white" style={{ fontSize: "clamp(20px, 1.9vw, 27px)" }}>
              {hero.texto}
            </p>
          </figcaption>
        </figure>
      </aside>
    </main>
  );
}
