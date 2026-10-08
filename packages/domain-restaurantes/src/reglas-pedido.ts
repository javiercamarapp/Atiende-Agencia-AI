// Reglas de negocio por sucursal que se aplican al cotizar y al crear un pedido (modelo PM,
// migracion 023): horario ("abierto ahora"), pedido minimo por canal, cobertura de entrega
// ("fuera de zona") y politica de propina. Todas son OPT-IN: una sucursal sin politica
// configurada (o una base sin la migracion) se comporta exactamente como antes.
//
// Las lecturas van por `repo.find*`/`repo.list*`, que degradan con SAVEPOINT contra la base
// sin migrar (ver PostgresRestaurantesRepository): este modulo nunca captura SQLSTATE por
// su cuenta porque corre dentro de la transaccion unica del request.
import { aperturaConExcepciones, componentesLocales, etiquetaHoraLocal, fechaAnterior, fechaLocal, mensajeProgramadoFueraDeHorario, mensajeSucursalCerrada, type EstadoApertura } from "./horarios.ts";
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { OrderValidationError } from "./errors.ts";
import { normalizeZoneText } from "./nearest-branch.ts";
import { opcionesDeReferencia, referenciaDeColonia, SUCURSALES_QUE_NO_REPARTEN_PM, sucursalesDeDespacho } from "./sugerencia-despacho.ts";
import type { RestaurantesRepository } from "./repository.ts";
import { evaluarDomicilioSucursal, mensajeDomicilioNoDisponible } from "./domicilio-sucursal.ts";
import type { Branch, BranchPolicy, CanalPedido, KnownZone, PropinaPolitica } from "./types.ts";

export const COLONIA_FUERA_DE_VERIFICACION_MENSAJE =
  "No reconozco esa colonia para verificar la zona de reparto: pida otra referencia cercana (colonia vecina, cruce de calles o plaza conocida) e inténtelo de nuevo.";

/** ¿Alguna sucursal de la organizacion tiene la zona en su cobertura de entrega? */
async function algunaSucursalCubre(repo: RestaurantesRepository, organizationId: string, zoneId: string): Promise<boolean> {
  for (const b of await repo.listBranchesForOrganizationAdmin(organizationId)) {
    if ((await repo.listBranchDeliveryZoneIds(b.propertyId)).includes(zoneId)) return true;
  }
  return false;
}

/** `undefined` -> "domicilio" (comportamiento historico); cualquier otro valor fuera del
 * catalogo se rechaza en vez de caer en silencio a un canal. */
export function normalizarCanal(raw: unknown): CanalPedido {
  if (raw === undefined || raw === null) return "domicilio";
  if (raw === "domicilio" || raw === "recoger") return raw;
  throw new OrderValidationError("El canal del pedido debe ser 'domicilio' o 'recoger'.");
}

/** PM: propina SOLO con tarjeta. Sin politica configurada nunca se pregunta. */
export function debePreguntarPropina(politica: PropinaPolitica | null, paymentMethod: "efectivo" | "tarjeta" | null | undefined): boolean {
  if (politica === "siempre") return true;
  if (politica === "solo_tarjeta") return paymentMethod === "tarjeta";
  return false;
}

/** Largo minimo (texto normalizado, sin espacios) para que un fragmento cuente como colonia: una o dos letras ("a", "co") son
 * subcadena de casi cualquier zona y harian pasar un domicilio sin colonia real. */
export const LARGO_MIN_COLONIA = 4;

/** Quita lo que va entre parentesis ("García Lavín (Victory Platz)" -> "García Lavín") con un solo recorrido (sin expresion regular: el nombre de una zona es dato de la cuenta). */
function sinAclaracionEntreParentesis(nombre: string): string {
  let profundidad = 0;
  let salida = "";
  for (const ch of nombre) {
    if (ch === "(") profundidad += 1;
    else if (ch === ")" && profundidad > 0) profundidad -= 1;
    else if (profundidad === 0) salida += ch;
  }
  return salida.split(" ").filter((t) => t !== "").join(" ");
}

/** Mismo emparejamiento que `restaurantes.nearest_branch_by_colonia` (migracion 005): texto
 * normalizado de ambos lados, la zona mas especifica (nombre mas largo) gana. */
export function matchKnownZone(zones: readonly KnownZone[], colonia: string): KnownZone | null {
  const input = normalizeZoneText(colonia);
  if (!input) return null;
  let best: KnownZone | null = null;
  for (const zone of zones) {
    // Una zona con aclaracion entre parentesis ("García Lavín (Victory Platz)") tambien se llama por su nombre corto: el modelo manda la direccion completa
    // en `colonia` ("Calle 32 #345 x 20 y 22, García Lavín") y el nombre largo nunca estaba contenido (QA-PM-R2-voz-07).
    const nombres = [zone.name, sinAclaracionEntreParentesis(zone.name)].map(normalizeZoneText).filter((n) => n.length > 0);
    if (nombres.length === 0) continue;
    // La zona cuyo nombre normalizado ES lo dicho gana siempre (misma regla que la funcion SQL, migracion 056): sin esto "Centro" caia en
    // "Centro Chichi Suarez" y "Montebello" en "Montebello II" solo por tener el nombre mas largo.
    if (nombres.includes(input)) return zone;
    // La colonia escrita contiene la zona conocida (zona >= 3 letras), o la zona contiene lo escrito (fragmento >= LARGO_MIN_COLONIA).
    const coincide = nombres.some((name) => (name.length >= 3 && input.includes(name)) || (input.length >= LARGO_MIN_COLONIA && name.includes(input)));
    if (coincide && (!best || zone.name.length > best.name.length)) best = zone;
  }
  return best;
}

function pesos(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export interface ReglasSucursalArgs {
  readonly branch: Branch;
  readonly canal: CanalPedido;
  /** Total de renglones ANTES de cualquier descuento de promocion. */
  readonly subtotal: number;
  readonly colonia?: string;
  readonly paymentMethod?: "efectivo" | "tarjeta" | null;
  readonly propina?: number;
  /** "admin" (captura manual del staff) no se bloquea por horario. */
  readonly source?: "web" | "voice" | "whatsapp" | "admin";
  /** Instante contra el que se evalua el horario. Un pedido PROGRAMADO pasa la hora para la que se pidio. */
  readonly now?: Date;
  /** `true` = rechazar aunque `source` sea "admin" (un pedido programado nunca se acepta fuera de horario). */
  readonly exigirAbierto?: boolean;
  /** Mensaje de cierre propio (pedido programado: "no atiende a la hora elegida"). */
  readonly mensajeCerrado?: (apertura: EstadoApertura, zonaHoraria: string) => string;
  /** Solo canal "recoger": hora (ISO con zona) a la que el cliente pasara. Se valida contra el RELOJ del servidor: ni pasada, ni de otro dia
   * de negocio, ni despues del cierre (la voz y el LLM calculan "en 40 minutos" con la hora UTC y la guardaban 6 h tarde o dos dias atras). */
  readonly horaRecogida?: string;
}

/** Tolerancia hacia atras: el cliente dijo "paso a las 2" y el reloj ya marca 2:05. */
export const HORA_RECOGIDA_GRACIA_MIN = 10;
/** Una recogida mas lejana que esto ya no es "hoy": se pide un pedido programado. */
export const HORA_RECOGIDA_MAX_HORAS = 12;

export interface ReglasSucursalResultado {
  readonly policy: BranchPolicy;
  readonly apertura: EstadoApertura | null;
  readonly pedidoMinimo: number | null;
  readonly preguntarPropina: boolean;
  /** Dia de NEGOCIO (0-6) cuando la sucursal tiene horario y el instante cae en la cola de un turno que
   * cruzo la medianoche; `null` = usa el dia calendario (sin horario configurado o fuera de esa cola). */
  readonly diaNegocio: number | null;
}

/**
 * Aplica las reglas de la sucursal; lanza `OrderValidationError` con un mensaje claro para
 * el cliente cuando alguna se viola. Orden: horario -> minimo -> cobertura -> propina.
 */
export async function aplicarReglasDeSucursal(repo: RestaurantesRepository, args: ReglasSucursalArgs): Promise<ReglasSucursalResultado> {
  const { branch, canal, subtotal } = args;
  const policy = await repo.findBranchPolicy(branch.propertyId);

  let apertura: EstadoApertura | null = null;
  let diaNegocio: number | null = null;
  const horarioBase = policy.horario && policy.horario.length > 0 ? policy.horario : null;
  const ahora = args.now ?? new Date();
  const zonaCruda = (await repo.findBranchZonaHoraria(branch.propertyId)).zonaHoraria;
  // Puentes: una excepcion por fecha reemplaza el horario semanal en esas fechas (turno de hoy con el
  // horario de hoy; la cola del turno de ayer con el de ayer). Contra la base sin migrar la lectura
  // degrada a [] con SAVEPOINT.
  const zona = resolverZonaHorariaNegocio(zonaCruda);
  const hoy = fechaLocal(ahora, zona);
  const excepciones = await repo.listBranchHoursExceptions(branch.propertyId, fechaAnterior(hoy), hoy);
  const cubreHoy = excepciones.some((e) => e.fechaDesde <= hoy && hoy <= e.fechaHasta);
  if (horarioBase || cubreHoy) {
    const r = aperturaConExcepciones(horarioBase ?? [], excepciones, ahora, zonaCruda);
    apertura = r.estado;
    diaNegocio = r.diaNegocio;
    if (!apertura.abierto && (args.source !== "admin" || args.exigirAbierto === true)) {
      throw new OrderValidationError(args.mensajeCerrado ? args.mensajeCerrado(apertura, zona) : mensajeSucursalCerrada(branch.name, apertura));
    }
  }

  if (args.horaRecogida && canal === "recoger") {
    await validarHoraRecogida(repo, { branch, horarioBase, ahora, zonaCruda, zona, aperturaAhora: apertura, diaNegocioAhora: diaNegocio, horaRecogida: args.horaRecogida });
  }

  // Migracion 057: domicilio por sucursal (solo recoger o solo ciertos dias). El dia es el de NEGOCIO de la sucursal
  // (en su zona horaria; la cola de un turno que cruza la medianoche cuenta para el dia en que empezo).
  if (canal === "domicilio") {
    const diaEntrega = diaNegocio ?? componentesLocales(ahora, zona).dia;
    const estadoDomicilio = evaluarDomicilioSucursal(policy, diaEntrega);
    if (!estadoDomicilio.acepta) throw new OrderValidationError(mensajeDomicilioNoDisponible(branch.name, policy, estadoDomicilio));
  }

  const pedidoMinimo = canal === "domicilio" ? policy.pedidoMinimoDomicilio : policy.pedidoMinimoRecoger;
  if (pedidoMinimo !== null && subtotal < pedidoMinimo) {
    const faltante = Math.round((pedidoMinimo - subtotal) * 100) / 100;
    throw new OrderValidationError(
      `El pedido mínimo ${canal === "domicilio" ? "a domicilio" : "para recoger"} en ${branch.name} es de $${pesos(pedidoMinimo)}. ` +
        `El pedido suma $${pesos(subtotal)}; faltan $${pesos(faltante)} para alcanzarlo. No se puede registrar por debajo del mínimo: ofrezca agregar productos${canal === "domicilio" ? " o pasar a recoger" : ""}.`,
    );
  }

  if (canal === "domicilio") {
    const zoneIds = await repo.listBranchDeliveryZoneIds(branch.propertyId);
    if (zoneIds.length > 0) {
      const colonia = typeof args.colonia === "string" ? args.colonia.trim() : "";
      if (!colonia) {
        throw new OrderValidationError(
          `La sucursal ${branch.name} solo entrega en zonas de cobertura: pida la colonia o zona del cliente para verificarla antes de continuar.`,
        );
      }
      const zones = await repo.listKnownZones(branch.organizationId);
      const match = matchKnownZone(zones, colonia);
      if (!match) throw new OrderValidationError(COLONIA_FUERA_DE_VERIFICACION_MENSAJE);
      if (!zoneIds.includes(match.id)) {
        // Colonia conocida que NINGUNA sucursal cubre todavia (ambigua entre dos sucursales o sin asignar): no es "fuera de zona", es una zona
        // por confirmar. No se rechaza como si el cliente estuviera lejos: se ofrece recoger o se pasa a una persona.
        if (!(await algunaSucursalCubre(repo, branch.organizationId, match.id))) {
          // Nombra la sucursal de despacho mas cercana segun la referencia del piloto (aproximada) para que el cliente pueda recoger ahi; nunca promete el envio.
          // Sin km: la referencia del piloto de una colonia sin cobertura puede estar equivocada.
          const esPm = (await repo.findWhatsAppAgentConfig(branch.organizationId, null))?.perfil === "taqueria_pm";
          const cercana = opcionesDeReferencia(await referenciaDeColonia(repo, branch.organizationId, match.id), await sucursalesDeDespacho(repo, branch.organizationId, esPm ? SUCURSALES_QUE_NO_REPARTEN_PM : []))[0];
          const recogerEn = cercana ? ` Para recoger, una sucursal cercana es ${cercana.nombre}.` : "";
          throw new OrderValidationError(
            `${match.name} está fuera de la zona de reparto de ${branch.name}: todavía no tiene una sucursal de reparto asignada, así que no puedo confirmar el domicilio a esa colonia.${recogerEn} ` +
              `Ofrezca recoger en sucursal o pase el pedido con una persona del negocio para que confirme la zona.`,
          );
        }
        throw new OrderValidationError(
          `${match.name} está fuera de la zona de reparto de ${branch.name}: no se puede enviar el pedido a domicilio desde esta sucursal. Ofrezca recoger en sucursal o, si corresponde, otra sucursal.`,
        );
      }
    }
  }

  const preguntarPropina = debePreguntarPropina(policy.propinaPolitica, args.paymentMethod);
  if (args.propina !== undefined) {
    if (!Number.isFinite(args.propina) || args.propina < 0 || args.propina > 100000) {
      throw new OrderValidationError("La propina debe ser un monto en pesos mayor o igual a 0.");
    }
    if (args.propina > 0 && !preguntarPropina) {
      throw new OrderValidationError(
        policy.propinaPolitica === "solo_tarjeta"
          ? "La propina solo se registra cuando el pago es con tarjeta."
          : "Esta sucursal no registra propina en el pedido.",
      );
    }
  }

  return { policy, apertura, pedidoMinimo, preguntarPropina, diaNegocio };
}

/** QA-PM-R2-reglas-05 / voz-03 / wa-15: la hora de recogida la valida el SERVIDOR. Lanza `OrderValidationError` con un mensaje accionable
 * (incluye la hora local actual de la sucursal, que el modelo no sabia). */
async function validarHoraRecogida(
  repo: RestaurantesRepository,
  a: {
    readonly branch: Branch;
    readonly horarioBase: BranchPolicy["horario"] | null;
    readonly ahora: Date;
    readonly zonaCruda: string | null | undefined;
    readonly zona: string;
    readonly aperturaAhora: EstadoApertura | null;
    readonly diaNegocioAhora: number | null;
    readonly horaRecogida: string;
  },
): Promise<void> {
  const pickup = new Date(a.horaRecogida);
  const etiquetaAhora = etiquetaHoraLocal(a.ahora, a.zona);
  const etiquetaPickup = etiquetaHoraLocal(pickup, a.zona);
  const minutos = (pickup.getTime() - a.ahora.getTime()) / 60_000;
  if (minutos < -HORA_RECOGIDA_GRACIA_MIN) {
    throw new OrderValidationError(
      `La hora de recogida (${etiquetaPickup}) ya pasó: ahora son las ${etiquetaAhora} en la sucursal. Calcule la hora a partir de esa hora local (no de UTC) y confirme con el cliente a qué hora pasará.`,
    );
  }
  if (minutos > HORA_RECOGIDA_MAX_HORAS * 60) {
    throw new OrderValidationError(
      `La hora de recogida (${etiquetaPickup}) está a más de ${HORA_RECOGIDA_MAX_HORAS} horas (ahora son las ${etiquetaAhora}). Para otro día use un pedido programado (programado_para); aquí solo se acepta una recogida de hoy.`,
    );
  }
  const hoyLocal = fechaLocal(a.ahora, a.zona);
  const fechaPickup = fechaLocal(pickup, a.zona);
  const excepciones = await repo.listBranchHoursExceptions(a.branch.propertyId, fechaAnterior(fechaPickup), fechaPickup);
  const cubrePickup = excepciones.some((e) => e.fechaDesde <= fechaPickup && fechaPickup <= e.fechaHasta);
  if (a.horarioBase || cubrePickup) {
    const r = aperturaConExcepciones(a.horarioBase ?? [], excepciones, pickup, a.zonaCruda);
    if (!r.estado.abierto) {
      const cierre = a.aperturaAhora?.cierraA ? ` Hoy cierra a las ${a.aperturaAhora.cierraA}: ofrezca pasar antes.` : "";
      throw new OrderValidationError(`${mensajeProgramadoFueraDeHorario(a.branch.name, etiquetaPickup, r.estado)}${cierre}`);
    }
    if (a.diaNegocioAhora !== null && r.diaNegocio !== a.diaNegocioAhora) {
      throw new OrderValidationError(
        `La hora de recogida (${etiquetaPickup}) cae en otro día de negocio (ahora son las ${etiquetaAhora}). Para otro día use un pedido programado (programado_para).`,
      );
    }
  } else if (fechaPickup !== hoyLocal) {
    throw new OrderValidationError(`La hora de recogida (${etiquetaPickup}) no es de hoy (ahora son las ${etiquetaAhora}). Para otro día use un pedido programado (programado_para).`);
  }
}
