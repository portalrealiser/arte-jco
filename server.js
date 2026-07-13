'use strict';

/*
 * Arte JCO — gerador de imagem no padrão "Print / Feed" do Jornal da Cidade Online.
 * Substitui a Placid: recebe { imagem, titulo } e devolve { image_url } público.
 *
 * Layout (canvas fixo 1080 x 1350, formato 4:5 de feed):
 *   - Chrome (cabeçalho + barra COMPARTILHAR)  : overlay PNG fixo, y 0..214
 *   - Área branca do título                    : y 214..~645, título auto-fit centralizado
 *   - Handle (@jonaldacidadeonline)            : cinza, esquerda, y ~685
 *   - Foto                                     : y 705..1350 (1080x645), cover-crop
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { createCanvas, loadImage, registerFont } = require('canvas');

// ---------- Config ----------
const PORT = parseInt(process.env.PORT || '3002', 10);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const HANDLE = process.env.HANDLE || '@jornaldacidadeonline';
const JPEG_QUALITY = parseFloat(process.env.JPEG_QUALITY || '0.92');
const RETENTION_HOURS = parseFloat(process.env.RETENTION_HOURS || '24');
const RENDER_TOKEN = process.env.RENDER_TOKEN || '';            // se setado, exige Bearer no /render
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '10000', 10);
const MAX_IMAGE_MB = parseFloat(process.env.MAX_IMAGE_MB || '15');

const ASSETS = path.join(__dirname, 'assets');
const PUBLIC_DIR = path.join(__dirname, 'public');
const IMG_DIR = path.join(PUBLIC_DIR, 'img');
fs.mkdirSync(IMG_DIR, { recursive: true });

// ---------- Fontes ----------
registerFont(path.join(ASSETS, 'Roboto-Regular.ttf'), { family: 'JCOSans', weight: 'normal' });
try {
  registerFont(path.join(ASSETS, 'Roboto-Bold.ttf'), { family: 'JCOSans', weight: 'bold' });
} catch (_) { /* bold é opcional */ }

// ---------- Constantes de layout (medidas na arte original) ----------
const W = 1080, H = 1350;

const CHROME_H = 214;              // altura do overlay do topo

// caixa do título (área branca, acima do handle)
const TITLE_BOX = { top: 226, bottom: 640, maxWidth: 960, centerX: W / 2 };
const TITLE_MAX_FONT = 70;   // base fixa (encolhe só se não couber)
const TITLE_MIN_FONT = 30;
const LINE_HEIGHT_RATIO = 1.32;    // line-height / font-size observado
const TITLE_COLOR = '#111111';

// handle
const HANDLE_FONT = 29;
const HANDLE_COLOR = '#aeaeae';
const HANDLE_X = 30;
const HANDLE_BASELINE = 688;

// foto
const PHOTO = { x: 0, y: 705, w: 1080, h: 645 };

// ---------- Chrome overlay (carregado 1x) ----------
let chromeImg = null;
async function getChrome() {
  if (!chromeImg) chromeImg = await loadImage(path.join(ASSETS, 'chrome.png'));
  return chromeImg;
}

// ---------- Helpers ----------
function wrapLines(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const word of words) {
    const tentative = cur ? cur + ' ' + word : word;
    if (ctx.measureText(tentative).width <= maxWidth || !cur) {
      cur = tentative;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Auto-fit: acha a maior fonte em que o título (quebrado) cabe na caixa.
function fitTitle(ctx, text) {
  const boxH = TITLE_BOX.bottom - TITLE_BOX.top;
  for (let size = TITLE_MAX_FONT; size >= TITLE_MIN_FONT; size--) {
    ctx.font = `normal ${size}px JCOSans`;
    const lines = wrapLines(ctx, text, TITLE_BOX.maxWidth);
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const lineH = size * LINE_HEIGHT_RATIO;
    const blockH = lines.length * lineH;
    if (widest <= TITLE_BOX.maxWidth && blockH <= boxH) {
      return { size, lines, lineH, blockH };
    }
  }
  // fallback: fonte mínima
  ctx.font = `normal ${TITLE_MIN_FONT}px JCOSans`;
  const lines = wrapLines(ctx, text, TITLE_BOX.maxWidth);
  return { size: TITLE_MIN_FONT, lines, lineH: TITLE_MIN_FONT * LINE_HEIGHT_RATIO, blockH: lines.length * TITLE_MIN_FONT * LINE_HEIGHT_RATIO };
}

function drawCover(ctx, img, dx, dy, dw, dh) {
  const scale = Math.max(dw / img.width, dh / img.height);
  const sw = dw / scale, sh = dh / scale;
  const sx = (img.width - sw) / 2;
  const sy = (img.height - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

async function fetchImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`timeout ao baixar imagem (${FETCH_TIMEOUT_MS}ms)`);
    throw new Error('falha de rede ao baixar imagem');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`falha ao baixar imagem (${res.status})`);

  // valida tipo: precisa ser imagem
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (!ctype.startsWith('image/')) {
    throw new Error(`URL não retornou uma imagem (content-type: ${ctype || 'desconhecido'})`);
  }

  // valida tamanho: pelo header se houver, e pelo buffer sempre
  const maxBytes = MAX_IMAGE_MB * 1024 * 1024;
  const declared = parseInt(res.headers.get('content-length') || '0', 10);
  if (declared && declared > maxBytes) {
    throw new Error(`imagem excede o limite de ${MAX_IMAGE_MB}MB`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error(`imagem excede o limite de ${MAX_IMAGE_MB}MB`);
  }
  return loadImage(buf);
}

// ---------- Render principal ----------
async function renderArt({ imagem, titulo }) {
  if (!titulo || !String(titulo).trim()) throw new Error('titulo é obrigatório');
  if (!imagem || !String(imagem).trim()) throw new Error('imagem (URL) é obrigatória');

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // fundo branco
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // foto (cover-crop na região de baixo)
  const photo = await fetchImage(String(imagem).trim());
  drawCover(ctx, photo, PHOTO.x, PHOTO.y, PHOTO.w, PHOTO.h);

  // título (caixa alta, auto-fit, centralizado e centralizado verticalmente na caixa)
  const text = String(titulo).trim().toUpperCase();
  const fit = fitTitle(ctx, text);
  ctx.fillStyle = TITLE_COLOR;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const boxCenterY = (TITLE_BOX.top + TITLE_BOX.bottom) / 2;
  const startY = boxCenterY - fit.blockH / 2 + fit.size; // baseline da 1ª linha
  ctx.font = `normal ${fit.size}px JCOSans`;
  fit.lines.forEach((line, i) => {
    ctx.fillText(line, TITLE_BOX.centerX, startY + i * fit.lineH);
  });

  // handle
  ctx.fillStyle = HANDLE_COLOR;
  ctx.textAlign = 'left';
  ctx.font = `normal ${HANDLE_FONT}px JCOSans`;
  ctx.fillText(HANDLE, HANDLE_X, HANDLE_BASELINE);

  // chrome por cima (cabeçalho + barra)
  const chrome = await getChrome();
  ctx.drawImage(chrome, 0, 0, W, CHROME_H);

  return canvas.toBuffer('image/jpeg', { quality: JPEG_QUALITY });
}

// ---------- Limpeza de arquivos antigos ----------
function cleanup() {
  const cutoff = Date.now() - RETENTION_HOURS * 3600 * 1000;
  fs.readdir(IMG_DIR, (err, files) => {
    if (err) return;
    for (const f of files) {
      const fp = path.join(IMG_DIR, f);
      fs.stat(fp, (e, st) => {
        if (!e && st.mtimeMs < cutoff) fs.unlink(fp, () => {});
      });
    }
  });
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/img', express.static(IMG_DIR, { maxAge: '1h' }));

app.get('/', (_req, res) => res.json({ ok: true, service: 'arte-jco', base: PUBLIC_BASE_URL }));

// Auth: se RENDER_TOKEN estiver setado, exige "Authorization: Bearer <token>"
function requireToken(req, res, next) {
  if (!RENDER_TOKEN) return next(); // sem token configurado = aberto (ver aviso no boot)
  const auth = req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== RENDER_TOKEN) {
    return res.status(401).json({ error: 'não autorizado' });
  }
  next();
}

app.post('/render', requireToken, async (req, res) => {
  try {
    const { imagem, titulo } = req.body || {};
    const buf = await renderArt({ imagem, titulo });
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`;
    fs.writeFileSync(path.join(IMG_DIR, name), buf);
    const image_url = `${PUBLIC_BASE_URL}/img/${name}`;
    res.json({ image_url });
  } catch (err) {
    console.error('[render]', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`arte-jco ouvindo na porta ${PORT} | base ${PUBLIC_BASE_URL}`);
  if (!RENDER_TOKEN) {
    console.warn('[aviso] RENDER_TOKEN não configurado: /render está ABERTO. Recomendado definir em produção.');
  }
  cleanup();
  setInterval(cleanup, 3600 * 1000);
});
