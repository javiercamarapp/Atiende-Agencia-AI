// Analítica del dueño · pestaña Zonas: ventas y tiempo de entrega REAL por colonia (mapa de calor por intensidad + tabla). Colonias con menos de 5 pedidos o
// 5 clientes se agrupan en «(otras)»; lo que no se puede ubicar es «sin colonia / recoge». Sin direcciones ni clientes. Datos de `analitica_zonas` (160).
// No hay mapa geográfico: el repo no guarda coordenadas por colonia; la intensidad es relativa a la colonia con más pedidos de la sucursal.
import { useState } from "react";
import { MapPinned, ShieldCheck } from "lucide-react";
import type { ZonaVista } from "@atiende/domain-restaurantes/analitica";
import { Callout, ChartCard, DataTable, EstadoVacio, PageContainer, RankingBarras } from "@atiende/ui";
import { fetchZonas } from "./analitica-client.ts";
import type { CfoPaginaProps } from "./contexto.ts";
import { SIN_DATO, entero, minutos, pesos, porcentaje } from "./formato.ts";
import { CargaCfoVista } from "./piezas.tsx";
import { claveCarga } from "./piezas-b.tsx";
import { SelectorSucursalAnalitica, TODAS, nombreDe } from "./piezas-analitica.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

/** Relleno del mosaico: tono primario con opacidad proporcional a la intensidad (0 = sin relleno). Clases fijas (sin estilos inventados). */
const CLASE_INTENSIDAD = ["bg-primary/5", "bg-primary/10", "bg-primary/20", "bg-primary/30", "bg-primary/40", "bg-primary/60"] as const;
export const claseIntensidad = (i: number): string => CLASE_INTENSIDAD[Math.min(CLASE_INTENSIDAD.length - 1, Math.max(0, Math.floor(i * CLASE_INTENSIDAD.length)))] ?? "bg-primary/5";

export function CfoZonas({ api, filtros }: CfoPaginaProps) {
  const { carga, recargando, recargar } = useCargaCfo(() => fetchZonas(api, filtros), [claveCarga(filtros), api.propertyId, api.token]);
  const [sel, setSel] = useState<string>(TODAS);
  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-zonas">
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta="Cargando las zonas…">
        {(v) => {
          const nombres = nombreDe(v.sucursales);
          const filas: readonly ZonaVista[] = sel === TODAS ? v.zonas : v.zonas.filter((z) => z.propertyId === sel);
          if (v.zonas.length === 0) return <EstadoVacio icon={MapPinned} titulo="Sin pedidos por zona" mensaje="Cuando haya pedidos verás aquí en qué colonias vendes y cuánto tarda la entrega." />;
          const ubicables = filas.filter((z) => !z.sinColonia && !z.esOtras);
          return (
            <>
              <Callout tone="info" data-testid="zonas-privacidad" icon={<ShieldCheck className="size-4" aria-hidden="true" />}>
                Por privacidad, las colonias con menos de {v.k} pedidos o {v.k} clientes se agrupan en «(otras)». Nunca se muestran direcciones. «Sin colonia / recoge» junta los pedidos para recoger y los domicilios cuya colonia no se conoce.
              </Callout>
              <SelectorSucursalAnalitica nombre="analitica-zonas-sucursal" sucursales={v.sucursales} valor={sel} onChange={setSel} hayTotal />
              <ChartCard titulo="Dónde se vende" subtitulo="Intensidad por colonia: más oscuro = más pedidos (relativo a la colonia líder de cada sucursal)" tamano="L">
                {ubicables.length === 0 ? (
                  <p role="status" className="py-6 text-center text-xs text-faint">Ninguna colonia llega al mínimo de {v.k} pedidos y {v.k} clientes en este periodo.</p>
                ) : (
                  <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" data-testid="zonas-mosaico">
                    {ubicables.map((z) => (
                      <li key={`${z.propertyId}-${z.colonia}`} className={`rounded-lg border border-border p-2 text-xs ${claseIntensidad(z.intensidad)}`} data-colonia={z.colonia}>
                        <p className="font-medium">{z.colonia}</p>
                        <p className="tabular-nums text-muted-foreground">{entero(z.pedidos)} pedidos · {pesos(z.netaCentavos)}</p>
                        <p className="tabular-nums text-muted-foreground">Entrega {minutos(z.medianaMin)}</p>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-3">
                  <RankingBarras filas={ubicables.slice(0, 8).map((z) => ({ id: `${z.propertyId}-${z.colonia}`, etiqueta: z.colonia, valor: z.pedidos }))} formato={entero} sinDatos="Sin colonias para ordenar" />
                </div>
              </ChartCard>
              <ChartCard titulo="Venta y tiempo de entrega por colonia" subtitulo="Tiempo real = de que entra el pedido a que se entrega; solo domicilios entregados. Los que no se cerraron se cuentan aparte" tamano="L">
                <DataTable<ZonaVista>
                  etiqueta="Colonias con venta y tiempo de entrega"
                  filas={filas}
                  obtenerId={(f) => `${f.propertyId}-${f.colonia}`}
                  paginacion={{ tamano: 12 }}
                  vista="tabla"
                  vacio={{ mensaje: "Sin pedidos en este periodo." }}
                  atributosFila={(f) => ({ "data-colonia": f.colonia })}
                  columnas={[
                    { id: "c", encabezado: "Colonia", principal: true, celda: (f) => (f.sinColonia ? "Sin colonia / recoge" : f.colonia) },
                    { id: "s", encabezado: "Sucursal", celda: (f) => nombres.get(f.propertyId) ?? SIN_DATO },
                    { id: "p", encabezado: "Pedidos", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.pedidos) },
                    { id: "v", encabezado: "Venta", alinear: "right", className: "tabular-nums", celda: (f) => pesos(f.netaCentavos) },
                    { id: "t", encabezado: "Ticket", alinear: "right", className: "tabular-nums", celda: (f) => pesos(f.ticketCentavos) },
                    { id: "m", encabezado: "Entrega (mediana)", alinear: "right", className: "tabular-nums", celda: (f) => minutos(f.medianaMin) },
                    { id: "q", encabezado: "Entrega (p90)", alinear: "right", className: "tabular-nums", celda: (f) => minutos(f.p90Min) },
                    { id: "g", encabezado: "Más de 60 min", alinear: "right", className: "tabular-nums", celda: (f) => porcentaje(f.pctMasDe60) },
                    { id: "n", encabezado: "Sin cierre", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.sinCierre) },
                  ]}
                />
              </ChartCard>
            </>
          );
        }}
      </CargaCfoVista>
    </PageContainer>
  );
}
