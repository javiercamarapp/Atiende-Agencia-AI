# Roadmap de Atiende (corte 9-nov-2026)

No existía un documento de roadmap en el repo: la «lista maestra al 100 %» del 13-oct vivía solo en la Mac del loop (`pm/LISTA-MAESTRA-100.md`). Este archivo la
sustituye. Estado operativo diario y backlog por olas: [`docs/relevo/`](relevo/relevo.md). Mediciones: [`docs/evals/agente-pm/`](evals/agente-pm/README.md).

`main` = `cd4eeadc3` (Merge #778). GitHub Actions bloqueado por facturación desde el 8-nov (sin CI no se fusiona).

## Porcentaje real (medido, no estimado)

| Frente | Cifra | Qué es | Fuente |
|---|---|---|---|
| Paridad visual con Rovaq (ds3) | **74 %** | auditoría R2 sobre `3c39f025d` (8-nov), de 61 % en R1; por rubro: shell 95, cabecera y guía 92, encabezado 72, componentes 62, dashboard 75, verticales 55, Pregúntale 85, onboarding 60, superposiciones 55, carga 88, móvil 72, i18n 40 | auditor de paridad del loop |
| Agente de WhatsApp de PM | **86.8 %** (347/400) | banco ciego C4 ×5 sobre #718 `5107d110d`; el suelto da 88.8 % en el mismo banco (sin diferencia significativa) | `docs/evals/agente-pm/README.md` |
| Agente de voz de PM | **75 % limpio / 83 % restaurante** (n=12 cada uno) | E2E sintético (LiveKit + worker, sin teléfono) sobre #813 `c7ec4f03b`; latencia de respuesta 7-10 s p50 contra meta de 4 s | `docs/evals/agente-pm/voz.md` |

Ninguna de las tres cifras está medida sobre `main` con el código que se fusionaría: WhatsApp y voz viven en PRs abiertos (#718; #752 → #813).
Meta del agente (relevo del 8-oct): ≥ 95 % en cada suite, 2 rondas seguidas sin defectos y auditoría final.

## Qué entró a producción en octubre-noviembre

| Carril | En `main` | Abierto / pendiente |
|---|---|---|
| **Diseño ds3 (paridad Rovaq)** | tokens, botones, logo y fuentes (25-27 oct); shell, cabecera, superposiciones, carga, móvil, login Rovaq, paleta, diseño por organización, guía (motor), i18n base y comunes, contenido del Resumen, cobertura del Copiloto (6-8 nov); **diseño nuevo por omisión para todas las organizaciones** (#758, 8-nov, migración 0076 aplicada) | páginas de restaurantes #762 #763 #764 #812; Resumen general #759; i18n de páginas (~18 PRs encadenados desde #770; restaurantes ~72 % de textos si entran todos); rediseño R2 #819; retiro del CI viejo #760 |
| **Alta autoservicio de restaurantes** | alta de sucursal (#737), registro de restaurantes (#774, migración 0077 **sin aplicar**), importador de menú (#783), WhatsApp Embedded Signup **apagado por bandera** (#792) | «primer valor en < 30 min» #796 (en conflicto, migración por renumerar); CTA de registro #798 |
| **Cobro (planes medidos)** | — | cadena #771 → #793 (tabulador, planes Básico/Plus/Pro, pago por uso, cotizador con margen) → #802 (Stripe por plan, IVA, SPEI, cobranza) → #809 (pantallas). Planes aprobados por el dueño el 7-nov con piso de margen de 55 %; migraciones de la cadena por debajo de 000800 (renumerar) |
| **CFO de la plataforma (superadmin)** | cockpit de economía por cliente (#786, migración 0085 **sin aplicar**) | #791 métricas → #794 API → #797 pantalla → #808 recomendaciones con IA → #810 exportes (Excel y PDF para inversionistas). Pendiente del dueño: gastos fijos, marketing, caja, presupuesto, costos unitarios faltantes |
| **Voz** | stack ElevenLabs con Deepgram de respaldo y cerebro de dos niveles opt-in (#719, 7-nov) | calidad r2 #752 → r3 #813 (sin E2E en su cabeza final); **sin infraestructura**: Fly sin app, LiveKit sin trunk, Twilio sin número ni bundle MX, desvío sin contratar; 0 llamadas reales |
| **Agente de WhatsApp** | modelos por actividad (#750, migración 104 aplicada), ARCO (#757, migración 106 aplicada) | cerebro medido detrás de bandera #718 (3 defectos de servidor arreglados en `fa304de9f`, sin medir); umbral de pedido grande por decidir |
| **Seguridad y operación** | RLS de folios CFDI (#761; su migración `mcp_cfdi` 002 **sin aplicar**: la tabla sigue sin RLS), desaturación de Actions (#795), plan de crons (#782) | MFA superadmin #766, CSP enforce #775 (rojo), smoke contra el alias #779, Sentry #780, typecheck OOM #815 |

## Lo que falta para «listo para producción» de PM

1. **Destrabar CI** (facturación de GitHub) y dejar `main` en verde (#815).
2. **Aplicar migraciones pendientes** que ya están en `main`: 0075, `mcp_cfdi` 002, 0077, 0085, 0090.
3. **WhatsApp**: medir #718 en `fa304de9f` (C4 ×5, con OK de gasto), decidir el umbral de pedido grande y fusionar detrás de bandera.
4. **Voz**: fusionar #752 → #813, medir su cabeza, bajar latencia a la meta; después infraestructura (Twilio + bundle MX, LiveKit trunk, Fly, desvío) y primeras llamadas reales.
5. **Cobro y CFO**: fusionar sus cadenas (renumerar migraciones), cargar los datos del dueño.
6. **Frontend**: terminar páginas e i18n de restaurantes hasta la paridad objetivo; luego las otras verticales (congeladas por enfoque en restaurantes).
7. **Legal**: aviso de privacidad revisado por abogado. Lista completa de decisiones: [`docs/relevo/bloqueantes.md`](relevo/bloqueantes.md).

## Fase final (orden del 14-oct, sin cambios)

Cuando el agente de PM cumpla la meta, comparar con el mismo agente todos los modelos y formas (WhatsApp y voz: cascada contra voz nativa, ZDR y regiones, telefonía real)
y decidir calidad, precio y margen con datos.
