# Documentos legales de privacidad (BORRADOR técnico)

> **Es un borrador técnico de calidad. NO es asesoría legal.** Lo redactó un desarrollador con apoyo de un asistente de IA a partir del
> texto oficial de la ley. **Debe revisarlo un abogado especialista en protección de datos personales antes de publicarse o de ponerse
> frente a un cliente final.** Nada de esta carpeta debe presentarse como aviso vigente mientras tenga marcadores sin completar.

## Qué hay aquí

| Archivo | Para qué sirve |
| --- | --- |
| `aviso-privacidad-integral.md` | Aviso de privacidad **integral** para un restaurante (responsable) que usa el agente de WhatsApp y voz de Atiende. Incluye el Anexo B: aviso de Atiende como responsable de sus propios usuarios y prospectos. |
| `aviso-privacidad-simplificado.md` | Textos **simplificados**: primer mensaje de WhatsApp, guion de apertura de la llamada, texto corto para web y el mensaje de revocación. |
| `publicable/` | Aquí solo entra una versión **ya completada** (sin marcadores). Hoy contiene `aviso-privacidad-integral.md` v1.0, vigente desde el 21-oct-2026, publicado por autorización explícita del dueño del negocio **sin revisión de abogado**; se sirve como página estática en `apps/web/public/aviso-privacidad.html` (regenerar si cambia el `.md`). La prueba `privacidad-avisos-legales.spec.ts` falla si un archivo de esta carpeta conserva un marcador sin completar. |

## Datos de Atiende ya capturados (16-oct, dados por el dueño del negocio)

Razón social «Atiende AI, S.A. de C.V.»; domicilio Calle 43 No. 147A por 38 y 36D, Colonia Benito Juárez Norte, Mérida, Yucatán (ciudad y estado por confirmar). Se usan para Atiende (encargada y responsable del Anexo B). El correo ARCO se escribió «ventaslikida.ai»: la dirección exacta NO se conoce y queda como marcador (probablemente ventas@likida.ai). Los campos del restaurante cliente (sección 1) siguen por completar.

## Marcadores por completar

Todo dato del negocio que el repo no conoce va como `[[POR COMPLETAR: descripción]]` (código postal, correo ARCO exacto, teléfono, persona o área de datos personales, URL del aviso,
RFC, regiones de los proveedores, plazos de conservación definitivos). **No se inventan.** El detector es
`packages/domain-restaurantes/src/privacidad/marcadores.ts` (`marcadoresPendientes`, `assertSinMarcadores`).

## Modelo de roles (el lector debe confirmarlo)

Supuesto con el que está redactado todo el paquete:

1. **El restaurante cliente es el responsable** (Art. 2 fr. XIV; decide para qué y cómo se tratan los datos de sus comensales).
2. **Atiende es la persona encargada** (Art. 2 fr. XII: trata datos "por cuenta del responsable") del agente de WhatsApp/voz y del panel.
3. **Atiende es además responsable** de los datos de sus propios usuarios del panel, prospectos y clientes (Anexo B).
4. Los proveedores (Meta, Google, OpenRouter, Deepgram, ElevenLabs, Twilio, LiveKit, Supabase, Vercel, Resend, Sentry, pasarela de pago)
   son **subencargados** de Atiende / encargados del responsable. La ley vigente **no trae un artículo propio sobre la relación
   responsable-encargado ni la subcontratación** (solo la definición del Art. 2 fr. XII y menciones en Arts. 35 y 53): lo que obliga
   en la práctica es el contrato y el Art. 13 (el responsable responde de que el aviso se respete "por terceros con los que guarde alguna relación jurídica").
   **Pendiente de abogado:** contrato de encargo (qué debe decir, quién notifica vulneraciones) y si algún proveedor actúa como tercero y no como encargado.

## Marco legal verificado

Fuente consultada el 15-oct-2026: texto vigente publicado en
`ordenjuridico.gob.mx/Documentos/Federal/html/wo125102.html` ("Nueva Ley publicada en el DOF el 20 de marzo de 2025"); la liga del PDF en
`diputados.gob.mx/LeyesBiblio/pdf/LFPDPPP.pdf` es el mismo ordenamiento. Verificado leyendo los artículos, no de memoria:

- **Ley Federal de Protección de Datos Personales en Posesión de los Particulares (LFPDPPP), nueva ley publicada en el DOF el 20-mar-2025**;
  entra en vigor al día siguiente (Transitorio Primero) y **abroga la ley del 5-jul-2010** (Transitorio Segundo, fr. I).
- **Autoridad: Secretaría Anticorrupción y Buen Gobierno** (Art. 2 fr. XV). El INAI desaparece: sus funciones pasan a los entes que las adquieren (Transitorio Cuarto) y sus recursos humanos a esa Secretaría (Transitorio Quinto).
- **Definiciones** (Art. 2): aviso de privacidad (fr. I), bloqueo (fr. III), consentimiento (fr. IV), datos sensibles (fr. VI, lista enunciativa: origen, salud, genéticos, creencias, opiniones políticas, preferencia sexual), ARCO (fr. VII), **"Días: días hábiles" (fr. VIII)**, persona encargada (fr. XII), transferencia (fr. XX).
- **Principios** (Art. 5): licitud, finalidad, lealtad, consentimiento, calidad, proporcionalidad, información y responsabilidad. Arts. 6-13 los desarrollan.
- **Consentimiento** (Art. 7): regla general tácito; **expreso** para datos financieros o patrimoniales; **expreso y por escrito** para sensibles (Art. 8); excepciones en Art. 9; revocable sin efectos retroactivos y el aviso debe decir cómo (Art. 7 último párrafo). Cambio de finalidad exige nuevo consentimiento (Art. 11).
- **Contenido mínimo del aviso** (Art. 15, seis elementos): identidad y domicilio; datos tratados señalando los sensibles; finalidades distinguiendo las que requieren consentimiento; opciones para limitar uso o divulgación; mecanismos para ejercer ARCO; procedimiento para comunicar cambios al aviso.
- **Aviso simplificado** (Art. 16 fr. II): obligatorio cuando los datos se obtienen por medios electrónicos, ópticos, sonoros o visuales (WhatsApp, llamada, web); contiene al menos las fracciones I a IV del Art. 15 e indica dónde consultar el integral.
- **Seguridad** (Art. 18, medidas administrativas, técnicas y físicas) y **vulneraciones** (Art. 19: informar de inmediato a la persona titular cuando afecten de forma significativa sus derechos patrimoniales o morales). Confidencialidad (Art. 20).
- **ARCO** (Arts. 21-34): acceso (22), rectificación (23), cancelación con periodo de bloqueo (24; excepciones Art. 25), oposición (26; fr. II cubre **tratamiento automatizado con efectos jurídicos no deseados o que afecte de forma significativa**). Contenido de la solicitud (Art. 28); persona o departamento que tramita (Art. 29); **respuesta en máximo veinte días y ejecución en quince más, ampliables una sola vez por un periodo igual** (Art. 31); causas de improcedencia (Art. 33); **gratuito, salvo costos de reproducción o envío** (Art. 34).
- **Transferencias** (Arts. 35-36): comunicar el aviso al tercero y cláusula en el aviso sobre si la persona titular acepta o no la transferencia; excepciones del Art. 36. **Remisión a encargados no es transferencia** (Art. 35 habla de terceros "distintos de la persona encargada").
- **Procedimiento ante la Secretaría** (Arts. 40-50): la solicitud de protección se presenta dentro de **quince días** siguientes a la respuesta, o desde que venció el plazo si no hubo respuesta (Art. 40); resolución en 50 días ampliables (Art. 42). Sanciones: multas de 100 a 160,000 y de 200 a 320,000 UMA (Art. 59); omitir elementos del Art. 15 es infracción (Art. 58 fr. V); delitos en Arts. 62-64.

## Lo que NO pude confirmar o que contradice lo pedido (marcado)

- **Derecho de portabilidad: no existe en el texto vigente.** Busqué la palabra en la ley completa y no aparece; un resumen automático que la mencionaba no se corresponde con el articulado que leí. El aviso **no lo presenta como derecho legal**: ofrece, como cortesía, entregar los datos en un documento electrónico (el Art. 32 permite cumplir el acceso con "documentos electrónicos"). Confirmar con abogado por si hay norma secundaria.
- **Reglamento y lineamientos**: la ley remite a un Reglamento (Art. 2 fr. XIII; procedimientos de los Arts. 40-57) y no verifiqué si ya hay uno nuevo ni si el Reglamento de 2011 o los Lineamientos del Aviso de 2013 siguen aplicándose en lo que no se opongan. **Pendiente.**
- **Menores de edad**: no encontré en la ley vigente un artículo específico sobre datos de menores; el aviso trae una cláusula prudente (no se dirige a menores) cuyo fundamento legal queda **por confirmar**.
- **Datos sensibles (alergias)**: el Art. 8 exige consentimiento expreso y por escrito (firma autógrafa, electrónica o mecanismo de autenticación). No se afirma que un mensaje de WhatsApp lo cumpla; el abogado debe definir el mecanismo. Mientras tanto el aviso dice que las alergias se pasan a una persona de la sucursal.
- **Voz / audio**: no está en la lista de sensibles del Art. 2 fr. VI. No se trató como sensible; el aviso la declara dato personal y pide autorización expresa antes de grabar (ya es el diseño del repo). **Confirmar** si el abogado la considera sensible.
- **Transferencias internacionales**: no hay un artículo especial más allá de Arts. 35-36; no verifiqué cláusulas adicionales ni normas secundarias.
- **Cookies**: la ley no las regula expresamente; se tratan bajo el Art. 15 y el principio de información.
- **Plazos en días hábiles vs. el código del repo**: ver abajo.

## Hallazgos sobre cómo el repo ya maneja ARCO y aviso (no se cambió código de producción)

1. **El aviso simplificado de WhatsApp (`privacyNoticeWhatsApp` en `packages/domain-restaurantes/src/privacidad/aviso.ts`) no alcanza el Art. 16 fr. II**: nombra al responsable pero **no su domicilio**, no distingue finalidades que requieren consentimiento y no ofrece opción de limitar el uso. La versión completa propuesta está en `aviso-privacidad-simplificado.md`; cambiar el código es una decisión de producto (afecta el primer mensaje de todos los clientes) y se deja como seguimiento.
2. **Plazos ARCO: ley = días hábiles; el repo = días naturales.** `docs/PRIVACIDAD-PLATAFORMA.md` y las migraciones calculan 20 + 15 días de calendario. El Art. 2 fr. VIII de la ley vigente define "días" como **hábiles**, así que el cómputo del repo vence **antes** que el legal (es conservador, no incumple). El aviso dice "veinte días hábiles" porque es lo que dice la ley. Mostrar la fecha legal exacta en el panel requiere un calendario de días inhábiles (cambio con migración, fuera de este PR).
3. El detector ARCO (#533/#545: `arco-intent.ts`, herramienta `registrar_solicitud_arco`, rol `clasificador_arco`) ya atiende por WhatsApp y voz con la frase "mis datos personales". El aviso integral la menciona como canal. Falta que el integral esté publicado: `privacy_config.notice_url` (URL https) es lo que el onboarding exige.
4. `encargados.ts` lista cinco proveedores (OpenRouter, Gemini voz, Twilio, LiveKit, Meta). El código también usa Deepgram (cascada de voz v2, apagada por omisión), ElevenLabs, Resend, Stripe, Supabase, Vercel y Sentry; el aviso los incluye y conviene ampliar `encargados.ts` (seguimiento).
5. Retención por defecto del repo: conversaciones 180 días (30 a 1095), transcripciones de voz 30 días (0 a 365). El aviso las cita como configurables.
