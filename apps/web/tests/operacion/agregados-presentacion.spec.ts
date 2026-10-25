import { describe, expect, it } from "vitest";
import type { TarjetaAgregado } from "@atiende/domain-restaurantes/operacion";
import { colorCronometro, enlaceLlamar, enlaceWhatsapp, nivelDeSegundos, ordenarAgregados, segundosVivos, textoCronometro, textoPendientes, tituloConPendientes } from "../../src/verticals/restaurantes/lib/agregados-presentacion.ts";

const t = (id: string, estado: TarjetaAgregado["estado"], solicitadoEn: string, resueltoEn: string | null = null) => ({ id, estado, solicitadoEn, resueltoEn, sla: { segundosEspera: 30, nivel: "en_tiempo", segundosParaSiguienteUmbral: 570 } }) as unknown as TarjetaAgregado;

describe("cronometro y SLA de 10/20 minutos", () => {
  it("texto, color y nivel", () => {
    expect(textoCronometro(45)).toBe("Hace 45 s");
    expect(textoCronometro(130)).toBe("Hace 2 min 10 s");
    expect(textoCronometro(3900)).toBe("Hace 1 h 5 min");
    expect(colorCronometro(299)).toBe("verde");
    expect(colorCronometro(300)).toBe("ambar");
    expect(colorCronometro(600)).toBe("rojo");
    expect(nivelDeSegundos(599)).toBe("en_tiempo");
    expect(nivelDeSegundos(600)).toBe("sin_respuesta");
    expect(nivelDeSegundos(1200)).toBe("vencido");
  });
  it("segundos vivos: suma lo transcurrido en este telefono solo si sigue pendiente", () => {
    expect(segundosVivos(t("a", "pendiente", ""), 1000, 31_000)).toBe(60);
    expect(segundosVivos(t("a", "aceptado", ""), 1000, 31_000)).toBe(30);
  });
});

describe("orden y contacto", () => {
  it("pendientes primero y la mas antigua arriba; resueltas, la mas reciente primero", () => {
    const o = ordenarAgregados([t("r1", "aceptado", "2026-10-24T10:00:00Z", "2026-10-24T10:05:00Z"), t("p2", "pendiente", "2026-10-24T11:00:00Z"), t("p1", "pendiente", "2026-10-24T09:00:00Z"), t("r2", "rechazado", "2026-10-24T10:00:00Z", "2026-10-24T10:30:00Z")]);
    expect(o.map((x) => x.id)).toEqual(["p1", "p2", "r2", "r1"]);
  });
  it("enlaces de llamada y WhatsApp solo con numero utilizable", () => {
    expect(enlaceLlamar("9995550101")).toBe("tel:+529995550101");
    expect(enlaceWhatsapp("+52 999 555 0101")).toBe("https://wa.me/529995550101");
    expect(enlaceLlamar(null)).toBeNull();
    expect(enlaceWhatsapp("123")).toBeNull();
  });
  it("titulo parpadeante y plural", () => {
    expect(tituloConPendientes("Panel", 2, true)).toBe("(2) Agregado por validar");
    expect(tituloConPendientes("Panel", 2, false)).toBe("Panel");
    expect(tituloConPendientes("Panel", 0, true)).toBe("Panel");
    expect(textoPendientes(1)).toBe("1 agregado por validar");
    expect(textoPendientes(3)).toBe("3 agregados por validar");
  });
});
