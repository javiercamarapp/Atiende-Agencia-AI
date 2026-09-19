// Motor puro de derivación de cadencia -- ver `../src/salud/cadencia.ts`.
// Casos límite: expresión no soportada -> 0 (nunca inventa un número),
// diario/horario/cada-N-minutos, y que `cadenciaMinutosPorRuta()` cubra
// realmente los 19 crons declarados en vercel.json (falla si alguien agrega
// un cron a vercel.json sin que este módulo sepa derivar su cadencia, o si
// alguien borra un cron de vercel.json sin darse cuenta).
import { describe, expect, it } from "vitest";
import { cadenciaMinutosPorRuta, minutosEsperadosDeCron, rutasDeCronDeclaradas } from "../src/salud/cadencia.ts";

describe("minutosEsperadosDeCron", () => {
  it("minuto y hora fijos ('0 5 * * *') -> diario, 1440 min", () => {
    expect(minutosEsperadosDeCron("0 5 * * *")).toBe(24 * 60);
  });

  it("hora comodín con minuto fijo ('30 * * * *') -> cada hora, 60 min", () => {
    expect(minutosEsperadosDeCron("30 * * * *")).toBe(60);
  });

  it("step de minuto con hora comodín ('*/15 * * * *') -> cada 15 min", () => {
    expect(minutosEsperadosDeCron("*/15 * * * *")).toBe(15);
  });

  it("step de hora con minuto fijo ('0 */6 * * *') -> cada 6 horas, 360 min", () => {
    expect(minutosEsperadosDeCron("0 */6 * * *")).toBe(360);
  });

  it("día-mes/mes/día-semana distinto de '*' -> 0 (fuera de alcance soportado, nunca inventa)", () => {
    expect(minutosEsperadosDeCron("0 5 * * 1")).toBe(0);
    expect(minutosEsperadosDeCron("0 5 1 * *")).toBe(0);
  });

  it("lista o rango en minuto/hora -> 0 (no soportado, nunca un número inventado)", () => {
    expect(minutosEsperadosDeCron("0,30 5 * * *")).toBe(0);
    expect(minutosEsperadosDeCron("0 5-7 * * *")).toBe(0);
  });

  it("expresión mal formada (número de campos distinto de 5) -> 0", () => {
    expect(minutosEsperadosDeCron("* * *")).toBe(0);
  });
});

describe("cadenciaMinutosPorRuta / rutasDeCronDeclaradas", () => {
  it("cubre los 19 crons reales de vercel.json, todos con cadencia diaria determinable", () => {
    const rutas = rutasDeCronDeclaradas();
    expect(rutas.length).toBe(19);

    const mapa = cadenciaMinutosPorRuta();
    for (const ruta of rutas) {
      expect(mapa[ruta]).toBe(24 * 60);
    }
  });

  it("incluye el cron de whatsapp/dispatch (el hueco documentado que dio origen a esta pantalla)", () => {
    const mapa = cadenciaMinutosPorRuta();
    expect(mapa["/internal/whatsapp/dispatch"]).toBe(24 * 60);
  });
});
