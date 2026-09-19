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
  Card,
  CardContent,
  EstadoCargando,
  EstadoVacio,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@atiende/ui";
import {
  checkIn,
  fetchAttendance,
  fetchCrossCheck,
  fetchStpsExportCsv,
  upsertStaffSchedule,
} from "../lib/asistencia-client.ts";
import type { AttendanceEvent, CrossCheckRow } from "../lib/asistencia-client.ts";
import { hoyFechaSolo, parseFechaSolo } from "../../../lib/formato-fecha.ts";
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
    return new Date(iso).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

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
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-display font-semibold text-foreground">Asistencia</h1>
        <p className="mt-1 text-sm text-muted-foreground">Checador de autoservicio — LFT art. 132 fr. XXXIV.</p>
      </header>

      <Card className="max-w-md">
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
          <div>
            <Label htmlFor="asis-nota">Nota (opcional)</Label>
            <Input id="asis-nota" value={notaFichaje} onChange={(e) => setNotaFichaje(e.target.value)} className="mt-1" />
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              className="flex-1"
              variant={siguienteEvento === "entrada" ? "default" : "outline"}
              onClick={() => void handleFichar("entrada")}
              disabled={fichando !== null}
            >
              <LogIn className="w-4 h-4" strokeWidth={1.75} />
              {fichando === "entrada" ? "Registrando…" : "Marcar entrada"}
            </Button>
            <Button
              type="button"
              className="flex-1"
              variant={siguienteEvento === "salida" ? "destructive" : "outline"}
              onClick={() => void handleFichar("salida")}
              disabled={fichando !== null}
            >
              <LogOut className="w-4 h-4" strokeWidth={1.75} />
              {fichando === "salida" ? "Registrando…" : "Marcar salida"}
            </Button>
          </div>
          {errorPropio && <p role="alert" className="text-sm text-destructive">{errorPropio}</p>}
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
    </div>
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
        <h2 className="text-base font-semibold text-foreground">Administración de asistencia</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Programar horarios, cruzarlos contra lo trabajado y exportar a la STPS. Solo owner/gm.</p>
      </div>

      <div className="max-w-md">
        <Label htmlFor="asis-staff-id">Empleado (staffUserId, UUID)</Label>
        <Input id="asis-staff-id" value={staffUserId} onChange={(e) => setStaffUserId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" className="mt-1 font-mono text-xs" />
      </div>

      <Card className="max-w-md">
        <CardContent className="p-4">
          <form onSubmit={handleGuardarHorario} className="flex flex-col gap-3">
            <p className="text-sm font-semibold text-foreground">Programar horario</p>
            <div>
              <Label htmlFor="asis-fecha">Fecha</Label>
              <Input id="asis-fecha" type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} required className="mt-1" />
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <Label htmlFor="asis-entrada-prog">Entrada programada</Label>
                <Input id="asis-entrada-prog" type="datetime-local" value={scheduledStart} onChange={(e) => setScheduledStart(e.target.value)} required className="mt-1" />
              </div>
              <div className="flex-1">
                <Label htmlFor="asis-salida-prog">Salida programada</Label>
                <Input id="asis-salida-prog" type="datetime-local" value={scheduledEnd} onChange={(e) => setScheduledEnd(e.target.value)} required className="mt-1" />
              </div>
            </div>
            <div>
              <Label htmlFor="asis-extra-min">Horas extra autorizadas (minutos)</Label>
              <Input
                id="asis-extra-min"
                type="number"
                min={0}
                value={authorizedOvertimeMinutes}
                onChange={(e) => setAuthorizedOvertimeMinutes(Number(e.target.value) || 0)}
                className="mt-1"
              />
            </div>
            {scheduleError && <p role="alert" className="text-sm text-destructive">{scheduleError}</p>}
            <Button type="submit" disabled={savingSchedule}>
              {savingSchedule ? "Guardando…" : "Guardar horario"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold text-foreground">Cruce contra lo trabajado</p>
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <Label htmlFor="asis-desde">Desde</Label>
            <Input id="asis-desde" type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label htmlFor="asis-hasta">Hasta</Label>
            <Input id="asis-hasta" type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="mt-1" />
          </div>
          <Button type="button" variant="outline" onClick={() => void handleConsultarCruce()} disabled={consultandoCruce}>
            {consultandoCruce ? "Calculando…" : "Calcular cruce"}
          </Button>
          <Button type="button" variant="outline" onClick={() => void handleExportarStps()} disabled={exportando}>
            {exportando ? "Exportando…" : "Exportar CSV (STPS)"}
          </Button>
        </div>

        {cruceError && <p role="alert" className="text-sm text-destructive">{cruceError}</p>}

        {cruce && cruce.length === 0 && <p className="text-sm text-muted-foreground">Sin días en este rango.</p>}
        {cruce && cruce.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Programadas</TableHead>
                <TableHead>Trabajadas</TableHead>
                <TableHead>Extra autorizada</TableHead>
                <TableHead>Extra NO autorizada</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cruce.map((row) => (
                <TableRow key={row.fecha} className={row.alerta ? "bg-destructive/5" : undefined}>
                  <TableCell>{row.fecha}</TableCell>
                  <TableCell>{row.estado}</TableCell>
                  <TableCell>{row.horasProgramadas ?? "—"}</TableCell>
                  <TableCell>{row.horasTrabajadas}</TableCell>
                  <TableCell>{row.horasExtraAutorizadas}</TableCell>
                  <TableCell className={row.horasExtraNoAutorizadas > 0 ? "font-bold text-destructive" : undefined}>{row.horasExtraNoAutorizadas}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}
