import { OrderValidationError } from "../errors.ts";
import { validarHorario } from "../horarios.ts";
import { MOTIVOS_ESCALACION_DESACTIVABLES } from "../types.ts";
import { ESQUEMA_RESTAURANTE_VERSION, type RestauranteConfig } from "./tipos.ts";

export interface ResultadoValidacion {
  readonly ok: boolean;
  /** Bloquean la generacion. */
  readonly errores: readonly string[];
  /** No bloquean; van a la pantalla de revision. */
  readonly advertencias: readonly string[];
}

export interface OpcionesValidacion {
  /** `true` = solo se va a generar el perfil (prompt/voz): no exige menu ni horarios (instancia PM, cuyo menu vive en su seed). */
  readonly soloPerfil?: boolean;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const norm = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

function zonaValida(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("es-MX", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validacion determinista de la config: la misma entrada da siempre el mismo veredicto (sin reloj, red ni azar). */
export function validarConfig(c: RestauranteConfig, op: OpcionesValidacion = {}): ResultadoValidacion {
  const e: string[] = [];
  const a: string[] = [];
  if (c.schemaVersion !== ESQUEMA_RESTAURANTE_VERSION) e.push(`schemaVersion ${String(c.schemaVersion)} no soportada (se espera ${ESQUEMA_RESTAURANTE_VERSION}).`);
  if (!SLUG_RE.test(c.slug)) e.push(`slug "${c.slug}" invalido (minusculas, numeros y guiones).`);
  if (!c.marca.nombre.trim()) e.push("marca.nombre vacio.");
  if (!c.marca.tiempoEntrega.trim()) e.push("marca.tiempoEntrega vacio: el agente no puede inventar tiempos.");
  if (!c.negocio.giro.trim() || !c.negocio.ciudad.trim()) e.push("negocio.giro y negocio.ciudad son obligatorios.");
  if (!zonaValida(c.negocio.zonaHoraria)) e.push(`negocio.zonaHoraria "${c.negocio.zonaHoraria}" no es una zona IANA valida.`);
  const p = c.politicas;
  if (!Number.isInteger(p.pedidoMinimoDomicilio) || p.pedidoMinimoDomicilio < 0 || p.pedidoMinimoDomicilio > 5000) e.push("politicas.pedidoMinimoDomicilio debe ser un entero de 0 a 5000.");
  if (p.costoEnvio !== 0) e.push("politicas.costoEnvio distinto de 0 no esta soportado en la Fase A (el prompt afirma envio sin costo).");
  if (p.urlFacturacion !== null && !/^https:\/\/\S{4,300}$/.test(p.urlFacturacion)) e.push("politicas.urlFacturacion debe ser https o null.");
  for (const m of p.motivosDesactivados) if (!(MOTIVOS_ESCALACION_DESACTIVABLES as readonly string[]).includes(m)) e.push(`politicas.motivosDesactivados: "${m}" no es desactivable.`);

  const slugs = new Set<string>();
  for (const s of c.sucursales) {
    if (!SLUG_RE.test(s.slug)) e.push(`sucursal "${s.nombre}": slug "${s.slug}" invalido.`);
    if (slugs.has(s.slug)) e.push(`sucursal duplicada: ${s.slug}.`);
    slugs.add(s.slug);
    try {
      validarHorario(s.horario);
    } catch (err) {
      e.push(`sucursal ${s.slug}: ${err instanceof OrderValidationError || err instanceof Error ? err.message : "horario invalido"}`);
    }
    if (s.activa && s.horario.length === 0 && !op.soloPerfil) a.push(`sucursal ${s.slug}: sin horario capturado.`);
  }
  if (c.sucursales.length === 0) e.push("Se necesita al menos una sucursal.");
  else if (!c.sucursales.some((s) => s.activa)) e.push("Ninguna sucursal activa.");

  if (!op.soloPerfil) {
    const cats = new Set(c.menu.categorias.map(norm));
    if (c.menu.productos.length === 0) e.push("El menu no tiene productos.");
    const nombres = new Map<string, string>();
    const aliasDe = new Map<string, string>();
    for (const pr of c.menu.productos) {
      const k = norm(pr.nombre);
      if (!k) e.push("Producto sin nombre.");
      if (nombres.has(k)) e.push(`Producto duplicado: "${pr.nombre}".`);
      nombres.set(k, pr.nombre);
      if (!cats.has(norm(pr.categoria))) e.push(`"${pr.nombre}": categoria "${pr.categoria}" no existe en menu.categorias.`);
      if (!Number.isInteger(pr.precio) || pr.precio <= 0) e.push(`"${pr.nombre}": precio ${pr.precio} invalido (entero positivo en pesos).`);
      else if (pr.precio > 3000) a.push(`"${pr.nombre}": precio ${pr.precio} inusualmente alto, confirmar.`);
      for (const [sl, v] of Object.entries(pr.precioPorSucursal ?? {})) {
        if (!slugs.has(sl)) e.push(`"${pr.nombre}": precio para sucursal inexistente "${sl}".`);
        if (!Number.isInteger(v) || v <= 0) e.push(`"${pr.nombre}": precio ${v} invalido en ${sl}.`);
      }
      for (const al of pr.alias ?? []) {
        const ka = norm(al);
        const previo = aliasDe.get(ka);
        if (previo && previo !== pr.nombre) e.push(`Alias "${al}" choca entre "${previo}" y "${pr.nombre}".`);
        else if (nombres.has(ka) && nombres.get(ka) !== pr.nombre) e.push(`Alias "${al}" de "${pr.nombre}" es el nombre de otro producto.`);
        aliasDe.set(ka, pr.nombre);
      }
    }
    for (const cat of c.menu.categorias) if (!c.menu.productos.some((x) => norm(x.categoria) === norm(cat))) a.push(`Categoria "${cat}" sin productos.`);
    const codigos = new Set<string>();
    for (const pm of c.promociones) {
      if (codigos.has(pm.codigo)) e.push(`Promocion duplicada: ${pm.codigo}.`);
      codigos.add(pm.codigo);
      for (const pn of pm.productos) if (!nombres.has(norm(pn))) e.push(`Promocion ${pm.codigo}: el producto "${pn}" no existe en el menu.`);
      for (const sl of pm.sucursales ?? []) if (!slugs.has(sl)) e.push(`Promocion ${pm.codigo}: sucursal inexistente "${sl}".`);
      if (pm.dias.length === 0 || pm.dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) e.push(`Promocion ${pm.codigo}: dias invalidos (0 a 6).`);
      if (pm.canales.length === 0) e.push(`Promocion ${pm.codigo}: sin canales.`);
    }
    if (c.promociones.length > 0 && p.promosTexto === null) a.push("Hay promociones pero politicas.promosTexto es null: el prompt usaria las promos de PM. Escribir la frase.");
    if (c.promociones.length === 0 && p.promosTexto === null) a.push("promosTexto null usa las promos de PM: pon una frase propia (p. ej. \"no hay promociones vigentes\").");
  }
  return { ok: e.length === 0, errores: e, advertencias: a };
}
