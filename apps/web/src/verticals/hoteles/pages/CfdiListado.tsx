// CFDI de hospedaje — listado a nivel property (Fase 5, H5/REQ-BO-001/002),
// landing de la entrada "CFDI" del nav lateral (`GET /hoteles/:propertyId/cfdi`, la
// 1ra de las 4 rutas reales de apps/api/.../hoteles/cfdi.ts). Timbrar un CFDI de
// hospedaje o su complemento de pago es una acción POR FOLIO (exige el desglose de
// cargos/pagos de ESE folio) — este listado solo lee y cancela; el botón "Ir al
// folio" navega a pages/Cfdi.tsx (CfdiPage), que sí cubre timbrar/pagar, igual que ya
// se llega ahí desde el enlace nuevo de Folio.tsx.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { EstadoCargando, EstadoError, EstadoVacio } from "@atiende/ui";
import { cancelarCfdi, fetchCfdisByProperty, MOTIVO_CANCELACION_LABELS } from "../lib/cfdi-client.ts";
import type { CfdiEmisionSummary, MotivoCancelacionSat } from "../lib/cfdi-client.ts";
import { newIdempotencyKey } from "../lib/admin-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

function formatMoney(n: number): string {
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const ESTADO_LABELS: Record<CfdiEmisionSummary["estado"], string> = {
  pendiente: "Pendiente",
  timbrado: "Timbrado",
  en_proceso_cancelacion: "Cancelación en proceso",
  cancelado: "Cancelado",
  rechazado: "Rechazado",
};

const MOTIVOS: readonly MotivoCancelacionSat[] = ["01", "02", "03", "04"];

export function CfdiListadoPage({ apiBaseUrl, token, propertyId, orgSlug }: HotelesShellContext) {
  const navigate = useNavigate();
  const [cfdis, setCfdis] = useState<readonly CfdiEmisionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [folioJump, setFolioJump] = useState("");

  const [cancelTargetId, setCancelTargetId] = useState<string | null>(null);
  const [cancelMotivo, setCancelMotivo] = useState<MotivoCancelacionSat>("02");
  const [cancelFolioSustitucion, setCancelFolioSustitucion] = useState("");

  async function load() {
    setError(null);
    try {
      setCfdis(await fetchCfdisByProperty(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los CFDI de este hotel.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleCancelar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cancelTargetId) return;
    setBusy(true);
    setError(null);
    try {
      await cancelarCfdi(fetch, apiBaseUrl, token, propertyId, cancelTargetId, cancelMotivo, cancelMotivo === "01" ? cancelFolioSustitucion.trim() || undefined : undefined, newIdempotencyKey());
      setCancelTargetId(null);
      setCancelFolioSustitucion("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cancelar el CFDI.");
    } finally {
      setBusy(false);
    }
  }

  function handleFolioJump(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const folioId = folioJump.trim();
    if (!folioId) return;
    navigate(`/hoteles/${orgSlug}/folios/${folioId}/cfdi`);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 760 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: 0 }}>CFDI de hospedaje</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>Todos los comprobantes fiscales timbrados en este hotel, de cualquier folio.</p>
      </header>

      <form onSubmit={handleFolioJump} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
        <span style={{ fontSize: 13 }}>Timbrar/gestionar el CFDI de un folio:</span>
        <input placeholder="ID del folio" value={folioJump} onChange={(e) => setFolioJump(e.target.value)} style={{ flex: 1, padding: 8, minWidth: 200 }} />
        <button type="submit" style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer" }}>
          Ir al folio
        </button>
      </form>

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {!cfdis && !error && <EstadoCargando etiqueta="Cargando CFDI…" />}
      {cfdis && cfdis.length === 0 && <EstadoVacio mensaje="Este hotel todavía no tiene ningún CFDI timbrado." />}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {cfdis?.map((c) => (
          <div key={c.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div>
                <p style={{ margin: 0, fontWeight: 600, fontSize: 13 }}>
                  {c.tipo === "hospedaje" ? "Hospedaje" : "Complemento de pago"} · {c.uuidFiscal ?? "sin UUID"}
                </p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>
                  RFC {c.rfcReceptor} · Uso {c.usoCfdi} · {c.metodoPago} {c.pac ? `· PAC: ${c.pac}` : ""}
                </p>
                <p style={{ margin: "2px 0 0", fontSize: 11, color: "#9ca3af" }}>
                  Folio: <Link to={`/hoteles/${orgSlug}/folios/${c.folioId}/cfdi`}>{c.folioId}</Link>
                </p>
              </div>
              <span
                style={{
                  alignSelf: "flex-start",
                  fontSize: 12,
                  padding: "3px 10px",
                  borderRadius: 999,
                  background: c.estado === "cancelado" ? "#fee2e2" : c.estado === "timbrado" ? "#dcfce7" : "#f3f4f6",
                  color: c.estado === "cancelado" ? "#991b1b" : c.estado === "timbrado" ? "#166534" : "#374151",
                }}
              >
                {ESTADO_LABELS[c.estado]}
              </span>
            </div>
            <p style={{ margin: "8px 0 0", fontSize: 13 }}>
              Subtotal {formatMoney(c.subtotal)} · IVA {formatMoney(c.iva)}
              {c.impuestosLocales.ishMonto > 0 ? ` · ISH ${formatMoney(c.impuestosLocales.ishMonto)}` : ""}
              {c.impuestosLocales.dsaMonto > 0 ? ` · DSA ${formatMoney(c.impuestosLocales.dsaMonto)}` : ""} · Total <strong>{formatMoney(c.total)}</strong>
            </p>
            <p style={{ margin: "4px 0 0", fontSize: 11, color: "#9ca3af" }}>Emitido: {new Date(c.creadoEn).toLocaleString("es-MX")}</p>
            {c.estado === "timbrado" && cancelTargetId !== c.id && (
              <button onClick={() => setCancelTargetId(c.id)} disabled={busy} style={{ marginTop: 10, padding: "5px 12px", borderRadius: 8, border: "1px solid #b91c1c", background: "#fff", color: "#b91c1c", fontSize: 12, cursor: "pointer" }}>
                Cancelar CFDI
              </button>
            )}
            {cancelTargetId === c.id && (
              <form onSubmit={handleCancelar} style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8, border: "1px solid #fecaca", borderRadius: 8, padding: 10 }}>
                <select value={cancelMotivo} onChange={(e) => setCancelMotivo(e.target.value as MotivoCancelacionSat)} style={{ padding: 6 }}>
                  {MOTIVOS.map((m) => (
                    <option key={m} value={m}>
                      {MOTIVO_CANCELACION_LABELS[m]}
                    </option>
                  ))}
                </select>
                {cancelMotivo === "01" && (
                  <input placeholder="Folio fiscal del CFDI que lo sustituye (UUID)" value={cancelFolioSustitucion} onChange={(e) => setCancelFolioSustitucion(e.target.value)} style={{ padding: 6 }} />
                )}
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="submit" disabled={busy} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #b91c1c", background: "#b91c1c", color: "#fff", fontSize: 12, cursor: "pointer" }}>
                    Confirmar cancelación
                  </button>
                  <button type="button" onClick={() => setCancelTargetId(null)} disabled={busy} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#111827", fontSize: 12, cursor: "pointer" }}>
                    Cerrar
                  </button>
                </div>
              </form>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
