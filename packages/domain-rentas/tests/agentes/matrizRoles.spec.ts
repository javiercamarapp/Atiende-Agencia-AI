import { describe, expect, it } from "vitest";
import { CATALOGO_TOOLS_AGENTE, NOMBRE_TOOL_CONSULTAR_POLITICA_CANAL, NOMBRE_TOOL_PROPONER_BORRADOR } from "../../src/agentes/catalogo.ts";
import { construirMatrizCompleta, toolPermitidaParaActor, toolsDisponiblesParaActor } from "../../src/agentes/matrizRoles.ts";
import { RENTAS_VERTICAL_ROLES } from "../../src/roles.ts";
import type { RentasVerticalRole } from "../../src/roles.ts";

function actor(rol: RentasVerticalRole) {
  return { usuarioId: "u1", rol };
}

describe("catálogo de tools de agentes de rentas", () => {
  it("solo expone mensajeria_proponer_borrador y mensajeria_consultar_politica_canal — nunca cancelación/reembolso/contacto directo", () => {
    expect(CATALOGO_TOOLS_AGENTE.map((t) => t.nombre).sort()).toEqual([NOMBRE_TOOL_CONSULTAR_POLITICA_CANAL, NOMBRE_TOOL_PROPONER_BORRADOR].sort());
  });
});

describe("toolPermitidaParaActor / toolsDisponiblesParaActor — matriz rol×tool (H-078)", () => {
  it.each(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"] as RentasVerticalRole[])("%s puede proponer un borrador", (rol) => {
    const tool = CATALOGO_TOOLS_AGENTE.find((t) => t.nombre === NOMBRE_TOOL_PROPONER_BORRADOR)!;
    expect(toolPermitidaParaActor(tool, actor(rol))).toBe(true);
  });

  it.each(["operador:solo_calendario", "contador", "limpieza"] as RentasVerticalRole[])("%s NUNCA puede proponer un borrador (D-006: solo quien puede escribir la conversación)", (rol) => {
    const tool = CATALOGO_TOOLS_AGENTE.find((t) => t.nombre === NOMBRE_TOOL_PROPONER_BORRADOR)!;
    expect(toolPermitidaParaActor(tool, actor(rol))).toBe(false);
  });

  it("consultar política de canal está abierto a TODOS los roles de vertical — es solo lectura, sin efecto sobre ninguna conversación", () => {
    const tool = CATALOGO_TOOLS_AGENTE.find((t) => t.nombre === NOMBRE_TOOL_CONSULTAR_POLITICA_CANAL)!;
    for (const rol of RENTAS_VERTICAL_ROLES) {
      expect(toolPermitidaParaActor(tool, actor(rol))).toBe(true);
    }
  });

  it("toolsDisponiblesParaActor de contador solo incluye la tool de solo lectura", () => {
    const disponibles = toolsDisponiblesParaActor(actor("contador"));
    expect(disponibles.map((t) => t.nombre)).toEqual([NOMBRE_TOOL_CONSULTAR_POLITICA_CANAL]);
  });

  it("toolsDisponiblesParaActor de admin_gestora incluye ambas tools", () => {
    const disponibles = toolsDisponiblesParaActor(actor("admin_gestora"));
    expect(disponibles.map((t) => t.nombre).sort()).toEqual([NOMBRE_TOOL_CONSULTAR_POLITICA_CANAL, NOMBRE_TOOL_PROPONER_BORRADOR].sort());
  });
});

describe("construirMatrizCompleta", () => {
  it("produce una fila por cada combinación tool×rol, resuelta en servidor", () => {
    const matriz = construirMatrizCompleta();
    expect(matriz).toHaveLength(CATALOGO_TOOLS_AGENTE.length * RENTAS_VERTICAL_ROLES.length);
    const filaProponerLimpieza = matriz.find((f) => f.tool === NOMBRE_TOOL_PROPONER_BORRADOR && f.rol === "limpieza");
    expect(filaProponerLimpieza?.permitido).toBe(false);
  });
});
