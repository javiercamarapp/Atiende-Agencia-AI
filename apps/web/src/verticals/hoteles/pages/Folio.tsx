// Folio — caja/facturación de recepción (Fase 7): cargos/descuentos/reversos/pagos/
// cierre de un folio real contra @atiende/domain-hoteles (folioEngine.ts, ver
// folios-client.ts). El motor de montos SIEMPRE corre en el servidor — este panel
// nunca calcula impuesto/saldo por su cuenta, solo refleja lo que el servidor
// devuelve.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { addCharge, addDiscount, addPayment, closeFolio, fetchFolio, reverseCharge, CHARGE_CONCEPT_LABELS } from "../lib/folios-client.ts";
import type { AddChargeInput, FolioSummary } from "../lib/folios-client.ts";
import { newIdempotencyKey } from "../lib/admin-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

export interface FolioPageProps extends HotelesShellContext {
  readonly folioId: string;
}

function formatMoney(n: number): string {
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const CHARGE_CONCEPTS: readonly AddChargeInput["concepto"][] = ["hospedaje", "ab", "extras", "ajuste", "propina", "otro"];

export function FolioPage({ apiBaseUrl, token, propertyId, orgSlug, folioId }: FolioPageProps) {
  const [folio, setFolio] = useState<FolioSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [chargeDesc, setChargeDesc] = useState("");
  const [chargeAmount, setChargeAmount] = useState("");
  const [chargeConcept, setChargeConcept] = useState<AddChargeInput["concepto"]>("extras");

  const [discountDesc, setDiscountDesc] = useState("");
  const [discountAmount, setDiscountAmount] = useState("");

  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"efectivo" | "transferencia">("efectivo");

  async function load() {
    setError(null);
    try {
      setFolio(await fetchFolio(fetch, apiBaseUrl, token, propertyId, folioId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el folio.");
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

  async function handleAddCharge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const monto = Number(chargeAmount);
    if (!chargeDesc.trim() || !Number.isFinite(monto) || monto <= 0) return setError("Descripción y monto (> 0) son requeridos.");
    await withBusy(async () => {
      await addCharge(fetch, apiBaseUrl, token, propertyId, folioId, { descripcion: chargeDesc.trim(), monto, concepto: chargeConcept }, newIdempotencyKey());
      setChargeDesc("");
      setChargeAmount("");
    });
  }

  async function handleAddDiscount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const monto = Number(discountAmount);
    if (!discountDesc.trim() || !Number.isFinite(monto) || monto <= 0) return setError("Descripción y monto (> 0) son requeridos.");
    await withBusy(async () => {
      await addDiscount(fetch, apiBaseUrl, token, propertyId, folioId, discountDesc.trim(), monto, newIdempotencyKey());
      setDiscountDesc("");
      setDiscountAmount("");
    });
  }

  async function handleAddPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const monto = Number(paymentAmount);
    if (!Number.isFinite(monto) || monto <= 0) return setError("El monto del pago debe ser > 0.");
    await withBusy(async () => {
      await addPayment(fetch, apiBaseUrl, token, propertyId, folioId, { monto, metodo: paymentMethod }, newIdempotencyKey());
      setPaymentAmount("");
    });
  }

  async function handleReverse(chargeId: string) {
    const motivo = window.prompt("Motivo del reverso:");
    if (!motivo) return;
    await withBusy(() => reverseCharge(fetch, apiBaseUrl, token, propertyId, folioId, chargeId, motivo, newIdempotencyKey()).then(() => undefined));
  }

  async function handleClose(motivo: "saldo_cero" | "cuenta_por_cobrar") {
    await withBusy(() => closeFolio(fetch, apiBaseUrl, token, propertyId, folioId, motivo).then(() => undefined));
  }

  if (!folio && !error) return <p style={{ color: "#6b7280" }}>Cargando…</p>;
  if (!folio) {
    return (
      <p role="alert" style={{ color: "#b91c1c" }}>
        {error}
      </p>
    );
  }

  const isOpen = folio.estado === "abierto";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
      <header>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Folio: {folio.etiqueta}</h1>
          <Link to={`/hoteles/${orgSlug}/folios/${folioId}/cfdi`} style={{ fontSize: 13, padding: "6px 12px", borderRadius: 8, border: "1px solid #111827", color: "#111827", textDecoration: "none" }}>
            CFDI de este folio
          </Link>
        </div>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          {folio.esPrincipal ? "Folio principal" : "Folio secundario"} · Estado: {folio.estado}
          {folio.motivoCierre ? ` (${folio.motivoCierre})` : ""}
        </p>
        <p style={{ fontSize: 24, fontWeight: 700, margin: "10px 0 0" }}>Saldo: {formatMoney(folio.saldo)}</p>
      </header>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}

      <section>
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>Cargos</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {folio.cargos.length === 0 && <p style={{ color: "#6b7280", fontSize: 13 }}>Sin cargos.</p>}
          {folio.cargos.map((ch) => (
            <div key={ch.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #f3f4f6", borderRadius: 8, padding: "8px 12px", opacity: ch.revertidoPor ? 0.5 : 1 }}>
              <div>
                <p style={{ margin: 0, fontSize: 13 }}>
                  {CHARGE_CONCEPT_LABELS[ch.concepto]} · {ch.descripcion}
                </p>
                <p style={{ margin: "2px 0 0", fontSize: 11, color: "#9ca3af" }}>{new Date(ch.creadoEn).toLocaleString("es-MX")}</p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{formatMoney(ch.monto + ch.impuesto)}</span>
                {isOpen && !ch.revertidoPor && ch.concepto !== "reverso" && (
                  <button onClick={() => void handleReverse(ch.id)} disabled={busy} style={{ padding: "3px 8px", borderRadius: 6, border: "1px solid #b91c1c", background: "#fff", color: "#b91c1c", fontSize: 11, cursor: "pointer" }}>
                    Reversar
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {isOpen && (
        <form onSubmit={handleAddCharge} style={{ display: "flex", flexDirection: "column", gap: 8, border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Agregar cargo</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input placeholder="Descripción" value={chargeDesc} onChange={(e) => setChargeDesc(e.target.value)} style={{ flex: 2, padding: 8, minWidth: 160 }} />
            <input placeholder="Monto" type="number" min="0.01" step="0.01" value={chargeAmount} onChange={(e) => setChargeAmount(e.target.value)} style={{ flex: 1, padding: 8, minWidth: 100 }} />
            <select value={chargeConcept} onChange={(e) => setChargeConcept(e.target.value as AddChargeInput["concepto"])} style={{ padding: 8 }}>
              {CHARGE_CONCEPTS.map((c) => (
                <option key={c} value={c}>
                  {CHARGE_CONCEPT_LABELS[c]}
                </option>
              ))}
            </select>
            <button type="submit" disabled={busy} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer" }}>
              Agregar
            </button>
          </div>
        </form>
      )}

      {isOpen && (
        <form onSubmit={handleAddDiscount} style={{ display: "flex", flexDirection: "column", gap: 8, border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Aplicar descuento</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input placeholder="Motivo" value={discountDesc} onChange={(e) => setDiscountDesc(e.target.value)} style={{ flex: 2, padding: 8, minWidth: 160 }} />
            <input placeholder="Monto" type="number" min="0.01" step="0.01" value={discountAmount} onChange={(e) => setDiscountAmount(e.target.value)} style={{ flex: 1, padding: 8, minWidth: 100 }} />
            <button type="submit" disabled={busy} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#fff", color: "#111827", fontSize: 13, cursor: "pointer" }}>
              Aplicar
            </button>
          </div>
          <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>Un descuento por arriba del umbral de la property requiere autorización de un rol admin (owner/gm) — el servidor lo exige, este formulario no lo evita.</p>
        </form>
      )}

      <section>
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>Pagos</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {folio.pagos.length === 0 && <p style={{ color: "#6b7280", fontSize: 13 }}>Sin pagos.</p>}
          {folio.pagos.map((p) => (
            <div key={p.id} style={{ display: "flex", justifyContent: "space-between", border: "1px solid #f3f4f6", borderRadius: 8, padding: "8px 12px" }}>
              <span style={{ fontSize: 13 }}>
                {p.metodo} · {p.estado}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{formatMoney(p.monto)}</span>
            </div>
          ))}
        </div>
      </section>

      {isOpen && (
        <form onSubmit={handleAddPayment} style={{ display: "flex", flexDirection: "column", gap: 8, border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Registrar pago</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input placeholder="Monto" type="number" min="0.01" step="0.01" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} style={{ flex: 1, padding: 8, minWidth: 100 }} />
            <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as "efectivo" | "transferencia")} style={{ padding: 8 }}>
              <option value="efectivo">Efectivo</option>
              <option value="transferencia">Transferencia</option>
            </select>
            <button type="submit" disabled={busy} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer" }}>
              Registrar
            </button>
          </div>
          <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>Pago con tarjeta no disponible en este panel: exige un token real de pasarela, nunca un número de tarjeta capturado a mano.</p>
        </form>
      )}

      {isOpen && (
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => void handleClose("saldo_cero")} disabled={busy} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#fff", color: "#111827", fontSize: 13, cursor: "pointer" }}>
            Cerrar folio (saldo en cero)
          </button>
          <button onClick={() => void handleClose("cuenta_por_cobrar")} disabled={busy} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #b45309", background: "#fff", color: "#b45309", fontSize: 13, cursor: "pointer" }}>
            Cerrar como cuenta por cobrar
          </button>
        </div>
      )}
    </div>
  );
}
