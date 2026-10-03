// "¿Olvidaste tu contraseña?" dentro de la pantalla de login de las 6 verticales (PL-21). Pide el correo y llama
// a POST /auth/password-reset/solicitar, que responde SIEMPRE el mismo 200 exista o no la cuenta (anti-
// enumeracion): por eso el aviso de exito es uniforme ("Si <correo> tiene una cuenta...") y nunca confirma que
// la cuenta existe. Los errores reales del servidor (correo invalido, demasiados intentos, red) SI se muestran.
// Mismo lenguaje visual que el resto del login (`login-campo`, `login-btn`, medidas de Likida).
import { useState } from "react";
import type { FormEvent } from "react";
import { FormField } from "@atiende/ui";
import { solicitarRestablecerContrasena } from "./cuenta-client.ts";
import type { VerticalCuenta } from "./cuenta-client.ts";

export interface OlvidoContrasenaProps {
  readonly apiBaseUrl: string;
  readonly vertical: VerticalCuenta;
  /** Correo ya escrito en el formulario de acceso, para no pedirlo dos veces. */
  readonly correoInicial?: string;
  readonly onVolver: () => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function OlvidoContrasena({ apiBaseUrl, vertical, correoInicial = "", onVolver }: OlvidoContrasenaProps) {
  const [correo, setCorreo] = useState(correoInicial);
  const [errorCorreo, setErrorCorreo] = useState<string | null>(null);
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [enviadoA, setEnviadoA] = useState<string | null>(null);

  async function enviar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (enviando) return;
    if (!EMAIL_RE.test(correo.trim())) {
      setErrorCorreo("Escribe un correo válido, por ejemplo tu@negocio.com.");
      return;
    }
    setErrorCorreo(null);
    setErrorEnvio(null);
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
    <div className="login-entra mt-8 flex flex-col gap-3">
      <div>
        <p className="login-cuerpo font-semibold text-foreground">Restablece tu contraseña</p>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">Escribe tu correo y, si tiene una cuenta, te enviamos un enlace para elegir una contraseña nueva.</p>
      </div>

      {enviadoA && (
        <div role="status" className="rounded-[18px] border border-border bg-muted p-5">
          <p className="login-cuerpo font-semibold text-foreground">Revisa tu correo.</p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            Si <span className="font-semibold text-foreground">{enviadoA}</span> tiene una cuenta, te enviamos un enlace para elegir una contraseña nueva. Expira en 1 hora y solo funciona una vez.
          </p>
        </div>
      )}

      <form onSubmit={enviar} className="flex flex-col gap-3" noValidate>
        <FormField label={<span className="sr-only">Tu correo</span>} error={errorCorreo ?? undefined}>
          {(campo) => <input {...campo} type="email" placeholder="tu@negocio.com" autoComplete="email" aria-required="true" value={correo} onChange={(e) => setCorreo(e.target.value)} className="login-campo" />}
        </FormField>
        <button type="submit" disabled={enviando} aria-busy={enviando || undefined} className="login-btn login-btn-tinta mt-1">
          {enviando ? "Enviando…" : "Enviarme el enlace"}
        </button>
      </form>

      {errorEnvio && (
        <p role="alert" className="text-sm text-destructive">
          {errorEnvio}
        </p>
      )}

      <button type="button" onClick={onVolver} className="self-start text-sm underline underline-offset-2 text-foreground transition-opacity hover:opacity-70">
        Volver a iniciar sesión
      </button>
    </div>
  );
}
