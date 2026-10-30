// Registro de adaptadores del banco. Aqui NO hay proveedores reales: cada adaptador se registra por id con una fabrica perezosa (los reales llegan en tareas posteriores).
import { crearAdaptadorFalso } from "./adaptadores/falso.ts";
import type { AdaptadorBanco } from "./tipos.ts";

export type FabricaAdaptador = (opciones: Record<string, unknown>) => AdaptadorBanco;

const fabricas = new Map<string, FabricaAdaptador>();

export function registrarAdaptador(id: string, fabrica: FabricaAdaptador): void {
  if (!/^[a-z0-9][a-z0-9:+._-]*$/.test(id)) throw new Error("id de adaptador invalido");
  if (fabricas.has(id)) throw new Error(`el adaptador ${id} ya esta registrado`);
  fabricas.set(id, fabrica);
}

export function listarAdaptadores(): string[] {
  return [...fabricas.keys()].sort();
}

export function crearAdaptador(id: string, opciones: Record<string, unknown> = {}): AdaptadorBanco {
  const f = fabricas.get(id);
  if (!f) throw new Error(`adaptador desconocido: ${id.slice(0, 40)} (registrados: ${listarAdaptadores().join(", ") || "ninguno"})`);
  return f(opciones);
}

// Unico adaptador de esta etapa: el doble determinista (sin red, sin llaves, sin gasto).
registrarAdaptador("falso", () => crearAdaptadorFalso());
