# @atiende/domain-licitaciones

Dominio real y portado — ya NO es una carpeta reservada. Actualizado en el barrido
de documentación de las rondas 13/14/16: este README decía "aún no portado",
desactualizado desde hace muchas fases (`src/` tiene 46 archivos, `migrations/` 22).
Portado de `licitaciones/packages/agents` (lo específico de negocio; el gateway LLM
compartido vive en `@atiende/agent-core`, nunca duplicado aquí).

Cubre, de punta a punta: descubrimiento de convocatorias (conectores reales, ver
`connectors/`/`connector-registry.ts`), checklist de cumplimiento/integridad,
matching de perfil de empresa, flujo de aprobación granular, ensamblado de
paquete/propuesta económica y técnica (con agente de redacción/revisión asistido
por IA y aprobación humana obligatoria, `llm-requirement-extractor.ts`), ciclo de
vida y facturación de contrato, radar de renovación, autopsia de fallos,
inconformidades, y las alertas/recordatorios de plazo con su propio dispatcher de
correo (`alert-notifications.ts`/`email-dispatch.ts`). Consumido por
`apps/api/src/routes/verticals/licitaciones/` (23 archivos de rutas) y por los jobs
reales de `apps/worker/src/jobs/licitaciones/` (ver ese README para el detalle de
scheduler).
