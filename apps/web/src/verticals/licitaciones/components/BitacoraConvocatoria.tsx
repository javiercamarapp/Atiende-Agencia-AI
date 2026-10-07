// L-29 -- pestana "Bitacora" de la convocatoria: eventos reales de la convocatoria (auditoria de alta/edicion,
// sala de guerra, go/no-go, aprobaciones y presentacion) en orden temporal, con filtros por fuente y rango de
// fechas y paginacion del servidor (GET .../bitacora). Solo lectura: ningun boton escribe nada.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, DataTable, Input, Label, NativeSelect, StatusBadge } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { BITACORA_FUENTE_LABEL, fetchBitacora } from "../lib/sala-guerra-client.ts";
import type { BitacoraEvento, BitacoraFuente, BitacoraPagina } from "../lib/sala-guerra-client.ts";

const PAGE_SIZE = 25;
const FECHA = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" });

function actorTexto(e: BitacoraEvento): string {
  if (e.actor.esTuyo === true) return e.actor.rol ? `Tú (${e.actor.rol})` : "Tú";
  if (e.actor.esTuyo === false) return e.actor.rol ? `Otra persona (${e.actor.rol})` : "Otra persona del equipo";
  return e.actor.rol ?? "Sistema";
}

const COLUMNAS: readonly DataTableColumna<BitacoraEvento>[] = [
  { id: "at", encabezado: "Fecha", celda: (e) => <span className="whitespace-nowrap text-xs text-muted-foreground">{FECHA.format(new Date(e.at))}</span> },
  { id: "fuente", encabezado: "Origen", celda: (e) => <StatusBadge dot={false}>{BITACORA_FUENTE_LABEL[e.fuente]}</StatusBadge> },
  { id: "descripcion", encabezado: "Evento", principal: true, celda: (e) => <span className="whitespace-pre-line text-foreground">{e.descripcion}</span> },
  { id: "actor", encabezado: "Quién", celda: (e) => <span className="text-xs text-muted-foreground">{actorTexto(e)}</span> },
];

export interface BitacoraConvocatoriaProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly tenderId: string;
  /** L-P3-17: solo owner/admin -- enlace a la traza de punta a punta (ingesta, versiones, aprobaciones y manifiesto) en la bitacora de la organizacion. */
  readonly trazaHref?: string;
}

export function BitacoraConvocatoria({ apiBaseUrl, token, propertyId, tenderId, trazaHref }: BitacoraConvocatoriaProps) {
  const [fuente, setFuente] = useState<BitacoraFuente | "">("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<BitacoraPagina | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPage(await fetchBitacora(fetch, apiBaseUrl, token, propertyId, tenderId, { fuente, desde, hasta, limit: PAGE_SIZE, offset }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la bitácora.");
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, token, propertyId, tenderId, fuente, desde, hasta, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const cambiarFiltro = (fn: () => void) => {
    fn();
    setOffset(0);
  };
  const desdeN = page ? page.offset + 1 : 0;
  const hastaN = page ? page.offset + page.items.length : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Bitácora de la convocatoria</CardTitle>
        <CardDescription>
          Todo lo que ha pasado con esta convocatoria, del más reciente al más antiguo. Solo lectura.
          {trazaHref && (
            <>
              {" "}
              <Link to={trazaHref} className="font-semibold text-foreground hover:underline">
                Ver la traza de cambios de punta a punta
              </Link>
              .
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="bitacora-fuente">Origen</Label>
            <NativeSelect id="bitacora-fuente" size="sm" wrapperClassName="w-56" value={fuente} onChange={(e) => cambiarFiltro(() => setFuente(e.target.value as BitacoraFuente | ""))}>
              <option value="">Todos</option>
              {(Object.keys(BITACORA_FUENTE_LABEL) as BitacoraFuente[]).map((f) => (
                <option key={f} value={f}>
                  {BITACORA_FUENTE_LABEL[f]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="bitacora-desde">Desde</Label>
            <Input id="bitacora-desde" type="date" value={desde} onChange={(e) => cambiarFiltro(() => setDesde(e.target.value))} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="bitacora-hasta">Hasta</Label>
            <Input id="bitacora-hasta" type="date" value={hasta} onChange={(e) => cambiarFiltro(() => setHasta(e.target.value))} />
          </div>
          {(fuente || desde || hasta) && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setFuente("");
                setDesde("");
                setHasta("");
                setOffset(0);
              }}
            >
              Limpiar filtros
            </Button>
          )}
        </div>

        {page && !page.available && (
          <p role="status" className="text-xs text-muted-foreground">
            La sala de guerra aún no está disponible en esta base (falta la migración 029): se muestran solo los eventos de las demás fuentes.
          </p>
        )}

        <DataTable
          etiqueta="Bitácora de la convocatoria"
          columnas={COLUMNAS}
          filas={page?.items ?? []}
          obtenerId={(e) => e.id}
          estado={loading && !page ? "loading" : error && !page ? "error" : undefined}
          error={{ mensaje: error ?? undefined, onReintentar: () => void load() }}
          vacio={{ mensaje: fuente || desde || hasta ? "Ningún evento coincide con los filtros." : "Esta convocatoria todavía no tiene eventos." }}
          paginacion={false}
        />

        {error && page && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {page && page.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {desdeN}–{hastaN} de {page.total}
            </span>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" disabled={loading || page.offset === 0} onClick={() => setOffset(Math.max(0, page.offset - PAGE_SIZE))}>
                Anterior
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={loading || page.nextOffset === null} onClick={() => page.nextOffset !== null && setOffset(page.nextOffset)}>
                Siguiente
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
