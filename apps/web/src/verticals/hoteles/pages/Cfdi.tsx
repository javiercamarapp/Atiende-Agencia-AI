// CFDI de hospedaje — Fase 5 (H5/REQ-BO-001/002), UI real para
// apps/api/src/routes/verticals/hoteles/cfdi.ts (hasta esta pieza el backend de CFDI
// no tenía cliente ni página: timbrar la estancia de un huésped era imposible desde
// el panel). Autorización fina real: solo owner/gm/accountant pueden timbrar/pagar/
// cancelar (CFDI_HOSPEDAJE_ROLES, packages/domain-hoteles/src/roles.ts) — este
// componente NO replica esa lista (apps/web nunca depende de un paquete domain-*,
// mismo criterio que folios-client.ts): un staff sin ese rol ve el 403 real del
// servidor reflejado en `error`, igual que ya hace FraudePage con FRAUD_SCAN_ROLES.
//
// El motor de reglas fiscales (breakdown ISH/DSA, validación previa al timbrado)
// corre SIEMPRE en el servidor — este panel nunca calcula ni valida montos, solo
// refleja lo que la ruta ya serializa.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { cancelarCfdi, emitirCfdiHospedaje, emitirCfdiPago, fetchCfdisByFolio, MOTIVO_CANCELACION_LABELS } from "../lib/cfdi-client.ts";
import type { CfdiEmisionSummary, MotivoCancelacionSat } from "../lib/cfdi-client.ts";
import { fetchFolio } from "../lib/folios-client.ts";
import type { FolioSummary } from "../lib/folios-client.ts";
import { newIdempotencyKey } from "../lib/admin-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

export interface CfdiPageProps extends HotelesShellContext {
  readonly folioId: string;
}

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

export function CfdiPage({ apiBaseUrl, token, propertyId, folioId }: CfdiPageProps) {
  const [folio, setFolio] = useState<FolioSummary | null>(null);
  const [cfdis, setCfdis] = useState<readonly CfdiEmisionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [rfcReceptor, setRfcReceptor] = useState("");
  const [usoCfdi, setUsoCfdi] = useState("G03");
  const [metodoPago, setMetodoPago] = useState<"PUE" | "PPD">("PUE");
  const [esExtranjero, setEsExtranjero] = useState(false);
  const [esGlobal, setEsGlobal] = useState(false);
  const [esNoShow, setEsNoShow] = useState(false);

  const [cancelTargetId, setCancelTargetId] = useState<string | null>(null);
  const [cancelMotivo, setCancelMotivo] = useState<MotivoCancelacionSat>("02");
  const [cancelFolioSustitucion, setCancelFolioSustitucion] = useState("");

  async function load() {
    setError(null);
    try {
      const [folioResult, cfdisResult] = await Promise.all([fetchFolio(fetch, apiBaseUrl, token, propertyId, folioId), fetchCfdisByFolio(fetch, apiBaseUrl, token, propertyId, folioId)]);
      setFolio(folioResult);
      setCfdis(cfdisResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el CFDI de este folio.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, folioId]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la operación.");
    } finally {
      setBusy(false);
    }
  }

  async function handleEmitirHospedaje(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (esExtranjero && esGlobal) return setError("Un CFDI no puede ser extranjero y global a la vez.");
    if (!esExtranjero && !esGlobal && (!rfcReceptor.trim() || !usoCfdi.trim())) {
      return setError("RFC receptor y uso de CFDI son obligatorios salvo huésped extranjero/factura global.");
    }
    await withBusy(async () => {
      await emitirCfdiHospedaje(
        fetch,
        apiBaseUrl,
        token,
        propertyId,
        folioId,
        {
          rfcReceptor: esExtranjero || esGlobal ? undefined : rfcReceptor.trim(),
          usoCfdi: esExtranjero || esGlobal ? undefined : usoCfdi.trim(),
          metodoPago,
          esExtranjero,
          esGlobal,
          esNoShow,
        },
        newIdempotencyKey(),
      );
    });
  }

  async function handleEmitirPago(hospedajeCfdiId: string, paymentId: string) {
    await withBusy(() => emitirCfdiPago(fetch, apiBaseUrl, token, propertyId, folioId, paymentId, hospedajeCfdiId, newIdempotencyKey()).then(() => undefined));
  }

  async function handleCancelar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cancelTargetId) return;
    await withBusy(async () => {
      await cancelarCfdi(fetch, apiBaseUrl, token, propertyId, cancelTargetId, cancelMotivo, cancelMotivo === "01" ? cancelFolioSustitucion.trim() || undefined : undefined, newIdempotencyKey());
      setCancelTargetId(null);
      setCancelFolioSustitucion("");
    });
  }

  if (!folio || !cfdis) {
    if (error) {
      return (
        <p role="alert" style={{ color: "#b91c1c" }}>
          {error}
        </p>
      );
    }
    return <p style={{ color: "#6b7280" }}>Cargando…</p>;
  }

  // Fix hallazgo auditoría — un CFDI de hospedaje "cancelado" SÍ debe poder
  // reemitirse con un folio fiscal nuevo (misma regla que ya aplica el backend,
  // ver cfdi.ts): solo un hospedaje VIGENTE (no cancelado) cuenta como "ya
  // emitido" para ocultar el formulario o habilitar el complemento de pago. Un
  // folio puede acumular más de un CFDI 'hospedaje' en su historial (los
  // cancelados), pero a lo más uno vigente a la vez (REQ-BO-002).
  const cfdiHospedaje = cfdis.find((c) => c.tipo === "hospedaje" && c.estado !== "cancelado") ?? null;
  const cfdisPago = cfdis.filter((c) => c.tipo === "pago");
  const puedeTimbrarHospedaje = !cfdiHospedaje;
  // `serializeCfdi` (apps/api/.../cfdi.ts) no expone `paymentId` en la respuesta —
  // este panel no puede saber, solo con GET .../cfdi, a qué pago capturado
  // corresponde CADA complemento ya timbrado. En vez de fingir esa distinción con un
  // filtro que adivinaría mal, se listan TODOS los pagos capturados: la ruta
  // POST .../cfdi/pago YA es idempotente por `paymentId` real
  // (`findCfdiEmisionByPayment`), así que reintentar sobre un pago que ya tiene
  // complemento simplemente devuelve el mismo comprobante (200) sin re-timbrar.
  const pagosCapturados = folio.pagos.filter((p) => p.estado === "capturado");
  const puedeTimbrarPago = cfdiHospedaje?.estado === "timbrado" && cfdiHospedaje.metodoPago === "PPD";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: 0 }}>CFDI de hospedaje</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          Folio: {folio.etiqueta} · Saldo: {formatMoney(folio.saldo)}
        </p>
      </header>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}

      <section>
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>Comprobantes emitidos</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {cfdis.length === 0 && <p style={{ color: "#6b7280", fontSize: 13 }}>Este folio todavía no tiene ningún CFDI timbrado.</p>}
          {cfdis.map((c) => (
            <div key={c.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: 13 }}>
                    {c.tipo === "hospedaje" ? "Hospedaje" : "Complemento de pago"} · {c.uuidFiscal ?? "sin UUID"}
                  </p>
                  <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>
                    RFC {c.rfcReceptor} · Uso {c.usoCfdi} · {c.metodoPago} {c.pac ? `· PAC: ${c.pac}` : ""}
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
      </section>

      {puedeTimbrarHospedaje && (
        <form onSubmit={handleEmitirHospedaje} style={{ display: "flex", flexDirection: "column", gap: 10, border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Timbrar CFDI de hospedaje</p>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={esExtranjero} onChange={(e) => setEsExtranjero(e.target.checked)} disabled={esGlobal} /> Huésped extranjero (RFC genérico XEXX010101000)
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={esGlobal} onChange={(e) => setEsGlobal(e.target.checked)} disabled={esExtranjero} /> Factura global a público en general (RFC XAXX010101000)
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={esNoShow} onChange={(e) => setEsNoShow(e.target.checked)} /> No-show (penalización sin estancia)
          </label>
          {!esExtranjero && !esGlobal && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input placeholder="RFC receptor" value={rfcReceptor} onChange={(e) => setRfcReceptor(e.target.value.toUpperCase())} style={{ flex: 1, padding: 8, minWidth: 160 }} />
              <input placeholder="Uso de CFDI (p. ej. G03)" value={usoCfdi} onChange={(e) => setUsoCfdi(e.target.value.toUpperCase())} style={{ flex: 1, padding: 8, minWidth: 140 }} />
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13 }}>Método de pago:</span>
            <select value={metodoPago} onChange={(e) => setMetodoPago(e.target.value as "PUE" | "PPD")} style={{ padding: 8 }}>
              <option value="PUE">PUE · pago en una sola exhibición</option>
              <option value="PPD">PPD · pago en parcialidades o diferido</option>
            </select>
          </div>
          <button type="submit" disabled={busy} style={{ alignSelf: "flex-start", padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer" }}>
            {busy ? "Timbrando…" : "Timbrar CFDI"}
          </button>
          <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>
            El servidor calcula el desglose real (subtotal, IVA, ISH, DSA) a partir de los cargos facturables del folio y valida el comprobante antes de timbrarlo — este formulario no calcula ni adivina montos.
          </p>
        </form>
      )}

      {puedeTimbrarPago && (
        <section>
          <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>Complementos de pago (CFDI de tipo 'pago')</h2>
          {pagosCapturados.length === 0 && <p style={{ color: "#6b7280", fontSize: 13 }}>Este folio todavía no tiene ningún pago capturado.</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {pagosCapturados.map((p) => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #f3f4f6", borderRadius: 8, padding: "8px 12px" }}>
                <span style={{ fontSize: 13 }}>
                  {p.metodo} · {formatMoney(p.monto)} {p.referenciaExterna ? `· Ref: ${p.referenciaExterna}` : ""}
                </span>
                <button onClick={() => void handleEmitirPago(cfdiHospedaje!.id, p.id)} disabled={busy} style={{ padding: "5px 12px", borderRadius: 8, border: "1px solid #111827", background: "#fff", color: "#111827", fontSize: 12, cursor: "pointer" }}>
                  Timbrar complemento de pago
                </button>
              </div>
            ))}
          </div>
          <p style={{ margin: "8px 0 0", fontSize: 11, color: "#9ca3af" }}>
            Timbrar el complemento de un pago que ya tiene uno es seguro: el servidor es idempotente por pago y devuelve el mismo comprobante ya emitido, {cfdisPago.length} emitido(s) hasta ahora en este folio.
          </p>
        </section>
      )}
    </div>
  );
}
