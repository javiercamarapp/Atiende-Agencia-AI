# @atiende/domain-despachos

Nota: este archivo no existía antes de la Fase 10 (auditado al construirla —
`domain-despachos` era el único paquete de dominio del monorepo sin README propio,
a diferencia de `domain-hoteles`/`domain-citas`/`domain-rentas`/`domain-restaurantes`/
`domain-licitaciones`). No se reconstruye aquí el historial completo de las Fases
1-9 (ver `docs/REQUISITOS.md` y el comentario de cabecera de cada migración/archivo
de `src/` para el diseño de cada una); esta entrada arranca documentando la fase que
lo agrega.

## Fase 10 — cobranza automatizada (cuentas por cobrar)

Gap real verificado contra el original (`~/Desktop/supabase/despachos/b2b_ai/
services/collections.py` + `collections_report.py` + `collections_templates.py`):
`domain-despachos` no tenía ningún módulo de cobranza — ni seguimiento de estado de
facturas emitidas vs. pagos recibidos, ni aging, ni recordatorios escalonados. El
comentario de cabecera de `despachos.invoice` (migración 001) ya declaraba que
"cobranza" leería de esa tabla; esta fase cierra esa referencia pendiente.

- `src/cobranza/engine.ts` — motor determinista (sin LLM), port literal de
  `CollectionsManager.analyze`/`collectability_score` y de
  `aging_report`/`projection`/`summary`: clasificación por antigüedad (buckets
  0-30/31-60/61-90/90+), score de cobrabilidad (0..1, ponderado por antigüedad +
  historial de respuestas/escalamientos), análisis de cartera, proyección de cobro
  esperado (monto × score) y resumen ejecutivo con alertas. 100% puro/testeable, sin
  acceso a base de datos — mismo criterio que `vencimientos/engine.ts` en este mismo
  paquete.
- `src/cobranza/templates.ts` — las 5 plantillas de recordatorio en español MX
  (`pre_vencimiento`/`vencimiento`/`recordatorio_formal`/`segundo_recordatorio`/
  `escalamiento`), texto traducido 1:1 del origen, para email (subject + body) y
  WhatsApp.
- `despachos.receivable` (migración 004) — arranca el reloj de cobranza sobre un
  invoice tipo 'I' ya ingerido (`fecha_vencimiento` + `pagado_en`/`monto_pagado`
  cuando se liquida). Deliberadamente una tabla aparte del invoice (no una columna
  nueva en `despachos.invoice`): el CFDI en sí no trae una fecha de vencimiento
  utilizable, e ingerir un CFDI (flujo 1, estable desde Fase 1) nunca debía acoplarse
  a si ese invoice también entra a cobranza activa.
- `despachos.collection_event` (migración 004) — auditoría de cada recordatorio
  generado y de las respuestas del deudor (`etapa = 'respuesta'`); alimenta el score
  de cobrabilidad como historial.

**Límite deliberado, heredado del origen (no una omisión silenciosa de esta fase):**
el `CollectionsManager` original nunca envía mensajes reales — su propio docstring lo
dice: "NO envía mensajes reales: solo genera el contenido y, opcionalmente, lo
registra... El envío real queda a cargo del canal de notificaciones del cliente."
Este port respeta ese límite exacto: `construirRecordatorioCobranza` genera el
contenido (subject/body o texto de WhatsApp) y `insertCollectionEvent` deja el rastro
de auditoría, pero **no hay integración con un canal de envío real** (`messaging_
outbox`/`whatsapp-gateway`/email) en esta fase. Conectar el contenido generado a un
canal real (con aprobación humana antes de enviar, mismo patrón que
`domain-rentas`/`mensajeria` y `domain-citas`) es trabajo de una fase futura.

Migración nueva: `migrations/004_cobranza_schema.sql`.
