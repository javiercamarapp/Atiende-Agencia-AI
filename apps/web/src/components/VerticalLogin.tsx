// Login unificado de las verticales (PR-4 del plan de diseno-ux, 4.5): pantalla
// passwordless -- Google (si el entorno lo tiene configurado) y "Continuar con
// correo" (magic link) -- parametrizada por vertical. Sustituye a los Login.tsx
// casi gemelos de cada vertical. La logica de red vive en lib/google-auth.ts; el
// shell/hook de sesion NO interviene aqui (no hay sesion todavia).
//
// Los metodos son props: una vertical que no ofrece Google o magic link (o que
// agregue contrasena el dia de manana) los enciende/apaga sin copiar la pantalla.
import { useEffect, useId, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { AtiendeMark, AtiendeWordmark, FormField, GoogleIcon } from "@atiende/ui";
import { EtiquetaBoton } from "./EtiquetaBoton.tsx";
import { OlvidoContrasena } from "../shell/cuenta/OlvidoContrasena.tsx";
import { esVerticalCuenta } from "../shell/cuenta/cuenta-client.ts";
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
  /** `olvidoContrasena` (por defecto activo): enlace "¿Olvidaste tu contraseña?" (PL-21); se apaga solo si la vertical no usa contraseña. */
  readonly metodos?: { readonly google?: boolean; readonly magicLink?: boolean; readonly olvidoContrasena?: boolean };
  readonly hero: VerticalLoginHero;
  /** Reemplaza el pie por defecto ("Pídele a tu negocio que te dé de alta"); p. ej. rentas ofrece alta autoservicio. */
  readonly pie?: ReactNode;
}

export function esCorreoValido(correo: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo.trim());
}

export function VerticalLogin({ apiBaseUrl, vertical, nombre, descripcion, kicker = "Acceso al panel", placeholderCorreo = "tu@negocio.com", metodos, hero, pie }: VerticalLoginProps) {
  const conGoogle = metodos?.google ?? true;
  const conMagicLink = metodos?.magicLink ?? true;
  const conOlvido = (metodos?.olvidoContrasena ?? true) && esVerticalCuenta(vertical);
  const [modoOlvido, setModoOlvido] = useState(false);
  const [correo, setCorreo] = useState("");
  const [errorCorreo, setErrorCorreo] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [enviadoA, setEnviadoA] = useState<string | null>(null);
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const idCorreo = useId();
  const idEstado = `${idCorreo}-estado`;
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
    setErrorEnvio(null);
    setEnviadoA(null);
    setEnviando(true);
    try {
      const resultado = await iniciarMagicLink(apiBaseUrl, correo.trim(), vertical);
      if (!resultado.ok) {
        setErrorEnvio(resultado.error ?? "No se pudo enviar el enlace. Intenta de nuevo.");
        return;
      }
      setEnviadoA(correo.trim());
    } finally {
      setEnviando(false);
    }
  }

  const alertaExterna = googleError ? mensajeGoogleError(googleError) : magicLinkError ? mensajeMagicLinkError(magicLinkError) : null;
  // UN SOLO mensaje a la vez en la ranura de altura fija `.login-estado`: error de correo, error del servidor, aviso de
  // "enviado" o error que llega por la URL. Antes "enviado" se insertaba ENCIMA del formulario y los errores empujaban todo:
  // cada cambio de estado movia el formulario y hacia aparecer el scroll.
  const avisoEnviado = conMagicLink && enviadoA && !modoOlvido ? enviadoA : null;
  const alerta = errorCorreo ?? errorEnvio ?? (avisoEnviado ? null : alertaExterna);
  const idAlerta = `${idEstado}-alerta`;

  // Composición de ~/likida/src/app/login/page.tsx:283-441 (UNI-9). Medidas citadas por línea de Likida:
  // columna `max-w-[392px]` centrada en la mitad (:292), logo h-6 (:296), bloque centrado en vertical `py-12` (:299),
  // kicker (:301), titular 38/44 px serif (:304), bajada 15 px/1.6 (:311), aviso de "enviado" ENCIMA del formulario (:333),
  // hairline `mt-9` (:365), Google `mt-8` (:373), separador `my-6` (:389), formulario `gap-3` (:405), píldora `mt-1` (:431),
  // pie `mt-7` 14 px (:438), error inline 14 px (:455), legales `mt-10` 12 px (:464) y lámina `p-9` (:512).
  return (
    <main className="login login-pantalla lg:grid lg:grid-cols-2">
      <section className="login-seccion flex flex-col px-6 sm:px-10 lg:px-14">
        <div className="mx-auto flex w-full max-w-[392px] flex-1 flex-col">
          <header className="login-entra flex items-center">
            <AtiendeWordmark markClassName="h-6 w-auto" className="[&>span]:text-xl [&>span]:leading-6" />
          </header>

          <div className="login-contenido flex flex-1 items-center">
            <div className="w-full">
              <p className="login-entra [--retraso:40ms] login-kicker">{kicker}</p>
              <h1 className="login-entra [--retraso:90ms] login-serif login-titulo mt-5 text-foreground">Bienvenido a atiende {nombre}</h1>
              {/* En "olvidé mi contraseña" el panel ya explica la pantalla: se omite la bajada para que esa vista tampoco pase del alto de la ventana. */}
              {!modoOlvido && <p className="login-entra [--retraso:140ms] login-cuerpo login-descripcion mt-4 text-muted-foreground">{descripcion}</p>}

              <div className="login-entra [--retraso:180ms] login-regla mt-9 h-px bg-border" />

              {modoOlvido && esVerticalCuenta(vertical) ? (
                <OlvidoContrasena apiBaseUrl={apiBaseUrl} vertical={vertical} correoInicial={correo} onVolver={() => setModoOlvido(false)} />
              ) : (
                <>
                  {conGoogle && (
                    <div className="login-entra [--retraso:220ms] login-bloque-google relative mt-8">
                      <button
                        type="button"
                        onClick={irAGoogle}
                        disabled={!googleHabilitado}
                        title={!googleHabilitado ? avisoGoogle : undefined}
                        className="login-btn login-btn-borde"
                      >
                        <GoogleIcon />
                        Continuar con Google
                      </button>
                      {/* Absoluto en el hueco del separador: "Comprobando Google..." aparece y desaparece al cargar y no puede empujar nada. */}
                      {!googleHabilitado && <p className="login-aviso-google absolute inset-x-0 top-full mt-1 text-xs leading-none text-muted-foreground">{avisoGoogle}</p>}
                    </div>
                  )}

                  {conGoogle && conMagicLink && (
                    <div className="login-entra [--retraso:250ms] login-separador my-6 flex items-center gap-4">
                      <span className="h-px flex-1 bg-border" />
                      <span className="text-ui lowercase text-faint">o</span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  )}

                  {conMagicLink && (
                    <form onSubmit={enviarMagicLink} className={`login-entra [--retraso:280ms] flex flex-col gap-3 ${conGoogle ? "" : "mt-8"}`} noValidate>
                      <FormField id={idCorreo} label={<span className="sr-only">Tu correo</span>}>
                        {(campo) => (
                          <input
                            {...campo}
                            type="email"
                            placeholder={placeholderCorreo}
                            autoComplete="email"
                            aria-required="true"
                            aria-invalid={errorCorreo ? true : undefined}
                            aria-describedby={errorCorreo ? idAlerta : undefined}
                            value={correo}
                            onChange={(e) => setCorreo(e.target.value)}
                            className="login-campo"
                          />
                        )}
                      </FormField>
                      <button type="submit" disabled={enviando} aria-busy={enviando || undefined} className="login-btn login-btn-tinta mt-1">
                        <span aria-hidden className="login-glifo">
                          <AtiendeMark className="h-[17px] w-auto brightness-0 invert" />
                        </span>
                        <EtiquetaBoton ocupado={enviando} reposo="Continuar con correo" enCurso="Enviando…" />
                      </button>
                    </form>
                  )}

                  {/* Ranura de ALTURA FIJA para el resultado: idle, enviando, enviado, error y reenviar ocupan el mismo espacio (CLS 0). */}
                  <div className="login-estado" data-estado={avisoEnviado ? "enviado" : alerta ? "error" : "reposo"}>
                    {avisoEnviado && (
                      <div role="status">
                        <p className="login-cuerpo font-semibold text-foreground">Te mandamos un enlace a tu correo.</p>
                        <p className="truncate text-sm text-muted-foreground">
                          Enviado a <span className="font-semibold text-foreground">{avisoEnviado}</span>
                        </p>
                        <p className="truncate text-ui text-faint">Ábrelo en este dispositivo · expira en 15 minutos.</p>
                      </div>
                    )}
                    {alerta && (
                      <p id={idAlerta} role="alert" className="line-clamp-3 text-sm text-destructive">
                        {alerta}
                      </p>
                    )}
                  </div>

                  {conOlvido && (
                    <button type="button" onClick={() => setModoOlvido(true)} className="login-entra [--retraso:300ms] mt-2 text-sm underline underline-offset-2 text-foreground transition-opacity hover:opacity-70">
                      ¿Olvidaste tu contraseña?
                    </button>
                  )}
                </>
              )}

              <p className="login-entra [--retraso:320ms] login-pie mt-5 text-pretty text-sm leading-relaxed text-muted-foreground">
                {pie ?? (
                  <>
                    ¿Tu correo no tiene acceso? <span className="font-semibold text-foreground">Pídele a tu negocio que te dé de alta.</span>
                  </>
                )}
              </p>

              <p className="login-entra [--retraso:360ms] login-legales mt-6 text-pretty text-xs leading-[1.7] text-faint">
                Al continuar, aceptas los{" "}
                <a href="/terminos" className="underline underline-offset-2 text-foreground transition-opacity hover:opacity-70">
                  Términos de Servicio
                </a>{" "}
                y el{" "}
                <a href="/privacidad" className="underline underline-offset-2 text-foreground transition-opacity hover:opacity-70">
                  Aviso de Privacidad
                </a>{" "}
                de atiende.ai.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Lámina: `hidden lg:flex` como Likida (:496): por debajo de 1024 px no se pinta ni se descarga. */}
      <aside className="login-aside hidden lg:flex lg:flex-col lg:pl-6 lg:pr-10">
        <figure className="login-lamina min-h-0 flex-1">
          <img src={`${import.meta.env.BASE_URL}${hero.imagen}`} alt={hero.alt} className="login-foto" />
          <div className="login-velo" />
          <figcaption className="absolute inset-x-0 bottom-0 p-9">
            <p className="login-kicker login-kicker-foto">{hero.kicker}</p>
            <p className="login-serif login-titular-foto foto-texto mt-3.5">{hero.texto}</p>
          </figcaption>
        </figure>
      </aside>
    </main>
  );
}
