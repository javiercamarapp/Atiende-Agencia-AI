import { describe, expect, it } from "vitest";
import { detectarSenalesEscalamiento } from "../../src/mensajeria/escalamiento.ts";

describe("detectarSenalesEscalamiento", () => {
  it("detecta queja, emergencia, reembolso y vip de forma independiente", () => {
    expect(detectarSenalesEscalamiento("Esto es inaceptable, pésimo servicio")).toEqual(["queja"]);
    expect(detectarSenalesEscalamiento("Hay una fuga de gas, es urgente")).toEqual(expect.arrayContaining(["emergencia"]));
    expect(detectarSenalesEscalamiento("Quiero mi reembolso ya")).toEqual(["reembolso"]);
    expect(detectarSenalesEscalamiento("Soy cliente VIP de esta plataforma")).toEqual(["vip"]);
  });

  it("puede detectar varias señales en el mismo texto", () => {
    const senales = detectarSenalesEscalamiento("Es una emergencia, quiero mi reembolso, esto es inaceptable");
    expect(senales).toEqual(expect.arrayContaining(["emergencia", "reembolso", "queja"]));
    expect(senales).toHaveLength(3);
  });

  it("un mensaje neutro no dispara ninguna señal", () => {
    expect(detectarSenalesEscalamiento("¿A qué hora es el check-in?")).toEqual([]);
  });
});
