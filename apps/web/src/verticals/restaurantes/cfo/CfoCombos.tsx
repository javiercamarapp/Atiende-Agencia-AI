// Analítica del dueño · pestaña Productos y combos: más vendidos con margen (solo si el producto tiene costo capturado) y pares que se piden juntos con
// soporte, confianza y lift, marcados «en el menú» o «no existe como combo» (oportunidad). Datos de `analitica_productos` (migración 161).
import { useState } from "react";
import { Boxes } from "lucide-react";
import type { ParVista, ProductoVista } from "@atiende/domain-restaurantes/analitica";
import { Callout, ChartCard, DataTable, EstadoVacio, PageContainer } from "@atiende/ui";
import { fetchProductosCombos } from "./analitica-client.ts";
import type { CfoPaginaProps } from "./contexto.ts";
import { SIN_DATO, entero, pesos, porcentaje } from "./formato.ts";
import { CargaCfoVista } from "./piezas.tsx";
import { claveCarga } from "./piezas-b.tsx";
import { SelectorSucursalAnalitica, TODAS, nombreDe } from "./piezas-analitica.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

export function CfoCombos({ api, filtros }: CfoPaginaProps) {
  const { carga, recargando, recargar } = useCargaCfo(() => fetchProductosCombos(api, filtros), [claveCarga(filtros), api.propertyId, api.token]);
  const [sel, setSel] = useState<string>(TODAS);
  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-combos">
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta="Cargando productos y combos…">
        {(v) => {
          const nombres = nombreDe(v.sucursales);
          const p = v.productos;
          const productos: ProductoVista[] = sel === TODAS ? [...p.productos].sort((a, b) => b.unidades - a.unidades) : p.productos.filter((x) => x.propertyId === sel);
          const pares: readonly ParVista[] = sel === TODAS ? p.pares : p.pares.filter((x) => x.propertyId === sel);
          if (p.productos.length === 0) return <EstadoVacio icon={Boxes} titulo="Sin ventas de productos" mensaje="Cuando haya pedidos verás aquí qué se vende más y qué se pide junto." />;
          return (
            <>
              <SelectorSucursalAnalitica nombre="analitica-combos-sucursal" sucursales={v.sucursales} valor={sel} onChange={setSel} hayTotal />
              {!p.margenDisponible && (
                <Callout tone="neutral" data-testid="combos-sin-margen">
                  Todavía no hay costos por producto: el margen aparece solo cuando el dueño captura el costo de cada producto. No se estima.
                </Callout>
              )}
              <ChartCard titulo="Más vendidos" subtitulo="Por unidades. Margen = ingreso − unidades × costo capturado" tamano="L">
                <DataTable<ProductoVista>
                  etiqueta="Productos más vendidos"
                  filas={productos}
                  obtenerId={(f) => `${f.propertyId}-${f.productoRef}`}
                  paginacion={{ tamano: 10 }}
                  vista="tabla"
                  vacio={{ mensaje: "Sin ventas de productos en este periodo." }}
                  columnas={[
                    { id: "n", encabezado: "Producto", principal: true, celda: (f) => f.nombre },
                    { id: "s", encabezado: "Sucursal", celda: (f) => nombres.get(f.propertyId) ?? SIN_DATO },
                    { id: "u", encabezado: "Unidades", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.unidades) },
                    { id: "i", encabezado: "Ingreso", alinear: "right", className: "tabular-nums", celda: (f) => pesos(f.ingresoCentavos) },
                    { id: "m", encabezado: "Margen", alinear: "right", className: "tabular-nums", celda: (f) => (f.sinCosto ? "Sin costo registrado" : pesos(f.margenCentavos)) },
                    { id: "q", encabezado: "Margen %", alinear: "right", className: "tabular-nums", celda: (f) => porcentaje(f.margenPct) },
                  ]}
                />
              </ChartCard>
              <ChartCard titulo="Combos frecuentes" subtitulo="Productos que se piden juntos (mínimo 5 pedidos). «En el menú» = hay una promoción de cortesía vigente que los une" tamano="L">
                <DataTable<ParVista>
                  etiqueta="Pares de productos más pedidos juntos"
                  filas={pares}
                  obtenerId={(f) => `${f.propertyId}-${f.productoA}-${f.productoB}`}
                  paginacion={{ tamano: 10 }}
                  vista="tabla"
                  vacio={{ mensaje: "Ningún par llega a 5 pedidos juntos en este periodo." }}
                  atributosFila={(f) => ({ "data-estado": f.estado })}
                  columnas={[
                    { id: "par", encabezado: "Par", principal: true, celda: (f) => `${f.nombreA} + ${f.nombreB}` },
                    { id: "s", encabezado: "Sucursal", celda: (f) => nombres.get(f.propertyId) ?? SIN_DATO },
                    { id: "j", encabezado: "Pedidos juntos", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.juntos) },
                    { id: "so", encabezado: "Soporte", alinear: "right", className: "tabular-nums", celda: (f) => porcentaje(f.soportePct) },
                    { id: "co", encabezado: "Confianza A→B", alinear: "right", className: "tabular-nums", celda: (f) => porcentaje(f.confianzaAB) },
                    { id: "l", encabezado: "Lift", alinear: "right", className: "tabular-nums", celda: (f) => (f.lift === null ? SIN_DATO : f.lift.toFixed(2)) },
                    { id: "e", encabezado: "Combo", celda: (f) => (f.estado === "en_menu" ? `En el menú${f.promocionCodigo ? ` (${f.promocionCodigo})` : ""}` : "No existe como combo") },
                  ]}
                />
                {p.oportunidades.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground" data-testid="combos-oportunidades">
                    {entero(p.oportunidades.length)} par(es) se piden juntos pero no existen como combo: son candidatos a una promoción. El agente solo sugiere combos que ya existen en el menú.
                  </p>
                )}
              </ChartCard>
            </>
          );
        }}
      </CargaCfoVista>
    </PageContainer>
  );
}
