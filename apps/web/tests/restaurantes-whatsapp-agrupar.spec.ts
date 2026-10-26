// Agrupación de burbujas: mensajes SEGUIDOS del mismo remitente comparten grupo (solo el primero lleva cola); cambio de remitente, de día o un mensaje de sistema abren grupo.
import { describe, expect, it } from "vitest";
import { agruparMensajes } from "../src/verticals/restaurantes/preview/agrupar-mensajes.ts";

const t = (iso: string) => new Date(iso);
const AHORA = t("2026-10-08T20:15:00.000Z");

describe("agruparMensajes", () => {
  it("dos o tres mensajes seguidos del mismo remitente: solo el primero abre grupo", () => {
    const r = agruparMensajes(
      [
        { rol: "cliente", hora: t("2026-10-08T20:10:00.000Z") },
        { rol: "cliente", hora: t("2026-10-08T20:11:00.000Z") },
        { rol: "cliente", hora: t("2026-10-08T20:12:00.000Z") },
        { rol: "agente", hora: t("2026-10-08T20:13:00.000Z") },
        { rol: "agente", hora: t("2026-10-08T20:14:00.000Z") },
        { rol: "cliente", hora: t("2026-10-08T20:15:00.000Z") },
      ],
      "America/Mexico_City",
      AHORA,
    );
    expect(r.map((m) => m.primero)).toEqual([true, false, false, true, false, true]);
    expect(r.map((m) => m.separador)).toEqual(["Hoy", null, null, null, null, null]);
  });

  it("un mensaje de sistema corta el grupo y el cambio de día pone la fecha (no «Hoy») y reabre grupo", () => {
    const r = agruparMensajes(
      [
        { rol: "agente", hora: t("2026-10-07T20:10:00.000Z") },
        { rol: "agente", hora: t("2026-10-07T20:11:00.000Z") },
        { rol: "sistema", hora: t("2026-10-07T20:11:30.000Z") },
        { rol: "agente", hora: t("2026-10-07T20:12:00.000Z") },
        { rol: "agente", hora: t("2026-10-08T20:00:00.000Z") },
      ],
      "America/Mexico_City",
      AHORA,
    );
    expect(r.map((m) => m.primero)).toEqual([true, false, true, true, true]);
    expect(r[0]!.separador).toMatch(/\d/);
    expect(r[0]!.separador).not.toBe("Hoy");
    expect(r[4]!.separador).toBe("Hoy");
  });
});
