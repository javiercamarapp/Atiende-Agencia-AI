// Inicio de sesion ds3: la pantalla de Rovaq AI (app/(app)/login de Rovaq, que a su vez salio del login de Atiende)
// con la paleta de Atiende. Misma composicion y medidas: >= 1024 px dos columnas iguales, panel oscuro a la IZQUIERDA
// (radio 24, esfera de particulas que sigue al puntero) y formulario a la derecha a 470 px; en movil, solo el formulario.
// Orden de Rovaq: logo + ES/EN, kicker, H1, bajada, filete, Google, «o», correo + boton en tinta (enlace con espera de
// 60 s para reenviar), ayuda en <details>, «Pide una invitación», nota al pie. Decision del dueno (6-nov): SOLO enlace por
// correo y Google, sin contrasena, exactamente como Rovaq. Quien hoy tiene contrasena entra igual con el enlace a su mismo
// correo (POST /auth/magic-link/iniciar solo envia a cuentas existentes, nunca crea una) o con Google (vincula por correo
// verificado). Se conserva el pie propio de cada vertical (alta en rentas, acceso de repartidor en restaurantes). Siempre en
// tema claro, como Rovaq. El copy por vertical vive en login-ds3-copia.ts.
import { useEffect, useId, useLayoutEffect, useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { aplicarTema, AtiendeMark, AtiendeWordmark, FormField, GoogleIcon, leerIdioma, leerTema, useI18n } from "@atiende/ui";
import { LoginArtwork } from "./LoginArtwork.tsx";
import { iniciarMagicLink, mensajeGoogleError, mensajeMagicLinkError, urlIniciarGoogleLogin, verificarGoogleConfigurado } from "../lib/google-auth.ts";
import { esCorreoValido, useEscritorio, type VerticalLoginProps } from "./login-comun.ts";
import { copiaLoginDs3 } from "./login-ds3-copia.ts";
import "../pages/login.css";
import "../pages/login-ds3.css";

/** Segundos de espera antes de poder pedir otro enlace (Rovaq: «Reintentar en N s»). */
export const ESPERA_REENVIO_S = 60;

/** Segundos siempre con dos cifras de ancho (un espacio de cifra delante de 1-9): el texto no cambia de ancho al contar. */
export function segundosVisibles(n: number): string {
  return n < 10 ? `\u2007${n}` : String(n);
}

/** El login es siempre claro (Rovaq: `color-scheme: light`): quita `dark` mientras la pantalla vive y repone el tema guardado al salir. */
function useTemaClaro(): void {
  useLayoutEffect(() => {
    const raiz = document.documentElement;
    if (!raiz.classList.contains("dark")) return undefined;
    raiz.classList.remove("dark");
    return () => {
      aplicarTema(leerTema());
    };
  }, []);
}

export function VerticalLoginDs3({ apiBaseUrl, vertical, nombre, descripcion, kicker = "Acceso al panel", placeholderCorreo = "tu@negocio.com", metodos, hero, pie }: VerticalLoginProps) {
  useTemaClaro();
  const conGoogle = metodos?.google ?? true;
  const conMagicLink = metodos?.magicLink ?? true;
  const [correo, setCorreo] = useState("");
  const [errorCorreo, setErrorCorreo] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [enviadoA, setEnviadoA] = useState<string | null>(null);
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null);
  // Espera de reenvio por fecha limite (no por cuenta de ticks): sobrevive a pestanas en segundo plano y a relojes simulados.
  const [hasta, setHasta] = useState(0);
  const [ahora, setAhora] = useState(() => Date.now());
  const espera = Math.max(0, Math.ceil((hasta - ahora) / 1000));
  const [searchParams, setSearchParams] = useSearchParams();
  // i18n: `?lang=` manda en esta pantalla; sin el, la preferencia guardada. Solo el clic en ES/EN la guarda (cambiarIdioma).
  const { cambiarIdioma: guardarIdiomaElegido } = useI18n();
  const lang = searchParams.get("lang");
  const locale = lang === "en" || lang === "es" ? lang : leerIdioma();
  const en = locale === "en";
  const tr = (es: string, english: string) => (en ? english : es);
  const escritorio = useEscritorio();
  const copia = copiaLoginDs3(vertical, { nombre, descripcion, kicker: hero.kicker, texto: typeof hero.texto === "string" ? hero.texto : "" });
  const idBase = useId();
  const idCorreo = `${idBase}-correo`;
  const idAlerta = `${idBase}-alerta`;
  const idDisponibilidad = `${idBase}-google`;
  const [googleConfigurado, setGoogleConfigurado] = useState(false);
  const [comprobandoGoogle, setComprobandoGoogle] = useState(conGoogle);

  useEffect(() => {
    if (!conGoogle) return undefined;
    let vivo = true;
    void verificarGoogleConfigurado(apiBaseUrl).then((ok) => {
      if (vivo) {
        setGoogleConfigurado(ok);
        setComprobandoGoogle(false);
      }
    });
    return () => {
      vivo = false;
    };
  }, [apiBaseUrl, conGoogle]);

  // Cuenta regresiva del reenvio: se refresca cada segundo mientras falte tiempo.
  useEffect(() => {
    if (hasta <= ahora) return undefined;
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasta, ahora]);

  function cambiarIdioma(siguiente: "es" | "en") {
    const params = new URLSearchParams(searchParams);
    params.set("lang", siguiente);
    setSearchParams(params, { replace: true });
    guardarIdiomaElegido(siguiente);
  }

  const googleHabilitado = conGoogle && googleConfigurado && !comprobandoGoogle;
  const avisoGoogle = comprobandoGoogle ? tr("Comprobando Google…", "Checking Google…") : tr("Google: pendiente de configurar en este entorno.", "Google sign-in is not configured in this environment.");

  function irAGoogle() {
    if (!googleHabilitado) return;
    window.location.href = urlIniciarGoogleLogin(apiBaseUrl, vertical);
  }

  async function enviarMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (enviando || espera > 0) return;
    if (!esCorreoValido(correo)) {
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
        setErrorEnvio(resultado.error ?? tr("No se pudo enviar el enlace. Intenta de nuevo.", "We couldn’t send the link. Try again."));
        return;
      }
      setEnviadoA(correo.trim());
      const t = Date.now();
      setAhora(t);
      setHasta(t + ESPERA_REENVIO_S * 1000);
    } finally {
      setEnviando(false);
    }
  }

  const googleError = searchParams.get("google_error");
  const magicLinkError = searchParams.get("magic_link_error");
  const alertaExterna = googleError ? mensajeGoogleError(googleError) : magicLinkError ? mensajeMagicLinkError(magicLinkError) : null;
  const errorFormulario = errorCorreo ?? errorEnvio;

  return (
    <main className="login-ds3" data-vertical={vertical} lang={locale}>
      <section className="ld3-columna">
        <div className="ld3-interior">
          <header className="login-entra ld3-marca">
            <AtiendeWordmark markClassName="h-6 w-auto" className="[&>span]:text-xl [&>span]:leading-6" />
            <nav className="ld3-idiomas" aria-label={tr("Idioma", "Language")}>
              <button type="button" lang="es" onClick={() => cambiarIdioma("es")} aria-current={!en ? "true" : undefined} aria-label="Español">ES</button>
              <span aria-hidden="true">/</span>
              <button type="button" lang="en" onClick={() => cambiarIdioma("en")} aria-current={en ? "true" : undefined} aria-label="English">EN</button>
            </nav>
          </header>

          <div className="ld3-copia">
            <p className="login-entra ld3-kicker">{en ? "Workspace access" : kicker}</p>
            <h1 className="login-entra ld3-serif ld3-titulo">
              {tr("Bienvenido a atiende", "Welcome to atiende")} {en ? copia.nombreEn : nombre}
            </h1>
            <p className="login-entra ld3-intro">{en ? copia.introEn : descripcion}</p>
            <div className="ld3-divisor" />

            {alertaExterna && (
              <p className="ld3-mensaje" role="alert">
                {alertaExterna}
              </p>
            )}

            {conGoogle && (
              <div className="login-entra ld3-google">
                <button type="button" onClick={irAGoogle} disabled={!googleHabilitado} aria-describedby={!googleHabilitado ? idDisponibilidad : undefined} className="login-btn login-btn-borde">
                  <GoogleIcon />
                  {tr("Continuar con Google", "Continue with Google")}
                </button>
              </div>
            )}

            {conGoogle && conMagicLink && (
              // El texto cambia («Comprobando…» -> «o» o el aviso): un nodo nuevo por estado sobre un filete de ancho completo, asi
              // nada existente se mueve (CLS 0).
              <div className="ld3-separador">
                <p key={googleHabilitado ? "o" : avisoGoogle} id={idDisponibilidad}>
                  {googleHabilitado ? tr("o", "or") : avisoGoogle}
                </p>
              </div>
            )}

            {conMagicLink && (
              <form onSubmit={enviarMagicLink} className={`login-entra ld3-correo${conGoogle ? "" : " ld3-correo-solo"}`} aria-label={tr("Acceder por correo", "Sign in by email")} noValidate>
                <FormField id={idCorreo} label={<span className="sr-only">{tr("Correo", "Email")}</span>}>
                  {(campo) => (
                    <input
                      {...campo}
                      type="email"
                      placeholder={placeholderCorreo}
                      autoComplete="email"
                      maxLength={254}
                      aria-required="true"
                      aria-invalid={errorCorreo ? true : undefined}
                      aria-describedby={errorFormulario ? idAlerta : undefined}
                      value={correo}
                      onChange={(e) => setCorreo(e.target.value)}
                      className="login-campo"
                    />
                  )}
                </FormField>
                <button type="submit" disabled={enviando || espera > 0} aria-busy={enviando || undefined} className="login-btn login-btn-tinta">
                  <span aria-hidden className="login-glifo">
                    <AtiendeMark className="h-[17px] w-auto brightness-0 invert" />
                  </span>
                  {/* Tres textos apilados en la misma celda (solo uno visible): cambiar de estado o de segundo no mueve nada (CLS 0). */}
                  <span className="login-etiqueta">
                    <span className={enviando || espera > 0 ? "invisible" : undefined}>{tr("Continuar con correo", "Continue with email")}</span>
                    <span className={!enviando && espera > 0 ? undefined : "invisible"}>
                      {tr("Reintentar en", "Try again in")} <span className="ld3-segundos">{segundosVisibles(espera || ESPERA_REENVIO_S)}</span> s
                    </span>
                    <span className={enviando ? undefined : "invisible"}>{tr("Enviando…", "Sending…")}</span>
                  </span>
                </button>
                {/* Ranura de alto reservado (Rovaq: role=status): enviado y errores ocupan el mismo espacio, el formulario no se mueve. */}
                <div className="login-estado ld3-estado" data-estado={enviadoA && !errorFormulario ? "enviado" : errorFormulario ? "error" : "reposo"}>
                  {enviadoA && !errorFormulario && (
                    <div role="status">
                      <p className="ld3-estado-titulo">
                        {tr("Te mandamos un enlace a", "We sent a link to")} <strong>{enviadoA}</strong>.
                      </p>
                      <p>{tr("Ábrelo en este dispositivo · expira en 15 minutos.", "Open it on this device · expires in 15 minutes.")}</p>
                    </div>
                  )}
                  {errorFormulario && (
                    <p id={idAlerta} role="alert" className="ld3-estado-error">
                      {errorFormulario}
                    </p>
                  )}
                </div>
              </form>
            )}

            <details className="ld3-ayuda">
              <summary>{tr("¿Necesitas ayuda para entrar?", "Need help signing in?")}</summary>
              <p>
                {tr(
                  "No necesitas contraseña. Usa el correo con el que tu equipo te dio de alta y abre el enlace seguro que recibas, o entra con Google si es ese mismo correo. Revisa también la carpeta de correo no deseado.",
                  "No password needed. Use the email your team added and open the secure link you receive, or sign in with Google if it is that same email. Check your spam folder too.",
                )}
              </p>
            </details>

            <p className="login-pie ld3-invitacion">
              {(!en && pie) || (
                <>
                  {tr("¿Tu correo no tiene acceso?", "Does your email need access?")} <strong>{tr("Pide una invitación a tu equipo.", "Ask your team for an invitation.")}</strong>
                </>
              )}
            </p>

            <p className="login-legales ld3-nota">
              {tr(
                "Acceso reservado a equipos autorizados. Inicia sesión sin contraseña con Google o un enlace seguro en tu correo. Al continuar, aceptas los",
                "For authorized teams. Sign in without a password using Google or a secure email link. By continuing, you accept the",
              )}{" "}
              <a href="/terminos">{tr("Términos de Servicio", "Terms of Service")}</a> {tr("y el", "and the")}{" "}
              <a href="/privacidad">{tr("Aviso de Privacidad", "Privacy Notice")}</a> {tr("de atiende.ai.", "of atiende.ai.")}
            </p>
          </div>
        </div>
      </section>

      <aside className="ld3-visual" aria-label={en ? copia.kicker.en : copia.kicker.es}>
        <div className="login-story-surface ld3-superficie">
          <div className="ld3-panel-copia">
            <p className="ld3-kicker">{en ? copia.kicker.en : copia.kicker.es}</p>
            <h2 className="ld3-serif">{en ? copia.titulo.en : copia.titulo.es}</h2>
            <p className="ld3-panel-descripcion">{en ? copia.descripcion.en : copia.descripcion.es}</p>
          </div>
          {escritorio ? <LoginArtwork vertical={vertical} /> : null}
        </div>
      </aside>
    </main>
  );
}
