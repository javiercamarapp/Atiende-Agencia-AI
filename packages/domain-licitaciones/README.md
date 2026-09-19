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

## Cobertura de descubrimiento de convocatorias (honesta, Fase 9)

`connector-registry.ts` registra 10 fuentes; solo 4 tienen una implementación
REAL (`connector` presente) y solo 2 están `liveVerification.verified: true`.
Ver el `README.md` de `apps/worker/src/jobs/licitaciones/` para la tabla
completa de estado por fuente, el contrato real descubierto de cada una
(endpoints, paginación, volumen) y los gaps declarados. Resumen:

- **SÍ cubierto (vigentes reales)**: Nuevo León (`nl_ocds`, API OCDS pública,
  verificada) es la ÚNICA fuente que hoy produce convocatorias vigentes
  reales. CDMX (`cdmx_ocds`) tiene una implementación real y completa pero el
  recurso público verificado está estancado desde 2023 (gap de la FUENTE, no
  del código) y `compras_mx_historico` es histórico (contratos ya
  concluidos, nunca vigentes por diseño).
- **NO cubierto**: ComprasMX en vivo / DOF / cobertura nacional amplia --
  ver decisión ya tomada (no se evade reCAPTCHA/Akamai ni se scrapea prosa
  libre sin API) y el conector `aggregator` (API por pegar, sin proveedor
  elegido) como única vía realista a esa cobertura.
- **Cómo se amplía**: configurar `LICITACIONES_AGGREGATOR_API_KEY` +
  `LICITACIONES_AGGREGATOR_BASE_URL` (ver `docs/CREDENCIALES.md`) contra un
  proveedor de agregación elegido, sustituyendo `connectors/aggregator.ts`
  únicamente en su mapeador (`mapAggregatorItem`) si el contrato real del
  proveedor difiere del documentado en `AggregatorTenderItem`.
