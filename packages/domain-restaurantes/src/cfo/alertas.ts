// CFO-09 · alertas de hallazgos del CFO al dueño (diseño §4.4). Se enganchan al tick diario de cierres (`/internal/restaurantes/cierres-dia`,
// 08:20 UTC): SIN cron nuevo. Para cada organización calcula los hallazgos del DIA DE NEGOCIO que acaba de cerrar (sesión de sistema, alcance de
// organización completa), se queda con los de urgencia ALTA o con impacto >= umbral y los avisa en la campana de owner/admin con
// `emitirNotificacion`.
//
// Garantías:
//  - Idempotencia: la clave de dedupe es `<tipo>-<sucursal|org>-<día de negocio>`. Repetir el tick (o el reintento `?dias=N`) no repite la alerta;
//    el top-5 se elige de forma determinista, así que la segunda llamada vuelve a apuntar a las mismas claves.
//  - Tope: como máximo `TOPE_ALERTAS_POR_ORG_DIA` (5) alertas por organización y día POR LLAMADA (se eligen las 5 primeras, de forma determinista, así que repetir
//    el tick apunta a las mismas claves); el resto se cuenta en `omitidasPorTope`. HUECO conocido: dos ticks el mismo día con datos distintos podrían
//    sumar más de 5. Contar lo ya emitido exige una función definer o una columna/índice en la base (el rol authenticated no puede leer
//    core.notification): F2.
//  - Día de negocio: la zona de la organización es la de su(s) sucursal(es) (la más común; empate = la primera). El día que cerró es AYER en esa
//    zona si ya pasó el corte del día de negocio (el MÁS TARDÍO de sus sucursales, `cobertura.corte`; 01:00 por omisión) y ANTEPASADO si todavía no
//    (una sucursal que cierra a las 03:00, o una re-ejecución manual a las 00:30). Nunca se usa la fecha UTC.
//  - Sin PII: el texto de la notificación solo lleva el código del tipo de hallazgo y el impacto en pesos enteros (la plantilla del catálogo no
//    admite texto libre). El detalle, la cifra y la acción viven en la pantalla del CFO (`/restaurantes/{orgSlug}/cfo`).
//  - Mejor esfuerzo: los fallos al EMITIR se aíslan y se reportan en `fallos`. Pero el servicio puede lanzar (`CfoSinAccesoError`,
//    `CfoParametroInvalidoError`) y esa excepción SÍ sube: el llamador (el tick) la atrapa por organización con try/catch.
//  - Canal externo (WhatsApp/correo): HUECO F2. Hoy solo existe la campana. Si un llamador pasa `canalExterno`, solo se invoca dentro del
//    horario del negocio (8:00 a 21:00 hora local) y nunca para alertas que no sean nuevas. En producción no se conecta ninguno (jamás se
//    envían mensajes reales desde aquí).
import { emitirNotificacion } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { diaLocalSucursal } from "../voz/kpi.ts";
import type { Hallazgo } from "./hallazgos.ts";
import type { CfoRepository } from "./repositorio.ts";
import { PostgresCfoRepository } from "./repositorio-postgres.ts";
import { ServicioCfo } from "./servicio.ts";
import { sumarDiasFecha } from "./util.ts";

/** Impacto mínimo (centavos) para alertar un hallazgo que no es de urgencia alta: $1,000. Si se quiere persistido en `cfo_config`, eso es F2. */
export const UMBRAL_ALERTA_CENTAVOS_POR_DEFECTO = 100_000;
/** Máximo de alertas por organización y día de negocio. */
export const TOPE_ALERTAS_POR_ORG_DIA = 5;
/** Ventana local en la que puede salir un canal externo (hueco F2): [8, 21). */
export const HORA_EXTERNA_DESDE = 8;
export const HORA_EXTERNA_HASTA = 21;

export interface SucursalAlerta {
  readonly propertyId: string;
  readonly zonaHoraria: string | null;
}

export interface AlertaCfo {
  readonly hallazgo: Hallazgo;
  /** `<tipo>-<sucursal|org>-<día de negocio>`. */
  readonly clave: string;
  readonly severidad: "atencion" | "critica";
  readonly impactoPesos: number | null;
}

export interface OpcionesAlertasCfo {
  /** Sucursales de la organización con su zona (salen de `sucursalesParaBarrido` del tick). Vacío = nada que alertar. */
  readonly sucursales: readonly SucursalAlerta[];
  readonly umbralCentavos?: number;
  readonly tope?: number;
  /** Inyectable en pruebas; por omisión, el adaptador Postgres sobre `db`. */
  readonly repo?: CfoRepository;
  /** Hueco F2: canal externo. Solo se invoca con alertas NUEVAS y dentro del horario del negocio. */
  readonly canalExterno?: (a: AlertaCfo) => Promise<void>;
}

export type EstadoAlertasCfo = "ok" | "no_disponible" | "sin_sucursales";

export interface ResultadoAlertasCfo {
  readonly estado: EstadoAlertasCfo;
  readonly organizationId: string;
  /** Día de negocio evaluado (AYER en la zona de la organización). */
  readonly dia: string | null;
  readonly zonaHoraria: string | null;
  readonly evaluados: number;
  readonly candidatos: number;
  readonly emitidas: number;
  /** Ya existían (dedupe), no había destinatarios o la base alcanzó su tope de volumen. */
  readonly sinNuevas: number;
  readonly omitidasPorTope: number;
  readonly externasEnviadas: number;
  readonly externasFueraDeHorario: number;
  readonly fallos: readonly string[];
}

/** Código legible (solo ASCII, sin espacios: `emitirNotificacion` rechaza texto libre) que va en el título de la notificación. */
const CODIGO_LEGIBLE: Readonly<Record<string, string>> = {
  caida_ventas: "Caida-de-ventas", ticket_baja: "Baja-del-ticket", cancelacion_alta: "Cancelaciones-altas", descuento_fuera_rango: "Descuentos-fuera-de-rango",
  compensaciones_inusuales: "Compensaciones-inusuales", costo_agente_alto: "Costo-alto-del-agente", cierre_agente_bajo: "Cierre-bajo-del-agente", entrega_lenta: "Entregas-lentas",
  frecuentes_dormidos: "Clientes-frecuentes-dormidos", agotado_estrella: "Producto-estrella-agotado", comandas_sin_capturar: "Comandas-sin-capturar",
  escalaciones_pico: "Pico-de-escalaciones", participacion_cae: "Cae-la-participacion", descuadre_sr: "Descuadre-con-SoftRestaurant",
};

const URGENCIA_ORDEN: Readonly<Record<string, number>> = { alta: 0, media: 1, baja: 2 };

/** Zona de la organización: la más común entre sus sucursales (empate: la primera en aparecer). Una zona vacía cae a la de México (igual que la base). */
export function zonaDeOrganizacion(sucursales: readonly SucursalAlerta[]): string | null {
  if (sucursales.length === 0) return null;
  const cuenta = new Map<string, number>();
  for (const s of sucursales) {
    const z = diaLocalSucursal(new Date(0), s.zonaHoraria).zonaHoraria;
    cuenta.set(z, (cuenta.get(z) ?? 0) + 1);
  }
  let mejor: string | null = null;
  let max = 0;
  for (const [z, n] of cuenta) {
    if (n > max) {
      mejor = z;
      max = n;
    }
  }
  return mejor;
}

/** Hora local entera (0-23) de `ahora` en la zona. */
export function horaLocal(ahora: Date, zona: string): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: zona, hour: "2-digit", hourCycle: "h23" }).format(ahora);
  return Number(h) % 24;
}

export function dentroDeHorarioExterno(ahora: Date, zona: string): boolean {
  const h = horaLocal(ahora, zona);
  return h >= HORA_EXTERNA_DESDE && h < HORA_EXTERNA_HASTA;
}

/** Puro: qué hallazgos alertan, en qué orden y con qué clave. Urgencia alta, o impacto >= umbral; alta primero, luego mayor impacto, luego id. */
export function seleccionarAlertas(hallazgos: readonly Hallazgo[], dia: string, umbralCentavos = UMBRAL_ALERTA_CENTAVOS_POR_DEFECTO): readonly AlertaCfo[] {
  const candidatos = hallazgos.filter((h) => h.urgencia === "alta" || (h.impactoCentavos != null && h.impactoCentavos >= umbralCentavos));
  const orden = [...candidatos].sort(
    (a, b) =>
      (URGENCIA_ORDEN[a.urgencia] ?? 9) - (URGENCIA_ORDEN[b.urgencia] ?? 9) ||
      (b.impactoCentavos ?? -1) - (a.impactoCentavos ?? -1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  // Un hallazgo por tipo × sucursal (el motor ya lo garantiza; esto cuida la clave de dedupe si cambiara).
  const vistos = new Set<string>();
  const out: AlertaCfo[] = [];
  for (const h of orden) {
    const clave = `${h.tipo}-${h.propertyId ?? "org"}-${dia}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    out.push({ hallazgo: h, clave, severidad: h.urgencia === "alta" ? "critica" : "atencion", impactoPesos: h.impactoCentavos == null ? null : Math.round(h.impactoCentavos / 100) });
  }
  return out;
}

/** Minutos desde la medianoche local. */
function minutosLocales(ahora: Date, zona: string): number {
  const partes = new Intl.DateTimeFormat("en-GB", { timeZone: zona, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ahora).split(":");
  return (Number(partes[0]) % 24) * 60 + Number(partes[1]);
}

/** `HH:MM[:SS]` -> minutos. */
function corteAMinutos(corte: string | null): number | null {
  const m = corte ? /^(\d{1,2}):(\d{2})/.exec(corte) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export async function alertarHallazgosCfo(db: TenantDbSession, organizationId: string, ahora: Date, opciones: OpcionesAlertasCfo): Promise<ResultadoAlertasCfo> {
  const vacio = { organizationId, dia: null, zonaHoraria: null, evaluados: 0, candidatos: 0, emitidas: 0, sinNuevas: 0, omitidasPorTope: 0, externasEnviadas: 0, externasFueraDeHorario: 0, fallos: [] as string[] };
  const zona = zonaDeOrganizacion(opciones.sucursales);
  if (zona === null) return { ...vacio, estado: "sin_sucursales" };
  const hoy = diaLocalSucursal(ahora, zona).fecha;
  const ids = opciones.sucursales.map((s) => s.propertyId);
  const repo = opciones.repo ?? new PostgresCfoRepository(db);
  // El dia de negocio cierra en el corte de CADA sucursal (`dia_negocio_corte`): se usa el mas tardio. Antes del corte, el dia que "ayer" nombra aun esta abierto.
  const cobertura = await repo.cobertura({ organizationId, propertyIds: null });
  const cortes = cobertura.filas.map((f) => corteAMinutos(f.corte)).filter((c): c is number => c !== null);
  const corteMin = cortes.length > 0 ? Math.max(...cortes) : 60;
  const dia = sumarDiasFecha(hoy, minutosLocales(ahora, zona) >= corteMin ? -1 : -2);

  const servicio = new ServicioCfo({
    repo,
    organizationId,
    // Organización completa: la sesión de sistema ve todo (incluido «No asignado»); `propertyIdsSql: null` deja que la SQL resuelva el alcance.
    alcance: { propertyIds: ids, todas: true, organizacionCompleta: true },
    propertyIdsSql: null,
    // Los nombres no se usan: el texto de la alerta no lleva nombres de sucursal.
    sucursales: ids.map((propertyId) => ({ propertyId, nombre: "Sucursal", slug: propertyId })),
    ahora,
  });
  const vista = await servicio.resumen({ desde: dia, hasta: dia, comparar: "mismo_dia_semana_4", granularidad: "dia" }, "impacto");
  const base = { ...vacio, dia, zonaHoraria: zona, evaluados: vista.hallazgos.length };
  if (!vista.bloques.ventas) return { ...base, estado: "no_disponible" };

  const todas = seleccionarAlertas(vista.hallazgos, dia, opciones.umbralCentavos);
  const tope = opciones.tope ?? TOPE_ALERTAS_POR_ORG_DIA;
  const elegidas = todas.slice(0, tope);
  const fallos: string[] = [];
  let emitidas = 0;
  let sinNuevas = 0;
  let externasEnviadas = 0;
  let externasFueraDeHorario = 0;
  let noDisponible = false;

  for (const a of elegidas) {
    const h = a.hallazgo;
    try {
      const r =
        a.impactoPesos != null
          ? await emitirNotificacion(db, { evento: "restaurantes.cfo.hallazgo", organizationId, propertyId: h.propertyId, clave: a.clave, severidad: a.severidad, parametros: { tipo: CODIGO_LEGIBLE[h.tipo] ?? h.tipo, impacto: a.impactoPesos }, entidadTipo: "cfo_hallazgo" })
          : await emitirNotificacion(db, { evento: "restaurantes.cfo.hallazgo_sin_monto", organizationId, propertyId: h.propertyId, clave: a.clave, severidad: a.severidad, parametros: { tipo: CODIGO_LEGIBLE[h.tipo] ?? h.tipo }, entidadTipo: "cfo_hallazgo" });
      if (r.estado === "emitida") {
        emitidas++;
        if (opciones.canalExterno) {
          if (dentroDeHorarioExterno(ahora, zona)) {
            try {
              await opciones.canalExterno(a);
              externasEnviadas++;
            } catch (err) {
              fallos.push(`canal_externo:${a.clave}:${err instanceof Error ? err.message.slice(0, 120) : "error"}`);
            }
          } else {
            externasFueraDeHorario++;
          }
        }
      } else if (r.estado === "sin_nuevas") sinNuevas++;
      else if (r.estado === "no_disponible") {
        noDisponible = true;
        break;
      } else fallos.push(`${a.clave}:${r.estado}${r.detalle ? `:${r.detalle.slice(0, 120)}` : ""}`);
    } catch (err) {
      fallos.push(`${a.clave}:${err instanceof Error ? err.message.slice(0, 120) : "error"}`);
    }
  }
  return {
    ...base,
    estado: noDisponible ? "no_disponible" : "ok",
    candidatos: todas.length,
    emitidas,
    sinNuevas,
    omitidasPorTope: Math.max(0, todas.length - elegidas.length),
    externasEnviadas,
    externasFueraDeHorario,
    fallos,
  };
}
