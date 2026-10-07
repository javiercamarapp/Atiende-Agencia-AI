// "¿Olvidaste tu contraseña?" dentro de la pantalla de login de las 6 verticales (PL-21). Pide el correo y llama
// a POST /auth/password-reset/solicitar, que responde SIEMPRE el mismo 200 exista o no la cuenta (anti-
// enumeracion): por eso el aviso de exito es uniforme ("Si <correo> tiene una cuenta...") y nunca confirma que
// la cuenta existe. Los errores reales del servidor (correo invalido, demasiados intentos, red) SI se muestran.
// Mismo lenguaje visual que el resto del login (`login-campo`, `login-btn`, medidas de Likida).
import { useId, useState } from "react";
import type { FormEvent } from "react";
import { FormField } from "@atiende/ui";
import { EtiquetaBoton } from "../../components/EtiquetaBoton.tsx";
import { solicitarRestablecerContrasena } from "./cuenta-client.ts";
import type { VerticalCuenta } from "./cuenta-client.ts";

export interface OlvidoContrasenaProps {
  readonly apiBaseUrl: string;
  readonly vertical: VerticalCuenta;
  /** Correo ya escrito en el formulario de acceso, para no pedirlo dos veces. */
  readonly correoInicial?: string;
  readonly locale?: "es" | "en";
  readonly onVolver: () => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function OlvidoContrasena({ apiBaseUrl, vertical, correoInicial = "", locale = "es", onVolver }: OlvidoContrasenaProps) {
  const tr = (es: string, en: string) => locale === "en" ? en : es;
  const [correo, setCorreo] = useState(correoInicial);
  const [errorCorreo, setErrorCorreo] = useState<string | null>(null);
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [enviadoA, setEnviadoA] = useState<string | null>(null);
  const idAlerta = `${useId()}-alerta`;

  async function enviar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (enviando) return;
    if (!EMAIL_RE.test(correo.trim())) {
      setErrorCorreo(tr("Escribe un correo válido, por ejemplo tu@negocio.com.", "Enter a valid email, such as you@business.com."));
      return;
    }
    setErrorCorreo(null);
    setErrorEnvio(null);
    setEnviadoA(null);
    setEnviando(true);
    try {
      await solicitarRestablecerContrasena(fetch, apiBaseUrl, correo, vertical);
      setEnviadoA(correo.trim());
    } catch (err) {
      setErrorEnvio(err instanceof Error ? err.message : "No se pudo solicitar el enlace. Intenta de nuevo en unos minutos.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="login-entra login-olvido mt-8 flex flex-col gap-3">
      <div>
        <p className="login-cuerpo font-semibold text-foreground">{tr("Restablece tu contraseña", "Reset your password")}</p>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{tr("Escribe tu correo y, si tiene una cuenta, te enviamos un enlace para elegir otra.", "Enter your email. If it has an account, we’ll send a password reset link.")}</p>
      </div>

      <form onSubmit={enviar} className="flex flex-col gap-3" noValidate>
        <FormField label={<span className="sr-only">{tr("Tu correo", "Your email")}</span>}>
          {(campo) => <input {...campo} type="email" placeholder="tu@negocio.com" autoComplete="email" aria-required="true" aria-invalid={errorCorreo ? true : undefined} aria-describedby={errorCorreo ? idAlerta : undefined} value={correo} onChange={(e) => setCorreo(e.target.value)} className="login-campo" />}
        </FormField>
        <button type="submit" disabled={enviando} aria-busy={enviando || undefined} className="login-btn login-btn-tinta mt-1">
          <EtiquetaBoton ocupado={enviando} reposo={tr("Enviarme el enlace", "Send me a link")} enCurso={tr("Enviando…", "Sending…")} />
        </button>
      </form>

      {/* Ranura de altura fija (como el login): aviso de enviado y errores ocupan el mismo espacio y no mueven el formulario. */}
      <div className="login-estado">
        {enviadoA && !errorCorreo && !errorEnvio && (
          <div role="status">
            <p className="login-cuerpo font-semibold text-foreground">{tr("Revisa tu correo.", "Check your email.")}</p>
            <p className="line-clamp-2 text-sm text-muted-foreground">
              {tr("Si", "If")} <span className="break-all font-semibold text-foreground">{enviadoA}</span> {tr("tiene una cuenta, te enviamos un enlace. Expira en 1 hora y solo funciona una vez.", "has an account, we sent a link. It expires in 1 hour and can be used once.")}
            </p>
          </div>
        )}
        {(errorCorreo || errorEnvio) && (
          <p id={idAlerta} role="alert" className="line-clamp-3 text-sm text-destructive">
            {errorCorreo ?? errorEnvio}
          </p>
        )}
      </div>

      <button type="button" onClick={onVolver} className="self-start text-sm underline underline-offset-2 text-foreground transition-opacity hover:opacity-70">
        {tr("Volver a iniciar sesión", "Back to sign in")}
      </button>
    </div>
  );
}
