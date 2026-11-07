// Analítica del dueño · ZONAS (puro). La base ya agrupa con k-anonimato (>= 5 pedidos y >= 5 clientes); aquí se vuelve a aplicar como defensa en
// profundidad (una colonia chica que llegara con nombre se junta en «(otras)» y pierde sus percentiles, que no se pueden recomponer) y se calcula la
// intensidad del mapa de calor. «sin colonia / recoge» nunca se oculta: es la parte de la demanda que no se puede ubicar.
import { pct } from "./ratios.ts";
import { ETIQUETA_OTRAS, ETIQUETA_SIN_COLONIA, K_ZONAS, type ZonaCruda } from "./tipos.ts";

export interface ZonaVista {
  readonly propertyId: string;
  readonly colonia: string;
  readonly esOtras: boolean;
  readonly sinColonia: boolean;
  readonly pedidos: number;
  readonly domicilios: number;
  readonly recogidas: number;
  readonly netaCentavos: number;
  readonly ticketCentavos: number | null;
  readonly clientes: number;
  readonly entregados: number;
  readonly sinCierre: number;
  readonly medianaMin: number | null;
  readonly p90Min: number | null;
  readonly masDe60: number;
  readonly pctMasDe60: number | null;
  /** 0..1 respecto de la colonia con más pedidos de su sucursal (para el mapa de calor). */
  readonly intensidad: number;
}

export function construirZonas(filas: readonly ZonaCruda[], k: number = K_ZONAS): ZonaVista[] {
  const minimo = Math.max(k, K_ZONAS);
  const fusionadas: ZonaCruda[] = [];
  const otras = new Map<string, { z: ZonaCruda; recompone: boolean }>();
  for (const z of filas) {
    const protegida = z.colonia === ETIQUETA_OTRAS || z.colonia === ETIQUETA_SIN_COLONIA;
    if (protegida || z.pedidos >= minimo) {
      if (z.colonia === ETIQUETA_OTRAS) {
        // La base ya trae «(otras)»: se junta con las que esta capa agregue sin inventar percentiles.
        const prev = otras.get(z.propertyId);
        otras.set(z.propertyId, { z: prev ? sumar(prev.z, z) : z, recompone: prev !== undefined });
      } else fusionadas.push(z);
      continue;
    }
    const prev = otras.get(z.propertyId);
    otras.set(z.propertyId, { z: prev ? sumar(prev.z, { ...z, colonia: ETIQUETA_OTRAS }) : { ...z, colonia: ETIQUETA_OTRAS }, recompone: true });
  }
  for (const { z, recompone } of otras.values()) fusionadas.push(recompone ? { ...z, medianaMin: null, p90Min: null } : z);

  const maxPorSucursal = new Map<string, number>();
  for (const z of fusionadas) maxPorSucursal.set(z.propertyId, Math.max(maxPorSucursal.get(z.propertyId) ?? 0, z.colonia === ETIQUETA_SIN_COLONIA || z.colonia === ETIQUETA_OTRAS ? 0 : z.pedidos));
  return fusionadas
    .map((z): ZonaVista => {
      const max = maxPorSucursal.get(z.propertyId) ?? 0;
      const referencia = z.colonia === ETIQUETA_SIN_COLONIA || z.colonia === ETIQUETA_OTRAS;
      return {
        propertyId: z.propertyId,
        colonia: z.colonia,
        esOtras: z.colonia === ETIQUETA_OTRAS,
        sinColonia: z.colonia === ETIQUETA_SIN_COLONIA,
        pedidos: z.pedidos,
        domicilios: z.domicilios,
        recogidas: z.recogidas,
        netaCentavos: z.netaCentavos,
        ticketCentavos: z.pedidos > 0 ? Math.round(z.netaCentavos / z.pedidos) : null,
        clientes: z.clientes,
        entregados: z.entregados,
        sinCierre: z.sinCierre,
        medianaMin: z.medianaMin,
        p90Min: z.p90Min,
        masDe60: z.masDe60,
        pctMasDe60: pct(z.masDe60, z.entregados),
        intensidad: referencia || max === 0 ? 0 : Math.round((z.pedidos / max) * 100) / 100,
      };
    })
    .sort((a, b) => (a.propertyId < b.propertyId ? -1 : a.propertyId > b.propertyId ? 1 : 0) || b.pedidos - a.pedidos || (a.colonia < b.colonia ? -1 : 1));
}

function sumar(a: ZonaCruda, b: ZonaCruda): ZonaCruda {
  return {
    propertyId: a.propertyId,
    colonia: a.colonia,
    pedidos: a.pedidos + b.pedidos,
    domicilios: a.domicilios + b.domicilios,
    recogidas: a.recogidas + b.recogidas,
    netaCentavos: a.netaCentavos + b.netaCentavos,
    // Clientes distintos no se suman (podrían repetirse): cota superior honesta.
    clientes: a.clientes + b.clientes,
    entregados: a.entregados + b.entregados,
    sinCierre: a.sinCierre + b.sinCierre,
    medianaMin: null,
    p90Min: null,
    masDe60: a.masDe60 + b.masDe60,
  };
}
