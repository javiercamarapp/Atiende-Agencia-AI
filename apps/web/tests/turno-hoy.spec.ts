// Modelo del tablero Turno: nunca un 0 inventado, motivos honestos, alertas en rojo y canales ordenados.
import { describe, expect, it } from "vitest";
import type { OperacionHoy } from "@atiende/domain-restaurantes/operacion";
import { alertasTurno, canalesTurno, etiquetaCorte, tarjetasTurno } from "../src/verticals/restaurantes/lib/turno-hoy.ts";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function hoy(p: Partial<OperacionHoy> = {}): OperacionHoy {
  return {
    corte: { desde: "2026-10-21T18:00:00.000Z", hasta: "2026-10-22T06:00:00.000Z" },
    pedidos: { total: 23, porEstado: { pending: 2, preparando: 5, en_camino: 3, entregado: 11, cancelado: 1, problema: 1 } },
    ventas: 16300, ticketPromedio: 708,
    puntuales: { pct: 91, evaluados: 20, umbralMin: { domicilio: 65, recoger: 35 } },
    tiempos: { preparacionMinProm: 14, entregaMinProm: 31, entregaMinP90: 48 },
    cancelados: { total: 1, porMotivo: { cliente_cancelo: 1 } },
    porCanal: { whatsapp: 9, voz: 4, llamada: 7, mostrador: 2, web: 1 },
    alertas: { sinAceptar: [{ pedidoId: U(1), numero: 150, minutos: 6 }], enCaminoMas90: [{ pedidoId: U(2), numero: 141, minutos: 104 }, { pedidoId: U(3), numero: 142, minutos: 80 }] },
    efectivoPorChofer: { disponible: true, choferes: [{ repartidorId: U(4), nombre: "Luis", entregas: 6, efectivoPorEntregar: 3120 }, { repartidorId: U(5), nombre: "Pedro", entregas: 9, efectivoPorEntregar: 100 }] },
    actualizadoEn: "2026-10-21T20:41:00.000Z",
    ...p,
  };
}
const t = (h: OperacionHoy, k: string) => tarjetasTurno(h).find((x) => x.clave === k)!;

describe("tarjetasTurno", () => {
  it("con datos completos da cifras reales y el chofer con mas entregas", () => {
    const h = hoy();
    expect(t(h, "pedidos")).toMatchObject({ value: "23", nota: "10 en curso" });
    expect(t(h, "ventas").value).toBe("$16,300.00");
    expect(t(h, "puntuales")).toMatchObject({ value: "91%", nota: "20 entregas evaluadas · 65/35 min" });
    expect(t(h, "entrega").value).toBe("31 min");
    expect(t(h, "choferTop")).toMatchObject({ value: "Pedro", nota: "9 entregas" });
    expect(t(h, "cancelados").value).toBe("1");
  });

  it("base sin migrar: tiempos null y efectivo no disponible quedan en «—» con motivo, jamas 0", () => {
    const h = hoy({ tiempos: { preparacionMinProm: null, entregaMinProm: null, entregaMinP90: null }, efectivoPorChofer: { disponible: false, choferes: [] } });
    expect(t(h, "entrega")).toMatchObject({ value: "—" });
    expect(t(h, "entrega").sinDato).toContain("Disponible tras actualizar");
    expect(t(h, "choferTop").sinDato).toContain("Disponible tras actualizar");
  });

  it("entrega promedio sin dato distingue «sin entregas en el corte» de «falta la hora de salida»", () => {
    const sinTiempos = { preparacionMinProm: null, entregaMinProm: null, entregaMinP90: null };
    const sinEntregas = hoy({ tiempos: sinTiempos, pedidos: { total: 3, porEstado: { pending: 3 } } });
    expect(t(sinEntregas, "entrega").sinDato).toBe("Aún no hay entregas en este corte.");
    const faltaSalida = hoy({ tiempos: sinTiempos }); // hay 11 entregados pero sin hora de salida
    expect(t(faltaSalida, "entrega").sinDato).toContain("falta registrar la hora de salida");
  });

  it("sin pedidos: ventas y ticket sin dato (no $0.00), cancelados si es un 0 medido", () => {
    const h = hoy({ pedidos: { total: 0, porEstado: {} }, ventas: 0, ticketPromedio: 0, puntuales: { pct: null, evaluados: 0, umbralMin: { domicilio: 65, recoger: 35 } }, cancelados: { total: 0, porMotivo: {} } });
    expect(t(h, "ventas").sinDato).toBeDefined();
    expect(t(h, "ticket").sinDato).toBeDefined();
    expect(t(h, "puntuales").sinDato).toBeDefined();
    expect(t(h, "cancelados")).toMatchObject({ value: "0", nota: "Sin cancelaciones" });
  });

  it("hora pico siempre explica por que no hay cifra (el contrato aun no la trae)", () => {
    expect(t(hoy(), "horaPico").sinDato).toContain("todavía no calcula");
  });
});

describe("canalesTurno y alertasTurno", () => {
  it("ordena canales de mayor a menor con su porcentaje y omite los vacios", () => {
    const c = canalesTurno({ whatsapp: 9, llamada: 7, web: 0, voz: 4 });
    expect(c.map((x) => x.etiqueta)).toEqual(["WhatsApp", "Llamada", "Voz"]);
    expect(c[0]!.porcentaje).toBe(45);
    expect(canalesTurno({})).toEqual([]);
  });

  it("solo es critica (roja) la de mas de 90 min; van primero", () => {
    const a = alertasTurno(hoy().alertas);
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ critica: true, texto: "#141 lleva 104 min en camino" });
    expect(a[1]).toMatchObject({ critica: false, texto: "#150 sin aceptar hace 6 min" });
  });
});

describe("etiquetaCorte (zona del negocio)", () => {
  // 2026-10-22T00:00Z = 21 oct 6:00 p.m. en Merida (UTC-6); 08:00Z = 2:00 a.m. del 22. Debe salir igual sin importar la zona del navegador.
  const corte = { desde: "2026-10-22T00:00:00.000Z", hasta: "2026-10-22T08:00:00.000Z" };
  it("muestra la fecha y la hora en America/Merida y lo dice", () => {
    const e = etiquetaCorte(corte);
    expect(e).toContain("21 oct 2026");
    expect(e).toMatch(/6:00\s*p\.\s*m\./);
    expect(e).toMatch(/2:00\s*a\.\s*m\./);
    expect(e).toContain("hora de Mérida");
  });
  it("no depende de la zona del proceso", () => {
    const original = process.env.TZ;
    try {
      const resultados = ["Asia/Tokyo", "America/Los_Angeles", "UTC"].map((tz) => {
        process.env.TZ = tz;
        return etiquetaCorte(corte);
      });
      expect(new Set(resultados).size).toBe(1);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});
