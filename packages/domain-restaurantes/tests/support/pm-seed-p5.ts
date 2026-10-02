// FIXTURE de prueba (nunca datos reales): Javier contesta P5 con la propuesta de plan-integracion-cerebro.
//   * T7 y T8 = el menu de T1-2026.
//   * T2 = el menu de T1 sin lo que T2 no vende (comida regional, flautas, Ensalada de PM, Jericallas, Cafe) mas Heineken Silver a $90.
// Todos esos precios van marcados `provisional_P5`, las sucursales se activan y el pendiente P5 pasa a `resuelta`. Con los datos
// reales T2, T7 y T8 no tienen catalogo: este fixture solo existe para probar que el modelo funciona cuando Javier conteste.
import type { PmSeedData } from "../../src/seed/pm-demo.ts";

export function dataConP5Aprobado(data: PmSeedData): PmSeedData {
  const copia = JSON.parse(JSON.stringify(data)) as unknown as {
    sucursales: Array<{ id: string; activa: boolean }>;
    productos: Array<{ nombre: string; categoria: string; precios_por_sucursal: Record<string, number>; fuente_precio: Record<string, string> }>;
    pendientes_dueno: Array<{ id: string; estado?: string }>;
  };
  for (const b of copia.sucursales) if (["T2", "T7", "T8"].includes(b.id)) b.activa = true;
  const noEnT2 = (p: { categoria: string; nombre: string }) => ["Comida Regional", "Flautas de PM"].includes(p.categoria) || ["Ensalada de PM", "Jericallas", "Café"].includes(p.nombre);
  for (const p of copia.productos) {
    const t1 = p.precios_por_sucursal.T1;
    const nuevos: Record<string, number> = {};
    if (t1 !== undefined) {
      nuevos.T7 = t1;
      nuevos.T8 = t1;
      if (!noEnT2(p)) nuevos.T2 = t1;
    }
    if (p.nombre === "Heineken Silver") nuevos.T2 = 90;
    for (const [id, precio] of Object.entries(nuevos)) {
      p.precios_por_sucursal[id] = precio;
      p.fuente_precio[id] = "provisional_P5";
    }
  }
  copia.pendientes_dueno.find((x) => x.id === "P5")!.estado = "resuelta";
  return copia as unknown as PmSeedData;
}
