# Contexto del dominio de despachos

Glosario del dominio y rótulos oficiales en español para la interfaz. Lo usa la tarea UNI-C (rótulos de la UI). Todo lo que
sea una opinión fiscal está en `docs/despachos/PREGUNTAS-AL-FISCALISTA.md`; las normas citadas, en
`packages/domain-despachos/normas/`.

## Glosario

| Término | Qué significa en este producto |
|---|---|
| Despacho | La organización contable cliente de Atiende. Cada despacho atiende una cartera de clientes. |
| Cartera de clientes | Los contribuyentes que atiende el despacho; cada uno es una "propiedad" en el modelo de datos y tiene una ficha (RFC, régimen, periodicidad, responsable). |
| CFDI | Comprobante Fiscal Digital por Internet: la factura electrónica. Tipos usados: I (ingreso), E (egreso o nota de crédito), N (nómina), P (pago). |
| PUE | Método de pago "Pago en una sola exhibición": se paga al emitir. |
| PPD | Método de pago "Pago en parcialidades o diferido": el pago ocurre después y se documenta con un REP. |
| REP | Recibo electrónico de pago (complemento de pago, versión 2.0): CFDI tipo P que documenta un cobro de una factura PPD. El IVA se reconoce en el mes de la fecha de pago. |
| Póliza | Asiento contable con partidas de cargo y abono dentro del libro contable. |
| Catálogo de cuentas | Lista de cuentas del cliente; se envía al SAT en el formato del Anexo 24. |
| Balanza de comprobación | Saldos y movimientos por cuenta del mes; se envía al SAT con contabilidad electrónica. |
| Contabilidad electrónica | Envío mensual al SAT de catálogo y balanza (Anexo 24). |
| DIOT | Declaración informativa de operaciones con terceros: por proveedor, el valor de lo efectivamente pagado en el mes. |
| 69-B o EFOS | Lista del SAT de contribuyentes que facturan operaciones presuntamente inexistentes. Situaciones: presunto, definitivo, desvirtuado y sentencia favorable. |
| Vencimiento | Fecha límite de una obligación fiscal, ajustada al siguiente día hábil si cae en inhábil. |
| Pago provisional | Anticipo mensual de ISR, calculado por régimen (601, 612, 626). |
| Régimen 601, 612, 626 | 601 general de personas morales, 612 personas físicas con actividad empresarial y profesional, 626 RESICO personas físicas. |
| Iguala | Cuota periódica pactada que cobra el despacho por sus servicios. |
| Cobranza | Seguimiento de las cuentas por cobrar del despacho a sus clientes. |
| Cierre mensual | Lista de tareas contables y fiscales de un mes que termina con un cierre irreversible del periodo. |
| Conciliación | Comparación de los movimientos del estado de cuenta bancario contra facturas y cartera. |
| Devolución de IVA | Solicitud de saldo a favor de IVA con su papel de trabajo y plazo de resolución. |
| Papel de trabajo | Documento de soporte con las cifras y las advertencias de un cálculo; no es una determinación firme. |
| Portal del cliente | Página pública con enlace temporal con la que el cliente del despacho sube documentos y escribe mensajes. |
| Outbox | Cola de correos por enviar; el usuario no la ve en la interfaz. |
| Ficha normativa | Archivo de `normas/` que documenta una norma citada por el motor y si está verificada. |

## Rótulos oficiales en español para la interfaz

Cada fila da el término en inglés que no debe aparecer en la interfaz y el rótulo que lo reemplaza. "Bookkeeping" y "Staff" son
los rótulos que hoy muestra la barra lateral (`apps/web/src/verticals/despachos/DespachosShell.tsx:115` y `:121`); "Dashboard" ya
se muestra como "Resumen" (línea 103). Las rutas no cambian.

| Término en inglés | Rótulo oficial |
|---|---|
| Bookkeeping | Clasificación contable |
| Matching | Coincidencias |
| Overrides | Ajustes manuales |
| Staff | Equipo |
| Outbox | Cola de envíos |
| Workpaper | Papel de trabajo |
| Receivables | Cuentas por cobrar |
| Payroll | Nómina |
| Reconciliation | Conciliación |

Reglas de uso:

- La interfaz habla español de México; los términos fiscales oficiales se conservan tal cual (CFDI, REP, DIOT, PUE, PPD, RFC).
- Un rótulo no se traduce de forma distinta en dos pantallas; este cuadro es la fuente.
- Los rótulos que ya están en español en la barra lateral (por ejemplo "Cartera de clientes", "Cierre mensual", "Pagos
  provisionales") no cambian.
- Cambiar rótulos no cambia rutas, nombres de API ni identificadores de código.
