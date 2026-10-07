// Base de conocimiento AUTOMATICA del agente: el equivalente de los documentos `[Auto]` del original (`sync_knowledge_base`), pero GENERADOS
// al momento desde los datos de la cuenta (sucursales y horarios, menu y precios por sucursal, colonias conocidas y politicas). Por eso:
//   * nunca hay texto escrito a mano con precios: cada cifra sale del dato vigente;
//   * se "re-sincronizan solos": no hay copia que envejezca; al cambiar un precio, un horario o una colonia, el siguiente documento ya sale distinto
//     (la `huella` cambia, y la pantalla la muestra para que se vea);
//   * el precio que se COBRA sigue saliendo de `cotizar_pedido`: el documento es referencia para contestar, no una fuente de cobro.
// Los documentos de "ventas" y "personal" del original NO se generan (DOCUMENTOS_AUTO_OMITIDOS: razon en ajustes.ts).
//
// Todo lo de este archivo es puro salvo `cargarDatosConocimiento`, que solo LEE por el repositorio existente (mismos metodos que usa el panel).
import { createHash } from "node:crypto";
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { haversineKmExact } from "../nearest-branch.ts";
import { sanitizeInlineText } from "../text-sanitize.ts";
import type { HorarioSucursal, TurnoHorario } from "../horarios.ts";
import type { RestaurantesRepository } from "../repository.ts";
import type { Branch, BranchPolicy, ColoniaReferencia, KnownZone, PropinaPolitica, StorefrontCatalogRow } from "../types.ts";

export const TIPOS_DOCUMENTO_AUTO = ["sucursales_horarios", "colonias_sucursal", "faq", "menu_precios"] as const;
export type TipoDocumentoAuto = (typeof TIPOS_DOCUMENTO_AUTO)[number];

/** Si la segunda sucursal mas cercana a una colonia queda a menos de esta distancia de la primera, la colonia es ambigua (regla del original). */
export const UMBRAL_COLONIA_AMBIGUA_KM = 1;
/** Tope de caracteres que se inyectan al prompt de voz entre todos los documentos. */
export const TOPE_CARACTERES_PROMPT = 6_000;
const MAX_DOC_CARACTERES = 20_000;

export interface SucursalConocimiento {
  readonly branch: Branch;
  readonly politica: BranchPolicy;
  /** Cantidad de zonas de reparto asignadas (0 = reparte a todas las conocidas o sin configurar). */
  readonly zonasDeReparto: number;
  /** Ids de las colonias conocidas que ESTA sucursal cubre hoy (`branch_delivery_zone`). `undefined` = no se leyo la cobertura (el documento no habla de reparto). */
  readonly zonaIdsReparto?: readonly string[];
}

export interface DatosConocimiento {
  readonly sucursales: readonly SucursalConocimiento[];
  readonly zonas: readonly KnownZone[];
  /** Referencia del piloto por colonia (migracion 056: `ref_*`). `undefined` = la base no tiene la 056: se comporta como antes, sin referencia. */
  readonly referencias?: readonly ColoniaReferencia[];
  /** Menu por sucursal activa (precio y disponibilidad de ESA sucursal). */
  readonly menus: readonly { readonly propertyId: string; readonly filas: readonly StorefrontCatalogRow[] }[];
}

export interface DocumentoAuto {
  readonly tipo: TipoDocumentoAuto;
  readonly titulo: string;
  readonly contenido: string;
  readonly caracteres: number;
  /** sha256 del contenido: cambia cuando cambia cualquier dato del que sale. */
  readonly huella: string;
  /** Sin datos de los que generar nada (la pantalla dice por que). */
  readonly vacio: boolean;
  readonly motivoVacio: string | null;
  /** Version COMPACTA para el prompt de voz (tope de caracteres); si no existe, el prompt usa `contenido`. El panel muestra `contenido`. */
  readonly contenidoPrompt?: string;
  /** `true` = el documento pasaba del maximo y se recorto por renglones (el final lo declara); nunca se corta a medias sin avisar. */
  readonly truncado?: boolean;
}

export interface AlertaColonia {
  readonly colonia: string;
  readonly sucursales: readonly [string, string];
  readonly diferenciaKm: number;
}

export interface ConocimientoAuto {
  readonly documentos: readonly DocumentoAuto[];
  readonly alertasColonias: readonly AlertaColonia[];
  /** Colonias que no se pudieron asignar (ninguna sucursal activa con coordenadas). */
  readonly coloniasSinSucursal: number;
  /** Huella de todo el conjunto (cambia si cambia cualquier documento). */
  readonly huella: string;
}

const sha = (t: string): string => createHash("sha256").update(t).digest("hex");
const limpio = (t: string | null | undefined, max = 200): string => (t ? sanitizeInlineText(t, max) : "");
const dinero = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"] as const;

function rangoDeDias(dias: readonly number[]): string {
  const orden = [...new Set(dias)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  const grupos: number[][] = [];
  for (const d of orden) {
    const ult = grupos[grupos.length - 1];
    if (ult && d === ult[ult.length - 1]! + 1) ult.push(d);
    else grupos.push([d]);
  }
  const partes = grupos.map((g) => (g.length >= 3 ? `${DIAS[g[0]!]} a ${DIAS[g[g.length - 1]!]}` : g.map((d) => DIAS[d]).join(" y ")));
  return partes.join(" y ");
}

function textoTurno(t: TurnoHorario): string {
  const cruza = t.cierra <= t.abre;
  return `${rangoDeDias(t.dias)} de ${t.abre} a ${t.cierra}${cruza ? " (cierra ya pasada la medianoche)" : ""}`;
}

/** "lunes a viernes de 12:00 a 22:00; sábado de 12:00 a 23:00". Vacio si no hay horario configurado. */
export function textoDeHorario(horario: HorarioSucursal | null): string {
  if (!horario || horario.length === 0) return "";
  return horario.map(textoTurno).join("; ");
}

const TEXTO_PROPINA: Readonly<Record<PropinaPolitica, string>> = {
  nunca: "no se acepta propina",
  siempre: "la propina se agrega a todos los pedidos",
  solo_tarjeta: "la propina solo se agrega en pagos con tarjeta",
};

function envolver(tipo: TipoDocumentoAuto, titulo: string, lineas: readonly string[], motivoVacio: string, contenidoPrompt?: string): DocumentoAuto {
  if (lineas.length === 0) return { tipo, titulo, contenido: "", caracteres: 0, huella: sha(""), vacio: true, motivoVacio };
  let contenido = lineas.join("\n");
  let truncado = false;
  if (contenido.length > MAX_DOC_CARACTERES) {
    // Se recorta por renglones completos y se DECLARA cuantos faltan (antes cortaba a media linea sin avisar).
    truncado = true;
    const conservadas: string[] = [];
    let usados = 0;
    for (const l of lineas) {
      if (usados + l.length + 1 > MAX_DOC_CARACTERES - 90) break;
      conservadas.push(l);
      usados += l.length + 1;
    }
    contenido = `${conservadas.join("\n")}\n… (recortado por tamaño: faltan ${lineas.length - conservadas.length} renglones; la lista completa se consulta en vivo)`;
  }
  const huella = sha(contenidoPrompt === undefined ? contenido : `${contenido}\n--prompt--\n${contenidoPrompt}`);
  return {
    tipo, titulo, contenido, caracteres: contenido.length, huella, vacio: false, motivoVacio: null,
    ...(contenidoPrompt === undefined ? {} : { contenidoPrompt }),
    ...(truncado ? { truncado: true } : {}),
  };
}

function docSucursales(d: DatosConocimiento): DocumentoAuto {
  const lineas: string[] = [];
  for (const s of d.sucursales.filter((x) => x.branch.status === "active")) {
    const b = s.branch;
    lineas.push(`## ${limpio(b.name, 120)}`);
    if (b.address) lineas.push(`Dirección: ${limpio(b.address)}`);
    if (b.phone) lineas.push(`Teléfono: ${limpio(b.phone, 40)}`);
    const horario = textoDeHorario(s.politica.horario);
    lineas.push(horario ? `Horario: ${horario}` : "Horario: no configurado (no prometas un horario; ofrece confirmar con la sucursal).");
    if (s.politica.pedidoMinimoDomicilio !== null) lineas.push(`Pedido mínimo a domicilio: ${dinero(s.politica.pedidoMinimoDomicilio)}`);
    if (s.politica.pedidoMinimoRecoger !== null) lineas.push(`Pedido mínimo para recoger: ${dinero(s.politica.pedidoMinimoRecoger)}`);
    if (s.politica.propinaPolitica) lineas.push(`Propina: ${TEXTO_PROPINA[s.politica.propinaPolitica]}.`);
    lineas.push("");
  }
  while (lineas.length > 0 && lineas[lineas.length - 1] === "") lineas.pop();
  return envolver("sucursales_horarios", "Sucursales y horarios", lineas, "No hay sucursales activas.");
}

interface OpcionSucursal {
  readonly nombre: string;
  /** `null` = la referencia del piloto no trae km para esta opcion (no se inventa). */
  readonly km: number | null;
}

interface Asignacion {
  readonly colonia: string;
  readonly mas: OpcionSucursal | null;
  readonly segunda: OpcionSucursal | null;
  /** De donde sale la sucursal sugerida: calculo con coordenadas propias o referencia del piloto (migracion 056). */
  readonly origenKm: "calculada" | "piloto" | null;
  /** Sucursales que REPARTEN y cubren la colonia hoy (cobertura explicita); `null` = no se leyo, o la colonia tiene coordenadas y se atiende por km (no se dice nada de reparto). */
  readonly cubre: readonly string[] | null;
}

/** Sucursal que hoy puede repartir a domicilio: activa y que no es "solo recoger" (decision 7-oct: la mas cercana entre las que REPARTEN). */
const reparte = (s: SucursalConocimiento): boolean => s.branch.status === "active" && s.politica.aceptaDomicilio !== false;

/**
 * Cobertura de una colonia, con la MISMA regla que `assignBranch`: la cobertura explicita (`branch_delivery_zone`) de las sucursales que reparten; una colonia
 * CON coordenadas y sin cobertura explicita se atiende por km puros (la mas cercana que reparte), asi que no esta "por confirmar".
 * `explicita` = nombres de las que la cubren; `null` = no se leyo la cobertura.
 */
function coberturaDeZona(d: DatosConocimiento, z: KnownZone): { readonly explicita: readonly string[] | null; readonly porKm: boolean } {
  const repartidoras = d.sucursales.filter(reparte);
  const leida = repartidoras.length > 0 && repartidoras.every((s) => s.zonaIdsReparto !== undefined);
  const explicita = leida
    ? repartidoras
        .filter((s) => (s.zonaIdsReparto as readonly string[]).includes(z.id))
        .map((s) => limpio(s.branch.name, 120))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    : null;
  const porKm = z.lat !== null && z.lng !== null && repartidoras.some((s) => s.branch.lat !== null && s.branch.lng !== null) && (explicita === null || explicita.length === 0);
  return { explicita, porKm };
}

function asignarColonias(d: DatosConocimiento): { readonly asignaciones: readonly Asignacion[]; readonly sinSucursal: number } {
  const activas = d.sucursales.filter(reparte);
  const candidatas = activas.filter((s) => s.branch.lat !== null && s.branch.lng !== null);
  const referencias = new Map((d.referencias ?? []).map((r) => [r.zoneId, r] as const));
  const porSlug = new Map(activas.map((s) => [s.branch.slug, s] as const));
  const asignaciones: Asignacion[] = [];
  let sinSucursal = 0;
  for (const z of d.zonas) {
    const { explicita, porKm } = coberturaDeZona(d, z);
    const cubre = porKm ? null : explicita;
    let mas: OpcionSucursal | null = null;
    let segunda: OpcionSucursal | null = null;
    let origenKm: Asignacion["origenKm"] = null;
    if (candidatas.length > 0 && z.lat !== null && z.lng !== null) {
      const zLat = z.lat;
      const zLng = z.lng;
      const ordenadas = candidatas
        .map((s) => ({ nombre: limpio(s.branch.name, 120), km: haversineKmExact(zLat, zLng, s.branch.lat as number, s.branch.lng as number) }))
        .sort((a, b) => a.km - b.km || a.nombre.localeCompare(b.nombre));
      mas = ordenadas[0]!;
      segunda = ordenadas[1] ?? null;
      origenKm = "calculada";
    } else {
      // Sin coordenadas propias (migracion 056) no se puede medir: se usa lo que el piloto dijo (sucursal mas cercana y segunda con sus km), solo si esa
      // sucursal existe y esta ACTIVA. Nunca se inventa un punto ni una distancia.
      const ref = referencias.get(z.id);
      const opciones: OpcionSucursal[] = [];
      if (ref) {
        for (const [slug, kmRef] of [[ref.refSucursalSlug, ref.refKm], [ref.ref2SucursalSlug, ref.ref2Km]] as const) {
          const sucursalRef = slug ? porSlug.get(slug) : undefined;
          if (sucursalRef) opciones.push({ nombre: limpio(sucursalRef.branch.name, 120), km: kmRef });
        }
      }
      mas = opciones[0] ?? null;
      segunda = opciones[1] ?? null;
      if (mas) origenKm = "piloto";
    }
    if (!mas) sinSucursal += 1;
    // Sin sucursal sugerida y sin ninguna que la cubra no hay nada que decir de la colonia.
    if (!mas && (cubre === null || cubre.length === 0)) continue;
    asignaciones.push({ colonia: limpio(z.name, 120), mas, segunda, origenKm, cubre });
  }
  asignaciones.sort((a, b) => a.colonia.localeCompare(b.colonia, "es"));
  return { asignaciones, sinSucursal };
}

const km = (n: number): string => `${(Math.round(n * 10) / 10).toFixed(1)} km`;
const kmOpcion = (o: OpcionSucursal, origen: Asignacion["origenKm"]): string =>
  o.km === null ? (origen === "piloto" ? "piloto" : "") : `${km(o.km)}${origen === "piloto" ? ", piloto" : ""}`;
const conKm = (o: OpcionSucursal, origen: Asignacion["origenKm"]): string => {
  const k = kmOpcion(o, origen);
  return k === "" ? o.nombre : `${o.nombre} (${k})`;
};
const textoReparto = (cubre: readonly string[] | null): string => (cubre === null ? "" : cubre.length > 0 ? ` Reparto: cubre ${cubre.join(" y ")}.` : " Reparto por confirmar.");

/**
 * Version COMPACTA para el prompt de voz (tope de 6,000 caracteres): una linea por sucursal sugerida con sus colonias, `*` en las ambiguas (menos de 1 km entre la
 * 1.a y la 2.a) y una linea final de reglas. El detalle (km, 2.a opcion, reparto) queda en el documento largo del panel y en la herramienta buscar_sucursal_cercana.
 */
function compactoParaPrompt(asignaciones: readonly Asignacion[]): string | undefined {
  const porSucursal = new Map<string, string[]>();
  for (const a of asignaciones) {
    if (!a.mas) continue;
    const ambigua = a.segunda !== null && a.mas.km !== null && a.segunda.km !== null && a.segunda.km - a.mas.km < UMBRAL_COLONIA_AMBIGUA_KM;
    porSucursal.set(a.mas.nombre, [...(porSucursal.get(a.mas.nombre) ?? []), `${a.colonia}${ambigua ? "*" : ""}`]);
  }
  if (porSucursal.size === 0) return undefined;
  const lineas = [...porSucursal.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([sucursal, colonias]) => `${sucursal}: ${colonias.join(", ")}`);
  lineas.push("Si la colonia no está en la lista, usa buscar_sucursal_cercana. * = ambigua (menos de 1 km entre las 2 más cercanas): confirma con el cliente. Es cercanía, no promete reparto.");
  return lineas.join("\n");
}

function docColonias(
  asignaciones: readonly Asignacion[],
  sinSucursal: number,
  hayReferencias: boolean,
): { readonly doc: DocumentoAuto; readonly alertas: readonly AlertaColonia[] } {
  const alertas: AlertaColonia[] = [];
  const lineas = asignaciones.map((a) => {
    const reparto = textoReparto(a.cubre);
    if (!a.mas) return `${a.colonia}: sin sucursal sugerida (no hay distancia).${reparto}`;
    const diferencia = a.segunda && a.mas.km !== null && a.segunda.km !== null ? a.segunda.km - a.mas.km : null;
    if (a.segunda && diferencia !== null && diferencia < UMBRAL_COLONIA_AMBIGUA_KM) {
      alertas.push({ colonia: a.colonia, sucursales: [a.mas.nombre, a.segunda.nombre], diferenciaKm: Math.round(diferencia * 10) / 10 });
      return `${a.colonia}: ${conKm(a.mas, a.origenKm)} o ${conKm(a.segunda, a.origenKm)}; quedan a menos de ${UMBRAL_COLONIA_AMBIGUA_KM} km de diferencia, pregunta al cliente cuál le queda mejor (ADVERTENCIA: colonia ambigua).${reparto}`;
    }
    if (a.origenKm === "piloto") return `${a.colonia}: sugerida ${conKm(a.mas, a.origenKm)}${a.segunda ? `, 2.ª ${conKm(a.segunda, a.origenKm)}` : ""}.${reparto}`;
    return `${a.colonia}: ${conKm(a.mas, a.origenKm)}.${reparto}`;
  });
  const motivo =
    sinSucursal === 0
      ? "No hay colonias conocidas configuradas."
      : hayReferencias
        ? "Hay colonias, pero ninguna tiene coordenadas con sucursales activas con coordenadas ni referencia del piloto hacia una sucursal activa."
        : "Hay colonias, pero ninguna sucursal activa tiene coordenadas.";
  return { doc: envolver("colonias_sucursal", "Colonia → sucursal más cercana", lineas, motivo, compactoParaPrompt(asignaciones)), alertas };
}

function docFaq(d: DatosConocimiento): DocumentoAuto {
  const activas = d.sucursales.filter((s) => s.branch.status === "active");
  const lineas: string[] = [];
  const porHorario = activas.filter((s) => textoDeHorario(s.politica.horario) !== "");
  if (porHorario.length > 0) {
    lineas.push("P: ¿A qué hora abren y cierran?");
    lineas.push(`R: ${porHorario.map((s) => `${limpio(s.branch.name, 120)}: ${textoDeHorario(s.politica.horario)}`).join(" | ")}.`);
  }
  const porDireccion = activas.filter((s) => s.branch.address);
  if (porDireccion.length > 0) {
    lineas.push("P: ¿Dónde están?");
    lineas.push(`R: ${porDireccion.map((s) => `${limpio(s.branch.name, 120)}: ${limpio(s.branch.address)}`).join(" | ")}.`);
  }
  const porTelefono = activas.filter((s) => s.branch.phone);
  if (porTelefono.length > 0) {
    lineas.push("P: ¿Cuál es el teléfono de la sucursal?");
    lineas.push(`R: ${porTelefono.map((s) => `${limpio(s.branch.name, 120)}: ${limpio(s.branch.phone, 40)}`).join(" | ")}.`);
  }
  const minimos = activas.filter((s) => s.politica.pedidoMinimoDomicilio !== null || s.politica.pedidoMinimoRecoger !== null);
  if (minimos.length > 0) {
    lineas.push("P: ¿Hay pedido mínimo?");
    lineas.push(
      `R: ${minimos
        .map((s) => {
          const partes = [
            s.politica.pedidoMinimoDomicilio !== null ? `a domicilio ${dinero(s.politica.pedidoMinimoDomicilio)}` : null,
            s.politica.pedidoMinimoRecoger !== null ? `para recoger ${dinero(s.politica.pedidoMinimoRecoger)}` : null,
          ].filter((x): x is string => x !== null);
          return `${limpio(s.branch.name, 120)}: ${partes.join(" y ")}`;
        })
        .join(" | ")}.`,
    );
  }
  const conPropina = activas.filter((s) => s.politica.propinaPolitica);
  if (conPropina.length > 0) {
    lineas.push("P: ¿Se puede dejar propina?");
    lineas.push(`R: ${conPropina.map((s) => `${limpio(s.branch.name, 120)}: ${TEXTO_PROPINA[s.politica.propinaPolitica as PropinaPolitica]}`).join(" | ")}.`);
  }
  if (d.zonas.length > 0) {
    const coberturaLeida = d.sucursales.filter(reparte).length > 0 && d.sucursales.filter(reparte).every((x) => x.zonaIdsReparto !== undefined);
    const conRepartoIds = new Set(d.zonas.filter((z) => {
      const c = coberturaDeZona(d, z);
      return (c.explicita !== null && c.explicita.length > 0) || c.porKm;
    }).map((z) => z.id));
    const limpias = d.zonas.map((z) => ({ id: z.id, nombre: limpio(z.name, 80) })).filter((z) => z.nombre !== "");
    const porNombre = (a: { nombre: string }, b: { nombre: string }): number => a.nombre.localeCompare(b.nombre, "es");
    lineas.push("P: ¿Entregan en mi colonia?");
    if (coberturaLeida) {
      // Se separan las colonias con reparto confirmado (alguna sucursal ACTIVA las cubre hoy) de las que quedan por confirmar; solo las primeras se nombran.
      const conReparto = limpias.filter((z) => conRepartoIds.has(z.id)).sort(porNombre);
      const porConfirmar = limpias.length - conReparto.length;
      const visibles = conReparto.slice(0, 40).map((z) => z.nombre);
      const lista = conReparto.length === 0 ? "" : conReparto.length > visibles.length ? ` (algunas: ${visibles.join(", ")})` : `: ${visibles.join(", ")}`;
      lineas.push(
        `R: Reconocemos ${limpias.length} colonias: ${conReparto.length} con reparto confirmado${lista}${porConfirmar > 0 ? `; ${porConfirmar} reconocidas con reparto por confirmar (no prometas la entrega: confirma con la sucursal)` : ""}. Si la colonia no está en la lista, pide una referencia cercana y confirma la sucursal.`,
      );
    } else {
      const nombres = limpias.sort(porNombre).map((z) => z.nombre);
      const visibles = nombres.slice(0, 40);
      lineas.push(`R: Reconocemos ${nombres.length} colonias${nombres.length > visibles.length ? ` (algunas: ${visibles.join(", ")})` : `: ${visibles.join(", ")}`}. Si la colonia no está en la lista, pide una referencia cercana y confirma la sucursal.`);
    }
  }
  return envolver("faq", "Preguntas frecuentes", lineas, "Todavía no hay horarios, direcciones, políticas ni colonias de las que generar respuestas.");
}

function docMenu(d: DatosConocimiento): DocumentoAuto {
  const nombreSucursal = new Map(d.sucursales.map((s) => [s.branch.propertyId, limpio(s.branch.name, 120)]));
  // producto -> { categoria, orden, precios por sucursal }
  interface Item {
    readonly nombre: string;
    readonly categoria: string;
    readonly ordenCategoria: number;
    readonly orden: number;
    readonly noDomicilio: boolean;
    readonly precios: Map<string, number>;
  }
  const items = new Map<string, Item>();
  const sucursalesConMenu = new Set<string>();
  for (const m of d.menus) {
    for (const f of m.filas) {
      if (!f.isAvailable) continue;
      sucursalesConMenu.add(m.propertyId);
      const it = items.get(f.id) ?? { nombre: limpio(f.name, 120), categoria: limpio(f.categoryName ?? "Otros", 80) || "Otros", ordenCategoria: f.categoryDisplayOrder, orden: f.displayOrder, noDomicilio: f.noDomicilio, precios: new Map<string, number>() };
      it.precios.set(m.propertyId, f.price);
      items.set(f.id, it);
    }
  }
  const lineas: string[] = [];
  const porCategoria = new Map<string, Item[]>();
  for (const it of items.values()) porCategoria.set(it.categoria, [...(porCategoria.get(it.categoria) ?? []), it]);
  const categorias = [...porCategoria.entries()].sort((a, b) => a[1][0]!.ordenCategoria - b[1][0]!.ordenCategoria || a[0].localeCompare(b[0], "es"));
  for (const [categoria, lista] of categorias) {
    lineas.push(`## ${categoria}`);
    for (const it of lista.sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre, "es"))) {
      const precios = [...it.precios.entries()];
      const distintos = new Set(precios.map(([, p]) => p));
      const detalle =
        distintos.size === 1 && precios.length === sucursalesConMenu.size
          ? dinero(precios[0]![1])
          : precios.map(([pid, p]) => `${nombreSucursal.get(pid) ?? "Sucursal"} ${dinero(p)}`).join(", ");
      lineas.push(`- ${it.nombre}: ${detalle}${it.noDomicilio ? " (solo en sucursal, no se envía a domicilio)" : ""}`);
    }
  }
  if (lineas.length > 0) lineas.unshift("Referencia para contestar. El total que se cobra SIEMPRE sale de cotizar_pedido, no de esta lista.", "");
  return envolver("menu_precios", "Menú y precios", lineas, "No hay productos disponibles en las sucursales activas.");
}

/** Genera los documentos desde los datos. Puro y determinista: mismos datos, mismos documentos y misma huella. */
export function generarConocimientoAuto(datos: DatosConocimiento): ConocimientoAuto {
  const { asignaciones, sinSucursal } = asignarColonias(datos);
  const colonias = docColonias(asignaciones, sinSucursal, (datos.referencias ?? []).length > 0);
  const documentos = [docSucursales(datos), colonias.doc, docFaq(datos), docMenu(datos)];
  return { documentos, alertasColonias: colonias.alertas, coloniasSinSucursal: sinSucursal, huella: sha(documentos.map((x) => `${x.tipo}:${x.huella}`).join("|")) };
}

/** Lee los datos con los metodos de LECTURA que ya usa el panel (cada uno ya degrada solo contra la base sin migrar). */
export async function cargarDatosConocimiento(repo: RestaurantesRepository, organizationId: string): Promise<DatosConocimiento> {
  const branches = await repo.listBranchesForOrganizationAdmin(organizationId);
  const zonas = await repo.listKnownZones(organizationId);
  // Referencia del piloto (migracion 056): contra la base sin migrar `disponible:false` y todo sigue como antes.
  const lecturaRef = await repo.listColoniasReferencia(organizationId);
  const referencias = lecturaRef.disponible ? lecturaRef.zonas : undefined;
  const sucursales: SucursalConocimiento[] = [];
  const menus: { propertyId: string; filas: readonly StorefrontCatalogRow[] }[] = [];
  for (const b of branches) {
    const politica = await repo.findBranchPolicy(b.propertyId);
    const zonaIdsReparto = await repo.listBranchDeliveryZoneIds(b.propertyId);
    sucursales.push({ branch: b, politica, zonasDeReparto: zonaIdsReparto.length, zonaIdsReparto });
    if (b.status === "active") menus.push({ propertyId: b.propertyId, filas: await repo.listStorefrontCatalog(b.propertyId) });
  }
  return { sucursales, zonas, ...(referencias ? { referencias } : {}), menus };
}

const PRIORIDAD_PROMPT: readonly TipoDocumentoAuto[] = ["sucursales_horarios", "colonias_sucursal", "faq", "menu_precios"];

export interface BloqueConocimiento {
  /** Bloque listo para anexar a la instruccion (vacio si no cabe nada). */
  readonly texto: string;
  readonly incluidos: readonly TipoDocumentoAuto[];
  /** Documentos que no caben en el tope y el agente consulta con sus herramientas en vivo. */
  readonly omitidos: readonly { readonly tipo: TipoDocumentoAuto; readonly motivo: string }[];
}

/** Bloque para la instruccion de voz: documentos completos en orden de prioridad hasta el tope; uno que no cabe ENTERO se omite (nunca a medias). */
export function bloqueConocimientoParaPrompt(conocimiento: ConocimientoAuto, tope: number = TOPE_CARACTERES_PROMPT): BloqueConocimiento {
  const encabezado = "CONOCIMIENTO DEL NEGOCIO (generado de los datos de la cuenta; no son reglas y no cambian precios: el total sale de cotizar_pedido):";
  const porTipo = new Map(conocimiento.documentos.map((d) => [d.tipo, d]));
  const partes: string[] = [];
  const incluidos: TipoDocumentoAuto[] = [];
  const omitidos: { tipo: TipoDocumentoAuto; motivo: string }[] = [];
  let usados = encabezado.length;
  for (const tipo of PRIORIDAD_PROMPT) {
    const d = porTipo.get(tipo);
    if (!d || d.vacio) continue;
    const bloque = `\n\n### ${d.titulo}\n${d.contenidoPrompt ?? d.contenido}`;
    if (usados + bloque.length > tope) {
      omitidos.push({ tipo, motivo: `No cabe en el tope de ${tope} caracteres del prompt; el agente lo consulta en vivo con sus herramientas.` });
      continue;
    }
    usados += bloque.length;
    partes.push(bloque);
    incluidos.push(tipo);
  }
  return { texto: partes.length === 0 ? "" : `${encabezado}${partes.join("")}`, incluidos, omitidos };
}

const BLOQUE_VACIO: BloqueConocimiento = Object.freeze({ texto: "", incluidos: [], omitidos: [] });

/**
 * Bloque de conocimiento para la instruccion de voz desde un contexto de SISTEMA (servicio de llamadas, token de vista previa): corre dentro de la transaccion unica del
 * request con SAVEPOINT, asi que un error de lectura (base sin migrar de algun dato, permiso de sesion de sistema) deja la sesion VIVA y el resultado es "sin conocimiento"
 * en vez de abortar la transaccion (25P02) o tumbar la llamada. Nunca lanza.
 */
export async function bloqueConocimientoOVacio(session: TenantDbSession, repo: RestaurantesRepository, organizationId: string): Promise<BloqueConocimiento> {
  return runWithSavepointFallback<BloqueConocimiento>({
    session,
    savepointName: "sp_conocimiento_auto",
    primary: async () => bloqueConocimientoParaPrompt(generarConocimientoAuto(await cargarDatosConocimiento(repo, organizationId))),
    isRecoverable: () => true,
    fallback: async (err) => {
      const codigo = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "desconocido";
      console.warn(`conocimiento automatico: no se pudo generar para el prompt (SQLSTATE/codigo ${codigo}); la instruccion sale sin el bloque.`);
      return BLOQUE_VACIO;
    },
  });
}
