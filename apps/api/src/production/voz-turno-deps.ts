// Puertos de produccion del turno de voz (routes/verticals/restaurantes/voz-turno.ts). Cada `enTransaccion` abre su propia sesion de sistema
// (`userId: null`): la marca «en proceso» se confirma antes del modelo y el turno del agente + su respuesta se confirman juntos.
// Compatibilidad con la base sin migrar: el secreto y la bandera se leen en SAVEPOINT (42P01/42703/42883 -> «no disponible», 503 con fin).
import type { LlmGateway } from "@atiende/agent-core";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { runWithSavepointFallback } from "@atiende/db";
import { consumeRateLimit, leerCerebroV2, PostgresRestaurantesRepository, resolveAgentConfig, FALLBACK_CONFIG } from "@atiende/domain-restaurantes";
import { agenteDeVoz, esBaseSinMigrarVoz, gatewayDeVoz, modeloDeVoz, PostgresHilosVozRepository, repoDeVoz } from "@atiende/domain-restaurantes/voz-turno";
import type { ResultadoAuthVozTurno, VozTurnoPuertos } from "../routes/verticals/restaurantes/voz-turno.ts";
import type { buildRestaurantesTurnHandlerForSession } from "./deps.ts";

/** Presupuesto del turno de voz con modelo: el worker espera 35 s y reintenta; el turno debe terminar antes (y la marca caduca a los 60 s). */
export const VOZ_TURNO_PRESUPUESTO_MS = 20_000;

async function resolverSecreto(db: TenantDbSession, secretHash: string): Promise<{ organizationId: string; propertyId: string } | null | "no_disponible"> {
  return runWithSavepointFallback<{ organizationId: string; propertyId: string } | null | "no_disponible">({
    session: db,
    primary: async () => {
      const { rows } = await db.query<{ organization_id: string; property_id: string }>(`select organization_id, property_id from restaurantes.voz_turno_resolver_secreto($1);`, [secretHash]);
      return rows[0] ? { organizationId: rows[0].organization_id, propertyId: rows[0].property_id } : null;
    },
    isRecoverable: esBaseSinMigrarVoz,
    fallback: async () => "no_disponible",
  });
}

/** `construirHandler` = `buildRestaurantesTurnHandlerForSession` de ./deps.ts (inyectado para no crear un ciclo de imports). */
export function buildVozTurnoPuertos(
  engine: TenancyEngine,
  gateway: LlmGateway,
  construirHandler: typeof buildRestaurantesTurnHandlerForSession,
  env: NodeJS.ProcessEnv = process.env,
): VozTurnoPuertos {
  const modelo = modeloDeVoz(env.VOZ_TURNO_MODELO);
  return {
    apagado: () => ["1", "true", "on", "si"].includes(String(env.VOZ_TURNO_APAGADO ?? "").trim().toLowerCase()),

    autenticar: (secretHash) =>
      engine.withAppSession({ userId: null }, async (db): Promise<ResultadoAuthVozTurno> => {
        const r = await resolverSecreto(db, secretHash);
        if (r === "no_disponible") return { estado: "no_disponible" };
        if (r === null) return { estado: "no_coincide" };
        // leerCerebroV2 ya degrada con SAVEPOINT a «apagada» sin la 190.
        return { estado: "ok", ...r, cerebroV2: await leerCerebroV2(db, r.organizationId) };
      }),

    enTransaccion: (llamada, fn) =>
      engine.withAppSession({ userId: null }, (db) => {
        const base = new PostgresRestaurantesRepository(db);
        return fn({
          hilos: new PostgresHilosVozRepository(db),
          consumirCupo: async (clave, max, ventanaSeg) => (await consumeRateLimit(base, "voz-turno", clave, max, ventanaSeg)).allowed,
          contextoSaludo: async () => {
            const config = await resolveAgentConfig(base, llamada.organizationId, llamada.propertyId);
            return { zonaHoraria: config.timezone, nombreNegocio: config.businessName === FALLBACK_CONFIG.businessName ? null : config.businessName };
          },
          agente: async (args) => {
            const repo = repoDeVoz(base, { telefono: args.telefono, callId: args.callId });
            const handler = construirHandler(db, gatewayDeVoz(gateway), {}, undefined, {
              repo,
              opciones: {
                // Modelo de voz (Luna por omision; VOZ_TURNO_MODELO=rapido -> Gemini 3.5 Flash-Lite) y temperatura de siempre (0).
                leerAjustes: async () => ({ modelo, temperatura: 0 }),
                // La ruta solo atiende organizaciones con la bandera: el turno corre con las reglas v2 y ZDR estricto.
                leerCerebroV2: async () => true,
                turnBudgetMs: VOZ_TURNO_PRESUPUESTO_MS,
              },
            });
            return agenteDeVoz(handler, repo, llamada)(args);
          },
        });
      }),
  };
}
