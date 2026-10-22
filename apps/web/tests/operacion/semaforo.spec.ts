import { describe, expect, it } from "vitest";
import { MAX_PEDIDOS_POR_VIAJE, MINUTOS_A_TIEMPO, SEMAFORO_EN_CAMINO_ROJO_MIN, SEMAFORO_FRACCION_AMARILLO } from "@atiende/domain-restaurantes/operacion";
import { EN_CAMINO_ROJO_MIN, FRACCION_AMARILLO, MINUTOS_PROMETIDOS, minutosDesde, semaforoPedido, textoMinutos } from "../../src/verticals/restaurantes/lib/semaforo.ts";

describe("semaforo del panel del operador", () => {
  it("las constantes locales coinciden con las del contrato", () => {
    expect(MINUTOS_PROMETIDOS).toEqual(MINUTOS_A_TIEMPO);
    expect(FRACCION_AMARILLO).toBe(SEMAFORO_FRACCION_AMARILLO);
    expect(EN_CAMINO_ROJO_MIN).toBe(SEMAFORO_EN_CAMINO_ROJO_MIN);
    expect(MAX_PEDIDOS_POR_VIAJE).toBe(6);
  });

  it("domicilio: verde bajo 70 % de 65 (45.5 min), amarillo hasta 65, rojo despues", () => {
    expect(semaforoPedido("preparando", "domicilio", 0)).toBe("verde");
    expect(semaforoPedido("preparando", "domicilio", 45)).toBe("verde");
    expect(semaforoPedido("preparando", "domicilio", 46)).toBe("amarillo");
    expect(semaforoPedido("preparando", "domicilio", 65)).toBe("amarillo");
    expect(semaforoPedido("preparando", "domicilio", 66)).toBe("rojo");
  });

  it("recoger: 35 min prometidos (verde bajo 24.5, amarillo hasta 35, rojo despues)", () => {
    expect(semaforoPedido("listo_para_recoger", "recoger", 24)).toBe("verde");
    expect(semaforoPedido("listo_para_recoger", "recoger", 25)).toBe("amarillo");
    expect(semaforoPedido("listo_para_recoger", "recoger", 35)).toBe("amarillo");
    expect(semaforoPedido("listo_para_recoger", "recoger", 36)).toBe("rojo");
  });

  it("sin aceptar: amarillo pasados 3 min y rojo pasados 5, aunque falte mucho para el prometido", () => {
    expect(semaforoPedido("pending", "domicilio", 3)).toBe("verde");
    expect(semaforoPedido("pending", "domicilio", 4)).toBe("amarillo");
    expect(semaforoPedido("pending", "domicilio", 5)).toBe("amarillo");
    expect(semaforoPedido("pending", "domicilio", 6)).toBe("rojo");
  });

  it("en camino: rojo a los 90 min", () => {
    expect(semaforoPedido("en_camino", "domicilio", 20)).toBe("verde");
    expect(semaforoPedido("en_camino", "domicilio", 60)).toBe("amarillo");
    expect(semaforoPedido("en_camino", "domicilio", 89)).toBe("amarillo");
    expect(semaforoPedido("en_camino", "domicilio", 90)).toBe("rojo");
  });

  it("minutosDesde nunca es negativo y tolera fechas invalidas", () => {
    const ahora = Date.parse("2026-10-21T20:00:00Z");
    expect(minutosDesde("2026-10-21T19:48:30Z", ahora)).toBe(11);
    expect(minutosDesde("2026-10-21T20:10:00Z", ahora)).toBe(0);
    expect(minutosDesde("no-es-fecha", ahora)).toBe(0);
    expect(minutosDesde(null, ahora)).toBe(0);
  });

  it("textoMinutos", () => {
    expect(textoMinutos(7)).toBe("7 min");
    expect(textoMinutos(65)).toBe("1 h 05 min");
  });
});
