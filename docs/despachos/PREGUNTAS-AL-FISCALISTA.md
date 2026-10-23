# Preguntas al fiscalista (despachos)

Aquí se juntan las dudas fiscales del dominio de despachos que hoy viven dispersas en comentarios de código. Cada pregunta enlaza
su ficha en `packages/domain-despachos/normas/` y el archivo:línea que cambia según la respuesta. Las líneas son las de `main`
al momento de escribir este documento; si el archivo se edita, se actualizan al resolver la pregunta.

Qué NO es esto: no es un dictamen ni una validación. Ninguna ficha está `verificada` todavía (todas son `por_verificar`), y ningún
motor debe presentar como firme una cifra que dependa de una pregunta abierta.

## Cómo se cierra una pregunta

1. El fiscalista responde con **nombre, fecha y fuente** (artículo, regla de la RMF con su DOF, o criterio del SAT).
2. Se mueve la pregunta a la sección Resueltas con esos tres datos.
3. Se actualiza la ficha: `estado_verificacion: verificada`, `verificada_por` y `fecha` (la prueba `tests/normas-sincronia.spec.ts`
   exige ambos campos en una ficha verificada y los prohíbe en una que no lo está).
4. Si la respuesta cambia el cálculo, se abre un PR aparte con el cambio del motor y su prueba; las fichas y este documento no
   modifican la lógica.

## Abiertas

### 1. Layout de la DIOT sin cotejar con el validador del SAT
- **Duda:** el orden y nombre de las columnas del TXT/XML no se cotejó con el validador oficial; la versión del layout se llama
  literalmente `diot-batch-sin-cotejar-con-validador-sat`. Además, ¿el archivo debe ir con tipo de tercero 04/05/15 solo nacional
  como hoy, o el despacho necesita extranjeros y global?
- **Dónde:** `packages/domain-despachos/src/declaraciones/diot-layout.ts:40` (`LAYOUT_DIOT_VERSION`), `:49` (`COLUMNAS_DIOT`),
  `:191` (advertencia al usuario).
- **Fichas:** `rmf-4.5.1`, `liva-32-viii`.
- **Qué se necesita:** subir un archivo real al validador de la DIOT del SAT y registrar resultado y versión del validador.

### 2. Columnas del CSV de la lista 69-B
- **Duda:** el lector busca la fila de encabezado con las columnas RFC y Situación del contribuyente y tolera renglones de título
  antes del encabezado. ¿Cuáles son las columnas oficiales vigentes y el orden en que el SAT las publica hoy?
- **Dónde:** `packages/domain-despachos/src/cfdi/efos.ts:172` (`parsearListado69B`), `:180` (búsqueda del encabezado), `:257`
  (efecto por situación del emisor).
- **Ficha:** `cff-69-b`.
- **Qué se necesita:** el CSV real del mes y confirmar el efecto fiscal que se muestra para presunto, definitivo, desvirtuado y
  sentencia favorable.

### 3. Plazos del calendario fiscal (D-26)
- **Duda:** DIOT el último día del mes siguiente (RMF 4.5.1); balanza el día 3 (moral) o 5 (física) del segundo mes siguiente
  (RMF 2.8.1.6); declaración anual 31 de marzo y 30 de abril; pagos mensuales el día 17. El propio código los marca POR VALIDAR.
  ¿Son los vigentes, con qué regla y sobre qué calendario de días inhábiles?
- **Dónde:** `packages/domain-despachos/src/vencimientos/calendario-fiscal.ts:16` a `:19` (resumen de plazos), `:255`, `:262`,
  `:278`, `:288`, `:290`.
- **Fichas:** `cff-12`, `rmf-4.5.1`, `rmf-2.8.1.6`, `lisr-76-150`, `liva-5-d`, `lft-74`.

### 4. Retenciones de ISR e IVA en honorarios a personas morales
- **Duda:** el validador compara contra 10 por ciento de ISR y dos terceras partes del IVA como referencia y solo avisa si no
  coinciden. ¿Esas son las retenciones aplicables a honorarios pagados por personas morales, y cuándo aplican otras?
- **Dónde:** `packages/domain-despachos/src/cfdi/reglas-fiscales-avanzadas.ts:38` (tolerancia), `:247` a `:256` (avisos).
- **Ficha:** `liva-1-a-5` (retención de IVA). La ficha de la retención de ISR queda por crear cuando el fiscalista cite el artículo.

### 5. RESICO
- **Duda:** (a) RESICO persona física: tasas mensuales de 1.00 a 2.50 por ciento y tope de 3,500,000 pesos, ¿y sus retenciones?;
  (b) RESICO persona moral: el motor de declaraciones lo calcula con tasa fija de 30 por ciento sobre deducciones pagadas
  y el de pagos provisionales lo declara "aún no modelado". ¿Cuál es el tratamiento correcto?
- **Dónde:** `packages/domain-despachos/src/pagos-provisionales/engine.ts:21`, `:42`, `:45`, `:332`;
  `src/declaraciones/isr-engine.ts:148`; `src/declaraciones/isr-tablas.ts:129`, `:163`.
- **Fichas:** `lisr-113-e`, `lisr-9-206-209`.

### 6. ISR de pagos provisionales: 601 por flujo o nominal, 626 persona moral y tabla fija del 612
Hallazgos del revisor del PR #322.
- **6a. 601:** los ingresos de persona moral se acumulan por CFDI emitido (nominal, incluye PPD aún no cobrados), mientras que el
  IVA se calcula por flujo. ¿Es correcto para el pago provisional? Quedan fuera anticipos y cobros sin CFDI.
  Dónde: `packages/domain-despachos/src/pagos-provisionales/engine.ts:12`, `:14`, `:290`, `:291`. Ficha: `lisr-14-17`.
- **6b. 626 de persona moral:** el motor responde "no soportado" para morales en 626. Dónde: `engine.ts:332`. Ficha: `lisr-113-e`.
- **6c. 612:** la tarifa mensual del artículo 96 se escala por meses transcurridos y solo hay tabla verificada por el código para
  2025 y 2026; el cálculo toma la del ejercicio sin un mecanismo de actualización. ¿El escalado es correcto y cómo se
  actualiza cada ejercicio? Dónde: `engine.ts:17`, `:80`, `:93`, `:312`; `src/declaraciones/isr-tablas.ts:87`.
  Fichas: `lisr-106`, `lisr-96`.

### 7. PPD, REP y acreditamiento
- **Duda:** el IVA se cuenta en el mes de la fecha de pago del REP; un CFDI PPD sin REP no acredita ni traslada. ¿Qué pasa con
  pagos parciales, pagos en moneda extranjera (hoy se reportan pero no se suman) y la clave de forma de pago 99 en el REP?
- **Dónde:** `packages/domain-despachos/src/cfdi/rep.ts:7`; `src/pagos-provisionales/engine.ts:23`;
  `src/cfdi/reglas-fiscales-avanzadas.ts:271`; `src/devolucion-iva/calculo.ts:66`.
- **Fichas:** `rmf-2.7.1.29`, `liva-1-b`, `liva-1-a-5`.

### 8. Devolución de IVA
- **Duda:** plazo de 40 días hábiles (20 con dictamen o garantía), días inhábiles fijos de 2026 en el cómputo, umbral de
  congruencia de 10,001 pesos con tolerancia de 1 peso y la advertencia de la presunción del artículo 59-III. (D-P3-34: el
  cómputo ya no usa los días inhábiles fijos de 2026 para cualquier año; usa el calendario fiscal del año real, con Jueves y
  Viernes Santo "por validar" -- ver la pregunta 10c.)
- **Dónde:** `packages/domain-despachos/src/devolucion-iva/calculo.ts:313`, `:317`, `:455`, `:456`, `:463`;
  `src/devolucion-iva/workpaper.ts:27`.
- **Fichas:** `cff-22`, `cff-59`, `cff-12`.

### 9. Citas inconsistentes detectadas al armar las fichas
- **9a. Fundamento de la DIOT:** `diot-layout.ts:3` cita LIVA 32-VIII y `reglas-fiscales-avanzadas.ts:271` cita Art. 32 LISR y
  Art. 31 LIVA. Fichas: `liva-32-viii`.
- **9b. Escalamiento:** `src/vencimientos/engine.ts:61` cita CFF 89 como fundamento de la revisión humana; ese artículo no parece
  el pertinente. Ficha: `cff-89`.
- **9c. Plazo de timbrado:** `reglas-fiscales-avanzadas.ts:22` y `:239` citan RMF 2.7.1.35 (72 horas) y el motor trunca a días
  completos. Ficha: `rmf-2.7.1.35`.
- **9d. Retenciones y acreditamiento:** el código cita LIVA 1-B y 5; la tarea pide 1-A y 5. Fichas: `liva-1-a-5`, `liva-1-b`.

### 10. Paridad 3 fiscal: proporción de IVA, calendario ampliado y DIOT (paridad3-despachos-fiscal-correcciones)
Este PR NO se fusiona sin el visto bueno del fiscalista sobre estas preguntas (tasas y DIOT).
- **10a. Proporción de acreditamiento del IVA (LIVA 5-V) cuando faltan datos.** El papel acredita al 100 % salvo que el contador
  capture `actosExentosCentavos` (y, si difieren de los CFDI emitidos del mes, `actosGravadosCentavos`). Sin ese dato el papel
  advierte "Proporción no aplicada: sin actos exentos registrados". Dudas: (i) ¿basta la proporción del MES aplicada a todo el IVA
  acreditable, o hay que separar gasto de uso exclusivo gravado, exclusivo exento y mixto (art. 5 RLIVA)? (ii) ¿la proporción es
  mensual o acumulada del ejercicio en el pago provisional? (iii) los actos a tasa 0 % cuentan como gravados; ¿se capturan aparte
  de los exentos? (iv) la alerta "IVA acreditable mayor a 3 veces el IVA trasladado" viene del sistema suelto: ¿el factor 3 y la
  referencia al art. 22 CFF son los correctos? Dónde: `packages/domain-despachos/src/pagos-provisionales/engine.ts` (`calcularIva`,
  `FACTOR_ALERTA_ACREDITABLE`). Fichas: `liva-1-a-5`.
- **10b. Obligaciones por régimen nuevas (migración 024).** Se agregan al calendario: retenciones de ISR/IVA (día 17), IMSS mensual
  (día 17), IMSS bimestral RCV/Infonavit (día 17 del mes siguiente al bimestre), ISN estatal (se asume día 17: varía por entidad) e
  informativa anual de retenciones (15 de febrero). Dudas: (i) la ficha de cartera no captura qué obligaciones tiene cada cliente
  (trabajadores, honorarios, arrendamiento), así que se generan para todo régimen con obligaciones periódicas, con nota "aplica
  si..."; ¿cuáles NO aplican por régimen (p. ej. 603, 626, 606)? (ii) plazo y tasa del ISN por entidad federativa; (iii) fundamento y
  fecha de la informativa anual (LISR 76-X y 99-VII); (iv) ¿el barrido avisa a 7/3/1 días hábiles o hay otro calendario de avisos
  que prefiera el despacho? Dónde: `src/vencimientos/calendario-fiscal.ts` (`calcularCalendarioFiscal`), `src/vencimientos/engine.ts`
  (`decidirEscalamientoHabil`). Fichas: `cff-12`, `lisr-106`.
- **10c. Días inhábiles del plazo de devolución.** Ahora usa `feriadosDelAnio` del año real. Jueves y Viernes Santo se tratan como
  inhábiles "por validar" (resolución del SAT de días inhábiles). ¿Hay otros días inhábiles que el SAT declare cada año (periodos
  vacacionales) que deban entrar al cómputo del plazo de 40 días hábiles? Dónde: `src/devolucion-iva/calculo.ts` (`esDiaHabil`),
  `src/vencimientos/calendario-fiscal.ts` (`feriadosDelAnio`). Ficha: `cff-12`, `cff-22`.
- **10d. Layout DIOT 2025 de 54 campos (D-P3-04, NO se construye aquí).** El layout vigente es el de 24 campos sin cotejar
  (pregunta 1). Se necesita el layout 2025 oficial y un archivo de ejemplo validado por el SAT antes de cambiarlo. Dónde:
  `src/declaraciones/diot-layout.ts`.
- **10e. DIOT: qué entra.** Desde este PR la DIOT solo toma compras del cliente: CFDI recibidos, vigentes (ni cancelados ni "no
  encontrados" ante el SAT), válidos y con RFC del contribuyente tomado de la ficha de cartera. Un CFDI de dirección desconocida
  solo entra si el receptor es el RFC de la ficha. Dudas: (i) ¿un CFDI con revisión rechazada debe excluirse (hoy no se excluye;
  `TODO(D-P3-23)`)? (ii) ¿un CFDI de estado SAT "pendiente" (nunca verificado) debe entrar? (hoy sí). (iii) el IEPS y los impuestos
  locales ya integran el total del CFDI pero no el IVA reportado en la DIOT. Dónde: `src/declaraciones/diot-desde-invoices.ts`.
  Fichas: `rmf-4.5.1`, `liva-32-viii`.
- **10f. Avisos nuevos de CFDI y REP (D-P3-31).** Son avisos, no errores: PPD con FormaPago distinta de 99 y PUE con 99; UsoCFDI contra
  RegimenFiscalReceptor (la tabla `REGIMENES_RECEPTOR_POR_USO` es una transcripción del catálogo c_UsoCFDI sin validar); IVA por
  concepto contra Base x Tasa; retención de ISR del 1.25 % para emisores RESICO PF; y en el REP FormaDePagoP (sin 99), MonedaP,
  TipoCambioP y TipoCadPago. ¿Alguno debe ser error (rechazo) en vez de aviso, con qué fundamento? Dónde:
  `src/cfdi/avisos-cfdi.ts`, `src/cfdi/rep.ts` (`avisosPagoRep`), `src/cfdi/reglas-fiscales-avanzadas.ts`. Fichas: `anexo-20`,
  `cff-29-29-a`.

## Resueltas

Ninguna todavía. Formato de cada entrada cuando se cierre:

- **Pregunta:** número y título.
- **Respuesta:** texto breve.
- **Firma:** nombre del fiscalista.
- **Fecha:** AAAA-MM-DD.
- **Fuente:** artículo, regla y publicación en el DOF o liga del SAT.
- **Ficha actualizada:** id y PR del cambio.
