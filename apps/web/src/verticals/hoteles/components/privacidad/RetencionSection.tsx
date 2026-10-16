// Retencion legal, acceso excepcional y bitacora (H-02). UNI-C gestion: listas con DataTable y notas con useConfirm en vez de
// `window.prompt` (Cancelar/Escape nunca liberan ni deciden). Mismas llamadas. Doble control: el servidor responde 403 al solicitante.
import { useEffect, useState } from "react";
import { Button, Card, CardContent, Callout, DataTable, EstadoCargando, EstadoError, StatusBadge, notify, useConfirm } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { decideAcceso, fetchAccesos, fetchBitacora, fetchRetenciones, releaseRetencion, revealAccesoExcepcional } from "../../lib/privacidad-client.ts";
import type { AccesoSummary, EventoSummary, Lista, RetencionSummary } from "../../lib/privacidad-client.ts";
import type { DocumentoRevelado } from "../../lib/identidad-client.ts";
import { NoDisponible, errorMessage, validarNota10 } from "./comun.tsx";
import type { PrivacidadSectionProps } from "./comun.tsx";

const REVISION_LABELS: Record<RetencionSummary["revision"], string> = { vigente: "Revisión vigente", revision_proxima: "Revisión próxima", revision_vencida: "Revisión vencida", liberada: "Liberada" };

export function RetencionSection({ apiBaseUrl, token, propertyId }: PrivacidadSectionProps) {
  const [holds, setHolds] = useState<Lista<RetencionSummary> | null>(null);
  const [accesos, setAccesos] = useState<Lista<AccesoSummary> | null>(null);
  const [bitacora, setBitacora] = useState<Lista<EventoSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ readonly id: string; readonly doc: DocumentoRevelado } | null>(null);
  const { pedirTexto, dialogo } = useConfirm();

  async function load() {
    setError(null);
    try {
      const [h, a, b] = await Promise.all([
        fetchRetenciones(fetch, apiBaseUrl, token, propertyId),
        fetchAccesos(fetch, apiBaseUrl, token, propertyId),
        fetchBitacora(fetch, apiBaseUrl, token, propertyId),
      ]);
      setHolds(h);
      setAccesos(a);
      setBitacora(b);
    } catch (err) {
      setError(errorMessage(err, "No se pudo cargar la retención y el bloqueo."));
    }
  }
  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleRelease(h: RetencionSummary) {
    const nota = await pedirTexto({
      titulo: `Liberar la retención del caso ${h.folio}`,
      descripcion: "Tras liberarla, la identidad podrá purgarse al vencer su ventana.",
      tono: "danger",
      confirmar: "Liberar retención",
      cancelar: "Cancelar",
      campo: { etiqueta: "Nota (10 a 300 caracteres)", multilinea: true, minLength: 10, maxLength: 300, validar: validarNota10 },
    });
    if (nota === null) return;
    try {
      await releaseRetencion(fetch, apiBaseUrl, token, propertyId, h.id, nota);
      notify.success("Retención liberada.");
      await load();
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo liberar la retención."));
    }
  }

  async function handleDecide(a: AccesoSummary, aprobar: boolean) {
    const nota = await pedirTexto({
      titulo: aprobar ? "Aprobar el acceso excepcional" : "Rechazar el acceso excepcional",
      descripcion: aprobar ? "La aprobación caduca en 2 horas y se usa una sola vez." : undefined,
      tono: aprobar ? "default" : "danger",
      confirmar: aprobar ? "Aprobar acceso" : "Rechazar acceso",
      cancelar: "Cancelar",
      campo: { etiqueta: aprobar ? "Nota de aprobación" : "Motivo del rechazo (opcional)", requerido: false, multilinea: true, maxLength: 300 },
    });
    if (nota === null) return;
    try {
      await decideAcceso(fetch, apiBaseUrl, token, propertyId, a.id, aprobar, nota || undefined);
      notify.success(aprobar ? "Acceso excepcional aprobado." : "Acceso excepcional rechazado.");
      await load();
    } catch (err) {
      // Doble control: si quien decide es quien pidió, el servidor responde 403 con el motivo.
      notify.error(errorMessage(err, "No se pudo resolver la solicitud."));
    }
  }

  async function handleReveal(a: AccesoSummary) {
    try {
      setRevealed({ id: a.id, doc: await revealAccesoExcepcional(fetch, apiBaseUrl, token, propertyId, a.id) });
      await load();
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo revelar el documento."));
    }
  }

  const colRetenciones: DataTableColumna<RetencionSummary>[] = [
    {
      id: "caso",
      encabezado: "Caso",
      principal: true,
      celda: (h) => (
        <div className="min-w-0">
          <p className="font-medium text-foreground">
            Caso {h.folio} · identidad {h.identidadId}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {h.motivo} · autoriza: {h.autorizacion}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {REVISION_LABELS[h.revision]} · revisar antes del {h.revisarAntesDe}
          </p>
        </div>
      ),
    },
    { id: "estado", encabezado: "Estado", celda: (h) => <StatusBadge tone={h.estado === "activa" ? "info" : "neutral"}>{h.estado === "activa" ? "Activa" : "Liberada"}</StatusBadge> },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      celda: (h) =>
        h.estado === "activa" ? (
          <Button type="button" size="sm" variant="outline" onClick={() => void handleRelease(h)}>
            Liberar retención
          </Button>
        ) : null,
    },
  ];

  const colAccesos: DataTableColumna<AccesoSummary>[] = [
    {
      id: "acceso",
      encabezado: "Solicitud",
      principal: true,
      celda: (a) => (
        <div className="min-w-0">
          <p className="text-sm text-foreground">
            Identidad {a.identidadId} · {a.motivo}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Solicitada por {a.solicitadaPor}
            {a.caducaEn ? ` · caduca ${a.caducaEn}` : ""}
          </p>
        </div>
      ),
    },
    { id: "estado", encabezado: "Estado", celda: (a) => <StatusBadge tone={a.estado === "pendiente" || a.estado === "aprobada" ? "info" : "neutral"}>{a.estado}</StatusBadge> },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      celda: (a) => (
        <div className="flex gap-2 flex-wrap">
          {a.estado === "pendiente" && (
            <>
              <Button type="button" size="sm" onClick={() => void handleDecide(a, true)}>
                Aprobar acceso
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void handleDecide(a, false)}>
                Rechazar acceso
              </Button>
            </>
          )}
          {a.estado === "aprobada" && (
            <Button type="button" size="sm" variant="outline" onClick={() => void handleReveal(a)}>
              Revelar documento (un solo uso)
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Una identidad vencida o con purga aprobada pasa primero a <strong>bloqueada</strong> (sin acceso operativo) y solo se purga al vencer la ventana y si no tiene una retención legal activa. Desde la bóveda puedes bloquear, aplicar una retención legal (folio, motivo y quién autoriza) o pedir acceso excepcional (doble control).
      </p>
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {!holds && !error && <EstadoCargando etiqueta="Cargando retenciones…" />}
      {holds && !holds.disponible && <NoDisponible />}
      {holds?.disponible && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-foreground">Retenciones legales</h2>
          <DataTable etiqueta="Retenciones legales" columnas={colRetenciones} filas={holds.items} obtenerId={(h) => h.id} vacio={{ mensaje: "No hay retenciones legales." }} />
        </div>
      )}
      {accesos?.disponible && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-foreground">Accesos excepcionales a identidades bloqueadas</h2>
          <p className="text-xs text-muted-foreground">Doble control: quien pide el acceso no puede aprobarlo; la aprobación caduca a las 2 horas y se consume una sola vez, solo por quien la pidió.</p>
          {revealed && (
            <Card>
              <CardContent className="p-3 text-sm flex flex-col gap-1" data-testid="documento-acceso-excepcional">
                <Callout tone="warning" titulo="Documento revelado (un solo uso)">Se descarta al ocultarlo.</Callout>
                <p>
                  <span className="text-muted-foreground">Nombre:</span> {revealed.doc.nombreCompleto}
                </p>
                <p>
                  <span className="text-muted-foreground">Documento:</span> {revealed.doc.numeroDocumento}
                </p>
                <div>
                  <Button type="button" variant="outline" size="sm" onClick={() => setRevealed(null)}>
                    Ocultar
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
          <DataTable etiqueta="Accesos excepcionales" columnas={colAccesos} filas={accesos.items} obtenerId={(a) => a.id} vacio={{ mensaje: "No hay solicitudes de acceso excepcional." }} />
        </div>
      )}
      {bitacora?.disponible && bitacora.items.length > 0 && (
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium text-foreground">Bitácora de privacidad (últimos 50)</h2>
          <ul className="text-xs text-muted-foreground flex flex-col gap-0.5">
            {bitacora.items.map((e) => (
              <li key={e.id}>
                {e.creadaEn} · {e.tipo} · {e.accion}
                {e.nota ? ` · ${e.nota}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {dialogo}
    </div>
  );
}
