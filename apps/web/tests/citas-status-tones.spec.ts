import { describe, expect, it } from "vitest";
import { statusTone } from "@atiende/ui";
import { activoTone, CITA_STATUS_TONES, INVITE_STATUS_TONES, syncTone } from "../src/verticals/citas/lib/status-tones.ts";
import { STATUS_LABELS } from "../src/verticals/citas/lib/format.ts";

describe("citas — tablas estado -> tono de StatusBadge", () => {
  it("cada estado de cita con etiqueta tiene tono propio (ninguno cae al neutral por omision salvo no_show)", () => {
    expect(Object.keys(CITA_STATUS_TONES).sort()).toEqual(Object.keys(STATUS_LABELS).sort());
    expect(statusTone(CITA_STATUS_TONES, "cancelled")).toBe("danger");
    expect(statusTone(CITA_STATUS_TONES, "completed")).toBe("success");
    expect(statusTone(CITA_STATUS_TONES, "pending")).toBe("warning");
    expect(statusTone(CITA_STATUS_TONES, "confirmed")).toBe("info");
  });

  it("un estado desconocido o ausente cae a neutral en vez de romper", () => {
    expect(statusTone(CITA_STATUS_TONES, "estado-nuevo")).toBe("neutral");
    expect(statusTone(INVITE_STATUS_TONES, null)).toBe("neutral");
  });

  it("invitaciones: revocada y expirada son danger, aceptada success", () => {
    expect(statusTone(INVITE_STATUS_TONES, "revoked")).toBe("danger");
    expect(statusTone(INVITE_STATUS_TONES, "expired")).toBe("danger");
    expect(statusTone(INVITE_STATUS_TONES, "accepted")).toBe("success");
  });

  it("sync de Google y activo/inactivo", () => {
    expect(syncTone("error")).toBe("danger");
    expect(syncTone("ok")).toBe("success");
    expect(syncTone(undefined)).toBe("success");
    expect(activoTone(true)).toBe("success");
    expect(activoTone(false)).toBe("neutral");
  });
});
