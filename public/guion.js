'use strict';

// l-gym. Todo el marcado se construye con createElement y textContent: los
// nombres de ejercicios los escribe el usuario y no hay razón para dejar que
// entre HTML por ahí.

const $ = (s) => document.querySelector(s);
const crear = (tag, clase, texto) => {
  const n = document.createElement(tag);
  if (clase) n.className = clase;
  if (texto != null) n.textContent = texto;
  return n;
};

const estado = { rutina: null, sesion: null, stats: null };

// ------------------------------------------------------------------- fechas

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// Las fechas son AAAA-MM-DD sin hora: se parten a mano para que el huso del
// navegador no las mueva un día.
function corto(iso) {
  if (!iso) return '—';
  const [a, m, d] = iso.split('-').map(Number);
  return `${d} ${MESES[m - 1]} ${String(a).slice(2)}`;
}

// -------------------------------------------------------------------- red

async function pedir(url, opciones) {
  const cfg = Object.assign({ headers: {} }, opciones);
  if (cfg.cuerpo !== undefined) {
    cfg.method = cfg.method || 'POST';
    cfg.headers['Content-Type'] = 'application/json';
    cfg.body = JSON.stringify(cfg.cuerpo);
    delete cfg.cuerpo;
  }
  const r = await fetch(url, cfg);
  if (r.status === 401) { location.reload(); throw new Error('sin sesión'); }
  const cuerpo = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(cuerpo.error || 'fallo'), { cuerpo });
  return cuerpo;
}

// Guardar en cada tecleo sería una petición por letra; esto agrupa.
function conRetraso(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------------------------------------------------------------- pestañas

const VISTAS = ['hoy', 'rutinas', 'progreso'];

function mostrar(vista, tocarUrl = true) {
  if (!VISTAS.includes(vista)) vista = 'hoy';

  // La pestaña va en la URL: así se puede guardar en favoritos la de progreso
  // y el botón de atrás del móvil hace lo que se espera en vez de salirse.
  if (tocarUrl && location.hash.slice(1) !== vista) {
    history.pushState({ vista }, '', '#' + vista);
  }

  document.querySelectorAll('.vista').forEach((v) => {
    v.classList.toggle('oculta', v.id !== 'vista-' + vista);
  });
  document.querySelectorAll('.pestana').forEach((b) => {
    b.classList.toggle('activa', b.dataset.vista === vista);
    b.setAttribute('aria-selected', b.dataset.vista === vista ? 'true' : 'false');
  });
  document.querySelectorAll('.menu-opcion[data-vista]').forEach((b) => {
    b.classList.toggle('activa', b.dataset.vista === vista);
    // aria-current y no aria-selected: esto es un menú, no una lista de
    // pestañas, y aria-selected ahí no significa nada.
    if (b.dataset.vista === vista) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  });
  if (vista === 'progreso') cargarStats();
  if (vista === 'rutinas') pintarEditor();
}

// ================================================================= ENTRENO

async function cargarSesion() {
  const grupoId = $('#grupo').value;
  const fecha = $('#fecha').value;
  if (!grupoId || !fecha) return;

  $('#aviso-hoy').textContent = 'Cargando…';
  try {
    estado.sesion = await pedir(`/api/sesion?fecha=${fecha}&grupo=${grupoId}`);
    $('#aviso-hoy').textContent = '';
    $('#entreno').hidden = false;
    pintarEntreno();
  } catch (e) {
    $('#aviso-hoy').textContent = 'No he podido cargar el entreno.';
  }
}

/*
 * Guardados con retraso que todavia no han salido. El boton de terminar los
 * vacia antes de cerrar: los campos de peso esperan 600 ms y las notas 800, y
 * si se cierra el movil justo despues de teclear esa ultima cifra se perderia.
 */
const pendientes = new Set();

async function vaciarPendientes() {
  await Promise.all([...pendientes].map((f) => f()));
}

const marcaDe = (id) => (estado.sesion.marcas.find((m) => m.ejercicio_id === id) || {}).hecho === 1;
const seriesDe = (id) => estado.sesion.series.filter((s) => s.ejercicio_id === id);

function pintarEntreno() {
  const { ejercicios, sesion } = estado.sesion;
  $('#notas').value = sesion.notas || '';

  const calent = ejercicios.filter((e) => e.tipo === 'calentamiento');
  const ejerc = ejercicios.filter((e) => e.tipo === 'ejercicio');

  pintarLista($('#lista-calentamiento'), calent, false,
    'Este grupo no tiene calentamiento. Añádelo en Rutinas.');
  pintarLista($('#lista-ejercicios'), ejerc, true,
    'Este grupo no tiene ejercicios. Añádelos en Rutinas.');

  pintarCierre();
}

/*
 * El pie de la sesion: cuanto llevas hecho y el boton de cerrarla.
 *
 * El resumen sale de lo que ya hay en pantalla, no se le pide al servidor: son
 * dos sumas sobre datos que estan cargados.
 */
function pintarCierre() {
  const { sesion, series } = estado.sesion;
  const hechas = series.filter((s) => s.hecho === 1);
  const volumen = hechas.reduce((a, s) => a + (s.peso || 0) * (s.repeticiones || 0), 0);
  const cerrada = Boolean(sesion.terminada);

  const bloque = $('#bloque-cierre');
  bloque.classList.toggle('guardado', cerrada);
  $('#aviso-cierre').textContent = '';

  $('#resumen-cierre').textContent = cerrada
    ? `Entreno guardado a las ${hora(sesion.terminada)}`
    : (hechas.length
      ? `${hechas.length} ${hechas.length === 1 ? 'serie hecha' : 'series hechas'} · ${kg(volumen)} kg de volumen`
      : 'Todavía no has marcado ninguna serie.');

  $('#guardar-entreno').textContent = cerrada ? 'Reabrir entreno' : 'Guardar entreno';
}

const hora = (iso) => new Date(iso).toLocaleTimeString('es-ES',
  { hour: '2-digit', minute: '2-digit' });

function pintarLista(ul, lista, conSeries, vacio) {
  ul.replaceChildren();
  if (!lista.length) { ul.append(crear('li', 'nota', vacio)); return; }
  lista.forEach((e) => ul.append(conSeries ? filaEjercicio(e) : filaCalentamiento(e)));
}

function cabeceraMovimiento(e, hechoInicial, alMarcar) {
  const cab = crear('div', 'mov-cabecera');

  const etiqueta = crear('label', 'mov-check');
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = hechoInicial;
  check.addEventListener('change', () => alMarcar(check.checked));
  etiqueta.append(check, crear('span', 'mov-nombre', e.nombre));
  cab.append(etiqueta);

  if (e.imagen) {
    const img = document.createElement('img');
    img.className = 'mov-foto';
    img.src = '/imagenes/' + e.imagen;
    img.alt = 'Cómo se hace: ' + e.nombre;
    img.loading = 'lazy';
    // Tocar la foto la amplía: en el gimnasio se mira de reojo y en pequeño no
    // se distingue la postura.
    img.addEventListener('click', () => img.classList.toggle('grande'));
    cab.append(img);
  }
  return cab;
}

function filaCalentamiento(e) {
  const li = crear('li', 'mov');
  li.append(cabeceraMovimiento(e, marcaDe(e.id), (hecho) => {
    pedir(`/api/sesion/${estado.sesion.sesion.id}/marca`,
      { cuerpo: { ejercicio_id: e.id, hecho } }).catch(() => {});
    li.classList.toggle('hecho', hecho);
  }));
  if (e.notas) li.append(crear('p', 'mov-notas', e.notas));
  li.classList.toggle('hecho', marcaDe(e.id));
  // Los de la rutina diaria se distinguen: si no, no se entiende por qué
  // aparecen los mismos tres movimientos en todos los grupos.
  li.classList.toggle('diario', Boolean(e.diario));
  return li;
}

function filaEjercicio(e) {
  const li = crear('li', 'mov');
  li.append(cabeceraMovimiento(e, marcaDe(e.id), (hecho) => {
    pedir(`/api/sesion/${estado.sesion.sesion.id}/marca`,
      { cuerpo: { ejercicio_id: e.id, hecho } }).catch(() => {});
    li.classList.toggle('hecho', hecho);
  }));
  if (e.notas) li.append(crear('p', 'mov-notas', e.notas));
  li.classList.toggle('hecho', marcaDe(e.id));

  const guardadas = seriesDe(e.id);
  const antes = (estado.sesion.ultimaVez || {})[e.id];
  const cuantas = Math.max(e.series, guardadas.length ? Math.max(...guardadas.map((s) => s.numero)) : 0);

  // Resumen de la última vez, para saber de dónde vienes sin tener que ir a la
  // pestaña de progreso.
  if (antes) {
    const pesos = antes.series.map((s) => (s.peso == null ? '—' : s.peso)).join(' · ');
    li.append(crear('p', 'ultima-vez', `Última vez (${corto(antes.fecha)}): ${pesos} kg`));
  }

  const tabla = crear('div', 'series');
  const cab = crear('div', 'serie serie-cabecera');
  cab.append(crear('span', null, '#'), crear('span', null, 'Peso (kg)'),
    crear('span', null, 'Reps'), crear('span', null, 'Hecha'));
  tabla.append(cab);

  for (let n = 1; n <= cuantas; n++) {
    const guardada = guardadas.find((s) => s.numero === n);
    const sugerida = antes && antes.series.find((s) => s.numero === n);
    tabla.append(filaSerie(e, n, guardada || {}, guardada ? null : sugerida));
  }

  const mas = crear('button', 'boton-lino', '+ serie');
  mas.type = 'button';
  mas.addEventListener('click', async () => {
    await pedir(`/api/sesion/${estado.sesion.sesion.id}/serie`,
      { cuerpo: { ejercicio_id: e.id, numero: cuantas + 1, peso: '', repeticiones: '', hecho: 0 } });
    await cargarSesion();
  });

  li.append(tabla, mas);
  return li;
}

function filaSerie(e, numero, datos, sugerida) {
  const fila = crear('div', 'serie');
  fila.append(crear('span', 'serie-num', String(numero)));

  const peso = document.createElement('input');
  peso.type = 'number';
  peso.step = '0.5';
  peso.min = '0';
  peso.inputMode = 'decimal';
  peso.setAttribute('aria-label', `Peso de la serie ${numero} de ${e.nombre}`);

  const reps = document.createElement('input');
  reps.type = 'number';
  reps.min = '0';
  reps.inputMode = 'numeric';
  reps.setAttribute('aria-label', `Repeticiones de la serie ${numero} de ${e.nombre}`);

  /*
   * Si esta serie todavía no tiene nada apuntado hoy, se rellena con lo de la
   * última vez y se marca en gris: es una propuesta, no un dato. Nada se
   * guarda hasta que se toque el campo o se marque la serie como hecha, así
   * que una sesión abierta y no entrenada no ensucia el volumen ni las marcas.
   *
   * Se rellena el valor en vez de usar placeholder porque lo normal es repetir
   * peso: así basta con marcar la casilla, que es justo lo que se quiere poder
   * hacer con una mano y la barra esperando.
   */
  const propuesto = Boolean(sugerida) && datos.peso == null;
  peso.value = datos.peso ?? (sugerida ? sugerida.peso ?? '' : '');
  reps.value = datos.repeticiones ?? (sugerida ? sugerida.repeticiones ?? '' : '');
  if (propuesto) {
    fila.classList.add('propuesta');
    peso.title = 'Lo que levantaste la última vez. Cámbialo o márcala y se guarda.';
  }
  const confirmar = () => fila.classList.remove('propuesta');

  const hecha = document.createElement('input');
  hecha.type = 'checkbox';
  hecha.checked = datos.hecho === 1;
  hecha.setAttribute('aria-label', `Serie ${numero} de ${e.nombre} hecha`);

  const guardar = () => {
    // Fuera de la lista antes de enviar: si el boton de terminar llega a la
    // vez, que no lo mande dos veces.
    pendientes.delete(guardar);
    return pedir(`/api/sesion/${estado.sesion.sesion.id}/serie`, {
      cuerpo: {
        ejercicio_id: e.id, numero,
        peso: peso.value, repeticiones: reps.value, hecho: hecha.checked ? 1 : 0,
      },
    }).catch(() => {});
  };

  const guardarLuego = conRetraso(guardar, 600);
  const tecleado = () => { confirmar(); pendientes.add(guardar); guardarLuego(); };
  peso.addEventListener('input', tecleado);
  reps.addEventListener('input', tecleado);
  hecha.addEventListener('change', () => {
    confirmar();
    guardar();
    fila.classList.toggle('hecha', hecha.checked);
  });
  fila.classList.toggle('hecha', hecha.checked);

  fila.append(peso, reps, hecha);
  return fila;
}

// ================================================================= RUTINAS

function pintarEditor() {
  const cont = $('#editor');
  cont.replaceChildren();
  if (!estado.rutina) return;

  if (estado.rutina.diario) cont.append(bloqueDiario(estado.rutina.diario));

  if (!estado.rutina.grupos.length) {
    cont.append(crear('p', 'nota', 'Todavía no hay grupos. Crea el primero arriba.'));
    return;
  }

  estado.rutina.grupos.forEach((g) => cont.append(bloqueGrupo(g)));
}

/*
 * El calentamiento de todos los días. Por dentro es un grupo, pero aquí no se
 * renombra ni se borra: no es "uno más", es el que se cuela en los demás.
 */
function bloqueDiario(g) {
  const sec = crear('section', 'grupo grupo-diario');

  const cab = crear('header', 'grupo-cabecera');
  cab.append(crear('h2', 'grupo-nombre', 'Calentamiento diario'));
  sec.append(cab);

  sec.append(crear('p', 'nota',
    'Sale al principio del calentamiento de todos los grupos, antes del suyo propio.'));
  sec.append(subLista(g, 'calentamiento', 'Movimientos'));
  return sec;
}

function bloqueGrupo(g) {
  const sec = crear('section', 'grupo');

  const cab = crear('header', 'grupo-cabecera');
  cab.append(crear('h2', 'grupo-nombre', g.nombre));

  const renombrar = crear('button', 'boton-lino', 'Renombrar');
  renombrar.type = 'button';
  renombrar.addEventListener('click', async () => {
    const nombre = window.prompt('Nuevo nombre del grupo:', g.nombre);
    if (!nombre) return;
    await pedir(`/api/grupos/${g.id}`, { method: 'PATCH', cuerpo: { nombre } });
    await recargarRutina();
  });

  const borrar = crear('button', 'boton-peligro', 'Borrar grupo');
  borrar.type = 'button';
  borrar.addEventListener('click', async () => {
    if (!window.confirm(`¿Borrar "${g.nombre}" con todos sus ejercicios y lo apuntado en ellos?`)) return;
    await pedir(`/api/grupos/${g.id}`, { method: 'DELETE' });
    await recargarRutina();
  });

  cab.append(renombrar, borrar);
  sec.append(cab);

  sec.append(subLista(g, 'calentamiento', 'Calentamiento'));
  sec.append(subLista(g, 'ejercicio', 'Ejercicios'));
  return sec;
}

function subLista(g, tipo, titulo) {
  const caja = crear('div', 'sublista');
  caja.append(crear('h3', 'sublista-titulo', titulo));

  const lista = g.ejercicios.filter((e) => e.tipo === tipo);
  if (!lista.length) caja.append(crear('p', 'nota', 'Nada todavía.'));
  lista.forEach((e) => caja.append(filaEditor(e)));

  const form = crear('form', 'fila-anadir');
  const nombre = document.createElement('input');
  nombre.placeholder = tipo === 'calentamiento' ? 'Añadir calentamiento…' : 'Añadir ejercicio…';
  nombre.maxLength = 80;
  nombre.required = true;
  nombre.setAttribute('aria-label', 'Nombre');

  const series = document.createElement('input');
  series.type = 'number';
  series.min = '1';
  series.max = '12';
  series.value = '3';
  series.className = 'campo-series';
  series.setAttribute('aria-label', 'Series');

  form.append(nombre);
  if (tipo === 'ejercicio') form.append(series);
  form.append(crear('button', 'boton', 'Añadir'));

  // La foto que se lleva el ejercicio si se coge uno del catálogo.
  let imagenElegida = null;

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    await pedir('/api/ejercicios', {
      cuerpo: {
        grupo_id: g.id, tipo, nombre: nombre.value, series: series.value,
        imagen: imagenElegida,
      },
    });
    imagenElegida = null;
    await recargarRutina();
  });

  caja.append(form);
  form.append(buscadorCatalogo(nombre, tipo, (m) => {
    // Al elegir del catálogo se rellena el formulario y se envía: quien
    // busca "Press banca" y lo ve con su foto ya ha decidido.
    nombre.value = m.nombre;
    if (tipo === 'ejercicio' && m.series) series.value = m.series;
    imagenElegida = m.imagen || null;
    form.requestSubmit();
  }));
  return caja;
}

/*
 * Lo que ya existe en la casa, mientras se escribe.
 *
 * Es el punto de todo esto: el que añade "Press banca" no tiene que volver a
 * crearlo ni a hacerle una foto, se queda con el que ya hay. La foto no se
 * duplica en disco; el ejercicio nuevo apunta al mismo fichero.
 */
function buscadorCatalogo(input, tipo, alElegir) {
  const caja = crear('div', 'sugerencias');
  caja.hidden = true;

  const cerrar = () => { caja.hidden = true; caja.replaceChildren(); };

  const buscar = conRetraso(async (q) => {
    if (q.length < 2) return cerrar();
    let movimientos = [];
    try {
      ({ movimientos } = await pedir(
        `/api/catalogo?tipo=${tipo}&q=${encodeURIComponent(q)}`));
    } catch { return cerrar(); }

    // Lo que ya está escrito tal cual no es una sugerencia útil.
    const iguales = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
    movimientos = movimientos.filter((m) => !iguales(m.nombre, input.value));
    if (!movimientos.length) return cerrar();

    caja.replaceChildren();
    caja.append(crear('p', 'sugerencias-titulo', 'Ya existen:'));
    movimientos.forEach((m) => {
      const b = crear('button', 'sugerencia');
      b.type = 'button';

      if (m.imagen) {
        const img = document.createElement('img');
        img.src = `/imagenes/${m.imagen}`;
        img.alt = '';
        img.loading = 'lazy';
        b.append(img);
      } else {
        b.append(crear('span', 'sugerencia-sinfoto', '—'));
      }

      const txt = crear('span', 'sugerencia-texto');
      txt.append(crear('b', null, m.nombre));
      const pistas = [];
      if (m.imagen) pistas.push('con foto');
      if (tipo === 'ejercicio' && m.series) pistas.push(`${m.series} series`);
      if (m.veces > 1) pistas.push(`lo usan ${m.veces}`);
      if (pistas.length) txt.append(crear('small', null, pistas.join(' · ')));
      b.append(txt);

      b.addEventListener('click', () => { cerrar(); alElegir(m); });
      caja.append(b);
    });
    caja.hidden = false;
  }, 250);

  input.addEventListener('input', () => buscar(input.value));
  input.addEventListener('blur', () => setTimeout(cerrar, 150));
  return caja;
}

// ------------------------------------------------- rutinas de otra gente

/*
 * Las rutinas de los demás, para copiárselas. Se copia la ficha del
 * movimiento —nombre, notas, series y foto—, nunca lo levantado: el progreso
 * es de cada uno.
 */
async function pintarExistentes() {
  const panel = $('#panel-existentes');
  panel.replaceChildren();
  panel.append(crear('p', 'nota', 'Cargando…'));

  let rutinas = [];
  try {
    ({ rutinas } = await pedir('/api/rutinas-existentes'));
  } catch {
    panel.replaceChildren(crear('p', 'nota', 'No se han podido cargar.'));
    return;
  }

  panel.replaceChildren();
  if (!rutinas.length) {
    panel.append(crear('p', 'nota',
      'Todavía no hay rutinas de otras personas. Cuando alguien monte la suya, aparecerá aquí.'));
    return;
  }

  rutinas.forEach((r) => panel.append(fichaExistente(r)));
}

function fichaExistente(r) {
  const ficha = crear('article', 'existente');

  // "Rutina «Pecho» de Lepayo" o "Calentamiento diario de Lepayo".
  const titulo = crear('h3', 'existente-nombre');
  if (r.diario) {
    titulo.append(document.createTextNode('Calentamiento diario de '));
  } else {
    titulo.append(document.createTextNode('Rutina «'));
    titulo.append(crear('b', null, r.nombre));
    titulo.append(document.createTextNode('» de '));
  }
  titulo.append(crear('b', null, r.dueno));
  ficha.append(titulo);

  const cuenta = [];
  if (r.ejercicios) cuenta.push(`${r.ejercicios} ${r.ejercicios === 1 ? 'ejercicio' : 'ejercicios'}`);
  if (r.calentamientos) cuenta.push(`${r.calentamientos} de calentamiento`);
  ficha.append(crear('p', 'nota', cuenta.join(' · ')));

  const detalle = crear('div', 'existente-detalle');
  detalle.hidden = true;

  const ver = crear('button', 'boton-lino', 'Ver qué lleva');
  ver.type = 'button';
  ver.addEventListener('click', async () => {
    if (!detalle.hidden) { detalle.hidden = true; ver.textContent = 'Ver qué lleva'; return; }
    ver.textContent = 'Ocultar';
    detalle.hidden = false;
    if (detalle.childElementCount) return;

    detalle.append(crear('p', 'nota', 'Cargando…'));
    const g = await pedir(`/api/rutinas-existentes/${r.id}`);
    detalle.replaceChildren();
    for (const [tipo, titulo] of [['calentamiento', 'Calentamiento'], ['ejercicio', 'Ejercicios']]) {
      const lista = g.ejercicios.filter((e) => e.tipo === tipo);
      if (!lista.length) continue;
      detalle.append(crear('h4', 'sublista-titulo', titulo));
      const ul = crear('ul', 'existente-lista');
      lista.forEach((e) => {
        const li = crear('li');
        if (e.imagen) {
          const img = document.createElement('img');
          img.src = `/imagenes/${e.imagen}`;
          img.alt = '';
          img.loading = 'lazy';
          li.append(img);
        }
        li.append(crear('span', null, e.nombre
          + (tipo === 'ejercicio' && e.series ? ` · ${e.series} series` : '')));
        ul.append(li);
      });
      detalle.append(ul);
    }
  });

  const copiar = crear('button', 'boton', r.diario ? 'Añadir a mi calentamiento' : 'Copiar a mis rutinas');
  copiar.type = 'button';
  copiar.addEventListener('click', async () => {
    const que = r.diario
      ? `¿Añadir los movimientos del calentamiento diario de ${r.dueno} al tuyo?`
      : `¿Copiar la rutina «${r.nombre}» de ${r.dueno} a tus grupos?`;
    if (!window.confirm(que)) return;
    copiar.disabled = true;
    try {
      const copia = await pedir(`/api/rutinas-existentes/${r.id}/copiar`, { cuerpo: {} });
      await recargarRutina();
      copiar.textContent = `Copiada: ${copia.copiados} movimientos`;
    } catch {
      copiar.disabled = false;
      copiar.textContent = 'No se pudo copiar';
    }
  });

  const botones = crear('div', 'existente-botones');
  botones.append(ver, copiar);
  ficha.append(botones, detalle);
  return ficha;
}

function filaEditor(e) {
  const fila = crear('div', 'fila-editor');

  const izq = crear('div', 'fila-editor-datos');
  izq.append(crear('span', 'fila-nombre', e.nombre));
  if (e.tipo === 'ejercicio') izq.append(crear('span', 'fila-series', e.series + ' series'));
  if (e.notas) izq.append(crear('span', 'fila-notas', e.notas));
  fila.append(izq);

  if (e.imagen) {
    const img = document.createElement('img');
    img.className = 'mini-foto';
    img.src = '/imagenes/' + e.imagen;
    img.alt = '';
    fila.append(img);
  }

  const acciones = crear('div', 'fila-acciones');

  const subir = crear('button', 'boton-lino', '↑');
  subir.type = 'button';
  subir.title = 'Subir';
  subir.addEventListener('click', async () => {
    await pedir(`/api/ejercicios/${e.id}/mover`, { cuerpo: { direccion: -1 } });
    await recargarRutina();
  });

  const bajar = crear('button', 'boton-lino', '↓');
  bajar.type = 'button';
  bajar.title = 'Bajar';
  bajar.addEventListener('click', async () => {
    await pedir(`/api/ejercicios/${e.id}/mover`, { cuerpo: { direccion: 1 } });
    await recargarRutina();
  });

  const editar = crear('button', 'boton-lino', 'Editar');
  editar.type = 'button';
  editar.addEventListener('click', async () => {
    const nombre = window.prompt('Nombre:', e.nombre);
    if (nombre === null) return;
    const notas = window.prompt('Notas (opcional):', e.notas || '');
    if (notas === null) return;
    let series = e.series;
    if (e.tipo === 'ejercicio') {
      const s = window.prompt('Series:', String(e.series));
      if (s === null) return;
      series = s;
    }
    await pedir(`/api/ejercicios/${e.id}`, { method: 'PATCH', cuerpo: { nombre, notas, series } });
    await recargarRutina();
  });

  // La foto se manda cruda por PUT, como la del portal. Nada de formularios
  // multiparte para un fichero suelto.
  const foto = document.createElement('input');
  foto.type = 'file';
  foto.accept = 'image/*';
  foto.className = 'oculto';
  foto.addEventListener('change', async () => {
    const f = foto.files[0];
    if (!f) return;
    try {
      await fetch(`/api/ejercicios/${e.id}/imagen`, {
        method: 'PUT', headers: { 'Content-Type': f.type }, body: f,
      }).then((r) => { if (!r.ok) throw new Error(); });
      await recargarRutina();
    } catch {
      window.alert('No he podido subir esa imagen.');
    }
  });

  const botonFoto = crear('button', 'boton-lino', e.imagen ? 'Cambiar foto' : 'Foto');
  botonFoto.type = 'button';
  botonFoto.addEventListener('click', () => foto.click());

  const borrar = crear('button', 'boton-peligro', 'Borrar');
  borrar.type = 'button';
  borrar.addEventListener('click', async () => {
    if (!window.confirm(`¿Borrar "${e.nombre}"?`)) return;
    await pedir(`/api/ejercicios/${e.id}`, { method: 'DELETE' });
    await recargarRutina();
  });

  acciones.append(subir, bajar, editar, botonFoto, foto, borrar);
  fila.append(acciones);
  return fila;
}

// ================================================================ PROGRESO

async function cargarStats() {
  estado.stats = await pedir('/api/stats');
  pintarTarjetas();
  pintarRecords();
  pintarHistorial();
  llenarSelectorEjercicios();
}

const kg = (n) => Math.round(Number(n) || 0).toLocaleString('es-ES');

function pintarTarjetas() {
  const r = estado.stats.resumen;
  const cont = $('#tarjetas');
  cont.replaceChildren();

  // Números sueltos, sin gráfica: son valores únicos, no una serie.
  [
    ['Entrenos', String(r.entrenos || 0), ''],
    ['Series hechas', String(r.series_totales || 0), ''],
    ['Volumen total', kg(r.volumen_total), 'kg levantados'],
    ['Último', corto(r.ultimo), ''],
  ].forEach(([rotulo, valor, pie]) => {
    const t = crear('div', 'tarjeta');
    t.append(crear('span', 'tarjeta-rotulo', rotulo));
    t.append(crear('strong', 'tarjeta-valor', valor));
    if (pie) t.append(crear('span', 'tarjeta-pie', pie));
    cont.append(t);
  });
}

function tablaDe(nodo, cabeceras, filas, vacio) {
  nodo.replaceChildren();
  if (!filas.length) {
    nodo.append(crear('caption', 'nota', vacio));
    return;
  }
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  cabeceras.forEach((c) => tr.append(crear('th', null, c)));
  thead.append(tr);
  const tbody = document.createElement('tbody');
  filas.forEach((f) => {
    const t = document.createElement('tr');
    f.forEach((c) => t.append(crear('td', null, c)));
    tbody.append(t);
  });
  nodo.append(thead, tbody);
}

function pintarRecords() {
  tablaDe($('#tabla-records'),
    ['Ejercicio', 'Grupo', 'Máximo', 'Cuándo'],
    estado.stats.records.map((r) => [r.nombre, r.grupo, kg(r.peso) + ' kg', corto(r.fecha)]),
    'Todavía no hay marcas: apunta algún peso.');
}

function pintarHistorial() {
  tablaDe($('#tabla-historial'),
    ['Día', 'Grupo', 'Series', 'Volumen'],
    estado.stats.historial
      .filter((h) => h.series_hechas > 0)
      .map((h) => [corto(h.fecha), h.grupo, String(h.series_hechas), kg(h.volumen) + ' kg']),
    'Todavía no hay entrenos con series marcadas.');
}

function llenarSelectorEjercicios() {
  const sel = $('#ejercicio-grafica');
  const antes = sel.value;
  sel.replaceChildren();
  if (!estado.rutina) return;

  estado.rutina.grupos.forEach((g) => {
    const ejerc = g.ejercicios.filter((e) => e.tipo === 'ejercicio');
    if (!ejerc.length) return;
    const grupo = document.createElement('optgroup');
    grupo.label = g.nombre;
    ejerc.forEach((e) => {
      const o = document.createElement('option');
      o.value = e.id;
      o.textContent = e.nombre;
      grupo.append(o);
    });
    sel.append(grupo);
  });

  if (antes) sel.value = antes;
  if (sel.value) pintarProgreso();
}

async function pintarProgreso() {
  const id = $('#ejercicio-grafica').value;
  const cont = $('#graficas');
  cont.replaceChildren();
  if (!id) return;

  const { ejercicio, puntos } = await pedir('/api/progreso/' + id);

  if (puntos.length < 2) {
    cont.append(crear('p', 'nota',
      'Hacen falta al menos dos días con series marcadas para dibujar una línea. '
      + `De momento hay ${puntos.length}.`));
    if (puntos.length === 1) cont.append(tablaProgreso(puntos));
    return;
  }

  // Dos medidas de escala distinta -- kilos y volumen total -- en dos gráficas
  // separadas. Nunca dos ejes en la misma: la comparación que sugieren es
  // falsa, porque depende de dónde pongas cada escala.
  cont.append(grafica('Peso máximo por día', puntos, 'peso_max', 'kg'));
  cont.append(grafica('Volumen por día', puntos, 'volumen', 'kg totales'));
  cont.append(tablaProgreso(puntos));
  cont.setAttribute('aria-label', 'Progreso de ' + ejercicio.nombre);
}

function tablaProgreso(puntos) {
  const caja = crear('details', 'tabla-alterna');
  caja.append(crear('summary', null, 'Ver los datos en tabla'));
  const env = crear('div', 'tabla-envoltura');
  const t = document.createElement('table');
  t.className = 'tabla';
  tablaDe(t, ['Día', 'Peso máximo', 'Volumen', 'Series'],
    puntos.map((p) => [corto(p.fecha), kg(p.peso_max) + ' kg', kg(p.volumen) + ' kg', String(p.series)]),
    '');
  env.append(t);
  caja.append(env);
  return caja;
}

// --------------------------------------------------------------- la gráfica

const SVG = 'http://www.w3.org/2000/svg';
const el = (tag, atributos) => {
  const n = document.createElementNS(SVG, tag);
  for (const k in atributos) n.setAttribute(k, atributos[k]);
  return n;
};

/*
 * Una serie, una gráfica. Línea de 2 px, puntos de 8, rejilla discreta y solo
 * dos etiquetas directas -- el máximo y el último valor -- en vez de un número
 * encima de cada punto, que a los diez días es ilegible.
 *
 * El color identifica al ejercicio, así que es el mismo en las dos gráficas.
 * Los números van en color de texto, nunca en el de la línea.
 */
function grafica(titulo, puntos, campo, unidad) {
  const An = 720, Al = 260;
  const M = { arriba: 24, derecha: 56, abajo: 34, izquierda: 52 };
  const anchoUtil = An - M.izquierda - M.derecha;
  const altoUtil = Al - M.arriba - M.abajo;

  const valores = puntos.map((p) => Number(p[campo]) || 0);
  const maximo = Math.max(...valores);
  const minimo = Math.min(...valores);
  // Un poco de aire arriba y abajo, y nunca un rango de altura cero.
  const techo = maximo + Math.max((maximo - minimo) * 0.15, maximo * 0.05, 1);
  const suelo = Math.max(0, minimo - Math.max((maximo - minimo) * 0.15, 1));

  const x = (i) => M.izquierda + (puntos.length === 1 ? anchoUtil / 2
    : (i / (puntos.length - 1)) * anchoUtil);
  const y = (v) => M.arriba + altoUtil - ((v - suelo) / (techo - suelo)) * altoUtil;

  const caja = crear('figure', 'grafica');
  caja.append(crear('figcaption', 'grafica-titulo', titulo));

  const envoltura = crear('div', 'grafica-lienzo');
  const svg = el('svg', {
    viewBox: `0 0 ${An} ${Al}`, class: 'lienzo',
    role: 'img', 'aria-label': `${titulo}. De ${kg(valores[0])} a ${kg(valores[valores.length - 1])} ${unidad}.`,
  });

  // Rejilla horizontal, recesiva: sitúa sin competir con los datos.
  for (let i = 0; i <= 3; i++) {
    const v = suelo + ((techo - suelo) * i) / 3;
    svg.append(el('line', {
      x1: M.izquierda, x2: An - M.derecha, y1: y(v), y2: y(v), class: 'rejilla',
    }));
    const t = el('text', { x: M.izquierda - 10, y: y(v) + 4, class: 'eje' });
    t.textContent = kg(v);
    svg.append(t);
  }

  const d = puntos.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(valores[i]).toFixed(1)}`).join(' ');
  svg.append(el('path', { d, class: 'linea' }));

  puntos.forEach((p, i) => {
    svg.append(el('circle', { cx: x(i), cy: y(valores[i]), r: 4, class: 'punto' }));
  });

  // Etiquetas directas solo en el máximo y en el último.
  const iMax = valores.indexOf(maximo);
  const iUlt = valores.length - 1;
  [...new Set([iMax, iUlt])].forEach((i) => {
    const t = el('text', {
      x: x(i), y: y(valores[i]) - 12, class: 'etiqueta',
      'text-anchor': i === iUlt && i !== 0 ? 'end' : 'middle',
    });
    t.textContent = kg(valores[i]);
    svg.append(t);
  });

  // Fechas: la primera y la última, que en un móvil no caben más.
  [0, puntos.length - 1].forEach((i, k) => {
    const t = el('text', {
      x: x(i), y: Al - 10, class: 'eje',
      'text-anchor': k === 0 ? 'start' : 'end',
    });
    t.textContent = corto(puntos[i].fecha);
    svg.append(t);
  });

  // Capa de interacción: cruceta y globo. El área sensible es toda la banda
  // vertical del punto, no el punto: acertar un círculo de 8 px con el dedo es
  // pedir demasiado.
  const cruceta = el('line', { class: 'cruceta', y1: M.arriba, y2: M.arriba + altoUtil, x1: 0, x2: 0 });
  cruceta.style.display = 'none';
  svg.append(cruceta);

  const globo = crear('div', 'globo');
  globo.hidden = true;
  envoltura.append(svg, globo);

  const banda = anchoUtil / Math.max(1, puntos.length - 1);
  svg.addEventListener('pointermove', (ev) => {
    const caja2 = svg.getBoundingClientRect();
    const px = ((ev.clientX - caja2.left) / caja2.width) * An;
    let i = Math.round((px - M.izquierda) / banda);
    i = Math.min(puntos.length - 1, Math.max(0, i));

    cruceta.style.display = '';
    cruceta.setAttribute('x1', x(i));
    cruceta.setAttribute('x2', x(i));

    globo.hidden = false;
    globo.replaceChildren(
      crear('strong', null, kg(valores[i]) + ' ' + unidad),
      crear('span', null, corto(puntos[i].fecha))
    );
    const izq = (x(i) / An) * caja2.width;
    globo.style.left = Math.min(caja2.width - 90, Math.max(10, izq)) + 'px';
  });
  svg.addEventListener('pointerleave', () => {
    cruceta.style.display = 'none';
    globo.hidden = true;
  });

  caja.append(envoltura);
  return caja;
}

// =================================================================== arranque

async function recargarRutina() {
  estado.rutina = await pedir('/api/rutina');
  $('#menu-nombre').textContent = estado.rutina.usuario || 'Tu cuenta';

  const sel = $('#grupo');
  const antes = sel.value;
  sel.replaceChildren();
  estado.rutina.grupos.forEach((g) => {
    const o = document.createElement('option');
    o.value = g.id;
    o.textContent = g.nombre;
    sel.append(o);
  });

  if (antes && estado.rutina.grupos.some((g) => String(g.id) === antes)) sel.value = antes;

  pintarEditor();
  llenarSelectorEjercicios();

  if (!estado.rutina.grupos.length) {
    $('#entreno').hidden = true;
    $('#aviso-hoy').textContent = 'Crea un grupo muscular en la pestaña Rutinas para empezar.';
  } else {
    await cargarSesion();
  }
}

document.querySelectorAll('.pestana').forEach((b) => {
  b.addEventListener('click', () => mostrar(b.dataset.vista));
});

// El panel de rutinas ajenas se pide al abrirlo, no al cargar la página: la
// mayoría de las veces nadie lo abre.
$('#boton-existentes').addEventListener('click', async () => {
  const panel = $('#panel-existentes');
  const boton = $('#boton-existentes');
  const abrir = panel.hidden;

  panel.hidden = !abrir;
  boton.setAttribute('aria-expanded', String(abrir));
  boton.textContent = abrir ? 'Ocultar rutinas existentes' : 'Rutinas existentes';
  if (abrir) await pintarExistentes();
});

// ------------------------------------------------------- menú de la foto

const menuUsuario = $('#menu-usuario');
const botonMenu = $('#boton-menu');

function verMenu(abierto) {
  menuUsuario.hidden = !abierto;
  botonMenu.setAttribute('aria-expanded', String(abierto));
}

botonMenu.addEventListener('click', (ev) => {
  // Sin esto el clic sigue subiendo hasta document y lo cierra al instante.
  ev.stopPropagation();
  verMenu(menuUsuario.hidden);
});

// Tocar fuera y Escape lo cierran: en el móvil, sin esto, un menú abierto por
// error solo se quita eligiendo algo.
document.addEventListener('click', (ev) => {
  if (!menuUsuario.hidden && !menuUsuario.contains(ev.target)) verMenu(false);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !menuUsuario.hidden) { verMenu(false); botonMenu.focus(); }
});

menuUsuario.querySelectorAll('[data-vista]').forEach((b) => {
  b.addEventListener('click', () => { mostrar(b.dataset.vista); verMenu(false); });
});

window.addEventListener('popstate', () => mostrar(location.hash.slice(1) || 'hoy', false));

$('#fecha').addEventListener('change', cargarSesion);
$('#grupo').addEventListener('change', cargarSesion);
$('#ejercicio-grafica').addEventListener('change', pintarProgreso);

const guardarNotas = () => {
  pendientes.delete(guardarNotas);
  return pedir(`/api/sesion/${estado.sesion.sesion.id}/notas`,
    { cuerpo: { notas: $('#notas').value } }).catch(() => {});
};
const guardarNotasLuego = conRetraso(guardarNotas, 800);
$('#notas').addEventListener('input', () => {
  pendientes.add(guardarNotas);
  guardarNotasLuego();
});

/*
 * Cerrar el entreno. Primero se vacia lo que quedara pendiente y solo despues
 * se marca como terminado: al reves, el ultimo peso tecleado llegaria a una
 * sesion ya cerrada.
 */
$('#guardar-entreno').addEventListener('click', async () => {
  const boton = $('#guardar-entreno');
  // Si ya estaba cerrado, este clic lo reabre.
  const reabrir = Boolean(estado.sesion.sesion.terminada);
  boton.disabled = true;
  $('#aviso-cierre').textContent = reabrir ? 'Reabriendo…' : 'Guardando…';
  try {
    if (!reabrir) await vaciarPendientes();
    await pedir(`/api/sesion/${estado.sesion.sesion.id}/terminar`,
      { cuerpo: { abierto: reabrir } });
    await cargarSesion();
    $('#aviso-cierre').textContent = reabrir ? '' : 'Guardado.';
  } catch (e) {
    $('#aviso-cierre').textContent = 'No he podido guardarlo. Vuelve a intentarlo.';
  } finally {
    boton.disabled = false;
  }
});

$('#form-grupo').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const campo = $('#nuevo-grupo');
  if (!campo.value.trim()) return;
  await pedir('/api/grupos', { cuerpo: { nombre: campo.value } });
  campo.value = '';
  await recargarRutina();
});

(async () => {
  const r = await pedir('/api/rutina');
  $('#fecha').value = r.hoy;
  $('#fecha').max = r.hoy;
  await recargarRutina();
  // Se abre al final, cuando ya hay datos: la pestaña de progreso necesita la
  // rutina cargada para llenar el desplegable de ejercicios.
  mostrar(location.hash.slice(1) || 'hoy', false);
})();


/* ── Tema ────────────────────────────────────────────────────────────────────
 *
 * La elección se guarda en el SERVIDOR, por usuario: así te sigue del móvil al
 * ordenador. Antes esto iba en localStorage y era de cada dispositivo.
 *
 * Aquí no se aplica el tema al cargar. Ya viene marcado en el <html> desde el
 * servidor, que es lo que evita ver un fogonazo del tema por defecto mientras
 * carga este fichero.
 */
const TEMAS_GYM = ['oscuro', 'crystal', 'dark-crystal'];

/* El color de la barra del navegador en el móvil. Sin actualizarlo se queda el
   del tema anterior y aparece una franja que no pega con la pantalla. */
const COLOR_BARRA = { oscuro: '#0f1216', crystal: '#c7dcf2', 'dark-crystal': '#131a24' };

const temaActual = () => document.documentElement.dataset.tema || 'oscuro';

const ICONOS_TEMA = {

  'oscuro': '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/></svg>',

  'crystal': '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5zm0 12.2l7.1-3.95L21 12l-9 5-9-5 1.9-1.05L12 15.2z"/></svg>',

  'dark-crystal': '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5zm0 12.2l7.1-3.95L21 12l-9 5-9-5 1.9-1.05L12 15.2z"/></svg>',

};

const NOMBRE_TEMA = { oscuro: 'Oscuro', crystal: 'Crystal', 'dark-crystal': 'Dark Crystal' };

function marcarTema(tema) {
  document.querySelectorAll('.menu-tema[data-tema]').forEach((b) => {
    const suyo = b.dataset.tema === tema;
    b.classList.toggle('activa', suyo);
    b.setAttribute('aria-checked', suyo ? 'true' : 'false');
  });
  /* El nombre a la derecha de "Tema": sin él hay que desplegar para saber
     cuál está puesto. */
  const puesto = document.getElementById('tema-actual');
  /* El icono del tema puesto. El nombre sigue haciendo falta, pero
     para el lector de pantalla: un icono solo no dice nada. */
  if (puesto) {
    puesto.className = 'tema-muestra tema-mini ' + tema;
    puesto.innerHTML = ICONOS_TEMA[tema] || '';
  }
  if (abrirTemas) abrirTemas.setAttribute('aria-label', 'Tema: ' + (NOMBRE_TEMA[tema] || tema));
}

async function ponerTema(tema) {
  if (!TEMAS_GYM.includes(tema)) return;
  const antes = temaActual();

  /* Se aplica primero y se guarda después: el cambio de tema tiene que sentirse
     instantáneo, y esperar a la red para pintar lo haría parecer lento. */
  if (tema === 'oscuro') delete document.documentElement.dataset.tema;
  else document.documentElement.dataset.tema = tema;

  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = COLOR_BARRA[tema];
  marcarTema(tema);

  try {
    const r = await fetch('/api/tema', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tema }),
    });
    if (!r.ok) throw new Error('no se ha guardado');
  } catch {
    /* Si no se pudo guardar se vuelve atrás, en vez de dejar la pantalla
       diciendo una cosa y el servidor recordando otra: al recargar volvería el
       anterior y parecería que el botón no funciona. */
    if (antes === 'oscuro') delete document.documentElement.dataset.tema;
    else document.documentElement.dataset.tema = antes;
    if (meta) meta.content = COLOR_BARRA[antes];
    marcarTema(antes);
  }
}

document.querySelectorAll('.menu-tema[data-tema]').forEach((b) => {
  b.addEventListener('click', () => ponerTema(b.dataset.tema));
});

/* Desplegar y plegar. El menú entero se cierra al pulsar fuera, así que esto
   solo tiene que ocuparse de abrir y cerrar su propia lista. */
const abrirTemas = document.getElementById('abrir-temas');
const submenuTemas = document.getElementById('submenu-temas');
if (abrirTemas && submenuTemas) {
  abrirTemas.addEventListener('click', () => abrirVentanaTema(true));
}

/* Abrir y cerrar la ventana. Al abrirla se cierra el menú de usuario: dejar los
   dos abiertos a la vez tapa media pantalla y no aporta nada. */
function abrirVentanaTema(v) {
  const velo = document.getElementById('tema-velo');
  if (!velo) return;
  velo.hidden = !v;
  if (v && typeof abrirMenu === 'function') abrirMenu(false);
  if (abrirTemas) abrirTemas.setAttribute('aria-expanded', v ? 'true' : 'false');
}

const veloTema = document.getElementById('tema-velo');
if (veloTema) {
  veloTema.addEventListener('click', (e) => {
    if (e.target === veloTema || e.target.closest('[data-cierra-tema]')) abrirVentanaTema(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !veloTema.hidden) abrirVentanaTema(false);
  });
}

marcarTema(temaActual());
