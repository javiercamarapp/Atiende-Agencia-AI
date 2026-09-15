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
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  checkIn,
  fetchAttendance,
  fetchCrossCheck,
  fetchStpsExportCsv,
  upsertStaffSchedule,
} from "../lib/asistencia-client.ts";
import type { AttendanceEvent, CrossCheckRow } from "../lib/asistencia-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const ATTENDANCE_ADMIN_ROLES_NAV: ReadonlySet<string> = new Set(["owner", "gm"]);

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function sevenDaysAgoIso(): string {
  const d = new Date();
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
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: 0 }}>Asistencia</h1>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6b7280" }}>Checador de autoservicio — LFT art. 132 fr. XXXIV.</p>
      </header>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, maxWidth: 420, display: "flex", flexDirection: "column", gap: 10 }}>
        <p style={{ margin: 0, fontSize: 13, color: "#374151" }}>
          {ultimoEvento ? (
            <>
              Último registro: <strong>{ultimoEvento.eventType === "entrada" ? "Entrada" : "Salida"}</strong> el {formatHora(ultimoEvento.recordedAt)}
            </>
          ) : (
            "Todavía no tienes ningún registro de asistencia."
          )}
        </p>
        <label style={{ fontSize: 13 }}>
          Nota (opcional)
          <input value={notaFichaje} onChange={(e) => setNotaFichaje(e.target.value)} style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }} />
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => void handleFichar("entrada")}
            disabled={fichando !== null}
            style={{
              flex: 1,
              padding: "12px 14px",
              fontWeight: 600,
              borderRadius: 8,
              border: "1px solid #065f46",
              background: siguienteEvento === "entrada" ? "#065f46" : "#fff",
              color: siguienteEvento === "entrada" ? "#fff" : "#065f46",
              cursor: fichando !== null ? "default" : "pointer",
            }}
          >
            {fichando === "entrada" ? "Registrando…" : "Marcar entrada"}
          </button>
          <button
            onClick={() => void handleFichar("salida")}
            disabled={fichando !== null}
            style={{
              flex: 1,
              padding: "12px 14px",
              fontWeight: 600,
              borderRadius: 8,
              border: "1px solid #991b1b",
              background: siguienteEvento === "salida" ? "#991b1b" : "#fff",
              color: siguienteEvento === "salida" ? "#fff" : "#991b1b",
              cursor: fichando !== null ? "default" : "pointer",
            }}
          >
            {fichando === "salida" ? "Registrando…" : "Marcar salida"}
          </button>
        </div>
        {errorPropio && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {errorPropio}
          </p>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>Tus últimos 7 días</h2>
        {!misEventos && !errorPropio && <p style={{ color: "#6b7280", fontSize: 13 }}>Cargando…</p>}
        {misEventos && misEventos.length === 0 && <p style={{ color: "#6b7280", fontSize: 13 }}>Sin registros en este rango.</p>}
        {misEventos && misEventos.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {[...misEventos].reverse().map((e) => (
              <div key={e.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "6px 10px", border: "1px solid #f3f4f6", borderRadius: 8 }}>
                <span>{e.eventType === "entrada" ? "Entrada" : "Salida"}</span>
                <span style={{ color: "#6b7280" }}>{formatHora(e.recordedAt)}</span>
                {e.nota && <span style={{ color: "#9ca3af" }}>{e.nota}</span>}
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
  const [scheduleMessage, setScheduleMessage] = useState<string | null>(null);

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
    setScheduleMessage(null);
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
      setScheduleMessage("Horario guardado.");
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
    <section style={{ borderTop: "1px solid #e5e7eb", paddingTop: 20, display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h2 style={{ fontSize: 16, margin: "0 0 4px" }}>Administración de asistencia</h2>
        <p style={{ margin: 0, fontSize: 12, color: "#6b7280" }}>Programar horarios, cruzarlos contra lo trabajado y exportar a la STPS. Solo owner/gm.</p>
      </div>

      <label style={{ fontSize: 13, maxWidth: 420 }}>
        Empleado (staffUserId, UUID)
        <input value={staffUserId} onChange={(e) => setStaffUserId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" style={{ display: "block", width: "100%", padding: 8, marginTop: 4, fontFamily: "monospace", fontSize: 12 }} />
      </label>

      <form onSubmit={handleGuardarHorario} style={{ display: "flex", flexDirection: "column", gap: 10, border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, maxWidth: 420 }}>
        <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>Programar horario</p>
        <label style={{ fontSize: 13 }}>
          Fecha
          <input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} required style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }} />
        </label>
        <div style={{ display: "flex", gap: 10 }}>
          <label style={{ fontSize: 13, flex: 1 }}>
            Entrada programada
            <input type="datetime-local" value={scheduledStart} onChange={(e) => setScheduledStart(e.target.value)} required style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 13, flex: 1 }}>
            Salida programada
            <input type="datetime-local" value={scheduledEnd} onChange={(e) => setScheduledEnd(e.target.value)} required style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }} />
          </label>
        </div>
        <label style={{ fontSize: 13 }}>
          Horas extra autorizadas (minutos)
          <input type="number" min={0} value={authorizedOvertimeMinutes} onChange={(e) => setAuthorizedOvertimeMinutes(Number(e.target.value) || 0)} style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }} />
        </label>
        {scheduleError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {scheduleError}
          </p>
        )}
        {scheduleMessage && (
          <p style={{ color: "#065f46", margin: 0, fontSize: 13 }}>{scheduleMessage}</p>
        )}
        <button type="submit" disabled={savingSchedule} style={{ padding: 10, fontWeight: 600, borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", cursor: "pointer" }}>
          {savingSchedule ? "Guardando…" : "Guardar horario"}
        </button>
      </form>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>Cruce contra lo trabajado</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ fontSize: 13 }}>
            Desde
            <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} style={{ display: "block", padding: 8, marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 13 }}>
            Hasta
            <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} style={{ display: "block", padding: 8, marginTop: 4 }} />
          </label>
          <button onClick={() => void handleConsultarCruce()} disabled={consultandoCruce} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#fff", color: "#111827", fontSize: 13, cursor: "pointer" }}>
            {consultandoCruce ? "Calculando…" : "Calcular cruce"}
          </button>
          <button onClick={() => void handleExportarStps()} disabled={exportando} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#fff", color: "#111827", fontSize: 13, cursor: "pointer" }}>
            {exportando ? "Exportando…" : "Exportar CSV (STPS)"}
          </button>
        </div>

        {cruceError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {cruceError}
          </p>
        )}

        {cruce && cruce.length === 0 && <p style={{ color: "#6b7280", fontSize: 13 }}>Sin días en este rango.</p>}
        {cruce && cruce.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
                  <th style={{ padding: "6px 8px" }}>Fecha</th>
                  <th style={{ padding: "6px 8px" }}>Estado</th>
                  <th style={{ padding: "6px 8px" }}>Programadas</th>
                  <th style={{ padding: "6px 8px" }}>Trabajadas</th>
                  <th style={{ padding: "6px 8px" }}>Extra autorizada</th>
                  <th style={{ padding: "6px 8px" }}>Extra NO autorizada</th>
                </tr>
              </thead>
              <tbody>
                {cruce.map((row) => (
                  <tr key={row.fecha} style={{ borderBottom: "1px solid #f3f4f6", background: row.alerta ? "#fef2f2" : undefined }}>
                    <td style={{ padding: "6px 8px" }}>{row.fecha}</td>
                    <td style={{ padding: "6px 8px" }}>{row.estado}</td>
                    <td style={{ padding: "6px 8px" }}>{row.horasProgramadas ?? "—"}</td>
                    <td style={{ padding: "6px 8px" }}>{row.horasTrabajadas}</td>
                    <td style={{ padding: "6px 8px" }}>{row.horasExtraAutorizadas}</td>
                    <td style={{ padding: "6px 8px", fontWeight: row.horasExtraNoAutorizadas > 0 ? 700 : 400, color: row.horasExtraNoAutorizadas > 0 ? "#b91c1c" : undefined }}>
                      {row.horasExtraNoAutorizadas}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
