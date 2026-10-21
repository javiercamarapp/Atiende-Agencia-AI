// Paquete B: reglas de prompt de ubicacion y cobertura (modulo aparte; un integrador lo enlaza a perfil-pm.ts). Determinista, sin LLM.
import { describe, expect, it } from "vitest";
import { PM_PAQUETE_B_REGLAS, PM_PAQUETE_B_REGLAS_VOZ, bloquePaqueteB } from "../src/whatsapp/prompt-pm-paquete-b.ts";

describe("PM paquete B: reglas de ubicacion y cobertura", () => {
  const t = PM_PAQUETE_B_REGLAS;
  it("pin y tablaje son direccion valida: no se pide calle y numero ni se repite la direccion", () => {
    expect(t).toMatch(/pin/i);
    expect(t).toMatch(/tablaje/i);
    expect(t).toMatch(/NO pida calle y número|no pida calle y número/i);
    expect(t).toMatch(/UNA sola vez, en UN solo mensaje/);
    expect(t).toMatch(/color de (?:la )?casa/i);
  });
  it("nunca rechaza un pin valido", () => {
    expect(t).toMatch(/nunca rechace un pin/i);
  });
  it("la cobertura la decide la herramienta ANTES de decir si llegan", () => {
    expect(t).toMatch(/buscar_sucursal_cercana/);
    expect(t).toMatch(/antes de (?:decir|contestar|afirmar)/i);
  });
  it("deriva a otra sucursal con el telefono de la herramienta o de DATOS DEL NEGOCIO, sin inventar", () => {
    expect(t).toMatch(/teléfono/i);
    expect(t).toMatch(/nunca (?:lo )?invente|no lo invente|nunca de memoria/i);
    expect(t).toMatch(/recoger/i);
  });
  it("sin dato de cobertura no afirma ni niega: la sucursal confirma (no endurece reglas)", () => {
    expect(t).toMatch(/la sucursal (?:se lo )?confirma/i);
    expect(t).toMatch(/zona_no_reconocida/);
  });
  it("minimo $200 y sin cargo de envio desde la primera cotizacion, propina voluntaria al repartidor", () => {
    expect(t).toMatch(/\$200/);
    expect(t).toMatch(/sin cargo de envío/i);
    expect(t).toMatch(/propina/i);
    expect(t).toMatch(/voluntaria/i);
  });
  it("pin contradictorio: prefiere el pin y confirma la colonia en una linea", () => {
    expect(t).toMatch(/prefiera el pin/i);
  });
  it("no trae datos reales: ni telefonos ni nombres de colonias", () => {
    expect(t).not.toMatch(/\d{3}[\s-]?\d{3}[\s-]?\d{4}/);
    expect(t).not.toMatch(/Cholul|Temozón|Altabrisa|Country|Ceiba|Dzitiá|Santa Fe/i);
  });
  it("la version de voz es corta, sin pin y sin tablaje", () => {
    expect(PM_PAQUETE_B_REGLAS_VOZ.length).toBeLessThan(t.length);
    expect(PM_PAQUETE_B_REGLAS_VOZ).not.toMatch(/\bpin\b|tablaje/i);
    expect(PM_PAQUETE_B_REGLAS_VOZ).toMatch(/\$200/);
  });
  it("bloquePaqueteB elige por canal y declara que gana sobre el paso 4 de domicilio", () => {
    expect(bloquePaqueteB("whatsapp")).toContain(t);
    expect(bloquePaqueteB("voz")).toContain(PM_PAQUETE_B_REGLAS_VOZ);
    expect(bloquePaqueteB("whatsapp")).toMatch(/paso 4/);
  });
});
