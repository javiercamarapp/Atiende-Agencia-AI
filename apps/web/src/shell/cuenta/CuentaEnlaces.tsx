// Paginas PUBLICAS de los enlaces de correo de la cuenta, compartidas por las 6 verticales (PL-21):
//  - `/<vertical>/restablecer-contrasena?token=...`  (enlace de "olvide mi contrasena")
//  - `/<vertical>/verificar-correo?token=...`        (enlace de verificacion de correo)
// El canje es SIEMPRE un POST desde aqui (un escaner de correo que abre el enlace con GET no lo consume) y el
// servidor decide: los tokens son de un solo uso, vencen y no se distingue "ya usado" de "vencido" (mismo
// mensaje). El token se guarda en memoria y se quita de la URL al montar, para que no quede en el historial ni
// viaje en un `Referer`. Marco visual: `MarcoPublico` (lienzo gris tenue + tarjeta, medidas de Likida).
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, EstadoCargando, EstadoError, FormField, Input } from "@atiende/ui";
import { MarcoPublico } from "../../components/MarcoPublico.tsx";
import { confirmarRestablecerContrasena, confirmarVerificacionCorreo, validarNuevaContrasena } from "./cuenta-client.ts";
import type { VerticalCuenta } from "./cuenta-client.ts";

export interface CuentaEnlacesProps {
  readonly apiBaseUrl: string;
  readonly vertical: VerticalCuenta;
}

/** Lee `?token=` una sola vez y lo quita de la barra de direcciones. */
function useTokenDeLaUrl(): string {
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token") ?? "");
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }, []);
  return token;
}

function IrAIniciarSesion({ vertical }: { readonly vertical: VerticalCuenta }) {
  return (
    <Link to={`/${vertical}/login`} className="text-sm underline underline-offset-2">
      Ir a iniciar sesión
    </Link>
  );
}

export function RestablecerContrasenaPage({ apiBaseUrl, vertical }: CuentaEnlacesProps) {
  const token = useTokenDeLaUrl();
  const [nueva, setNueva] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState(false);

  async function enviar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ocupado) return;
    const invalida = validarNuevaContrasena(nueva, confirmacion);
    if (invalida) {
      setError(invalida);
      return;
    }
    setOcupado(true);
    setError(null);
    try {
      await confirmarRestablecerContrasena(fetch, apiBaseUrl, token, nueva);
      setListo(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo restablecer la contraseña.");
    } finally {
      setOcupado(false);
    }
  }

  if (!token) {
    return (
      <MarcoPublico titulo="Enlace incompleto">
        <p className="text-sm text-muted-foreground">Este enlace no trae el código para restablecer tu contraseña. Abre el enlace completo del correo o pide uno nuevo desde «¿Olvidaste tu contraseña?» en el inicio de sesión.</p>
        <IrAIniciarSesion vertical={vertical} />
      </MarcoPublico>
    );
  }

  if (listo) {
    return (
      <MarcoPublico titulo="Contraseña actualizada">
        <p role="status" className="text-sm text-foreground">
          Listo. Por seguridad se cerraron todas tus sesiones: inicia sesión de nuevo (con Google o con un enlace por correo).
        </p>
        <IrAIniciarSesion vertical={vertical} />
      </MarcoPublico>
    );
  }

  return (
    <MarcoPublico titulo="Elige una contraseña nueva" descripcion="El enlace funciona una sola vez y expira a la hora de pedirlo.">
      <form onSubmit={(e) => void enviar(e)} className="flex flex-col gap-3" noValidate>
        {error && <EstadoError mensaje={error} compacto />}
        <FormField label="Contraseña nueva (mínimo 8 caracteres)" required>
          <Input id="restablecer-nueva" type="password" autoComplete="new-password" value={nueva} onChange={(e) => setNueva(e.target.value)} />
        </FormField>
        <FormField label="Repite la contraseña nueva" required>
          <Input id="restablecer-confirmar" type="password" autoComplete="new-password" value={confirmacion} onChange={(e) => setConfirmacion(e.target.value)} />
        </FormField>
        <Button type="submit" loading={ocupado}>
          Guardar contraseña
        </Button>
      </form>
    </MarcoPublico>
  );
}

export function VerificarCorreoPage({ apiBaseUrl, vertical }: CuentaEnlacesProps) {
  const token = useTokenDeLaUrl();
  const [estado, setEstado] = useState<"cargando" | "ok" | "error">(token ? "cargando" : "error");
  const [error, setError] = useState<string | null>(token ? null : "Este enlace no trae el código de verificación. Abre el enlace completo del correo.");
  // React StrictMode monta el efecto dos veces en desarrollo: el token es de un solo uso, un segundo canje
  // fallaria espuriamente.
  const yaCanjeado = useRef(false);

  useEffect(() => {
    if (!token || yaCanjeado.current) return;
    yaCanjeado.current = true;
    confirmarVerificacionCorreo(fetch, apiBaseUrl, token)
      .then(() => setEstado("ok"))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "No se pudo verificar el correo.");
        setEstado("error");
      });
  }, [apiBaseUrl, token]);

  return (
    <MarcoPublico titulo="Verificación de correo">
      {estado === "cargando" && <EstadoCargando etiqueta="Verificando tu correo…" />}
      {estado === "ok" && (
        <p role="status" className="text-sm text-foreground">
          Tu correo quedó verificado.
        </p>
      )}
      {estado === "error" && <EstadoError mensaje={error ?? "No se pudo verificar el correo."} compacto />}
      <IrAIniciarSesion vertical={vertical} />
    </MarcoPublico>
  );
}
