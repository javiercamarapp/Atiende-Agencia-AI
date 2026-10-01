import { describe, expect, it } from "vitest";
import { statusTone } from "@atiende/ui";
import {
  BORRADOR_HISTORIAL_TONES,
  CONCILIACION_TONES,
  ESTADO_CONFLICTO_TONES,
  ESTADO_TAREA_TONES,
  SALUD_FEED_TONES,
  SEVERIDAD_ALERTA_TONES,
  TIPO_CONFLICTO_TONES,
  feedCanalTone,
  ocupacionTone,
} from "../src/verticals/rentas/lib/status-tones.ts";

describe("status-tones de rentas", () => {
  it("conservan la carga semantica de las variantes de <Badge> que reemplazan", () => {
    expect(statusTone(SALUD_FEED_TONES, "ok")).toBe("success");
    expect(statusTone(SALUD_FEED_TONES, "en_backoff")).toBe("warning");
    expect(statusTone(SALUD_FEED_TONES, "en_cuarentena")).toBe("danger");
    expect(statusTone(SALUD_FEED_TONES, "inactivo")).toBe("neutral");
    expect(statusTone(SEVERIDAD_ALERTA_TONES, "critica")).toBe("danger");
    expect(statusTone(SEVERIDAD_ALERTA_TONES, "aviso")).toBe("warning");
    expect(statusTone(ESTADO_CONFLICTO_TONES, "abierto")).toBe("danger");
    expect(statusTone(ESTADO_CONFLICTO_TONES, "resuelto")).toBe("success");
    expect(statusTone(ESTADO_CONFLICTO_TONES, "ignorado")).toBe("neutral");
    expect(statusTone(TIPO_CONFLICTO_TONES, "overbooking_confirmado")).toBe("danger");
    expect(statusTone(BORRADOR_HISTORIAL_TONES, "enviado")).toBe("success");
    expect(statusTone(BORRADOR_HISTORIAL_TONES, "rechazado")).toBe("danger");
    expect(statusTone(CONCILIACION_TONES, "conciliado")).toBe("success");
    expect(statusTone(CONCILIACION_TONES, "discrepancia")).toBe("danger");
    expect(statusTone(CONCILIACION_TONES, "pendiente")).toBe("warning");
    expect(statusTone(ESTADO_TAREA_TONES, "completada")).toBe("success");
    expect(statusTone(ESTADO_TAREA_TONES, "bloqueada")).toBe("danger");
  });

  it("un estado desconocido cae a neutral en vez de pintarse mal", () => {
    expect(statusTone(CONCILIACION_TONES, "estado_nuevo")).toBe("neutral");
    expect(statusTone(BORRADOR_HISTORIAL_TONES, undefined)).toBe("neutral");
  });

  it("feedCanalTone: cuarentena roja, conectado verde, inactivo neutro", () => {
    expect(feedCanalTone({ enCuarentenaDesde: "2026-09-01T00:00:00Z", activo: true })).toBe("danger");
    expect(feedCanalTone({ enCuarentenaDesde: null, activo: true })).toBe("success");
    expect(feedCanalTone({ enCuarentenaDesde: null, activo: false })).toBe("neutral");
  });

  it("ocupacionTone: cancelado y bloqueo neutros, conflicto rojo, provisional ambar, reserva confirmada verde", () => {
    expect(ocupacionTone({ estado: "cancelado", capa: "reserva" })).toBe("neutral");
    expect(ocupacionTone({ estado: "conflicto_pendiente", capa: "reserva" })).toBe("danger");
    expect(ocupacionTone({ estado: "provisional", capa: "reserva" })).toBe("warning");
    expect(ocupacionTone({ estado: "confirmado", capa: "bloqueo" })).toBe("neutral");
    expect(ocupacionTone({ estado: "confirmado", capa: "reserva" })).toBe("success");
  });
});
