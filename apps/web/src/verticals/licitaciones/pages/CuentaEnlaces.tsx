// Paginas PUBLICAS de los enlaces de correo de la cuenta de licitaciones (L-02):
//  - `/licitaciones/restablecer-contrasena?token=...`  (enlace de "olvide mi contrasena")
//  - `/licitaciones/verificar-correo?token=...`        (enlace de verificacion de correo)
// El canje es SIEMPRE un POST desde aqui (un escaner de correo que abre el enlace con GET no lo
// consume) y el servidor decide: los tokens son de un solo uso, vencen y no se distingue "ya usado" de
// "vencido" (mismo mensaje). El token se guarda en memoria y se quita de la URL al montar, para que no
// quede en el historial ni viaje en un `Referer`.
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import { AtiendeWordmark, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, Input, Label } from "@atiende/ui";
import { confirmarRestablecerContrasena, confirmarVerificacionCorreo, validarNuevaContrasena } from "../lib/cuenta-client.ts";
import { LICITACIONES_TAB_TITLE } from "../lib/brand.ts";

function PaginaPublica({ titulo, descripcion, children }: { readonly titulo: string; readonly descripcion?: string; readonly children: ReactNode }) {
  useEffect(() => {
    document.title = LICITACIONES_TAB_TITLE;
  }, []);
  return (
    <main className="flex min-h-screen flex-col items-center gap-8 bg-background px-6 py-12">
      <AtiendeWordmark />
      <Card className="w-full max-w-[420px]">
        <CardHeader>
          <CardTitle className="text-lg">{titulo}</CardTitle>
          {descripcion && <CardDescription>{descripcion}</CardDescription>}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
    </main>
  );
}

/** Lee `?token=` una sola vez y lo quita de la barra de direcciones. */
function useTokenDeLaUrl(): string {
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token") ?? "");
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }, []);
  return token;
}

export function RestablecerContrasenaPage({ apiBaseUrl }: { readonly apiBaseUrl: string }) {
  const token = useTokenDeLaUrl();
  const [nueva, setNueva] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState(false);

  async function enviar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      <PaginaPublica titulo="Enlace incompleto">
        <p className="text-[13px] text-muted-foreground">Este enlace no trae el código para restablecer tu contraseña. Abre el enlace completo del correo o pide uno nuevo desde Seguridad de tu cuenta.</p>
        <Link to="/licitaciones/login" className="text-[13px] underline underline-offset-2">
          Ir a iniciar sesión
        </Link>
      </PaginaPublica>
    );
  }

  if (listo) {
    return (
      <PaginaPublica titulo="Contraseña actualizada">
        <p role="status" className="text-[13px] text-foreground">
          Listo. Por seguridad se cerraron todas tus sesiones: inicia sesión de nuevo (con Google o con un enlace por correo).
        </p>
        <Link to="/licitaciones/login" className="text-[13px] underline underline-offset-2">
          Ir a iniciar sesión
        </Link>
      </PaginaPublica>
    );
  }

  return (
    <PaginaPublica titulo="Elige una contraseña nueva" descripcion="El enlace funciona una sola vez y expira a la hora de pedirlo.">
      <form onSubmit={(e) => void enviar(e)} className="flex flex-col gap-3">
        {error && <EstadoError mensaje={error} />}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="restablecer-nueva">Contraseña nueva (mínimo 8 caracteres)</Label>
          <Input id="restablecer-nueva" type="password" autoComplete="new-password" value={nueva} onChange={(e) => setNueva(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="restablecer-confirmar">Repite la contraseña nueva</Label>
          <Input id="restablecer-confirmar" type="password" autoComplete="new-password" value={confirmacion} onChange={(e) => setConfirmacion(e.target.value)} />
        </div>
        <Button type="submit" disabled={ocupado}>
          {ocupado ? "Guardando…" : "Guardar contraseña"}
        </Button>
      </form>
    </PaginaPublica>
  );
}

export function VerificarCorreoPage({ apiBaseUrl }: { readonly apiBaseUrl: string }) {
  const token = useTokenDeLaUrl();
  const [estado, setEstado] = useState<"cargando" | "ok" | "error">(token ? "cargando" : "error");
  const [error, setError] = useState<string | null>(token ? null : "Este enlace no trae el código de verificación. Abre el enlace completo del correo.");
  // React StrictMode monta el efecto dos veces en desarrollo: el token es de un solo uso, un segundo
  // canje fallaria espuriamente.
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
    <PaginaPublica titulo="Verificación de correo">
      {estado === "cargando" && <EstadoCargando etiqueta="Verificando tu correo…" />}
      {estado === "ok" && (
        <p role="status" className="text-[13px] text-foreground">
          Tu correo quedó verificado.
        </p>
      )}
      {estado === "error" && <EstadoError mensaje={error ?? "No se pudo verificar el correo."} />}
      <Link to="/licitaciones/login" className="text-[13px] underline underline-offset-2">
        Ir a iniciar sesión
      </Link>
    </PaginaPublica>
  );
}
