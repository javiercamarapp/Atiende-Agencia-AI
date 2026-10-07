// QA-PM-R2: con el cliente de nuevo visible (migracion 071) el agente lee su pedido reciente en CADA turno. Las dos lecturas de apoyo (zona horaria y datos de recogida)
// corren cada una en su SAVEPOINT sobre la MISMA sesion: lanzadas en paralelo, el RELEASE de una liberaba el de la otra y el webhook respondia 500.
import { describe, expect, it } from "vitest";
import { buscarPedidoReciente } from "../src/pedido-reciente.ts";
import type { RestaurantesRepository } from "../src/repository.ts";

describe("buscarPedidoReciente: lecturas de apoyo en serie", () => {
  it("nunca tiene dos lecturas de la sesion en vuelo a la vez", async () => {
    let enVuelo = 0;
    let maxEnVuelo = 0;
    const lectura = async <T>(valor: T): Promise<T> => {
      enVuelo += 1;
      maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
      await new Promise((r) => setTimeout(r, 5));
      enVuelo -= 1;
      return valor;
    };
    const ahora = new Date("2026-10-06T19:10:00.000Z");
    const repo = {
      findLatestOrderByPhone: async () => ({ id: "o1", propertyId: "p1", status: "preparando", branch: "García Lavín", createdAt: "2026-10-06T19:00:00.000Z" }),
      findBranchZonaHoraria: () => lectura({ zonaHoraria: "America/Merida" }),
      listOrderPickupInfo: () => lectura([{ orderId: "o1", canal: "recoger" as const, propina: null, horaRecogida: null }]),
    } as unknown as RestaurantesRepository;
    const r = await buscarPedidoReciente(repo, "org", "9991234567", ahora);
    expect(r).toMatchObject({ canal: "recoger", sucursal: "García Lavín", minutosDesdeConfirmacion: 10 });
    expect(maxEnVuelo).toBe(1);
  });
});
