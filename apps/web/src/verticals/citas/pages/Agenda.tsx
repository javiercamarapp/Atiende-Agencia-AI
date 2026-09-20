// Agenda del panel de citas (Fase 5/7/10) — vista mes/semana de citas REALES (GET
// /v1/citas/properties/:propertyId/appointments, Fase 5 — admin.ts), agrupadas por
// día. Fase 5 solo ofrecía cancelar (appointments-lifecycle.ts); Fase 7 agrega
// confirmar/completar/marcar no-show — mismo patrón de botón condicionado por
// estado. El panel sigue sin reagendar ni reasignar hoy (esas dos solo las
// ejecuta el agente, ver ese mismo archivo).
//
// Fase 10 — tiempo real: además del refetch tras cada acción propia (`load()`,
// sin cambios), la agenda ahora se suscribe a Supabase Realtime
// (`subscribeToAppointmentChanges`, ver realtime-client.ts) sobre
// `citas.appointments` filtrado por `organization_id`, para que un cambio hecho
// por OTRO miembro del staff dispare el mismo `load()` sin que haga falta
// refrescar a mano — puerto real del patrón del origen
// (AgendaSection.tsx: `.channel(agenda-${tenantId})` + nonce). Ver la cabecera de
// realtime-client.ts para el bloqueo real documentado (alineación del secreto
// JWT del proyecto Supabase, fuera del alcance de este repo) — sin esa
// alineación la suscripción no entrega eventos (falla cerrado) y este `load()`
// tras acción propia sigue siendo, en la práctica, el único refresco real.
//
// Hallazgo ALTA de auditoría: `GET/POST .../waitlist[/broadcast]` (admin.ts, Fase
// 9) estaba completo, probado y documentado en el backend, pero ningún cliente ni
// página de apps/web lo consumía — el staff no tenía forma de ver la fila FIFO ni
// de disparar el aviso manual. Se agrega aquí (y no en Disponibilidad.tsx, que es
// horarios/excepciones de configuración) porque Agenda es donde el staff ya
// cancela/marca no-show — el momento real en que un horario se libera y vale la
// pena avisar a quien está esperando; reusa el MISMO `providerFilter` de la
// agenda para no duplicar el selector de proveedor.
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { CalendarPlus, CalendarX2, Check, CheckCheck, ChevronLeft, ChevronRight, Clock, Megaphone, RefreshCw, TriangleAlert, UserX, X } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@atiende/ui";
import { ModalFormularioLateral } from "../../../components/ModalFormularioLateral.tsx";
import { cancelAppointment, completeAppointment, confirmAppointment, createAppointment, fetchAppointments, markAppointmentNoShow, retryAppointmentCalendarSync } from "../lib/appointments-client.ts";
import type { AppointmentSummary } from "../lib/appointments-client.ts";
import { fetchProviders } from "../lib/providers-client.ts";
import type { ProviderSummary } from "../lib/providers-client.ts";
import { fetchServices } from "../lib/services-client.ts";
import type { ServiceSummary } from "../lib/services-client.ts";
import { broadcastWaitlist, fetchWaitlist } from "../lib/waitlist-client.ts";
import type { WaitlistBroadcastSummary, WaitlistCandidate } from "../lib/waitlist-client.ts";
import { formatAppointmentSource, formatAppointmentStatus, formatDateLong, formatGoogleSyncStatus, formatTimeRange, googleSyncStatusNeedsAttention } from "../lib/format.ts";
import { subscribeToAppointmentChanges } from "../lib/realtime-client.ts";
import { hoyFechaSolo, parseFechaSolo } from "../../../lib/formato-fecha.ts";
import { saludoConNombre } from "../../../lib/greeting.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

type ViewMode = "month" | "week";

function startOfWeek(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = domingo
  const diff = day === 0 ? -6 : 1 - day; // semana empieza en lunes
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

// Bug real (revisión de PR #164, "no bloqueante" #3): las 2 etiquetas de rango de abajo
// ("Semana del ..."/mes) se arman sobre `from`, un valor de solo-FECHA anclado a
// medianoche UTC (mismo patrón que `parseFechaSolo` de `formato-fecha.ts` -- por eso
// `startOfWeek`/el cálculo del día 1 del mes usan SOLO getters/setters `UTC*`, nunca
// locales). Formatearlo con `formatDateLong`/sin `timeZone` fijo usa la zona LOCAL DEL
// NAVEGADOR -- en CUALQUIER zona con offset negativo (América completa) eso corre la
// etiqueta un día/mes ANTES del real ("domingo, 13 de septiembre" para la semana del
// LUNES 14; "agosto de 2026" viendo septiembre). El fix es forzar `timeZone: "UTC"` --
// igual que `formatFechaSolo` -- para recuperar el día/mes que `from` en realidad
// representa; NO se toca `formatDateLong`/`format.ts` (esa función también formatea
// timestamps reales de citas en otro lugar de este mismo archivo, con una zona horaria
// de negocio distinta -- un solo `timeZone` ahí serviría a un caso rompiendo el otro).
const RANGO_LABEL_FORMATTER_LARGA = new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const RANGO_LABEL_FORMATTER_MES = new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric", timeZone: "UTC" });

function computeRange(anchor: Date, view: ViewMode): { fromIso: string; toIso: string; label: string } {
  if (view === "week") {
    const from = startOfWeek(anchor);
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 7);
    return { fromIso: from.toISOString(), toIso: to.toISOString(), label: `Semana del ${RANGO_LABEL_FORMATTER_LARGA.format(from)}` };
  }
  const from = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const to = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
  const label = RANGO_LABEL_FORMATTER_MES.format(from);
  return { fromIso: from.toISOString(), toIso: to.toISOString(), label };
}

function shiftAnchor(anchor: Date, view: ViewMode, direction: 1 | -1): Date {
  const d = new Date(anchor);
  if (view === "week") d.setUTCDate(d.getUTCDate() + 7 * direction);
  else d.setUTCMonth(d.getUTCMonth() + direction);
  return d;
}

function groupByDay(appointments: readonly AppointmentSummary[]): ReadonlyArray<[string, AppointmentSummary[]]> {
  const groups = new Map<string, AppointmentSummary[]>();
  for (const apt of appointments) {
    const dayKey = apt.startsAt.slice(0, 10);
    const list = groups.get(dayKey) ?? [];
    list.push(apt);
    groups.set(dayKey, list);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

const CANCELABLE_STATUSES = new Set(["pending", "confirmed"]);
// Fase 7 — mismos 2 estados "vivos" que ya usa CANCELABLE_STATUSES/
// LIFECYCLE_EDITABLE_STATUSES de domain-citas/appointments.ts: solo una cita
// pending/confirmed admite estas 3 transiciones nuevas.
const CONFIRMABLE_STATUSES = new Set(["pending"]);
const COMPLETABLE_STATUSES = new Set(["pending", "confirmed"]);
const NO_SHOW_STATUSES = new Set(["pending", "confirmed"]);

type LifecycleAction = "cancel" | "confirm" | "complete" | "no_show" | "retry_sync";

/** Clase compartida para los `<select>` nativos que se quedan nativos (el design
 * system no exporta un Select propio): mismo alto/radio/anillo de foco que el
 * `Input` real de @atiende/ui, con tokens en vez de hex. */
const SELECT_CLASS =
  "h-11 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/** Estado de la cita -> variante real de `Badge` (nada de hex artesanales). */
function statusBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "cancelled") return "destructive";
  if (status === "completed") return "default";
  if (status === "no_show") return "outline";
  return "secondary";
}

export function AgendaPage({ apiBaseUrl, token, propertyId, orgId, staffFullName, staffEmail }: CitasShellContext) {
  const [view, setView] = useState<ViewMode>("month");
  // Bug real (revisión r6, punto 2 -- el fix de PR #164 solo corrigió la ETIQUETA):
  // `anchor` alimenta `startOfWeek`/`computeRange` (ambos con getters/setters `UTC*`,
  // porque tratan `anchor` como un valor de solo-FECHA anclado a medianoche UTC -- mismo
  // criterio que `parseFechaSolo` de `formato-fecha.ts`). `new Date()` da el INSTANTE
  // actual, no un día anclado a UTC -- entre las 18:00 y las 23:59 de CDMX (00:00-05:59
  // UTC) su `getUTCDate()`/`getUTCMonth()` YA son los de MAÑANA, así que
  // `startOfWeek`/el cálculo del día 1 del mes calculaban la semana/mes SIGUIENTE, y
  // `fromIso`/`toIso` (mandados al servidor) pedían el rango equivocado -- aunque la
  // ETIQUETA (ya corregida en PR #164 con `timeZone: "UTC"` en los formatters) mostrara
  // el día/mes correcto para ESE `anchor` ya corrido. Fix: anclar `anchor` al día de
  // CALENDARIO del negocio (`hoyFechaSolo()`), luego convertirlo al mismo tipo de Date
  // anclado a medianoche UTC (`parseFechaSolo()`) que el resto de esta función ya espera.
  const [anchor, setAnchor] = useState<Date>(() => parseFechaSolo(hoyFechaSolo()));
  const [providers, setProviders] = useState<readonly ProviderSummary[] | null>(null);
  const [providerFilter, setProviderFilter] = useState<string>("");
  const [appointments, setAppointments] = useState<readonly AppointmentSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Una sola acción de ciclo de vida en vuelo a la vez, por cita — mismo criterio
  // que el `cancellingId` original, generalizado a las 4 acciones del panel.
  const [pendingAction, setPendingAction] = useState<{ id: string; action: LifecycleAction } | null>(null);
  // Fase 10 — se incrementa cuando Realtime avisa un cambio ajeno; entra al
  // arreglo de dependencias del efecto de `load()` de abajo para disparar el
  // mismo refetch, mismo patrón que el `recargarNonce` del origen.
  const [realtimeNonce, setRealtimeNonce] = useState(0);

  // ---- Lista de espera (cierra el hallazgo "backend completo, sin cliente") ----
  const [services, setServices] = useState<readonly ServiceSummary[] | null>(null);
  const [waitlistServiceFilter, setWaitlistServiceFilter] = useState<string>("");
  const [waitlist, setWaitlist] = useState<readonly WaitlistCandidate[] | null>(null);
  const [waitlistLoading, setWaitlistLoading] = useState(false);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);
  const [broadcasting, setBroadcasting] = useState(false);
  // Corrección post-revisión de f2-citas-lista-de-espera (hallazgo B) —
  // WaitlistBroadcastSummary ya no trae `notified` (el efecto real corre
  // post-commit, best-effort, en segundo plano) y `skippedNoWhatsappConfig` es
  // `boolean`, no `number` — ver el comentario largo de `waitlist-client.ts`.
  const [broadcastSummary, setBroadcastSummary] = useState<WaitlistBroadcastSummary | null>(null);

  // ---- Fase 12 — hallazgo de auditoría (ALTO, "Staff no puede crear citas
  // manualmente desde la Agenda"): alta manual real (POST .../appointments, ver
  // appointments-client.ts::createAppointment). Formulario plegado por default —
  // mismo criterio de "no ensuciar la vista principal" que el resto de este panel. ----
  const [showNewForm, setShowNewForm] = useState(false);
  const [newProviderId, setNewProviderId] = useState("");
  const [newServiceId, setNewServiceId] = useState("");
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [newCustomerEmail, setNewCustomerEmail] = useState("");
  const [newStartsAt, setNewStartsAt] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [creatingAppointment, setCreatingAppointment] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const range = useMemo(() => computeRange(anchor, view), [anchor, view]);

  useEffect(() => {
    fetchProviders(fetch, apiBaseUrl, token, propertyId)
      .then(setProviders)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudieron cargar los proveedores."));
    fetchServices(fetch, apiBaseUrl, token, propertyId)
      .then(setServices)
      .catch((err: unknown) => setWaitlistError(err instanceof Error ? err.message : "No se pudieron cargar los servicios."));
  }, [apiBaseUrl, token, propertyId]);

  async function loadWaitlist() {
    setWaitlistLoading(true);
    setWaitlistError(null);
    try {
      const result = await fetchWaitlist(fetch, apiBaseUrl, token, propertyId, { providerId: providerFilter || undefined, serviceId: waitlistServiceFilter || undefined });
      setWaitlist(result);
    } catch (err) {
      setWaitlistError(err instanceof Error ? err.message : "No se pudo cargar la lista de espera.");
    } finally {
      setWaitlistLoading(false);
    }
  }

  useEffect(() => {
    // Mismos filtros de provider_id/service_id que el broadcast — reusa
    // `providerFilter` (selector ya existente de la agenda) y agrega
    // `waitlistServiceFilter` propio de esta sección.
    void loadWaitlist();
  }, [apiBaseUrl, token, propertyId, providerFilter, waitlistServiceFilter]);

  async function handleBroadcastWaitlist() {
    if (!window.confirm("¿Avisar a la lista de espera que un horario se liberó? Se les manda un mensaje real de WhatsApp.")) return;
    setBroadcasting(true);
    setWaitlistError(null);
    setBroadcastSummary(null);
    try {
      const summary = await broadcastWaitlist(fetch, apiBaseUrl, token, propertyId, { providerId: providerFilter || undefined, serviceId: waitlistServiceFilter || undefined });
      setBroadcastSummary(summary);
      await loadWaitlist();
    } catch (err) {
      setWaitlistError(err instanceof Error ? err.message : "No se pudo avisar a la lista de espera.");
    } finally {
      setBroadcasting(false);
    }
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAppointments(fetch, apiBaseUrl, token, propertyId, { fromIso: range.fromIso, toIso: range.toIso, providerId: providerFilter || undefined });
      setAppointments(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las citas.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // `load` se recrea cada render (depende de `providerFilter`, ya en el arreglo
    // de dependencias) — mismo criterio que Dashboard.tsx de restaurantes: este
    // proyecto no tiene configurado eslint-plugin-react-hooks, así que no hace
    // falta silenciar nada. `realtimeNonce` dispara el mismo `load()` cuando
    // Realtime avisa un cambio ajeno (Fase 10, ver efecto de abajo).
    void load();
  }, [apiBaseUrl, token, propertyId, range.fromIso, range.toIso, providerFilter, realtimeNonce]);

  useEffect(() => {
    // Fase 10 — Realtime nunca es la fuente de datos (ver cabecera de
    // realtime-client.ts): el callback ignora el payload del evento y solo
    // dispara el mismo refetch autenticado de siempre incrementando el nonce.
    // Sin `orgId` (organización aún no resuelta) no hay nada a qué suscribirse.
    if (!orgId) return;
    return subscribeToAppointmentChanges(orgId, token, () => setRealtimeNonce((n) => n + 1));
  }, [orgId, token]);

  async function runLifecycleAction(appointmentId: string, action: LifecycleAction, confirmMessage: string | null, run: () => Promise<AppointmentSummary>, errorFallback: string) {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setPendingAction({ id: appointmentId, action });
    setError(null);
    try {
      await run();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : errorFallback);
    } finally {
      setPendingAction(null);
    }
  }

  async function handleCancel(appointmentId: string) {
    await runLifecycleAction(appointmentId, "cancel", "¿Cancelar esta cita? Esta acción no se puede deshacer.", () => cancelAppointment(fetch, apiBaseUrl, token, propertyId, appointmentId), "No se pudo cancelar la cita.");
  }

  async function handleConfirm(appointmentId: string) {
    await runLifecycleAction(appointmentId, "confirm", null, () => confirmAppointment(fetch, apiBaseUrl, token, propertyId, appointmentId), "No se pudo confirmar la cita.");
  }

  async function handleComplete(appointmentId: string) {
    await runLifecycleAction(appointmentId, "complete", null, () => completeAppointment(fetch, apiBaseUrl, token, propertyId, appointmentId), "No se pudo marcar la cita como completada.");
  }

  async function handleNoShow(appointmentId: string) {
    await runLifecycleAction(
      appointmentId,
      "no_show",
      "¿Marcar esta cita como no-show? El cliente no se presentó y el horario del proveedor queda libre de inmediato.",
      () => markAppointmentNoShow(fetch, apiBaseUrl, token, propertyId, appointmentId),
      "No se pudo marcar la cita como no-show.",
    );
  }

  // Fase 6 §2 (seguimiento, "citas-sync-errores-visibles") — "Reintentar
  // sincronización": solo tiene efecto real sobre una cita 'invalid' (rechazo
  // permanente de validación, p.ej. Cal.com exige el correo del cliente); el
  // servidor responde 409 si la cita no está en ese estado (ver
  // appointments-lifecycle.ts).
  async function handleRetrySync(appointmentId: string) {
    await runLifecycleAction(appointmentId, "retry_sync", null, () => retryAppointmentCalendarSync(fetch, apiBaseUrl, token, propertyId, appointmentId), "No se pudo reintentar la sincronización de esta cita.");
  }

  async function handleCreateAppointment(e: FormEvent) {
    e.preventDefault();
    if (!newProviderId || !newServiceId || !newCustomerName.trim() || !newCustomerPhone.trim() || !newStartsAt) return;
    setCreatingAppointment(true);
    setCreateError(null);
    try {
      await createAppointment(fetch, apiBaseUrl, token, propertyId, {
        providerId: newProviderId,
        serviceId: newServiceId,
        customerName: newCustomerName.trim(),
        customerPhone: newCustomerPhone.trim(),
        customerEmail: newCustomerEmail.trim() || undefined,
        // El <input type="datetime-local"> devuelve hora LOCAL sin offset — se manda
        // tal cual el `Date` la interpreta (hora local del navegador) y se serializa
        // a ISO con offset real antes de mandarla al servidor.
        startsAt: new Date(newStartsAt).toISOString(),
        notes: newNotes.trim() || undefined,
      });
      setNewProviderId("");
      setNewServiceId("");
      setNewCustomerName("");
      setNewCustomerPhone("");
      setNewCustomerEmail("");
      setNewStartsAt("");
      setNewNotes("");
      setShowNewForm(false);
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "No se pudo crear la cita.");
    } finally {
      setCreatingAppointment(false);
    }
  }

  const groups = appointments ? groupByDay(appointments) : [];


  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">{saludoConNombre(staffFullName, staffEmail)}</p>
          <h1 className="font-display text-xl font-semibold text-foreground">Agenda</h1>
          <p className="mt-1 text-[13px] capitalize text-muted-foreground">{range.label}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="citas-agenda-proveedor" className="sr-only">
            Filtrar por proveedor
          </Label>
          <select id="citas-agenda-proveedor" value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} className={SELECT_CLASS}>
            <option value="">Todos los proveedores</option>
            {providers?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>

          <Tabs value={view} onValueChange={(v) => setView(v as ViewMode)}>
            <TabsList>
              <TabsTrigger value="month">Mes</TabsTrigger>
              <TabsTrigger value="week">Semana</TabsTrigger>
            </TabsList>
          </Tabs>

          <Button variant="outline" size="sm" onClick={() => setAnchor((a) => shiftAnchor(a, view, -1))}>
            <ChevronLeft aria-hidden />
            Anterior
          </Button>
          {/* Bug real (revisión r6 de corrección de PR #171, bloqueante 1): este botón seguía
              con `setAnchor(new Date())` -- el mismo bug que el estado inicial de `anchor` de
              arriba ya corrige (ver su comentario), pero reintroducido aquí. Mismo fix: anclar
              al día de CALENDARIO del negocio, nunca al instante UTC. */}
          <Button variant="outline" size="sm" onClick={() => setAnchor(parseFechaSolo(hoyFechaSolo()))}>
            Hoy
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAnchor((a) => shiftAnchor(a, view, 1))}>
            Siguiente
            <ChevronRight aria-hidden />
          </Button>
          <Button size="sm" onClick={() => setShowNewForm(true)}>
            <CalendarPlus aria-hidden />
            Nueva cita
          </Button>
        </div>
      </header>

      {/* Alta manual real (misma llamada `createAppointment` de siempre) — antes era
          una sección plegable inline; ahora es el modal lateral real del design
          system (ModalFormularioLateral), mismo estado `showNewForm` que la
          gobernaba. El botón de guardar vive en el pie del modal y dispara el
          `submit` del <form> de abajo vía `form="citas-nueva-cita"`, para no perder
          la validación nativa de los campos `required`. */}
      <ModalFormularioLateral
        open={showNewForm}
        onOpenChange={setShowNewForm}
        titulo="Nueva cita"
        subtitulo="Alta manual desde el panel — la misma cita que registraría el agente."
        anchoClase="max-w-3xl"
        footer={
          <Button type="submit" form="citas-nueva-cita" disabled={creatingAppointment} className="rounded-full px-6">
            {creatingAppointment ? "Creando…" : "Crear cita"}
          </Button>
        }
      >
        <form id="citas-nueva-cita" onSubmit={handleCreateAppointment} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="citas-nueva-proveedor">Proveedor</Label>
              <select id="citas-nueva-proveedor" required value={newProviderId} onChange={(e) => setNewProviderId(e.target.value)} className={SELECT_CLASS}>
                <option value="">Proveedor…</option>
                {providers?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="citas-nueva-servicio">Servicio</Label>
              <select id="citas-nueva-servicio" required value={newServiceId} onChange={(e) => setNewServiceId(e.target.value)} className={SELECT_CLASS}>
                <option value="">Servicio…</option>
                {services?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="citas-nueva-inicio">Fecha y hora</Label>
              <Input id="citas-nueva-inicio" required type="datetime-local" value={newStartsAt} onChange={(e) => setNewStartsAt(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="citas-nueva-cliente">Nombre del cliente</Label>
              <Input id="citas-nueva-cliente" required placeholder="Nombre del cliente" value={newCustomerName} onChange={(e) => setNewCustomerName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="citas-nueva-telefono">Teléfono</Label>
              <Input id="citas-nueva-telefono" required placeholder="Teléfono" value={newCustomerPhone} onChange={(e) => setNewCustomerPhone(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="citas-nueva-correo">Correo (opcional)</Label>
              <Input id="citas-nueva-correo" type="email" placeholder="Correo (opcional)" value={newCustomerEmail} onChange={(e) => setNewCustomerEmail(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="citas-nueva-notas">Notas (opcional)</Label>
              <Input id="citas-nueva-notas" placeholder="Notas (opcional)" value={newNotes} onChange={(e) => setNewNotes(e.target.value)} />
            </div>
          </div>
          {createError && (
            <p role="alert" className="text-[13px] text-destructive">
              {createError}
            </p>
          )}
        </form>
      </ModalFormularioLateral>

      {error && <EstadoError mensaje={error} />}

      {loading && !appointments && <EstadoCargando etiqueta="Cargando citas…" />}

      {appointments && appointments.length === 0 && !loading && <EstadoVacio icon={CalendarX2} mensaje="No hay citas en este rango." />}

      {groups.map(([day, dayAppointments]) => (
        <section key={day} className="flex flex-col gap-2">
          <h2 className="border-b border-border pb-1 text-[13px] font-semibold capitalize text-foreground">{formatDateLong(dayAppointments[0]!.startsAt)}</h2>
          {dayAppointments.map((apt) => (
            <Card key={apt.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    {formatTimeRange(apt.startsAt, apt.endsAt)} — {apt.serviceName ?? "Servicio desconocido"}
                  </p>
                  <p className="mt-0.5 text-[13px] text-foreground/80">
                    {apt.customerName ?? "Cliente desconocido"} {apt.customerPhone ? `· ${apt.customerPhone}` : ""}
                  </p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">
                    {apt.providerName ?? "Proveedor desconocido"} · {formatAppointmentSource(apt.source)}
                  </p>
                  {/* Fase 6 §2 (seguimiento, "citas-sync-errores-visibles") — indicador
                      discreto de sincronización con el calendario externo, solo cuando
                      de verdad requiere atención ('error'/'invalid' — el flujo normal
                      'pending'/'synced'/'skipped' nunca se muestra aquí, sería ruido). */}
                  {googleSyncStatusNeedsAttention(apt.googleSyncStatus) && (
                    <p className="mt-1 flex items-start gap-1 text-[12px] text-amber-700 dark:text-amber-400">
                      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        {formatGoogleSyncStatus(apt.googleSyncStatus)}
                        {apt.googleSyncError ? `: ${apt.googleSyncError}` : ""}
                      </span>
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={statusBadgeVariant(apt.status)}>{formatAppointmentStatus(apt.status)}</Badge>
                  {apt.googleSyncStatus === "invalid" && (
                    <Button variant="outline" size="sm" onClick={() => void handleRetrySync(apt.id)} disabled={pendingAction !== null && pendingAction.id === apt.id}>
                      <RefreshCw aria-hidden />
                      {pendingAction?.id === apt.id && pendingAction.action === "retry_sync" ? "Reintentando…" : "Reintentar sincronización"}
                    </Button>
                  )}
                  {CONFIRMABLE_STATUSES.has(apt.status) && (
                    <Button variant="outline" size="sm" onClick={() => void handleConfirm(apt.id)} disabled={pendingAction !== null && pendingAction.id === apt.id}>
                      <Check aria-hidden />
                      {pendingAction?.id === apt.id && pendingAction.action === "confirm" ? "Confirmando…" : "Confirmar"}
                    </Button>
                  )}
                  {COMPLETABLE_STATUSES.has(apt.status) && (
                    <Button variant="outline" size="sm" onClick={() => void handleComplete(apt.id)} disabled={pendingAction !== null && pendingAction.id === apt.id}>
                      <CheckCheck aria-hidden />
                      {pendingAction?.id === apt.id && pendingAction.action === "complete" ? "Completando…" : "Completar"}
                    </Button>
                  )}
                  {NO_SHOW_STATUSES.has(apt.status) && (
                    <Button variant="outline" size="sm" onClick={() => void handleNoShow(apt.id)} disabled={pendingAction !== null && pendingAction.id === apt.id}>
                      <UserX aria-hidden />
                      {pendingAction?.id === apt.id && pendingAction.action === "no_show" ? "Marcando…" : "No-show"}
                    </Button>
                  )}
                  {CANCELABLE_STATUSES.has(apt.status) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => void handleCancel(apt.id)}
                      disabled={pendingAction !== null && pendingAction.id === apt.id}
                    >
                      <X aria-hidden />
                      {pendingAction?.id === apt.id && pendingAction.action === "cancel" ? "Cancelando…" : "Cancelar"}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </section>
      ))}

      <Card className="mt-2">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base">Lista de espera</CardTitle>
            <CardDescription className="mt-1">Clientes esperando un horario, en el mismo orden en que se les avisaría (FIFO).</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="citas-espera-servicio" className="sr-only">
              Filtrar la lista de espera por servicio
            </Label>
            <select id="citas-espera-servicio" value={waitlistServiceFilter} onChange={(e) => setWaitlistServiceFilter(e.target.value)} className={SELECT_CLASS}>
              <option value="">Todos los servicios</option>
              {services?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              onClick={() => void handleBroadcastWaitlist()}
              disabled={broadcasting || waitlistLoading || (waitlist !== null && waitlist.length === 0)}
            >
              <Megaphone aria-hidden />
              {broadcasting ? "Avisando…" : "Avisar a la lista de espera"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-[12px] text-muted-foreground">
            Filtro de proveedor: el mismo selector de arriba ({providerFilter ? providers?.find((p) => p.id === providerFilter)?.displayName ?? providerFilter : "todos los proveedores"}).
          </p>

          {waitlistError && <EstadoError mensaje={waitlistError} />}

          {broadcastSummary && !broadcastSummary.queued && (
            // Corrección bloqueante de la ronda 2 de revisión del PR #180 — la
            // base todavía no tiene aplicadas las migraciones que este flujo
            // necesita: la ruta NO encoló ninguna tarea real (ver
            // `admin.ts::POST .../waitlist/broadcast`), así que este mensaje
            // NUNCA debe decir "Aviso encolado" (sería una confirmación falsa
            // -- exactamente el éxito falso que la ronda 2 encontró).
            <p role="status" className="rounded-md border border-border bg-muted px-3 py-2 text-[13px] text-foreground">
              Avisar a la lista de espera todavía no está disponible en este negocio (falta terminar de actualizar la base de datos). Ningún aviso se encoló; vuelve a intentarlo más tarde.
            </p>
          )}

          {broadcastSummary && broadcastSummary.queued && (
            <p role="status" className="rounded-md border border-border bg-muted px-3 py-2 text-[13px] text-foreground">
              {/* Corrección post-revisión (hallazgo B): el efecto real corre
                  post-commit, en segundo plano — este mensaje ya no promete un
                  "Avisados: N" síncrono (esa cifra no existe todavía cuando la
                  ruta responde), solo confirma que el aviso quedó encolado. */}
              Aviso encolado para {broadcastSummary.candidatesConsidered} candidato{broadcastSummary.candidatesConsidered === 1 ? "" : "s"} considerado{broadcastSummary.candidatesConsidered === 1 ? "" : "s"}; se procesa en segundo plano.
              {broadcastSummary.skippedNoWhatsappConfig ? " Este negocio no tiene WhatsApp configurado todavía, así que ningún aviso podrá salir." : ""}
            </p>
          )}

          {waitlistLoading && !waitlist && <EstadoCargando lineas={2} etiqueta="Cargando lista de espera…" />}

          {waitlist && waitlist.length === 0 && !waitlistLoading && <EstadoVacio icon={Clock} mensaje="Nadie está esperando con estos filtros." />}

          {waitlist && waitlist.length > 0 && (
            <Table>
              <TableCaption>Orden real en que se avisaría a cada cliente (FIFO).</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14">#</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Preferencias</TableHead>
                  <TableHead className="text-right">Avisos</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {waitlist.map((candidate) => (
                  <TableRow key={candidate.id}>
                    <TableCell className="font-medium text-foreground">#{candidate.position}</TableCell>
                    <TableCell>
                      <span className="block font-medium text-foreground">{candidate.customerName}</span>
                      <span className="block text-[12px] text-muted-foreground">{candidate.customerPhone}</span>
                    </TableCell>
                    <TableCell className="text-[12px] text-muted-foreground">
                      {candidate.preferredDateFrom || candidate.preferredTimeWindow
                        ? `${candidate.preferredDateFrom ? `desde ${candidate.preferredDateFrom}` : ""}${candidate.preferredDateFrom && candidate.preferredTimeWindow ? " · " : ""}${candidate.preferredTimeWindow ?? ""}`
                        : "Sin preferencia"}
                    </TableCell>
                    <TableCell className="text-right text-[12px] text-muted-foreground">
                      {candidate.notifiedCount > 0 ? `ya avisado ${candidate.notifiedCount}x` : "nunca avisado"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
