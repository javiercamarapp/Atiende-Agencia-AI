// Motor puro de derivación de cadencia -- ver `../src/salud/cadencia.ts`.
// Casos límite: expresión no soportada -> 0 (nunca inventa un número),
// diario/horario/cada-N-minutos, y que `cadenciaMinutosPorRuta()` cubra
// realmente los 21 crons declarados en vercel.json (falla si alguien agrega
// un cron a vercel.json sin que este módulo sepa derivar su cadencia, o si
// alguien borra un cron de vercel.json sin darse cuenta).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

  it("semanal ('20 6 * * 0') -> 7 dias; mensual ('40 7 3 * *') -> 31 dias (el hueco maximo, nunca marca vencido un mes corto)", () => {
    expect(minutosEsperadosDeCron("20 6 * * 0")).toBe(7 * 24 * 60);
    expect(minutosEsperadosDeCron("0 5 * * 1")).toBe(7 * 24 * 60);
    expect(minutosEsperadosDeCron("40 7 3 * *")).toBe(31 * 24 * 60);
  });

  it("combinaciones fuera de alcance -> 0 (mes fijo, dia-mes y dia-semana a la vez, semanal/mensual sin hora fija, dia-mes 0), nunca inventa", () => {
    expect(minutosEsperadosDeCron("0 5 1 1 *")).toBe(0);
    expect(minutosEsperadosDeCron("0 5 1 * 1")).toBe(0);
    expect(minutosEsperadosDeCron("*/5 5 * * 1")).toBe(0);
    expect(minutosEsperadosDeCron("0 * 3 * *")).toBe(0);
    expect(minutosEsperadosDeCron("0 5 0 * *")).toBe(0);
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
  it("cubre TODOS los crons reales de vercel.json (el total se lee del archivo: agregar un cron ya no obliga a tocar este numero), todos con cadencia determinable (> 0)", () => {
    const rutas = rutasDeCronDeclaradas();
    const vercel = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "vercel.json"), "utf8")) as { crons: unknown[] };
    expect(rutas.length).toBe(vercel.crons.length);

    const mapa = cadenciaMinutosPorRuta();
    for (const ruta of rutas) {
      expect(mapa[ruta], ruta).toBeGreaterThan(0);
    }
  });

  it("incluye el cron de whatsapp/dispatch (el hueco documentado que dio origen a esta pantalla)", () => {
    const mapa = cadenciaMinutosPorRuta();
    expect(mapa["/internal/whatsapp/dispatch"]).toBe(5);
    expect(mapa["/internal/citas/confirmacion-cita"]).toBe(30);
    expect(mapa["/internal/rentas/ical-sync"]).toBe(15);
    expect(mapa["/internal/hoteles/night-audit"]).toBe(24 * 60);
  });
});
