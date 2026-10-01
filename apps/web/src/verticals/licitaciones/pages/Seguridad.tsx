// Seguridad de la cuenta (L-01/L-02): verificacion en dos pasos (TOTP + codigos de respaldo) y, en
// L-02, correo (verificar), contrasena (cambiar; el enlace de "olvide mi contrasena" lleva a
// `/licitaciones/restablecer-contrasena`), vinculo de Google y sesiones activas (ver
// `SeguridadCuenta.tsx`). El login web de licitaciones sigue siendo passwordless (Google/enlace por
// correo): la contrasena existe por el flujo de invitacion y para la API.
//
// Sin libreria de QR (no hay una instalada en el repo y no se agrega dependencia): se muestra la
// clave para captura manual en la app de autenticacion, mas el enlace `otpauth://` (en un
// telefono con la app instalada, abrirlo da de alta la cuenta).
//
// El servidor es SIEMPRE la autoridad (lockout 5 fallos/15 min, anti-replay, un solo uso de los
// respaldos); esto solo conduce el flujo. Con la base sin la migracion (`available: false`) la
// pantalla lo dice honestamente en vez de fingir que funciona.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, Input, Label, PageContainer, StatusBadge } from "@atiende/ui";
import {
  confirmTwoFactorSetup,
  disableTwoFactor,
  fetchTwoFactorStatus,
  regenerateBackupCodes,
  secondFactorFromText,
  startTwoFactorSetup,
} from "../lib/two-factor-client.ts";
import type { TwoFactorSetup, TwoFactorStatus } from "../lib/two-factor-client.ts";
import { fetchCuentaEstado, fetchSesiones } from "../lib/cuenta-client.ts";
import type { CuentaEstado, SesionesEstado } from "../lib/cuenta-client.ts";
import { mensajeGoogleError } from "../../../lib/google-auth.ts";
import { ContrasenaCard, CorreoCard, GoogleCard, SesionesCard } from "./SeguridadCuenta.tsx";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

/** Mientras carga el estado de la cuenta: sin `available` ni identidades (las tarjetas no ofrecen nada). */
const CARGANDO: CuentaEstado = { available: false, email: "", emailVerified: true, hasPassword: true, google: { configured: false, available: false, identities: [] } };

type Accion = "activar" | "confirmar" | "regenerar" | "desactivar";

export function SeguridadPage({ apiBaseUrl, token, orgSlug }: LicitacionesShellContext) {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [codigo, setCodigo] = useState("");
  const [password, setPassword] = useState("");
  const [backupCodes, setBackupCodes] = useState<readonly string[] | null>(null);
  const [ocupado, setOcupado] = useState<Accion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [mostrarDesactivar, setMostrarDesactivar] = useState(false);
  const [cuenta, setCuenta] = useState<CuentaEstado | null>(null);
  const [sesiones, setSesiones] = useState<SesionesEstado | null>(null);

  async function recargarCuenta() {
    const [c, s] = await Promise.all([fetchCuentaEstado(fetch, apiBaseUrl, token), fetchSesiones(fetch, apiBaseUrl, token)]);
    setCuenta(c);
    setSesiones(s);
  }

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

  useEffect(() => {
    let vivo = true;
    void Promise.all([fetchCuentaEstado(fetch, apiBaseUrl, token), fetchSesiones(fetch, apiBaseUrl, token)]).then(([c, s]) => {
      if (!vivo) return;
      setCuenta(c);
      setSesiones(s);
    });
    return () => {
      vivo = false;
    };
  }, [apiBaseUrl, token]);

  // Regreso del flujo "vincular Google" (`?google_link=ok|<codigo>`): se muestra una vez y se limpia de la URL.
  useEffect(() => {
    const resultado = new URLSearchParams(window.location.search).get("google_link");
    if (!resultado) return;
    if (resultado === "ok") setAviso("Cuenta de Google vinculada.");
    else setError(mensajeGoogleError(resultado));
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function ejecutar(accion: Accion, fn: () => Promise<void>) {
    setOcupado(accion);
    setError(null);
    setAviso(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la acción.");
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
      setError("Escribe un código de tu app (o un código de respaldo) para regenerar.");
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
      setError("Para desactivar necesitas tu contraseña y un código de tu app (o de respaldo).");
      return;
    }
    void ejecutar("desactivar", async () => {
      await disableTwoFactor(fetch, apiBaseUrl, token, password, factor);
      setCodigo("");
      setPassword("");
      setMostrarDesactivar(false);
      setBackupCodes(null);
      setAviso("Verificación en dos pasos desactivada.");
      await recargar();
    });
  }

  if (!status) return <EstadoCargando />;
  const disponible = status.available;

  return (
    <PageContainer padding="none" size="sm" className="gap-4 [&>*]:min-w-0">
      <header className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
        <h1 className="font-display text-lg font-semibold text-foreground">Seguridad de la cuenta</h1>
      </header>

      {error && <EstadoError mensaje={error} />}
      {aviso && (
        <p role="status" className="text-sm text-foreground">
          {aviso}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            Verificación en dos pasos
            {disponible && <StatusBadge tone={status.enabled ? "success" : status.pending ? "warning" : "neutral"}>{status.enabled ? "Activa" : status.pending ? "Pendiente" : "Inactiva"}</StatusBadge>}
          </CardTitle>
          <CardDescription>
            Rescindir, penalizar, modificar o marcar el pago de un contrato pide un código de tu app de autenticación (Google Authenticator, 1Password, Authy…).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!disponible && (
            <p className="text-sm text-muted-foreground">
              La verificación en dos pasos todavía no está disponible en este ambiente. Mientras tanto, las acciones sensibles siguen protegidas solo por tu rol.
            </p>
          )}

          {disponible && !status.enabled && !setup && (
            <Button size="sm" className="self-start" onClick={activar} disabled={ocupado !== null}>
              {ocupado === "activar" ? "Preparando…" : "Activar verificación en dos pasos"}
            </Button>
          )}

          {disponible && setup && (
            <form onSubmit={confirmar} className="flex flex-col gap-3">
              <p className="text-sm text-foreground">1. En tu app de autenticación agrega una cuenta con esta clave (captura manual, tipo «basada en tiempo»):</p>
              <code className="select-all break-all rounded-md border border-border bg-muted px-3 py-2 text-sm">{setup.secret}</code>
              <p className="text-xs text-muted-foreground">
                Desde un teléfono con la app instalada también puedes abrir{" "}
                <a href={setup.otpauthUrl} className="underline underline-offset-2">
                  este enlace
                </a>
                .
              </p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="seguridad-confirmar">2. Escribe el código de 6 dígitos que muestra la app</Label>
                <Input id="seguridad-confirmar" inputMode="numeric" autoComplete="one-time-code" value={codigo} onChange={(e) => setCodigo(e.target.value)} placeholder="123456" />
              </div>
              <Button type="submit" size="sm" className="self-start" disabled={ocupado !== null || codigo.trim().length === 0}>
                {ocupado === "confirmar" ? "Verificando…" : "Confirmar y activar"}
              </Button>
            </form>
          )}

          {backupCodes && (
            <div role="status" className="flex flex-col gap-2 rounded-md border border-border bg-muted/50 p-3">
              <p className="text-sm font-semibold text-foreground">Guarda tus códigos de respaldo</p>
              <p className="text-xs text-muted-foreground">Cada uno sirve una sola vez si pierdes tu teléfono. No volverán a mostrarse.</p>
              <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
                {backupCodes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}

          {disponible && status.enabled && (
            <>
              <p className="text-sm text-muted-foreground">
                Te quedan {status.backupCodesRemaining} códigos de respaldo.
                {status.lockedUntil && ` Verificación bloqueada por intentos fallidos hasta ${new Date(status.lockedUntil).toLocaleTimeString("es-MX")}.`}
              </p>
              <form onSubmit={regenerar} className="flex flex-col gap-2">
                <Label htmlFor="seguridad-codigo">Código de tu app o de respaldo</Label>
                <Input id="seguridad-codigo" autoComplete="one-time-code" value={codigo} onChange={(e) => setCodigo(e.target.value)} placeholder="123456" />
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm" variant="outline" disabled={ocupado !== null}>
                    {ocupado === "regenerar" ? "Generando…" : "Generar códigos de respaldo nuevos"}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setMostrarDesactivar((v) => !v)} disabled={ocupado !== null}>
                    Desactivar…
                  </Button>
                </div>
              </form>
              {mostrarDesactivar && (
                <form onSubmit={desactivar} className="flex flex-col gap-2 rounded-md border border-destructive/30 p-3">
                  <Label htmlFor="seguridad-password">Tu contraseña actual</Label>
                  <Input id="seguridad-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  <p className="text-xs text-muted-foreground">Usa también el código de arriba (app o respaldo). Sin 2FA no podrás rescindir, penalizar, modificar ni marcar pagos.</p>
                  <Button type="submit" size="sm" variant="destructive" className="self-start" disabled={ocupado !== null}>
                    {ocupado === "desactivar" ? "Desactivando…" : "Desactivar verificación en dos pasos"}
                  </Button>
                </form>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <CorreoCard apiBaseUrl={apiBaseUrl} token={token} estado={cuenta ?? CARGANDO} onAviso={setAviso} onError={setError} />
      <ContrasenaCard apiBaseUrl={apiBaseUrl} token={token} estado={cuenta ?? CARGANDO} onAviso={setAviso} onError={setError} />
      <GoogleCard apiBaseUrl={apiBaseUrl} token={token} orgSlug={orgSlug} estado={cuenta ?? CARGANDO} onAviso={setAviso} onError={setError} onCambio={recargarCuenta} />
      <SesionesCard apiBaseUrl={apiBaseUrl} token={token} sesiones={sesiones} onAviso={setAviso} onError={setError} onCambio={recargarCuenta} />
    </PageContainer>
  );
}
