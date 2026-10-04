// Detector DETERMINISTA de señales de crisis (ideación suicida, autolesión, desesperanza, despedida, plan o medios) para WhatsApp Y voz.
// Corre ANTES del LLM y nunca depende del modelo. Principios:
//   - Minimizar FALSOS NEGATIVOS: frases directas e indirectas, conjugaciones, tercera persona (un familiar que avisa), sin acentos, mayúsculas,
//     errores de dedo (kiero, suisidarme, quieroooo), jerga, leetspeak (m4tarme), letras separadas (m a t a r m e), emoji y puntuación
//     de por medio, doble espacio o salto de línea (la voz llega sin puntuación) y el inglés básico.
//   - Los FALSOS POSITIVOS en un consultorio ("me corto el pelo", "ya no aguanto el dolor de muela", "terminar con todo el tratamiento",
//     "ya no puedo más tarde de las 5") se evitan con contexto de la frase; lo que aun así coincida NO se silencia: recibe la respuesta
//     cuidadosa de contención y una persona del negocio lo revisa.
//   - El resultado es una ETIQUETA fija de familia (nunca la frase del paciente): es lo que se guarda en la escalación, se muestra al
//     negocio y la voz acepta de vuelta, sin copiar texto del paciente (dato de salud).

/** Familias de señal; el valor es la etiqueta fija que viaja a la escalación. */
export const CRISIS_SENALES = {
  plan: "plan o medios",
  ideacion: "ideación suicida",
  autolesion: "autolesión",
  despedida: "despedida",
  desesperanza: "desesperanza",
} as const;
export type CrisisSenal = (typeof CRISIS_SENALES)[keyof typeof CRISIS_SENALES];

/** Lista cerrada de etiquetas (la voz solo acepta de vuelta una de estas). */
export const CRISIS_ETIQUETAS: readonly string[] = Object.values(CRISIS_SENALES);

const LEET: Readonly<Record<string, string>> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };

/**
 * Texto comparable: sin acentos, minúsculas, emoji/símbolos fuera, puntuación de oración convertida en el separador `|` (así "ya no
 * aguanto. Quiero cita" corta la frase), k->qu, letras repetidas colapsadas, leetspeak dentro de palabras y letras sueltas pegadas.
 */
export function normalizarTextoCrisis(texto: string): string {
  let t = (texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  // "me.quiero.morir" (sin espacios) une palabras; la puntuación con espacio es límite de frase. Los saltos de línea son espacio: "quiero\nmorirme".
  t = t.replace(/(?<=[a-z0-9])[.,;:!?\/\\_-]+(?=[a-z0-9])/g, " ").replace(/[\n\r\t]+/g, " ");
  t = t.replace(/[.,;:!?¡¿()"“”«»…\\/]+/g, " | ").replace(/['’`´]/g, " ");
  // Leetspeak solo dentro de palabras que ya tienen letras (no toca "10:00" ni "5pm").
  t = t
    .split(/\s+/)
    .map((tok) => (/[a-z]/.test(tok) && /[0-9@$]/.test(tok) && tok.length >= 4 ? tok.replace(/[0-9@$]/g, (c) => LEET[c] ?? c) : tok))
    .join(" ");
  t = t.replace(/[^a-z0-9| ]+/g, " ");
  // m a t a r m e -> matarme (4 o más letras sueltas seguidas).
  t = t.replace(/(?:^| )((?:[a-z] ){3,}[a-z])(?= |$)/g, (_m, g: string) => ` ${g.replace(/ /g, "")}`);
  // quieroooo -> quiero (3 o más repeticiones; el español no tiene letras triples).
  t = t.replace(/([a-z])\1{2,}/g, "$1");
  t = t.replace(/\b(?:kero|quero|qero)\b/g, "quiero").replace(/\bke\b/g, "que").replace(/\bq\b/g, "que");
  return t.replace(/\s+/g, " ").replace(/ ?\| ?(?:\| ?)*/g, " | ").trim();
}

/** kiero -> quiero (k por qu). Se evalúa como variante aparte: en inglés "kill" no debe volverse "quill". */
function corregirK(s: string): string {
  return s.replace(/\bk(?=[ie])/g, "qu");
}

/** Todas las letras repetidas a una sola: tolera "morirrr"/"quierro"/"sucidarme" escritos con letras de más. */
function comprimirRepetidas(s: string): string {
  return s.replace(/([a-z])\1+/g, "$1");
}

const FIN = String.raw`(?=\s*(?:\||$))`;
// Relleno entre el deseo y el verbo (hasta 3 palabras, sin "que": "quiero que mi perro no se vaya a morir" NO es un deseo propio de morir).
const REL = String.raw`(?:(?!que\b)[a-z]+ ){0,3}`;
const DESEO = String.raw`(?:quier\w*|quis\w*|queria\w*|ganas de|deseo|desear\w*|prefier\w*|preferir\w*|ojala|pienso|pensando en|planeo|planeando|necesito|decidi|mejor|me gustaria|me dan ganas de|tengo ganas de)`;
const ESPERA_FIGURADA = String.raw`(?!\s+(?:de\s+)?(?:la |el )?(?:risa|hambre|sueno|pena|verguenza|miedo|calor|frio|sed|nervios|ganas|envidia|celos|aburrimiento|coraje|gusto))`;
const NO_PELO = String.raw`(?!\s+(?:el|la|las|los|mi|mis|un|una)\s+(?:pelo|cabello|cabellos|unas|barba|bigote|flequillo|fleco|puntas|melena|cuticulas?|hilo))`;
const SITIO = String.raw`(?:brazos?|antebrazos?|munecas?|venas?|piernas?|muslos?|vientre|panza|piel|cuerpo|torso)`;

interface Regla {
  readonly senal: CrisisSenal;
  readonly re: RegExp;
}

function r(senal: CrisisSenal, fuente: string): Regla {
  return { senal, re: new RegExp(fuente) };
}

// Orden = prioridad (la primera familia que coincide es la etiqueta).
const REGLAS_ES: readonly Regla[] = [
  // ---- Plan o medios ----
  r(CRISIS_SENALES.plan, String.raw`\b(?:ahorcar|colgar|envenenar|electrocutar|disparar|degollar)(?:me|se)\b`),
  r(CRISIS_SENALES.plan, String.raw`\bme (?:voy a |quiero |quisiera |podria |ire a |va a )?(?:ahorcar|colgar|envenenar|electrocutar|disparar|degollar)\b`),
  r(CRISIS_SENALES.plan, String.raw`\bme (?:voy a |quiero |quisiera |podria |ire a |va a )?(?:pegar|meter|volar) (?:un |el |la )?(?:tiro|balazo|bala|cabeza|plomo)`),
  r(CRISIS_SENALES.plan, String.raw`\bme (?:voy a |quiero |quisiera |podria |ire a |va a )?(?:cortar|abrir|rebanar|rajar) (?:las |los )?(?:venas|munecas|muneca|brazos|cuello|garganta)`),
  r(CRISIS_SENALES.plan, String.raw`\b(?:pegar(?:me|se)|meter(?:me|se)|volar(?:me|se)) (?:un |el |la )?(?:tiro|balazo|bala|cabeza|plomo)`),
  r(CRISIS_SENALES.plan, String.raw`\b(?:cortar|abrir|rebanar|rajar)(?:me|se) (?:las |los )?(?:venas|munecas|muneca|brazos|cuello|garganta)`),
  r(CRISIS_SENALES.plan, String.raw`\b(?:aventar|tirar|lanzar|arrojar|echar|saltar)(?:me|se)? (?:de|del|desde|al|a la|a las|a un|a una|por) (?:el |la |un |una |los |las )?(?:puente|edificio|balcon|ventana|azotea|techo|vias|tren|metro|camion|barranco|acantilado|precipicio|cerro|torre)`),
  r(CRISIS_SENALES.plan, String.raw`\bme (?:voy a |quiero |quisiera |podria |ire a )?(?:aventar|tirar|lanzar|arrojar) (?:a las vias|al tren|al metro|a un carro|a un camion|al vacio)`),
  r(CRISIS_SENALES.plan, String.raw`\b(?:tomar|tomarme|tome|me tome|me voy a tomar|quiero tomar|me tomo)\b[^|]{0,25}\b(?:todas|toda|todo|un monton de|muchas|el frasco|el bote|la caja)\b[^|]{0,20}\b(?:pastillas|pildoras|medicamentos?|medicinas?|tabletas|capsulas|frasco|caja|bote)`),
  r(CRISIS_SENALES.plan, String.raw`\bsobredosis\b[^|]{0,30}\b(?:a proposito|para morir|para matarme|voluntaria|intencional)`),
  r(CRISIS_SENALES.plan, String.raw`\b(?:me voy a|quiero|quisiera|intente|intento|pienso|planeo) (?:provocar(?:me)? )?(?:una )?sobredosis`),
  r(CRISIS_SENALES.plan, String.raw`\b(?:pistola|arma|soga|cuerda|pastillas|navaja|cuchillo|veneno|rifle|escopeta|medicamentos?|plan)\b[^|]{0,40}\bpara (?:matarme|suicidarme|acabar con|terminar con|hacerlo|dormirme para siempre|quitarme|morir|irme|desaparecer)`),
  r(CRISIS_SENALES.plan, String.raw`\b(?:ya )?(?:tengo|tengo listo|tengo lista|compre|consegui|prepare) (?:un |el |la |todo )?(?:plan|todo listo|todo preparado|la soga|la pistola|el arma)\b[^|]{0,30}\b(?:matarme|suicid\w*|morir|acabar|terminar con (?:todo|mi vida)|hacerlo|irme)`),
  r(CRISIS_SENALES.plan, String.raw`\besta noche (?:lo hago|acabo|termino|me (?:mato|quito|voy a (?:matar|quitar|acabar)))`),
  r(CRISIS_SENALES.plan, String.raw`\bya (?:decidi|se como|se cuando|tengo decidido)\b[^|]{0,25}\b(?:matarme|suicid\w*|acabar con mi vida|quitarme la vida|terminar con mi vida|hacerlo)`),
  // ---- Ideación suicida ----
  r(CRISIS_SENALES.ideacion, String.raw`\bsu(?:i)?[cs]id\w*`),
  r(CRISIS_SENALES.ideacion, String.raw`\b(?:sui[cs]ide|suicidal)\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\bmatar(?:me|se)\b${ESPERA_FIGURADA}(?!\s+(?:trabajando|estudiando|corriendo|haciendo))`),
  r(CRISIS_SENALES.ideacion, String.raw`\b(?:me|se) (?:voy a |va a |quiero |quiere |quisiera |quisiese |podria |debo |tengo que |ire a |pienso |planeo )?matar\b${ESPERA_FIGURADA}(?!\s+(?:trabajando|estudiando|corriendo|haciendo))`),
  r(CRISIS_SENALES.ideacion, String.raw`\bme mato${FIN}|\bme mato (?:hoy|manana|esta noche|ya|solo|sola)\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\b(?:me|se) (?:voy a |va a |quiero |quiere |quisiera |podria |debo |pienso )?quit\w* (?:la )?vida\b|\bquit(?:arme|arse|ar(?:me|se)?) (?:la )?vida\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\b${DESEO} ${REL}(?:morir|morirme|morirse|morirnos|fallecer)\b${ESPERA_FIGURADA}`),
  r(CRISIS_SENALES.ideacion, String.raw`\b(?:pensando|pensado|pienso|pensar|idea|ideas|pensamientos?) (?:en|de) (?:morir|morirme|morirse|muerte|acabar|terminar con (?:todo|mi vida|esto))`),
  r(CRISIS_SENALES.ideacion, String.raw`\b(?:acabar|acabo|terminar|termino|poner fin|acabare|terminare) (?:con |a )(?:mi vida|mi existencia|mis dias|conmigo|mi sufrimiento)\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\b(?:acabar|terminar|acabo|termino|acabare|terminare) con todo(?: esto| ya| de una vez| hoy| esta noche| para siempre| de una buena vez)?${FIN}`),
  r(CRISIS_SENALES.ideacion, String.raw`\b(?:dejar de (?:vivir|existir|respirar)|dejar este mundo|irme de este mundo|irme para siempre)\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\bno (?:quiero|quisiera) (?:seguir )?(?:viviendo|vivir|vivo|viva|existir|estar vivo|estar viva|estar en este mundo|estar aca en este mundo|volver a despertar|despertar)\b(?!\s+con\s+(?:dolor|el dolor|este dolor|ese dolor|molestias?|esta molestia|miedo|ansiedad|esa))`),
  r(CRISIS_SENALES.ideacion, String.raw`\bya no (?:quiero|quisiera) (?:seguir )?(?:viviendo|vivir|vivo|viva|existir|estar vivo|estar viva|estar aqui|estar aca|estar en este mundo|despertar|seguir aqui|seguir asi|seguir adelante|luchar|pelear)\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\bno (?:puedo|podre) seguir (?:viviendo|asi|adelante|con mi vida)\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\b(?:quiero|quisiera|ojala|deseo|me gustaria|prefiero|preferiria|desearia) ${REL}(?:desaparecer|desvanecerme|no existir|no estar aqui|no haber nacido|no haber existido|no despertar|no amanecer|dormirme y no despertar|dormir y no despertar|estar muert[oa])\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\bojala\b[^|]{0,40}\b(?:muriera|muera|muriese)\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\bojala (?:me |se |no )?(?:muriera|muera|desapareciera|existiera|despertara|amaneciera|hubiera nacido)\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\b(?:dormir|dormirme|dormirse) (?:y )?(?:ya )?(?:no volver a despertar|no despertar|para siempre)\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\b(?:estaria|estar|seria|fuera) mejor (?:muert[oa]|muriendome|si me muriera|si no existiera|si no estuviera|si desapareciera)\b|\bmejor (?:muert[oa]|estar muert[oa])\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\b(?:no vale la pena (?:vivir|seguir viviendo|mi vida)|la vida no vale la pena|mi vida no vale (?:nada|la pena)|ya nada vale la pena)\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\bno (?:tengo|encuentro|le encuentro|veo) (?:ningun |ninguna |una |algun |alguna )?(?:motivo|motivos|razon|razones|sentido|ganas|ilusion)(?:es)? (?:para |de |a |en )?(?:vivir|seguir viviendo|seguir|la vida|mi vida|existir)\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\bpara que (?:seguir viviendo|seguir vivo|seguir viva|vivir|existir|seguir con esta vida|seguir en este mundo)\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\b(?:harto|harta|hart[oa]s?|cansad[oa]|cansadisim[oa]) de (?:vivir|la vida|mi vida|existir|estar vivo|estar viva)\b|\bodio (?:mi vida|vivir|estar vivo|estar viva)\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\b(?:estarian|estaria|estaran|estan|vivirian|estarias|estaras|seria) (?:mucho |bastante )?(?:mejor|mejores|mas tranquilos|tranquilos|bien|felices) (?:todos )?sin mi\b|\bmejor sin mi\b|\bsin mi (?:estarian|estarias|estaria|estaran|vivirian|seria|todos)\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\bmejor (?:si )?(?:no estuviera|no existiera|me fuera|desapareciera|me muriera|no estuviese)\b`),
  r(CRISIS_SENALES.ideacion, String.raw`\b(?:nadie me (?:va a |iba a |vendria a )?(?:extranar|extranaria|extrana|echaria de menos)|a nadie le (?:importo|importaria|hago falta|haria falta))\b`),
  // ---- Autolesión ----
  r(CRISIS_SENALES.autolesion, String.raw`\bauto ?(?:lesion\w*|agre\w*|dano\w*|mutila\w*)`),
  r(CRISIS_SENALES.autolesion, String.raw`\bhacer(?:me|se) sangrar\b|\bme hago sangrar\b`),
  r(CRISIS_SENALES.autolesion, String.raw`\bme (?:estoy |sigo |he |ya me |volvi a |vuelvo a |empece a |habia estado )?(?:cort\w*) (?:a proposito|adrede|(?:los |las |mis |el |la |toda la |toda mi )?${SITIO})\b`),
  r(CRISIS_SENALES.autolesion, String.raw`\bme (?:estoy |sigo |he |ya me |volvi a |vuelvo a |empece a |habia estado )?(?:lastim\w*|herid\w*|hier\w*|golpe\w*|rasgun\w*|aran\w*|quem\w*|pellizc\w*|hag\w* dano|hac\w+ dano|hech\w+ dano|hic\w+ dano) (?:[a-z]+ ){0,3}(?:a proposito|adrede|con intencion)\b`),
  r(CRISIS_SENALES.autolesion, String.raw`\bme (?:estoy|sigo|he|ya me|volvi a|vuelvo a|habia estado) (?:cortando|lastimando|haciendo dano|hiriendo|cortado|lastimado|hecho dano|castigando)(?:\s+(?:otra vez|de nuevo|seguido|a diario))?${FIN}`),
  r(CRISIS_SENALES.autolesion, String.raw`\bme (?:hago|hice|hacia|he hecho) (?:unos |varios |cortes )?cortes\b`),
  r(CRISIS_SENALES.autolesion, String.raw`\bme (?:corto|cortaba|lastimo|lastimaba|hago dano|hacia dano|hiero|golpeo|golpeaba|castigo|castigaba)(?= (?:a mi mism[oa]|para (?:sentir|calmarme|desahogarme|olvidar|castigarme|dejar de sentir|no sentir)|y no puedo (?:parar|dejar|dejarlo)|otra vez|de nuevo|seguido|a diario|cada dia|casi todos los dias)\b|\s*(?:\||$))`),
  r(CRISIS_SENALES.autolesion, String.raw`\b(?:me|nos) (?:quiero|quisiera|voy a|va a|dan ganas de|tengo ganas de|necesito|debo|merezco) (?:cortar|lastimar|hacer dano|herir|golpear|castigar|hacerme dano)${NO_PELO}\b`),
  r(CRISIS_SENALES.autolesion, String.raw`\b(?:quiero|quisiera|voy a|va a|ganas de|necesito|tengo que|pienso|pensando en|estoy pensando en|merezco|me dan ganas de) (?:\w+ )?(?:cortarme|cortarse|lastimarme|lastimarse|hacerme dano|hacerse dano|herirme|herirse|golpearme|golpearse|castigarme|castigarse)${NO_PELO}\b`),
  r(CRISIS_SENALES.autolesion, String.raw`\b(?:se|le) (?:corta|lastima|hace dano|hiere) (?:a proposito|adrede|(?:los |las |sus )?${SITIO})\b`),
  // ---- Despedida ----
  r(CRISIS_SENALES.despedida, String.raw`\b(?:adios a todos|me despido de (?:todos|ustedes|ti)|despidanse de mi|ya me despedi|ya me despido|no me busquen)\b`),
  r(CRISIS_SENALES.despedida, String.raw`\b(?:este es|esta es|es) mi (?:ultimo mensaje|ultima despedida|ultima carta|carta de despedida|despedida)\b|\bcarta (?:de despedida|suicida)\b|\bultimo mensaje\b`),
  r(CRISIS_SENALES.despedida, String.raw`\bperdon(?:ame|enme|alo|adme) por lo que voy a hacer\b`),
  r(CRISIS_SENALES.despedida, String.raw`\bcuid\w+ (?:a |de )?(?:mis|mi|los|las) \w+ cuando (?:yo )?(?:ya )?no (?:este|estoy|este aqui)\b`),
  r(CRISIS_SENALES.despedida, String.raw`\bya no (?:les |le |te )?(?:voy a )?(?:dar|causar|ser) (?:mas )?(?:molestias|lata|problemas|problema|carga)\b|\bsoy (?:una |un )?(?:carga|estorbo|peso muerto|molestia para todos)\b`),
  // ---- Desesperanza (agotamiento sin objeto) ----
  r(CRISIS_SENALES.desesperanza, String.raw`\bno (?:le )?(?:veo|encuentro) (?:ningun |ninguna )?sentido (?:a |en )?(?:la vida|vivir|seguir|todo|nada|esto|mi vida|existir)\b`),
  r(CRISIS_SENALES.desesperanza, String.raw`\bno le (?:veo|encuentro) (?:ningun )?sentido${FIN}`),
  r(CRISIS_SENALES.desesperanza, String.raw`\bno (?:tiene|tendria|tiene ya) (?:ningun )?sentido (?:seguir|vivir|la vida|mi vida|continuar|existir)\b`),
  r(CRISIS_SENALES.desesperanza, String.raw`\b(?:ya )?no (?:veo|hay|queda|tengo) (?:ninguna |ya |mas )?(?:salida|esperanza|futuro|solucion para mi)\b(?= (?:para mi|a esto|a mi vida|a mis problemas|en mi vida|alguna)\b|\s*(?:\||$))`),
  r(CRISIS_SENALES.desesperanza, String.raw`\b(?:ya )?no (?:aguanto|soporto|resisto|tolero|puedo) mas(?=\s*(?:\||$)| (?:con (?:todo|esto|mi vida|la vida|nada|tanto)|de (?:todo|esto|vivir|esta vida|tanto|sufrir|estar asi)|esta vida|mi vida|asi|y|pero|quiero|necesito|me|ya|ayuda|ayudame|por favor|help)\b)`),
  r(CRISIS_SENALES.desesperanza, String.raw`\b(?:ya )?no (?:aguanto|soporto|resisto|tolero|puedo)${FIN}`),
  r(CRISIS_SENALES.desesperanza, String.raw`\bya no (?:puedo|aguanto|soporto) (?:con )?(?:esto|todo|mi vida|esta vida|la vida)${FIN}`),
  r(CRISIS_SENALES.desesperanza, String.raw`\bya no puedo seguir(?=\s*(?:\||$)| (?:asi|con (?:esto|todo|mi vida|la vida)|adelante|viviendo|luchando|peleando|aguantando|fingiendo)\b)`),
  r(CRISIS_SENALES.desesperanza, String.raw`\b(?:me rindo|ya me rendi)(?:\s+(?:con (?:todo|la vida|esto)|de (?:todo|vivir|la vida)))?\s*\|?\s*$|\bme (?:rindo|rendi) (?:con (?:todo|la vida|esto)|de (?:todo|vivir|la vida))\b`),
  r(CRISIS_SENALES.desesperanza, String.raw`\b(?:ya )?no (?:quiero|quisiera) seguir (?:asi|aqui|con mi vida|con esta vida)\b`),
];

const REGLAS_EN: readonly Regla[] = [
  r(CRISIS_SENALES.ideacion, String.raw`\b(?:kill(?:ing)? my ?self|end(?:ing)? my (?:own )?life|take my (?:own )?life|want(?:ed)? to die(?! (?:laughing|of laughter|of embarrassment|of shame))|wanna die|suicid\w*|(?:do not|don ?t|do n ?t|dont) want to (?:live|be alive|exist|be here any ?more)|better off without me|no reason to (?:live|go on)|end it all|(?:can ?t|cannot|can not) go on|want to disappear|wish i (?:was|were) dead)\b`),
  r(CRISIS_SENALES.autolesion, String.raw`\bself ?harm\w*|\b(?:want to|wanna|going to|gonna|keep|kept|started|start|used to|need to) (?:hurt|harm|cut)\w* my ?self\b|\b(?:hurt|harm|cut)\w* my ?self (?:on purpose|again|every (?:day|night|time))\b`),
];

const REGLAS: readonly Regla[] = [...REGLAS_ES, ...REGLAS_EN];
const REGLAS_COMPRIMIDAS: readonly Regla[] = REGLAS.map((x) => ({ senal: x.senal, re: new RegExp(comprimirRepetidas(x.re.source)) }));

/**
 * Etiqueta de la familia de señal de crisis que trae el mensaje, o null si no hay ninguna. Se evalúa el texto normalizado y, para tolerar
 * letras de más o de menos ("sucidarme", "morirrr"), también su versión con repetidas colapsadas contra las reglas colapsadas.
 */
export function detectarSenalCrisis(mensaje: string): CrisisSenal | null {
  const t = normalizarTextoCrisis(mensaje);
  if (!t) return null;
  const k = corregirK(t);
  const variantes = k === t ? [t] : [t, k];
  for (const v of variantes) for (const regla of REGLAS) if (regla.re.test(v)) return regla.senal;
  for (const v of variantes) {
    const c = comprimirRepetidas(v);
    for (const regla of REGLAS_COMPRIMIDAS) if (regla.re.test(c)) return regla.senal;
  }
  return null;
}
