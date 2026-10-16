# Restaurantes: backlog P2 (no construir sin decisión)

Fuente: `huecos-finales-restaurantes` §9, que viene de la auditoría del 3-oct del storefront viejo y de los 21 informes de investigación
(`work/qa/restaurantes/huecos-finales-orig.md` §3 y §4). Solo se registra; nada de esto está construido.

| Elemento | Origen (id del informe) | Nota |
|---|---|---|
| Presets de propina 10/12/15 % | A-09 | |
| Alérgenos y filtros del menú | A-14 | El guard de alergias del agente ya escala. |
| Atribución de origen del pedido (QR de bolsa o ticket, click-to-WhatsApp) | A-41 / A-42, B-21 | |
| Agente de eventos con cotización y anticipo | B-01 | |
| Desborde de reparto con Uber Direct o Lalamove | B-23 | |
| Menú ordenado por más vendidos | B-27 | |
| Reporte semanal de eventos raros del `audit_log` | C-25 | |
| Foto de bolsa como evidencia | C-26 | |
| Promos automáticas en horas valle | C-29 | |
| Importar menú desde foto o PDF | — | |
| MCP público de menú | C-28 / B-13 | `mcp-servers` solo tiene `cfdi`. |
| Nota por renglón y diálogo de producto en el storefront | S-06, S-05 | |
| Enlace de empleo | S-26 | |
| Analítica sin cookies de terceros | S-40 | |
| Cola de Rappi/Uber/DiDi | — | P0 solo si el dueño vende por apps: PREGUNTA al dueño. |
| Lealtad simple por teléfono (cashback) | A-40 / B-43 | Requiere decisión económica de PM (la diseña `cliente-360-restaurantes`). |
| "Mis pedidos / repetir" sin cuenta | S-30 | Coordinar con `cliente-360-restaurantes`. |
