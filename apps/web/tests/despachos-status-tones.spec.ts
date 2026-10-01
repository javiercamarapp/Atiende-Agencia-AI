import { describe, expect, it } from "vitest";
import { statusTone } from "@atiende/ui";
import {
  COBRANZA_BUCKET_TONES,
  ESTATUS_VERIFICACION_TONES,
  MIGRACION_ESTADO_TONES,
  NIVEL_ATENCION_TONES,
  PERIODO_STATUS_TONES,
  TAREA_STATUS_TONES,
  VENCIMIENTO_ESTADO_TONES,
  VENCIMIENTO_PRIORIDAD_TONES,
  confianzaTone,
} from "../src/verticals/despachos/lib/status-tones.ts";

describe("status-tones de despachos", () => {
  it("conservan la carga semantica de los colores crudos que reemplazan", () => {
    expect(statusTone(PERIODO_STATUS_TONES, "open")).toBe("info");
    expect(statusTone(PERIODO_STATUS_TONES, "closed")).toBe("success");
    expect(statusTone(PERIODO_STATUS_TONES, "overdue")).toBe("danger");
    expect(statusTone(TAREA_STATUS_TONES, "blocked")).toBe("danger");
    expect(statusTone(TAREA_STATUS_TONES, "done")).toBe("success");
    expect(statusTone(COBRANZA_BUCKET_TONES, "0-30")).toBe("success");
    expect(statusTone(COBRANZA_BUCKET_TONES, "61-90")).toBe("warning");
    expect(statusTone(COBRANZA_BUCKET_TONES, "90+")).toBe("danger");
    expect(statusTone(VENCIMIENTO_PRIORIDAD_TONES, "critica")).toBe("danger");
    expect(statusTone(VENCIMIENTO_PRIORIDAD_TONES, "baja")).toBe("success");
    expect(statusTone(VENCIMIENTO_ESTADO_TONES, "vencido")).toBe("danger");
    expect(statusTone(VENCIMIENTO_ESTADO_TONES, "escalado")).toBe("warning");
    expect(statusTone(MIGRACION_ESTADO_TONES, "pendiente")).toBe("warning");
    expect(statusTone(NIVEL_ATENCION_TONES, "critico")).toBe("danger");
    expect(statusTone(NIVEL_ATENCION_TONES, "al_corriente")).toBe("success");
  });

  it("un estado desconocido cae a neutral en vez de pintarse mal", () => {
    expect(statusTone(ESTATUS_VERIFICACION_TONES, "otro_estatus_nuevo")).toBe("neutral");
    expect(statusTone(PERIODO_STATUS_TONES, undefined)).toBe("neutral");
  });

  it("confianzaTone: ambar si requiere revision, verde si es alta, azul en el resto", () => {
    expect(confianzaTone(0.99, true)).toBe("warning");
    expect(confianzaTone(0.85, false)).toBe("success");
    expect(confianzaTone(0.6, false)).toBe("info");
  });
});
