// Exportaciones del CFO de la plataforma: Excel real (zip OOXML) y PDF de inversionistas sin nombres de clientes, con step-up y bitacora.
import { afterEach, describe, expect, it, vi } from "vitest";
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { InMemoryCfoCockpitRepository, InMemoryCfoRepository, InMemoryPylRepository } from "@atiende/db";
import type { CfoOrgRow } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { armarCockpit } from "../src/cfo/cockpit.ts";
import { informeInversionistas, libroCockpit } from "../src/cfo/cockpit-exportar.ts";
import { isSensitiveRoute } from "../src/superadmin-seguridad/step-up.ts";
import { rutaFinanciera } from "../src/superadmin-seguridad/zona-cfo.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

afterEach(() => vi.useRealTimers());

const T0 = new Date("2026-11-15T12:00:00.000Z");

function fila(id: string, nombre: string, parche: Partial<CfoOrgRow> = {}): CfoOrgRow {
  return {
    organizationId: id, organizationName: nombre, organizationSlug: id, vertical: "restaurantes", orgStatus: "active",
    planId: "rest", planNombre: "Restaurantes", precioBaseCentavos: 300000, precioAsientoCentavos: null, asientosIncluidos: 0,
    billingStatus: "activa", billingSeats: null, sucursalesActivas: 1,
    llmMicroUsd: 1_000_000, vozMicroUsd: 0, whatsappMicroUsd: 0, telefoniaMicroUsd: 0, otrosMicroUsd: 0,
    eventosTotal: 0, eventosEstimados: 0, minutosVoz: 0, mensajes: 0, llmCapMicroUsd: 900_000_000, llmAlertPct: 80,
    billingPeriodEndMs: null, limites: [], mxnPorUsd: 20, fxFecha: "2026-11-06", fxFuente: "Banxico FIX", ...parche,
  };
}

const NOMBRE = "Pizzería Doña Carmen";
const C = armarCockpit(
  { mes: "2026-11", rows: [fila("p", NOMBRE), fila("x", "Sin plan", { planId: null, planNombre: null, precioBaseCentavos: null })], rowsPrevias: [], fotos: [], uso: [], supuestos: [], capturas: [], infra: [], cockpitMigrado: true, infraMigrada: true },
  T0,
);

/** Texto de todos los streams del PDF (descomprimidos si vienen con Flate). */
function streamsDe(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const crudo = buf.toString("latin1");
  let out = "";
  const re = /stream\r?\n/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(crudo)) !== null) {
    const ini = m.index + m[0].length;
    const fin = crudo.indexOf("endstream", ini);
    if (fin === -1) break;
    const trozo = buf.subarray(ini, fin);
    try {
      out += inflateSync(trozo).toString("latin1");
    } catch {
      out += trozo.toString("latin1");
    }
  }
  return out;
}

const hex = (t: string) => [...new TextEncoder().encode(t)].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join("");

describe("libro de Excel", () => {
  it("es un zip OOXML con las hojas del cockpit y el cliente en la hoja de economia", () => {
    const bytes = libroCockpit(C, T0);
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe("PK");
    const crudo = new TextDecoder().decode(bytes);
    for (const hoja of ["Economía por cliente", "Por vertical", "Por plan", "MRR mensual", "Cohortes", "Supuestos"]) expect(crudo).toContain(`name="${hoja}"`);
    expect(crudo).toContain(NOMBRE);
  });
});

describe("PDF de inversionistas", () => {
  it("se abre, lleva el titulo y NO lleva nombres de clientes", async () => {
    const bytes = await informeInversionistas(C, T0);
    expect(new TextDecoder("latin1").decode(bytes.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toBe("Resumen mensual 2026-11");
    const crudo = streamsDe(bytes);
    expect(crudo).toContain(hex("Resumen mensual para inversionistas"));
    expect(crudo).not.toContain("Carmen");
    expect(crudo).not.toContain(hex("Carmen"));
  });
});

describe("rutas de exportacion", () => {
  it("exigen step-up, quedan como exportacion en la zona CFO y devuelven el archivo", async () => {
    expect(isSensitiveRoute("GET", "/superadmin/cfo/cockpit/export.xlsx")).toBe(true);
    expect(isSensitiveRoute("GET", "/superadmin/cfo/cockpit/informe.pdf")).toBe(true);
    expect(rutaFinanciera("GET", "/superadmin/cfo/cockpit/informe.pdf")).toMatchObject({ exportacion: true });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const s = await seguridadSetup();
    const cfo = new InMemoryCfoRepository();
    cfo.seedRows([fila("p", NOMBRE)]);
    const cockpit = new InMemoryCfoCockpitRepository({ now: () => T0.getTime() });
    const app = buildApp({ ...s.deps, cfoRepo: () => cfo, cfoCockpitRepo: () => cockpit, pylRepo: () => new InMemoryPylRepository() });
    const sa = await s.superadmin();
    cfo.seedSuperadmin(sa.id);
    cockpit.seedSuperadmin(sa.id);
    const x = await app.request("/superadmin/cfo/cockpit/export.xlsx?mes=2026-11", { headers: bearer(sa.token) });
    expect(x.status).toBe(200);
    expect(x.headers.get("content-type")).toMatch(/spreadsheetml/);
    const p = await app.request("/superadmin/cfo/cockpit/informe.pdf?mes=2026-11", { headers: bearer(sa.token) });
    expect(p.status).toBe(200);
    expect(p.headers.get("content-type")).toBe("application/pdf");
    expect(p.headers.get("content-disposition")).toContain("resumen-inversionistas-2026-11.pdf");
    const st = await s.staff();
    expect((await app.request("/superadmin/cfo/cockpit/informe.pdf", { headers: bearer(st.token) })).status).toBe(403);
  });
});
