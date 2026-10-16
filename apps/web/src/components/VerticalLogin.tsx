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
import { LoginArtwork, LOGIN_STORIES } from "./LoginArtwork.tsx";
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
  /** Nombre visible en el titulo: "{tr("Bienvenido a atiende", "Welcome to atiende")} {en ? englishNames[vertical] ?? nombre : nombre}". */
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
  const [searchParams, setSearchParams] = useSearchParams();
  const locale = searchParams.get("lang") === "en" ? "en" : "es";
  const en = locale === "en";
  const tr = (es: string, english: string) => en ? english : es;
  const englishNames: Record<string, string> = { restaurantes: "restaurants", hoteles: "hotels", rentas: "vacation rentals", despachos: "accounting firms", licitaciones: "tenders", citas: "appointments" };
  const englishDescriptions: Record<string, string> = {
    restaurantes: "Your restaurant’s operations, in one place.", hoteles: "Your hotel’s reservations, guests and daily operations.", rentas: "Your properties, stays and teams, connected.", despachos: "Your clients, documents and accounting workflows.", licitaciones: "Your opportunities, requirements and deadlines.", citas: "Your availability, bookings and customer follow-up.",
  };
  function changeLocale(next: "es" | "en") {
    const params = new URLSearchParams(searchParams);
    params.set("lang", next);
    setSearchParams(params, { replace: true });
  }
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
  const avisoGoogle = comprobandoGoogle ? tr("Comprobando Google…", "Checking Google…") : tr("Google: pendiente de configurar en este entorno.", "Google sign-in is not configured in this environment.");

  function irAGoogle() {
    if (!googleHabilitado) return;
    window.location.href = urlIniciarGoogleLogin(apiBaseUrl, vertical);
  }

  async function enviarMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (enviando) return;
    if (!esCorreoValido(correo)) {
      // Un solo mensaje en la ranura: si antes se envio bien, el aviso de "enviado" se retira para que el error sea el unico visible.
      setEnviadoA(null);
      setErrorEnvio(null);
      setErrorCorreo(tr("Escribe un correo válido, por ejemplo tu@negocio.com.", "Enter a valid email, such as you@business.com."));
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

  const story = LOGIN_STORIES[vertical];
  const englishStories: Record<string, { title: string; description: string }> = {
    restaurantes: { title: "Every order. Your whole operation.", description: "Conversations, orders and customers in one place. Your team has the context to carry every service through to completion." },
    hoteles: { title: "A coordinated stay, from start to finish.", description: "Reservations, reception and service connected. Every request reaches the right team, with each guest’s history at hand." },
    rentas: { title: "Your properties. One connected operation.", description: "Calendars, guests and maintenance share the same context. Follow every stay with visibility across your portfolio." },
    despachos: { title: "Fewer loose ends. More clarity for your firm.", description: "Documents, reconciliations and closing in one workflow. Your team reviews exceptions and stays in control of every client." },
    licitaciones: { title: "From opportunity to the next step.", description: "Requirements, documents and dates with clear owners. Follow every tender with the information your team needs to decide." },
    citas: { title: "Your schedule, organized. Your customers, cared for.", description: "Availability, appointments and follow-up connected. Coordinate your team and keep the context of every visit." },
  };
  const displayStory = en ? englishStories[vertical] ?? story : story;

  // El formulario mantiene sus estados y su orden de teclado; la lámina editorial es complementaria.
  return (
    <main className="login login-pantalla login-editorial lg:grid lg:grid-cols-2" data-vertical={vertical} lang={locale}>
      <section className="login-seccion flex flex-col px-6 sm:px-10 lg:px-14">
        <div className="mx-auto flex w-full max-w-[530px] flex-1 flex-col">
          <header className="login-entra login-access-header flex items-center">
            <AtiendeWordmark markClassName="h-6 w-auto" className="[&>span]:text-xl [&>span]:leading-6" />
            <nav className="login-locales" aria-label={tr("Idioma", "Language")}>
              <button type="button" onClick={() => changeLocale("es")} aria-current={!en ? "true" : undefined} aria-label="Español">ES</button>
              <span aria-hidden="true">/</span>
              <button type="button" onClick={() => changeLocale("en")} aria-current={en ? "true" : undefined} aria-label="English">EN</button>
            </nav>
          </header>

          <div className="login-contenido flex flex-1 items-center">
            <div className="w-full">
              <p className="login-entra [--retraso:40ms] login-kicker">{en ? "WORKSPACE ACCESS" : kicker}</p>
              <h1 className="login-entra [--retraso:90ms] login-serif login-titulo mt-5 text-foreground">{tr("Bienvenido a atiende", "Welcome to atiende")} {en ? englishNames[vertical] ?? nombre : nombre}</h1>
              {/* En "olvidé mi contraseña" el panel ya explica la pantalla: se omite la bajada para que esa vista tampoco pase del alto de la ventana. */}
              {!modoOlvido && <p className="login-entra [--retraso:140ms] login-cuerpo login-descripcion mt-4 text-muted-foreground">{en ? englishDescriptions[vertical] ?? descripcion : descripcion}</p>}

              <div className="login-entra [--retraso:180ms] login-regla mt-9 h-px bg-border" />

              {modoOlvido && esVerticalCuenta(vertical) ? (
                <OlvidoContrasena apiBaseUrl={apiBaseUrl} vertical={vertical} correoInicial={correo} locale={locale} onVolver={() => setModoOlvido(false)} />
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
                        {tr("Continuar con Google", "Continue with Google")}
                      </button>
                      {/* Sin separador (solo Google) el aviso va absoluto bajo el boton, sin ocupar lugar. */}
                      {!googleHabilitado && !conMagicLink && <p className="login-aviso-google absolute inset-x-0 top-full mt-1 text-xs leading-none text-muted-foreground">{avisoGoogle}</p>}
                    </div>
                  )}

                  {conGoogle && conMagicLink && (
                    <div className="login-entra [--retraso:250ms] login-separador relative my-6 flex items-center gap-4">
                      <span className="h-px flex-1 bg-border" />
                      <span className="text-ui lowercase text-faint">{tr("o", "or")}</span>
                      <span className="h-px flex-1 bg-border" />
                      {/* El aviso "Google pendiente / comprobando" se pinta SOBRE el separador (absoluto, con el fondo de la pagina): aparece y desaparece al cargar sin empujar nada. */}
                      {!googleHabilitado && (
                        <p className="login-aviso-google absolute inset-0 flex items-center justify-center">
                          <span className="bg-background px-2 text-xs leading-none text-muted-foreground">{avisoGoogle}</span>
                        </p>
                      )}
                    </div>
                  )}

                  {conMagicLink && (
                    <form onSubmit={enviarMagicLink} className={`login-entra [--retraso:280ms] flex flex-col gap-3 ${conGoogle ? "" : "mt-8"}`} noValidate>
                      <FormField id={idCorreo} label={<span className="sr-only">{tr("Tu correo", "Your email")}</span>}>
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
                        <EtiquetaBoton ocupado={enviando} reposo={tr("Continuar con correo", "Continue with email")} enCurso={tr("Enviando…", "Sending…")} />
                      </button>
                    </form>
                  )}

                  {/* Ranura de ALTURA FIJA para el resultado: idle, enviando, enviado, error y reenviar ocupan el mismo espacio (CLS 0). */}
                  {(conMagicLink || alerta) && (
                    <div className="login-estado" data-estado={avisoEnviado ? "enviado" : alerta ? "error" : "reposo"}>
                      {avisoEnviado && (
                        <div role="status">
                          <p className="login-cuerpo font-semibold text-foreground">{tr("Te mandamos un enlace a tu correo.", "We sent a link to your email.")}</p>
                          <p className="truncate text-sm text-muted-foreground">
                            {tr("Enviado a", "Sent to")} <span className="font-semibold text-foreground">{avisoEnviado}</span>
                          </p>
                          <p className="truncate text-ui text-faint">{tr("Ábrelo en este dispositivo · expira en 15 minutos.", "Open it on this device · expires in 15 minutes.")}</p>
                        </div>
                      )}
                      {alerta && (
                        <p id={idAlerta} role="alert" className="line-clamp-3 text-sm text-destructive">
                          {alerta}
                        </p>
                      )}
                    </div>
                  )}

                  {conOlvido && (
                    <button type="button" onClick={() => setModoOlvido(true)} className="login-entra [--retraso:300ms] mt-2 text-sm underline underline-offset-2 text-foreground transition-opacity hover:opacity-70">
                      {tr("¿Olvidaste tu contraseña?", "Forgot your password?")}
                    </button>
                  )}
                </>
              )}

              <p className="login-entra [--retraso:320ms] login-pie mt-5 text-pretty text-sm leading-relaxed text-muted-foreground">
                {(!en && pie) || (
                  <>
                    {tr("¿Tu correo no tiene acceso?", "No access with this email?")} <span className="font-semibold text-foreground">{tr("Pídele a tu negocio que te dé de alta.", "Ask your business to add you.")}</span>
                  </>
                )}
              </p>

              <p className="login-entra [--retraso:360ms] login-legales mt-6 text-pretty text-xs leading-[1.7] text-faint">
                {tr("Al continuar, aceptas los", "By continuing, you accept the")}{" "}
                <a href="/terminos" className="underline underline-offset-2 text-foreground transition-opacity hover:opacity-70">
                  {tr("Términos de Servicio", "Terms of Service")}
                </a>{" "}
                {tr("y el", "and the")}{" "}
                <a href="/privacidad" className="underline underline-offset-2 text-foreground transition-opacity hover:opacity-70">
                  {tr("Aviso de Privacidad", "Privacy Notice")}
                </a>{" "}
                {tr("de atiende.ai.", "of atiende.ai.")}
              </p>
            </div>
          </div>
        </div>
      </section>

      <aside className="login-aside login-story-panel hidden lg:flex lg:flex-col" aria-label={`Atiende ${nombre}`}>
        <div className="login-story-surface">
          <div className="login-story-copy">
            <p className="login-kicker">Atiende · {en ? englishNames[vertical] ?? nombre : nombre}</p>
            <h2 className="login-serif">{displayStory?.title ?? hero.kicker}</h2>
            <p className="login-story-description">{displayStory?.description ?? hero.texto}</p>
          </div>
          {story ? <LoginArtwork vertical={vertical} /> : <img src={`${import.meta.env.BASE_URL}${hero.imagen}`} alt={hero.alt} className="login-foto" />}
        </div>
      </aside>
    </main>
  );
}
