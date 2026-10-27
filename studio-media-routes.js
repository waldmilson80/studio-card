'use strict';

/**
 * Novas funções isoladas do Studio Card: leitura de prints como conteúdo,
 * transcrição/criação de Reels, renderização FFmpeg e publicação de Reels.
 * Não altera as rotas antigas /gerar-card, Blogger, raspagem ou correções.
 */
module.exports = function registerStudioMediaRoutes(app, deps) {
  const { fetch: fetchFn, fs, path } = deps;
  const multer = require('multer');
  const { spawn } = require('child_process');
  const ffmpegPath = require('ffmpeg-static');
  const GRAPH_VERSION = String(process.env.META_GRAPH_VERSION || 'v26.0');
  const uploadDir = '/tmp/studio-card-uploads';
  fs.mkdirSync(uploadDir, { recursive: true });

  const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 250 * 1024 * 1024, files: 4, fields: 30 }
  });

  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  function parseJson(raw) {
    const text = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(text); } catch (_) {}
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch (_) {}
    }
    throw new Error('A IA devolveu um formato inesperado. Tente uma imagem mais legível.');
  }

  function imagePart(dataUrl, index) {
    const value = String(dataUrl || '').trim();
    const match = value.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-z0-9+/=\r\n]+)$/i);
    if (!match) throw new Error(`A imagem ${index + 1} não está em um formato válido.`);
    return { inlineData: { mimeType: match[1].toLowerCase().replace('image/jpg', 'image/jpeg'), data: match[2] } };
  }

  async function gemini(parts, instruction, maxOutputTokens = 1800) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY não está configurada no Render studio-card.');
    const listResponse = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
    const list = await listResponse.json().catch(() => ({}));
    if (!listResponse.ok) throw new Error(list.error?.message || 'Não foi possível consultar os modelos Gemini.');
    const available = (list.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''))
      .filter(name => /^gemini-/i.test(name) && !/(embedding|tts|live|robotics|aqa)/i.test(name));
    const score = name => /2\.5-flash/i.test(name) ? 0 : /2\.0-flash/i.test(name) ? 1 : /flash/i.test(name) && !/(preview|experimental)/i.test(name) ? 2 : /pro/i.test(name) && !/(preview|experimental)/i.test(name) ? 3 : 4;
    const models = available.sort((a, b) => score(a) - score(b) || a.localeCompare(b)).slice(0, 8);
    if (!models.length) throw new Error('A chave Gemini não retornou um modelo compatível com generateContent.');
    let lastError = '';
    for (const model of models) {
      try {
        const response = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [...parts, { text: instruction }] }],
            generationConfig: { temperature: 0.15, maxOutputTokens }
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) { lastError = data.error?.message || `Gemini HTTP ${response.status}`; continue; }
        const answer = (data.candidates?.[0]?.content?.parts || []).map(p => typeof p.text === 'string' ? p.text : '').filter(Boolean).join('\n').trim();
        if (answer) return answer;
        lastError = 'Gemini retornou uma resposta vazia.';
      } catch (error) { lastError = error.message; }
    }
    throw new Error(lastError || 'Nenhum modelo Gemini conseguiu processar o pedido.');
  }

  app.post('/editor/api/draft-text', async (req, res) => {
    try {
      const title = String(req.body?.title || '').trim().slice(0, 500);
      const subtitle = String(req.body?.subtitle || '').trim().slice(0, 1200);
      const body = String(req.body?.body || '').trim().slice(0, 12000);
      const theme = String(req.body?.theme || '').trim().slice(0, 500);
      if (!title && !subtitle && !body && !theme) throw new Error('Preencha o tema ou o texto da notícia antes de chamar a IA.');
      const raw = await gemini([{ text: `Tema informado: ${theme}\nTítulo informado: ${title}\nLinha fina informada: ${subtitle}\nTexto de referência factual:\n${body}` }],
        'Você é editor jornalístico do Central Goiano. Melhore o título e a linha fina e prepare uma legenda para Instagram com base SOMENTE nos dados fornecidos. Não invente informações, nomes, datas, quantidades, causa de acidente ou declarações. Se faltarem detalhes, use formulação neutra. Português do Brasil, tom jornalístico, sem emojis. A legenda termina exatamente com: Para mais informações, acesse: www.centralgoiano.com.br\n\nTem uma informação ou vídeo exclusivo? Envie para o Central Goiano pelo WhatsApp (64) 9 8179-1016.\n\n#CentralGoiano #Noticias e mais duas hashtags temáticas. Retorne SOMENTE JSON válido: {"theme":"...","title":"até 110 caracteres","subtitle":"até 180 caracteres","body":"resumo de 2 a 4 parágrafos curtos","caption":"legenda completa","highlightWords":"até três termos separados por vírgulas"}.', 2200);
      const d = parseJson(raw);
      res.json({ success: true, theme: String(d.theme || theme).slice(0, 500), title: String(d.title || title).slice(0, 220), subtitle: String(d.subtitle || subtitle).slice(0, 500), body: String(d.body || body).slice(0, 5000), caption: String(d.caption || '').slice(0, 2200), highlightWords: String(d.highlightWords || '').slice(0, 300) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message || 'Não foi possível preparar o texto com a IA.' });
    }
  });

  // ESTE endpoint interpreta imagens como fonte de notícia. Prints de estilo devem
  // ser enviados ao endpoint /analyze-reference, nunca a este endpoint.
  app.post('/editor/api/analyze-news', async (req, res) => {
    try {
      const images = Array.isArray(req.body?.images) ? req.body.images.slice(0, 10) : [];
      if (!images.length) throw new Error('Envie pelo menos um print com o conteúdo da notícia.');
      const parts = images.map(imagePart);
      const raw = await gemini(parts,
        `Você é editor jornalístico do portal Central Goiano. LEIA SOMENTE o conteúdo noticioso legível nas imagens enviadas. Extraia fatos e informações que estejam realmente presentes, sem completar lacunas com suposições. Se a imagem for um card com texto, use os dados factuais visíveis como fonte de notícia; o estilo gráfico não interessa nesta tarefa. Crie um rascunho jornalístico curto em português do Brasil. Retorne SOMENTE JSON válido com o formato: {"theme":"tema factual em uma frase","title":"manchete objetiva com até 110 caracteres","subtitle":"linha fina com até 180 caracteres","body":"resumo informativo em 2 a 4 parágrafos curtos","caption":"legenda de Instagram em parágrafos, seguida exatamente por Para mais informações, acesse: www.centralgoiano.com.br, uma linha em branco, Tem uma informação ou vídeo exclusivo? Envie para o Central Goiano pelo WhatsApp (64) 9 8179-1016., uma linha em branco e #CentralGoiano #Noticias mais duas hashtags específicas","highlightWords":"até três palavras separadas por vírgulas"}. Não copie manchetes longas de maneira mecânica; reescreva com linguagem jornalística. Não invente nomes, datas, números, feridos, causas ou locais ausentes. Se não houver notícia legível, explique isso no campo theme e mantenha os demais campos modestos, sem inventar fatos.`, 2200);
      const data = parseJson(raw);
      res.json({ success: true,
        theme: String(data.theme || '').slice(0, 500),
        title: String(data.title || '').slice(0, 220),
        subtitle: String(data.subtitle || '').slice(0, 500),
        body: String(data.body || '').slice(0, 5000),
        caption: String(data.caption || '').slice(0, 2200),
        highlightWords: String(data.highlightWords || '').slice(0, 300)
      });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message || 'Não foi possível ler o print.' });
    }
  });

  function runFfmpeg(args, timeoutMs = 8 * 60 * 1000) {
    return new Promise((resolve, reject) => {
      if (!ffmpegPath) return reject(new Error('O pacote ffmpeg-static não encontrou o binário do FFmpeg.'));
      let stderr = '';
      const child = spawn(ffmpegPath, ['-hide_banner', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('O processamento do vídeo excedeu o limite de tempo. Tente um vídeo mais curto.'));
      }, timeoutMs);
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('close', code => {
        clearTimeout(timeout);
        if (code === 0) return resolve({ stderr });
        reject(new Error(`FFmpeg não conseguiu processar o arquivo. ${stderr.slice(-1800)}`));
      });
    });
  }

  function probeMedia(filePath) {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
      child.on('error', reject);
      child.on('close', () => {
        const match = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
        const duration = match ? (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) : 0;
        const videoMatch = stderr.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/i);
        resolve({ duration, hasAudio: /Stream #\d+:\d+[^\n]*Audio:/i.test(stderr), width: videoMatch ? Number(videoMatch[1]) : 0, height: videoMatch ? Number(videoMatch[2]) : 0, details: stderr.slice(-2500) });
      });
    });
  }

  function safeUploadName(file) { return file && typeof file.path === 'string' && file.path.startsWith(uploadDir); }
  function cleanUploaded(files) {
    for (const file of files || []) {
      if (safeUploadName(file)) { try { fs.unlinkSync(file.path); } catch (_) {} }
    }
  }

  function addVideoNormalization(args, file, start, duration, overlay, opts, mainOut) {
    // Função mantida como documentação da composição; a rota compõe o grafo abaixo.
    return { file, start, duration, overlay, opts, mainOut };
  }

  app.post('/editor/api/video/analyze', upload.single('video'), async (req, res) => {
    const files = req.file ? [req.file] : [];
    let audioPath = '';
    try {
      const video = req.file;
      if (!video) throw new Error('Selecione um vídeo primeiro.');
      const info = await probeMedia(video.path);
      if (!info.duration) throw new Error('Não consegui ler a duração do vídeo. Tente MP4 ou MOV.');
      if (info.duration > 900) throw new Error('Para transcrição automática, use vídeos de até 15 minutos.');
      audioPath = path.join(uploadDir, `audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);
      await runFfmpeg(['-y', '-i', video.path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-t', '900', audioPath]);
      const stat = fs.statSync(audioPath);
      if (stat.size > 18 * 1024 * 1024) throw new Error('O áudio convertido ficou grande demais para a análise. Recorte um trecho menor do vídeo.');
      const audioBase64 = fs.readFileSync(audioPath).toString('base64');
      const transcriptRaw = await gemini([{ inlineData: { mimeType: 'audio/mpeg', data: audioBase64 } }],
        'Transcreva fielmente o áudio em português do Brasil. Preserve nomes, lugares, números e frases audíveis. Não invente partes inaudíveis. Devolva somente a transcrição, sem introdução.', 5000);
      const transcript = transcriptRaw.trim().slice(0, 25000);
      const draftRaw = await gemini([{ text: `TRANSCRIÇÃO DO VÍDEO:\n${transcript}` }],
        'Com base somente nesta transcrição, crie um título curto para um Reels jornalístico e uma legenda de Instagram em português do Brasil. Não invente fatos. A legenda deve ser editável e incluir, no final, exatamente: Para mais informações, acesse: www.centralgoiano.com.br\n\nTem uma informação ou vídeo exclusivo? Envie para o Central Goiano pelo WhatsApp (64) 9 8179-1016.\n\n#CentralGoiano #Noticias e duas hashtags temáticas. Retorne SOMENTE JSON válido: {"title":"...","caption":"...","theme":"..."}.', 1800);
      const draft = parseJson(draftRaw);
      res.json({ success: true, duration: info.duration, transcript,
        title: String(draft.title || '').slice(0, 220),
        caption: String(draft.caption || '').slice(0, 2200),
        theme: String(draft.theme || '').slice(0, 500)
      });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message || 'Falha ao transcrever o vídeo.' });
    } finally {
      cleanUploaded(files);
      if (audioPath) { try { fs.unlinkSync(audioPath); } catch (_) {} }
    }
  });

  app.post('/editor/api/video/render', upload.fields([
    { name: 'video', maxCount: 1 }, { name: 'overlay', maxCount: 1 },
    { name: 'overlay2', maxCount: 1 }, { name: 'ending', maxCount: 1 }
  ]), async (req, res) => {
    const files = Object.values(req.files || {}).flat();
    const tempFiles = [];
    try {
      const source = req.files?.video?.[0];
      const overlay = req.files?.overlay?.[0] || null;
      const overlay2 = req.files?.overlay2?.[0] || null;
      const ending = req.files?.ending?.[0] || null;
      if (!source) throw new Error('Selecione o vídeo principal do Reels.');
      const info = await probeMedia(source.path);
      const overlayInfo = overlay ? await probeMedia(overlay.path) : null;
      const overlay2Info = overlay2 ? await probeMedia(overlay2.path) : null;
      if (!info.duration) throw new Error('Não consegui detectar a duração do vídeo.');
      if (info.duration > 1800) throw new Error('Use um vídeo de até 30 minutos para evitar processamento excessivo.');
      const start = clamp(req.body?.start, 0, Math.max(0, info.duration - 0.2), 0);
      const requestedEnd = Number(req.body?.end || 0);
      if (requestedEnd > 0 && requestedEnd <= start) throw new Error('O fim do corte deve ser maior que o início.');
      const duration = requestedEnd > 0 ? Math.min(requestedEnd, info.duration) - start : Math.max(0.2, info.duration - start);
      const endingSeconds = clamp(req.body?.endingSeconds, 1, 12, 3);
      if (duration < 0.2) throw new Error('O trecho escolhido é curto demais.');
      if (!ending && duration < 3) throw new Error('O Instagram exige Reels com pelo menos 3 segundos. Aumente o trecho ou adicione um final.');
      if (ending && duration + endingSeconds < 3) throw new Error('O Reels final precisa ter pelo menos 3 segundos.');

      const ratio = String(req.body?.aspectRatio || '9:16');
      const dimensions = {
        '9:16': { width: 1080, height: 1920 },
        '4:5': { width: 1080, height: 1350 },
        '1:1': { width: 1080, height: 1080 },
        '16:9': { width: 1920, height: 1080 }
      };
      const output = dimensions[ratio] || dimensions['9:16'];
      const outW = output.width, outH = output.height;
      const mainOut = path.join(uploadDir, `main-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);
      tempFiles.push(mainOut);
      const args = ['-y', '-ss', String(start), '-i', source.path];
      const layerFiles = { overlay, overlay2 };
      const layerInfos = { overlay: overlayInfo, overlay2: overlay2Info };
      const layerSpecs = {
        overlay: { x: clamp(req.body?.overlayX,0,100,50), y: clamp(req.body?.overlayY,0,100,10), scale: clamp(req.body?.overlayScale,5,100,30) },
        overlay2: { x: clamp(req.body?.overlay2X,0,100,50), y: clamp(req.body?.overlay2Y,0,100,50), scale: clamp(req.body?.overlay2Scale,5,100,35) }
      };
      let requestedOrder=[];
      try { const parsed=JSON.parse(String(req.body?.layerOrder||'[]')); if(Array.isArray(parsed))requestedOrder=parsed.filter(x=>x==='overlay'||x==='overlay2'); } catch (_) {}
      const seen=new Set();
      // layerOrder is bottom-to-top. Default puts layer 2 behind layer 1.
      const layerOrder=[...requestedOrder,'overlay2','overlay'].filter(name=>{if(!layerFiles[name]||seen.has(name))return false;seen.add(name);return true;});
      const layerInputIndexes={}; let inputCount=1;
      for(const name of layerOrder){const file=layerFiles[name];if(!file)continue;layerInputIndexes[name]=inputCount++;if(/^image\//i.test(file.mimetype||''))args.push('-loop','1','-framerate','30','-i',file.path);else args.push('-stream_loop','-1','-i',file.path);}
      let silenceIndex=-1;
      if(!info.hasAudio){silenceIndex=inputCount++;args.push('-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000');}
      const filters=[`[0:v]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},fps=30,setsar=1[base]`];
      let previous='base',layerNumber=0;
      for(const name of layerOrder){const file=layerFiles[name];if(!file)continue;const li=layerInfos[name];const spec=layerSpecs[name];const aspect=li?.width>0&&li?.height>0?li.width/li.height:(9/16);const width=Math.max(2,Math.min(Math.round(outW*spec.scale/100/2)*2,Math.floor(Math.min(outW,outH*aspect)/2)*2));const height=Math.max(2,Math.min(outH,Math.round(width/aspect/2)*2));const x=Math.round(Math.max(0,outW-width)*spec.x/100);const y=Math.round(Math.max(0,outH-height)*spec.y/100);const il=`lay${layerNumber}`,ol=`mix${layerNumber}`;filters.push(`[${layerInputIndexes[name]}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,format=rgba,setpts=PTS-STARTPTS[${il}]`);filters.push(`[${previous}][${il}]overlay=x=${x}:y=${y}:eof_action=repeat:shortest=1[${ol}]`);previous=ol;layerNumber++;}
      if(previous==='base')filters.push('[base]null[vout]');else filters.push(`[${previous}]null[vout]`);
      args.push('-filter_complex',filters.join(';'),'-map','[vout]');
      if(info.hasAudio)args.push('-map','0:a:0?');else args.push('-map',`${silenceIndex}:a:0`);
      args.push('-t',String(duration),'-c:v','libx264','-preset','veryfast','-crf','22','-pix_fmt','yuv420p','-r','30','-c:a','aac','-b:a','128k','-ar','48000','-ac','2','-movflags','+faststart','-shortest',mainOut);
      await runFfmpeg(args);

      let finalOut=mainOut;
      if(ending){
        const endingOut=path.join(uploadDir,`ending-${Date.now()}-${Math.random().toString(36).slice(2,8)}.mp4`);tempFiles.push(endingOut);
        const endingArgs=['-y'];if(/^image\//i.test(ending.mimetype||''))endingArgs.push('-loop','1','-framerate','30','-i',ending.path);else endingArgs.push('-stream_loop','-1','-i',ending.path);
        endingArgs.push('-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000','-vf',`scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},fps=30,setsar=1`,'-map','0:v:0','-map','1:a:0','-t',String(endingSeconds),'-c:v','libx264','-preset','veryfast','-crf','22','-pix_fmt','yuv420p','-r','30','-c:a','aac','-b:a','128k','-ar','48000','-ac','2','-movflags','+faststart','-shortest',endingOut);
        await runFfmpeg(endingArgs);
        const listPath=path.join(uploadDir,`concat-${Date.now()}-${Math.random().toString(36).slice(2,8)}.txt`);tempFiles.push(listPath);
        const concatOut=path.join(uploadDir,`concat-out-${Date.now()}-${Math.random().toString(36).slice(2,8)}.mp4`);tempFiles.push(concatOut);
        fs.writeFileSync(listPath,`file '${mainOut}'\nfile '${endingOut}'\n`,'utf8');
        await runFfmpeg(['-y','-f','concat','-safe','0','-i',listPath,'-c','copy','-movflags','+faststart',concatOut]);finalOut=concatOut;
      }
      const finalName=`studio-reel-${Date.now()}-${Math.random().toString(36).slice(2,8)}.mp4`;
      const publicPath=path.join('/tmp',finalName);fs.copyFileSync(finalOut,publicPath);
      const host=String(req.get('host')||'').replace(/[^a-z0-9.:-]/gi,'');if(!host)throw new Error('Não foi possível formar a URL pública do vídeo.');
      res.json({success:true,fileName:finalName,videoUrl:`https://${host}/temp/${finalName}`,width:outW,height:outH,aspectRatio:ratio in dimensions?ratio:'9:16'});
    } catch(error){res.status(400).json({success:false,error:error.message||'Falha ao montar o Reels.'});}
    finally{cleanUploaded(files);for(const file of tempFiles){try{fs.unlinkSync(file);}catch(_){}}}
  });

  app.post('/editor/api/video/publish', async (req, res) => {
    try {
      const profile = String(req.body?.profile || 'padrao').trim().toLowerCase();
      let token = '';
      let userId = '';
      if (profile === 'padrao') {
        token = process.env.CGN_PADRAO_INSTAGRAM_ACCESS_TOKEN;
        userId = process.env.CGN_PADRAO_INSTAGRAM_ACCOUNT_ID;
        if (!token || !userId) {
          throw new Error('Para publicar pelo destino Padrão CGN usando o editor novo, configure CGN_PADRAO_INSTAGRAM_ACCESS_TOKEN e CGN_PADRAO_INSTAGRAM_ACCOUNT_ID no Render studio-card. Copie os valores do perfil padrão diretamente do Environment do Render antigo; não envie os tokens pelo chat.');
        }
      } else if (profile === 'studio') {
        token = process.env.INSTAGRAM_ACCESS_TOKEN;
        userId = process.env.INSTAGRAM_ACCOUNT_ID;
        if (!token || !userId) throw new Error('Configure INSTAGRAM_ACCESS_TOKEN e INSTAGRAM_ACCOUNT_ID para o perfil Studio Card no Environment deste Render.');
      } else {
        throw new Error('Destino Instagram desconhecido. Selecione Padrão CGN ou Studio Card no botão Destino Insta.');
      }
      const fileName = path.basename(String(req.body?.fileName || ''));
      if (!/^studio-reel-[a-z0-9-]+\.mp4$/i.test(fileName)) throw new Error('Nome do Reels inválido. Gere o vídeo novamente antes de publicar.');
      const filePath = path.join('/tmp', fileName);
      if (!fs.existsSync(filePath)) throw new Error('O vídeo final não está mais no servidor. Gere o Reels novamente e publique logo depois.');
      const caption = String(req.body?.caption || '').trim().slice(0, 2200);
      if (!caption) throw new Error('Escreva ou gere uma legenda antes de publicar.');
      const host = String(req.get('host') || '').replace(/[^a-z0-9.:-]/gi, '');
      const videoUrl = `https://${host}/temp/${fileName}`;
      const graphBase = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(userId)}`;
      const createResponse = await fetchFn(`${graphBase}/media`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true', access_token: token })
      });
      const container = await createResponse.json().catch(() => ({}));
      if (!createResponse.ok || container.error || !container.id) throw new Error(container.error?.message || `A Meta recusou o vídeo (HTTP ${createResponse.status}).`);
      let finished = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        const statusResponse = await fetchFn(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(container.id)}?fields=status_code,status&access_token=${encodeURIComponent(token)}`);
        const status = await statusResponse.json().catch(() => ({}));
        if (!statusResponse.ok || status.error) throw new Error(status.error?.message || 'Não foi possível consultar o processamento do Reels.');
        const code = String(status.status_code || '').toUpperCase();
        if (code === 'FINISHED') { finished = true; break; }
        if (code === 'ERROR' || code === 'EXPIRED') throw new Error(status.status || `O Instagram marcou o vídeo como ${code}.`);
      }
      if (!finished) throw new Error('O Instagram ainda está processando o vídeo. Aguarde um pouco e tente consultar novamente.');
      const publishResponse = await fetchFn(`${graphBase}/media_publish`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ creation_id: container.id, access_token: token })
      });
      const published = await publishResponse.json().catch(() => ({}));
      if (!publishResponse.ok || published.error || !published.id) throw new Error(published.error?.message || 'A Meta não confirmou a publicação do Reels.');
      res.json({ success: true, message: 'Reels publicado no Instagram.', mediaId: published.id });
    } catch (error) {
      res.status(502).json({ success: false, error: error.message || 'Falha ao publicar o Reels.' });
    }
  });
};
