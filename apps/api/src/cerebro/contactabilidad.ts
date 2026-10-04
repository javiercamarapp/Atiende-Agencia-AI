// Contactabilidad de los prospectos del Cerebro (SA-L-46 + SA-L-37): que destinos estan en la lista de supresion de plataforma.
// `core.esta_suprimido` es una funcion SOLO DE SISTEMA (exige auth.uid() nulo y devuelve un booleano sin revelar motivo ni origen), asi
// que la lectura corre en una sesion de sistema propia, abierta por la ruta DESPUES de autenticar y gatear al superadmin; el valor en
// claro nunca sale del proceso (solo su hash viaja a la base) y la respuesta es un booleano por destino.
//
// Base sin migrar (0043 sin aplicar -> 42883/42P01/42703): devuelve `null` = "no se pudo verificar"; la pantalla lo dice y NO abre
// el WhatsApp ni el correo (falla cerrado). Nunca un 500.
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { avisarSupresionNoMigrada, esSupresionNoMigrada, hashearContacto } from "../supresion/index.ts";
import type { TipoContacto } from "../supresion/index.ts";

export interface SuprimidoProspecto {
  readonly telefono: boolean;
  readonly correo: boolean;
}

interface DestinoProspecto {
  readonly id: string;
  readonly telefono: string | null;
  readonly correo: string | null;
}

/** Tope de destinos por consulta: una sola ida a la base por lote. */
const LOTE = 2_000;

/**
 * Para cada prospecto, si su telefono / correo estan suprimidos. Un destino que no se puede interpretar (hash nulo) cuenta como NO
 * suprimido (no hay con que compararlo; el proveedor lo rechazara como invalido). `null` = lista no disponible en esta base.
 */
export async function suprimidosPorProspecto(db: TenantDbSession, prospectos: readonly DestinoProspecto[]): Promise<ReadonlyMap<string, SuprimidoProspecto> | null> {
  const pares = new Map<string, { tipo: TipoContacto; hash: string }>();
  const clave = (tipo: TipoContacto, hash: string) => `${tipo}:${hash}`;
  const hashes: { id: string; tipo: TipoContacto; hash: string }[] = [];
  for (const p of prospectos) {
    for (const [tipo, valor] of [["telefono", p.telefono], ["correo", p.correo]] as const) {
      if (valor === null) continue;
      const hash = hashearContacto(tipo, valor);
      if (hash === null) continue;
      pares.set(clave(tipo, hash), { tipo, hash });
      hashes.push({ id: p.id, tipo, hash });
    }
  }
  const unicos = [...pares.values()];
  const suprimidos = new Set<string>();
  if (unicos.length > 0) {
    const r = await runWithSavepointFallback<ReadonlySet<string> | null>({
      session: db,
      primary: async () => {
        const encontrados = new Set<string>();
        for (let i = 0; i < unicos.length; i += LOTE) {
          const lote = unicos.slice(i, i + LOTE);
          const { rows } = await db.query<{ tipo: string; hash: string; suprimido: boolean }>(
            "select t.tipo, t.hash, core.esta_suprimido(t.tipo, t.hash) as suprimido from unnest($1::text[], $2::text[]) as t(tipo, hash);",
            [lote.map((x) => x.tipo), lote.map((x) => x.hash)],
          );
          for (const f of rows) if (f.suprimido === true) encontrados.add(`${f.tipo}:${f.hash}`);
        }
        return encontrados;
      },
      isRecoverable: esSupresionNoMigrada,
      fallback: async () => {
        avisarSupresionNoMigrada("esta_suprimido (cerebro/contactabilidad)");
        return null;
      },
    });
    if (r === null) return null;
    for (const k of r) suprimidos.add(k);
  }
  const salida = new Map<string, SuprimidoProspecto>();
  for (const p of prospectos) salida.set(p.id, { telefono: false, correo: false });
  for (const h of hashes) {
    if (!suprimidos.has(clave(h.tipo, h.hash))) continue;
    const actual = salida.get(h.id)!;
    salida.set(h.id, h.tipo === "telefono" ? { ...actual, telefono: true } : { ...actual, correo: true });
  }
  return salida;
}
