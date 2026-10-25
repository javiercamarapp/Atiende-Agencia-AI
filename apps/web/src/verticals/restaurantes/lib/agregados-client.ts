// Cliente de «Agregados por validar» (migracion 099). Los TIPOS salen del contrato `@atiende/domain-restaurantes/operacion` (solo `import type`); el servidor re-valida rol
// (`pedidos.agregados`), alcance por sucursal y motivo. La idempotencia REAL la da el servidor
// (compare-and-set sobre `pendiente` + `version`: doble clic = `ya_resuelto`, nunca un segundo efecto). El helper compartido `enviar` manda un `Idempotency-Key` por costumbre
// del panel movil, pero estas rutas NO lo leen: no hay que reutilizarlo en los reintentos. Aceptar y rechazar EXIGEN la `version` de la solicitud que la persona vio: si el
// cliente pidio mas entre tanto, el servidor responde 409 `agregado_version_cambio` (o 409 `agregado_vencido` pasados 20 min) y no decide nada.
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

export function aceptarAgregado(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string, version: number, llave: string): Promise<ResolverAgregadoSalida> {
  return enviar(fetchImpl, `${base(apiBaseUrl, propertyId)}/${encodeURIComponent(id)}/aceptar`, token, "POST", { version }, llave);
}

export function rechazarAgregado(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string, version: number, entrada: RechazarAgregadoEntrada, llave: string): Promise<ResolverAgregadoSalida> {
  return enviar(fetchImpl, `${base(apiBaseUrl, propertyId)}/${encodeURIComponent(id)}/rechazar`, token, "POST", { ...entrada, version }, llave);
}
