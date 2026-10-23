// Cliente de `GET admin/operacion/hoy` (PLAN-PANEL-OPERADOR §2.5): la respuesta se valida contra el esquema del contrato; un formato inesperado es un
// error honesto y nunca cifras a medias.
import { esquemaOperacionHoy } from "@atiende/domain-restaurantes/operacion";
import type { OperacionHoy, TurnoHoy } from "@atiende/domain-restaurantes/operacion";
import { pedirContrato } from "./repartidor-client.ts";

export function fetchOperacionHoy(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, turno: TurnoHoy): Promise<OperacionHoy> {
  const consulta = new URLSearchParams({ propertyId, turno });
  return pedirContrato(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/operacion/hoy?${consulta.toString()}`, token, esquemaOperacionHoy);
}
