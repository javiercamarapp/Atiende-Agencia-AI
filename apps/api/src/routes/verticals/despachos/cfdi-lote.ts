// D-13 (SOLO la parte "carga masiva de CFDI"): `POST /despachos/:propertyId/cfdi/importar-lote`.
//
// Es como un despacho recibe los XML de la descarga manual del portal del SAT: hasta 50 XML sueltos (multipart) o UN ZIP de hasta
// 4 MB (limite de cuerpo de las funciones de Vercel). Cada XML pasa por la MISMA ingesta que `POST .../cfdi/importar-xml`
// (`ingestarXmlCfdiDespachos`, cfdi.ts: parser endurecido D-29, EFOS, bloqueo de periodo cerrado, cola de revision humana) y los
// complementos de pago (tipo P) por la MISMA ingesta que `POST .../pagos-provisionales/rep` (`registrarRepDespachos`, D-23/D-25).
// La nomina (tipo N) y cualquier otro tipo no soportado se rechazan con motivo. Es idempotente por UUID del timbre.
//
// Transaccion: el request es UNA transaccion (dbSession). Cada archivo corre en su SAVEPOINT (`runWithSavepointFallback`): un archivo
// que falla revierte solo lo suyo y no aborta la transaccion ni a los demas; un error inesperado de base SI se propaga (500).
// Respuesta 200 con el resultado por archivo (ingerido / en_revision / duplicado / rechazado + motivo) y los totales.
//
// No requiere SQL nuevo. La descarga automatica desde el SAT necesita e.firma (D-18) y NO es parte de este endpoint.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { ApiError, assertVerticalRole } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { CfdiXmlParseError, validarXmlCfdiSeguro } from "@atiende/billing";
import { emitirNotificacion, runWithSavepointFallback } from "@atiende/db";
import { GESTIONAR_PAGOS_PROVISIONALES_ROLES, INGESTA_CFDI_ROLES, MAX_ARCHIVOS_LOTE, nombreArchivoParaMostrar, tipoComprobanteDeXml, totalesDeLote } from "@atiende/domain-despachos";
import type { CarteraRepository, ResultadoArchivoLote } from "@atiende/domain-despachos";
import { PostgresCarteraRepository } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";
import { avisarCfdiRequiereRevision, avisarEmisorEfos, ingestarXmlCfdiDespachos } from "./cfdi.ts";
import { clasificacionDe } from "./clasificacion-deps.ts";
import { registrarRepDespachos } from "./pagos-provisionales.ts";
import { LIMITES_ZIP_CFDI, ZipCfdiInvalidoError, leerZipCfdi } from "./cfdi-lote-zip.ts";

/** Cuerpo maximo de la peticion: 4.5 MB, el limite de Vercel (un ZIP de 4 MB cabe con su envoltura multipart). */
export const MAX_CUERPO_LOTE_BYTES = 4_718_592;
/** Mismo tope por XML que `POST .../cfdi/importar-xml` (MAX_CFDI_XML_BYTES de cfdi.ts). */
const MAX_XML_BYTES = 512 * 1024;
/** Presupuesto de tiempo (la funcion dura 30 s): lo que no alcance se reporta como no procesado, nunca se pierde en silencio. */
const PRESUPUESTO_MS = 22_000;
// Una peticion = una tanda de <= 50 XML. El navegador descomprime hasta 5000 entradas (100 tandas): el tope debe cubrir un lote completo
// con margen para un reintento; el costo por peticion ya esta acotado (cuerpo <= 4 MB, <= 50 XML, rol y periodo validados).
const LOTE_RATE_LIMIT = { max: 150, windowMs: 5 * 60_000 } as const;

interface ArchivoEntrada {
  readonly nombre: string;
  readonly bytes: Uint8Array;
}

/** Lee el cuerpo en streaming y corta en cuanto pasa del tope (el content-length puede mentir o faltar: chunked). */
async function leerCuerpoAcotado(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declarado) || declarado < 0 || declarado > maxBytes) throw Errors.payloadTooLarge("El lote excede 4.5 MB: envía menos archivos o un ZIP más pequeño.");
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw Errors.payloadTooLarge("El lote excede 4.5 MB: envía menos archivos o un ZIP más pequeño.");
    }
    partes.push(value);
  }
  const cuerpo = new Uint8Array(total);
  let off = 0;
  for (const parte of partes) {
    cuerpo.set(parte, off);
    off += parte.byteLength;
  }
  return cuerpo;
}

function esZip(nombre: string, tipo: string, bytes: Uint8Array): boolean {
  const firma = bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);
  return /\.zip$/i.test(nombre) || /zip/i.test(tipo) || firma;
}

function rechazo(archivo: string, motivo: string, clase: ResultadoArchivoLote["clase"] = null, folioFiscal: string | null = null): ResultadoArchivoLote {
  return { archivo, estado: "rechazado", clase, folioFiscal, motivo };
}

export function despachosCfdiLoteRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const carteraDe = (db: Parameters<NonNullable<AppDeps["carteraRepo"]>>[0]): CarteraRepository => (deps.carteraRepo ? deps.carteraRepo(db) : new PostgresCarteraRepository(db));

  // SIN `app.use` propio a proposito (igual que cfdi-estatus-sat.ts): `despachosCfdiRoutes` (cfdi.ts, montado ANTES en despachos.ts)
  // ya registra authMiddleware + dbSession + requirePropertyMembership sobre `/despachos/:propertyId/cfdi/*`; repetirlo abriria una
  // segunda transaccion por request. Cubierto por las pruebas de 401 sin token y de property ajena.

  app.post("/despachos/:propertyId/cfdi/importar-lote", async (c) => {
    assertVerticalRole(c, INGESTA_CFDI_ROLES);
    const db = c.get("db");
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const rolVertical = c.get("verticalRole");
    const puedeRegistrarRep = rolVertical !== undefined && (GESTIONAR_PAGOS_PROVISIONALES_ROLES as readonly string[]).includes(rolVertical);

    const tipoContenido = c.req.header("content-type") ?? "";
    if (!/^multipart\/form-data\b/i.test(tipoContenido)) throw Errors.validation("Se esperaba multipart/form-data con los archivos XML o un ZIP.");
    if (!(await rateLimit(`despachos:cfdi-lote:${c.get("userId")}`, LOTE_RATE_LIMIT.max, LOTE_RATE_LIMIT.windowMs, { category: "despachos:cfdi-lote" }))) {
      throw Errors.tooManyRequests("Demasiadas cargas masivas. Intenta de nuevo en unos minutos.");
    }
    const inicio = Date.now();

    const cuerpo = await leerCuerpoAcotado(c.req.raw, MAX_CUERPO_LOTE_BYTES);
    let formulario: FormData;
    try {
      formulario = await new Response(cuerpo, { headers: { "content-type": tipoContenido } }).formData();
    } catch {
      throw Errors.validation("El cuerpo multipart no es válido.");
    }
    const recibidos: ArchivoEntrada[] = [];
    for (const [, valor] of formulario.entries()) {
      if (typeof valor === "string") continue;
      recibidos.push({ nombre: valor.name, bytes: new Uint8Array(await valor.arrayBuffer()) });
    }
    if (recibidos.length === 0) throw Errors.validation("No se recibió ningún archivo. Envía los XML (o un ZIP) como archivos del formulario.");

    // Un ZIP viaja solo; el resto son XML sueltos (hasta MAX_ARCHIVOS_LOTE).
    const resultados: ResultadoArchivoLote[] = [];
    const pendientes: ArchivoEntrada[] = [];
    let ignorados = 0;
    const hayZip = recibidos.some((f) => esZip(f.nombre, "", f.bytes));
    if (hayZip) {
      if (recibidos.length !== 1) throw Errors.validation("Envía un solo ZIP, o hasta 50 archivos XML; no ambos a la vez.");
      const zip = recibidos[0]!;
      if (zip.bytes.byteLength > LIMITES_ZIP_CFDI.maxBytesZip) throw Errors.payloadTooLarge("El ZIP excede 4 MB: descomprímelo y envía los XML en tandas, o divídelo.");
      try {
        const lectura = leerZipCfdi(zip.bytes);
        pendientes.push(...lectura.xml.map((e) => ({ nombre: e.nombre, bytes: e.bytes })));
        for (const nombre of lectura.noXml) resultados.push(rechazo(nombreArchivoParaMostrar(nombre), "No es un archivo XML: se omitió."));
        ignorados = lectura.ignorados;
      } catch (err) {
        if (err instanceof ZipCfdiInvalidoError) throw Errors.validation(err.message);
        throw err;
      }
    } else {
      if (recibidos.length > MAX_ARCHIVOS_LOTE) throw Errors.payloadTooLarge(`Máximo ${MAX_ARCHIVOS_LOTE} archivos por envío.`);
      pendientes.push(...recibidos);
    }

    const cartera = carteraDe(db);
    let hayRevision = false;
    const decodificador = new TextDecoder("utf-8", { fatal: true });
    for (const archivo of pendientes) {
      const nombre = nombreArchivoParaMostrar(archivo.nombre);
      if (Date.now() - inicio > PRESUPUESTO_MS) {
        resultados.push(rechazo(nombre, "No se procesó: la carga agotó su tiempo. Vuelve a enviar este archivo."));
        continue;
      }
      if (archivo.bytes.byteLength > MAX_XML_BYTES) {
        resultados.push(rechazo(nombre, `El XML excede ${MAX_XML_BYTES / 1024} KB.`));
        continue;
      }
      let xml: string;
      try {
        xml = decodificador.decode(archivo.bytes);
      } catch {
        resultados.push(rechazo(nombre, "El XML debe estar codificado en UTF-8 válido."));
        continue;
      }
      try {
        // DTD/entidades/hojas de estilo se rechazan ANTES de enrutar o parsear (el mismo candado D-29 que usa cada ingesta).
        validarXmlCfdiSeguro(xml);
      } catch (err) {
        resultados.push(rechazo(nombre, err instanceof CfdiXmlParseError ? err.message : "El XML no es válido."));
        continue;
      }
      const tipo = tipoComprobanteDeXml(xml);
      if (tipo === "N") {
        resultados.push(rechazo(nombre, "Recibo de nómina (tipo N): no se admite en la carga masiva.", "cfdi"));
        continue;
      }

      try {
        if (tipo === "P") {
          if (!puedeRegistrarRep) {
            resultados.push(rechazo(nombre, "Complemento de pago: tu rol no puede registrar pagos.", "rep"));
            continue;
          }
          const r = await runWithSavepointFallback({
            session: db,
            primary: () => registrarRepDespachos(deps, db, organizationId, propertyId, xml),
            isRecoverable: () => true,
            fallback: (e) => Promise.reject(e),
          });
          const nota = [r.omitidos.length > 0 ? `${r.omitidos.length} documento(s) omitido(s)` : "", r.rechazados.length > 0 ? `${r.rechazados.length} rechazado(s)` : ""].filter((t) => t !== "").join(", ");
          if (r.registrados > 0) {
            resultados.push({ archivo: nombre, estado: "ingerido", clase: "rep", folioFiscal: r.folioFiscalRep, motivo: `${r.registrados} pago(s) registrado(s)${nota ? `; ${nota}` : ""}.` });
          } else if (r.yaExistian > 0 && r.omitidos.length === 0 && r.rechazados.length === 0) {
            resultados.push({ archivo: nombre, estado: "duplicado", clase: "rep", folioFiscal: r.folioFiscalRep, motivo: "Ya existía: sus pagos ya estaban registrados." });
          } else {
            const detalle = r.rechazados[0]?.motivo ?? r.omitidos[0]?.motivo ?? "ningún documento relacionado se pudo ligar a una factura del despacho";
            resultados.push(rechazo(nombre, `No se registró ningún pago: ${detalle}.`, "rep", r.folioFiscalRep));
          }
          continue;
        }

        const r = await runWithSavepointFallback({
          session: db,
          primary: async () => {
            const ingesta = await ingestarXmlCfdiDespachos(deps.despachosRepo(db), organizationId, propertyId, xml, cartera, clasificacionDe(deps, db));
            if (!ingesta.duplicado) await avisarEmisorEfos(db, organizationId, propertyId, ingesta.invoice, ingesta.efos);
            return ingesta;
          },
          isRecoverable: () => true,
          fallback: (e) => Promise.reject(e),
        });
        const folio = r.invoice.folioFiscal;
        if (r.duplicado) {
          // D-P3-18: el UUID ya estaba en ESTE cliente -- no se duplica ni se reporta como error.
          resultados.push({ archivo: nombre, estado: "duplicado", clase: "cfdi", folioFiscal: folio, motivo: "Ya existía un CFDI con ese UUID en este cliente: no se duplicó." });
        } else if (r.invoice.requiresHumanReview) {
          hayRevision = true;
          resultados.push({ archivo: nombre, estado: "en_revision", clase: "cfdi", folioFiscal: folio, motivo: "Quedó en la cola de revisión humana." });
        } else {
          resultados.push({ archivo: nombre, estado: "ingerido", clase: "cfdi", folioFiscal: folio, motivo: null });
        }
      } catch (err) {
        if (err instanceof ApiError) {
          // `conflict` es EXACTAMENTE el UUID repetido (InvoiceAlreadyExistsError, cfdi.ts); el periodo cerrado trae su propio codigo.
          if (err.code === "conflict" && tipo !== "P") resultados.push({ archivo: nombre, estado: "duplicado", clase: "cfdi", folioFiscal: null, motivo: "Ya existía un CFDI con ese UUID: no se duplicó." });
          else resultados.push(rechazo(nombre, err.message, tipo === "P" ? "rep" : null));
          continue;
        }
        throw err;
      }
    }

    // D-P3-23: una sola campana por cliente y por dia si algun CFDI del lote quedo en la cola de revision (por el motor fiscal o por la clasificacion).
    if (hayRevision) await avisarCfdiRequiereRevision(deps, db, organizationId, propertyId);
    const totales = totalesDeLote(resultados);
    const loteId = randomUUID();
    if (totales.ingeridos + totales.enRevision > 0) {
      await emitirNotificacion(db, {
        evento: "despachos.cfdi.lote_importado",
        organizationId,
        propertyId,
        clave: loteId,
        parametros: { ingeridos: totales.ingeridos, en_revision: totales.enRevision, duplicados: totales.duplicados, rechazados: totales.rechazados },
        entidadTipo: "lote_cfdi",
        entidadId: loteId,
      });
    }
    await deps.despachosAuditSink.record({
      at: new Date().toISOString(),
      actorUserId: c.get("userId"),
      actorEmail: c.get("userEmail") ?? null,
      organizationId,
      action: "despachos.cfdi:importar-lote",
      route: c.req.path,
      method: c.req.method,
      decision: "allowed",
      metadata: { propertyId, loteId, ...totales },
    });
    return c.json({ loteId, resultados, totales, ignorados });
  });

  return app;
}
