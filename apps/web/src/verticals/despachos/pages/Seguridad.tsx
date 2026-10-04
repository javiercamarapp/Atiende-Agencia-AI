// Seguridad de la cuenta de despachos (D-30): verificacion en dos pasos (TOTP + codigos de respaldo) antepuesta a las
// tarjetas COMUNES de cuenta (correo, contrasena, Google y sesiones activas) de `shell/cuenta/`. Es el alta que piden las
// acciones sensibles del despacho (`despachos_sensitive`, ver lib/step-up.ts): sin TOTP activo no hay bypass.
// Mismo flujo y mismos endpoints (`/auth/2fa/*`) que licitaciones/pages/Seguridad.tsx; el servidor es SIEMPRE la autoridad
// (lockout 5 fallos/15 min, anti-replay, un solo uso de los respaldos). Con la base sin la migracion (`available: false`)
// la pantalla lo dice honestamente en vez de fingir que funciona. Sin libreria de QR: clave para captura manual + enlace `otpauth://`.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Card, EstadoCargando, FormField, Input, StatusBadge } from "@atiende/ui";
import {
  confirmTwoFactorSetup,
  disableTwoFactor,
  fetchTwoFactorStatus,
  regenerateBackupCodes,
  secondFactorFromText,
  startTwoFactorSetup,
} from "../lib/two-factor-client.ts";
import type { TwoFactorSetup, TwoFactorStatus } from "../lib/two-factor-client.ts";
import { SeguridadCuentaPagina } from "../../../shell/cuenta/SeguridadCuentaPagina.tsx";
import type { DespachosShellContext } from "../DespachosShell.tsx";
import { horaEsMx } from "../../../lib/formato-fecha.ts";

type Accion = "activar" | "confirmar" | "regenerar" | "desactivar";

interface DosPasosCardProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly onAviso: (mensaje: string | null) => void;
  readonly onError: (mensaje: string | null) => void;
}

function DosPasosCard({ apiBaseUrl, token, onAviso, onError }: DosPasosCardProps) {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [codigo, setCodigo] = useState("");
  const [password, setPassword] = useState("");
  const [backupCodes, setBackupCodes] = useState<readonly string[] | null>(null);
  const [ocupado, setOcupado] = useState<Accion | null>(null);
  const [mostrarDesactivar, setMostrarDesactivar] = useState(false);

  async function recargar() {
    setStatus(await fetchTwoFactorStatus(fetch, apiBaseUrl, token));
  }

  useEffect(() => {
    let vivo = true;
    void fetchTwoFactorStatus(fetch, apiBaseUrl, token).then((s) => {
      if (vivo) setStatus(s);
    });
    return () => {
      vivo = false;
    };
  }, [apiBaseUrl, token]);

  async function ejecutar(accion: Accion, fn: () => Promise<void>) {
    setOcupado(accion);
    onError(null);
    onAviso(null);
    try {
      await fn();
    } catch (err) {
      onError(err instanceof Error ? err.message : "No se pudo completar la acción.");
      await recargar();
    } finally {
      setOcupado(null);
    }
  }

  function activar() {
    void ejecutar("activar", async () => {
      setSetup(await startTwoFactorSetup(fetch, apiBaseUrl, token));
      setCodigo("");
      setBackupCodes(null);
    });
  }

  function confirmar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ejecutar("confirmar", async () => {
      const codes = await confirmTwoFactorSetup(fetch, apiBaseUrl, token, codigo.replace(/\s+/gu, ""));
      setBackupCodes(codes);
      setSetup(null);
      setCodigo("");
      await recargar();
    });
  }

  function regenerar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const factor = secondFactorFromText(codigo);
    if (!factor) {
      onError("Escribe un código de tu app (o un código de respaldo) para regenerar.");
      return;
    }
    void ejecutar("regenerar", async () => {
      setBackupCodes(await regenerateBackupCodes(fetch, apiBaseUrl, token, factor));
      setCodigo("");
      await recargar();
    });
  }

  function desactivar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const factor = secondFactorFromText(codigo);
    if (!factor || password.length === 0) {
      onError("Para desactivar necesitas tu contraseña y un código de tu app (o de respaldo).");
      return;
    }
    void ejecutar("desactivar", async () => {
      await disableTwoFactor(fetch, apiBaseUrl, token, password, factor);
      setCodigo("");
      setPassword("");
      setMostrarDesactivar(false);
      setBackupCodes(null);
      onAviso("Verificación en dos pasos desactivada.");
      await recargar();
    });
  }

  if (!status) return <EstadoCargando variante="tarjeta" />;
  const disponible = status.available;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-ui font-medium">Verificación en dos pasos</p>
        {disponible && <StatusBadge tone={status.enabled ? "success" : status.pending ? "warning" : "neutral"}>{status.enabled ? "Activa" : status.pending ? "Pendiente" : "Inactiva"}</StatusBadge>}
      </div>
      <p className="mt-1 text-eyebrow text-muted-foreground">
        Cerrar un periodo, crear o revocar enlaces del portal, exportar el paquete de contabilidad electrónica y gestionar al equipo piden un código de tu app de autenticación (Google Authenticator, 1Password, Authy…).
      </p>
      <div className="mt-2.5 flex flex-col gap-4">
        {!disponible && (
          <p className="text-eyebrow text-muted-foreground">
            La verificación en dos pasos todavía no está disponible en este ambiente. Mientras tanto, las acciones sensibles siguen protegidas solo por tu rol.
          </p>
        )}

        {disponible && !status.enabled && !setup && (
          <Button size="xs" className="self-start" onClick={activar} loading={ocupado === "activar"} disabled={ocupado !== null}>
            Activar verificación en dos pasos
          </Button>
        )}

        {disponible && setup && (
          <form onSubmit={confirmar} className="flex flex-col gap-3" noValidate>
            <p className="text-ui text-foreground">1. En tu app de autenticación agrega una cuenta con esta clave (captura manual, tipo «basada en tiempo»):</p>
            <code className="select-all break-all rounded-lg border border-border bg-muted px-3 py-2 text-ui">{setup.secret}</code>
            <p className="text-eyebrow text-muted-foreground">
              Desde un teléfono con la app instalada también puedes abrir{" "}
              <a href={setup.otpauthUrl} className="underline underline-offset-2">
                este enlace
              </a>
              .
            </p>
            <FormField label="2. Escribe el código de 6 dígitos que muestra la app">
              <Input id="seguridad-confirmar" inputMode="numeric" autoComplete="one-time-code" value={codigo} onChange={(e) => setCodigo(e.target.value)} placeholder="123456" />
            </FormField>
            <Button type="submit" size="xs" className="self-start" loading={ocupado === "confirmar"} disabled={ocupado !== null || codigo.trim().length === 0}>
              Confirmar y activar
            </Button>
          </form>
        )}

        {backupCodes && (
          <div role="status" className="flex flex-col gap-2 rounded-lg border border-border bg-muted/50 p-3">
            <p className="text-ui font-semibold text-foreground">Guarda tus códigos de respaldo</p>
            <p className="text-eyebrow text-muted-foreground">Cada uno sirve una sola vez si pierdes tu teléfono. No volverán a mostrarse.</p>
            <ul className="grid grid-cols-2 gap-1 font-mono text-ui">
              {backupCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}

        {disponible && status.enabled && (
          <>
            <p className="text-eyebrow text-muted-foreground">
              Te quedan {status.backupCodesRemaining} códigos de respaldo.
              {status.lockedUntil && ` Verificación bloqueada por intentos fallidos hasta ${horaEsMx(status.lockedUntil)}.`}
            </p>
            <form onSubmit={regenerar} className="flex flex-col gap-2" noValidate>
              <FormField label="Código de tu app o de respaldo">
                <Input id="seguridad-codigo" autoComplete="one-time-code" value={codigo} onChange={(e) => setCodigo(e.target.value)} placeholder="123456" />
              </FormField>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="xs" variant="outline" loading={ocupado === "regenerar"} disabled={ocupado !== null}>
                  Generar códigos de respaldo nuevos
                </Button>
                <Button type="button" size="xs" variant="outline" onClick={() => setMostrarDesactivar((v) => !v)} disabled={ocupado !== null}>
                  Desactivar…
                </Button>
              </div>
            </form>
            {mostrarDesactivar && (
              <form onSubmit={desactivar} className="flex flex-col gap-2 rounded-lg border border-destructive/30 p-3" noValidate>
                <FormField label="Tu contraseña actual">
                  <Input id="seguridad-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </FormField>
                <p className="text-eyebrow text-muted-foreground">Usa también el código de arriba (app o respaldo). Sin 2FA no podrás cerrar periodos, compartir el portal, exportar el paquete contable ni gestionar al equipo.</p>
                <Button type="submit" size="xs" variant="destructive" className="self-start" loading={ocupado === "desactivar"} disabled={ocupado !== null}>
                  Desactivar verificación en dos pasos
                </Button>
              </form>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

export function SeguridadPage({ apiBaseUrl, token, orgSlug }: DespachosShellContext) {
  return (
    <SeguridadCuentaPagina
      apiBaseUrl={apiBaseUrl}
      token={token}
      orgSlug={orgSlug}
      vertical="despachos"
      tituloBarra={null}
      extra={({ onAviso, onError }) => <DosPasosCard apiBaseUrl={apiBaseUrl} token={token} onAviso={onAviso} onError={onError} />}
    />
  );
}
