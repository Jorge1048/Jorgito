'use strict';
/* Manga PDF Manager — 100% local. Los PDFs solo se leen en memoria del navegador. */
const $ = s => document.querySelector(s);
const GB = 1024 ** 3;
const state = { items: [], events: [], warn: [], manga: 'Manga', running: false, doneBatches: [] };

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtSize = b => b >= GB ? (b / GB).toFixed(2) + ' GB' : (b / 1048576).toFixed(0) + ' MB';
const rng = (a, b) => a === b ? `${a}` : `${a}-${b}`;
const limit = () => Math.max(0.1, parseFloat($('#max').value) || 2) * GB;
const tick = () => new Promise(r => setTimeout(r));
const note = (icon, text) => { state.events.unshift({ icon, text, t: new Date().toLocaleTimeString() }); render(); };

/* ---------- 1. Interpretar el nombre del archivo ---------- */
function parseName(fn) {
  let s = fn.replace(/\.pdf$/i, '').replace(/_/g, ' ');
  let copy = false;
  // Sufijo de copia "(1)" solo si el resto del nombre ya contiene un número
  const c = s.match(/^(.*\S)\s+\((\d{1,2})\)\s*$/);
  if (c && /\d/.test(c[1])) { s = c[1]; copy = true; }

  let m = s.match(/(\d+(?:\.\d+)?)\s*[-–—~]\s*(\d+(?:\.\d+)?)/), a, b;
  if (m) { a = +m[1]; b = +m[2]; }
  else {
    const all = [...s.matchAll(/\d+(?:\.\d+)?/g)];
    // Sin número, varios números ambiguos o palabras tipo "volumen/especial" => no interpretable
    if (all.length !== 1 || /\b(vol(umen|umenes)?|tomo|especial|special|extra)\b/i.test(s)) return { name: '', copy, start: null };
    m = all[0]; a = b = +m[0];
  }
  if (b < a) return { name: '', copy, start: null };
  const name = s.slice(0, m.index)
    .replace(/\b(caps?|cap[ií]tulos?|chapters?|ch|c)\b\.?/gi, '')
    .replace(/[()\[\]\-–—:]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { name, copy, start: a, end: b };
}

/* ---------- 2. Agregar archivos ---------- */
function addFiles(list) {
  for (const f of list) {
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') continue;
    if (state.items.some(i => i.file.name === f.name && i.file.size === f.size && i.file.lastModified === f.lastModified)) continue;
    const p = parseName(f.name);
    state.items.push({ file: f, size: f.size, ...p, parsed: p.start !== null, status: 'pending', keep: null, err: '' });
  }
  $('#app').hidden = !state.items.length;
  render();
}

/* ---------- 3. Análisis: duplicados, faltantes, advertencias ---------- */
const isActive = i => i.parsed && !i.excluded && i.status !== 'error';
function analyze() {
  const it = state.items, lim = limit();
  it.sort((x, y) => (x.parsed === y.parsed ? 0 : x.parsed ? -1 : 1) || x.start - y.start || x.end - y.end || x.file.name.localeCompare(y.file.name, undefined, { numeric: true }));

  // Nombre del manga: el más frecuente
  const cnt = {};
  it.forEach(i => { if (i.name) { const k = i.name.toLowerCase(); (cnt[k] = cnt[k] || { n: 0, name: i.name }).n++; } });
  const top = Object.values(cnt).sort((a, b) => b.n - a.n)[0];
  state.manga = top ? top.name : 'Manga';

  // Duplicados: mismo rango exacto
  const groups = {};
  it.forEach(i => { i.dupKey = null; i.excluded = false; if (i.parsed) (groups[rng(i.start, i.end)] ||= []).push(i); });
  state.warn = [];
  for (const [k, g] of Object.entries(groups)) {
    if (g.length < 2) continue;
    if (!g.some(i => i.keep)) { g.forEach(i => i.keep = false); g.sort((a, b) => a.copy - b.copy)[0].keep = true; }
    g.forEach(i => { i.dupKey = k; i.excluded = !i.keep; });
    state.warn.push(`⚠️ Posible duplicado: capítulos ${k} (${g.length} archivos). Elige cuál conservar.`);
  }
  it.filter(i => !i.parsed).forEach(i => state.warn.push(`⚠️ No se pudo determinar el rango de este archivo: ${i.file.name}`));
  it.filter(i => i.size > lim).forEach(i => state.warn.push(`⚠️ ${i.file.name} pesa ${fmtSize(i.size)} y supera el máximo: no se procesará como lote normal.`));
  it.filter(i => i.status === 'error').forEach(i => state.warn.push(`❌ Error en ${i.file.name}: ${i.err}`));

  // Capítulos faltantes (sobre archivos interpretables)
  state.missing = [];
  let maxEnd = null;
  it.filter(i => i.parsed && !i.excluded).forEach(i => {
    if (maxEnd !== null && Math.ceil(i.start) - Math.floor(maxEnd) > 1) {
      const a = Math.floor(maxEnd) + 1, b = Math.ceil(i.start) - 1;
      state.missing.push(rng(a, b));
      state.warn.push(`⚠️ Posible capítulo faltante: ${rng(a, b)} (salto entre ${maxEnd} y ${i.start}).` +
        (it.some(x => !x.parsed) ? ' Podría estar en un archivo no reconocido.' : ''));
    }
    maxEnd = maxEnd === null ? i.end : Math.max(maxEnd, i.end);
  });
  state.missingCount = state.missing.reduce((n, r) => { const [a, b] = r.split('-').map(Number); return n + (b ? b - a + 1 : 1); }, 0);
}

/* ---------- 4. Lotes (orden numérico, máx. tamaño) ---------- */
function buildBatches() {
  const lim = limit(), batches = [];
  let cur = null;
  for (const f of state.items.filter(i => isActive(i) && i.status === 'pending' && i.size <= lim)) {
    if (!cur || cur.size + f.size > lim) batches.push(cur = { files: [], size: 0 });
    cur.files.push(f); cur.size += f.size;
  }
  batches.forEach(b => { b.min = b.files[0].start; b.max = Math.max(...b.files.map(f => f.end)); });
  return batches;
}

/* ---------- 5. Render ---------- */
function render() {
  analyze();
  const it = state.items, tot = it.reduce((n, i) => n + i.size, 0);
  const parsed = it.filter(i => i.parsed);
  const done = it.filter(i => i.status === 'done').reduce((n, i) => n + i.size, 0);
  const pend = it.filter(i => i.status === 'pending' && isActive(i) && i.size <= limit()).reduce((n, i) => n + i.size, 0);
  const errs = it.filter(i => i.status === 'error').length;
  const range = parsed.length ? rng(Math.min(...parsed.map(i => i.start)), Math.max(...parsed.map(i => i.end))) : '—';
  const st = [['📚 Manga', state.manga], ['📄 Archivos', it.length], ['📖 Capítulos', range], ['💾 Tamaño total', fmtSize(tot)],
    ['✅ Procesados', fmtSize(done)], ['⏳ Pendientes', fmtSize(pend)], ['⚠️ Advertencias', state.warn.length - errs],
    ['❌ Errores', errs], ['Sin interpretar', it.filter(i => !i.parsed).length], ['Capítulos faltantes', state.missingCount]];
  $('#stats').innerHTML = st.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('');

  const evs = [...state.warn.map(t => ({ t })), ...state.events.map(e => ({ t: `${e.icon} ${e.text}`, time: e.t }))];
  $('#notes').innerHTML = evs.map(e => `<li class="${e.t.startsWith('❌') ? 'error' : e.t.startsWith('⚠️') ? 'warn' : 'done'}"><span>${esc(e.t)}</span><small>${e.time || ''}</small></li>`).join('') || '<li>Sin notificaciones.</li>';

  const bs = buildBatches();
  $('#batches').innerHTML = (state.doneBatches.map(d => `<li class="done"><span class="info"><b>✅ ${esc(d.name)}</b><small>Capítulos ${d.r} · ${fmtSize(d.size)}</small></span></li>`).join('') +
    bs.map((b, n) => `<li class="pending"><span class="info"><b>⏳ Lote ${n + 1}</b><small>Capítulos ${rng(b.min, b.max)} · ${fmtSize(b.size)} · ${b.files.length} archivos</small></span></li>`).join('')) || '<li>No hay lotes pendientes.</li>';

  $('#files').innerHTML = it.map((i, n) => {
    const cls = i.status === 'done' ? 'done' : i.status === 'error' ? 'error' : (!i.parsed || i.dupKey || i.size > limit()) ? 'warn' : 'pending';
    const ico = { done: '✅', error: '❌', warn: '⚠️', pending: '⏳' }[cls];
    const stTxt = i.status === 'done' ? 'Procesado' : i.status === 'error' ? 'Error: ' + i.err : !i.parsed ? 'Rango no reconocido' : i.excluded ? 'Duplicado omitido' : i.dupKey ? 'Duplicado (conservado)' : i.size > limit() ? 'Demasiado grande' : 'Pendiente';
    return `<li class="${cls} ${i.excluded ? 'off' : ''}"><span class="info"><b>${ico} ${esc(i.file.name)}</b><small>${fmtSize(i.size)} · Capítulos: ${i.parsed ? rng(i.start, i.end) : '?'} · ${esc(stTxt)}</small></span>
      <span>${!i.parsed ? `<button data-a="set" data-n="${n}">Asignar capítulos</button>` : ''}${i.dupKey && !i.keep ? `<button data-a="keep" data-n="${n}">Conservar este</button>` : ''}
      <button data-a="rm" data-n="${n}" aria-label="Quitar">✕</button></span></li>`;
  }).join('');
  $('#go').disabled = state.running || !bs.length;
}

/* ---------- 6. Procesar y descargar ---------- */
function askName(def, size) {
  return new Promise(res => {
    const d = $('#dlg'); $('#nm').value = def; $('#dinfo').textContent = `Tamaño: ${fmtSize(size)}`;
    $('#dl').onclick = () => { d.close(); res(($('#nm').value.trim() || def).replace(/[\\/:*?"<>|]/g, '').replace(/\.pdf$/i, '')); };
    d.addEventListener('cancel', e => e.preventDefault(), { once: true }); // obliga a elegir nombre
    d.showModal();
  });
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name + '.pdf';
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function run() {
  if (state.running) return;
  const batches = buildBatches(); if (!batches.length) return;
  state.running = true; $('#prog').hidden = false; render();
  for (let n = 0; n < batches.length; n++) {
    const b = batches[n]; let cur = null, bytes = 0;
    try {
      const out = await PDFLib.PDFDocument.create(); let read = 0;
      for (const f of b.files) {
        cur = f;
        $('#prog').innerHTML = `<h2>Procesando lote ${n + 1} de ${batches.length}</h2><div>${esc(state.manga)} ${rng(b.min, b.max)}</div><div class="bar"><i style="width:${read / b.size * 100}%"></i></div><small>${Math.round(read / b.size * 100)}% · ${esc(f.file.name)}</small>`;
        await tick();
        const src = await PDFLib.PDFDocument.load(await f.file.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
        (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
        read += f.size;
      }
      cur = null;
      $('#prog').innerHTML = `<h2>Lote ${n + 1} de ${batches.length}: guardando…</h2><div class="bar"><i style="width:100%"></i></div>`;
      await tick();
      const data = await out.save(); bytes = data.length;
      const name = await askName(`(${b.min} - ${b.max}) ${state.manga}`, bytes);
      download(new Blob([data], { type: 'application/pdf' }), name);
      b.files.forEach(f => f.status = 'done');
      state.doneBatches.push({ name: name + '.pdf', r: rng(b.min, b.max), size: bytes });
      note('🔔', `Lote terminado: se creó correctamente ${name}.pdf`);
    } catch (e) {
      if (cur) { cur.status = 'error'; cur.err = e.message || 'no se pudo leer el PDF'; }
      note('❌', `Lote ${n + 1} falló${cur ? ' en ' + cur.file.name : ''}: ${e.message}. Los demás archivos siguen pendientes.`);
    }
    await tick();
  }
  state.running = false; $('#prog').hidden = true;
  note('🔔', 'Proceso terminado: todos los archivos compatibles fueron procesados.');
}

/* ---------- 7. Eventos ---------- */
$('#file').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
const drop = $('#drop');
['dragover', 'dragenter'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));
$('#max').oninput = render;
$('#go').onclick = run;
$('#clear').onclick = () => { if (!state.running) { state.items = []; state.events = []; state.doneBatches = []; $('#app').hidden = true; render(); } };
$('#files').onclick = e => {
  const b = e.target.closest('button'); if (!b || state.running) return;
  const i = state.items[+b.dataset.n];
  if (b.dataset.a === 'rm') state.items.splice(+b.dataset.n, 1);
  if (b.dataset.a === 'keep') state.items.filter(x => x.dupKey === i.dupKey).forEach(x => x.keep = x === i);
  if (b.dataset.a === 'set') {
    const m = (prompt(`Capítulos de "${i.file.name}" (ej: 12 o 12-20):`) || '').match(/^\s*(\d+(?:\.\d+)?)\s*(?:[-–]\s*(\d+(?:\.\d+)?))?\s*$/);
    if (m && (!m[2] || +m[2] >= +m[1])) { i.start = +m[1]; i.end = +(m[2] || m[1]); i.parsed = true; }
  }
  render();
};
