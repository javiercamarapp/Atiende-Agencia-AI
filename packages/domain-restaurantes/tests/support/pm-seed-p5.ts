// FIXTURE de prueba: la fase en la que T2 y T8 tambien reciben pedidos. Desde el 2-oct-2026 los datos reales YA traen P5 resuelta,
// el catalogo de T7 (activa, lista T1-2026) y el catalogo provisional de T2 y T8 (lista 2026, `provisional_P5`); lo unico que falta
// para que T2 y T8 atiendan es activarlas, que es lo que hace este fixture. No toca ningun precio.
import type { PmSeedData } from "../../src/seed/pm-demo.ts";

export function dataConP5Aprobado(data: PmSeedData): PmSeedData {
  const copia = JSON.parse(JSON.stringify(data)) as unknown as { sucursales: Array<{ id: string; activa: boolean }> };
  for (const b of copia.sucursales) if (["T2", "T7", "T8"].includes(b.id)) b.activa = true;
  return copia as unknown as PmSeedData;
}
