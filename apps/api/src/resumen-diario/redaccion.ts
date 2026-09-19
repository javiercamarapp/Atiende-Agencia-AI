// Redacción del resumen diario -- plantilla DETERMINISTA en español, SIEMPRE
// disponible (fallback incondicional), y opcionalmente un párrafo narrativo
// por LLM. Principio innegociable (ver el comentario de cabecera de
// `packages/db/migrations/0015_superadmin_resumen_diario.sql`, que viene de
// un incidente real en otro producto del mismo dueño): el LLM SOLO redacta
// prosa a partir de números YA calculados -- nunca decide qué es una alerta,
// nunca ve un dato personal.
//
// ATRIBUCIÓN DE GASTO DE PLATAFORMA -- decisión documentada aquí porque es la
// única pieza de este feature que se aparta del patrón ya establecido
// (`production/llm-gateway.ts::buildProductionLlmGateway`): ESE gateway
// comparte 8 escaleras (5 producción + réplicas *_escalated) cuyo
// `usageRecorder`/`orgMonthlyBudgetStore` atan CADA llamada a
// `core.llm_usage_daily`/`core.llm_org_budget` vía `opts.tenantId` ==
// `organization_id` -- una columna `uuid not null references core.
// organization(id)` (ver `0010_llm_usage_budget_schema.sql`). El resumen
// diario NO pertenece a ningún tenant -- es un gasto de PLATAFORMA. Inventar
// una organización falsa (una fila ficticia en `core.organization` solo para
// poder reusar esas tablas) sería mentirle al modelo de datos real
// (aparecería como "una organización más" en cualquier conteo/listado de
// organizaciones del back office) -- la instrucción explícita del diseño es
// "si el modelo de datos exige organización, NO inventes una".
//
// La resolución más simple y correcta: `production/llm-gateway.ts::
// buildResumenDiarioLlmGateway` construye un `LlmGateway` DEDICADO (misma
// escalera de proveedores/credenciales, mismo circuit breaker por defecto),
// pero SIN `usageRecorder` ni `orgMonthlyBudgetStore` -- así que
// `gateway.complete()` nunca toca `core.llm_usage_daily`/`core.
// llm_monthly_reservation` para esta llamada (el `budgetStore` en memoria de
// `createGatewayBudget`/`reserveBudget` SÍ sigue aplicando -- es puramente un
// ledger de proceso, nunca requiere una organización real, ver `budget.ts`).
// El costo/modelo/proveedor REAL que el proveedor reportó se guarda
// DIRECTAMENTE en la fila de `core.daily_ops_summary` que este mismo módulo
// produce (columnas `costo_llm_micro_usd`/`modelo_llm`/`proveedor_llm`) --
// el resumen diario ES su propio registro de uso de plataforma: no hace
// falta una tabla nueva ni una organización inventada, el dato ya vive
// exactamente donde se necesita (la pantalla /superadmin/resumen lo muestra
// junto con el resto).
import type { LlmGateway } from "@atiende/agent-core";
import type { DiarioAgregados } from "./motor.ts";

/** Rol lógico de la escalera dedicada -- ver `production/llm-gateway.ts::
 *  buildResumenDiarioLlmGateway`. Una sola llamada al día. */
export const RESUMEN_DIARIO_LLM_ROLE = "plataforma:resumen_diario";

/** `tenantId` que exige `GatewayCallOptions` -- NUNCA se persiste como
 *  `organization_id` (el gateway dedicado no tiene `usageRecorder`/
 *  `orgMonthlyBudgetStore`, ver el comentario de cabecera): solo sirve como
 *  llave del ledger de presupuesto EN MEMORIA de esa corrida (`budget.ts`),
 *  que no exige que sea un UUID real. */
export const RESUMEN_DIARIO_LLM_TENANT_ID = "plataforma";

/** Timeout corto explícito -- un párrafo narrativo nunca debe demorar la
 *  generación del resumen (ni el cron, ni "generar ahora"): si el proveedor
 *  tarda más de esto, se aborta y se usa la plantilla determinista. */
export const RESUMEN_DIARIO_LLM_TIMEOUT_MS = 8_000;

const RESUMEN_DIARIO_LLM_MAX_OUTPUT_TOKENS = 400;

export interface NarrativaResultado {
  readonly narrativa: string;
  readonly generadoPor: "llm" | "determinista";
  readonly costoLlmMicroUsd: number | null;
  readonly modeloLlm: string | null;
  readonly proveedorLlm: string | null;
}

function moneda(microUsd: number | null): string {
  if (microUsd === null) return "no disponible";
  return `$${(microUsd / 1_000_000).toFixed(2)} USD`;
}

function porcentaje(p: number | null): string {
  return p === null ? "no disponible" : `${p.toFixed(1)}%`;
}

/**
 * Plantilla determinista en ESPAÑOL -- titulares + secciones, una línea por
 * pieza de `DiarioAgregados`, "no se pudo leer" explícito para cada sección
 * `null` (NUNCA un cero disfrazado). SIEMPRE disponible (sin I/O, sin
 * depender de ningún proveedor externo) -- el fallback incondicional de todo
 * este feature.
 */
export function redactarPlantillaDeterminista(a: DiarioAgregados): string {
  const lineas: string[] = [];
  lineas.push(`Resumen diario de operación — ${a.fecha} (${a.zonaHoraria}).`);

  const criticas = a.salud.alertas.filter((x) => x.severidad === "critica").length;
  lineas.push(a.salud.alertas.length === 0 ? "Salud operativa: sin alertas." : `Salud operativa: ${a.salud.alertas.length} alerta(s) activa(s), ${criticas} crítica(s).`);

  lineas.push(a.gastoLlm.costoHoyMicroUsd === null ? "Gasto de API de LLM: no se pudo leer." : `Gasto de API de LLM hoy: ${moneda(a.gastoLlm.costoHoyMicroUsd)} (${porcentaje(a.gastoLlm.pctTopePlataforma)} del tope mensual de plataforma).`);

  lineas.push(
    a.facturacion === null
      ? "Facturación: no se pudo leer."
      : `Facturación: ${a.facturacion.altas} alta(s), ${a.facturacion.bajas} baja(s), ${a.facturacion.morososNuevos} moroso(s) nuevo(s) hoy — ${a.facturacion.activasTotal} organización(es) activa(s) en total.`,
  );

  lineas.push(
    a.prospectos === null
      ? "Prospectos: no se pudo leer."
      : `Prospectos: ${a.prospectos.altas} alta(s), ${a.prospectos.cambiosEstado} cambio(s) de estado hoy, ${a.prospectos.sinMovimiento} sin movimiento en más de ${a.prospectos.umbralSinMovimientoDias} días.`,
  );

  lineas.push(
    a.organizacionesStaff === null
      ? "Organizaciones y staff nuevos: no se pudo leer."
      : `Organizaciones y staff nuevos: ${a.organizacionesStaff.organizacionesNuevas} organización(es)${
          a.organizacionesStaff.nombresOrganizacionesNuevas.length > 0 ? ` (${a.organizacionesStaff.nombresOrganizacionesNuevas.join(", ")})` : ""
        }, ${a.organizacionesStaff.staffNuevos} miembro(s) de staff nuevo(s).`,
  );

  lineas.push(
    a.mensajeria === null
      ? "Mensajería: no se pudo leer."
      : `Mensajería: ${a.mensajeria.reduce((s, c) => s + c.fallidosHoy, 0)} fallido(s) y ${a.mensajeria.reduce((s, c) => s + c.muertosHoy, 0)} muerto(s) hoy entre las ${a.mensajeria.length} colas.`,
  );

  lineas.push(a.breakGlassAbiertos === null ? "Break-glass: no se pudo leer." : `Break-glass: ${a.breakGlassAbiertos} acceso(s) de emergencia abierto(s) hoy.`);

  return lineas.join("\n");
}

/**
 * SOLO lo que este módulo le manda al LLM -- el JSON de agregados YA
 * calculados tal cual (`DiarioAgregados`), serializado sin transformación
 * adicional. Verificado por diseño (nunca por confianza): `DiarioAgregados`
 * nunca contiene nombre/teléfono/correo de huésped o cliente, ni texto libre
 * de un prospecto -- solo conteos, montos, estados y nombres de
 * ORGANIZACIÓN (explícitamente permitidos, ver el comentario de cabecera de
 * la migración). `apps/api/tests/resumen-diario-redaccion.spec.ts` lo
 * verifica con un fixture que SÍ trae datos personales en la entrada cruda
 * (antes de pasar por el agregador) para confirmar que nunca llegan aquí.
 */
export function construirPromptLlm(agregados: DiarioAgregados): string {
  return JSON.stringify(agregados);
}

const SYSTEM_PROMPT_LLM =
  "Eres un redactor ejecutivo. A partir de un JSON de métricas YA CALCULADAS de una plataforma SaaS B2B, escribe UN SOLO párrafo narrativo en español neutro, claro y directo, dirigido al dueño de la plataforma para que entienda en un minuto cómo amaneció la operación. Reglas estrictas: nunca inventes ni menciones un número que no esté literalmente en el JSON; nunca decidas ni sugieras qué es una alerta o qué tan grave es (esa clasificación ya viene resuelta en el JSON, solo repórtala); nunca recomiendes ninguna acción de negocio; nunca menciones a ningún cliente, huésped o persona por nombre (el JSON no trae nombres de personas, solo de organizaciones, y sí puedes mencionarlas). Responde solo con el párrafo, sin título ni viñetas.";

/**
 * Intenta redactar el párrafo narrativo vía el gateway dedicado
 * (`production/llm-gateway.ts::buildResumenDiarioLlmGateway`). Devuelve
 * `null` -- NUNCA lanza -- en cualquiera de estos casos: sin gateway
 * (ningún proveedor configurado), el gateway lanza (proveedor caído, tope
 * agotado, lo que sea), o tarda más que `timeoutMs`. El llamador
 * (`redactarResumenDiario`) trata `null` como "usa la plantilla
 * determinista".
 */
export async function generarNarrativaLlm(gateway: LlmGateway | undefined, agregados: DiarioAgregados, timeoutMs: number = RESUMEN_DIARIO_LLM_TIMEOUT_MS): Promise<NarrativaResultado | null> {
  if (!gateway) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const llamada = gateway.complete({
      tenantId: RESUMEN_DIARIO_LLM_TENANT_ID,
      runId: `resumen-diario:${agregados.fecha}`,
      lane: "background",
      role: RESUMEN_DIARIO_LLM_ROLE,
      request: {
        system: SYSTEM_PROMPT_LLM,
        messages: [{ role: "user", content: construirPromptLlm(agregados) }],
        maxOutputTokens: RESUMEN_DIARIO_LLM_MAX_OUTPUT_TOKENS,
        signal: controller.signal,
      },
    });
    // Defensa en profundidad además de `controller.signal`: no todo proveedor
    // garantiza abortar de inmediato -- este `race` acota el tiempo real que
    // `redactarResumenDiario` puede quedar esperando, sin importar qué tan
    // rápido reaccione el proveedor al abort.
    const resultado = await Promise.race([llamada, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("resumen-diario: timeout esperando al LLM")), timeoutMs))]);

    const texto = resultado.text.trim();
    if (texto.length === 0) return null;
    return {
      narrativa: texto,
      generadoPor: "llm",
      costoLlmMicroUsd: Math.round(resultado.costUsd * 1_000_000),
      modeloLlm: resultado.model,
      proveedorLlm: resultado.providerId,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Punto de entrada único: SIEMPRE devuelve un resultado utilizable (la
 *  plantilla determinista si el LLM no aplicó o falló) -- nunca lanza. */
export async function redactarResumenDiario(gateway: LlmGateway | undefined, agregados: DiarioAgregados, timeoutMs?: number): Promise<NarrativaResultado> {
  const viaLlm = await generarNarrativaLlm(gateway, agregados, timeoutMs);
  if (viaLlm) return viaLlm;
  return { narrativa: redactarPlantillaDeterminista(agregados), generadoPor: "determinista", costoLlmMicroUsd: null, modeloLlm: null, proveedorLlm: null };
}
