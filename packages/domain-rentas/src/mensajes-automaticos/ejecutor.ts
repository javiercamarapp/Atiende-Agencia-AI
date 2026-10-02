// Rn-25 -- corrida real de los mensajes automaticos por evento.
//
// NUNCA envia: para cada reserva en ventana renderiza la plantilla APROBADA por el tenant
// (exigirPlantillaAprobadaParaProgramar, H-056) y deja un BORRADOR `pendiente_aprobacion` en la cola
// de aprobacion humana existente (D-006). La politica por canal y la aprobacion siguen siendo la
// unica salida real (mensajeria-borradores.ts); sin canal conectado el borrador queda pendiente.
//
// Una transaccion POR RESERVA (misma leccion que acceso/liberacion.ts y checkin-reminders.ts): un
// error SQL real en una reserva deja ESA transaccion abortada (25P02) y su ROLLBACK nunca toca los
// borradores ya creados. Idempotente: la marca (ocupacion, evento) hace que dos corridas -- o dos
// instancias a la vez -- dejen UN solo borrador.
//
// Sin PII en logs: los `console.*` de este archivo solo reciben ids y el SQLSTATE/nombre del error.
import { isMigrationPendingError } from "@atiende/db";
import { PlantillaNoAprobadaError, VariablePlantillaFaltanteError, exigirPlantillaAprobadaParaProgramar, renderizarPlantilla } from "../mensajeria/plantillas.ts";
import type { RentasMensajesAutomaticosRepository } from "./repository.ts";
import { MAX_MENSAJES_POR_CORRIDA } from "./tipos.ts";
import type { CandidatoMensajeAutomatico, ResumenMensajesAutomaticos } from "./tipos.ts";
import { enVentanaDisparo } from "./ventana.ts";
import { construirVariables } from "./variables.ts";

export interface BorradorAutomaticoCreado {
  readonly borradorId: string;
  readonly organizationId: string;
  readonly propertyId: string;
}

export interface ContextoMensajesAutomaticos {
  readonly repo: RentasMensajesAutomaticosRepository;
  /** Se invoca DENTRO de la transaccion de la reserva, tras crear el borrador (aviso in-app `rentas.aprobacion.pendiente`). */
  readonly alCrearBorrador?: (creado: BorradorAutomaticoCreado) => Promise<void>;
}

/** Ejecuta `fn` en UNA transaccion propia (la ruta abre `withAppSession({ userId: null })`). */
export type WithMensajesAutomaticosTx = <T>(fn: (ctx: ContextoMensajesAutomaticos) => Promise<T>) => Promise<T>;

type Resultado = "creado" | "omitido" | "ya_procesado";

function etiquetaError(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "error";
}

async function procesarCandidata(ctx: ContextoMensajesAutomaticos, c: CandidatoMensajeAutomatico): Promise<Resultado> {
  const plantilla = { id: c.plantillaId, evento: c.evento, idioma: "es" as const, canal: c.canal, cuerpo: c.plantillaCuerpo, aprobadaPorTenant: c.plantillaAprobada, activa: c.plantillaActiva };
  // Si la base devolviera una plantilla no aprobada/inactiva (no deberia: la consulta ya la filtra) se rechaza aqui tambien.
  exigirPlantillaAprobadaParaProgramar(plantilla);

  let texto: string;
  try {
    texto = renderizarPlantilla(plantilla, construirVariables(c));
  } catch (err) {
    if (err instanceof VariablePlantillaFaltanteError) {
      // El motor nunca inventa un valor: se deja marca para no reintentar cada hora un mensaje que no puede salir bien.
      await ctx.repo.registrarOmitido({ ocupacionId: c.ocupacionId, evento: c.evento, plantillaId: c.plantillaId });
      return "omitido";
    }
    throw err;
  }

  const borradorId = await ctx.repo.crearBorradorAutomatico({ ocupacionId: c.ocupacionId, evento: c.evento, plantillaId: c.plantillaId, texto });
  if (borradorId === null) return "ya_procesado";
  if (ctx.alCrearBorrador) await ctx.alCrearBorrador({ borradorId, organizationId: c.organizationId, propertyId: c.propertyId });
  return "creado";
}

export async function ejecutarMensajesAutomaticos(withTx: WithMensajesAutomaticosTx, ahora: Date = new Date(), opciones: { readonly maxPorCorrida?: number } = {}): Promise<ResumenMensajesAutomaticos> {
  const max = opciones.maxPorCorrida ?? MAX_MENSAJES_POR_CORRIDA;
  const r = { candidatas: 0, borradoresCreados: 0, omitidasVariableFaltante: 0, yaProcesadas: 0, fueraDeVentana: 0, errores: 0 };

  let candidatas: readonly CandidatoMensajeAutomatico[];
  try {
    candidatas = await withTx((ctx) => ctx.repo.listarCandidatos(ahora, max));
  } catch (err) {
    // Base sin la migracion 029: no hay nada programado todavia (nunca un 500).
    if (isMigrationPendingError(err)) return { disponible: false, ...r, truncada: false };
    throw err;
  }
  r.candidatas = candidatas.length;

  for (const c of candidatas) {
    // Segunda barrera: la regla de ventana (zona horaria de la propiedad) se revalida en TypeScript.
    if (!enVentanaDisparo(c, ahora)) {
      r.fueraDeVentana += 1;
      continue;
    }
    try {
      const res = await withTx((ctx) => procesarCandidata(ctx, c));
      if (res === "creado") r.borradoresCreados += 1;
      else if (res === "omitido") r.omitidasVariableFaltante += 1;
      else r.yaProcesadas += 1;
    } catch (err) {
      r.errores += 1;
      console.error("mensajes-automaticos: error procesando reserva", c.ocupacionId, c.evento, err instanceof PlantillaNoAprobadaError ? "plantilla_no_aprobada" : etiquetaError(err));
    }
  }
  return { disponible: true, ...r, truncada: candidatas.length >= max };
}
