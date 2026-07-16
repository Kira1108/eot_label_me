import WaveSurfer from 'https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.esm.js'
import RegionsPlugin from 'https://unpkg.com/wavesurfer.js@7/dist/plugins/regions.esm.js'
import TimelinePlugin from 'https://unpkg.com/wavesurfer.js@7/dist/plugins/timeline.esm.js'

// ---------- DOM ----------
const $ = (id) => document.getElementById(id)
const urlInput = $('urlInput'), fileInput = $('fileInput')
const loadStatus = $('loadStatus'), audioMeta = $('audioMeta')
const waveCard = $('waveCard'), annCard = $('annCard'), listCard = $('listCard')

// ---------- State ----------
let ws = null, regions = null
let audioInfo = { name: '', sampleRate: 0, channels: 0, duration: 0 }
let cursorTime = 0
let speechRegion = null, waitRegion = null
let cur = { segStart: null, segEnd: null, label: null } // current in-progress annotation
let annotations = []
let origAB = null           // original file bytes (for stereo playback + case save)
let decodedBuffer = null    // decoded AudioBuffer (per-channel samples)
let channelChoice = 'stereo' // 'stereo' | 0 (L) | 1 (R) | ...
let zoomMode = false        // when true, next drag on waveform = box-zoom
let progAdd = false         // guard: region added programmatically (skip adopt)
const DEFAULT_WAIT_SEC = 0.5

// ---------- Load ----------
function setStatus(msg, cls = '') { loadStatus.textContent = msg; loadStatus.className = 'status ' + cls }

// ---------- True sample-rate detection (parse file header) ----------
// WaveSurfer resamples audio to its internal context, so we must read the
// real sample rate from the container header (MP3 / WAV covered natively).
function parseAudioHeader(ab, name) {
  const b = new Uint8Array(ab)
  const ext = (name.split('.').pop() || '').toLowerCase()
  // ---- WAV ----
  if (b.length > 44 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) { // "RIFF"
    const dv = new DataView(ab)
    // find "fmt " chunk
    let off = 12
    while (off + 8 <= b.length) {
      const id = String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3])
      const size = dv.getUint32(off + 4, true)
      if (id === 'fmt ') {
        return { sampleRate: dv.getUint32(off + 12, true), channels: dv.getUint16(off + 10, true), format: 'wav' }
      }
      off += 8 + size + (size % 2)
    }
  }
  // ---- MP3 ----
  let i = 0
  // skip ID3v2 tag
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) { // "ID3"
    const sz = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f)
    i = 10 + sz
  }
  for (; i < b.length - 4; i++) {
    if (b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0) { // frame sync
      const ver = (b[i + 1] >> 3) & 0x03      // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
      const rateIdx = (b[i + 2] >> 2) & 0x03
      const chMode = (b[i + 3] >> 6) & 0x03
      if (rateIdx === 3 || ver === 1) continue
      const tables = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }
      const t = tables[ver]
      if (t && t[rateIdx]) return { sampleRate: t[rateIdx], channels: chMode === 3 ? 1 : 2, format: 'mp3' }
    }
  }
  return null // unknown -> fall back to decoder
}

async function detectSampleRate(ab, name) {
  const hdr = parseAudioHeader(ab, name)
  if (hdr) return hdr
  // fallback: decode with a fresh AudioContext (rate may be the browser's, flagged approximate)
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)()
    const buf = await ac.decodeAudioData(ab.slice(0))
    const r = { sampleRate: buf.sampleRate, channels: buf.numberOfChannels, format: 'decoded' }
    ac.close()
    return r
  } catch { return null }
}

function initWave() {
  if (ws) { ws.destroy(); ws = null }
  $('waveform').innerHTML = ''
  $('timeline').innerHTML = ''
  ws = WaveSurfer.create({
    container: '#waveform',
    waveColor: '#3a4867',
    progressColor: '#4f8cff',
    cursorColor: '#ffffff',
    cursorWidth: 2,
    height: 150,
    normalize: true,
    minPxPerSec: 1,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
  })
  regions = ws.registerPlugin(RegionsPlugin.create())
  ws.registerPlugin(TimelinePlugin.create({ container: '#timeline' }))

  ws.on('ready', onReady)
  ws.on('interaction', (t) => { cursorTime = t; $('cursorTime').textContent = t.toFixed(3) })
  ws.on('timeupdate', (t) => { cursorTime = t; $('cursorTime').textContent = t.toFixed(3) })
  ws.on('play', () => setPlayIcon(true))
  ws.on('pause', () => setPlayIcon(false))
  ws.on('finish', () => setPlayIcon(false))
  ws.on('error', (e) => setStatus('加载/解码失败: ' + (e?.message || e) + '（URL 可能不允许跨域）', 'err'))

  regions.on('region-updated', onRegionUpdated)
  regions.on('region-created', onRegionCreated)
  regions.enableDragSelection({ color: 'rgba(79,140,255,0.22)' })
  window.__ws = ws // debug/testing hook
  window.__regions = regions
}

function setPlayIcon(playing) {
  const btn = $('playBtn')
  if (!btn) return
  const p = btn.querySelector('.ic-play'), ps = btn.querySelector('.ic-pause')
  if (p) p.style.display = playing ? 'none' : ''
  if (ps) ps.style.display = playing ? '' : 'none'
}

function onReady() {
  const buf = ws.getDecodedData()
  audioInfo.duration = buf ? buf.duration : ws.getDuration()
  // sampleRate & channels come from header detection (set before load); do NOT
  // trust getDecodedData().sampleRate because WaveSurfer resamples internally.
  $('metaName').textContent = audioInfo.name || '(URL)'
  $('metaRate').textContent = audioInfo.sampleRate ? audioInfo.sampleRate + (audioInfo.rateApprox ? ' (近似)' : '') : '未知'
  $('metaCh').textContent = audioInfo.channels || '?'
  $('metaDur').textContent = audioInfo.duration.toFixed(3)
  audioMeta.classList.remove('hidden')
  setStatus('加载成功 ✔  采样率 ' + (audioInfo.sampleRate || '未知') + ' Hz，已自动适配。', 'ok')

  const empty = $('emptyState'); if (empty) empty.style.display = 'none'
  waveCard.style.display = ''
  annCard.style.display = ''
  listCard.style.display = ''
  setPlayIcon(false)
  resetCurrent()
}

async function loadArrayBuffer(ab, name) {
  audioInfo = { name, sampleRate: 0, channels: 0, duration: 0, rateApprox: false }
  origAB = ab
  const info = await detectSampleRate(ab, name)
  if (info) {
    audioInfo.sampleRate = info.sampleRate
    audioInfo.channels = info.channels
    audioInfo.rateApprox = info.format === 'decoded'
  }
  // decode to get per-channel samples (at the true rate when known)
  decodedBuffer = null
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)(
      audioInfo.sampleRate ? { sampleRate: audioInfo.sampleRate } : undefined)
    decodedBuffer = await ac.decodeAudioData(ab.slice(0))
    ac.close()
  } catch (e) { /* keep null, fall back to original blob */ }

  if (decodedBuffer) audioInfo.channels = decodedBuffer.numberOfChannels
  if (!audioInfo.sampleRate && decodedBuffer) { audioInfo.sampleRate = decodedBuffer.sampleRate; audioInfo.rateApprox = true }

  channelChoice = 'stereo'
  buildChannelSelector()
  applyChannel()
}

// ---------- Channel selection ----------
// Build a WAV blob. pick='stereo' keeps all channels; pick=index outputs that
// single channel duplicated to BOTH output channels (so it is heard on both
// speakers while the waveform reflects only that channel).
function bufferToWavBlob(buf, pick) {
  const rate = buf.sampleRate
  const len = buf.length
  let outCh, getChannel
  if (pick === 'stereo') {
    outCh = Math.min(buf.numberOfChannels, 2)
    const chans = []
    for (let c = 0; c < outCh; c++) chans.push(buf.getChannelData(c))
    getChannel = (c) => chans[c]
  } else {
    outCh = 2
    const src = buf.getChannelData(pick)
    getChannel = () => src // both output channels get the same source
  }
  const bytesPerSample = 2
  const blockAlign = outCh * bytesPerSample
  const dataSize = len * blockAlign
  const ab = new ArrayBuffer(44 + dataSize)
  const dv = new DataView(ab)
  const ws2 = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)) }
  ws2(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); ws2(8, 'WAVE')
  ws2(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true)
  dv.setUint16(22, outCh, true); dv.setUint32(24, rate, true)
  dv.setUint32(28, rate * blockAlign, true); dv.setUint16(32, blockAlign, true)
  dv.setUint16(34, 16, true); ws2(36, 'data'); dv.setUint32(40, dataSize, true)
  let off = 44
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < outCh; c++) {
      let v = getChannel(c)[i]
      v = Math.max(-1, Math.min(1, v))
      dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true)
      off += 2
    }
  }
  return new Blob([ab], { type: 'audio/wav' })
}

// Crop [startSec, endSec) of a decoded buffer to a 16-bit WAV blob.
// pick='stereo' keeps up to 2 channels; a numeric index outputs ONLY that
// channel as mono (so left-annotation exports left data, right -> right data).
function cropToWavBlob(buf, pick, startSec, endSec) {
  const rate = buf.sampleRate
  const s = Math.max(0, Math.floor(startSec * rate))
  const e = Math.min(buf.length, Math.ceil(endSec * rate))
  const len = Math.max(0, e - s)
  let chans
  if (pick === 'stereo') {
    chans = []
    for (let c = 0; c < Math.min(buf.numberOfChannels, 2); c++) chans.push(buf.getChannelData(c).subarray(s, e))
  } else {
    const idx = Math.min(Number(pick), buf.numberOfChannels - 1)
    chans = [buf.getChannelData(idx).subarray(s, e)]
  }
  const outCh = chans.length
  const bytesPerSample = 2
  const blockAlign = outCh * bytesPerSample
  const dataSize = len * blockAlign
  const ab = new ArrayBuffer(44 + dataSize)
  const dv = new DataView(ab)
  const ws2 = (off, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)) }
  ws2(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); ws2(8, 'WAVE')
  ws2(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true)
  dv.setUint16(22, outCh, true); dv.setUint32(24, rate, true)
  dv.setUint32(28, rate * blockAlign, true); dv.setUint16(32, blockAlign, true)
  dv.setUint16(34, 16, true); ws2(36, 'data'); dv.setUint32(40, dataSize, true)
  let off = 44
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < outCh; c++) {
      let v = chans[c][i]
      v = Math.max(-1, Math.min(1, v))
      dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true)
      off += 2
    }
  }
  return { blob: new Blob([ab], { type: 'audio/wav' }), rate, samples: len }
}

function buildChannelSelector() {
  const wrap = $('channelWrap')
  const sel = $('channelSelect')
  if (!decodedBuffer || decodedBuffer.numberOfChannels < 2) {
    wrap.classList.add('hidden')
    sel.innerHTML = ''
    return
  }
  const names = ['左声道 (L)', '右声道 (R)', '声道 3', '声道 4']
  let opts = '<option value="stereo">立体声 (原始)</option>'
  for (let c = 0; c < decodedBuffer.numberOfChannels; c++) {
    opts += `<option value="${c}">${names[c] || '声道 ' + (c + 1)}</option>`
  }
  sel.innerHTML = opts
  sel.value = 'stereo'
  wrap.classList.remove('hidden')
}

function applyChannel() {
  initWave()
  if (channelChoice === 'stereo' || !decodedBuffer) {
    ws.loadBlob(new Blob([origAB]))
  } else {
    ws.loadBlob(bufferToWavBlob(decodedBuffer, channelChoice))
  }
}

async function loadFromUrl() {
  const url = urlInput.value.trim()
  if (!url) { setStatus('请输入 URL', 'err'); return }
  setStatus('下载中...')
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const ab = await res.arrayBuffer()
    await loadArrayBuffer(ab, url.split('/').pop().split('?')[0] || 'url')
  } catch (e) {
    setStatus('加载失败: ' + e.message + '（URL 可能不允许跨域 CORS）', 'err')
  }
}

async function loadFromFile(file) {
  setStatus('读取文件中...')
  const ab = await file.arrayBuffer()
  await loadArrayBuffer(ab, file.name)
}

$('loadUrlBtn').onclick = loadFromUrl
fileInput.onchange = (e) => { if (e.target.files[0]) loadFromFile(e.target.files[0]) }

// ---------- Playback controls ----------
$('playBtn').onclick = () => ws && ws.playPause()
$('zoom').oninput = (e) => ws && ws.zoom(Number(e.target.value))
$('zoomResetBtn').onclick = () => { if (!ws) return; ws.zoom(0); ws.setScrollTime(0); $('zoom').value = 0 }
$('zoomSelectBtn').onclick = () => setZoomMode(!zoomMode)
function setZoomMode(on) {
  zoomMode = on
  $('zoomSelectBtn').classList.toggle('toggle-active', on)
  setStatus(on ? '框选放大已开启：在波形空白处拖动选择要放大的区域' : '框选放大已关闭', on ? 'ok' : '')
}
function zoomToRange(s, e) {
  if (!ws) return
  if (e - s < 0.02) { setStatus('选择区域太小', 'err'); return }
  const w = (ws.getWidth && ws.getWidth()) || $('waveform').clientWidth || 800
  const px = Math.max(1, w / (e - s))
  ws.zoom(px)
  ws.setScrollTime(s)
  $('zoom').value = Math.min(Number($('zoom').max), px)
}
$('speed').onchange = (e) => ws && ws.setPlaybackRate(Number(e.target.value))
$('channelSelect').onchange = (e) => {
  const v = e.target.value
  channelChoice = v === 'stereo' ? 'stereo' : Number(v)
  const keepZoom = Number($('zoom').value)
  const keepSpeed = Number($('speed').value)
  applyChannel()
  ws.once('ready', () => { ws.zoom(keepZoom); ws.setPlaybackRate(keepSpeed) })
  const label = v === 'stereo' ? '立体声' : (v === '0' ? '左声道' : v === '1' ? '右声道' : '声道 ' + (Number(v) + 1))
  setStatus('已切换波形声道: ' + label + (v === 'stereo' ? '' : '（播放时左右两声道都能听到）'), 'ok')
}
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && ws && e.target.tagName !== 'INPUT') { e.preventDefault(); ws.playPause() }
})

// ---------- Speech segment + labels ----------
function clamp(t) { return Math.max(0, Math.min(t, audioInfo.duration)) }

function onRegionCreated(region) {
  if (progAdd) return           // programmatic (speech/wait) region, ignore
  if (region === speechRegion || region === waitRegion) return
  if (zoomMode) {               // box-zoom: use the drag, then discard the region
    const s = region.start, e = region.end
    region.remove()
    zoomToRange(s, e)
    setZoomMode(false)
    return
  }
  adoptSpeechRegion(region)     // a fresh drag-selection becomes the speech segment
}

function adoptSpeechRegion(region) {
  if (speechRegion && speechRegion !== region) speechRegion.remove()
  speechRegion = region
  speechRegion.setOptions({ color: 'rgba(79,140,255,0.22)', drag: true, resize: true, content: '语音' })
  cur.segStart = region.start
  cur.segEnd = region.end
  updateSegDisplay()
  if (waitRegion) reanchorWaitToSeg()
}

function ensureSpeechRegion() {
  if (speechRegion) return speechRegion
  progAdd = true
  const start = clamp(cursorTime)
  speechRegion = regions.addRegion({
    start, end: clamp(start + 0.3),
    color: 'rgba(79,140,255,0.22)', content: '语音', drag: true, resize: true,
  })
  progAdd = false
  cur.segStart = speechRegion.start
  cur.segEnd = speechRegion.end
  return speechRegion
}

$('segStartBtn').onclick = () => {
  const r = ensureSpeechRegion()
  const start = clamp(cursorTime)
  const end = Math.max(start + 0.01, r.end)
  r.setOptions({ start, end }); cur.segStart = start; cur.segEnd = end; updateSegDisplay()
  if (waitRegion) reanchorWaitToSeg()
}
$('segEndBtn').onclick = () => {
  const r = ensureSpeechRegion()
  const end = clamp(cursorTime)
  const start = Math.min(r.start, end - 0.01)
  r.setOptions({ start: Math.max(0, start), end }); cur.segStart = r.start; cur.segEnd = end; updateSegDisplay()
  if (waitRegion) reanchorWaitToSeg()
}

function updateSegDisplay() {
  $('segStart').textContent = cur.segStart != null ? cur.segStart.toFixed(3) : '-'
  $('segEnd').textContent = cur.segEnd != null ? cur.segEnd.toFixed(3) : '-'
  $('segDur').textContent = (cur.segStart != null && cur.segEnd != null) ? (cur.segEnd - cur.segStart).toFixed(3) : '-'
}

$('completeBtn').onclick = () => setLabel('complete')
$('incompleteBtn').onclick = () => setLabel('incomplete')

function setLabel(label) {
  if (cur.segStart == null || cur.segEnd == null) { setStatus('请先选择语音区间（拖动或用起点/终点按钮）', 'err'); return }
  cur.label = label
  $('completeBtn').classList.toggle('active', label === 'complete')
  $('incompleteBtn').classList.toggle('active', label === 'incomplete')
  const tag = $('curLabel'); tag.textContent = label; tag.className = 'tag ' + label

  if (label === 'incomplete') {
    $('waitBox').classList.remove('hidden')
    if (!waitRegion) createWaitRegion()
    updateWaitDisplay()
  } else {
    $('waitBox').classList.add('hidden')
    if (waitRegion) { waitRegion.remove(); waitRegion = null }
  }
}

// wait_time region: default DEFAULT_WAIT_SEC starting at speech end; both edges adjustable
function createWaitRegion() {
  const start = clamp(cur.segEnd)
  const end = clamp(start + Math.min(DEFAULT_WAIT_SEC, Math.max(0.05, audioInfo.duration - start)))
  progAdd = true
  waitRegion = regions.addRegion({
    start, end, color: 'rgba(245,184,61,0.26)', drag: true, resize: true,
  })
  progAdd = false
}

function reanchorWaitToSeg() {
  if (!waitRegion) return
  const start = clamp(cur.segEnd)
  const end = clamp(Math.max(start + 0.05, start + DEFAULT_WAIT_SEC))
  waitRegion.setOptions({ start, end })
  updateWaitDisplay()
}

function onRegionUpdated(region) {
  if (region === speechRegion) { cur.segStart = region.start; cur.segEnd = region.end; updateSegDisplay() }
  if (region === waitRegion) updateWaitDisplay()
}

function updateWaitDisplay() {
  if (!waitRegion) return
  const ms = Math.round((waitRegion.end - waitRegion.start) * 1000)
  $('waitStart').textContent = waitRegion.start.toFixed(3)
  $('waitEnd').textContent = waitRegion.end.toFixed(3)
  $('waitMs').textContent = ms
}

$('waitStartFromCursor').onclick = () => {
  if (!waitRegion) return
  const start = clamp(cursorTime)
  waitRegion.setOptions({ start, end: Math.max(waitRegion.end, start + 0.01) })
  updateWaitDisplay()
}
$('waitEndFromCursor').onclick = () => {
  if (!waitRegion) return
  const end = clamp(cursorTime)
  waitRegion.setOptions({ start: Math.min(waitRegion.start, end - 0.01), end })
  updateWaitDisplay()
}

// ---------- Save / list ----------
$('addBtn').onclick = () => {
  if (cur.segStart == null || cur.segEnd == null) { setStatus('请先选择语音区间', 'err'); return }
  if (!cur.label) { setStatus('请选择标签', 'err'); return }
  const inc = cur.label === 'incomplete' && waitRegion
  const rec = {
    index: annotations.length + 1,
    seg_start_sec: +cur.segStart.toFixed(3),
    seg_end_sec: +cur.segEnd.toFixed(3),
    seg_duration_sec: +(cur.segEnd - cur.segStart).toFixed(3),
    label: cur.label,
    channel: channelChoice, // 'stereo' | 0 | 1 ... captured at annotation time
    wait_start_sec: inc ? +waitRegion.start.toFixed(3) : null,
    wait_end_sec: inc ? +waitRegion.end.toFixed(3) : null,
    wait_time_ms: inc ? Math.round((waitRegion.end - waitRegion.start) * 1000) : null,
    note: $('noteInput').value.trim() || '',
  }
  annotations.push(rec)
  renderTable()
  resetCurrent()
  setStatus('已保存标注 #' + rec.index, 'ok')
}

$('clearCurBtn').onclick = resetCurrent

function resetCurrent() {
  cur = { segStart: null, segEnd: null, label: null }
  if (speechRegion) { speechRegion.remove(); speechRegion = null }
  if (waitRegion) { waitRegion.remove(); waitRegion = null }
  updateSegDisplay()
  $('curLabel').textContent = ''; $('curLabel').className = 'tag'
  $('completeBtn').classList.remove('active'); $('incompleteBtn').classList.remove('active')
  $('waitBox').classList.add('hidden')
  $('noteInput').value = ''
}

function renderTable() {
  const tb = $('annTable').querySelector('tbody')
  tb.innerHTML = ''
  annotations.forEach((r, i) => {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td>${r.index}</td>
      <td>${r.seg_start_sec} ~ ${r.seg_end_sec}</td>
      <td>${r.seg_duration_sec}</td>
      <td class="tag ${r.label}">${r.label}</td>
      <td>${r.wait_time_ms ?? '-'}</td><td>${r.note || ''}</td>
      <td><button data-i="${i}">删除</button></td>`
    tr.querySelector('button').onclick = () => { annotations.splice(i, 1); reindex(); renderTable() }
    tb.appendChild(tr)
  })
  $('count').textContent = annotations.length
}
function reindex() { annotations.forEach((r, i) => r.index = i + 1) }

// ---------- Export ----------
function baseName() {
  return (audioInfo.name || 'annotations').replace(/\.[^.]+$/, '') || 'annotations'
}
function channelLabel(ch) {
  return ch === 'stereo' ? 'stereo' : (ch === 0 ? 'left' : ch === 1 ? 'right' : 'ch' + (Number(ch) + 1))
}
function buildJson() {
  return JSON.stringify({
    audio: {
      name: audioInfo.name,
      sample_rate: audioInfo.sampleRate,
      channels: audioInfo.channels,
      duration_sec: +audioInfo.duration.toFixed(3),
    },
    annotations,
  }, null, 2)
}
function downloadBlob(blob, filename) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 1000)
}
$('exportBtn').onclick = () => {
  downloadBlob(new Blob([buildJson()], { type: 'application/json' }), baseName() + '.eot.json')
}
$('copyBtn').onclick = async () => {
  await navigator.clipboard.writeText(buildJson())
  setStatus('JSON 已复制到剪贴板', 'ok')
}
$('clearAllBtn').onclick = () => { if (confirm('清空全部标注?')) { annotations = []; renderTable() } }

// ---------- Save cases to a folder (File System Access API) ----------
let rootDirHandle = null // the "eot-data" directory handle

async function verifyRW(handle) {
  if (typeof handle.queryPermission !== 'function') return true // e.g. OPFS handles
  const opts = { mode: 'readwrite' }
  if ((await handle.queryPermission(opts)) === 'granted') return true
  return (await handle.requestPermission(opts)) === 'granted'
}

async function pickDir() {
  if (!window.showDirectoryPicker) {
    setStatus('当前浏览器不支持文件夹保存（需 Chrome/Edge，并通过 http://localhost 打开）', 'err')
    return null
  }
  const picked = await window.showDirectoryPicker({ id: 'eot', mode: 'readwrite', startIn: 'desktop' })
  // If the user already selected an "eot-data" folder, use it; otherwise create one inside.
  rootDirHandle = picked.name === 'eot-data'
    ? picked
    : await picked.getDirectoryHandle('eot-data', { create: true })
  if (!(await verifyRW(rootDirHandle))) { setStatus('未获得写入权限', 'err'); rootDirHandle = null; return null }
  $('dirLabel').textContent = '📁 ' + (picked.name === 'eot-data' ? 'eot-data' : picked.name + '/eot-data')
  setStatus('保存文件夹已选择: ' + $('dirLabel').textContent, 'ok')
  return rootDirHandle
}
$('pickDirBtn').onclick = () => pickDir().catch(e => setStatus('选择文件夹失败: ' + e.message, 'err'))

function randomCaseName() {
  const id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2)).replace(/-/g, '').slice(0, 12)
  return 'case-' + id
}

async function writeFile(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  await w.write(blob)
  await w.close()
}

function buildCaseJson(rec, caseId, clip, audioFile) {
  const ch = rec.channel
  const inc = rec.label === 'incomplete'
  return JSON.stringify({
    case_id: caseId,
    source_audio: audioInfo.name,
    audio_file: audioFile,          // cropped clip filename in this folder
    sample_rate: clip.rate,         // sample rate of the saved clip
    channel: channelLabel(ch),
    clip: {                         // the cropped range (speech segment) in the SOURCE audio
      start_sec: rec.seg_start_sec,
      end_sec: rec.seg_end_sec,
      duration_sec: rec.seg_duration_sec,
      samples: clip.samples,
    },
    label: rec.label,
    // wait_time is the prediction target measured from the speech endpoint (clip end)
    wait_time_ms: inc ? rec.wait_time_ms : null,
    wait: inc ? {
      start_sec: rec.wait_start_sec,
      end_sec: rec.wait_end_sec,
      // relative to the clip end (speech endpoint = 0)
      rel_start_sec: +(rec.wait_start_sec - rec.seg_end_sec).toFixed(3),
      rel_end_sec: +(rec.wait_end_sec - rec.seg_end_sec).toFixed(3),
    } : null,
    note: rec.note || '',
  }, null, 2)
}

$('saveCasesBtn').onclick = async () => {
  if (!annotations.length) { setStatus('没有可保存的标注', 'err'); return }
  if (!decodedBuffer) { setStatus('音频未成功解码，无法截取', 'err'); return }
  try {
    const root = rootDirHandle || await pickDir()
    if (!root) return
    let ok = 0
    for (const rec of annotations) {
      const caseId = randomCaseName()
      const caseDir = await root.getDirectoryHandle(caseId, { create: true })
      // crop the SPEECH SEGMENT (seg_start -> seg_end), selected channel
      const clip = cropToWavBlob(decodedBuffer, rec.channel, rec.seg_start_sec, rec.seg_end_sec)
      await writeFile(caseDir, 'audio.wav', clip.blob)
      await writeFile(caseDir, 'annotation.json',
        new Blob([buildCaseJson(rec, caseId, clip, 'audio.wav')], { type: 'application/json' }))
      ok++
    }
    setStatus(`已保存 ${ok} 个 case 到 ${$('dirLabel').textContent}（每个独立文件夹，含截取音频 audio.wav + annotation.json）`, 'ok')
  } catch (e) {
    if (e.name === 'AbortError') { setStatus('已取消', ''); return }
    setStatus('保存失败: ' + e.message, 'err')
  }
}
