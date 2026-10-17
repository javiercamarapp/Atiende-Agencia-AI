// Fase 4 (cierre de gap): el motor de nómina completa (Fase 3 — ISR nómina, IMSS/
// Infonavit, subsidio, prestaciones) quedó construido, verificado contra el
// intérprete Python real (136 casos de golden-set) y 100% cubierto por tests de
// dominio, pero ninguna ruta HTTP lo invocaba — mismo oversight real que
// declaraciones.ts (Fase 2/3 se enfocaron en el motor, no en cablearlo). Esta ruta
// lo cierra, exponiendo `procesarNomina()` (el puerto de `process_payroll`, que ya
// compone ISR+IMSS+Infonavit+subsidio para un periodo completo de empleados).
//
// Igual que declaraciones.ts: es un endpoint puro/calculadora, sin persistencia.
// Ningún esquema de despachos modela "periodo de nómina procesado" como entidad
// propia — agregar esa tabla sería alcance nuevo no pedido por este cierre de gap.
// `procesarNomina` ya trae su propia `idempotencyKey` derivada de (year, month,
// tenantId) en el resultado, para que quien persista la respuesta pueda deduplicar.
//
// Nota de negocio heredada y NO resuelta aquí (ver diseño Fase 3 despachos §5.2): el
// repo Python origen tiene un segundo motor de nómina (`services/payroll.py`) que no
// coincide con `nomina_completa` (~2.6× de diferencia en IMSS obrero). Esta ruta
// expone el motor YA PORTADO (`nomina_completa`, el que la tarea de Fase 3 pidió
// explícitamente) — cuál de los dos es "el bueno" para producción sigue siendo
// decisión de negocio pendiente de Javier/legal, no se resuelve unilateralmente aquí.
//
// Fase 7 (cierre de gap de auditoría "Sin generación/timbrado del XML de
// complemento Nómina 1.2"): `/generar-xml` cierra la parte construible del gap —
// genera el XML (SIN sellar) del comprobante + complemento nomina12:Nomina para
// cada empleado del periodo, vía `generarXmlCfdiNomina` (@atiende/domain-despachos).
// Mismo criterio "puro/calculadora, sin persistencia" que el resto de esta ruta: no
// se guarda el XML generado ni se timbra — eso sigue fuera de alcance (FIEL/CSD real,
// timbrado ante PAC vía `CfdiPort`, RPA a SAT/IMSS — ver nomina/index.ts).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { procesarNomina, generarXmlCfdiNomina, NOMINA_ROLES, TIPOS_NOMINA, NominaInvalidaError, ImssInvalidoError, VigenciaNoSoportadaError } from "@atiende/domain-despachos";
import type { ConceptosPeriodoInput, HoraExtraInput, IncapacidadInput, EmployeePayrollInput, PayrollPeriodInput, Periodicidad, DatosEmisorNominaXml, DatosReceptorNominaXml, DatosLaboralesNominaXml, TipoNomina } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface PeriodBody {
  readonly month?: unknown;
  readonly year?: unknown;
  readonly diasPagados?: unknown;
  readonly salarioDiarioDefault?: unknown;
  readonly fechaPago?: unknown;
  readonly periodicidad?: unknown;
}

interface ConceptosBody {
  readonly aguinaldo?: unknown;
  readonly primaVacacional?: unknown;
  readonly ptu?: unknown;
  readonly semanasTiempoExtra?: unknown;
  readonly horasExtra?: unknown;
  readonly incapacidades?: unknown;
}

interface EmployeeBody {
  readonly employeeId?: unknown;
  readonly nombre?: unknown;
  readonly salarioBruto?: unknown;
  readonly percepciones?: unknown;
  readonly salarioDiario?: unknown;
  readonly antiguedadAnios?: unknown;
  readonly fechaInicioRelLaboral?: unknown;
  readonly sbc?: unknown;
  readonly primaRt?: unknown;
  readonly conceptos?: ConceptosBody;
}

interface ProcesarNominaBody {
  readonly period?: PeriodBody;
  readonly employees?: unknown;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw Errors.validation(`${field}: se esperaba un número.`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw Errors.validation(`${field}: se esperaba un texto.`);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw Errors.validation(`${field}: se esperaba un texto no vacío.`);
  return value.trim();
}

function optionalFecha(value: unknown, field: string): string | undefined {
  const s = optionalString(value, field);
  if (s === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw Errors.validation(`${field}: se esperaba una fecha YYYY-MM-DD.`);
  return s;
}

function parsePeriodicidad(value: unknown): Periodicidad | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== "mensual" && value !== "quincenal") throw Errors.validation("period.periodicidad: se esperaba mensual o quincenal.");
  return value;
}

function parsePeriod(raw: PeriodBody | undefined): PayrollPeriodInput {
  const p = raw ?? {};
  return {
    month: optionalNumber(p.month, "period.month"),
    year: optionalNumber(p.year, "period.year"),
    diasPagados: optionalNumber(p.diasPagados, "period.diasPagados"),
    salarioDiarioDefault: optionalNumber(p.salarioDiarioDefault, "period.salarioDiarioDefault"),
    fechaPago: optionalFecha(p.fechaPago, "period.fechaPago"),
    periodicidad: parsePeriodicidad(p.periodicidad),
  };
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw Errors.validation(`${field}: se esperaba un objeto.`);
  return value as Record<string, unknown>;
}

function parseConceptos(raw: ConceptosBody | undefined, field: string): ConceptosPeriodoInput | undefined {
  if (raw === undefined || raw === null) return undefined;
  const c = requireObject(raw, field) as ConceptosBody;
  const horasRaw = c.horasExtra;
  if (horasRaw !== undefined && !Array.isArray(horasRaw)) throw Errors.validation(`${field}.horasExtra: se esperaba un arreglo.`);
  const incRaw = c.incapacidades;
  if (incRaw !== undefined && !Array.isArray(incRaw)) throw Errors.validation(`${field}.incapacidades: se esperaba un arreglo.`);
  if ((horasRaw?.length ?? 0) > 50 || (incRaw?.length ?? 0) > 50) throw Errors.validation(`${field}: demasiados renglones (máximo 50).`);
  const horasExtra: HoraExtraInput[] = (horasRaw ?? []).map((h: unknown, i: number) => {
    const o = requireObject(h, `${field}.horasExtra[${i}]`);
    const tipo = o["tipo"];
    if (tipo !== "01" && tipo !== "02") throw Errors.validation(`${field}.horasExtra[${i}].tipo: se esperaba 01 (dobles) o 02 (triples).`);
    return {
      dias: optionalNumber(o["dias"], `${field}.horasExtra[${i}].dias`) ?? 0,
      tipo,
      horas: optionalNumber(o["horas"], `${field}.horasExtra[${i}].horas`) ?? 0,
      importe: optionalNumber(o["importe"], `${field}.horasExtra[${i}].importe`) ?? 0,
    };
  });
  const incapacidades: IncapacidadInput[] = (incRaw ?? []).map((h: unknown, i: number) => {
    const o = requireObject(h, `${field}.incapacidades[${i}]`);
    return {
      dias: optionalNumber(o["dias"], `${field}.incapacidades[${i}].dias`) ?? 0,
      tipo: requireString(o["tipo"], `${field}.incapacidades[${i}].tipo`),
      importe: optionalNumber(o["importe"], `${field}.incapacidades[${i}].importe`),
    };
  });
  return {
    aguinaldo: optionalNumber(c.aguinaldo, `${field}.aguinaldo`),
    primaVacacional: optionalNumber(c.primaVacacional, `${field}.primaVacacional`),
    ptu: optionalNumber(c.ptu, `${field}.ptu`),
    semanasTiempoExtra: optionalNumber(c.semanasTiempoExtra, `${field}.semanasTiempoExtra`),
    horasExtra,
    incapacidades,
  };
}

function parseEmployeeInput(e: EmployeeBody, i: number): EmployeePayrollInput {
  const o = requireObject(e, `employees[${i}]`) as EmployeeBody;
  return {
    employeeId: optionalString(o.employeeId, `employees[${i}].employeeId`),
    nombre: optionalString(o.nombre, `employees[${i}].nombre`),
    salarioBruto: optionalNumber(o.salarioBruto, `employees[${i}].salarioBruto`),
    percepciones: optionalNumber(o.percepciones, `employees[${i}].percepciones`),
    salarioDiario: optionalNumber(o.salarioDiario, `employees[${i}].salarioDiario`),
    antiguedadAnios: optionalNumber(o.antiguedadAnios, `employees[${i}].antiguedadAnios`),
    fechaInicioRelLaboral: optionalFecha(o.fechaInicioRelLaboral, `employees[${i}].fechaInicioRelLaboral`),
    sbc: optionalNumber(o.sbc, `employees[${i}].sbc`),
    primaRt: optionalNumber(o.primaRt, `employees[${i}].primaRt`),
    conceptos: parseConceptos(o.conceptos, `employees[${i}].conceptos`),
  };
}

/** Los errores de reglas del motor (vigencia sin cargar, SBC <= 0, conceptos inválidos) son del usuario: 400, no 500. */
function procesar(period: PayrollPeriodInput, employees: readonly EmployeePayrollInput[], propertyId: string) {
  try {
    // D-P3-50: el tenant sale de la RUTA (propertyId, ya validado por `requirePropertyMembership`); un `tenantId` del cuerpo se ignora.
    return procesarNomina(period, employees, null, propertyId);
  } catch (err) {
    if (err instanceof NominaInvalidaError || err instanceof ImssInvalidoError || err instanceof VigenciaNoSoportadaError) throw Errors.validation(err.message);
    throw err;
  }
}

function parseEmployees(raw: unknown): readonly EmployeePayrollInput[] {
  if (!Array.isArray(raw)) throw Errors.validation("employees: se esperaba un arreglo.");
  if (raw.length > 500) throw Errors.validation("employees: máximo 500 empleados por solicitud.");
  return (raw as EmployeeBody[]).map((e, i) => parseEmployeeInput(e, i));
}

// ---------------------------------------------------------------------------
// POST /nomina/generar-xml (Fase 7)
// ---------------------------------------------------------------------------

interface EmisorXmlBody {
  readonly rfc?: unknown;
  readonly nombre?: unknown;
  readonly regimenFiscal?: unknown;
  readonly lugarExpedicion?: unknown;
  readonly noCertificado?: unknown;
  readonly certificado?: unknown;
  readonly registroPatronal?: unknown;
}

interface EmployeeXmlBody extends EmployeeBody {
  readonly rfcReceptor?: unknown;
  readonly nombreReceptor?: unknown;
  readonly domicilioFiscalReceptor?: unknown;
  readonly regimenFiscalReceptor?: unknown;
  readonly folio?: unknown;
  // Datos laborales exigidos por nomina12:Receptor (XSD real, ver corrección
  // hallazgo "XML de nómina 1.2 no valida contra el XSD real del SAT") —
  // ver xml-nomina.ts::DatosLaboralesNominaXml.
  readonly curp?: unknown;
  readonly numEmpleado?: unknown;
  readonly tipoContrato?: unknown;
  readonly tipoRegimen?: unknown;
  readonly periodicidadPago?: unknown;
  readonly claveEntFed?: unknown;
  readonly numSeguridadSocial?: unknown;
  readonly riesgoPuesto?: unknown;
}

interface GenerarXmlNominaBody {
  readonly period?: PeriodBody & { readonly tipoNomina?: unknown; readonly serie?: unknown; readonly fechaInicialPago?: unknown; readonly fechaFinalPago?: unknown };
  readonly employees?: unknown;
  readonly emisor?: EmisorXmlBody;
}

function parseEmisorXml(raw: EmisorXmlBody | undefined): DatosEmisorNominaXml {
  const e = raw ?? {};
  return {
    rfc: requireString(e.rfc, "emisor.rfc"),
    nombre: requireString(e.nombre, "emisor.nombre"),
    regimenFiscal: requireString(e.regimenFiscal, "emisor.regimenFiscal"),
    lugarExpedicion: requireString(e.lugarExpedicion, "emisor.lugarExpedicion"),
    noCertificado: optionalString(e.noCertificado, "emisor.noCertificado"),
    certificado: optionalString(e.certificado, "emisor.certificado"),
    registroPatronal: optionalString(e.registroPatronal, "emisor.registroPatronal"),
  };
}

function parseTipoNomina(value: unknown): TipoNomina | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !(TIPOS_NOMINA as readonly string[]).includes(value)) {
    throw Errors.validation(`period.tipoNomina: se esperaba uno de ${TIPOS_NOMINA.join("|")}.`);
  }
  return value as TipoNomina;
}

interface EmpleadoXmlDatos {
  readonly receptor: DatosReceptorNominaXml;
  readonly datosLaborales: DatosLaboralesNominaXml;
  readonly folio: string;
}

function parseEmployeesXml(raw: unknown): { readonly payrollInputs: readonly EmployeePayrollInput[]; readonly datosXml: readonly EmpleadoXmlDatos[] } {
  if (!Array.isArray(raw)) throw Errors.validation("employees: se esperaba un arreglo.");
  const body = raw as EmployeeXmlBody[];
  if (body.length > 500) throw Errors.validation("employees: máximo 500 empleados por solicitud.");
  const payrollInputs = body.map((e, i) => parseEmployeeInput(e, i));
  const datosXml = body.map((e, i) => ({
    receptor: {
      rfc: requireString(e.rfcReceptor, `employees[${i}].rfcReceptor`),
      // Cae al `nombre` de nómina si no se da un `nombreReceptor` explícito
      // (mismo empleado, un solo nombre) — evita pedir el dato dos veces.
      nombre: optionalString(e.nombreReceptor, `employees[${i}].nombreReceptor`) ?? requireString(e.nombre, `employees[${i}].nombre`),
      domicilioFiscalReceptor: requireString(e.domicilioFiscalReceptor, `employees[${i}].domicilioFiscalReceptor`),
      regimenFiscalReceptor: optionalString(e.regimenFiscalReceptor, `employees[${i}].regimenFiscalReceptor`),
    },
    // nomina12:Receptor -- ver corrección hallazgo "XML de nómina 1.2 no valida
    // contra el XSD real del SAT" (xml-nomina.ts): obligatorios, sin defaults.
    datosLaborales: {
      curp: requireString(e.curp, `employees[${i}].curp`),
      numEmpleado: requireString(e.numEmpleado, `employees[${i}].numEmpleado`),
      tipoContrato: requireString(e.tipoContrato, `employees[${i}].tipoContrato`),
      tipoRegimen: requireString(e.tipoRegimen, `employees[${i}].tipoRegimen`),
      periodicidadPago: requireString(e.periodicidadPago, `employees[${i}].periodicidadPago`),
      claveEntFed: requireString(e.claveEntFed, `employees[${i}].claveEntFed`),
      numSeguridadSocial: optionalString(e.numSeguridadSocial, `employees[${i}].numSeguridadSocial`),
      fechaInicioRelLaboral: optionalFecha(e.fechaInicioRelLaboral, `employees[${i}].fechaInicioRelLaboral`),
      riesgoPuesto: optionalString(e.riesgoPuesto, `employees[${i}].riesgoPuesto`),
    },
    folio: requireString(e.folio, `employees[${i}].folio`),
  }));
  return { payrollInputs, datosXml };
}

export function despachosNominaRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/despachos/:propertyId/nomina/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post("/despachos/:propertyId/nomina/calcular", async (c) => {
    assertVerticalRole(c, NOMINA_ROLES);
    const raw = await readJsonCapped<ProcesarNominaBody>(c.req.raw, 64 * 1024);
    const period = parsePeriod(raw.period);
    const employees = parseEmployees(raw.employees);
    const resultado = procesar(period, employees, c.req.param("propertyId"));
    return c.json(resultado);
  });

  app.post("/despachos/:propertyId/nomina/generar-xml", async (c) => {
    assertVerticalRole(c, NOMINA_ROLES);
    const raw = await readJsonCapped<GenerarXmlNominaBody>(c.req.raw, 64 * 1024);
    const period = parsePeriod(raw.period);
    const tipoNomina = parseTipoNomina(raw.period?.tipoNomina);
    const serie = optionalString(raw.period?.serie, "period.serie");
    const { payrollInputs, datosXml } = parseEmployeesXml(raw.employees);
    const emisor = parseEmisorXml(raw.emisor);
    const fechaInicialPago = optionalFecha(raw.period?.fechaInicialPago, "period.fechaInicialPago");
    const fechaFinalPago = optionalFecha(raw.period?.fechaFinalPago, "period.fechaFinalPago");

    // Reusa el MISMO motor que /calcular — nunca se recalculan ISR/IMSS aquí
    // ni se acepta un `taxes` ya calculado desde el cliente (evitaría que un
    // XML fiscal se genere con cifras que este backend nunca verificó).
    const periodo = procesar(period, payrollInputs, c.req.param("propertyId"));
    if (periodo.employees.length !== datosXml.length) {
      // No debería poder pasar (misma longitud de `employees` de entrada),
      // pero se verifica explícitamente antes de indexar en paralelo abajo.
      throw Errors.validation("employees: el número de empleados procesados no coincide con los datos de XML recibidos.");
    }

    const comprobantes = periodo.employees.map((empleado, i) => {
      const datos = datosXml[i]!;
      try {
        const xml = generarXmlCfdiNomina(
          empleado,
          emisor,
          datos.receptor,
          {
            year: periodo.year,
            month: periodo.month,
            diasPagados: empleado.diasPagados,
            tipoNomina,
            serie,
            folio: datos.folio,
            fechaInicialPago,
            fechaFinalPago,
          },
          datos.datosLaborales,
        );
        return { employeeId: empleado.employeeId, folio: datos.folio, xml };
      } catch (err) {
        // `generarXmlCfdiNomina` lanza `Error` plano para input inválido (RFC mal
        // formado, campos fiscales faltantes) — se traduce a 400 aquí; sin este
        // catch, `app.onError` (apps/api/src/app.ts) lo trataría como 500 genérico.
        const mensaje = err instanceof Error ? err.message : String(err);
        throw Errors.validation(`employees[${i}]: ${mensaje}`);
      }
    });

    return c.json({ idempotencyKey: periodo.idempotencyKey, comprobantes });
  });

  return app;
}
