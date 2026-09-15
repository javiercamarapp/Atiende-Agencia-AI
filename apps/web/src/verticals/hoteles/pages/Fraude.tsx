// Fraude — cola de fraude interno (Fase 7, H16-014/REQ-REC-014): ejecutar un
// escaneo determinista real y resolver (confirmar/descartar) las alertas generadas.
// El escaneo nunca usa un LLM (ver fraude.ts) — solo los 2 patrones deterministas
// portados a @atiende/domain-hoteles.
import { useEffect, useState } from "react";
import { fetchFraudAlerts, resolveFraudAlert, runFraudScan, FRAUD_ALERT_STATUS_LABELS } from "../lib/fraude-client.ts";
import type { FraudAlertStatus, FraudAlertSummary } from "../lib/fraude-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const FILTERS: ReadonlyArray<FraudAlertStatus | "todas"> = ["todas", "pendiente", "confirmado", "descartado"];

export function FraudePage({ apiBaseUrl, token, propertyId }: HotelesShellContext) {
  const [filter, setFilter] = useState<FraudAlertStatus | "todas">("pendiente");
  const [alerts, setAlerts] = useState<readonly FraudAlertSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setAlerts(await fetchFraudAlerts(fetch, apiBaseUrl, token, propertyId, filter === "todas" ? undefined : filter));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las alertas de fraude.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, filter]);

  async function handleScan() {
    setScanning(true);
    setScanMessage(null);
    setError(null);
    try {
      const result = await runFraudScan(fetch, apiBaseUrl, token, propertyId);
      setScanMessage(`Escaneo completo: ${result.generadas} alerta(s) nueva(s), ${result.yaExistentes} ya existían.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo ejecutar el escaneo.");
    } finally {
      setScanning(false);
    }
  }

  async function handleResolve(alert: FraudAlertSummary, decision: "confirmar" | "descartar") {
    // Hallazgo de auditoría (severidad ALTA, "el botón 'Cancelar' del prompt de
    // confirmación de fraude no aborta la acción"): `window.prompt` devuelve `null`
    // SOLO cuando el usuario da clic en su botón "Cancelar" (una cadena vacía, en
    // cambio, significa que dio clic en "Aceptar" sin escribir nada) — el código
    // anterior colapsaba ambos casos con `?? undefined` y seguía llamando a
    // `resolveFraudAlert` de todas formas, así que "Cancelar" en el diálogo nativo
    // nunca abortaba confirmar/descartar la alerta, solo dejaba la nota vacía. Ahora
    // `nota === null` corta la función ANTES de tocar `setBusyId`/la llamada de red:
    // ninguna reserva/alerta se resuelve si el staff canceló el diálogo.
    const nota = window.prompt(`Nota de decisión (${decision}):`);
    if (nota === null) return;
    setBusyId(alert.id);
    setError(null);
    try {
      await resolveFraudAlert(fetch, apiBaseUrl, token, propertyId, alert.id, decision, nota || undefined);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo resolver la alerta.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Fraude interno</h1>
        <button onClick={() => void handleScan()} disabled={scanning} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer" }}>
          {scanning ? "Escaneando…" : "Ejecutar escaneo"}
        </button>
      </header>

      {scanMessage && <p style={{ margin: 0, fontSize: 13, color: "#065f46" }}>{scanMessage}</p>}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{ padding: "6px 12px", borderRadius: 999, border: "1px solid #d1d5db", background: filter === f ? "#111827" : "#fff", color: filter === f ? "#fff" : "#111827", fontSize: 12, cursor: "pointer" }}
          >
            {f === "todas" ? "Todas" : FRAUD_ALERT_STATUS_LABELS[f]}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}
      {!alerts && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}
      {alerts && alerts.length === 0 && <p style={{ color: "#6b7280" }}>No hay alertas en este filtro.</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {alerts?.map((a) => (
          <div key={a.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div>
                <p style={{ margin: 0, fontWeight: 600 }}>{a.patron}</p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>{a.razon}</p>
              </div>
              <span style={{ alignSelf: "flex-start", fontSize: 12, padding: "3px 10px", borderRadius: 999, background: a.estado === "pendiente" ? "#fef3c7" : "#f3f4f6", color: a.estado === "pendiente" ? "#92400e" : "#374151" }}>
                {FRAUD_ALERT_STATUS_LABELS[a.estado]}
              </span>
            </div>
            <p style={{ margin: "8px 0 0", fontSize: 11, color: "#9ca3af" }}>
              Folio: {a.folioId} {a.cargoId ? `· Cargo: ${a.cargoId}` : ""} · Roles destinatario: {a.rolesDestinatario.join(", ")}
            </p>
            {a.notaDecision && <p style={{ margin: "6px 0 0", fontSize: 12, color: "#6b7280" }}>Nota: {a.notaDecision}</p>}
            {a.estado === "pendiente" && (
              <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                <button onClick={() => void handleResolve(a, "confirmar")} disabled={busyId === a.id} style={{ padding: "5px 12px", borderRadius: 8, border: "1px solid #b91c1c", background: "#fff", color: "#b91c1c", fontSize: 12, cursor: "pointer" }}>
                  Confirmar
                </button>
                <button onClick={() => void handleResolve(a, "descartar")} disabled={busyId === a.id} style={{ padding: "5px 12px", borderRadius: 8, border: "1px solid #111827", background: "#fff", color: "#111827", fontSize: 12, cursor: "pointer" }}>
                  Descartar
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
