// Repartidor sugerido: regla determinista (carga, tiempo sin recibir pedido, id estable) y alcance por sucursal.
import { describe, expect, it } from "vitest";
import { cargaDeRepartidor, sugerirRepartidor } from "../src/repartidor-sugerido.ts";
import type { CandidatoRepartidor, CargaRepartidor } from "../src/repartidor-sugerido.ts";

const SUC_A = "00000000-0000-0000-0000-00000000c0a1";
const SUC_B = "00000000-0000-0000-0000-00000000c0b2";
const ana: CandidatoRepartidor = { userId: "u-ana", nombre: "Ana", propertyIds: null };
const beto: CandidatoRepartidor = { userId: "u-beto", nombre: "Beto", propertyIds: null };
const cleo: CandidatoRepartidor = { userId: "u-cleo", nombre: "Cleo", propertyIds: [SUC_B] };

const carga = (enCamino: number, ultimaAsignacionAt: string | null): CargaRepartidor => ({ enCamino, ultimaAsignacionAt });

describe("cargaDeRepartidor", () => {
  it("cuenta solo en_camino y toma el pedido asignado mas reciente de cualquier estado", () => {
    expect(
      cargaDeRepartidor([
        { status: "en_camino", createdAt: "2026-10-04T18:00:00.000Z" },
        { status: "entregado", createdAt: "2026-10-04T19:30:00.000Z" },
        { status: "en_camino", createdAt: "2026-10-04T17:00:00.000Z" },
        { status: "preparando", createdAt: "2026-10-04T16:00:00.000Z" },
      ]),
    ).toEqual({ enCamino: 2, ultimaAsignacionAt: "2026-10-04T19:30:00.000Z" });
    expect(cargaDeRepartidor([])).toEqual({ enCamino: 0, ultimaAsignacionAt: null });
  });
});

describe("sugerirRepartidor", () => {
  it("elige al de menor carga (menos pedidos en_camino)", () => {
    const cargas = new Map([[ana.userId, carga(2, "2026-10-04T18:00:00.000Z")], [beto.userId, carga(1, "2026-10-04T19:00:00.000Z")]]);
    expect(sugerirRepartidor(SUC_A, [ana, beto], cargas)).toEqual({ repartidorId: "u-beto", nombre: "Beto", enCamino: 1 });
  });

  it("empate de carga: el que lleva mas tiempo sin recibir pedido; quien nunca recibio uno va primero", () => {
    const cargas = new Map([[ana.userId, carga(1, "2026-10-04T19:00:00.000Z")], [beto.userId, carga(1, "2026-10-04T18:00:00.000Z")]]);
    expect(sugerirRepartidor(SUC_A, [ana, beto], cargas)?.repartidorId).toBe("u-beto");
    const conNuevo = new Map([...cargas, [cleo.userId, carga(1, null)]]);
    expect(sugerirRepartidor(SUC_B, [ana, beto, cleo], conNuevo)?.repartidorId).toBe("u-cleo");
  });

  it("determinista: mismo resultado sin importar el orden de entrada; empate total desempata por id", () => {
    const cargas = new Map([[ana.userId, carga(0, null)], [beto.userId, carga(0, null)]]);
    expect(sugerirRepartidor(SUC_A, [beto, ana], cargas)?.repartidorId).toBe("u-ana");
    expect(sugerirRepartidor(SUC_A, [ana, beto], cargas)?.repartidorId).toBe("u-ana");
  });

  it("respeta el alcance por sucursal: un repartidor acotado a otra sucursal no se sugiere", () => {
    const cargas = new Map<string, CargaRepartidor>([[cleo.userId, carga(0, null)], [ana.userId, carga(5, null)]]);
    expect(sugerirRepartidor(SUC_A, [cleo, ana], cargas)?.repartidorId).toBe("u-ana");
    expect(sugerirRepartidor(SUC_A, [cleo], cargas)).toBeNull();
  });

  it("sin repartidores no hay sugerencia (nunca inventa uno)", () => {
    expect(sugerirRepartidor(SUC_A, [], new Map())).toBeNull();
  });
});
