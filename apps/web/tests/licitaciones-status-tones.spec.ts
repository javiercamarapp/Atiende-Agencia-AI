import { describe, expect, it } from "vitest";
import { statusTone } from "@atiende/ui";
import {
  ALERTA_RENOVACION_TONES,
  APROBACION_DATO_TONES,
  BORRADOR_ESTATUS_TONES,
  CAMPO_CONTRATO_TONES,
  CONTACTO_WHATSAPP_TONES,
  CORRIDA_FUENTE_TONES,
  ELEGIBILIDAD_TONES,
  FACTURA_STATUS_TONES,
  INVITACION_STAFF_TONES,
  PAQUETE_CIERRE_TONES,
  PREGUNTA_JUNTA_TONES,
  PROPUESTA_PROPIA_TONES,
  REQUISITO_STATUS_TONES,
  RESULTADO_CUMPLIMIENTO_TONES,
  SEMAFORO_TONES,
  URGENCIA_RENOVACION_TONES,
  VIABILIDAD_TONES,
  contratoStatusTone,
} from "../src/verticals/licitaciones/lib/status-tones.ts";

describe("status-tones de licitaciones", () => {
  it("conservan la carga semantica de los colores crudos y variantes de Badge que reemplazan", () => {
    expect(statusTone(SEMAFORO_TONES, "rojo")).toBe("danger");
    expect(statusTone(SEMAFORO_TONES, "amarillo")).toBe("warning");
    expect(statusTone(SEMAFORO_TONES, "verde")).toBe("success");
    expect(statusTone(SEMAFORO_TONES, "gris")).toBe("neutral");
    expect(statusTone(RESULTADO_CUMPLIMIENTO_TONES, "verde")).toBe("success");
    expect(statusTone(RESULTADO_CUMPLIMIENTO_TONES, "ambar")).toBe("warning");
    expect(statusTone(RESULTADO_CUMPLIMIENTO_TONES, "rojo")).toBe("danger");
    expect(statusTone(PAQUETE_CIERRE_TONES, "ready")).toBe("success");
    expect(statusTone(PAQUETE_CIERRE_TONES, "draft")).toBe("warning");
    expect(statusTone(ALERTA_RENOVACION_TONES, "pendiente")).toBe("warning");
    expect(statusTone(ALERTA_RENOVACION_TONES, "reconocida")).toBe("success");
    expect(URGENCIA_RENOVACION_TONES).toEqual({ urgente: "danger", proxima: "warning", seguimiento: "neutral" });
    expect(statusTone(FACTURA_STATUS_TONES, "pagada")).toBe("success");
    expect(statusTone(FACTURA_STATUS_TONES, "vencida")).toBe("danger");
    expect(statusTone(VIABILIDAD_TONES, "alta")).toBe("success");
    expect(statusTone(VIABILIDAD_TONES, "baja")).toBe("danger");
    expect(statusTone(BORRADOR_ESTATUS_TONES, "revisado")).toBe("success");
    expect(statusTone(PROPUESTA_PROPIA_TONES, "desechada")).toBe("danger");
    expect(statusTone(PROPUESTA_PROPIA_TONES, "no_presentada")).toBe("warning");
    expect(statusTone(REQUISITO_STATUS_TONES, "bloqueado")).toBe("danger");
    expect(statusTone(REQUISITO_STATUS_TONES, "cumplido")).toBe("success");
    expect(statusTone(APROBACION_DATO_TONES, "pendiente_aprobacion")).toBe("warning");
    expect(statusTone(PREGUNTA_JUNTA_TONES, "enviada")).toBe("warning");
    expect(statusTone(PREGUNTA_JUNTA_TONES, "respondida")).toBe("success");
    expect(statusTone(CONTACTO_WHATSAPP_TONES, "pendiente")).toBe("warning");
    expect(statusTone(CONTACTO_WHATSAPP_TONES, "baja")).toBe("neutral");
    expect(statusTone(INVITACION_STAFF_TONES, "accepted")).toBe("success");
    expect(statusTone(INVITACION_STAFF_TONES, "expired")).toBe("danger");
    expect(statusTone(ELEGIBILIDAD_TONES, "cumple")).toBe("success");
    expect(statusTone(ELEGIBILIDAD_TONES, "no_cumple")).toBe("danger");
    expect(statusTone(CAMPO_CONTRATO_TONES, "sugerido")).toBe("warning");
  });

  it("un estado desconocido cae a neutral en vez de pintarse mal (o al fallback que se pida)", () => {
    expect(statusTone(REQUISITO_STATUS_TONES, "estado_nuevo")).toBe("neutral");
    expect(statusTone(SEMAFORO_TONES, undefined)).toBe("neutral");
    // Corrida de fuente: ok = verde, cualquier otro estado = rojo (como antes: destructive).
    expect(statusTone(CORRIDA_FUENTE_TONES, "ok", "danger")).toBe("success");
    expect(statusTone(CORRIDA_FUENTE_TONES, "failed", "danger")).toBe("danger");
    // Campo de contrato: solo "sugerido" es ambar; el resto (confirmado/corregido) es verde.
    expect(statusTone(CAMPO_CONTRATO_TONES, "confirmado", "success")).toBe("success");
  });

  it("contratoStatusTone: rojo en los estados de alerta del contrato, neutro en el resto", () => {
    for (const s of ["penalizado", "rescindido", "en_inconformidad", "cerrado"]) expect(contratoStatusTone(s)).toBe("danger");
    for (const s of ["vigente", "modificado", "en_firma"]) expect(contratoStatusTone(s)).toBe("neutral");
  });
});
