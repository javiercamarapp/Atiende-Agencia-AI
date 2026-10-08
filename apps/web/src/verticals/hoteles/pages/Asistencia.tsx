// Asistencia — checador de asistencia (Fase 16 hoteles, REQ-BO-024, P0/GOB, LFT
// art.132 fr.XXXIV). Hallazgo de auditoría (severidad ALTA, "P&L USALI y checador de
// asistencia LFT sin UI: el checador"): apps/api/src/routes/verticals/hoteles/
// asistencia.ts existía completo (fichaje, historial, horarios, cruce, exportación
// STPS) sin cliente ni página — ningún empleado podía fichar de verdad. Esta página
// SOLO cubre el checador (autoservicio + horarios/cruce/exportación de
// administración) — el resto de P&L USALI (migrations/20240101000071_012_pl_usali.sql)
// queda fuera de alcance de este hallazgo, ver README del vertical.
//
// Autoservicio SIN gating de rol (accesible a TODO staff autenticado, mismo criterio
// que exige el propio backend: /checar no acepta lista de roles, ver comentario de
// cabecera de asistencia.ts) + una sección de administración (horarios/cruce/
// exportar-STPS) gateada COSMÉTICAMENTE por rol, mismo patrón que
// PEDIDOS_FNB_NAV_ROLES en HotelesShell.tsx: solo oculta lo que el servidor
// rechazaría igual con 403 (assertVerticalRole(c, ATTENDANCE_ADMIN_ROLES) en
// asistencia.ts) — nunca la única barrera. Constante duplicada aquí a propósito:
// apps/web no depende de ningún paquete domain-* (ver comentario de cabecera de
// reservas-client.ts/folios-client.ts).
//
// Visual (ronda de integración del design system real, @atiende/ui): reemplaza
// tarjetas/tablas/inputs de estilos inline por Card/Table/Input/Label/Button
// reales — mismo criterio ya aplicado en HotelesShell.tsx/Login.tsx. El aviso
// transitorio "Horario guardado." ahora usa `toast` en vez de un banner
// persistente. Ningún cambio de lógica: mismos props, mismo estado, mismas
// llamadas de red.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { LogIn, LogOut } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  DataTable,
  EstadoCargando,
  EstadoVacio,
  FormField,
  Input,
  PageContainer,
  PageHeader,
  toast,
} from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import {
  checkIn,
  fetchAttendance,
  fetchCrossCheck,
  fetchStpsExportCsv,
  upsertStaffSchedule,
} from "../lib/asistencia-client.ts";
import type { AttendanceEvent, CrossCheckRow } from "../lib/asistencia-client.ts";
import { fechaHoraEsMx, formatFechaSolo, hoyFechaSolo, parseFechaSolo } from "../../../lib/formato-fecha.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const ATTENDANCE_ADMIN_ROLES_NAV: ReadonlySet<string> = new Set(["owner", "gm"]);

// `hoyFechaSolo()` (día de calendario en America/Mexico_City), NO
// `new Date().toISOString().slice(0, 10)` (día UTC) -- ese patrón viejo
// precargaba MAÑANA en vez de HOY entre las 18:00 y las 23:59 hora de CDMX
// (00:00-05:59 UTC), tanto en el default del día de trabajo (`workDate`) como
// en el rango de consulta de asistencia (`desde`/`hasta`). Ver
// apps/web/src/lib/formato-fecha.ts.
function todayIso(): string {
  return hoyFechaSolo();
}

function sevenDaysAgoIso(): string {
  const d = parseFechaSolo(hoyFechaSolo());
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

function formatHora(iso: string): string {
  try {
    return fechaHoraEsMx(iso);
  } catch {
    return iso;
  }
}

const COLUMNAS_CRUCE: readonly DataTableColumna<CrossCheckRow>[] = [
  { id: "fecha", encabezado: "Fecha", principal: true, celda: (r) => formatFechaSolo(r.fecha), valorOrden: (r) => r.fecha },
  { id: "estado", encabezado: "Estado", celda: (r) => r.estado, valorOrden: (r) => r.estado },
  { id: "programadas", encabezado: "Programadas", alinear: "right", celda: (r) => r.horasProgramadas ?? "—", valorOrden: (r) => r.horasProgramadas },
  { id: "trabajadas", encabezado: "Trabajadas", alinear: "right", celda: (r) => r.horasTrabajadas, valorOrden: (r) => r.horasTrabajadas },
  { id: "extra", encabezado: "Extra autorizada", alinear: "right", celda: (r) => r.horasExtraAutorizadas, valorOrden: (r) => r.horasExtraAutorizadas },
  {
    id: "extraNo",
    encabezado: "Extra NO autorizada",
    alinear: "right",
    celda: (r) => <span className={r.horasExtraNoAutorizadas > 0 ? "font-bold text-destructive" : undefined}>{r.horasExtraNoAutorizadas}</span>,
    valorOrden: (r) => r.horasExtraNoAutorizadas,
  },
];

export function AsistenciaPage({ apiBaseUrl, token, propertyId, role }: HotelesShellContext) {
  // ---- Autoservicio: fichaje propio ----
  const [misEventos, setMisEventos] = useState<readonly AttendanceEvent[] | null>(null);
  const [errorPropio, setErrorPropio] = useState<string | null>(null);
  const [fichando, setFichando] = useState<"entrada" | "salida" | null>(null);
  const [notaFichaje, setNotaFichaje] = useState("");

  async function cargarMisEventos() {
    setErrorPropio(null);
    try {
      setMisEventos(await fetchAttendance(fetch, apiBaseUrl, token, propertyId, { fromDate: sevenDaysAgoIso(), toDate: todayIso() }));
    } catch (err) {
      setErrorPropio(err instanceof Error ? err.message : "No se pudo cargar tu historial de asistencia.");
    }
  }

  useEffect(() => {
    void cargarMisEventos();
  }, [apiBaseUrl, token, propertyId]);

  const ultimoEvento = misEventos && misEventos.length > 0 ? misEventos[misEventos.length - 1] : null;
  const siguienteEvento: "entrada" | "salida" = ultimoEvento?.eventType === "entrada" ? "salida" : "entrada";

  async function handleFichar(eventType: "entrada" | "salida") {
    setFichando(eventType);
    setErrorPropio(null);
    try {
      await checkIn(fetch, apiBaseUrl, token, propertyId, eventType, notaFichaje.trim() || undefined);
      setNotaFichaje("");
      await cargarMisEventos();
    } catch (err) {
      setErrorPropio(err instanceof Error ? err.message : "No se pudo registrar el fichaje.");
    } finally {
      setFichando(null);
    }
  }

  return (
    <PageContainer padding="none" className="gap-4">
      <PageHeader titulo="Asistencia" descripcion="Checador de autoservicio — LFT art. 132 fr. XXXIV." />

      <Card>
        <CardContent className="p-4 flex flex-col gap-3">
          <p className="text-sm text-foreground">
            {ultimoEvento ? (
              <>
                Último registro: <strong>{ultimoEvento.eventType === "entrada" ? "Entrada" : "Salida"}</strong> el {formatHora(ultimoEvento.recordedAt)}
              </>
            ) : (
              "Todavía no tienes ningún registro de asistencia."
            )}
          </p>
          <FormField id="asis-nota" label="Nota (opcional)">
            <Input value={notaFichaje} onChange={(e) => setNotaFichaje(e.target.value)} />
          </FormField>
          <div className="flex gap-2">
            <Button
              type="button"
              className="flex-1"
              variant={siguienteEvento === "entrada" ? "default" : "outline"}
              onClick={() => void handleFichar("entrada")}
              loading={fichando === "entrada"}
              disabled={fichando !== null}
            >
              <LogIn className="w-4 h-4" strokeWidth={1.75} />
              Marcar entrada
            </Button>
            <Button
              type="button"
              className="flex-1"
              variant={siguienteEvento === "salida" ? "destructive" : "outline"}
              onClick={() => void handleFichar("salida")}
              loading={fichando === "salida"}
              disabled={fichando !== null}
            >
              <LogOut className="w-4 h-4" strokeWidth={1.75} />
              Marcar salida
            </Button>
          </div>
          {errorPropio && <Callout tone="danger">{errorPropio}</Callout>}
        </CardContent>
      </Card>

      <section>
        <h2 className="text-sm font-semibold text-foreground mb-2">Tus últimos 7 días</h2>
        {!misEventos && !errorPropio && <EstadoCargando lineas={2} etiqueta="Cargando tu historial…" />}
        {misEventos && misEventos.length === 0 && <EstadoVacio mensaje="Sin registros en este rango." />}
        {misEventos && misEventos.length > 0 && (
          <div className="flex flex-col gap-1">
            {[...misEventos].reverse().map((e) => (
              <div key={e.id} className="flex justify-between text-sm px-2.5 py-1.5 border border-border rounded-lg">
                <span className="text-foreground">{e.eventType === "entrada" ? "Entrada" : "Salida"}</span>
                <span className="text-muted-foreground">{formatHora(e.recordedAt)}</span>
                {e.nota && <span className="text-muted-foreground">{e.nota}</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      {ATTENDANCE_ADMIN_ROLES_NAV.has(role) && <AdministracionAsistencia apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} />}
    </PageContainer>
  );
}

/** Sección de administración (owner/gm): programar horarios y cruzarlos contra lo
 * realmente trabajado, más la exportación STPS del rango — ver ATTENDANCE_ADMIN_ROLES
 * en domain-hoteles/src/roles.ts (fuente de verdad real, aplicada por el servidor). */
function AdministracionAsistencia({ apiBaseUrl, token, propertyId }: { apiBaseUrl: string; token: string; propertyId: string }) {
  const [staffUserId, setStaffUserId] = useState("");

  // Horario
  const [workDate, setWorkDate] = useState(todayIso());
  const [scheduledStart, setScheduledStart] = useState("");
  const [scheduledEnd, setScheduledEnd] = useState("");
  const [authorizedOvertimeMinutes, setAuthorizedOvertimeMinutes] = useState(0);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  // Cruce
  const [desde, setDesde] = useState(sevenDaysAgoIso());
  const [hasta, setHasta] = useState(todayIso());
  const [cruce, setCruce] = useState<readonly CrossCheckRow[] | null>(null);
  const [cruceError, setCruceError] = useState<string | null>(null);
  const [consultandoCruce, setConsultandoCruce] = useState(false);
  const [exportando, setExportando] = useState(false);

  async function handleGuardarHorario(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setScheduleError(null);
    if (!staffUserId.trim()) return setScheduleError("staffUserId: requerido (UUID del empleado).");
    if (!scheduledStart || !scheduledEnd) return setScheduleError("Hora de inicio y fin del turno son requeridas.");
    setSavingSchedule(true);
    try {
      await upsertStaffSchedule(fetch, apiBaseUrl, token, propertyId, {
        staffUserId: staffUserId.trim(),
        workDate,
        scheduledStart: new Date(scheduledStart).toISOString(),
        scheduledEnd: new Date(scheduledEnd).toISOString(),
        authorizedOvertimeMinutes,
      });
      toast.success("Horario guardado.");
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : "No se pudo guardar el horario.");
    } finally {
      setSavingSchedule(false);
    }
  }

  async function handleConsultarCruce() {
    setCruceError(null);
    if (!staffUserId.trim()) return setCruceError("staffUserId: requerido (UUID del empleado).");
    setConsultandoCruce(true);
    try {
      setCruce(await fetchCrossCheck(fetch, apiBaseUrl, token, propertyId, staffUserId.trim(), desde, hasta));
    } catch (err) {
      setCruceError(err instanceof Error ? err.message : "No se pudo calcular el cruce.");
    } finally {
      setConsultandoCruce(false);
    }
  }

  async function handleExportarStps() {
    setCruceError(null);
    if (!staffUserId.trim()) return setCruceError("staffUserId: requerido (UUID del empleado).");
    setExportando(true);
    try {
      const csv = await fetchStpsExportCsv(fetch, apiBaseUrl, token, propertyId, staffUserId.trim(), desde, hasta);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `asistencia-stps-${staffUserId.trim()}-${desde}-a-${hasta}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setCruceError(err instanceof Error ? err.message : "No se pudo exportar el CSV.");
    } finally {
      setExportando(false);
    }
  }

  return (
    <section className="border-t border-border pt-5 flex flex-col gap-5">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Administración de asistencia</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Programar horarios, cruzarlos contra lo trabajado y exportar a la STPS. Solo owner/gm.</p>
      </div>

      <FormField id="asis-staff-id" label="Empleado (staffUserId, UUID)" className="max-w-md">
        <Input value={staffUserId} onChange={(e) => setStaffUserId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" className="font-mono text-xs" />
      </FormField>

      <Card>
        <CardContent className="p-4">
          <form onSubmit={handleGuardarHorario} className="flex flex-col gap-3">
            <p className="text-sm font-semibold text-foreground">Programar horario</p>
            <FormField id="asis-fecha" label="Fecha" required>
              <Input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField id="asis-entrada-prog" label="Entrada programada" required>
                <Input type="datetime-local" value={scheduledStart} onChange={(e) => setScheduledStart(e.target.value)} />
              </FormField>
              <FormField id="asis-salida-prog" label="Salida programada" required>
                <Input type="datetime-local" value={scheduledEnd} onChange={(e) => setScheduledEnd(e.target.value)} />
              </FormField>
            </div>
            <FormField id="asis-extra-min" label="Horas extra autorizadas (minutos)">
              <Input type="number" min={0} value={authorizedOvertimeMinutes} onChange={(e) => setAuthorizedOvertimeMinutes(Number(e.target.value) || 0)} />
            </FormField>
            {scheduleError && <Callout tone="danger">{scheduleError}</Callout>}
            <Button type="submit" loading={savingSchedule} disabled={savingSchedule}>
              Guardar horario
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold text-foreground">Cruce contra lo trabajado</p>
        <div className="flex gap-3 flex-wrap items-end">
          <FormField id="asis-desde" label="Desde">
            <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
          </FormField>
          <FormField id="asis-hasta" label="Hasta">
            <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
          </FormField>
          <Button type="button" variant="outline" onClick={() => void handleConsultarCruce()} loading={consultandoCruce} disabled={consultandoCruce}>
            Calcular cruce
          </Button>
          <Button type="button" variant="outline" onClick={() => void handleExportarStps()} loading={exportando} disabled={exportando}>
            Exportar CSV (STPS)
          </Button>
        </div>

        {cruceError && <Callout tone="danger">{cruceError}</Callout>}

        {cruce && (
          <DataTable
            etiqueta="Cruce de asistencia contra lo trabajado"
            columnas={COLUMNAS_CRUCE}
            filas={cruce}
            obtenerId={(r) => r.fecha}
            atributosFila={(r) => ({ "data-alerta": r.alerta ? "si" : "no" })}
            vacio={{ mensaje: "Sin días en este rango." }}
            paginacion={false}
          />
        )}
      </div>
    </section>
  );
}
