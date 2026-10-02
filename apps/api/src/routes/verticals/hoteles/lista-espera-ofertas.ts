// H-12 -- oferta automatica de la lista de espera tras liberar noches (cancelar una reserva o acortar fechas) y aviso al staff.
// Es una CONSECUENCIA best-effort, nunca una condicion: corre dentro de un SAVEPOINT, de modo que contra la base sin migrar (42P01
// / 42883) o ante cualquier fallo la cancelacion/el cambio de fechas ya hecho sigue valido y la transaccion compartida queda sana.
//
// Notificacion in-app `hoteles.lista_espera.disponible` (catalogo de @atiende/db): una por entrada ofrecida, dedupe por id de la
// entrada, sin PII (el texto no lleva nombre ni contacto). El envio real al huesped por WhatsApp NO esta conectado (depende de
// Meta, H-23): la oferta solo avisa al staff, que contacta a la persona.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion, runWithSavepointFallback } from "@atiende/db";
import {
  PostgresCambioFechasRepository,
  PostgresListaEsperaRepository,
  ofrecerLugaresLiberados,
  type ListaEsperaRepository,
  type CambioFechasRepository,
} from "@atiende/domain-hoteles";
import type { AppDeps } from "../../../deps.ts";

export interface LiberacionDeNoches {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  /** Noches liberadas (YYYY-MM-DD, sin orden garantizado). */
  readonly noches: readonly string[];
}

/** Ofrece las noches liberadas a la lista de espera (FIFO) y avisa al staff. Devuelve cuantas ofertas hizo; nunca lanza. */
export async function ofrecerListaEsperaTrasLiberacion(deps: AppDeps, db: TenantDbSession, lib: LiberacionDeNoches): Promise<number> {
  if (lib.noches.length === 0) return 0;
  const ordenadas = [...lib.noches].sort();
  const desde = ordenadas[0] as string;
  const hasta = nextDay(ordenadas[ordenadas.length - 1] as string);
  const lista: ListaEsperaRepository = deps.hotelesListaEsperaRepo ? deps.hotelesListaEsperaRepo(db) : new PostgresListaEsperaRepository(db);
  const fechas: CambioFechasRepository = deps.hotelesFechasRepo ? deps.hotelesFechasRepo(db) : new PostgresCambioFechasRepository(db);
  try {
    return await runWithSavepointFallback<number>({
      session: db,
      primary: async () => {
        const ahora = new Date();
        await lista.expirarVencidas(lib.propertyId, ahora);
        const ofrecidas = await ofrecerLugaresLiberados({ lista, disponibilidad: fechas, propertyId: lib.propertyId, roomTypeId: lib.roomTypeId, desde, hasta, ahora });
        for (const e of ofrecidas) {
          await emitirNotificacion(db, {
            evento: "hoteles.lista_espera.disponible",
            organizationId: lib.organizationId,
            propertyId: lib.propertyId,
            clave: e.id,
            entidadTipo: "waitlist_entry",
            entidadId: e.id,
          });
        }
        return ofrecidas.length;
      },
      isRecoverable: () => true,
      // Sin la migracion 041 o ante cualquier fallo: la cancelacion / el cambio de fechas ya hecho sigue valido.
      fallback: async () => 0,
    });
  } catch {
    return 0;
  }
}

function nextDay(date: string): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}
