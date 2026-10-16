// D-33: registro de las reglas fiscales del motor de despachos y los fundamentos (ids de ficha en normas/) que cada una
// aplica. NO ejecuta ni modifica ningún motor: es solo trazabilidad. La prueba tests/normas-sincronia.spec.ts exige que
// todo id exista como ficha, que toda regla tenga al menos un fundamento y que toda ficha se use o sea de contexto.
// Las rutas son relativas a packages/domain-despachos/.

export interface ReglaDelMotor {
  /** Id estable (no cambia aunque se mueva el archivo). */
  readonly id: string;
  readonly archivo: string;
  readonly descripcion: string;
  /** Ids de ficha de normas/. */
  readonly fundamentos: readonly string[];
}

export const REGLAS_DEL_MOTOR: readonly ReglaDelMotor[] = [
  { id: "cfdi.validacion-avanzada", archivo: "src/cfdi/reglas-fiscales-avanzadas.ts", descripcion: "Validaciones locales de CFDI: notas de crédito, plazo de timbrado, retenciones y proveedor reportable en DIOT.", fundamentos: ["cff-29-29-a", "anexo-20", "rmf-2.7.1.35", "liva-32-viii", "liva-1-b"] },
  { id: "cfdi.efos-69b", archivo: "src/cfdi/efos.ts", descripcion: "Lectura del listado 69-B del SAT y hallazgos por emisor.", fundamentos: ["cff-69-b"] },
  { id: "cfdi.rep", archivo: "src/cfdi/rep.ts", descripcion: "Análisis del complemento de pago (REP) y IVA efectivamente pagado por flujo.", fundamentos: ["rmf-2.7.1.29", "liva-1-b", "liva-1-a-5"] },
  { id: "vencimientos.calendario-fiscal", archivo: "src/vencimientos/calendario-fiscal.ts", descripcion: "Plazos por obligación y régimen con ajuste a día hábil.", fundamentos: ["cff-12", "lft-74", "liva-5-d", "rmf-4.5.1", "rmf-2.8.1.6", "lisr-76-150"] },
  { id: "vencimientos.engine", archivo: "src/vencimientos/engine.ts", descripcion: "Prioridad y escalamiento de vencimientos.", fundamentos: ["cff-12", "cff-89"] },
  { id: "declaraciones.diot-layout", archivo: "src/declaraciones/diot-layout.ts", descripcion: "Archivo de la DIOT (TXT y XML) para revisión humana.", fundamentos: ["liva-32-viii", "rmf-4.5.1"] },
  { id: "declaraciones.isr-engine", archivo: "src/declaraciones/isr-engine.ts", descripcion: "ISR de personas físicas, morales y RESICO persona moral.", fundamentos: ["lisr-96", "lisr-9-206-209"] },
  { id: "declaraciones.isr-tablas", archivo: "src/declaraciones/isr-tablas.ts", descripcion: "Tarifas de ISR (mensual y anual) y tasas de RESICO.", fundamentos: ["lisr-96", "lisr-113-e", "lisr-9-206-209"] },
  { id: "nomina.isr", archivo: "src/nomina/isr-nomina-engine.ts", descripcion: "ISR de nómina con la tarifa del art. 96 y subsidio para el empleo.", fundamentos: ["lisr-96", "lisr-113-174"] },
  { id: "nomina.imss", archivo: "src/nomina/imss-engine.ts", descripcion: "Cuotas IMSS e INFONAVIT con tope de SBC.", fundamentos: ["lss-infonavit"] },
  { id: "nomina.prestaciones", archivo: "src/nomina/prestaciones.ts", descripcion: "Aguinaldo y prima vacacional.", fundamentos: ["lft-80-87"] },
  { id: "devolucion-iva.calculo", archivo: "src/devolucion-iva/calculo.ts", descripcion: "Clasificación de IVA, conciliación y plazo de resolución de la devolución.", fundamentos: ["cff-22", "cff-12", "liva-1-a-5"] },
  { id: "devolucion-iva.workpaper", archivo: "src/devolucion-iva/workpaper.ts", descripcion: "Papel de trabajo de la devolución de IVA.", fundamentos: ["cff-59"] },
  { id: "pagos-provisionales.engine", archivo: "src/pagos-provisionales/engine.ts", descripcion: "Pagos provisionales de ISR (601, 612, 626) e IVA por flujo.", fundamentos: ["lisr-14-17", "lisr-27-iii", "lisr-106", "lisr-113-e", "liva-1-b", "liva-1-a-5"] },
  { id: "pagos-provisionales.rep-pagos", archivo: "src/pagos-provisionales/rep-pagos.ts", descripcion: "Pagos persistidos a partir de un REP ya analizado.", fundamentos: ["rmf-2.7.1.29"] },
  { id: "libro.balanza", archivo: "src/libro/balanza.ts", descripcion: "Balanza y paquete de contabilidad electrónica desde el libro.", fundamentos: ["anexo-24", "rmf-2.8.1.6"] },
  { id: "contabilidad-electronica.catalogo", archivo: "src/contabilidad-electronica/catalogo-cuentas.ts", descripcion: "Catálogo de cuentas en el formato del Anexo 24, con código agrupador y cuenta padre.", fundamentos: ["anexo-24", "anexo-24-codigo-agrupador"] },
  { id: "contabilidad-electronica.polizas-periodo", archivo: "src/contabilidad-electronica/polizas-periodo.ts", descripcion: "XML de pólizas del periodo (PolizasPeriodo 1.3) desde el libro.", fundamentos: ["anexo-24", "rmf-2.8.1.6"] },
];
