// Tarjetas de "Seguridad de la cuenta" compartidas por las 6 verticales (PL-21; nacieron en licitaciones, L-02):
// correo, contrasena, Google y sesiones activas. El servidor es SIEMPRE la autoridad (tokens de un solo uso,
// expiracion, revocacion de refresh tokens, contrasena actual para desvincular Google); esto solo conduce el
// flujo y, con la base sin migrar (`available: false`), lo dice honestamente en vez de fingir que funciona.
// Medidas de Likida: tarjeta `p-4`, titulo `text-ui font-medium`, texto de apoyo `text-eyebrow` muted, botones `xs`.
import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Button, Card, EstadoCargando, FormField, Input, StatusBadge, useConfirm } from "@atiende/ui";
import { clienteCuenta, describirDispositivo, validarNuevaContrasena } from "./cuenta-client.ts";
import type { CuentaEstado, SesionesEstado, VerticalCuenta } from "./cuenta-client.ts";
import { solicitarRestablecerContrasena } from "./cuenta-client.ts";

export interface CuentaCardProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly vertical: VerticalCuenta;
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

export function CorreoCard({ apiBaseUrl, token, vertical, estado, onAviso, onError }: CuentaCardProps & { readonly estado: CuentaEstado }) {
  const cuenta = useMemo(() => clienteCuenta(vertical), [vertical]);
  const [ocupado, setOcupado] = useState(false);
  if (!estado.available) {
    return null; // sin estado de la cuenta no se sabe si esta verificado: no se ofrece nada que no se pueda cumplir
  }

  async function enviar() {
    setOcupado(true);
    onError(null);
    onAviso(null);
    try {
      const r = await cuenta.enviarVerificacionCorreo(fetch, apiBaseUrl, token);
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
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-ui font-medium">Correo</p>
        <StatusBadge tone={estado.emailVerified ? "success" : "neutral"}>{estado.emailVerified ? "Verificado" : "Sin verificar"}</StatusBadge>
      </div>
      <p className="mt-1 text-eyebrow text-muted-foreground">{estado.email}</p>
      {!estado.emailVerified && (
        <div className="mt-2.5 flex flex-col gap-2">
          <p className="text-eyebrow text-muted-foreground">Confirma que este correo es tuyo: te enviamos un enlace de un solo uso.</p>
          <Button size="xs" variant="outline" className="self-start" onClick={() => void enviar()} loading={ocupado}>
            Enviar correo de verificación
          </Button>
        </div>
      )}
    </Card>
  );
}

export function ContrasenaCard({ apiBaseUrl, token, vertical, estado, onAviso, onError }: CuentaCardProps & { readonly estado: CuentaEstado }) {
  const cuenta = useMemo(() => clienteCuenta(vertical), [vertical]);
  const [actual, setActual] = useState("");
  const [nueva, setNueva] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [ocupado, setOcupado] = useState(false);

  async function cambiar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ocupado) return;
    onAviso(null);
    const invalida = actual.length === 0 ? "Escribe tu contraseña actual." : validarNuevaContrasena(nueva, confirmacion, actual);
    if (invalida) {
      onError(invalida);
      return;
    }
    setOcupado(true);
    onError(null);
    try {
      await cuenta.cambiarContrasena(fetch, apiBaseUrl, token, actual, nueva);
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
      await solicitarRestablecerContrasena(fetch, apiBaseUrl, estado.email, vertical);
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
      <Card className="p-4">
        <p className="text-ui font-medium">Contraseña</p>
        <p className="mt-1 text-eyebrow text-muted-foreground">Tu cuenta no tiene contraseña: entras con Google o con un enlace por correo.</p>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <p className="text-ui font-medium">Contraseña</p>
      <p className="mt-1 text-eyebrow text-muted-foreground">Al cambiarla se cierran las sesiones abiertas en otros dispositivos.</p>
      <form onSubmit={(e) => void cambiar(e)} className="mt-2.5 flex flex-col gap-3" noValidate>
        <FormField label="Contraseña actual">
          <Input id="cuenta-pass-actual" type="password" autoComplete="current-password" value={actual} onChange={(e) => setActual(e.target.value)} />
        </FormField>
        <FormField label="Contraseña nueva (mínimo 8 caracteres)">
          <Input id="cuenta-pass-nueva" type="password" autoComplete="new-password" value={nueva} onChange={(e) => setNueva(e.target.value)} />
        </FormField>
        <FormField label="Repite la contraseña nueva">
          <Input id="cuenta-pass-confirmar" type="password" autoComplete="new-password" value={confirmacion} onChange={(e) => setConfirmacion(e.target.value)} />
        </FormField>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="xs" loading={ocupado}>
            Cambiar contraseña
          </Button>
          {estado.available && (
            <Button type="button" size="xs" variant="ghost" onClick={() => void olvide()} disabled={ocupado}>
              No recuerdo la actual: enviarme un enlace
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

export function GoogleCard({
  apiBaseUrl,
  token,
  vertical,
  orgSlug,
  estado,
  onAviso,
  onError,
  onCambio,
}: CuentaCardProps & { readonly orgSlug: string; readonly estado: CuentaEstado; readonly onCambio: () => Promise<void> }) {
  const cuenta = useMemo(() => clienteCuenta(vertical), [vertical]);
  const [ocupado, setOcupado] = useState(false);
  const [quitando, setQuitando] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const { configured, available, identities } = estado.google;

  async function vincular() {
    setOcupado(true);
    onError(null);
    onAviso(null);
    try {
      const url = await cuenta.iniciarVinculoGoogle(fetch, apiBaseUrl, token, orgSlug);
      window.location.href = url;
    } catch (err) {
      onError(mensaje(err));
      setOcupado(false);
    }
  }

  async function quitar(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    if (ocupado) return;
    if (estado.hasPassword && password.length === 0) {
      onError("Escribe tu contraseña actual para desvincular Google.");
      return;
    }
    setOcupado(true);
    onError(null);
    try {
      await cuenta.desvincularGoogle(fetch, apiBaseUrl, token, id, password);
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
    <Card className="p-4">
      <p className="text-ui font-medium">Google</p>
      <p className="mt-1 text-eyebrow text-muted-foreground">Vincula tu cuenta de Google para entrar con «Continuar con Google».</p>
      <div className="mt-2.5 flex flex-col gap-3">
        {!estado.available && <p className="text-eyebrow text-muted-foreground">La vinculación con Google todavía no está disponible en este ambiente.</p>}
        {estado.available && available && identities.length === 0 && <p className="text-eyebrow text-muted-foreground">Todavía no hay ninguna cuenta de Google vinculada.</p>}
        {identities.map((g) => (
          <div key={g.id} className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-ui font-medium text-foreground">{g.email}</p>
                <p className="text-eyebrow text-muted-foreground">Vinculada el {fechaHora(g.linkedAt)}</p>
              </div>
              {quitando !== g.id && (
                <Button size="xs" variant="outline" onClick={() => setQuitando(g.id)} disabled={ocupado}>
                  Desvincular…
                </Button>
              )}
            </div>
            {quitando === g.id && (
              <form onSubmit={(e) => void quitar(e, g.id)} className="flex flex-col gap-2" noValidate>
                {estado.hasPassword && (
                  <FormField label="Tu contraseña actual">
                    <Input id="cuenta-google-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </FormField>
                )}
                <div className="flex gap-2">
                  <Button type="submit" size="xs" variant="destructive" loading={ocupado}>
                    Desvincular
                  </Button>
                  <Button type="button" size="xs" variant="ghost" onClick={() => setQuitando(null)} disabled={ocupado}>
                    Cancelar
                  </Button>
                </div>
              </form>
            )}
          </div>
        ))}
        {estado.available && available && (
          <>
            <Button size="xs" variant="outline" className="self-start" onClick={() => void vincular()} disabled={ocupado || !configured}>
              {ocupado ? "Abriendo Google…" : "Vincular una cuenta de Google"}
            </Button>
            {!configured && <p className="text-eyebrow text-muted-foreground">Google: pendiente de configurar en este entorno.</p>}
          </>
        )}
      </div>
    </Card>
  );
}

export function SesionesCard({
  apiBaseUrl,
  token,
  vertical,
  sesiones,
  onAviso,
  onError,
  onCambio,
}: CuentaCardProps & { readonly sesiones: SesionesEstado | null; readonly onCambio: () => Promise<void> }) {
  const cuenta = useMemo(() => clienteCuenta(vertical), [vertical]);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const { confirmar, dialogo } = useConfirm();

  async function ejecutar(clave: string, fn: () => Promise<void>, exito: string, confirmacion: { readonly titulo: string; readonly descripcion: string; readonly confirmar: string }) {
    // Cerrar sesiones es destructivo (el dispositivo pierde el acceso): Cancelar / cerrar el diálogo NO ejecuta nada.
    if (!(await confirmar({ ...confirmacion, tono: "danger" }))) return;
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

  if (!sesiones) return <EstadoCargando variante="tarjeta" etiqueta="Cargando sesiones…" />;
  const otras = sesiones.sessions.filter((s) => !s.current);

  return (
    <Card className="p-4">
      <p className="text-ui font-medium">Sesiones activas</p>
      <p className="mt-1 text-eyebrow text-muted-foreground">Dispositivos con la sesión abierta. Cierra los que no reconozcas; esta sesión no se interrumpe.</p>
      <div className="mt-2.5 flex flex-col gap-3">
        {sesiones.available ? (
          <>
            {sesiones.sessions.length === 0 && <p className="text-eyebrow text-muted-foreground">No hay sesiones registradas todavía. Aparecerán la próxima vez que inicies sesión.</p>}
            <ul className="flex flex-col gap-2">
              {sesiones.sessions.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2.5">
                  <div>
                    <p className="flex items-center gap-2 text-ui font-medium text-foreground">
                      {describirDispositivo(s.userAgent)}
                      {s.current && <StatusBadge tone="info">Este dispositivo</StatusBadge>}
                    </p>
                    <p className="text-eyebrow text-muted-foreground">
                      Iniciada el {fechaHora(s.startedAt)} · actividad {fechaHora(s.issuedAt)}
                    </p>
                  </div>
                  {!s.current && (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        void ejecutar(s.id, () => cuenta.cerrarSesion(fetch, apiBaseUrl, token, s.id), "Sesión cerrada.", {
                          titulo: `Cerrar la sesión de ${describirDispositivo(s.userAgent)}`,
                          descripcion: "Ese dispositivo perderá el acceso y tendrá que iniciar sesión de nuevo.",
                          confirmar: "Cerrar sesión",
                        })
                      }
                      disabled={ocupado !== null}
                    >
                      {ocupado === s.id ? "Cerrando…" : "Cerrar sesión"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <Button
              size="xs"
              variant="outline"
              className="self-start"
              onClick={() =>
                void ejecutar("todas", () => cuenta.cerrarOtrasSesiones(fetch, apiBaseUrl, token), "Se cerraron tus otras sesiones.", {
                  titulo: "Cerrar todas las demás sesiones",
                  descripcion: `Se cerrarán ${otras.length} sesión(es) en otros dispositivos; esta sesión no se interrumpe.`,
                  confirmar: "Cerrar todas las demás",
                })
              }
              disabled={ocupado !== null || otras.length === 0}
            >
              {ocupado === "todas" ? "Cerrando…" : "Cerrar todas las demás"}
            </Button>
          </>
        ) : (
          <>
            <p className="text-eyebrow text-muted-foreground">La lista de dispositivos todavía no está disponible en este ambiente, pero puedes cerrar tus otras sesiones.</p>
            <Button
              size="xs"
              variant="outline"
              className="self-start"
              onClick={() =>
                void ejecutar("todas", () => cuenta.cerrarOtrasSesionesPorCorte(fetch, apiBaseUrl, token), "Se cerraron tus otras sesiones. Esta sesión sigue activa hasta que expire.", {
                  titulo: "Cerrar mis otras sesiones",
                  descripcion: "Los demás dispositivos perderán el acceso; esta sesión sigue activa hasta que expire.",
                  confirmar: "Cerrar mis otras sesiones",
                })
              }
              disabled={ocupado !== null}
            >
              {ocupado === "todas" ? "Cerrando…" : "Cerrar mis otras sesiones"}
            </Button>
          </>
        )}
        {dialogo}
      </div>
    </Card>
  );
}
