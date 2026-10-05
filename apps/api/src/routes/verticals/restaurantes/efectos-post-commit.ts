// Efectos externos de un pedido recien creado (correo de confirmacion y comanda al POS), DESPUES del COMMIT.
//
// Hasta ahora el checkout publico (storefront.ts y public.ts) los ejecutaba DENTRO de la transaccion del request: si el COMMIT
// no llegaba (corte de conexion, timeout de la funcion), el cliente recibia un error y reintentaba, pero el correo y la comanda del
// pedido inexistente ya habian salido (y el reintento creaba otro pedido con otra llave de comanda). Ahora la transaccion solo
// ENCOLA (el correo en `messaging_outbox`, la comanda en el outbox del POS con `envioEnLinea: false`) y este modulo drena y envia
// en una sesion de sistema NUEVA, ya confirmado el pedido.
//
// Todo es best-effort y nunca lanza: lo encolado queda en el outbox y lo recogen el despachador del POS y el cron de correo. Lo que
// el cliente ve de la comanda es el estado REAL (el agente solo puede decir un folio que el POS devolvio).
import { enviarComandaEncolada, respuestaAgenteComanda, type ResultadoEncolarPedido } from "@atiende/domain-restaurantes/softrestaurant";
import type { AppDeps } from "../../../deps.ts";
import { triggerRestaurantesEmailDispatchInline } from "./email-dispatch.ts";
import { softRestaurantComandaDeps } from "./softrestaurant-wiring.ts";

export interface ComandaVisible {
  readonly estado: string;
  readonly folio: string | null;
  readonly mensaje: string;
}

export async function efectosPostCommitDePedido(deps: AppDeps, encolada: ResultadoEncolarPedido): Promise<ComandaVisible | null> {
  // Lo que se le diria al cliente si esta fase falla por completo: la comanda sigue encolada, "pendiente de confirmar".
  const pendiente: ComandaVisible | null = encolada.modo === "activo" ? respuestaAgenteComanda(encolada.fila) : null;
  try {
    return await deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      await triggerRestaurantesEmailDispatchInline(deps, db, repo);
      if (encolada.modo !== "activo" || encolada.fila === null) return pendiente;
      const r = await enviarComandaEncolada(softRestaurantComandaDeps(deps, db, repo), encolada.fila);
      return { estado: r.agente.estado, folio: r.agente.folio, mensaje: r.agente.mensaje };
    });
  } catch (err) {
    console.error("restaurantes: efectos posteriores al COMMIT del pedido fallaron (quedan encolados para el despachador/cron):", err instanceof Error ? err.message : err);
    return pendiente;
  }
}
