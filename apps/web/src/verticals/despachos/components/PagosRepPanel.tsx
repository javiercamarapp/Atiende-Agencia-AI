// D-P3-17: pagos de complemento de pago (REP) del periodo con su póliza de cobro/pago. "Contabilizar" llama a POST .../libro/polizas/desde-rep
// (una póliza vigente por pago, con el traspaso del IVA). Datos reales de pago_cfdi (D-25); si la base aún no tiene la migración 028 se dice así.
import { useCallback, useEffect, useState } from "react";
import { FilePlus2 } from "lucide-react";
import { Button, Callout, DataTable, EstadoCargando, EstadoError, StatusBadge } from "@atiende/ui";
import { dinero, ETIQUETA_TIPO_POLIZA, fetchPagosRep, polizasDesdeRep } from "../lib/libro-client.ts";
import type { PagoRepLibro } from "../lib/libro-client.ts";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";

export interface PagosRepPanelProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly periodo: string;
  readonly puedeGestionar: boolean;
  /** Recarga el resto del libro (pólizas y balanza) tras contabilizar. */
  readonly onCambio: () => void;
}

export function PagosRepPanel({ apiBaseUrl, token, propertyId, periodo, puedeGestionar, onCambio }: PagosRepPanelProps) {
  const [pagos, setPagos] = useState<readonly PagoRepLibro[] | null>(null);
  const [noDisponible, setNoDisponible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      const r = await fetchPagosRep(fetch, apiBaseUrl, token, propertyId, periodo);
      setNoDisponible(r.estado === "no_disponible");
      setPagos(r.pagos ?? []);
    } catch (err) {
      setPagos(null);
      setError(err instanceof Error ? err.message : "No se pudieron cargar los pagos de complemento de pago.");
    }
  }, [apiBaseUrl, token, propertyId, periodo]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function contabilizar(p: PagoRepLibro) {
    setTrabajando(p.pagoId);
    setAviso(null);
    setError(null);
    try {
      const r = await polizasDesdeRep(fetch, apiBaseUrl, token, propertyId, p.folioFiscalRep, p.pagoId);
      await cargar();
      onCambio();
      // Los mensajes se fijan DESPUÉS de recargar (recargar limpia el error anterior).
      const res = r.resultados[0];
      if (res?.estado === "registrada") setAviso(`Póliza folio ${res.folio} registrada.${res.advertencias?.length ? ` ${res.advertencias.join(" ")}` : ""}`);
      else if (res?.estado === "ya_existia") setAviso("Ese pago ya tenía póliza vigente.");
      else setError(res?.motivo ?? "No se pudo contabilizar el pago.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo contabilizar el pago.");
    } finally {
      setTrabajando(null);
    }
  }

  if (noDisponible) {
    return (
      <Callout tone="warning" role="status">
        Las pólizas de cobro y pago de complementos de pago todavía no están disponibles en esta base: falta aplicar la migración 028.
      </Callout>
    );
  }

  return (
    <section aria-label="Pagos de complemento de pago" className="flex flex-col gap-2">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Pagos de complemento de pago (REP)</h2>
        <p className="text-xs text-muted-foreground">Cada pago genera una póliza de cobro (CFDI emitido) o de pago (recibido), con el traspaso del IVA no cobrado/no pagado a cobrado/pagado.</p>
      </div>
      {aviso && (
        <p role="status" className="text-sm text-success">
          {aviso}
        </p>
      )}
      {error && <EstadoError mensaje={error} onReintentar={() => void cargar()} />}
      {pagos === null && !error && <EstadoCargando etiqueta="Cargando pagos…" />}
      {pagos !== null && (
        <DataTable
          etiqueta="Pagos de complemento de pago del periodo"
          obtenerId={(p) => p.pagoId}
          filas={pagos}
          paginacion={{ tamano: 10 }}
          vacio={{ mensaje: "No hay pagos de complemento de pago en este periodo. Se registran al subir un REP en la página CFDI." }}
          columnas={[
            { id: "fecha", encabezado: "Fecha de pago", principal: true, valorOrden: (p) => p.fechaPago, celda: (p) => formatFechaSolo(p.fechaPago) },
            { id: "flujo", encabezado: "Flujo", celda: (p) => <span className="text-muted-foreground">{p.flujo === "trasladado" ? "Cobro" : "Pago"}{p.numParcialidad ? ` · parcialidad ${p.numParcialidad}` : ""}</span> },
            { id: "cfdi", encabezado: "CFDI", celda: (p) => <span className="font-mono text-xs">{p.folioFiscalCfdi.slice(0, 8)}…</span> },
            { id: "importe", encabezado: "Importe", alinear: "right", valorOrden: (p) => p.importePagadoCentavos, celda: (p) => <span className="font-mono text-xs">{dinero(p.importePagadoCentavos)}</span> },
            { id: "iva", encabezado: "IVA", alinear: "right", celda: (p) => <span className="font-mono text-xs">{dinero(p.ivaCentavos)}</span> },
            {
              id: "poliza",
              encabezado: "Póliza",
              celda: (p) =>
                p.poliza ? (
                  <StatusBadge tone="success">
                    {ETIQUETA_TIPO_POLIZA[p.poliza.tipo]} {p.poliza.folio}
                  </StatusBadge>
                ) : p.armable ? (
                  <StatusBadge tone="info">Sin contabilizar</StatusBadge>
                ) : (
                  <span className="text-xs text-muted-foreground">{p.motivo}</span>
                ),
            },
            {
              id: "acciones",
              encabezado: "",
              celda: (p) =>
                puedeGestionar && p.armable ? (
                  <Button type="button" variant="outline" size="sm" disabled={trabajando !== null} onClick={() => void contabilizar(p)}>
                    <FilePlus2 />
                    {trabajando === p.pagoId ? "Contabilizando…" : "Contabilizar"}
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
    </section>
  );
}
