// Proveedores del panel de citas — lista + ficha (Fase 5). Fase 8 cierra el gap
// real de paridad con el origen (FichaProveedor.tsx/ProveedoresSection.tsx): alta/
// edición real de un proveedor y el checkbox real de qué servicios ofrece
// (`citas.provider_services`) — ver providers-client.ts. La ficha SÍ seguía
// ofreciendo, desde antes, una acción real: conectar Google Calendar (Fase 3).
//
// Sin selector de sucursal en el formulario a propósito: el shell de este panel
// (CitasShell.tsx) todavía usa siempre `branches[0]` como la única propertyId
// operable — un negocio de citas casi siempre es de una sola ubicación (ver
// ProviderRecord.propertyId). Agregar un selector de sucursal real es la misma
// decisión de producto pendiente en todo el panel, no algo que esta fase deba
// resolver a medias.
//
// Presentación real (Fase de diseño): los `style={{…}}` con hex se cambian por
// Card/Input/Label/Button/Badge/Table de @atiende/ui. La sincronización real con
// Google Calendar (apps/api/.../google-calendar-*.ts) no se toca: solo cambia
// cómo se ve su estado.
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, CalendarSync, Pencil, Plug, Plus, TriangleAlert, UserRound } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@atiende/ui";
import {
  connectCalCom,
  connectCalDav,
  createProvider,
  disconnectCalCom,
  disconnectCalDav,
  fetchProviderDetail,
  fetchProviders,
  requestGoogleCalendarConnectUrl,
  setProviderServiceOffering,
  testCalComConnection,
  testCalDavConnection,
  updateProvider,
} from "../lib/providers-client.ts";
import type { CalComStatus, CalDavStatus, ProviderDetail, ProviderSummary } from "../lib/providers-client.ts";
import { fetchServices } from "../lib/services-client.ts";
import type { ServiceSummary } from "../lib/services-client.ts";
import { formatDayOfWeek, formatHHMM } from "../lib/format.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

const CHECKBOX_CLASS = "size-4 rounded border-border accent-primary disabled:cursor-not-allowed disabled:opacity-50";

export function ProveedoresListPage({ apiBaseUrl, token, propertyId, orgSlug }: CitasShellContext) {
  const [providers, setProviders] = useState<readonly ProviderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRoleLabel, setNewRoleLabel] = useState("");
  const [creating, setCreating] = useState(false);

  function load() {
    setError(null);
    fetchProviders(fetch, apiBaseUrl, token, propertyId)
      .then(setProviders)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudieron cargar los proveedores."));
  }

  useEffect(() => {
    load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!newDisplayName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createProvider(fetch, apiBaseUrl, token, propertyId, { displayName: newDisplayName.trim(), roleLabel: newRoleLabel.trim() || undefined });
      setNewDisplayName("");
      setNewRoleLabel("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el proveedor.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-xl font-semibold text-foreground">Proveedores</h1>
      {error && <EstadoError mensaje={error} />}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Nuevo proveedor</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
              <Label htmlFor="citas-nuevo-proveedor-nombre">Nombre</Label>
              <Input id="citas-nuevo-proveedor-nombre" placeholder="Nombre (ej. Dra. Ana Ruiz)" value={newDisplayName} onChange={(e) => setNewDisplayName(e.target.value)} />
            </div>
            <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
              <Label htmlFor="citas-nuevo-proveedor-rol">Rol</Label>
              <Input id="citas-nuevo-proveedor-rol" placeholder="Rol (ej. Dentista, Barbero)" value={newRoleLabel} onChange={(e) => setNewRoleLabel(e.target.value)} />
            </div>
            <Button type="submit" disabled={creating}>
              <Plus aria-hidden />
              {creating ? "Creando…" : "Crear proveedor"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {!providers && !error && <EstadoCargando etiqueta="Cargando proveedores…" />}
      {providers && providers.length === 0 && <EstadoVacio icon={UserRound} mensaje="Este negocio todavía no tiene proveedores activos." />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {providers?.map((p) => (
          <Link key={p.id} to={`/citas/${orgSlug}/proveedores/${p.id}`} className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Card className="h-full transition-colors hover:border-foreground/20 hover:bg-muted/40">
              <CardContent className="p-4">
                <p className="font-semibold text-foreground">{p.displayName}</p>
                <p className="mt-1 text-[13px] text-muted-foreground">{p.roleLabel}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Fase 6 §2 (seguimiento) — "Calendarios conectados": Cal.com y CalDAV, mismo
// estándar visual que la tarjeta de Google Calendar de arriba (Badge de estado +
// mensaje de error legible + acción real) — a diferencia de Google (OAuth,
// redirección), aquí el profesional pega sus credenciales directo en un
// formulario (mismo criterio que la ruta HTTP, ver calendar-providers.ts) y
// puede "Probar conexión" sin tener que desconectar/reconectar para verificar
// que sigue viva.
// ============================================================================

interface CalendarProviderCardShellProps {
  readonly title: string;
  readonly connected: boolean;
  readonly syncStatus: "disconnected" | "connected" | "error";
  readonly syncError: string | null;
  readonly summary: string | null;
  readonly testResult: string | null;
  readonly localError: string | null;
  readonly testing: boolean;
  readonly disconnecting: boolean;
  readonly onTest: () => void;
  readonly onDisconnect: () => void;
  readonly connectForm: ReactNode;
}

function CalendarProviderCardShell({ title, connected, syncStatus, syncError, summary, testResult, localError, testing, disconnecting, onTest, onDisconnect, connectForm }: CalendarProviderCardShellProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {localError && <EstadoError mensaje={localError} />}
        {connected ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant={syncStatus === "error" ? "destructive" : "secondary"}>{syncStatus === "error" ? "Conectado (con error)" : "Conectado"}</Badge>
              {summary && <span className="break-all text-[13px] text-muted-foreground">{summary}</span>}
            </div>
            {syncStatus === "error" && syncError && <p className="text-[13px] text-destructive">Error de sincronización: {syncError}</p>}
            {testResult && <p className="text-[13px] text-muted-foreground">{testResult}</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onTest} disabled={testing}>
                {testing ? "Probando…" : "Probar conexión"}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={onDisconnect} disabled={disconnecting}>
                {disconnecting ? "Desconectando…" : "Desconectar"}
              </Button>
            </div>
          </div>
        ) : (
          connectForm
        )}
      </CardContent>
    </Card>
  );
}

interface CalComCardProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly providerId: string;
  readonly status: CalComStatus;
  readonly onChanged: () => void;
}

function CalComCard({ apiBaseUrl, token, propertyId, providerId, status, onChanged }: CalComCardProps) {
  const [apiKey, setApiKey] = useState("");
  const [eventTypeId, setEventTypeId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function handleConnect(e: FormEvent) {
    e.preventDefault();
    if (!apiKey.trim() || !eventTypeId.trim()) return;
    setConnecting(true);
    setLocalError(null);
    try {
      await connectCalCom(fetch, apiBaseUrl, token, propertyId, providerId, { apiKey: apiKey.trim(), eventTypeId: eventTypeId.trim(), baseUrl: baseUrl.trim() || undefined });
      setApiKey("");
      setEventTypeId("");
      setBaseUrl("");
      onChanged();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "No se pudo conectar Cal.com.");
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    setLocalError(null);
    try {
      await disconnectCalCom(fetch, apiBaseUrl, token, propertyId, providerId);
      onChanged();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "No se pudo desconectar Cal.com.");
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setLocalError(null);
    setTestResult(null);
    try {
      const result = await testCalComConnection(fetch, apiBaseUrl, token, propertyId, providerId);
      setTestResult(result.ok ? "Conexión verificada correctamente." : "La prueba de conexión falló.");
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "No se pudo probar la conexión con Cal.com.");
    } finally {
      setTesting(false);
      onChanged(); // la prueba puede haber cambiado sync_status/sync_error guardado
    }
  }

  return (
    <CalendarProviderCardShell
      title="Cal.com"
      connected={status.connected}
      syncStatus={status.syncStatus}
      syncError={status.syncError}
      summary={status.eventTypeId ? `Event type: ${status.eventTypeId}${status.baseUrl ? ` · ${status.baseUrl}` : ""}` : null}
      testResult={testResult}
      localError={localError}
      testing={testing}
      disconnecting={disconnecting}
      onTest={() => void handleTest()}
      onDisconnect={() => void handleDisconnect()}
      connectForm={
        <form onSubmit={handleConnect} className="flex flex-col gap-3">
          <p className="text-[13px] text-muted-foreground">Este proveedor todavía no conecta Cal.com.</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`citas-calcom-apikey-${providerId}`}>API key</Label>
            <Input id={`citas-calcom-apikey-${providerId}`} type="password" placeholder="cal_live_…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`citas-calcom-eventtype-${providerId}`}>Event type ID</Label>
            <Input id={`citas-calcom-eventtype-${providerId}`} placeholder="123" value={eventTypeId} onChange={(e) => setEventTypeId(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`citas-calcom-baseurl-${providerId}`}>URL base (solo si es self-hosted)</Label>
            <Input id={`citas-calcom-baseurl-${providerId}`} placeholder="https://calcom.tuempresa.com/v2" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          <Button type="submit" disabled={connecting} className="w-fit">
            <Plug aria-hidden />
            {connecting ? "Conectando…" : "Conectar Cal.com"}
          </Button>
        </form>
      }
    />
  );
}

interface CalDavCardProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly providerId: string;
  readonly status: CalDavStatus;
  readonly onChanged: () => void;
}

function CalDavCard({ apiBaseUrl, token, propertyId, providerId, status, onChanged }: CalDavCardProps) {
  const [calendarCollectionUrl, setCalendarCollectionUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function handleConnect(e: FormEvent) {
    e.preventDefault();
    if (!calendarCollectionUrl.trim() || !username.trim() || !password) return;
    setConnecting(true);
    setLocalError(null);
    try {
      await connectCalDav(fetch, apiBaseUrl, token, propertyId, providerId, { calendarCollectionUrl: calendarCollectionUrl.trim(), username: username.trim(), password });
      setCalendarCollectionUrl("");
      setUsername("");
      setPassword("");
      onChanged();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "No se pudo conectar CalDAV.");
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    setLocalError(null);
    try {
      await disconnectCalDav(fetch, apiBaseUrl, token, propertyId, providerId);
      onChanged();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "No se pudo desconectar CalDAV.");
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setLocalError(null);
    setTestResult(null);
    try {
      const result = await testCalDavConnection(fetch, apiBaseUrl, token, propertyId, providerId);
      setTestResult(result.ok ? "Conexión verificada correctamente." : "La prueba de conexión falló.");
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "No se pudo probar la conexión con CalDAV.");
    } finally {
      setTesting(false);
      onChanged();
    }
  }

  return (
    <CalendarProviderCardShell
      title="CalDAV (Apple/iCloud, Fastmail, Nextcloud…)"
      connected={status.connected}
      syncStatus={status.syncStatus}
      syncError={status.syncError}
      summary={status.calendarCollectionUrl ? `${status.username} · ${status.calendarCollectionUrl}` : null}
      testResult={testResult}
      localError={localError}
      testing={testing}
      disconnecting={disconnecting}
      onTest={() => void handleTest()}
      onDisconnect={() => void handleDisconnect()}
      connectForm={
        <form onSubmit={handleConnect} className="flex flex-col gap-3">
          <p className="text-[13px] text-muted-foreground">Este proveedor todavía no conecta CalDAV.</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`citas-caldav-url-${providerId}`}>URL de la colección de calendario</Label>
            <Input id={`citas-caldav-url-${providerId}`} placeholder="https://caldav.fastmail.com/dav/calendars/user/tu@correo.com/abc/" value={calendarCollectionUrl} onChange={(e) => setCalendarCollectionUrl(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`citas-caldav-username-${providerId}`}>Usuario</Label>
            <Input id={`citas-caldav-username-${providerId}`} value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`citas-caldav-password-${providerId}`}>Contraseña de aplicación</Label>
            <Input id={`citas-caldav-password-${providerId}`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          </div>
          <Button type="submit" disabled={connecting} className="w-fit">
            <Plug aria-hidden />
            {connecting ? "Conectando…" : "Conectar CalDAV"}
          </Button>
        </form>
      }
    />
  );
}

export interface ProveedorFichaPageProps extends CitasShellContext {
  readonly providerId: string;
}

export function ProveedorFichaPage({ apiBaseUrl, token, propertyId, orgSlug, providerId }: ProveedorFichaPageProps) {
  const [detail, setDetail] = useState<ProviderDetail | null>(null);
  const [services, setServices] = useState<readonly ServiceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [togglingServiceId, setTogglingServiceId] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editRoleLabel, setEditRoleLabel] = useState("");
  const [editIsActive, setEditIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  function load() {
    setError(null);
    fetchProviderDetail(fetch, apiBaseUrl, token, propertyId, providerId)
      .then((d) => {
        setDetail(d);
        setEditDisplayName(d.provider.displayName);
        setEditRoleLabel(d.provider.roleLabel);
        setEditIsActive(d.provider.isActive);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudo cargar el proveedor."));
  }

  useEffect(() => {
    load();
    fetchServices(fetch, apiBaseUrl, token, propertyId)
      .then(setServices)
      .catch(() => {
        /* la sección de servicios se degrada a "no se pudieron cargar" sin tronar la ficha completa */
      });
  }, [apiBaseUrl, token, propertyId, providerId]);

  async function handleConnectGoogleCalendar() {
    setConnecting(true);
    setError(null);
    try {
      const url = await requestGoogleCalendarConnectUrl(fetch, apiBaseUrl, token, propertyId, providerId);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar la conexión con Google Calendar.");
      setConnecting(false);
    }
  }

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editDisplayName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await updateProvider(fetch, apiBaseUrl, token, propertyId, providerId, { displayName: editDisplayName.trim(), roleLabel: editRoleLabel.trim() || undefined, isActive: editIsActive });
      setEditing(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el proveedor.");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleService(serviceId: string, offered: boolean) {
    setTogglingServiceId(serviceId);
    setError(null);
    try {
      await setProviderServiceOffering(fetch, apiBaseUrl, token, propertyId, providerId, serviceId, offered);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar el servicio del proveedor.");
    } finally {
      setTogglingServiceId(null);
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Button asChild variant="ghost" size="sm" className="w-fit px-2 text-muted-foreground">
        <Link to={`/citas/${orgSlug}/proveedores`}>
          <ArrowLeft aria-hidden />
          Volver a proveedores
        </Link>
      </Button>

      {error && <EstadoError mensaje={error} />}

      {!detail && !error && <EstadoCargando etiqueta="Cargando proveedor…" />}

      {detail && (
        <>
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="font-display text-xl font-semibold text-foreground">{detail.provider.displayName}</h1>
              <p className="mt-1 flex items-center gap-2 text-[13px] text-muted-foreground">
                {detail.provider.roleLabel} {!detail.provider.isActive && <Badge variant="outline">Inactivo</Badge>}
              </p>
            </div>
            {!editing && (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil aria-hidden />
                Editar proveedor
              </Button>
            )}
          </header>

          {editing && (
            <Card>
              <CardContent className="p-6">
                <form onSubmit={handleSaveEdit} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="citas-proveedor-nombre">Nombre</Label>
                    <Input id="citas-proveedor-nombre" value={editDisplayName} onChange={(e) => setEditDisplayName(e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="citas-proveedor-rol">Rol / etiqueta</Label>
                    <Input id="citas-proveedor-rol" value={editRoleLabel} onChange={(e) => setEditRoleLabel(e.target.value)} />
                  </div>
                  <label className="flex items-center gap-2 text-[13px] text-foreground">
                    <input type="checkbox" checked={editIsActive} onChange={(e) => setEditIsActive(e.target.checked)} className={CHECKBOX_CLASS} />
                    Activo
                  </label>
                  <div className="flex gap-2">
                    <Button type="submit" disabled={saving}>
                      {saving ? "Guardando…" : "Guardar cambios"}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => setEditing(false)} disabled={saving}>
                      Cancelar
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          <div className="flex flex-col gap-3">
            <h2 className="font-display text-base font-semibold text-foreground">Calendarios conectados</h2>
            <p className="-mt-2 text-[13px] text-muted-foreground">Cada proveedor conecta su propio calendario — es personal, nunca compartido por todo el negocio.</p>

            {/* Fase 6 §2 (seguimiento, "citas-sync-errores-visibles") — advertencia
                ámbar (nunca roja: la credencial sigue sirviendo, ver diseño en
                domain-citas/src/calendar-sync.ts) cuando este proveedor tiene citas
                con un rechazo PERMANENTE de validación (p.ej. Cal.com exige el correo
                del cliente). Se autolimpia sola en cuanto el staff corrige el dato y
                reintenta -- nunca requiere que alguien la "cierre" a mano. */}
            {detail.calendarSyncIssues.count > 0 && (
              <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 dark:border-amber-500/30 dark:bg-amber-500/10">
                <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
                <div className="text-[13px] text-amber-800 dark:text-amber-400">
                  <p className="font-semibold">
                    {detail.calendarSyncIssues.count} {detail.calendarSyncIssues.count === 1 ? "cita no se sincronizó" : "citas no se sincronizaron"} por un problema que la credencial no resuelve sola.
                  </p>
                  {detail.calendarSyncIssues.lastReason && <p className="mt-0.5">{detail.calendarSyncIssues.lastReason}</p>}
                  <p className="mt-0.5 text-amber-700/80 dark:text-amber-400/80">Corrige el dato que falte y usa "Reintentar sincronización" en la cita, desde la Agenda.</p>
                </div>
              </div>
            )}

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">Google Calendar</CardTitle>
              </CardHeader>
              <CardContent>
                {detail.googleCalendar.connected ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <Badge variant={detail.googleCalendar.syncStatus === "error" ? "destructive" : "secondary"}>
                      {detail.googleCalendar.syncStatus === "error" ? "Conectado (con error)" : "Conectado"}
                    </Badge>
                    <p className={detail.googleCalendar.syncStatus === "error" ? "text-[13px] text-destructive" : "text-[13px] text-muted-foreground"}>
                      {detail.googleCalendar.syncStatus === "error"
                        ? `Error de sincronización: ${detail.googleCalendar.syncError ?? "desconocido"}`
                        : "Las citas de este proveedor se sincronizan automáticamente."}
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-[13px] text-muted-foreground">Este proveedor todavía no conecta su Google Calendar.</p>
                    <Button onClick={() => void handleConnectGoogleCalendar()} disabled={connecting}>
                      <CalendarSync aria-hidden />
                      {connecting ? "Conectando…" : "Conectar Google Calendar"}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            <CalComCard apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} providerId={providerId} status={detail.calcom} onChanged={load} />
            <CalDavCard apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} providerId={providerId} status={detail.caldav} onChanged={load} />
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">Servicios que ofrece</CardTitle>
            </CardHeader>
            <CardContent>
              {!services ? (
                <EstadoCargando lineas={2} etiqueta="Cargando servicios…" />
              ) : services.length === 0 ? (
                <EstadoVacio mensaje="Este negocio todavía no tiene servicios configurados." />
              ) : (
                <div className="flex flex-col gap-1">
                  {services.map((s) => {
                    const offered = detail.offeredServiceIds.includes(s.id);
                    return (
                      <label key={s.id} className="flex items-center gap-2 py-1 text-[13px] text-foreground">
                        <input
                          type="checkbox"
                          checked={offered}
                          disabled={togglingServiceId === s.id}
                          onChange={(e) => void handleToggleService(s.id, e.target.checked)}
                          className={CHECKBOX_CLASS}
                        />
                        {s.name}
                      </label>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">Horario semanal</CardTitle>
            </CardHeader>
            <CardContent>
              {detail.availabilityRules.length === 0 ? (
                <EstadoVacio mensaje="Sin reglas de disponibilidad configuradas todavía." />
              ) : (
                <Table>
                  <TableBody>
                    {[...detail.availabilityRules]
                      .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
                      .map((rule) => (
                        <TableRow key={rule.id}>
                          <TableCell className="py-2 font-medium text-foreground">{formatDayOfWeek(rule.dayOfWeek)}</TableCell>
                          <TableCell className={rule.isActive ? "py-2 text-foreground" : "py-2 text-muted-foreground"}>
                            <span className="inline-flex items-center gap-2">
                              {formatHHMM(rule.startTime)} – {formatHHMM(rule.endTime)}
                              {!rule.isActive && <Badge variant="outline">inactivo</Badge>}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              )}
              <p className="mt-3 text-[12px] text-muted-foreground">Solo lectura — editar el horario todavía no está disponible desde el panel.</p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
