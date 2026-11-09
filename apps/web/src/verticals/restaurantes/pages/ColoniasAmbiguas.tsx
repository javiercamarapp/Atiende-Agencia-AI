// Reporte de colonias ambiguas (X42, T-ZS09): por colonia, la sucursal que la cubre, los km del piloto original (o calculados), la
// segunda sucursal y la marca "revisar" cuando las dos más cercanas quedan a menos de 1 km, nadie la cubre o la asignación contradice
// la distancia. Solo lectura: lo que se cambia se cambia en las zonas de reparto de cada sucursal. Se carga bajo demanda (son ~190 filas).
import { useState } from "react";
import { Button, DataTable, EstadoCargando, useT } from "@atiende/ui";
import type { DataTableColumna, Traductor } from "@atiende/ui";
import { restaurantesReglas } from "@atiende/ui/i18n/restaurantes/reglas";
import { ETIQUETA_MOTIVO_COLONIA, fetchColoniasAmbiguas } from "../lib/modelo-pm-client.ts";
import type { FilaColoniaAmbigua, ReporteColoniasAmbiguas } from "../lib/modelo-pm-client.ts";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
}

const km = (valor: number | null) => (valor === null ? "—" : `${valor.toFixed(1)} km`);

// Las columnas se arman con el `t` del render: encabezados y textos siguen al idioma activo.
const columnas = (t: Traductor): readonly DataTableColumna<FilaColoniaAmbigua>[] => [
  { id: "colonia", encabezado: t("restaurantes.reglas.col.colonia"), principal: true, celda: (f) => f.colonia, valorOrden: (f) => f.colonia },
  {
    id: "asignada",
    encabezado: t("restaurantes.reglas.col.asignada"),
    celda: (f) => (f.sucursalAsignada ? `${f.sucursalAsignada.nombre}${f.variasSucursales ? t("restaurantes.reglas.col.yOtras") : ""}` : t("restaurantes.reglas.col.sinAsignar")),
    valorOrden: (f) => f.sucursalAsignada?.nombre ?? "",
  },
  { id: "km", encabezado: t("restaurantes.reglas.col.km"), alinear: "right", celda: (f) => km(f.kmAsignada), valorOrden: (f) => f.kmAsignada },
  { id: "segunda", encabezado: t("restaurantes.reglas.col.segunda"), celda: (f) => f.segundaSucursal?.nombre ?? "—", valorOrden: (f) => f.segundaSucursal?.nombre ?? "" },
  { id: "segundaKm", encabezado: t("restaurantes.reglas.col.segundaKm"), alinear: "right", celda: (f) => km(f.segundaKm), valorOrden: (f) => f.segundaKm },
  { id: "diferencia", encabezado: t("restaurantes.reglas.col.diferencia"), alinear: "right", celda: (f) => km(f.diferenciaKm), valorOrden: (f) => f.diferenciaKm },
  {
    id: "revisar",
    encabezado: t("restaurantes.reglas.col.revisar"),
    celda: (f) =>
      f.revisar ? (
        <span title={f.motivos.map((m) => ETIQUETA_MOTIVO_COLONIA[m]).join(". ")}>{t("restaurantes.reglas.col.revisarMotivos", { motivos: f.motivos.map((m) => ETIQUETA_MOTIVO_COLONIA[m]).join("; ") })}</span>
      ) : (
        t("restaurantes.reglas.col.sinAlerta")
      ),
    valorOrden: (f) => (f.revisar ? 0 : 1),
  },
];

export function ColoniasAmbiguas({ apiBaseUrl, token, propertyId }: Props) {
  const t = useT(restaurantesReglas);
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
      setMensaje(err instanceof Error ? err.message : t("restaurantes.reglas.col.errorCargar"));
      setEstado("error");
    }
  }

  return (
    <section className="flex flex-col gap-2" aria-label={t("restaurantes.reglas.col.titulo")}>
      <h3 className="m-0 text-sm font-semibold text-foreground">{t("restaurantes.reglas.col.titulo")}</h3>
      <p className="m-0 text-xs text-muted-foreground">
        {t("restaurantes.reglas.col.ayuda")}
      </p>
      {estado === "cerrado" && (
        <div>
          <Button type="button" size="sm" variant="outline" onClick={() => void cargar()}>
            {t("restaurantes.reglas.col.ver")}
          </Button>
        </div>
      )}
      {estado === "cargando" && <EstadoCargando etiqueta={t("restaurantes.reglas.col.cargando")} />}
      {estado === "error" && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="m-0 text-xs text-destructive">
            {mensaje}
          </p>
          <div>
            <Button type="button" size="sm" variant="outline" onClick={() => void cargar()}>
              {t("restaurantes.reglas.col.reintentar")}
            </Button>
          </div>
        </div>
      )}
      {estado === "ok" && reporte && !reporte.disponible && (
        <p className="m-0 text-xs text-muted-foreground">{t("restaurantes.reglas.col.noDisponible")}</p>
      )}
      {estado === "ok" && reporte && reporte.disponible && (
        <>
          <p className="m-0 text-xs text-foreground">
            {t("restaurantes.reglas.col.resumen", { total: reporte.total, revisar: reporte.paraRevisar, sinAsignar: reporte.sinAsignar, ambiguas: reporte.ambiguas })}
          </p>
          <DataTable<FilaColoniaAmbigua>
            etiqueta={t("restaurantes.reglas.col.titulo")}
            columnas={columnas(t)}
            filas={reporte.filas}
            obtenerId={(f) => f.zoneId}
            vacio={{ mensaje: t("restaurantes.reglas.col.vacio") }}

            paginacion={{ tamano: 15 }}
            atributosFila={(f) => ({ "data-revisar": f.revisar ? "si" : "no" })}
          />
        </>
      )}
    </section>
  );
}
