// Pestana "Purgas" (doble control) de Identidad. UNI-C gestion: extraida de Identidad.tsx; DataTable, useConfirm en vez de
// window.prompt (Cancelar/Escape nunca deciden) y notify. Mismas llamadas: fetchPurgas / decidePurga.
import { useEffect, useState } from "react";
import { Button, DataTable, EstadoCargando, EstadoError, EstadoVacio, StatusBadge, notify, useConfirm } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { PURGA_ESTADO_LABELS, decidePurga, fetchPurgas } from "../../lib/identidad-client.ts";
import type { PurgaSummary } from "../../lib/identidad-client.ts";
import { fechaHoraEsMx } from "../../../../lib/formato-fecha.ts";
import { errorMessage } from "./comun.ts";
import type { TabProps } from "./comun.ts";

export function PurgasTab({ apiBaseUrl, token, propertyId }: TabProps) {
  const [data, setData] = useState<{ readonly disponible: boolean; readonly items: readonly PurgaSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { pedirTexto, dialogo } = useConfirm();

  async function load() {
    setError(null);
    try {
      setData(await fetchPurgas(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(errorMessage(err, "No se pudieron cargar las solicitudes de purga."));
    }
  }
  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleDecide(p: PurgaSummary, aprobar: boolean) {
    const nota = await pedirTexto({
      titulo: aprobar ? "Aprobar la purga" : "Rechazar la solicitud de purga",
      descripcion: aprobar ? "La identidad quedará bloqueada y se purgará (irreversible) al vencer la ventana." : undefined,
      tono: aprobar ? "danger" : "default",
      confirmar: aprobar ? "Aprobar purga" : "Rechazar",
      cancelar: "Cancelar",
      campo: { etiqueta: aprobar ? "Nota de aprobación (opcional)" : "Motivo del rechazo (opcional)", requerido: false, multilinea: true, maxLength: 300 },
    });
    if (nota === null) return;
    setBusyId(p.id);
    try {
      const r = await decidePurga(fetch, apiBaseUrl, token, propertyId, p.id, aprobar, nota || undefined);
      notify.success(r === "ejecutada" ? "Purga ejecutada." : r === "en_bloqueo" ? "Purga aprobada: la identidad quedó bloqueada y se purgará al vencer la ventana." : "Solicitud rechazada.");
      await load();
    } catch (err) {
      // Doble control: si quien decide es quien solicitó, el servidor responde 403 con el motivo.
      notify.error(errorMessage(err, "No se pudo resolver la solicitud."));
    } finally {
      setBusyId(null);
    }
  }

  const columnas: DataTableColumna<PurgaSummary>[] = [
    {
      id: "identidad",
      encabezado: "Solicitud",
      principal: true,
      celda: (p) => (
        <div className="min-w-0">
          <p className="font-medium text-foreground">Identidad {p.identidadId}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{p.motivo}</p>
          {p.notaDecision && <p className="mt-0.5 text-xs text-muted-foreground">Nota: {p.notaDecision}</p>}
        </div>
      ),
    },
    { id: "solicitada", encabezado: "Solicitada", celda: (p) => <span className="text-xs text-muted-foreground">Por {p.solicitadaPor} · {fechaHoraEsMx(p.creadaEn)}</span> },
    {
      id: "estado",
      encabezado: "Estado",
      celda: (p) => <StatusBadge tone={p.estado === "pendiente" || p.estado === "en_bloqueo" ? "warning" : "neutral"}>{PURGA_ESTADO_LABELS[p.estado]}</StatusBadge>,
    },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      celda: (p) =>
        p.estado === "pendiente" ? (
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="destructive" onClick={() => void handleDecide(p, true)} disabled={busyId === p.id}>
              Aprobar purga
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void handleDecide(p, false)} disabled={busyId === p.id}>
              Rechazar
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">Doble control: quien solicita una purga no puede aprobarla; debe decidirla otra persona con rol owner/gm. Aprobarla bloquea la identidad (sin acceso operativo, con la ventana configurada); la purga borra el documento cifrado, es irreversible y ocurre solo al vencer la ventana y si no hay retención legal.</p>
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {!data && !error && <EstadoCargando etiqueta="Cargando solicitudes…" />}
      {data && !data.disponible && <EstadoVacio mensaje="Las solicitudes de purga aún no están disponibles en esta base (migración pendiente de aplicar)." />}
      {data && data.disponible && <DataTable etiqueta="Solicitudes de purga" columnas={columnas} filas={data.items} obtenerId={(p) => p.id} vacio={{ mensaje: "No hay solicitudes de purga." }} />}
      {dialogo}
    </div>
  );
}
