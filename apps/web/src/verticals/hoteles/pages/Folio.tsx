// Folio — caja/facturación de recepción (Fase 7): cargos/descuentos/reversos/pagos/
// cierre de un folio real contra @atiende/domain-hoteles (folioEngine.ts, ver
// folios-client.ts). El motor de montos SIEMPRE corre en el servidor — este panel
// nunca calcula impuesto/saldo por su cuenta, solo refleja lo que el servidor
// devuelve.
//
// Visual (ronda de integración del design system real, @atiende/ui): reemplaza
// tarjetas/pills/inputs de estilos inline por Card/Badge/Input/Button reales — mismo
// criterio ya aplicado en HotelesShell.tsx/Login.tsx. El modal de confirmación de
// cierre (antes `<ConfirmModal>` de estilos inline, ver components/ConfirmModal.tsx,
// ahora eliminado por no usarse en ningún lado) usa `AlertDialog` real del design
// system (no `Dialog`/`ModalFormularioLateral` -- mismo criterio que la referencia
// real, atiende-restaurantes/PedidosSection.tsx: una confirmación sí/no no es un
// formulario) — mismo contrato (open/onConfirm/onCancel/busy), sin cambiar cuándo
// se abre ni qué confirma.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { Receipt } from "lucide-react";
import {
  Button,
  Callout,
  Checkbox,
  ConfirmDialog,
  EstadoCargando,
  EstadoError,
  FormField,
  Input,
  NativeSelect,
  PageContainer,
  PageHeader,
  notify,
  useConfirm,
} from "@atiende/ui";
import { fechaHoraEsMx } from "../../../lib/formato-fecha.ts";
import { addCharge, addDiscount, addPayment, cargoTransferible, closeFolio, fetchFolio, fetchFoliosByReservation, reverseCharge, splitFolio, transferCharge, CHARGE_CONCEPT_LABELS } from "../lib/folios-client.ts";
import type { AddChargeInput, FolioSummary } from "../lib/folios-client.ts";
import { newIdempotencyKey } from "../lib/admin-client.ts";
import { dineroMx } from "../lib/dinero.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

export interface FolioPageProps extends HotelesShellContext {
  readonly folioId: string;
}

const CHARGE_CONCEPTS: readonly AddChargeInput["concepto"][] = ["hospedaje", "ab", "extras", "ajuste", "propina", "otro"];
export function FolioPage({ apiBaseUrl, token, propertyId, orgSlug, folioId }: FolioPageProps) {
  const { pedirTexto, dialogo } = useConfirm();
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

  // Hallazgo de auditoría (severidad ALTA, "acciones destructivas sin
  // confirmación: ... cerrar folio ejecuta de inmediato con un clic"): cerrar un
  // folio es IRREVERSIBLE desde este panel (no hay ningún botón de "reabrir") --
  // `null` = modal cerrado; en otro caso guarda el motivo de cierre pendiente de
  // confirmar. Ver el <Dialog> de confirmación al final de este archivo.
  const [pendingClose, setPendingClose] = useState<"saldo_cero" | "cuenta_por_cobrar" | null>(null);

  // H-35: otros folios abiertos de la MISMA reserva (destino de una transferencia), transferencia en curso y split.
  const [otrosFolios, setOtrosFolios] = useState<readonly FolioSummary[]>([]);
  const [transfer, setTransfer] = useState<{ chargeId: string; destino: string; motivo: string } | null>(null);
  const [splitEtiqueta, setSplitEtiqueta] = useState("");
  const [splitCargos, setSplitCargos] = useState<ReadonlySet<string>>(new Set());
  const [aviso, setAviso] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const actual = await fetchFolio(fetch, apiBaseUrl, token, propertyId, folioId);
      setFolio(actual);
      // Si no se pueden listar los demas folios, solo se oculta la transferencia (no se rompe el folio).
      setOtrosFolios(
        (await fetchFoliosByReservation(fetch, apiBaseUrl, token, propertyId, actual.reservationId).catch(() => [] as readonly FolioSummary[])).filter((f) => f.id !== folioId && f.estado === "abierto"),
      );
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

  async function handleTransfer() {
    if (!transfer || !transfer.destino) return;
    const { chargeId, destino, motivo } = transfer;
    await withBusy(async () => {
      await transferCharge(fetch, apiBaseUrl, token, propertyId, folioId, chargeId, destino, motivo.trim() || undefined, newIdempotencyKey());
      setTransfer(null);
      setAviso("Cargo transferido al otro folio.");
    });
  }

  async function handleSplit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!splitEtiqueta.trim() || splitCargos.size === 0) return setError("Escribe un nombre para el folio nuevo y elige al menos un cargo.");
    await withBusy(async () => {
      const nuevo = await splitFolio(fetch, apiBaseUrl, token, propertyId, folioId, splitEtiqueta.trim(), [...splitCargos], newIdempotencyKey());
      setSplitEtiqueta("");
      setSplitCargos(new Set());
      setAviso(`Folio "${nuevo.etiqueta}" creado con los cargos elegidos.`);
    });
  }

  function toggleSplit(chargeId: string) {
    setSplitCargos((prev) => {
      const next = new Set(prev);
      if (next.has(chargeId)) next.delete(chargeId);
      else next.add(chargeId);
      return next;
    });
  }

  async function handleReverse(chargeId: string) {
    // Cancelar o Escape resuelven null: no se escribe nada. El reverso es un movimiento contable, siempre con motivo.
    const motivo = await pedirTexto({
      titulo: "Reversar cargo",
      descripcion: "El reverso queda registrado en el folio y no se puede deshacer desde este panel.",
      tono: "danger",
      confirmar: "Reversar cargo",
      campo: { etiqueta: "Motivo del reverso", multilinea: false, maxLength: 200 },
    });
    if (!motivo) return;
    await withBusy(async () => {
      await reverseCharge(fetch, apiBaseUrl, token, propertyId, folioId, chargeId, motivo, newIdempotencyKey());
      notify.success("Cargo reversado.");
    });
  }

  // Hallazgo de auditoría (severidad ALTA, "acciones destructivas sin
  // confirmación"): dar clic en "Cerrar folio"/"Cerrar como cuenta por cobrar" ya
  // NO cierra nada por sí solo -- solo abre el modal real (ver el <Dialog> de abajo,
  // "modal, no window.confirm"); `handleConfirmClose` es la única función que de
  // verdad llama a `closeFolio`.
  function handleClose(motivo: "saldo_cero" | "cuenta_por_cobrar") {
    setPendingClose(motivo);
  }

  async function handleConfirmClose() {
    const motivo = pendingClose;
    if (!motivo) return;
    try {
      await withBusy(() => closeFolio(fetch, apiBaseUrl, token, propertyId, folioId, motivo).then(() => undefined));
    } finally {
      // Cierra el modal SIEMPRE (éxito o error) -- un fallo del servidor debe ser
      // visible en el banner de error de la página, nunca quedar oculto detrás del
      // overlay del modal.
      setPendingClose(null);
    }
  }

  if (!folio && !error)
    return (
      <div className="max-w-md">
        <EstadoCargando etiqueta="Cargando folio…" />
      </div>
    );
  if (!folio) {
    return (
      <div className="max-w-md">
        <EstadoError mensaje={error ?? undefined} onReintentar={() => void load()} />
      </div>
    );
  }

  const isOpen = folio.estado === "abierto";

  return (
    <PageContainer padding="none" size="md" className="gap-4">
      <PageHeader
        titulo={`Folio: ${folio.etiqueta}`}
        descripcion={`${folio.esPrincipal ? "Folio principal" : "Folio secundario"} · Estado: ${folio.estado}${folio.motivoCierre ? ` (${folio.motivoCierre})` : ""}`}
        meta={<span className="text-base font-semibold text-foreground">Saldo: {dineroMx(folio.saldo)}</span>}
        acciones={
          <Button asChild variant="outline" size="sm">
            <Link to={`/hoteles/${orgSlug}/folios/${folioId}/cfdi`}>
              <Receipt className="w-4 h-4" strokeWidth={1.75} />
              CFDI de este folio
            </Link>
          </Button>
        }
      />

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} />}
      {aviso && (
        <Callout tone="success" onDismiss={() => setAviso(null)}>
          {aviso}
        </Callout>
      )}

      <section>
        <h2 className="text-sm font-semibold text-foreground mb-2">Cargos</h2>
        <div className="flex flex-col gap-1.5">
          {folio.cargos.length === 0 && <p className="text-sm text-muted-foreground">Sin cargos.</p>}
          {folio.cargos.map((ch) => (
            <div key={ch.id} className={`flex justify-between items-center border border-border rounded-lg px-3 py-2 ${ch.revertidoPor ? "opacity-50" : ""}`}>
              <div>
                <p className="text-sm text-foreground">
                  {CHARGE_CONCEPT_LABELS[ch.concepto]} · {ch.descripcion}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{fechaHoraEsMx(ch.creadoEn)}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">{dineroMx(ch.monto + ch.impuesto)}</span>
                {isOpen && cargoTransferible(ch) && otrosFolios.length > 0 && (
                  <Button type="button" variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={() => setTransfer(transfer?.chargeId === ch.id ? null : { chargeId: ch.id, destino: "", motivo: "" })} disabled={busy}>
                    Transferir
                  </Button>
                )}
                {isOpen && !ch.revertidoPor && ch.concepto !== "reverso" && (
                  <Button type="button" variant="outline" size="sm" className="h-7 px-2.5 text-xs text-destructive border-destructive/40 hover:border-destructive" onClick={() => void handleReverse(ch.id)} disabled={busy}>
                    Reversar
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {isOpen && transfer && (
        <div className="flex flex-col gap-2 border border-border rounded-lg p-4">
          <p className="text-sm font-semibold text-foreground">Transferir cargo a otro folio</p>
          <div className="flex gap-2 flex-wrap">
            <FormField label="Folio destino">
              <NativeSelect aria-label="Folio destino" value={transfer.destino} onChange={(e) => setTransfer({ ...transfer, destino: e.target.value })}>
                <option value="">Folio destino…</option>
                {otrosFolios.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.etiqueta}
                    {f.esPrincipal ? " (principal)" : ""}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Motivo (opcional)" className="flex-1 min-w-[160px]">
              <Input placeholder="Motivo (opcional)" value={transfer.motivo} maxLength={200} onChange={(e) => setTransfer({ ...transfer, motivo: e.target.value })} />
            </FormField>
            <Button type="button" loading={busy} disabled={busy || transfer.destino === ""} onClick={() => void handleTransfer()} className="self-end">
              Confirmar transferencia
            </Button>
            <Button type="button" variant="ghost" className="self-end" onClick={() => setTransfer(null)}>
              Cancelar
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">El cargo se reversa en este folio y se crea igual en el destino; ambos movimientos quedan registrados.</p>
        </div>
      )}

      {isOpen && folio.cargos.some(cargoTransferible) && (
        <form onSubmit={handleSplit} className="flex flex-col gap-2 border border-border rounded-lg p-4">
          <p className="text-sm font-semibold text-foreground">Dividir folio</p>
          <p className="text-xs text-muted-foreground">Elige los cargos que pasan a un folio nuevo de esta misma reserva (por ejemplo, para facturar aparte).</p>
          <div className="flex flex-col gap-1">
            {folio.cargos.filter(cargoTransferible).map((ch) => (
              <Checkbox key={ch.id} label={`${CHARGE_CONCEPT_LABELS[ch.concepto]} · ${ch.descripcion} · ${dineroMx(ch.monto + ch.impuesto)}`} checked={splitCargos.has(ch.id)} onChange={() => toggleSplit(ch.id)} />
            ))}
          </div>
          <div className="flex gap-2 flex-wrap">
            <FormField label="Nombre del folio nuevo" className="flex-1 min-w-[160px]"><Input placeholder="Nombre del folio nuevo" value={splitEtiqueta} maxLength={80} onChange={(e) => setSplitEtiqueta(e.target.value)} /></FormField>
            <Button type="submit" variant="outline" loading={busy} disabled={busy || splitCargos.size === 0 || splitEtiqueta.trim() === ""} className="self-end">
              Crear folio con los cargos elegidos
            </Button>
          </div>
        </form>
      )}

      {isOpen && (
        <form onSubmit={handleAddCharge} className="flex flex-col gap-2 border border-border rounded-lg p-4">
          <p className="text-sm font-semibold text-foreground">Agregar cargo</p>
          <div className="flex gap-2 flex-wrap">
            <FormField label="Descripción" className="flex-[2] min-w-[160px]"><Input placeholder="Descripción" value={chargeDesc} onChange={(e) => setChargeDesc(e.target.value)} /></FormField>
            <FormField label="Monto" className="flex-1 min-w-[100px]"><Input placeholder="Monto" type="number" min="0.01" step="0.01" value={chargeAmount} onChange={(e) => setChargeAmount(e.target.value)} /></FormField>
            <FormField label="Concepto">
              <NativeSelect value={chargeConcept} onChange={(e) => setChargeConcept(e.target.value as AddChargeInput["concepto"])}>
                {CHARGE_CONCEPTS.map((c) => (
                  <option key={c} value={c}>
                    {CHARGE_CONCEPT_LABELS[c]}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <Button type="submit" loading={busy} disabled={busy} className="self-end">
              Agregar
            </Button>
          </div>
        </form>
      )}

      {isOpen && (
        <form onSubmit={handleAddDiscount} className="flex flex-col gap-2 border border-border rounded-lg p-4">
          <p className="text-sm font-semibold text-foreground">Aplicar descuento</p>
          <div className="flex gap-2 flex-wrap">
            <FormField label="Motivo" className="flex-[2] min-w-[160px]"><Input placeholder="Motivo" value={discountDesc} onChange={(e) => setDiscountDesc(e.target.value)} /></FormField>
            <FormField label="Monto" className="flex-1 min-w-[100px]"><Input placeholder="Monto" type="number" min="0.01" step="0.01" value={discountAmount} onChange={(e) => setDiscountAmount(e.target.value)} /></FormField>
            <Button type="submit" variant="outline" loading={busy} disabled={busy} className="self-end">
              Aplicar
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Un descuento por arriba del umbral de la property requiere autorización de un rol admin (owner/gm) — el servidor lo exige, este formulario no lo evita.</p>
        </form>
      )}

      <section>
        <h2 className="text-sm font-semibold text-foreground mb-2">Pagos</h2>
        <div className="flex flex-col gap-1.5">
          {folio.pagos.length === 0 && <p className="text-sm text-muted-foreground">Sin pagos.</p>}
          {folio.pagos.map((p) => (
            <div key={p.id} className="flex justify-between border border-border rounded-lg px-3 py-2">
              <span className="text-sm text-foreground">
                {p.metodo} · {p.estado}
              </span>
              <span className="text-sm font-semibold text-foreground">{dineroMx(p.monto)}</span>
            </div>
          ))}
        </div>
      </section>

      {isOpen && (
        <form onSubmit={handleAddPayment} className="flex flex-col gap-2 border border-border rounded-lg p-4">
          <p className="text-sm font-semibold text-foreground">Registrar pago</p>
          <div className="flex gap-2 flex-wrap">
            <FormField label="Monto" className="flex-1 min-w-[100px]"><Input placeholder="Monto" type="number" min="0.01" step="0.01" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} /></FormField>
            <FormField label="Método">
              <NativeSelect value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as "efectivo" | "transferencia")}>
                <option value="efectivo">Efectivo</option>
                <option value="transferencia">Transferencia</option>
              </NativeSelect>
            </FormField>
            <Button type="submit" loading={busy} disabled={busy} className="self-end">
              Registrar
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Pago con tarjeta no disponible en este panel: exige un token real de pasarela, nunca un número de tarjeta capturado a mano.</p>
        </form>
      )}

      {isOpen && (
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => handleClose("saldo_cero")} disabled={busy}>
            Cerrar folio (saldo en cero)
          </Button>
          <Button type="button" variant="outline" className="text-warning border-warning/40 hover:border-warning" onClick={() => handleClose("cuenta_por_cobrar")} disabled={busy}>
            Cerrar como cuenta por cobrar
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={pendingClose !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPendingClose(null);
        }}
        titulo={pendingClose === "cuenta_por_cobrar" ? "Cerrar como cuenta por cobrar" : "Cerrar folio"}
        descripcion={
          pendingClose === "cuenta_por_cobrar"
            ? `¿Cerrar este folio (saldo ${dineroMx(folio.saldo)}) como cuenta por cobrar? Esta acción es irreversible desde este panel: el folio queda cerrado y el saldo pendiente pasa a cobranza.`
            : `¿Cerrar este folio con saldo en cero? Esta acción es irreversible desde este panel: el folio queda cerrado y ya no admite cargos ni pagos nuevos.`
        }
        tono="danger"
        confirmar={pendingClose === "cuenta_por_cobrar" ? "Sí, cerrar como cuenta por cobrar" : "Sí, cerrar folio"}
        cancelar="Volver"
        onConfirm={handleConfirmClose}
      />
      {dialogo}
    </PageContainer>
  );
}
