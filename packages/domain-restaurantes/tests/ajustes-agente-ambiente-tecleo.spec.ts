// Ajustes del agente: ambiente con presets, tecleo y naturalidad (migracion 087). Validacion, valores por omision, instruccion y lectura/escritura contra la base sin la 087.
import { describe, expect, it } from "vitest";
import {
  AJUSTES_AGENTE_POR_DEFECTO,
  AjustesInvalidosError,
  AjustesNoDisponiblesError,
  InMemoryAjustesAgenteRepository,
  ajustesDeFila,
  ajustesDeLlamada,
  instruccionConAjustes,
  validarAjustesAgente,
} from "../src/index.ts";
import { BLOQUE_NATURALIDAD } from "@atiende/voice-core";
import type { AjustesAgente } from "../src/index.ts";

const BASE_ENTRADA = { ...AJUSTES_AGENTE_POR_DEFECTO };
const SOLO_ANTIGUOS = {
  whatsappModelo: null,
  whatsappTemperatura: null,
  vozModeloCascada: null,
  vozTemperatura: null,
  vozRitmo: "normal",
  vozEstilo: "neutro",
  vozFondoActivo: false,
  vozFondoVolumen: 8,
};

describe("valores por omision (el comportamiento anterior no cambia)", () => {
  it("sin tecleo, sin naturalidad y con el preset de siempre", () => {
    expect(AJUSTES_AGENTE_POR_DEFECTO).toMatchObject({ vozFondoPreset: "cocina-taqueria", vozTecleoActivo: false, vozTecleoVolumen: 12, vozHumanizar: false });
  });

  it("un cliente desactualizado que no manda los campos nuevos CONSERVA los vigentes (no los borra)", () => {
    const vigentes: AjustesAgente = { ...AJUSTES_AGENTE_POR_DEFECTO, vozTecleoActivo: true, vozTecleoVolumen: 15, vozHumanizar: true, vozFondoPreset: "sala-tranquila" };
    expect(validarAjustesAgente(SOLO_ANTIGUOS, vigentes)).toMatchObject({ vozTecleoActivo: true, vozTecleoVolumen: 15, vozHumanizar: true, vozFondoPreset: "sala-tranquila" });
    expect(validarAjustesAgente(SOLO_ANTIGUOS)).toMatchObject({ vozTecleoActivo: false, vozHumanizar: false });
  });
});

describe("validacion", () => {
  it("acepta los valores validos", () => {
    const r = validarAjustesAgente({ ...BASE_ENTRADA, vozFondoPreset: "calle-ocupada", vozTecleoActivo: true, vozTecleoVolumen: 25, vozHumanizar: true });
    expect(r).toMatchObject({ vozFondoPreset: "calle-ocupada", vozTecleoActivo: true, vozTecleoVolumen: 25, vozHumanizar: true });
    expect(validarAjustesAgente({ ...BASE_ENTRADA, vozTecleoVolumen: 0 }).vozTecleoVolumen).toBe(0);
  });

  it.each([
    ["vozFondoPreset", ["", null, false, [], {}, 0, "discoteca"]],
    ["vozTecleoActivo", ["", null, 0, "si", [], {}]],
    ["vozTecleoVolumen", ["", null, false, [], {}, 26, -1, 1.5, "12"]],
    ["vozHumanizar", ["", null, 0, "si", [], {}]],
  ])("%s rechaza entradas invalidas", (campo, malos) => {
    for (const malo of malos as unknown[]) expect(() => validarAjustesAgente({ ...BASE_ENTRADA, [campo]: malo }), `${campo}=${JSON.stringify(malo)}`).toThrow(AjustesInvalidosError);
  });
});

describe("ajustes de llamada (lo que ve el worker)", () => {
  it("el tecleo solo cuenta activo con la bandera y volumen > 0; apagado manda volumen 0; el preset siempre viaja", () => {
    expect(ajustesDeLlamada(AJUSTES_AGENTE_POR_DEFECTO)).toMatchObject({ tecleo: { activo: false, volumen: 0 }, humanizar: false, fondo: { activo: false, preset: "cocina-taqueria" } });
    expect(ajustesDeLlamada({ ...AJUSTES_AGENTE_POR_DEFECTO, vozTecleoActivo: true, vozTecleoVolumen: 0 }).tecleo).toEqual({ activo: false, volumen: 0 });
    expect(ajustesDeLlamada({ ...AJUSTES_AGENTE_POR_DEFECTO, vozTecleoActivo: true, vozTecleoVolumen: 14, vozHumanizar: true, vozFondoPreset: "sala-tranquila" })).toMatchObject({
      tecleo: { activo: true, volumen: 14 },
      humanizar: true,
      fondo: { preset: "sala-tranquila" },
    });
  });
});

describe("instruccion con ajustes", () => {
  it("con vozHumanizar anexa el bloque de naturalidad y acento al FINAL; apagado no cambia nada", () => {
    const apagado = instruccionConAjustes("Reglas duras.", { vozRitmo: "normal", vozEstilo: "neutro", vozHumanizar: false }, null);
    expect(apagado).toBe("Reglas duras.");
    const encendido = instruccionConAjustes("Reglas duras.", { vozRitmo: "normal", vozEstilo: "calido", vozHumanizar: true }, null);
    expect(encendido.startsWith("Reglas duras.")).toBe(true);
    expect(encendido).toContain("Tu voz es calida y cercana.");
    expect(encendido.endsWith(BLOQUE_NATURALIDAD)).toBe(true);
    expect(instruccionConAjustes("Reglas duras.", { vozRitmo: "normal", vozEstilo: "neutro" }, null)).toBe("Reglas duras."); // sin el campo = apagado
  });
});

describe("filas de la base", () => {
  const fila = { whatsapp_model: null, whatsapp_temperature: null, voice_cascade_model: null, voice_temperature: null, voice_pace: "normal", voice_style: "neutro", voice_background: false, voice_background_volume: 8, updated_at: "2026-10-13T00:00:00Z" };
  it("una fila SIN las columnas de la 087 (base con 055 solamente) cae a los valores por omision", () => {
    expect(ajustesDeFila(fila)).toMatchObject({ vozFondoPreset: "cocina-taqueria", vozTecleoActivo: false, vozTecleoVolumen: 12, vozHumanizar: false });
  });
  it("una fila con valores fuera de lista (escrita directo) no rompe al agente", () => {
    expect(ajustesDeFila({ ...fila, voice_background_preset: "x", voice_typing: true, voice_typing_volume: 99, voice_humanize: true })).toMatchObject({ vozFondoPreset: "cocina-taqueria", vozTecleoActivo: true, vozTecleoVolumen: 12, vozHumanizar: true });
  });
});

describe("repositorio en memoria sin la 087", () => {
  it("guarda lo de siempre pero rechaza con 503 honesto lo nuevo; la lectura avisa ambienteDisponible=false", async () => {
    const r = new InMemoryAjustesAgenteRepository();
    r.ambienteMigrado = false;
    expect((await r.leer("o")).ambienteDisponible).toBe(false);
    await expect(r.guardar("o", "u", { ...AJUSTES_AGENTE_POR_DEFECTO, vozHumanizar: true })).rejects.toBeInstanceOf(AjustesNoDisponiblesError);
    await expect(r.guardar("o", "u", { ...AJUSTES_AGENTE_POR_DEFECTO, vozFondoVolumen: 5 })).resolves.toMatchObject({ disponible: true });
    r.ambienteMigrado = true;
    expect((await r.leer("o")).ambienteDisponible).toBe(true);
  });
});
