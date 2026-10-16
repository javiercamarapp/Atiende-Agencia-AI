// Pestana "Registro migratorio" de Identidad. UNI-C gestion: extraida de Identidad.tsx; DataTable, useConfirm en vez de
// window.prompt y notify. Mismas llamadas: fetchMigratorios / fetchIdentidades / createMigratorio / reportMigratorio.
import { useEffect, useMemo, useState } from "react";
import { Button, Card, CardContent, DataTable, EstadoCargando, EstadoError, EstadoVacio, StatusBadge, notify, useConfirm } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { DOCUMENT_TYPE_LABELS, MIGRATORIO_ESTADO_LABELS, createMigratorio, fetchIdentidades, fetchMigratorios, reportMigratorio } from "../../lib/identidad-client.ts";
import type { IdentidadSummary, MigratorioSummary } from "../../lib/identidad-client.ts";
import { errorMessage } from "./comun.ts";
import type { TabProps } from "./comun.ts";

export function MigratorioTab({ apiBaseUrl, token, propertyId }: TabProps) {
  const [data, setData] = useState<{ readonly disponible: boolean; readonly items: readonly MigratorioSummary[] } | null>(null);
  const [candidates, setCandidates] = useState<readonly IdentidadSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { pedirTexto, dialogo } = useConfirm();

  async function load() {
    setError(null);
    try {
      const [m, ids] = await Promise.all([fetchMigratorios(fetch, apiBaseUrl, token, propertyId), fetchIdentidades(fetch, apiBaseUrl, token, propertyId, "activo")]);
      setData(m);
      setCandidates(ids.items);
    } catch (err) {
      setError(errorMessage(err, "No se pudo cargar el registro migratorio."));
    }
  }
  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  // Identidades de extranjeros ligadas a una reserva que aún no tienen registro.
  const registrables = useMemo(() => {
    const registered = new Set((data?.items ?? []).map((r) => `${r.reservaId}|${r.huespedId}`));
    return candidates.filter((c) => c.reservaId && c.nacionalidad && c.nacionalidad !== "MEX" && !registered.has(`${c.reservaId}|${c.huespedId}`));
  }, [candidates, data]);

  async function handleCreate(c: IdentidadSummary) {
    setBusyId(c.id);
    try {
      await createMigratorio(fetch, apiBaseUrl, token, propertyId, { reservaId: c.reservaId!, huespedId: c.huespedId, identidadId: c.id });
      notify.success("Registro migratorio creado.");
      await load();
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo crear el registro migratorio."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleReport(r: MigratorioSummary) {
    const constancia = await pedirTexto({
      titulo: "Marcar como reportado",
      descripcion: "Este sistema no envía nada al INM: captura el folio o la referencia de la constancia que obtuviste al reportar.",
      confirmar: "Marcar reportado",
      cancelar: "Cancelar",
      campo: { etiqueta: "Folio o referencia de la constancia", maxLength: 120 },
    });
    if (constancia === null || constancia.trim() === "") return;
    setBusyId(r.id);
    try {
      await reportMigratorio(fetch, apiBaseUrl, token, propertyId, r.id, constancia.trim());
      notify.success("Registro marcado como reportado.");
      await load();
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo marcar como reportado."));
    } finally {
      setBusyId(null);
    }
  }

  const columnas: DataTableColumna<MigratorioSummary>[] = [
    {
      id: "registro",
      encabezado: "Registro",
      principal: true,
      celda: (r) => (
        <div className="min-w-0">
          <p className="font-medium text-foreground">
            {r.nacionalidad ?? "—"} · {r.llegada} → {r.salida}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Reserva {r.reservaId} · Huésped {r.huespedId}
            {r.retencionRegistroHasta ? ` · Registro conservado hasta ${r.retencionRegistroHasta}` : ""}
          </p>
          {r.constancia && <p className="mt-0.5 text-xs text-muted-foreground">Constancia: {r.constancia}</p>}
        </div>
      ),
    },
    { id: "estado", encabezado: "Estado", celda: (r) => <StatusBadge tone={r.estado === "pendiente" ? "warning" : "neutral"}>{MIGRATORIO_ESTADO_LABELS[r.estado]}</StatusBadge> },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      celda: (r) =>
        r.estado === "pendiente" ? (
          <Button type="button" size="sm" variant="outline" onClick={() => void handleReport(r)} disabled={busyId === r.id}>
            Marcar como reportado
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">Este registro lleva el estado y la constancia de cada huésped extranjero. No envía información al INM: el reporte se hace por el canal oficial y aquí se captura su folio.</p>
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {!data && !error && <EstadoCargando etiqueta="Cargando registro migratorio…" />}
      {data && !data.disponible && <EstadoVacio mensaje="El registro migratorio aún no está disponible en esta base (migración pendiente de aplicar)." />}

      {registrables.length > 0 && (
        <Card>
          <CardContent className="p-4 flex flex-col gap-2">
            <h2 className="text-sm font-medium text-foreground">Por registrar ({registrables.length})</h2>
            {registrables.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 flex-wrap text-sm">
                <span>
                  {DOCUMENT_TYPE_LABELS[c.tipoDocumento]} {c.ultimos4 ? `****${c.ultimos4}` : ""} · {c.nacionalidad} · reserva {c.reservaId}
                </span>
                <Button type="button" size="sm" variant="outline" onClick={() => void handleCreate(c)} disabled={busyId === c.id}>
                  Crear registro
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {data && data.disponible && <DataTable etiqueta="Registros migratorios" columnas={columnas} filas={data.items} obtenerId={(r) => r.id} vacio={{ mensaje: "No hay registros migratorios." }} />}
      {dialogo}
    </div>
  );
}
