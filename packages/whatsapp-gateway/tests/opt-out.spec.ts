// PL-32 -- deteccion determinista de BAJA/ALTA: positivos, variantes de formato y falsos positivos.
import { describe, expect, it } from "vitest";
import { detectarOptOut, normalizarTextoOptOut } from "../src/opt-out.ts";

describe("detectarOptOut", () => {
  it("baja: palabra sola en cualquier formato (mayusculas, acentos, signos, emojis, cortesias)", () => {
    for (const t of ["BAJA", "baja", " Stop ", "STOP.", "¡Alto!", "ALTO", "no más mensajes", "NO MAS MENSAJES", "No quiero más mensajes", "darme de baja", "Dar de baja", "unsubscribe", "BAJA 🙏", "cancelar suscripción"]) {
      expect(detectarOptOut(t), t).toBe("baja");
    }
  });

  it("alta: reactiva con ALTA/START y frases cortas", () => {
    for (const t of ["ALTA", "alta", "Start", "START!", "quiero recibir mensajes", "reactivar avisos"]) {
      expect(detectarOptOut(t), t).toBe("alta");
    }
  });

  it("falsos positivos: una frase real que CONTIENE la palabra no dispara", () => {
    for (const t of [
      "no puedo ir, baja la cita",
      "quiero una baja de mi cita",
      "stop por favor no, quiero reagendar",
      "hola",
      "",
      "   ",
      "el alto del edificio",
      "no hay mas mensajes en el chat, gracias por todo lo demas",
      "Confirmar",
      "alta de mi expediente",
      "quiero dar de alta a mi esposa en la clinica",
      "stop por favor",
      "hola, baja",
      "start the booking now please I need to talk about my appointment today",
    ]) {
      expect(detectarOptOut(t), t).toBeNull();
    }
  });

  it("CANCELAR no es baja por omision (cancela la cita/pedido) y solo lo es si se activa la opcion", () => {
    expect(detectarOptOut("CANCELAR")).toBeNull();
    expect(detectarOptOut("Cancelar", { cancelarEsBaja: true })).toBe("baja");
    expect(detectarOptOut("cancelar mi cita", { cancelarEsBaja: true })).toBeNull();
  });

  it("entradas no textuales no lanzan", () => {
    expect(detectarOptOut(undefined as unknown as string)).toBeNull();
    expect(detectarOptOut(null as unknown as string)).toBeNull();
    expect(normalizarTextoOptOut(42 as unknown as string)).toBe("");
  });
});
