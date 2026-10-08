// H-28 -- dialogo "Cambiar fechas" de una reserva (compartido por Recepcion y Reservas). Dos pasos reales contra el servidor:
// previsualiza (recotiza con el motor de tarifas, cupo, penalidad y bloqueos) y confirma con guardia de precio (`totalEsperado`) e
// Idempotency-Key. Nada se calcula en el cliente: todo numero sale de la previsualizacion. "Cancelar" solo cierra, nunca ejecuta.
import { useEffect, useRef, useState } from "react";
import { Button, Callout, DataTable, FormDialog, FormField, Input, Textarea } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { cambiarFechas, ESTADOS_EN_CASA, previsualizarFechas } from "../lib/fechas-client.ts";
import type { PrevisualizacionFechas } from "../lib/fechas-client.ts";
import { newIdempotencyKey } from "../lib/admin-client.ts";
import { dineroMx } from "../lib/dinero.ts";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";

export interface ReservaParaFechas {
  readonly id: string;
  readonly entrada: string;
  readonly salida: string;
  readonly estado: string;
  readonly huesped?: string | null;
}

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** null = cerrado. */
  readonly reserva: ReservaParaFechas | null;
  readonly onClose: () => void;
  /** Se llama tras un cambio exitoso con el aviso para mostrar; el padre recarga sus datos. */
  readonly onDone: (aviso: string) => void;
}

interface FilaComparacion {
  readonly etiqueta: string;
  readonly actual: string;
  readonly nueva: string;
  readonly fuerte?: boolean;
}

const COLUMNAS_COMPARACION: readonly DataTableColumna<FilaComparacion>[] = [
  { id: "concepto", encabezado: "Concepto", principal: true, celda: (f) => <span className={f.fuerte ? "font-semibold text-foreground" : "text-muted-foreground"}>{f.etiqueta}</span> },
  { id: "actual", encabezado: "Actual", alinear: "right", celda: (f) => <span className={f.fuerte ? "font-semibold tabular-nums" : "tabular-nums"}>{f.actual}</span> },
  { id: "nueva", encabezado: "Nueva", alinear: "right", celda: (f) => <span className={f.fuerte ? "font-semibold tabular-nums" : "tabular-nums"}>{f.nueva}</span> },
];

export function CambiarFechasDialog({ apiBaseUrl, token, propertyId, reserva, onClose, onDone }: Props) {
  const [entrada, setEntrada] = useState("");
  const [salida, setSalida] = useState("");
  const [motivo, setMotivo] = useState("");
  const [preview, setPreview] = useState<PrevisualizacionFechas | null>(null);
  const [cargando, setCargando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresco, setRefresco] = useState(0);
  const llave = useRef<string>(newIdempotencyKey());
  const secuencia = useRef(0);

  const enCasa = reserva !== null && ESTADOS_EN_CASA.has(reserva.estado);

  // Al abrir con otra reserva se reinician los campos.
  useEffect(() => {
    if (!reserva) return;
    setEntrada(reserva.entrada);
    setSalida(reserva.salida);
    setMotivo("");
    setPreview(null);
    setError(null);
    llave.current = newIdempotencyKey();
  }, [reserva?.id]);

  // Previsualizacion real contra el servidor cada vez que cambian las fechas (con espera corta para no consultar en cada tecla).
  useEffect(() => {
    if (!reserva) return;
    const sinCambio = entrada === reserva.entrada && salida === reserva.salida;
    if (sinCambio || entrada === "" || salida === "") {
      setPreview(null);
      return;
    }
    const mia = ++secuencia.current;
    const t = setTimeout(() => {
      setCargando(true);
      void previsualizarFechas(fetch, apiBaseUrl, token, propertyId, reserva.id, entrada, salida)
        .then((p) => {
          if (secuencia.current !== mia) return;
          setPreview(p);
        })
        .catch((err: unknown) => {
          if (secuencia.current !== mia) return;
          setPreview(null);
          setError(err instanceof Error ? err.message : "No se pudo previsualizar el cambio.");
        })
        .finally(() => {
          if (secuencia.current === mia) setCargando(false);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [reserva?.id, entrada, salida, refresco, apiBaseUrl, token, propertyId]);

  if (!reserva) return null;
  const nueva = preview?.nueva ?? null;

  async function confirmar() {
    if (!reserva || !preview || !nueva) return;
    setGuardando(true);
    setError(null);
    try {
      const r = await cambiarFechas(fetch, apiBaseUrl, token, propertyId, reserva.id, { checkInDate: entrada, checkOutDate: salida, totalEsperado: nueva.total, ...(motivo.trim() ? { motivo: motivo.trim() } : {}) }, llave.current);
      const penal = r.penalidad.monto > 0 ? ` Penalidad por politica de cancelacion: ${dineroMx(r.penalidad.monto)} (aplicala en el folio).` : "";
      const lista = r.ofertasListaEspera > 0 ? ` Se ofrecio lugar a ${r.ofertasListaEspera} entrada(s) de la lista de espera.` : "";
      onDone(`Fechas cambiadas: ${formatFechaSolo(r.cambio.entradaAnterior)} → ${formatFechaSolo(r.cambio.salidaAnterior)} pasa a ${r.reserva ? `${formatFechaSolo(r.reserva.checkInDate)} → ${formatFechaSolo(r.reserva.checkOutDate)}` : "las fechas nuevas"}. Total ${dineroMx(r.totalNuevo)}.${penal}${lista}`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar las fechas.");
      // Un rechazo por cambio de precio o cupo deja la previsualizacion vieja: se recalcula y se pide confirmar de nuevo.
      llave.current = newIdempotencyKey();
      setRefresco((n) => n + 1);
    } finally {
      setGuardando(false);
    }
  }

  const dif = preview?.diferenciaTotal ?? null;
  return (
    <FormDialog
      open
      onOpenChange={(abierto) => {
        if (!abierto && !guardando) onClose();
      }}
      titulo="Cambiar fechas"
      subtitulo={`${reserva.huesped ? `${reserva.huesped} · ` : ""}${formatFechaSolo(reserva.entrada)} → ${formatFechaSolo(reserva.salida)}`}
      anchoClase="max-w-xl"
      bloquearCierre={guardando}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={guardando}>
            Cancelar
          </Button>
          <Button type="button" loading={guardando} disabled={guardando || cargando || !preview?.puedeCambiar} onClick={() => void confirmar()}>
            {guardando ? "Aplicando…" : "Confirmar cambio"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {enCasa && <p className="text-xs text-muted-foreground">El huésped ya está en casa: solo se puede extender o acortar la salida. Las noches ya cargadas al folio no se tocan.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id="cf-entrada" label="Llegada">
            <Input type="date" value={entrada} disabled={enCasa || guardando} onChange={(e) => { setError(null); setEntrada(e.target.value); }} />
          </FormField>
          <FormField id="cf-salida" label="Salida">
            <Input type="date" value={salida} disabled={guardando} onChange={(e) => { setError(null); setSalida(e.target.value); }} />
          </FormField>
        </div>
        <FormField id="cf-motivo" label="Motivo (opcional)">
          <Textarea rows={2} maxLength={200} value={motivo} disabled={guardando} onChange={(e) => setMotivo(e.target.value)} />
        </FormField>

        {cargando && <p role="status" className="text-sm text-muted-foreground">Recotizando…</p>}
        {preview && !cargando && (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3" aria-label="Previsualización del cambio">
            {preview.bloqueos.length > 0 && (
              <ul role="alert" className="list-disc pl-4 text-sm text-destructive">
                {preview.bloqueos.map((b) => (
                  <li key={b.codigo}>{b.mensaje}</li>
                ))}
              </ul>
            )}
            {nueva && (
              <DataTable
                etiqueta="Comparación del cambio de fechas"
                columnas={COLUMNAS_COMPARACION}
                obtenerId={(f) => f.etiqueta}
                paginacion={false}
                vista="tabla"
                filas={[
                  { etiqueta: "Noches", actual: String(preview.actual.noches), nueva: String(nueva.noches) },
                  { etiqueta: "Subtotal", actual: dineroMx(preview.actual.neto), nueva: dineroMx(nueva.neto) },
                  { etiqueta: "IVA", actual: dineroMx(preview.actual.iva), nueva: dineroMx(nueva.iva) },
                  { etiqueta: "ISH", actual: dineroMx(preview.actual.ish), nueva: dineroMx(nueva.ish) },
                  { etiqueta: "Total", actual: dineroMx(preview.actual.total), nueva: dineroMx(nueva.total), fuerte: true },
                ]}
              />
            )}
            {dif !== null && (
              <p className="text-sm text-foreground">
                {dif === 0 ? "El total no cambia." : dif > 0 ? `Diferencia a cobrar: ${dineroMx(dif)}.` : `Diferencia a favor del huésped: ${dineroMx(Math.abs(dif))}.`}
              </p>
            )}
            {preview.nochesAgregadas.length > 0 && <p className="text-xs text-muted-foreground">Noches agregadas: {preview.nochesAgregadas.map((n) => formatFechaSolo(n)).join(", ")}.</p>}
            {preview.nochesQuitadas.length > 0 && <p className="text-xs text-muted-foreground">Noches liberadas: {preview.nochesQuitadas.map((n) => formatFechaSolo(n)).join(", ")}.</p>}
            {preview.penalidad.monto > 0 && (
              <p className="text-sm text-destructive">
                Penalidad por la política de cancelación ({Math.round(preview.penalidad.porcentaje * 100)}% de las noches liberadas): {dineroMx(preview.penalidad.monto)}. Es informativa: aplícala desde el folio.
              </p>
            )}
          </div>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </FormDialog>
  );
}
