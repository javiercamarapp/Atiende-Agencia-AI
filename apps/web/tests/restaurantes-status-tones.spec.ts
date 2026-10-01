import { describe, expect, it } from "vitest";
import { statusTone } from "@atiende/ui";
import { ORDER_STATUS_LABELS } from "../src/verticals/restaurantes/lib/orders-client.ts";
import { ESTADO_LABEL } from "../src/verticals/restaurantes/lib/conversaciones-client.ts";
import { CUSTOMER_TIER_TONES, HANDOFF_ESTADO_TONES, ORDER_STATUS_TONES, tierBadgeClase } from "../src/verticals/restaurantes/lib/status-tones.ts";

describe("restaurantes — tablas de tono para StatusBadge", () => {
  it("cada estado de pedido con etiqueta tiene tono (ninguno cae al fallback por omision)", () => {
    for (const estado of Object.keys(ORDER_STATUS_LABELS)) {
      expect(ORDER_STATUS_TONES[estado], `pedido ${estado}`).toBeDefined();
    }
  });

  it("cada estado de handoff con etiqueta tiene tono", () => {
    for (const estado of Object.keys(ESTADO_LABEL)) {
      expect(HANDOFF_ESTADO_TONES[estado], `handoff ${estado}`).toBeDefined();
    }
  });

  it("incidencias y pedidos no recogidos son peligro; entregado/completado son exito", () => {
    expect(ORDER_STATUS_TONES.problema).toBe("danger");
    expect(ORDER_STATUS_TONES.no_recogido).toBe("danger");
    expect(ORDER_STATUS_TONES.entregado).toBe("success");
    expect(ORDER_STATUS_TONES.completado).toBe("success");
  });

  it("un estado desconocido cae a neutral", () => {
    expect(statusTone(ORDER_STATUS_TONES, "estado_futuro")).toBe("neutral");
    expect(statusTone(HANDOFF_ESTADO_TONES, undefined)).toBe("neutral");
  });

  it("los cuatro tiers de cliente tienen tono y solo BLACK invierte colores con clases de token", () => {
    for (const t of ["BLACK", "PLATINUM", "GOLD", "BLUE"]) expect(CUSTOMER_TIER_TONES[t]).toBeDefined();
    expect(tierBadgeClase("BLACK")).toContain("bg-foreground");
    expect(tierBadgeClase("GOLD")).toBeUndefined();
  });
});
