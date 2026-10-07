// CHAT-17: la configuracion del Copiloto de plataforma (apps/web) apunta SOLO a herramientas que existen en el catalogo real y con argumentos que su esquema
// acepta; y el catalogo del superadmin (con `proponer_accion`) queda cubierto por las etiquetas de los pasos "en vivo". Si el catalogo renombra una herramienta o
// cambia sus parametros, este test falla en vez de dejar un chip roto en silencio.
import { describe, expect, it } from "vitest";
import { parseArgs } from "@atiende/agent-core/data-chat";
import { DATOS_COPILOTO_SUPERADMIN as COPILOTO_SUPERADMIN, DIRECTAS_COPILOTO_SUPERADMIN } from "../../web/src/superadmin/lib/copiloto-datos.ts";
import type { DependenciasAcciones } from "../src/superadmin-copiloto/acciones.ts";
import type { PlatformScope } from "../src/superadmin-copiloto/alcance.ts";
import { buildCatalogoPlataforma } from "../src/superadmin-copiloto/catalogo.ts";
import { fuentesFalsas } from "./superadmin-copiloto-fixtures.ts";

const SCOPE: PlatformScope = { userId: "u", rol: "superadmin", stepUp: true, timezone: "America/Mexico_City" };
const acciones = {} as DependenciasAcciones;
const catalogo = buildCatalogoPlataforma(fuentesFalsas(), SCOPE, { acciones });

describe("config del Copiloto de plataforma contra el catalogo real", () => {
  it("cada consulta directa apunta a una herramienta del catalogo con argumentos que su esquema acepta", () => {
    for (const [pregunta, directa] of Object.entries(DIRECTAS_COPILOTO_SUPERADMIN)) {
      const tool = catalogo.tools.find((t) => t.name === directa.tool);
      expect(tool, `${pregunta} -> ${directa.tool} no existe en el catalogo`).toBeDefined();
      const parsed = parseArgs(tool!.params, directa.args ?? {});
      expect(parsed.ok, `${pregunta} -> ${directa.tool}: ${parsed.ok ? "" : parsed.error}`).toBe(true);
    }
  });

  it("ningun chip lanza `proponer_accion` (la accion la propone el modelo y la confirma una persona)", () => {
    for (const directa of Object.values(DIRECTAS_COPILOTO_SUPERADMIN)) expect(directa.tool).not.toBe("proponer_accion");
  });

  it("la portada cubre CFO, cobranza, ventas, costos de IA, margen, clientes, agentes y salud, y cada pregunta de tarjeta o chip tiene consulta directa", () => {
    const herramientas = new Set(Object.values(DIRECTAS_COPILOTO_SUPERADMIN).map((d) => d.tool));
    for (const necesaria of ["mrr", "pyl", "margen_costos_unitarios", "facturacion_cobranza", "contratos_por_vencer", "prospectos", "costos_ia", "organizaciones", "agentes_interruptores", "errores", "salud_colas"]) {
      expect(herramientas, `falta una consulta directa a ${necesaria}`).toContain(necesaria);
    }
    for (const c of COPILOTO_SUPERADMIN.categorias) for (const q of c.preguntas) expect(DIRECTAS_COPILOTO_SUPERADMIN[q], `${q} no tiene consulta directa`).toBeDefined();
    for (const q of COPILOTO_SUPERADMIN.sugerencias) expect(DIRECTAS_COPILOTO_SUPERADMIN[q], `${q} no tiene consulta directa`).toBeDefined();
    expect(COPILOTO_SUPERADMIN.sugerencias.length).toBeLessThanOrEqual(5);
  });

  it("las etiquetas de los pasos cubren TODAS las herramientas del catalogo (incluida proponer_accion) y no sobra ninguna", () => {
    expect(Object.keys(COPILOTO_SUPERADMIN.etiquetasHerramienta).sort()).toEqual(catalogo.tools.map((t) => t.name).sort());
  });

  it("las rutas de fuente solo apuntan a pantallas internas", () => {
    for (const ruta of Object.values(COPILOTO_SUPERADMIN.rutasFuente)) expect(ruta).toMatch(/^\/superadmin(\/[a-z-]+)?(\?tab=[a-z]+)?$/);
    for (const tool of Object.keys(COPILOTO_SUPERADMIN.rutasFuente)) expect(catalogo.tools.map((t) => t.name)).toContain(tool);
  });
});
