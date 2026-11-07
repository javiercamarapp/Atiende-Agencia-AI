// Idiomas del agente de VOZ por sucursal: cliente del backend de #712 (migracion 181).
//   GET/PUT /v1/restaurantes/:propertyId/admin/agente/voz-idiomas
// El catalogo (lista cerrada) y el tope de adicionales vienen del servidor: aqui no se repite ninguna lista. 404/503 (API o base
// sin la funcion) y `disponible: false` (base sin la 181) son "no disponible aun", nunca un falso exito.
import { pedir, VozNoDisponibleError } from "./voz-client.ts";

export interface IdiomaVoz {
  readonly codigo: string;
  readonly nombre: string;
}

export interface ConfigIdiomasVoz {
  readonly principal: string;
  readonly adicionales: readonly string[];
  readonly deteccionAutomatica: boolean;
}

export interface IdiomasVoz {
  readonly configurado: boolean;
  readonly idiomas: ConfigIdiomasVoz;
  readonly catalogo: readonly IdiomaVoz[];
  readonly adicionalesMax: number;
}

interface IdiomasWire {
  readonly disponible?: unknown;
  readonly configurado?: unknown;
  readonly idiomas?: { readonly principal?: unknown; readonly adicionales?: unknown; readonly deteccionAutomatica?: unknown };
  readonly catalogo?: unknown;
  readonly adicionalesMax?: unknown;
}

const url = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/restaurantes/${encodeURIComponent(propertyId)}/admin/agente/voz-idiomas`;

function desdeWire(w: IdiomasWire): IdiomasVoz {
  // Base sin la migracion 181: el servidor lo dice con `disponible: false`; se trata igual que un 404/503.
  if (w.disponible !== true) throw new VozNoDisponibleError(503);
  const catalogo = Array.isArray(w.catalogo)
    ? (w.catalogo as readonly unknown[]).flatMap((i) => {
        const o = i as { codigo?: unknown; nombre?: unknown } | null;
        return o && typeof o.codigo === "string" && typeof o.nombre === "string" ? [{ codigo: o.codigo, nombre: o.nombre }] : [];
      })
    : [];
  const codigos = new Set(catalogo.map((i) => i.codigo));
  const principal = typeof w.idiomas?.principal === "string" ? w.idiomas.principal : (catalogo[0]?.codigo ?? "es-MX");
  const adicionales = Array.isArray(w.idiomas?.adicionales) ? (w.idiomas.adicionales as readonly unknown[]).filter((a): a is string => typeof a === "string" && codigos.has(a) && a !== principal) : [];
  return {
    configurado: w.configurado === true,
    idiomas: { principal, adicionales, deteccionAutomatica: w.idiomas?.deteccionAutomatica === true && adicionales.length > 0 },
    catalogo,
    adicionalesMax: typeof w.adicionalesMax === "number" && Number.isInteger(w.adicionalesMax) && w.adicionalesMax >= 0 ? w.adicionalesMax : 0,
  };
}

export async function fetchIdiomasVoz(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<IdiomasVoz> {
  return desdeWire(await pedir<IdiomasWire>(fetchImpl, url(apiBaseUrl, propertyId), token, { method: "GET" }));
}

export async function guardarIdiomasVoz(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, config: ConfigIdiomasVoz): Promise<IdiomasVoz> {
  const body = { principal: config.principal, adicionales: [...config.adicionales], deteccionAutomatica: config.deteccionAutomatica && config.adicionales.length > 0 };
  return desdeWire(await pedir<IdiomasWire>(fetchImpl, url(apiBaseUrl, propertyId), token, { method: "PUT", body }));
}

/** Cambiar el principal saca ese idioma de los adicionales (el servidor rechaza repetirlo). */
export function conPrincipal(c: ConfigIdiomasVoz, principal: string): ConfigIdiomasVoz {
  const adicionales = c.adicionales.filter((a) => a !== principal);
  return { principal, adicionales, deteccionAutomatica: c.deteccionAutomatica && adicionales.length > 0 };
}

export function conAdicional(c: ConfigIdiomasVoz, codigo: string, max: number): ConfigIdiomasVoz {
  if (codigo === c.principal || c.adicionales.includes(codigo) || c.adicionales.length >= max) return c;
  return { ...c, adicionales: [...c.adicionales, codigo] };
}

export function sinAdicional(c: ConfigIdiomasVoz, codigo: string): ConfigIdiomasVoz {
  const adicionales = c.adicionales.filter((a) => a !== codigo);
  return { ...c, adicionales, deteccionAutomatica: c.deteccionAutomatica && adicionales.length > 0 };
}

export function mismosIdiomas(a: ConfigIdiomasVoz, b: ConfigIdiomasVoz): boolean {
  return a.principal === b.principal && a.deteccionAutomatica === b.deteccionAutomatica && a.adicionales.length === b.adicionales.length && a.adicionales.every((x, i) => x === b.adicionales[i]);
}
