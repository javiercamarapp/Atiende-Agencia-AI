// Tope por IP ANTES de resolver la organizacion o autenticar (QA R1 seguridad-05/09).
//
// Problema que resuelve: el contador de `consumeRateLimit` vive en la transaccion de la request. Cuando el handler lanza un
// error de cliente (slug inexistente 404, token invalido 404, conflicto 409) la transaccion se revierte y el intento no
// cuenta; ademas el limite por organizacion solo se evaluaba DESPUES de resolverla. Aqui el contador se consume en su PROPIA
// transaccion (sesion de sistema abierta y cerrada ANTES de la sesion del handler, nunca anidada), asi queda confirmado aunque
// despues el handler falle, y cuenta todo intento por igual.
import type { Context } from "hono";
import { consumeRateLimit } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { requestActor } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

/** Consume 1 del bucket (scope, IP) en una transaccion propia; lanza 429 (despues de confirmar el contador) al rebasar `max`. */
export async function edgeRateLimit(deps: AppDeps, c: Context, scope: string, max: number, windowSeconds = 60): Promise<void> {
  const allowed = await deps.engine.withAppSession({ userId: null }, async (db) => {
    const repo = deps.restaurantesRepo(db);
    return (await consumeRateLimit(repo, scope, requestActor(c.req.raw, ""), max, windowSeconds)).allowed;
  });
  if (!allowed) throw Errors.tooManyRequests();
}
