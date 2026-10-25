// Cliente de «Agregados por validar» (migracion 097). Los TIPOS salen del contrato `@atiende/domain-restaurantes/operacion` (solo `import type`); el servidor re-valida rol
// (`pedidos.agregados`), alcance por sucursal y motivo. Toda escritura lleva `Idempotency-Key`: el llamador reutiliza UNA llave por intento y el servidor ademas hace
// compare-and-set (doble clic = `ya_resuelto`, nunca un segundo efecto).
import type { ListaAgregados, RechazarAgregadoEntrada, ResolverAgregadoSalida } from "@atiende/domain-restaurantes/operacion";
import { enviar, leer } from "./operacion-client.ts";

export type EstadoLista = "pendientes" | "recientes";

function base(apiBaseUrl: string, propertyId: string): string {
  return `${apiBaseUrl}/v1/restaurantes/${encodeURIComponent(propertyId)}/admin/agregados`;
}

export function fetchAgregados(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, estado: EstadoLista = "pendientes"): Promise<ListaAgregados> {
  return leer<ListaAgregados>(fetchImpl, `${base(apiBaseUrl, propertyId)}?estado=${estado}`, token);
}

export function marcarAgregadoVisto(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string, llave: string): Promise<{ readonly ok: boolean }> {
  return enviar(fetchImpl, `${base(apiBaseUrl, propertyId)}/${encodeURIComponent(id)}/visto`, token, "POST", {}, llave);
}

export function aceptarAgregado(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string, llave: string): Promise<ResolverAgregadoSalida> {
  return enviar(fetchImpl, `${base(apiBaseUrl, propertyId)}/${encodeURIComponent(id)}/aceptar`, token, "POST", {}, llave);
}

export function rechazarAgregado(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string, entrada: RechazarAgregadoEntrada, llave: string): Promise<ResolverAgregadoSalida> {
  return enviar(fetchImpl, `${base(apiBaseUrl, propertyId)}/${encodeURIComponent(id)}/rechazar`, token, "POST", entrada, llave);
}
