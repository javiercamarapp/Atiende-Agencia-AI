# Restaurantes: documentación del agente y de la operación

Documentos de operación de **Los Taquitos de PM** (y de cualquier restaurante de la plataforma). Portan lo útil del repo suelto
`atiende-restaurantes` (system prompt, base de conocimiento del menú, alta de WhatsApp y runbook) adaptado a lo que está fusionado hoy:
LLM por **OpenRouter**, WhatsApp por **Meta Cloud API**, comandas por el puerto **SoftRestaurantPort**, voz con **Gemini Live** (`docs/VOZ-PM.md`) y
crons de `vercel.json`.

| Documento | Para qué sirve |
|---|---|
| [`agente-system-prompt.md`](agente-system-prompt.md) | Qué dice el prompt del agente, de dónde sale, qué es editable y qué lo hace cumplir el servidor |
| [`agente-conocimiento-menu.md`](agente-conocimiento-menu.md) | De dónde sabe el agente el menú y los precios (no hay documento estático) y cómo mantenerlo |
| [`whatsapp-setup.md`](whatsapp-setup.md) | Alta del número de WhatsApp (Meta Cloud API), variables, webhook, plantillas y verificación |
| [`runbook-operacion.md`](runbook-operacion.md) | Operación diaria, incidentes, señales y qué hacer en cada caso |

Otros documentos que se cruzan con estos: `docs/CICLO-PUNTA-A-PUNTA-RESTAURANTES.md` (el ciclo por rol y qué es simulado), `docs/demo-pm/` (guion y carga de la
demo), `docs/VOZ-PM.md` (voz), `docs/CREDENCIALES.md`, `docs/CRONS.md`, `docs/runbooks/INCIDENTES.md` y `docs/NOTIFICACIONES.md`.
