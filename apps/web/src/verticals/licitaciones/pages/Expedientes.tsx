// Bandeja de EXPEDIENTES (paridad3 L-P3-16): el estado de cada convocatoria que ya se decidio perseguir (Go, en curso, presentada), paso por
// paso -- requisitos, redaccion, checklist, aprobacion 1/2 (tecnico-legal), aprobacion 2/2 (economica), paquete y presentacion --. Solo
// lectura: cada convocatoria enlaza a la pantalla donde se avanza cada paso. Paginacion y filtro de estado en el servidor (GET .../expedientes).
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { DataTable, EstadoCargando, EstadoError, EstadoVacio, Label, NativeSelect, PageContainer, StatusBadge } from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import { fetchExpedientes } from "../lib/expedientes-client.ts";
import type { ExpedienteEstado, ExpedienteFila, ExpedientesPagina } from "../lib/expedientes-client.ts";
import { formatDeadline, formatTenderStatus } from "../lib/format.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

const PAGE_SIZE = 25;

const CHECKLIST: Record<ExpedienteFila["checklist"], { readonly texto: string; readonly tono: StatusTone }> = {
  verde: { texto: "Verde", tono: "success" },
  ambar: { texto: "Ámbar", tono: "warning" },
  rojo: { texto: "Rojo", tono: "danger" },
  sin_correr: { texto: "Sin correr", tono: "neutral" },
};

function Paso({ hecho, si = "Listo", no = "Pendiente" }: { readonly hecho: boolean; readonly si?: string; readonly no?: string }) {
  return <StatusBadge tone={hecho ? "success" : "neutral"}>{hecho ? si : no}</StatusBadge>;
}

export function ExpedientesPage({ apiBaseUrl, token, propertyId, orgSlug }: LicitacionesShellContext) {
  const [estado, setEstado] = useState<ExpedienteEstado | "">("");
  const [pagina, setPagina] = useState(1);
  const [datos, setDatos] = useState<ExpedientesPagina | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDatos(await fetchExpedientes(fetch, apiBaseUrl, token, propertyId, { status: estado, limit: PAGE_SIZE, offset: (pagina - 1) * PAGE_SIZE }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los expedientes.");
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, token, propertyId, estado, pagina]);

  useEffect(() => {
    void load();
  }, [load]);

  const base = `/licitaciones/${orgSlug}/convocatorias`;
  return (
    <PageContainer padding="none" size="lg" className="gap-4 [&>*]:min-w-0">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground">Expedientes</h1>
        <p className="mt-1 text-sm text-muted-foreground">El avance de cada convocatoria que ya decidiste perseguir. Solo lectura: entra a una convocatoria para avanzar un paso.</p>
      </header>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="exp-estado">Estatus</Label>
          <NativeSelect
            id="exp-estado"
            value={estado}
            onChange={(e) => {
              setEstado(e.target.value as ExpedienteEstado | "");
              setPagina(1);
            }}
          >
            <option value="">Todos los activos</option>
            <option value="go">Go</option>
            <option value="in_progress">En curso</option>
            <option value="submitted">Presentadas</option>
          </NativeSelect>
        </div>
      </div>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
      {loading && !datos && <EstadoCargando etiqueta="Cargando expedientes…" />}
      {datos && datos.total === 0 && !loading && !error && <EstadoVacio mensaje="Todavía no hay convocatorias en Go, en curso o presentadas." />}

      {datos && datos.items.length > 0 && (
        <DataTable
          etiqueta="Expedientes"
          obtenerId={(f) => f.tenderId}
          filas={datos.items}
          paginacion={{ tamano: PAGE_SIZE, pagina, total: datos.total, onPaginaChange: setPagina }}
          estado={loading ? "loading" : undefined}
          columnas={[
            {
              id: "convocatoria",
              encabezado: "Convocatoria",
              principal: true,
              celda: (f) => (
                <>
                  <Link to={`${base}/${f.tenderId}`} className="font-semibold text-foreground no-underline hover:underline">
                    {f.title}
                  </Link>
                  <div className="text-xs font-normal text-muted-foreground">
                    {formatTenderStatus(f.status as never)} · {formatDeadline(f.submissionDeadline)}
                  </div>
                </>
              ),
            },
            {
              id: "requisitos",
              encabezado: "Requisitos",
              celda: (f) => (
                <Link to={`${base}/${f.tenderId}/requisitos`} className="text-foreground no-underline hover:underline">
                  {f.requisitos.cumplidos} de {f.requisitos.total}
                </Link>
              ),
            },
            {
              id: "redaccion",
              encabezado: "Redacción",
              celda: (f) => (
                <Link to={`${base}/${f.tenderId}/propuesta-tecnica`} className="no-underline">
                  <Paso hecho={f.redaccion === "hecho"} si="Con propuesta" />
                </Link>
              ),
            },
            {
              id: "checklist",
              encabezado: "Checklist",
              celda: (f) => (
                <Link to={`${base}/${f.tenderId}/cierre`} className="no-underline">
                  <StatusBadge tone={CHECKLIST[f.checklist].tono}>{CHECKLIST[f.checklist].texto}</StatusBadge>
                </Link>
              ),
            },
            { id: "aprob1", encabezado: "Aprobación 1/2", celda: (f) => <Paso hecho={f.aprobacion.tecnicaLegal} si="Aprobada" /> },
            { id: "aprob2", encabezado: "Aprobación 2/2", celda: (f) => <Paso hecho={f.aprobacion.economica} si="Aprobada" /> },
            { id: "paquete", encabezado: "Paquete", celda: (f) => <Paso hecho={f.paquete} si="Armado" /> },
            {
              id: "presentada",
              encabezado: "Presentada",
              celda: (f) => (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Paso hecho={f.presentada} si="Presentada" />
                  <Link to={`${base}/${f.tenderId}/sala-guerra`} className="text-xs text-muted-foreground hover:underline">
                    Sala de guerra
                  </Link>
                </span>
              ),
            },
          ]}
        />
      )}
    </PageContainer>
  );
}
