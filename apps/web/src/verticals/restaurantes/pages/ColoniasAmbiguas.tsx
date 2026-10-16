// Reporte de colonias ambiguas (X42, T-ZS09): por colonia, la sucursal que la cubre, los km del piloto original (o calculados), la
// segunda sucursal y la marca "revisar" cuando las dos más cercanas quedan a menos de 1 km, nadie la cubre o la asignación contradice
// la distancia. Solo lectura: lo que se cambia se cambia en las zonas de reparto de cada sucursal. Se carga bajo demanda (son ~190 filas).
import { useState } from "react";
import { Button, DataTable, EstadoCargando } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { ETIQUETA_MOTIVO_COLONIA, fetchColoniasAmbiguas } from "../lib/modelo-pm-client.ts";
import type { FilaColoniaAmbigua, ReporteColoniasAmbiguas } from "../lib/modelo-pm-client.ts";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
}

const km = (valor: number | null) => (valor === null ? "—" : `${valor.toFixed(1)} km`);

const COLUMNAS: readonly DataTableColumna<FilaColoniaAmbigua>[] = [
  { id: "colonia", encabezado: "Colonia", principal: true, celda: (f) => f.colonia, valorOrden: (f) => f.colonia },
  {
    id: "asignada",
    encabezado: "Sucursal asignada",
    celda: (f) => (f.sucursalAsignada ? `${f.sucursalAsignada.nombre}${f.variasSucursales ? " (y otras)" : ""}` : "Sin asignar"),
    valorOrden: (f) => f.sucursalAsignada?.nombre ?? "",
  },
  { id: "km", encabezado: "Km", alinear: "right", celda: (f) => km(f.kmAsignada), valorOrden: (f) => f.kmAsignada },
  { id: "segunda", encabezado: "2.ª sucursal", celda: (f) => f.segundaSucursal?.nombre ?? "—", valorOrden: (f) => f.segundaSucursal?.nombre ?? "" },
  { id: "segundaKm", encabezado: "Km 2.ª", alinear: "right", celda: (f) => km(f.segundaKm), valorOrden: (f) => f.segundaKm },
  { id: "diferencia", encabezado: "Diferencia", alinear: "right", celda: (f) => km(f.diferenciaKm), valorOrden: (f) => f.diferenciaKm },
  {
    id: "revisar",
    encabezado: "Revisar",
    celda: (f) => (f.revisar ? <span title={f.motivos.map((m) => ETIQUETA_MOTIVO_COLONIA[m]).join(". ")}>Revisar: {f.motivos.map((m) => ETIQUETA_MOTIVO_COLONIA[m]).join("; ")}</span> : "Sin alerta"),
    valorOrden: (f) => (f.revisar ? 0 : 1),
  },
];

export function ColoniasAmbiguas({ apiBaseUrl, token, propertyId }: Props) {
  const [estado, setEstado] = useState<"cerrado" | "cargando" | "error" | "ok">("cerrado");
  const [reporte, setReporte] = useState<ReporteColoniasAmbiguas | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);

  async function cargar() {
    setEstado("cargando");
    setMensaje(null);
    try {
      setReporte(await fetchColoniasAmbiguas(fetch, apiBaseUrl, token, propertyId));
      setEstado("ok");
    } catch (err) {
      setMensaje(err instanceof Error ? err.message : "No se pudo cargar el reporte de colonias.");
      setEstado("error");
    }
  }

  return (
    <section className="flex flex-col gap-2" aria-label="Colonias por revisar">
      <h3 className="m-0 text-sm font-semibold text-foreground">Colonias por revisar</h3>
      <p className="m-0 text-xs text-muted-foreground">
        Cada colonia con la sucursal que la cubre y la segunda más cercana. Se marcan para revisar las que quedan a menos de 1 km de dos sucursales, las que ninguna sucursal cubre y las que
        contradicen la distancia del piloto original. Es una propuesta: el mapa de zonas del dueño la reemplaza. Para cambiar una asignación, marque o desmarque las zonas de reparto de la sucursal.
      </p>
      {estado === "cerrado" && (
        <div>
          <Button type="button" size="sm" variant="outline" onClick={() => void cargar()}>
            Ver colonias por revisar
          </Button>
        </div>
      )}
      {estado === "cargando" && <EstadoCargando etiqueta="Cargando colonias…" />}
      {estado === "error" && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="m-0 text-xs text-destructive">
            {mensaje}
          </p>
          <div>
            <Button type="button" size="sm" variant="outline" onClick={() => void cargar()}>
              Reintentar
            </Button>
          </div>
        </div>
      )}
      {estado === "ok" && reporte && !reporte.disponible && (
        <p className="m-0 text-xs text-muted-foreground">No disponible aún: la base todavía no tiene la migración 056 (colonias sin coordenadas y su procedencia).</p>
      )}
      {estado === "ok" && reporte && reporte.disponible && (
        <>
          <p className="m-0 text-xs text-foreground">
            {reporte.total} colonias · {reporte.paraRevisar} para revisar · {reporte.sinAsignar} sin asignar · {reporte.ambiguas} ambiguas (menos de 1 km)
          </p>
          <DataTable<FilaColoniaAmbigua>
            etiqueta="Colonias por revisar"
            columnas={COLUMNAS}
            filas={reporte.filas}
            obtenerId={(f) => f.zoneId}
            vacio={{ mensaje: "Todavía no hay colonias cargadas con referencia. Se cargan con el seed de la cuenta." }}
            paginacion={{ tamano: 15 }}
            atributosFila={(f) => ({ "data-revisar": f.revisar ? "si" : "no" })}
          />
        </>
      )}
    </section>
  );
}
