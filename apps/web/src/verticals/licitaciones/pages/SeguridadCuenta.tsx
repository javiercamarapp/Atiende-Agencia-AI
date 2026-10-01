// Tarjetas de "Seguridad de la cuenta" de licitaciones (L-02): correo, contrasena, Google y sesiones
// activas. El servidor es SIEMPRE la autoridad (tokens de un solo uso, expiracion, revocacion de
// refresh tokens, contrasena actual para desvincular Google); esto solo conduce el flujo y, con la
// base sin migrar (`available: false`), lo dice honestamente en vez de fingir que funciona.
import { useState } from "react";
import type { FormEvent } from "react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, Input, Label } from "@atiende/ui";
import {
  cambiarContrasena,
  cerrarOtrasSesiones,
  cerrarSesion,
  desvincularGoogle,
  describirDispositivo,
  enviarVerificacionCorreo,
  iniciarVinculoGoogle,
  solicitarRestablecerContrasena,
  validarNuevaContrasena,
} from "../lib/cuenta-client.ts";
import type { CuentaEstado, SesionesEstado } from "../lib/cuenta-client.ts";
import { revokeOtherSessions } from "../lib/two-factor-client.ts";

export interface CuentaCardProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  /** Muestra un aviso/error global de la pantalla. */
  readonly onAviso: (mensaje: string | null) => void;
  readonly onError: (mensaje: string | null) => void;
}

function fechaHora(iso: string): string {
  return new Date(iso).toLocaleString("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" });
}

function mensaje(err: unknown): string {
  return err instanceof Error ? err.message : "No se pudo completar la acción.";
}

export function CorreoCard({ apiBaseUrl, token, estado, onAviso, onError }: CuentaCardProps & { readonly estado: CuentaEstado }) {
  const [ocupado, setOcupado] = useState(false);
  if (!estado.available) {
    return null; // sin estado de la cuenta no se sabe si esta verificado: no se ofrece nada que no se pueda cumplir
  }

  async function enviar() {
    setOcupado(true);
    onError(null);
    onAviso(null);
    try {
      const r = await enviarVerificacionCorreo(fetch, apiBaseUrl, token);
      if (r.alreadyVerified) onAviso("Tu correo ya estaba verificado.");
      else if (r.sent) onAviso(`Te enviamos un enlace a ${estado.email}. Expira en 24 horas y solo funciona una vez.`);
      else onError("No pudimos enviar el correo en este momento (el envío de correo no está disponible en este ambiente). Intenta más tarde.");
    } catch (err) {
      onError(mensaje(err));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Correo
          <Badge variant={estado.emailVerified ? "secondary" : "outline"}>{estado.emailVerified ? "Verificado" : "Sin verificar"}</Badge>
        </CardTitle>
        <CardDescription>{estado.email}</CardDescription>
      </CardHeader>
      {!estado.emailVerified && (
        <CardContent className="flex flex-col gap-2">
          <p className="text-[13px] text-muted-foreground">Confirma que este correo es tuyo: te enviamos un enlace de un solo uso.</p>
          <Button size="sm" variant="outline" className="self-start" onClick={() => void enviar()} disabled={ocupado}>
            {ocupado ? "Enviando…" : "Enviar correo de verificación"}
          </Button>
        </CardContent>
      )}
    </Card>
  );
}

export function ContrasenaCard({ apiBaseUrl, token, estado, onAviso, onError }: CuentaCardProps & { readonly estado: CuentaEstado }) {
  const [actual, setActual] = useState("");
  const [nueva, setNueva] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [ocupado, setOcupado] = useState(false);

  async function cambiar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onAviso(null);
    const invalida = actual.length === 0 ? "Escribe tu contraseña actual." : validarNuevaContrasena(nueva, confirmacion, actual);
    if (invalida) {
      onError(invalida);
      return;
    }
    setOcupado(true);
    onError(null);
    try {
      await cambiarContrasena(fetch, apiBaseUrl, token, actual, nueva);
      setActual("");
      setNueva("");
      setConfirmacion("");
      onAviso("Contraseña actualizada. Se cerraron tus otras sesiones; esta sigue activa.");
    } catch (err) {
      onError(mensaje(err));
    } finally {
      setOcupado(false);
    }
  }

  async function olvide() {
    setOcupado(true);
    onError(null);
    try {
      await solicitarRestablecerContrasena(fetch, apiBaseUrl, estado.email);
      onAviso(`Si ${estado.email} tiene una cuenta, te enviamos un enlace para elegir una contraseña nueva. Expira en 1 hora.`);
    } catch (err) {
      onError(mensaje(err));
    } finally {
      setOcupado(false);
    }
  }

  // Cuenta sin contrasena (entra con Google o enlace por correo): el servidor no tiene nada que cambiar.
  if (estado.available && !estado.hasPassword) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contraseña</CardTitle>
          <CardDescription>Tu cuenta no tiene contraseña: entras con Google o con un enlace por correo.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Contraseña</CardTitle>
        <CardDescription>Al cambiarla se cierran las sesiones abiertas en otros dispositivos.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void cambiar(e)} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cuenta-pass-actual">Contraseña actual</Label>
            <Input id="cuenta-pass-actual" type="password" autoComplete="current-password" value={actual} onChange={(e) => setActual(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cuenta-pass-nueva">Contraseña nueva (mínimo 8 caracteres)</Label>
            <Input id="cuenta-pass-nueva" type="password" autoComplete="new-password" value={nueva} onChange={(e) => setNueva(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cuenta-pass-confirmar">Repite la contraseña nueva</Label>
            <Input id="cuenta-pass-confirmar" type="password" autoComplete="new-password" value={confirmacion} onChange={(e) => setConfirmacion(e.target.value)} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={ocupado}>
              {ocupado ? "Guardando…" : "Cambiar contraseña"}
            </Button>
            {estado.available && (
              <Button type="button" size="sm" variant="ghost" onClick={() => void olvide()} disabled={ocupado}>
                No recuerdo la actual: enviarme un enlace
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function GoogleCard({ apiBaseUrl, token, orgSlug, estado, onAviso, onError, onCambio }: CuentaCardProps & { readonly orgSlug: string; readonly estado: CuentaEstado; readonly onCambio: () => Promise<void> }) {
  const [ocupado, setOcupado] = useState(false);
  const [quitando, setQuitando] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const { configured, available, identities } = estado.google;

  async function vincular() {
    setOcupado(true);
    onError(null);
    onAviso(null);
    try {
      const url = await iniciarVinculoGoogle(fetch, apiBaseUrl, token, orgSlug);
      window.location.href = url;
    } catch (err) {
      onError(mensaje(err));
      setOcupado(false);
    }
  }

  async function quitar(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    if (estado.hasPassword && password.length === 0) {
      onError("Escribe tu contraseña actual para desvincular Google.");
      return;
    }
    setOcupado(true);
    onError(null);
    try {
      await desvincularGoogle(fetch, apiBaseUrl, token, id, password);
      setPassword("");
      setQuitando(null);
      onAviso("Cuenta de Google desvinculada.");
      await onCambio();
    } catch (err) {
      onError(mensaje(err));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Google</CardTitle>
        <CardDescription>Vincula tu cuenta de Google para entrar con «Continuar con Google».</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!estado.available && <p className="text-[13px] text-muted-foreground">La vinculación con Google todavía no está disponible en este ambiente.</p>}
        {estado.available && available && identities.length === 0 && <p className="text-[13px] text-muted-foreground">Todavía no hay ninguna cuenta de Google vinculada.</p>}
        {identities.map((g) => (
          <div key={g.id} className="flex flex-col gap-2 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[13px] font-medium text-foreground">{g.email}</p>
                <p className="text-xs text-muted-foreground">Vinculada el {fechaHora(g.linkedAt)}</p>
              </div>
              {quitando !== g.id && (
                <Button size="sm" variant="outline" onClick={() => setQuitando(g.id)} disabled={ocupado}>
                  Desvincular…
                </Button>
              )}
            </div>
            {quitando === g.id && (
              <form onSubmit={(e) => void quitar(e, g.id)} className="flex flex-col gap-2">
                {estado.hasPassword && (
                  <>
                    <Label htmlFor="cuenta-google-pass">Tu contraseña actual</Label>
                    <Input id="cuenta-google-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </>
                )}
                <div className="flex gap-2">
                  <Button type="submit" size="sm" variant="destructive" disabled={ocupado}>
                    Desvincular
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setQuitando(null)} disabled={ocupado}>
                    Cancelar
                  </Button>
                </div>
              </form>
            )}
          </div>
        ))}
        {estado.available && available && (
          <>
            <Button size="sm" variant="outline" className="self-start" onClick={() => void vincular()} disabled={ocupado || !configured}>
              {ocupado ? "Abriendo Google…" : "Vincular una cuenta de Google"}
            </Button>
            {!configured && <p className="text-xs text-muted-foreground">Google: pendiente de configurar en este entorno.</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function SesionesCard({
  apiBaseUrl,
  token,
  sesiones,
  onAviso,
  onError,
  onCambio,
}: CuentaCardProps & { readonly sesiones: SesionesEstado | null; readonly onCambio: () => Promise<void> }) {
  const [ocupado, setOcupado] = useState<string | null>(null);

  async function ejecutar(clave: string, fn: () => Promise<void>, exito: string) {
    setOcupado(clave);
    onError(null);
    onAviso(null);
    try {
      await fn();
      onAviso(exito);
      await onCambio();
    } catch (err) {
      onError(mensaje(err));
    } finally {
      setOcupado(null);
    }
  }

  if (!sesiones) return <EstadoCargando />;
  const otras = sesiones.sessions.filter((s) => !s.current);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sesiones activas</CardTitle>
        <CardDescription>Dispositivos con la sesión abierta. Cierra los que no reconozcas; esta sesión no se interrumpe.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {sesiones.available ? (
          <>
            {sesiones.sessions.length === 0 && <p className="text-[13px] text-muted-foreground">No hay sesiones registradas todavía. Aparecerán la próxima vez que inicies sesión.</p>}
            <ul className="flex flex-col gap-2">
              {sesiones.sessions.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
                  <div>
                    <p className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                      {describirDispositivo(s.userAgent)}
                      {s.current && <Badge variant="secondary">Este dispositivo</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Iniciada el {fechaHora(s.startedAt)} · actividad {fechaHora(s.issuedAt)}
                    </p>
                  </div>
                  {!s.current && (
                    <Button size="sm" variant="outline" onClick={() => void ejecutar(s.id, () => cerrarSesion(fetch, apiBaseUrl, token, s.id), "Sesión cerrada.")} disabled={ocupado !== null}>
                      {ocupado === s.id ? "Cerrando…" : "Cerrar sesión"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => void ejecutar("todas", () => cerrarOtrasSesiones(fetch, apiBaseUrl, token), "Se cerraron tus otras sesiones.")}
              disabled={ocupado !== null || otras.length === 0}
            >
              {ocupado === "todas" ? "Cerrando…" : "Cerrar todas las demás"}
            </Button>
          </>
        ) : (
          <>
            <p className="text-[13px] text-muted-foreground">La lista de dispositivos todavía no está disponible en este ambiente, pero puedes cerrar tus otras sesiones.</p>
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => void ejecutar("todas", () => revokeOtherSessions(fetch, apiBaseUrl, token), "Se cerraron tus otras sesiones. Esta sesión sigue activa hasta que expire.")}
              disabled={ocupado !== null}
            >
              {ocupado === "todas" ? "Cerrando…" : "Cerrar mis otras sesiones"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
