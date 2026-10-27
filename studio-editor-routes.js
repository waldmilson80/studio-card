'use strict';

/**
 * Rotas independentes do Editor Visual Studio Card.
 * Este módulo não substitui nem altera /gerar-card. Ele registra somente
 * endpoints novos sob /editor e /editor/api/*.
 */
module.exports = function registerStudioEditorRoutes(app, deps) {
  const {
    puppeteer,
    chromium,
    fs,
    path,
    fetch: fetchFn,
    limparTextoLixo,
    gerarLegendaGeminiOficial
  } = deps;

  const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
  const MAX_SLIDES = 10;
  const MIN_SLIDES = 2;

  const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  };

  const escapeHtml = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const safeColor = (value, fallback) => {
    const candidate = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : fallback;
  };

  const safeDataImage = (value, label = 'imagem') => {
    const input = String(value || '').trim();
    if (!/^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=\r\n]+$/i.test(input)) {
      throw new Error(`A ${label} não é uma imagem válida. Selecione o arquivo novamente.`);
    }
    return input;
  };

  const safeOptionalDataImage = (value) => {
    if (!value) return '';
    return safeDataImage(value, 'logo');
  };

  function sanitizeDesign(input = {}) {
    const alignment = ['left', 'center', 'right'].includes(input.titleAlign)
      ? input.titleAlign : 'center';
    return {
      accentColor: safeColor(input.accentColor, '#f3132b'),
      titleColor: safeColor(input.titleColor, '#ffffff'),
      fontFamily: ['Montserrat', 'Arial', 'Roboto', 'Georgia'].includes(input.fontFamily)
        ? input.fontFamily : 'Montserrat',
      fontSize: clamp(input.fontSize, 34, 100, 68),
      titleBottom: clamp(input.titleBottom, 110, 700, 166),
      titleWidth: clamp(input.titleWidth, 45, 100, 92),
      titleX: clamp(input.titleX, 0, 100, 50),
      titleAlign: alignment,
      lineHeight: clamp(input.lineHeight, 0.85, 1.35, 1.075),
      titleWeight: [600, 700, 800, 900].includes(Number(input.titleWeight))
        ? Number(input.titleWeight) : 900,
      letterSpacing: clamp(input.letterSpacing, -3, 4, -1.2),
      highlightWords: String(input.highlightWords || '').slice(0, 500),
      imageX: clamp(input.imageX, 0, 100, 50),
      imageY: clamp(input.imageY, 0, 100, 50),
      overlayStart: clamp(input.overlayStart, 0, 90, 48),
      overlayStrength: clamp(input.overlayStrength, 0, 100, 92),
      ruleEnabled: input.ruleEnabled !== false,
      ruleWidth: clamp(input.ruleWidth, 40, 700, 246),
      ruleHeight: clamp(input.ruleHeight, 2, 18, 9),
      ruleGap: clamp(input.ruleGap, 4, 80, 28),
      logoEnabled: Boolean(input.logoEnabled),
      logoX: clamp(input.logoX, 0, 950, 65),
      logoY: clamp(input.logoY, 0, 1250, 55),
      logoWidth: clamp(input.logoWidth, 40, 500, 180),
      logoOpacity: clamp(input.logoOpacity, 20, 100, 100),
      footerEnabled: input.footerEnabled !== false,
      footerBottom: clamp(input.footerBottom, 10, 220, 65),
      footerFontSize: clamp(input.footerFontSize, 12, 28, 19),
      footerInstagram1: String(input.footerInstagram1 || '@alvesbuenoo').slice(0, 60),
      footerInstagram2: String(input.footerInstagram2 || '@centralgoiano').slice(0, 60),
      footerWebsite: String(input.footerWebsite || 'www.centralgoiano.com.br').slice(0, 100),
      socialItems: Array.isArray(input.socialItems) ? input.socialItems.slice(0, 3).map(item => ({
        type: ['instagram', 'facebook', 'youtube', 'tiktok', 'x', 'threads', 'globe'].includes(String(item?.type || '').toLowerCase()) ? String(item.type).toLowerCase() : 'globe',
        label: String(item?.label || '').trim().slice(0, 80),
        enabled: item?.enabled !== false
      })).filter(item => item.label) : [],
      footerLines: input.footerLines !== false,
      footerInstagram1Enabled: input.footerInstagram1Enabled !== false,
      footerInstagram2Enabled: input.footerInstagram2Enabled !== false,
      footerWebsiteEnabled: input.footerWebsiteEnabled !== false,
      subtitleFontSize: clamp(input.subtitleFontSize, 16, 42, 27),
      subtitleColor: safeColor(input.subtitleColor, '#ffffff'),
      backgroundColor: safeColor(input.backgroundColor, '#050505')
    };
  }

  function highlightedTitleHtml(title, keywords, accentColor) {
    const safeTitle = String(title || '').toLocaleUpperCase('pt-BR');
    const wordList = String(keywords || '')
      .split(',')
      .map(word => word.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (!wordList.length) return escapeHtml(safeTitle);

    const escapedParts = wordList
      .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .filter(Boolean);
    if (!escapedParts.length) return escapeHtml(safeTitle);

    const regex = new RegExp(`(${escapedParts.join('|')})`, 'giu');
    let output = '';
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(safeTitle)) !== null) {
      output += escapeHtml(safeTitle.slice(lastIndex, match.index));
      output += `<span style="color:${accentColor}">${escapeHtml(match[0])}</span>`;
      lastIndex = match.index + match[0].length;
      if (match[0].length === 0) regex.lastIndex++;
    }
    output += escapeHtml(safeTitle.slice(lastIndex));
    return output;
  }

  function socialSvg() {
    return '<svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><rect x="3.5" y="3.5" width="33" height="33" rx="9" stroke="currentColor" stroke-width="3"/><circle cx="20" cy="20" r="8" stroke="currentColor" stroke-width="3"/><circle cx="29.5" cy="10.8" r="2" fill="currentColor"/></svg>';
  }

  function globeSvg() {
    return '<svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle cx="20" cy="20" r="16" stroke="currentColor" stroke-width="2.8"/><ellipse cx="20" cy="20" rx="7" ry="16" stroke="currentColor" stroke-width="2.4"/><path d="M5 14h30M5 26h30M4 20h32" stroke="currentColor" stroke-width="2.2"/></svg>';
  }

  function socialSvgFor(type) {
    if (type === 'instagram') return socialSvg();
    if (type === 'globe' || type === 'threads') return globeSvg();
    if (type === 'facebook') return '<svg viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="17" stroke="currentColor" stroke-width="2.6"/><path d="M23 34V22h4l.7-5H23v-3.2c0-1.5.5-2.5 2.6-2.5H28V7c-.8-.1-2.2-.3-4-.3-4 0-6.7 2.4-6.7 7V17h-4v5h4v12" fill="currentColor"/></svg>';
    if (type === 'youtube') return '<svg viewBox="0 0 40 40" fill="none"><rect x="3" y="8" width="34" height="24" rx="7" stroke="currentColor" stroke-width="2.8"/><path d="M17 14v12l10-6z" fill="currentColor"/></svg>';
    if (type === 'tiktok') return '<svg viewBox="0 0 40 40" fill="none"><path d="M23 5v20.5a7 7 0 1 1-6-6.9v5.5a2 2 0 1 0 .8 1.6V5h5.2c.5 4 2.8 6.6 7 7.4v5.3c-2.8-.3-5.1-1.2-7-2.8" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg>';
    if (type === 'x') return '<svg viewBox="0 0 40 40" fill="none"><path d="M7 5h8.5l17.5 30h-8.5L7 5zm0 30L31 5" stroke="currentColor" stroke-width="3.2"/></svg>';
    return globeSvg();
  }

  function buildCardHtml(payload, override = {}) {
    const design = sanitizeDesign(override.design || payload.design || {});
    const imageData = safeDataImage(payload.imageData || payload.imagemBase64, 'foto principal');
    const logoData = safeOptionalDataImage(payload.logoData || '');
    const title = String(payload.title || payload.titulo || '').trim().slice(0, 500);
    const subtitle = String(payload.subtitle || payload.subtitulo || '').trim().slice(0, 1200);
    if (!title) throw new Error('Digite a manchete antes de gerar a arte.');

    const titleHtml = highlightedTitleHtml(title, design.highlightWords, design.accentColor);
    const showLogo = design.logoEnabled && Boolean(logoData);
    const widthPct = design.titleWidth;
    const leftPct = clamp(design.titleX - widthPct / 2, 0, 100 - widthPct, 4);
    const imageCss = `object-position:${design.imageX}% ${design.imageY}%;`;
    const footerItems = [];
    if (design.footerInstagram1Enabled && design.footerInstagram1.trim()) {
      footerItems.push(`<div class="footer-item">${socialSvg()}<span>${escapeHtml(design.footerInstagram1)}</span></div>`);
    }
    if (design.footerInstagram2Enabled && design.footerInstagram2.trim()) {
      footerItems.push(`<div class="footer-item">${socialSvg()}<span>${escapeHtml(design.footerInstagram2)}</span></div>`);
    }
    if (design.footerWebsiteEnabled && design.footerWebsite.trim()) {
      footerItems.push(`<div class="footer-item footer-website">${globeSvg()}<span>${escapeHtml(design.footerWebsite)}</span></div>`);
    }
    for (const item of (design.socialItems || [])) {
      if (item.enabled && item.label) {
        footerItems.push(`<div class="footer-item">${socialSvgFor(item.type)}<span>${escapeHtml(item.label)}</span></div>`);
      }
    }
    const dividers = footerItems.map((item, index) => index < footerItems.length - 1
      ? `${item}<div class="footer-divider"></div>` : item).join('');
    const rule = design.ruleEnabled
      ? `<div class="red-rule" style="width:${design.ruleWidth}px;height:${design.ruleHeight}px;margin-bottom:${design.ruleGap}px;background:${design.accentColor};"></div>`
      : '';
    const subtitleHtml = subtitle
      ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : '';
    const logoHtml = showLogo
      ? `<img class="logo" src="${logoData}" style="left:${design.logoX}px;top:${design.logoY}px;width:${design.logoWidth}px;opacity:${design.logoOpacity / 100};" />`
      : '';
    const footerHtml = design.footerEnabled
      ? `<footer class="footer" style="bottom:${design.footerBottom}px;font-size:${design.footerFontSize}px;">${design.footerLines ? `<span class="footer-line" style="background:${design.accentColor};"></span>` : ''}<div class="footer-items">${dividers}</div>${design.footerLines ? `<span class="footer-line" style="background:${design.accentColor};"></span>` : ''}</footer>`
      : '';

    return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=1080, initial-scale=1.0"><link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800;900&family=Roboto:wght@400;500;700;900&display=swap" rel="stylesheet"><style>
      *{box-sizing:border-box;margin:0;padding:0}html,body{width:1080px;height:1350px;overflow:hidden;background:${design.backgroundColor}}body{font-family:'${design.fontFamily}',Arial,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}#card{position:relative;width:1080px;height:1350px;overflow:hidden;background:${design.backgroundColor};color:#fff}.photo-wrap{position:absolute;inset:0;z-index:1;background:${design.backgroundColor}}.photo-wrap img{display:block;width:100%;height:100%;object-fit:cover;${imageCss}}.shade{position:absolute;inset:0;z-index:2;background:linear-gradient(180deg,rgba(0,0,0,.04) 0%,rgba(0,0,0,.08) ${design.overlayStart}%,rgba(0,0,0,${design.overlayStrength / 100}) 100%)}.logo{position:absolute;z-index:8;height:auto;object-fit:contain;filter:drop-shadow(0 3px 6px rgba(0,0,0,.35))}.headline-zone{position:absolute;z-index:5;left:${leftPct}%;bottom:${design.titleBottom}px;width:${widthPct}%;display:flex;flex-direction:column;align-items:${design.titleAlign === 'left' ? 'flex-start' : design.titleAlign === 'right' ? 'flex-end' : 'center'}}.title{width:100%;color:${design.titleColor};font-size:${design.fontSize}px;font-weight:${design.titleWeight};line-height:${design.lineHeight};letter-spacing:${design.letterSpacing}px;text-align:${design.titleAlign};text-transform:uppercase;overflow-wrap:break-word;word-break:normal;text-shadow:0 2px 6px rgba(0,0,0,.15)}.subtitle{width:100%;margin-top:18px;color:${design.subtitleColor};font-size:${design.subtitleFontSize}px;font-weight:600;line-height:1.24;text-align:${design.titleAlign};white-space:pre-wrap;overflow-wrap:break-word}.red-rule{flex:0 0 auto}.footer{position:absolute;z-index:7;left:0;width:1080px;padding:0 42px;display:flex;align-items:center;justify-content:space-between;gap:10px;color:#fff;white-space:nowrap}.footer-line{height:5px;width:64px;flex:0 0 64px}.footer-items{display:flex;align-items:center;justify-content:center;gap:16px;min-width:0;flex:1}.footer-item{display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:0 1 auto;color:#fff;font-size:1em;font-weight:600;line-height:1;letter-spacing:-.35px;min-width:0}.footer-item span{overflow:hidden;text-overflow:ellipsis;max-width:340px}.footer-item svg{display:block;width:34px;height:34px;flex:0 0 34px;color:#fff}.footer-divider{width:2px;height:35px;flex:0 0 2px;background:rgba(255,255,255,.9)}.footer-website{letter-spacing:-.55px}
      </style></head><body><div id="card"><div class="photo-wrap"><img id="background-image" src="${imageData}" /></div><div class="shade"></div>${logoHtml}<main class="headline-zone">${rule}<h1 class="title">${titleHtml}</h1>${subtitleHtml}</main>${footerHtml}</div><script>document.fonts.ready.then(()=>{const t=document.querySelector('.title');if(!t)return;let s=${design.fontSize};while(s>32&&t.scrollHeight>500){s--;t.style.fontSize=s+'px';}}).catch(()=>{});</script></body></html>`;
  }

  async function launchBrowser() {
    const executablePath = await chromium.executablePath();
    return puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      defaultViewport: { width: 1080, height: 1350, deviceScaleFactor: 1 },
      executablePath,
      headless: chromium.headless
    });
  }

  async function screenshotPayload(payload, type = 'jpeg', browserExisting = null) {
    const ownsBrowser = !browserExisting;
    const browser = browserExisting || await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 1 });
      await page.setContent(buildCardHtml(payload), { waitUntil: 'domcontentloaded', timeout: 25000 });
      try {
        await page.waitForFunction(() => {
          const img = document.getElementById('background-image');
          return img && img.complete && img.naturalWidth > 0;
        }, { timeout: 10000 });
      } catch (_) {
        throw new Error('A foto não carregou. Selecione a imagem novamente e tente gerar a prévia.');
      }
      try {
        await page.evaluate(() => document.fonts.ready);
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 150));
      const buffer = type === 'png'
        ? await page.screenshot({ type: 'png' })
        : await page.screenshot({ type: 'jpeg', quality: 91 });
      await page.close();
      return buffer;
    } finally {
      if (ownsBrowser) await browser.close();
    }
  }

  async function screenshotSlides(slides, design, logoData = '') {
    if (!Array.isArray(slides) || slides.length < MIN_SLIDES || slides.length > MAX_SLIDES) {
      throw new Error(`O carrossel precisa ter de ${MIN_SLIDES} a ${MAX_SLIDES} slides.`);
    }
    const browser = await launchBrowser();
    const images = [];
    try {
      for (let i = 0; i < slides.length; i++) {
        const slide = slides[i] || {};
        const payload = {
          title: slide.title || slide.titulo || `Slide ${i + 1}`,
          subtitle: slide.body || slide.subtitulo || '',
          imageData: slide.imageData,
          logoData,
          design: { ...design, highlightWords: slide.highlightWords || design.highlightWords }
        };
        const buffer = await screenshotPayload(payload, 'jpeg', browser);
        images.push(buffer);
      }
    } finally {
      await browser.close();
    }
    return images;
  }

  async function callGemini(parts, promptText) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY não está configurada neste Render.');

    const listResponse = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const listData = await listResponse.json().catch(() => ({}));
    if (!listResponse.ok) {
      throw new Error(listData.error?.message || 'Não foi possível consultar os modelos Gemini.');
    }

    const models = (listData.models || [])
      .filter(model => (model.supportedGenerationMethods || []).includes('generateContent'))
      .map(model => String(model.name || '').replace(/^models\//, ''))
      .filter(name => /^gemini-/i.test(name) && !/(embedding|tts|live|robotics|aqa)/i.test(name));

    const preference = models.sort((a, b) => {
      const score = name => {
        if (/2\.5-flash/i.test(name)) return 0;
        if (/2\.0-flash/i.test(name)) return 1;
        if (/flash/i.test(name) && !/(preview|experimental)/i.test(name)) return 2;
        if (/pro/i.test(name) && !/(preview|experimental)/i.test(name)) return 3;
        return 4;
      };
      return score(a) - score(b) || a.localeCompare(b);
    }).slice(0, 8);

    let lastError = '';
    for (const model of preference) {
      try {
        const response = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [...parts, { text: promptText }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 2500 }
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          lastError = data.error?.message || `Gemini HTTP ${response.status}`;
          continue;
        }
        const text = (data.candidates?.[0]?.content?.parts || [])
          .map(part => typeof part.text === 'string' ? part.text : '')
          .filter(Boolean).join('\n').trim();
        if (text) return text;
      } catch (error) {
        lastError = error.message;
      }
    }
    throw new Error(lastError || 'Nenhum modelo Gemini disponível conseguiu analisar a imagem.');
  }

  function parseModelJson(raw) {
    const text = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(text); } catch (_) {}
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch (_) {}
    }
    throw new Error('A IA respondeu em formato inesperado. Tente enviar um print mais nítido.');
  }

  function readImageParts(images) {
    return images.map((dataUrl, index) => {
      const safe = safeDataImage(dataUrl, `imagem ${index + 1}`);
      const match = safe.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
      return { inlineData: { mimeType: match[1], data: match[2] } };
    });
  }

  function graphError(data, status) {
    return data?.error?.message || `A Meta recusou a solicitação (HTTP ${status}).`;
  }

  async function graphPost(url, params) {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error || !data.id) {
      throw new Error(graphError(data, response.status));
    }
    return data;
  }

  async function waitForContainer(containerId, token) {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(containerId)}?fields=status_code,status&access_token=${encodeURIComponent(token)}`;
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await fetchFn(url);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(graphError(data, response.status));
      const status = String(data.status_code || '').toUpperCase();
      if (status === 'FINISHED' || status === 'PUBLISHED') return;
      if (status === 'ERROR' || status === 'EXPIRED') {
        throw new Error(data.status || `A Meta informou que o contêiner ficou ${status}.`);
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    // Contêineres de imagem podem não retornar status_code em todas as configurações.
    // Deixamos a etapa de publicação validar o resultado final.
  }

  async function preparePublishedJpeg(req, payload) {
    const buffer = await screenshotPayload(payload, 'jpeg');
    const fileName = `studio-editor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    fs.writeFileSync(path.join('/tmp', fileName), buffer);
    const host = String(req.get('host') || '').replace(/[^a-z0-9.:-]/gi, '');
    if (!host) throw new Error('Não foi possível identificar o endereço público do Render.');
    return { fileName, imageUrl: `https://${host}/temp/${fileName}` };
  }

  async function buildCaption(title, text, customCaption) {
    const typed = String(customCaption || '').trim();
    if (typed) return typed.slice(0, 2200);

    const key = process.env.GEMINI_API_KEY;
    if (key && typeof gerarLegendaGeminiOficial === 'function') {
      const generated = await gerarLegendaGeminiOficial(
        String(title || '').trim(),
        String(text || title || '').trim(),
        key
      );
      if (generated && generated.length > 20) return generated.slice(0, 2200);
    }
    const clean = typeof limparTextoLixo === 'function'
      ? limparTextoLixo(text || title || '') : String(text || title || '');
    return `${String(title || '').trim()}\n\n${String(clean).substring(0, 350)}\n\nPara mais informações, acesse: www.centralgoiano.com.br\n\nTem uma informação ou vídeo exclusivo? Envie para o Central Goiano pelo WhatsApp (64) 9 8179-1016.\n\n#CentralGoiano #Noticias`.slice(0, 2200);
  }

  function requireInstagramCredentials(profile = 'padrao') {
    // O perfil é escolhido no seletor Destino Insta do modal.
    // Nunca recebemos tokens do navegador: as credenciais ficam no Environment do Render.
    const normalized = String(profile || 'padrao').trim().toLowerCase();
    let token;
    let userId;

    if (normalized === 'padrao') {
      token = process.env.CGN_PADRAO_INSTAGRAM_ACCESS_TOKEN;
      userId = process.env.CGN_PADRAO_INSTAGRAM_ACCOUNT_ID;
      if (!token || !userId) {
        throw new Error('Para publicar pelo destino Padrão CGN usando o editor novo, configure CGN_PADRAO_INSTAGRAM_ACCESS_TOKEN e CGN_PADRAO_INSTAGRAM_ACCOUNT_ID no Render studio-card. Copie os valores do perfil padrão diretamente do Environment do Render antigo; não envie os tokens pelo chat.');
      }
    } else if (normalized === 'studio') {
      token = process.env.INSTAGRAM_ACCESS_TOKEN;
      userId = process.env.INSTAGRAM_ACCOUNT_ID;
      if (!token || !userId) {
        throw new Error('Configure INSTAGRAM_ACCESS_TOKEN e INSTAGRAM_ACCOUNT_ID para o perfil Studio Card no Environment deste Render.');
      }
    } else {
      throw new Error('Destino Instagram desconhecido. Selecione Padrão CGN ou Studio Card no botão Destino Insta.');
    }

    return { token, userId };
  }

  app.get('/editor', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'editor.html'));
  });

  app.get('/editor/health', (req, res) => {
    res.json({ success: true, service: 'studio-card-editor', graphVersion: GRAPH_VERSION });
  });

  app.post('/editor/api/analyze-reference', async (req, res) => {
    try {
      const image = safeDataImage(req.body?.imageData, 'print de referência');
      const parts = readImageParts([image]);
      const raw = await callGemini(parts,
        'Analise a referência visual enviada para servir como modelo de design de uma arte jornalística Instagram 1080x1350. Não copie dados pessoais da imagem. Identifique somente a estrutura visual: composição, alinhamento, tamanho relativo do título, cores, degradê, posição de logo, linha decorativa e rodapé. Retorne SOMENTE JSON válido com esta estrutura: {"detectedHeadline":"texto exato da manchete se legível, senão vazio","highlightWords":"palavras que aparecem em cor de destaque, separadas por vírgula","design":{"accentColor":"#f3132b","titleColor":"#ffffff","fontFamily":"Montserrat","fontSize":68,"titleBottom":166,"titleWidth":92,"titleX":50,"titleAlign":"center","lineHeight":1.075,"titleWeight":900,"letterSpacing":-1.2,"highlightWords":"","imageX":50,"imageY":50,"overlayStart":48,"overlayStrength":92,"ruleEnabled":true,"ruleWidth":246,"ruleHeight":9,"ruleGap":28,"logoEnabled":false,"logoX":65,"logoY":55,"logoWidth":180,"logoOpacity":100,"footerEnabled":true,"footerBottom":65,"footerFontSize":19,"footerLines":true,"footerInstagram1Enabled":true,"footerInstagram2Enabled":true,"footerWebsiteEnabled":true,"subtitleFontSize":27,"subtitleColor":"#ffffff","backgroundColor":"#050505"}}. Use valores numéricos aproximados. Não invente elementos que não estejam na referência. Use somente propriedades presentes no esquema.');
      const parsed = parseModelJson(raw);
      const design = sanitizeDesign({ ...(parsed.design || {}), highlightWords: parsed.highlightWords || parsed.design?.highlightWords });
      res.json({ success: true, detectedHeadline: String(parsed.detectedHeadline || '').slice(0, 500), design });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message || 'Falha ao analisar a referência.' });
    }
  });

  app.post('/editor/api/analyze-carousel', async (req, res) => {
    try {
      const images = Array.isArray(req.body?.images) ? req.body.images.slice(0, MAX_SLIDES) : [];
      if (images.length < 1) throw new Error('Envie pelo menos um print para montar um carrossel.');
      const parts = readImageParts(images);
      const raw = await callGemini(parts,
        `Leia os ${images.length} prints de notícia na ordem enviada. Extraia apenas informações legíveis, sem inventar fatos. Se houver 2 ou mais prints, organize um carrossel de 2 a 10 slides preservando a sequência útil. Se houver apenas 1 print, crie de 3 a 5 slides curtos a partir de aspectos diferentes explicitamente presentes nessa mesma notícia: capa, fato principal e detalhes/serviços que realmente apareçam no print. Não repita a mesma frase para completar slides e não crie fatos novos; se houver poucos dados, produza o menor número de slides que faça sentido (mínimo 2). Português do Brasil, tom jornalístico. Cada slide deve ter manchete de até 90 caracteres, texto de 1 ou 2 frases (até 240 caracteres) e até 3 palavras para destaque em vermelho. Retorne SOMENTE JSON válido: {"slides":[{"title":"","body":"","highlightWords":"PALAVRA1, PALAVRA2"}]}. Se faltar informação, use somente o que estiver legível e não complete com suposições.`);
      const parsed = parseModelJson(raw);
      const slides = Array.isArray(parsed.slides) ? parsed.slides.slice(0, MAX_SLIDES).map((slide, index) => ({
        title: String(slide.title || `Notícia ${index + 1}`).trim().slice(0, 160),
        body: String(slide.body || '').trim().slice(0, 600),
        highlightWords: String(slide.highlightWords || '').slice(0, 200),
        order: index + 1
      })) : [];
      if (slides.length < MIN_SLIDES) throw new Error('A IA não conseguiu separar os prints em pelo menos dois slides. Tente imagens mais legíveis.');
      res.json({ success: true, slides });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message || 'Falha ao analisar os prints.' });
    }
  });

  app.post('/editor/api/render', async (req, res) => {
    try {
      const payload = {
        title: req.body?.title,
        subtitle: req.body?.subtitle,
        imageData: req.body?.imageData,
        logoData: req.body?.logoData,
        design: sanitizeDesign(req.body?.design || {})
      };
      const buffer = await screenshotPayload(payload, 'jpeg');
      res.json({ success: true, imageData: `data:image/jpeg;base64,${buffer.toString('base64')}`, width: 1080, height: 1350 });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message || 'Falha ao gerar prévia.' });
    }
  });

  app.post('/editor/api/render-carousel', async (req, res) => {
    try {
      const design = sanitizeDesign(req.body?.design || {});
      const logoData = safeOptionalDataImage(req.body?.logoData || '');
      const slides = Array.isArray(req.body?.slides) ? req.body.slides.slice(0, MAX_SLIDES) : [];
      const rendered = await screenshotSlides(slides, design, logoData);
      res.json({ success: true, images: rendered.map(buffer => `data:image/jpeg;base64,${buffer.toString('base64')}`), count: rendered.length });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message || 'Falha ao gerar prévias do carrossel.' });
    }
  });

  app.post('/editor/api/publish', async (req, res) => {
    try {
      const { token, userId } = requireInstagramCredentials(req.body?.profile);
      const payload = {
        title: req.body?.title,
        subtitle: req.body?.subtitle,
        imageData: req.body?.imageData,
        logoData: req.body?.logoData,
        design: sanitizeDesign(req.body?.design || {})
      };
      const { imageUrl } = await preparePublishedJpeg(req, payload);
      const caption = await buildCaption(payload.title, req.body?.captionText || payload.subtitle, req.body?.caption);
      const graphBase = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(userId)}`;
      const creation = await graphPost(`${graphBase}/media`, {
        image_url: imageUrl,
        caption,
        access_token: token
      });
      await waitForContainer(creation.id, token);
      const published = await graphPost(`${graphBase}/media_publish`, {
        creation_id: creation.id,
        access_token: token
      });
      res.json({ success: true, message: 'Arte publicada no Instagram.', mediaId: published.id, previewUrl: imageUrl });
    } catch (error) {
      res.status(502).json({ success: false, error: error.message || 'Falha ao publicar a arte.' });
    }
  });

  app.post('/editor/api/publish-carousel', async (req, res) => {
    try {
      const { token, userId } = requireInstagramCredentials(req.body?.profile);
      const design = sanitizeDesign(req.body?.design || {});
      const logoData = safeOptionalDataImage(req.body?.logoData || '');
      const slides = Array.isArray(req.body?.slides) ? req.body.slides.slice(0, MAX_SLIDES) : [];
      if (slides.length < MIN_SLIDES || slides.length > MAX_SLIDES) {
        throw new Error(`O carrossel precisa ter de ${MIN_SLIDES} a ${MAX_SLIDES} slides.`);
      }
      const buffers = await screenshotSlides(slides, design, logoData);
      const host = String(req.get('host') || '').replace(/[^a-z0-9.:-]/gi, '');
      if (!host) throw new Error('Não foi possível identificar o endereço público do Render.');
      const urls = [];
      for (let i = 0; i < buffers.length; i++) {
        const fileName = `studio-carousel-${Date.now()}-${i + 1}-${Math.random().toString(36).slice(2, 7)}.jpg`;
        fs.writeFileSync(path.join('/tmp', fileName), buffers[i]);
        urls.push(`https://${host}/temp/${fileName}`);
      }

      const graphBase = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(userId)}`;
      const children = [];
      for (const imageUrl of urls) {
        const item = await graphPost(`${graphBase}/media`, {
          image_url: imageUrl,
          is_carousel_item: 'true',
          access_token: token
        });
        children.push(item.id);
        await waitForContainer(item.id, token);
      }

      const allText = slides.map((slide, index) => `Slide ${index + 1}: ${slide.title || ''}\n${slide.body || ''}`).join('\n\n');
      const caption = await buildCaption(slides[0]?.title || 'Central Goiano', allText, req.body?.caption);
      const carousel = await graphPost(`${graphBase}/media`, {
        media_type: 'CAROUSEL',
        children: children.join(','),
        caption,
        access_token: token
      });
      await waitForContainer(carousel.id, token);
      const published = await graphPost(`${graphBase}/media_publish`, {
        creation_id: carousel.id,
        access_token: token
      });
      res.json({ success: true, message: 'Carrossel publicado no Instagram.', mediaId: published.id, count: urls.length });
    } catch (error) {
      res.status(502).json({ success: false, error: error.message || 'Falha ao publicar o carrossel.' });
    }
  });
};
