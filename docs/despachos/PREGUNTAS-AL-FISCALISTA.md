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
  congruencia de 10,001 pesos con tolerancia de 1 peso y la advertencia de la presunción del artículo 59-III.
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

### 10. Nómina 2026: subsidio, IMSS por rama, prestaciones y exentos (paridad3)
Bloquea la fusión del PR de nómina: ningún valor está validado. Todo vive en `packages/domain-despachos/src/nomina/parametros.ts`.
- **10a. Subsidio al empleo.** 15.59 % de la UMA 2025 (3,439.46) en enero de 2026 y 15.02 % de la UMA 2026 (3,566.22) desde febrero,
  con ingreso mensual máximo de 11,492.66 (decreto DOF 31-dic-2025). Duda: confirmar porcentajes y tope, el prorrateo por 30.4 días
  en periodos no mensuales y que el excedente sobre el ISR no se pague en efectivo (OtroPago 002 con importe 0.00 y el subsidio
  causado en `SubsidioAlEmpleo`). Fichas: `lisr-113-174`.
- **10b. UMA.** 113.14 diaria / 3,439.46 mensual desde el 1-feb-2025 y 117.31 / 3,566.22 desde el 1-feb-2026.
- **10c. IMSS por rama.** Obrero: excedente EyM 0.40 % sobre (SBC − 3 UMA), prestaciones en dinero 0.25 %, GMP 0.375 %, IV 0.625 %,
  CEAV 1.125 %. Patronal: cuota fija 20.40 % de la UMA, excedente 1.10 %, prestaciones en dinero 0.70 %, GMP 1.05 %, IV 1.75 %,
  guarderías 1 %, retiro 2 %, INFONAVIT 5 %, RT por omisión clase I 0.54355 %. Ficha: `lss-infonavit`.
- **10d. CEAV patronal progresiva 2026.** Dos fuentes secundarias discrepan en el tramo 3.51 a 4.00 UMA (6.613 % usado vs 6.94 %). Resto:
  3.150, 3.676, 4.851, 5.556, 6.026, 6.361 y 7.513 % (4.01 UMA en adelante). Pedir la tabla oficial del decreto DOF 16-dic-2020.
- **10e. Factor de integración y vacaciones.** 1.0493 el primer año (aguinaldo 15, vacaciones 12, prima 25 %) y escalera del art. 76 LFT.
  Ficha: `lft-76-127`.
- **10f. Exentos del art. 93 LISR.** Aguinaldo 30 UMA, prima vacacional 15 UMA, PTU 15 UMA, tiempo extra 50 % hasta 5 UMA por semana, y que
  el gravado se sume al ingreso del periodo (sin la tasa efectiva del art. 174 RLISR). Ficha: `lisr-93`.
- **10g. PTU.** Tope del art. 127-VIII: tres meses de salario o promedio de tres años, lo más favorable al trabajador.
- **10h. XML.** `Total` y `Descuento` del comprobante no se tocaron: hoy `Total` = `SubTotal` (no resta deducciones). Confirmar la regla del
  CFDI de nómina 4.0 (Total = SubTotal − Descuento).
- **Dónde:** `packages/domain-despachos/src/nomina/{parametros,subsidio-empleo,imss-engine,prestaciones,payroll-engine,xml-nomina}.ts`.

## Resueltas

Ninguna todavía. Formato de cada entrada cuando se cierre:

- **Pregunta:** número y título.
- **Respuesta:** texto breve.
- **Firma:** nombre del fiscalista.
- **Fecha:** AAAA-MM-DD.
- **Fuente:** artículo, regla y publicación en el DOF o liga del SAT.
- **Ficha actualizada:** id y PR del cambio.
