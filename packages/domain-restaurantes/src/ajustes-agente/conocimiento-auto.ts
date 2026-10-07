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
import type { Branch, BranchPolicy, KnownZone, PropinaPolitica, StorefrontCatalogRow } from "../types.ts";

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
}

export interface DatosConocimiento {
  readonly sucursales: readonly SucursalConocimiento[];
  readonly zonas: readonly KnownZone[];
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

function envolver(tipo: TipoDocumentoAuto, titulo: string, lineas: readonly string[], motivoVacio: string): DocumentoAuto {
  if (lineas.length === 0) return { tipo, titulo, contenido: "", caracteres: 0, huella: sha(""), vacio: true, motivoVacio };
  let contenido = lineas.join("\n");
  if (contenido.length > MAX_DOC_CARACTERES) contenido = `${contenido.slice(0, MAX_DOC_CARACTERES - 1).trimEnd()}…`;
  return { tipo, titulo, contenido, caracteres: contenido.length, huella: sha(contenido), vacio: false, motivoVacio: null };
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

interface Asignacion {
  readonly colonia: string;
  readonly mas: { readonly nombre: string; readonly km: number };
  readonly segunda: { readonly nombre: string; readonly km: number } | null;
}

function asignarColonias(d: DatosConocimiento): { readonly asignaciones: readonly Asignacion[]; readonly sinSucursal: number } {
  const candidatas = d.sucursales.filter((s) => s.branch.status === "active" && s.branch.lat !== null && s.branch.lng !== null);
  const asignaciones: Asignacion[] = [];
  let sinSucursal = 0;
  for (const z of d.zonas) {
    // Una colonia sin coordenadas propias (migracion 056) no se puede ordenar por distancia: queda sin sucursal sugerida, nunca se inventa una.
    if (candidatas.length === 0 || z.lat === null || z.lng === null) {
      sinSucursal += 1;
      continue;
    }
    const zLat = z.lat;
    const zLng = z.lng;
    const ordenadas = candidatas
      .map((s) => ({ nombre: limpio(s.branch.name, 120), km: haversineKmExact(zLat, zLng, s.branch.lat as number, s.branch.lng as number) }))
      .sort((a, b) => a.km - b.km || a.nombre.localeCompare(b.nombre));
    asignaciones.push({ colonia: limpio(z.name, 120), mas: ordenadas[0]!, segunda: ordenadas[1] ?? null });
  }
  asignaciones.sort((a, b) => a.colonia.localeCompare(b.colonia, "es"));
  return { asignaciones, sinSucursal };
}

const km = (n: number): string => `${(Math.round(n * 10) / 10).toFixed(1)} km`;

function docColonias(asignaciones: readonly Asignacion[], sinSucursal: number): { readonly doc: DocumentoAuto; readonly alertas: readonly AlertaColonia[] } {
  const alertas: AlertaColonia[] = [];
  const lineas = asignaciones.map((a) => {
    if (a.segunda && a.segunda.km - a.mas.km < UMBRAL_COLONIA_AMBIGUA_KM) {
      alertas.push({ colonia: a.colonia, sucursales: [a.mas.nombre, a.segunda.nombre], diferenciaKm: Math.round((a.segunda.km - a.mas.km) * 10) / 10 });
      return `${a.colonia}: ${a.mas.nombre} (${km(a.mas.km)}) o ${a.segunda.nombre} (${km(a.segunda.km)}); quedan a menos de ${UMBRAL_COLONIA_AMBIGUA_KM} km de diferencia, pregunta al cliente cuál le queda mejor.`;
    }
    return `${a.colonia}: ${a.mas.nombre} (${km(a.mas.km)}).`;
  });
  const motivo = sinSucursal > 0 ? "Hay colonias, pero ninguna sucursal activa tiene coordenadas." : "No hay colonias conocidas configuradas.";
  return { doc: envolver("colonias_sucursal", "Colonia → sucursal más cercana", lineas, motivo), alertas };
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
    const nombres = d.zonas.map((z) => limpio(z.name, 80)).filter((n) => n !== "").sort((a, b) => a.localeCompare(b, "es"));
    const visibles = nombres.slice(0, 40);
    lineas.push("P: ¿Entregan en mi colonia?");
    lineas.push(`R: Reconocemos ${nombres.length} colonias${nombres.length > visibles.length ? ` (algunas: ${visibles.join(", ")})` : `: ${visibles.join(", ")}`}. Si la colonia no está en la lista, pide una referencia cercana y confirma la sucursal.`);
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
  const colonias = docColonias(asignaciones, sinSucursal);
  const documentos = [docSucursales(datos), colonias.doc, docFaq(datos), docMenu(datos)];
  return { documentos, alertasColonias: colonias.alertas, coloniasSinSucursal: sinSucursal, huella: sha(documentos.map((x) => `${x.tipo}:${x.huella}`).join("|")) };
}

/** Lee los datos con los metodos de LECTURA que ya usa el panel (cada uno ya degrada solo contra la base sin migrar). */
export async function cargarDatosConocimiento(repo: RestaurantesRepository, organizationId: string): Promise<DatosConocimiento> {
  const branches = await repo.listBranchesForOrganizationAdmin(organizationId);
  const zonas = await repo.listKnownZones(organizationId);
  const sucursales: SucursalConocimiento[] = [];
  const menus: { propertyId: string; filas: readonly StorefrontCatalogRow[] }[] = [];
  for (const b of branches) {
    const politica = await repo.findBranchPolicy(b.propertyId);
    const zonasDeReparto = (await repo.listBranchDeliveryZoneIds(b.propertyId)).length;
    sucursales.push({ branch: b, politica, zonasDeReparto });
    if (b.status === "active") menus.push({ propertyId: b.propertyId, filas: await repo.listStorefrontCatalog(b.propertyId) });
  }
  return { sucursales, zonas, menus };
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
    const bloque = `\n\n### ${d.titulo}\n${d.contenido}`;
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
