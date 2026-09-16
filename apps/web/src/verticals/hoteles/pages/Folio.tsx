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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  EstadoCargando,
  EstadoError,
  Input,
} from "@atiende/ui";
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
const selectClass =
  "flex h-11 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

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

  // Hallazgo de auditoría (severidad ALTA, "acciones destructivas sin
  // confirmación: ... cerrar folio ejecuta de inmediato con un clic"): cerrar un
  // folio es IRREVERSIBLE desde este panel (no hay ningún botón de "reabrir") --
  // `null` = modal cerrado; en otro caso guarda el motivo de cierre pendiente de
  // confirmar. Ver el <Dialog> de confirmación al final de este archivo.
  const [pendingClose, setPendingClose] = useState<"saldo_cero" | "cuenta_por_cobrar" | null>(null);

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
    <div className="flex flex-col gap-4 max-w-3xl">
      <header>
        <div className="flex justify-between items-start gap-3 flex-wrap">
          <h1 className="text-xl font-display font-semibold text-foreground">Folio: {folio.etiqueta}</h1>
          <Button asChild variant="outline" size="sm">
            <Link to={`/hoteles/${orgSlug}/folios/${folioId}/cfdi`}>
              <Receipt className="w-4 h-4" strokeWidth={1.75} />
              CFDI de este folio
            </Link>
          </Button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {folio.esPrincipal ? "Folio principal" : "Folio secundario"} · Estado: {folio.estado}
          {folio.motivoCierre ? ` (${folio.motivoCierre})` : ""}
        </p>
        <p className="mt-2.5 text-2xl font-semibold text-foreground">Saldo: {formatMoney(folio.saldo)}</p>
      </header>

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} />}

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
                <p className="mt-0.5 text-[11px] text-muted-foreground">{new Date(ch.creadoEn).toLocaleString("es-MX")}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">{formatMoney(ch.monto + ch.impuesto)}</span>
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

      {isOpen && (
        <form onSubmit={handleAddCharge} className="flex flex-col gap-2 border border-border rounded-lg p-4">
          <p className="text-sm font-semibold text-foreground">Agregar cargo</p>
          <div className="flex gap-2 flex-wrap">
            <Input placeholder="Descripción" value={chargeDesc} onChange={(e) => setChargeDesc(e.target.value)} className="flex-[2] min-w-[160px]" />
            <Input placeholder="Monto" type="number" min="0.01" step="0.01" value={chargeAmount} onChange={(e) => setChargeAmount(e.target.value)} className="flex-1 min-w-[100px]" />
            <select value={chargeConcept} onChange={(e) => setChargeConcept(e.target.value as AddChargeInput["concepto"])} className={selectClass}>
              {CHARGE_CONCEPTS.map((c) => (
                <option key={c} value={c}>
                  {CHARGE_CONCEPT_LABELS[c]}
                </option>
              ))}
            </select>
            <Button type="submit" disabled={busy}>
              Agregar
            </Button>
          </div>
        </form>
      )}

      {isOpen && (
        <form onSubmit={handleAddDiscount} className="flex flex-col gap-2 border border-border rounded-lg p-4">
          <p className="text-sm font-semibold text-foreground">Aplicar descuento</p>
          <div className="flex gap-2 flex-wrap">
            <Input placeholder="Motivo" value={discountDesc} onChange={(e) => setDiscountDesc(e.target.value)} className="flex-[2] min-w-[160px]" />
            <Input placeholder="Monto" type="number" min="0.01" step="0.01" value={discountAmount} onChange={(e) => setDiscountAmount(e.target.value)} className="flex-1 min-w-[100px]" />
            <Button type="submit" variant="outline" disabled={busy}>
              Aplicar
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">Un descuento por arriba del umbral de la property requiere autorización de un rol admin (owner/gm) — el servidor lo exige, este formulario no lo evita.</p>
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
              <span className="text-sm font-semibold text-foreground">{formatMoney(p.monto)}</span>
            </div>
          ))}
        </div>
      </section>

      {isOpen && (
        <form onSubmit={handleAddPayment} className="flex flex-col gap-2 border border-border rounded-lg p-4">
          <p className="text-sm font-semibold text-foreground">Registrar pago</p>
          <div className="flex gap-2 flex-wrap">
            <Input placeholder="Monto" type="number" min="0.01" step="0.01" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} className="flex-1 min-w-[100px]" />
            <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as "efectivo" | "transferencia")} className={selectClass}>
              <option value="efectivo">Efectivo</option>
              <option value="transferencia">Transferencia</option>
            </select>
            <Button type="submit" disabled={busy}>
              Registrar
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">Pago con tarjeta no disponible en este panel: exige un token real de pasarela, nunca un número de tarjeta capturado a mano.</p>
        </form>
      )}

      {isOpen && (
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => handleClose("saldo_cero")} disabled={busy}>
            Cerrar folio (saldo en cero)
          </Button>
          <Button type="button" variant="outline" className="text-amber-700 border-amber-700/40 hover:border-amber-700 dark:text-amber-500" onClick={() => handleClose("cuenta_por_cobrar")} disabled={busy}>
            Cerrar como cuenta por cobrar
          </Button>
        </div>
      )}

      <AlertDialog open={pendingClose !== null} onOpenChange={(open) => { if (!open && !busy) setPendingClose(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingClose === "cuenta_por_cobrar" ? "Cerrar como cuenta por cobrar" : "Cerrar folio"}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingClose === "cuenta_por_cobrar"
                ? `¿Cerrar este folio (saldo ${formatMoney(folio.saldo)}) como cuenta por cobrar? Esta acción es irreversible desde este panel: el folio queda cerrado y el saldo pendiente pasa a cobranza.`
                : `¿Cerrar este folio con saldo en cero? Esta acción es irreversible desde este panel: el folio queda cerrado y ya no admite cargos ni pagos nuevos.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Volver</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                // preventDefault: AlertDialogAction cierra solo por defecto -- este modal
                // sigue controlado por `pendingClose`/`busy` (mismo criterio que antes de
                // migrar de Dialog), no queremos que se cierre de golpe antes de que
                // termine `handleConfirmClose` (que muestra un estado "busy" mientras corre).
                e.preventDefault();
                void handleConfirmClose();
              }}
              disabled={busy}
            >
              {pendingClose === "cuenta_por_cobrar" ? "Sí, cerrar como cuenta por cobrar" : "Sí, cerrar folio"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
