// La cuenta demo ficticia NO copia datos reales de «Los Taquitos de PM» (cliente real, Merida): ni telefonos, ni colonias, ni nombres de producto, ni direcciones.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEMO_CUENTA } from "../src/seed/demo-cuenta/definicion.ts";
import { normalizar } from "../src/seed/demo-cuenta/plan.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PM = JSON.parse(readFileSync(path.join(AQUI, "../../../scripts/seed-pm-demo/data/pm-seed-data.json"), "utf8")) as {
  sucursales: { nombre: string; telefono: string | null; direccion: string | null }[];
  productos: { nombre: string }[];
  colonias: { nombre: string }[];
};
const digitos = (t: string) => t.replace(/\D/g, "");

describe("originalidad frente a PM", () => {
  it("ningun telefono coincide (ni sus ultimos 8 digitos)", () => {
    const pm = PM.sucursales.map((s) => digitos(s.telefono ?? "")).filter(Boolean);
    expect(pm.length).toBeGreaterThan(0);
    const nuestros = [...DEMO_CUENTA.sucursales.map((b) => b.telefono), DEMO_CUENTA.marca.telefonoOficina].map(digitos);
    for (const n of nuestros) for (const p of pm) expect(n.slice(-8) === p.slice(-8), `${n} vs ${p}`).toBe(false);
  });

  it("ninguna colonia de reparto ni nombre de sucursal coincide con una colonia de PM", () => {
    const pm = new Set(PM.colonias.map((c) => normalizar(c.nombre)));
    expect(pm.size).toBeGreaterThan(100);
    for (const c of DEMO_CUENTA.colonias) expect(pm.has(normalizar(c.nombre)), c.nombre).toBe(false);
    for (const b of DEMO_CUENTA.sucursales) expect(pm.has(normalizar(b.nombre)), b.nombre).toBe(false);
  });

  it("ningun producto comparte nombre con el menu de PM y las direcciones no repiten las de PM", () => {
    const pm = new Set(PM.productos.map((x) => normalizar(x.nombre)));
    for (const prod of DEMO_CUENTA.productos) expect(pm.has(normalizar(prod.nombre)), prod.nombre).toBe(false);
    const calles = PM.sucursales.map((s) => normalizar(s.direccion ?? "")).filter(Boolean);
    for (const b of DEMO_CUENTA.sucursales) for (const calle of calles) expect(normalizar(b.direccion).includes(calle)).toBe(false);
  });

  it("la marca no menciona a PM ni a Merida", () => {
    const texto = JSON.stringify([DEMO_CUENTA.marca, DEMO_CUENTA.agente, DEMO_CUENTA.conocimiento, DEMO_CUENTA.politicas]);
    expect(texto).not.toMatch(/taquitos de pm|m[eé]rida|yucat/i);
  });
});
