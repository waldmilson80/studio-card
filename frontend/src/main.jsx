import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Canvas, FabricImage, Textbox, Rect, Gradient
} from 'fabric';
import {
  EditorProvider, Preview, Timeline, AssetPanel, createDefaultDemuxerFactory,
  useTimelineEngine, useTracksStore, useSelectionStore, usePlaybackStore,
  useMediaLibrary, lazyExportVideo, serializeProject, deserializeProject
} from '@elah/editor';
import { strToU8, strFromU8, zipSync, unzipSync } from 'fflate';
import '@elah/timeline/styles.css';
import '@elah/editor/styles.css';
import '@elah/editor/styles/tokens.css';
import './studio.css';

const API = 'https://studio-card.onrender.com/editor/api';
const FPS = 30;
const demuxerFactory = createDefaultDemuxerFactory();
const mountedRoots = new Map();
let lastRenderedSignature = '';
const mediaFiles = new Map();
const mediaUrlSet = new Set();
let lastRenderedVideo = null;

function serializeCurrentProject(engine) {
  const project = engine?.getProject?.() ?? engine;
  const serialized = serializeProject(project);
  return typeof serialized === 'string' ? serialized : JSON.stringify(serialized);
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) throw new Error(data.error || `Falha HTTP ${response.status}`);
  return data;
}
function say(area, message, type = '') {
  const bridge = window.CGNStudioBridge;
  if (bridge?.status) bridge.status(area, message, type);
  else console[type === 'error' ? 'error' : 'log'](`[${area}] ${message}`);
}
function getProfile() {
  try { return window.CGNStudioBridge?.getProfile?.() || 'padrao'; } catch (_) { return 'padrao'; }
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 120000);
}
function idbOpen() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('cgn-studio-pro-v1', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Não foi possível abrir o armazenamento local.'));
  });
}
async function idbRequest(storeName, mode, work) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try { result = work(store); } catch (e) { db.close(); reject(e); return; }
    tx.oncomplete = () => { db.close(); resolve(result?.result ?? result); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Falha ao salvar localmente.')); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Operação local cancelada.')); };
  });
}
async function idbPut(store, value) { return idbRequest(store, 'readwrite', s => s.put(value)); }
async function idbGet(store, id) { return idbRequest(store, 'readonly', s => s.get(id)); }
async function idbAll(store) { return idbRequest(store, 'readonly', s => s.getAll()); }

// ------------------------- EDITOR DE ARTES (Fabric.js) ----------------------
function ArtEditor() {
  const elementRef = useRef(null);
  const canvasRef = useRef(null);
  const objectsRef = useRef({});
  const stateRef = useRef(null);
  const zoomRef = useRef(1);
  const movedRef = useRef(new Set());
  const imageUrlsRef = useRef({ bg: '', logo: '' });
  const [selected, setSelected] = useState('');
  const [ready, setReady] = useState(false);
  const [customText, setCustomText] = useState('Novo texto');
  const [modelName, setModelName] = useState('Modelo CGN');
  const [models, setModels] = useState([]);
  const [modelChoice, setModelChoice] = useState('');
  const [showLayerHelp, setShowLayerHelp] = useState(false);
  const [backgroundZoom, setBackgroundZoom] = useState(1);

  const refreshModels = useCallback(() => {
    try { setModels(JSON.parse(localStorage.getItem('cgn-studio-fabric-models-v1') || '[]')); }
    catch (_) { setModels([]); }
  }, []);

  useEffect(() => {
    if (!elementRef.current || canvasRef.current) return;
    let lastApplyPromise = Promise.resolve();
    const canvas = new Canvas(elementRef.current, {
      width: 1080, height: 1350, backgroundColor: '#111111',
      preserveObjectStacking: true, selection: true, stopContextMenu: true,
      controlsAboveOverlay: true, enableRetinaScaling: false
    });
    canvasRef.current = canvas;

    const bg = new Rect({ left: 0, top: 0, width: 1080, height: 1350, fill: '#202020', selectable: false, evented: false });
    bg.cgnRole = 'background'; canvas.add(bg); objectsRef.current.background = bg;
    const shade = new Rect({ left: 0, top: 0, width: 1080, height: 1350, fill: '#000000', opacity: 0.66, selectable: false, evented: false });
    shade.cgnRole = 'shade'; canvas.add(shade); objectsRef.current.shade = shade;
    const rule = new Rect({ left: 420, top: 950, width: 240, height: 9, fill: '#f3132b', selectable: true, evented: true });
    rule.cgnRole = 'rule'; canvas.add(rule); objectsRef.current.rule = rule;
    const title = new Textbox('SUA MANCHETE AQUI', { left: 75, top: 970, width: 930, fontFamily: 'Montserrat, Arial, sans-serif', fontSize: 68, fontWeight: 800, fill: '#ffffff', textAlign: 'center', lineHeight: 1.05, splitByGrapheme: true, editable: true, shadow: 'rgba(0,0,0,.18) 0px 2px 4px' });
    title.cgnRole = 'title'; canvas.add(title); objectsRef.current.title = title;
    const subtitle = new Textbox('', { left: 95, top: 1170, width: 890, fontFamily: 'Montserrat, Arial, sans-serif', fontSize: 30, fontWeight: 500, fill: '#ffffff', textAlign: 'center', lineHeight: 1.12, splitByGrapheme: true, editable: true });
    subtitle.cgnRole = 'subtitle'; canvas.add(subtitle); objectsRef.current.subtitle = subtitle;
    const footer = new Textbox('@alvesbuenoo  |  @centralgoiano  |  www.centralgoiano.com.br', { left: 40, top: 1293, width: 1000, fontFamily: 'Arial, sans-serif', fontSize: 18, fontWeight: 600, fill: '#ffffff', textAlign: 'center', editable: true });
    footer.cgnRole = 'footer'; canvas.add(footer); objectsRef.current.footer = footer;
    const logoPlaceholder = new Textbox('LOGO CGN', { left: 65, top: 55, width: 180, fontSize: 30, fontWeight: 800, fontFamily: 'Arial, sans-serif', fill: '#ffffff', backgroundColor: 'rgba(0,0,0,.28)', textAlign: 'center', editable: false });
    logoPlaceholder.cgnRole = 'logoPlaceholder'; canvas.add(logoPlaceholder); objectsRef.current.logoPlaceholder = logoPlaceholder;

    const onSelection = () => setSelected(String(canvas.getActiveObject()?.cgnRole || ''));
    canvas.on('selection:created', onSelection); canvas.on('selection:updated', onSelection); canvas.on('selection:cleared', () => setSelected(''));
    canvas.on('object:modified', ({ target }) => {
      if (!target) return;
      const role = target.cgnRole;
      if (role) movedRef.current.add(role);
      if (role === 'title') window.CGNStudioBridge?.setArtText?.('title', target.text || '');
      if (role === 'subtitle') window.CGNStudioBridge?.setArtText?.('subtitle', target.text || '');
      if (role === 'footer') window.CGNStudioBridge?.setArtFooter?.(target.text || '');
      syncArtInputsFromObject(target);
      canvas.requestRenderAll();
    });
    canvas.on('text:editing:exited', ({ target }) => {
      if (target?.cgnRole === 'title') window.CGNStudioBridge?.setArtText?.('title', target.text || '');
      if (target?.cgnRole === 'subtitle') window.CGNStudioBridge?.setArtText?.('subtitle', target.text || '');
    });
    function syncArtInputsFromObject(target) {
      const role = target?.cgnRole;
      if (role === 'logo') window.CGNStudioBridge?.setArtLogoPosition?.({ x: Math.round(target.left || 0), y: Math.round(target.top || 0), width: Math.round((target.width || 180) * (target.scaleX || 1)) });
      if (role === 'title') window.CGNStudioBridge?.setArtTitleBottom?.(Math.max(100, Math.min(700, Math.round(1350 - (target.top || 0) - (target.height || 300)))));
    }

    window.CGNStudioArtCanvas = {
      update: values => { stateRef.current = values || {}; lastApplyPromise = applyArtState({ ...(values || {}), backgroundScale:zoomRef.current }); return lastApplyPromise; },
      exportDataUrl: async () => {
        if (!canvasRef.current) throw new Error('A área de artes ainda está carregando.');
        await lastApplyPromise;
        canvasRef.current.discardActiveObject(); canvasRef.current.requestRenderAll();
        return canvasRef.current.toDataURL({ format: 'jpeg', quality: 0.94, multiplier: 1 });
      },
      saveModel: name => saveArtModel(name),
      loadModel: id => loadArtModel(id),
      resetLayout: () => { movedRef.current.clear(); applyArtState(stateRef.current || {}); },
    };
    refreshModels(); setReady(true);
    const initial = window.CGNStudioBridge?.getArtState?.();
    if (initial) { stateRef.current = initial; applyArtState(initial); }
    const onResize = () => { canvas.calcOffset(); canvas.requestRenderAll(); };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); canvas.dispose(); canvasRef.current = null; delete window.CGNStudioArtCanvas; };

    function position(role, object, values) {
      if (movedRef.current.has(role)) return;
      if (values.left != null) object.set('left', values.left);
      if (values.top != null) object.set('top', values.top);
      if (values.width != null) object.set('width', values.width);
      if (values.fontSize != null) object.set('fontSize', values.fontSize);
    }
    async function applyArtState(raw) {
      const c = canvasRef.current; if (!c || !raw) return;
      const o = objectsRef.current;
      const accent = /^#[\da-f]{6}$/i.test(raw.accentColor || '') ? raw.accentColor : '#f3132b';
      if (raw.imageData && raw.imageData !== imageUrlsRef.current.bg) {
        try {
          const image = await FabricImage.fromURL(raw.imageData);
          image.set({ selectable: false, evented: false, originX: 'left', originY: 'top' });
          const scale = Math.max(1080 / image.width, 1350 / image.height) * Math.max(1,Math.min(3.5,Number(raw.backgroundScale||1)));
          const scaledWidth=image.width*scale, scaledHeight=image.height*scale;
          image.set({ scaleX: scale, scaleY: scale, left:-(scaledWidth-1080)*Math.max(0,Math.min(100,Number(raw.imageX??50)))/100, top:-(scaledHeight-1350)*Math.max(0,Math.min(100,Number(raw.imageY??50)))/100 }); image.cgnRole = 'backgroundImage';
          const old = o.backgroundImage; if (old) c.remove(old);
          o.backgroundImage = image; c.add(image); c.sendObjectToBack(image); c.sendObjectToBack(o.background);
          imageUrlsRef.current.bg = raw.imageData;
        } catch (err) { console.warn('Fundo da arte:', err); }
      }
      const shade=Math.max(0, Math.min(1, Number(raw.overlayStrength ?? 65) / 100));
      const gradientTop=Math.max(0,Math.min(1250,Number(raw.overlayStart??48)*13.5));
      o.background.set({ fill: raw.backgroundColor || '#111111' });
      o.shade.set({ opacity: 1, top: gradientTop, height: 1350-gradientTop, fill: new Gradient({ type: 'linear', gradientUnits: 'pixels', coords: { x1: 0, y1: 0, x2: 0, y2: Math.max(1,1350-gradientTop) }, colorStops: [ { offset: 0, color: 'rgba(0,0,0,0)' }, { offset: 1, color: `rgba(0,0,0,${shade})` } ] }) });
      if (o.backgroundImage && !movedRef.current.has('backgroundImage')) {
        const bgScale=Math.max(1080/o.backgroundImage.width,1350/o.backgroundImage.height)*Math.max(1,Math.min(3.5,Number(raw.backgroundScale||1)));const bgW=o.backgroundImage.width*bgScale,bgH=o.backgroundImage.height*bgScale;o.backgroundImage.set({scaleX:bgScale,scaleY:bgScale});
        o.backgroundImage.set({left:-(bgW-1080)*Math.max(0,Math.min(100,Number(raw.imageX??50)))/100,top:-(bgH-1350)*Math.max(0,Math.min(100,Number(raw.imageY??50)))/100});
      }
      const ruleWidth=Math.max(40,Math.min(700,Number(raw.ruleWidth||246)));
      const titleWidth=Math.max(45,Math.min(100,Number(raw.titleWidth||92)))*10.8;
      const titleLeft=Math.max(0,Math.min(1080-titleWidth,Number(raw.titleX??50)*10.8-titleWidth/2));
      const titleTop=Math.max(300, 1350 - Number(raw.titleBottom || 166) - 300);
      o.rule.set({ fill: accent, visible:raw.ruleEnabled!==false, selectable:raw.ruleEnabled!==false, evented:raw.ruleEnabled!==false });
      if (!movedRef.current.has('rule')) o.rule.set({ height:Math.max(2,Math.min(18,Number(raw.ruleHeight||9))) });
      position('rule', o.rule, { left:(1080-ruleWidth)/2, top:Math.max(180,titleTop-Math.max(4,Number(raw.ruleGap||28))-9), width:ruleWidth });
      o.title.set({ text: String(raw.title || 'SUA MANCHETE AQUI').toLocaleUpperCase('pt-BR'), fill: raw.titleColor || '#ffffff', fontFamily: raw.fontFamily || 'Montserrat, Arial, sans-serif', fontSize: Math.max(34, Math.min(100, Number(raw.fontSize || 68))), fontWeight: [600,700,800,900].includes(Number(raw.titleWeight))?Number(raw.titleWeight):800, textAlign: raw.titleAlign || 'center', lineHeight:Math.max(.85,Math.min(1.35,Number(raw.lineHeight||1.075))), charSpacing:Math.max(-30,Math.min(40,Number(raw.letterSpacing||-1.2)*10)) });
      o.title.set('styles', {});
      const highlightWords=String(raw.highlightWords||'').split(',').map(w=>w.trim()).filter(Boolean).sort((a,b)=>b.length-a.length).slice(0,8);
      for(const word of highlightWords){let at=0;const textValue=String(o.title.text||'');while((at=textValue.toLocaleUpperCase('pt-BR').indexOf(word.toLocaleUpperCase('pt-BR'),at))!==-1){try{o.title.setSelectionStyles({fill:accent},at,at+word.length);}catch(_){}at+=Math.max(1,word.length);}}
      position('title', o.title, { left:titleLeft, top:titleTop, width:titleWidth, fontSize: Number(raw.fontSize || 68) });
      o.subtitle.set({ text: String(raw.subtitle || ''), fill: raw.subtitleColor || '#ffffff', fontFamily: raw.fontFamily || 'Montserrat, Arial, sans-serif', fontSize: Math.max(18, Math.min(48, Number(raw.subtitleFontSize || Math.round(Number(raw.fontSize || 68) * .42)))), textAlign: raw.titleAlign || 'center', lineHeight:1.12 });
      position('subtitle', o.subtitle, { left:titleLeft+Math.min(20,titleWidth*.02), top:Math.max(titleTop+Math.round(Number(raw.fontSize||68)*2.25),1120), width:titleWidth-Math.min(40,titleWidth*.04) });
      const footerParts=[];if(raw.footerInstagram1Enabled!==false)footerParts.push(raw.footerInstagram1||'@alvesbuenoo');if(raw.footerInstagram2Enabled!==false)footerParts.push(raw.footerInstagram2||'@centralgoiano');if(raw.footerWebsiteEnabled!==false)footerParts.push(raw.footerWebsite||'www.centralgoiano.com.br');
      o.footer.set({ text: raw.footerEnabled===false?'':(raw.footerLines===false?footerParts.join('  |  '):footerParts.join('   ')), fill: '#ffffff', fontSize:Math.max(12,Math.min(30,Number(raw.footerFontSize||19))), visible:raw.footerEnabled!==false });
      position('footer', o.footer, { left:40, top:Math.max(1250,1350-Number(raw.footerBottom||65)-40), width:1000 });
      const logoData = raw.logoData || '';
      if (logoData && logoData !== imageUrlsRef.current.logo) {
        try {
          const img = await FabricImage.fromURL(logoData);
          img.set({ left: Number(raw.logoX ?? 65), top: Number(raw.logoY ?? 55), selectable: true, evented: true, originX: 'left', originY: 'top' });
          const scale = Math.max(0.05, Number(raw.logoWidth || 180) / Math.max(1, img.width)); img.set({ scaleX: scale, scaleY: scale }); img.cgnRole = 'logo';
          const old = o.logo; if (old) c.remove(old);
          o.logo = img; c.add(img); c.bringObjectToFront(img); o.logoPlaceholder.set({ visible: false }); imageUrlsRef.current.logo = logoData;
        } catch (err) { console.warn('Logo da arte:', err); }
      } else if (!logoData) { if (o.logo) { c.remove(o.logo); delete o.logo; imageUrlsRef.current.logo = ''; } o.logoPlaceholder.set({ visible: true }); }
      else if (o.logo && !movedRef.current.has('logo')) {
        o.logo.set({ left: Number(raw.logoX ?? o.logo.left), top: Number(raw.logoY ?? o.logo.top) });
        const scale = Math.max(0.05, Number(raw.logoWidth || 180) / Math.max(1, o.logo.width)); o.logo.set({ scaleX: scale, scaleY: scale });
      }
      c.requestRenderAll();
    }
    function saveArtModel(name) {
      const c = canvasRef.current; if (!c) return;
      const payload = { id: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`, name: String(name || 'Modelo CGN').slice(0,80), objects: c.getObjects().filter(x => x.cgnRole && !['backgroundImage','logo'].includes(x.cgnRole)).map(x => ({ role:x.cgnRole,left:x.left,top:x.top,width:x.width,height:x.height,scaleX:x.scaleX,scaleY:x.scaleY,fontSize:x.fontSize,fontFamily:x.fontFamily,fontWeight:x.fontWeight,fill:typeof x.fill==='string'?x.fill:undefined,text:x.text,textAlign:x.textAlign,opacity:x.opacity,charSpacing:x.charSpacing,lineHeight:x.lineHeight,visible:x.visible })), savedAt:new Date().toISOString() };
      const rows = JSON.parse(localStorage.getItem('cgn-studio-fabric-models-v1') || '[]'); rows.unshift(payload); localStorage.setItem('cgn-studio-fabric-models-v1', JSON.stringify(rows.slice(0,20))); refreshModels(); setModelChoice(payload.id); say('cgnArtStatus', `Modelo “${payload.name}” salvo neste navegador.`, 'good');
    }
    function loadArtModel(id) {
      const payload = JSON.parse(localStorage.getItem('cgn-studio-fabric-models-v1') || '[]').find(x => x.id === id); if (!payload) throw new Error('Modelo salvo não encontrado.');
      const c = canvasRef.current; const o = objectsRef.current;
      for (const item of payload.objects || []) { let target = o[item.role]; if (!target && String(item.role||'').startsWith('custom-')) { target=new Textbox(String(item.text||'Texto'),{left:Number(item.left||100),top:Number(item.top||100),width:Number(item.width||600),fontSize:Number(item.fontSize||48),fontFamily:item.fontFamily||'Montserrat, Arial, sans-serif',fontWeight:item.fontWeight||700,fill:item.fill||'#ffffff',textAlign:item.textAlign||'center',editable:true,splitByGrapheme:true});target.cgnRole=item.role;o[item.role]=target;c.add(target); } if (!target) continue; target.set(Object.fromEntries(Object.entries(item).filter(([k])=>k!=='role'&&k!=='text'))); if (typeof item.text === 'string') target.set('text', item.text); movedRef.current.add(item.role); target.setCoords(); }
      c.requestRenderAll(); say('cgnArtStatus', `Modelo “${payload.name}” aplicado.`, 'good');
    }
  }, [refreshModels]);

  function selectedObject() { return canvasRef.current?.getActiveObject(); }
  function addText() {
    const c = canvasRef.current; if (!c) return;
    const text = new Textbox(customText || 'Novo texto', { left: 220, top: 350, width: 640, fontSize: 54, fill: '#ffffff', fontWeight: 700, textAlign: 'center', editable: true, splitByGrapheme: true });
    text.cgnRole = `custom-${Date.now()}`; c.add(text); c.setActiveObject(text); c.requestRenderAll(); movedRef.current.add(text.cgnRole); setSelected(text.cgnRole);
  }
  function deleteSelected() { const c = canvasRef.current; const obj = selectedObject(); if (!c || !obj || ['backgroundImage','background','shade'].includes(obj.cgnRole)) return; c.remove(obj); delete objectsRef.current[obj.cgnRole]; setSelected(''); }
  function duplicateSelected() { const c = canvasRef.current; const obj=selectedObject(); if(!c||!obj)return; obj.clone().then(copy=>{copy.set({left:(obj.left||0)+24,top:(obj.top||0)+24});copy.cgnRole=`custom-${Date.now()}`;c.add(copy);c.setActiveObject(copy);c.requestRenderAll();movedRef.current.add(copy.cgnRole);setSelected(copy.cgnRole);}); }
  function saveModel() { try { window.CGNStudioArtCanvas?.saveModel(modelName); } catch(e) { say('cgnArtStatus', e.message, 'error'); } }
  function loadModel() { try { window.CGNStudioArtCanvas?.loadModel(modelChoice); } catch(e) { say('cgnArtStatus', e.message, 'error'); } }

  return <section className="cgn-pro-panel cgn-art-editor">
    <div className="cgn-panel-head"><div><strong>Arte em camadas</strong><p>Selecione, arraste e redimensione os elementos. Duplo clique no texto para editá-lo.</p></div><span className="cgn-chip">1080 × 1350</span></div>
    <div className="cgn-art-grid">
      <aside className="cgn-art-tools">
        <div className="cgn-tool-group"><b>Elementos selecionados</b><div className="cgn-button-grid"><button onClick={addText}>+ Texto</button><button onClick={duplicateSelected}>Duplicar</button><button onClick={deleteSelected}>Excluir</button><button onClick={()=>canvasRef.current?.bringObjectForward(selectedObject())}>Trazer frente</button></div>
          <label className="cgn-field">Texto novo <input value={customText} onChange={e=>setCustomText(e.target.value)} /></label>
          <label className="cgn-field">Zoom do fundo <input type="range" min="1" max="3.5" step="0.05" value={backgroundZoom} onChange={e=>{const value=Number(e.target.value);zoomRef.current=value;setBackgroundZoom(value);if(stateRef.current)window.CGNStudioArtCanvas?.update(stateRef.current);}} /></label>
          <button className="cgn-secondary" onClick={()=>{movedRef.current.clear();window.CGNStudioArtCanvas?.resetLayout();}}>Reaplicar layout inicial</button>
          <button className="cgn-secondary" onClick={()=>setShowLayerHelp(v=>!v)}>{showLayerHelp?'Ocultar dicas':'Como editar'}</button>{showLayerHelp&&<p className="cgn-note">Clique num elemento para selecionar. Puxe as alças dos cantos para redimensionar. Para mover, clique e arraste. Os campos de manchete e linha fina continuam sincronizados com a área original de IA.</p>}
        </div>
        <div className="cgn-tool-group"><b>Modelos de layout</b><label className="cgn-field">Nome do modelo<input value={modelName} onChange={e=>setModelName(e.target.value)} /></label><button onClick={saveModel}>Salvar modelo</button><label className="cgn-field">Modelos salvos<select value={modelChoice} onChange={e=>setModelChoice(e.target.value)}><option value="">Escolher...</option>{models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label><button className="cgn-secondary" onClick={loadModel} disabled={!modelChoice}>Aplicar modelo</button></div>
        <div className="cgn-tool-group"><b>Seleção</b><div className="cgn-selection-label">{selected || 'Nenhum elemento selecionado'}</div><button className="cgn-primary" onClick={async()=>{try {const data=await window.CGNStudioArtCanvas.exportDataUrl();const a=document.createElement('a');a.href=data;a.download='cgn-arte-1080x1350.jpg';a.click();say('cgnArtStatus','Imagem exportada do canvas editável.','good');}catch(e){say('cgnArtStatus',e.message,'error');}}}>Exportar arte JPG</button><small>Exporta exatamente o que aparece nesta tela.</small></div>
      </aside>
      <div className="cgn-art-workspace"><div className="cgn-canvas-frame"><canvas ref={elementRef} aria-label="Canvas editável de arte Central Goiano" /></div>{!ready&&<div className="cgn-note">Carregando área de artes…</div>}</div>
    </div>
  </section>;
}

// -------------------------- EDITOR DE REELS (Elah) ---------------------------
const ASPECTS = {
  '9:16': { width: 1080, height: 1920 }, '4:5': { width: 1080, height: 1350 },
  '1:1': { width: 1080, height: 1080 }, '16:9': { width: 1920, height: 1080 }
};
const TRACKS = [
  { kind:'elements', name:'Textos e formas', height:42 },
  { kind:'video', name:'Camadas superiores', height:46 },
  { kind:'video', name:'Vídeo principal', height:50 },
  { kind:'audio', name:'Áudio', height:42 }
];

function VideoEditor() {
  const engine = useTimelineEngine();
  const tracks = useTracksStore(s => s.tracks);
  const clips = useTracksStore(s => s.clips);
  const totalFrames = useTracksStore(s => s.totalFrames);
  const selectedIds = useSelectionStore(s => s.selectedClipIds);
  const currentFrame = usePlaybackStore(s => s.currentFrame);
  const playing = usePlaybackStore(s => s.isPlaying);
  const togglePlayPause = usePlaybackStore(s => s.togglePlayPause);
  const setCurrentFrame = usePlaybackStore(s => s.setCurrentFrame);
  const library = useMediaLibrary();
  const [ratio, setRatio] = useState('9:16');
  const [title, setTitle] = useState(''); const [caption, setCaption] = useState(''); const [transcript, setTranscript] = useState('');
  const [analysisBusy, setAnalysisBusy] = useState(false); const [exportBusy, setExportBusy] = useState(false); const [exportProgress, setExportProgress] = useState(0);
  const [status, setStatus] = useState('Adicione um vídeo para começar.'); const [error, setError] = useState(false);
  const [audioFile, setAudioFile] = useState(null); const [lipSyncBusy, setLipSyncBusy] = useState(false);
  const [projectName, setProjectName] = useState('Edição CGN'); const [savedProjects, setSavedProjects] = useState([]); const [savedChoice, setSavedChoice] = useState('');
  const [templateKind, setTemplateKind] = useState('overlay'); const [savedAssets, setSavedAssets] = useState([]); const [templateChoice, setTemplateChoice] = useState('');
  const [autoTemplate, setAutoTemplate] = useState(localStorage.getItem('cgn-pro-auto-template') === '1');
  const mainVideoRef = useRef(null); const hiddenVideoRef = useRef(null); const hiddenAudioRef = useRef(null); const templateMap = useRef(new Map());
  const allClips = useMemo(()=>{
    if (Array.isArray(clips)) return clips;
    if (clips && typeof clips === 'object') return Object.values(clips);
    const project = engine.getProject?.(); return (project?.tracks||[]).flatMap(t=>t.clips||[]);
  }, [clips, engine]);
  const selectedIdsArray = useMemo(()=>Array.from(selectedIds || []), [selectedIds]);
  const selectedClip = useMemo(()=>allClips.find(c=>selectedIdsArray.includes(c.id)) || allClips[0] || null,[allClips,selectedIdsArray]);
  const framesToSeconds = frame => (Number(frame)||0) / FPS;
  const currentSeconds = framesToSeconds(currentFrame);
  const totalSeconds = Math.max(0, framesToSeconds(totalFrames));

  useEffect(()=>{ engine.setStage(ASPECTS[ratio].width,ASPECTS[ratio].height); },[engine,ratio]);
  useEffect(()=>{ loadLists(); },[]);
  async function loadLists(){
    try { setSavedProjects((await idbAll('projects')).map(x=>({id:x.id,name:x.name,updatedAt:x.updatedAt})).sort((a,b)=>b.updatedAt-a.updatedAt)); } catch(_){}
    try { const assets=await idbAll('assets'); templateMap.current=new Map(assets.map(a=>[a.id,a])); setSavedAssets(assets); } catch(_){}
  }
  function getTrack(kind, preferred='') {
    const list = Array.isArray(tracks) ? tracks : Object.values(tracks || {});
    return list.find(t=>t.name===preferred) || list.find(t=>t.kind===kind && !t.protected) || list.find(t=>t.kind===kind);
  }
  function showStatus(text, isError=false) { setStatus(text); setError(isError); say('cgnReelStatus', text, isError?'error':'good'); }

  async function filesAdded(files, auto=false) {
    const inputFiles = Array.from(files||[]); if (!inputFiles.length) return;
    setError(false);
    const trackCursors = new Map();
    for (const file of inputFiles) {
      let url = URL.createObjectURL(file); mediaUrlSet.add(url); mediaFiles.set(url,file);
      let type = file.type.startsWith('video/')?'video':file.type.startsWith('audio/')?'audio':file.type.startsWith('image/')?'image':'';
      if(!type) continue;
      try { await library.importFiles([file]); } catch (e) { console.warn('AssetPanel import',e); }
      const videoMeta = await readDuration(file,type);
      const track = type==='audio' ? getTrack('audio') : type==='image' ? getTrack('video','Camadas superiores') : getTrack('video','Vídeo principal');
      if(!track) throw new Error('Não encontrei a faixa correta para importar o arquivo.');
      const fallbackDuration=type==='image'?10:Math.max(1,videoMeta.duration||10);
      const priorEnd = Math.max(trackCursors.get(track.id)||0,allClips.filter(c=>c.trackId===track.id).reduce((max,c)=>Math.max(max,Number(c.startFrame||0)+Number(c.durationFrames||0)),0));
      const startFrame=(type==='video' ? priorEnd : type==='audio'?0:Math.round(currentFrame));
      const clipDurationFrames=Math.max(1,Math.round(fallbackDuration*FPS));
      const clip = engine.addClip({type,trackId:track.id,startFrame,durationFrames:clipDurationFrames,src:url,name:file.name});
      if(type==='video')trackCursors.set(track.id,startFrame+clipDurationFrames);
      if (type==='video' && autoTemplate) await appendDefaultTemplates(Math.max(1,Math.round(fallbackDuration*FPS)),startFrame);
      if(type==='video') showStatus(`Vídeo “${file.name}” importado. Arraste as alças da timeline para ajustar o corte.`);
      else showStatus(`${type==='audio'?'Áudio':'Imagem'} “${file.name}” adicionada à timeline.`);
    }
  }
  function readDuration(file,type) {
    return new Promise(resolve=>{ const url=URL.createObjectURL(file); const el=document.createElement(type==='audio'?'audio':'video'); el.preload='metadata'; el.src=url; el.onloadedmetadata=()=>{resolve({duration:Number.isFinite(el.duration)?el.duration:0});URL.revokeObjectURL(url);}; el.onerror=()=>{URL.revokeObjectURL(url);resolve({duration:0});}; });
  }
  async function appendDefaultTemplates(videoFrames, startFrame=0){
    const overlayId=localStorage.getItem('cgn-pro-default-overlay'); const endingId=localStorage.getItem('cgn-pro-default-ending');
    const overlay=templateMap.current.get(overlayId); const ending=templateMap.current.get(endingId);
    if(overlay){ const url=URL.createObjectURL(overlay.blob);mediaUrlSet.add(url);mediaFiles.set(url,new File([overlay.blob],overlay.name,{type:overlay.type}));const kind=overlay.type.startsWith('video/')?'video':'image';const tr=getTrack(kind==='image'?'video':'video','Camadas superiores');engine.addClip({type:kind,trackId:tr.id,startFrame,durationFrames:videoFrames,src:url,name:`Modelo: ${overlay.name}`}); }
    if(ending){ const url=URL.createObjectURL(ending.blob);mediaUrlSet.add(url);mediaFiles.set(url,new File([ending.blob],ending.name,{type:ending.type}));const kind=ending.type.startsWith('video/')?'video':'image';const tr=getTrack('video','Camadas superiores');engine.addClip({type:kind,trackId:tr.id,startFrame:startFrame+videoFrames,durationFrames:Math.round(3*FPS),src:url,name:`Final: ${ending.name}`}); }
  }
  async function saveCurrentAsTemplate(){
    if(!selectedClip?.src) throw new Error('Selecione uma camada de vídeo ou imagem para salvar como modelo.');
    let file=mediaFiles.get(selectedClip.src);
    if(!file){const b=await fetch(selectedClip.src).then(r=>r.blob());file=new File([b],selectedClip.name||'camada', {type:b.type||'application/octet-stream'});}
    const record={id:`asset-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,name:file.name,type:file.type,blob:file,kind:templateKind,updatedAt:Date.now()};
    await idbPut('assets',record);templateMap.current.set(record.id,record);setSavedAssets(a=>[record,...a]);
    localStorage.setItem(templateKind==='overlay'?'cgn-pro-default-overlay':'cgn-pro-default-ending',record.id);
    showStatus(`${templateKind==='overlay'?'Camada padrão':'Final padrão'} “${file.name}” salvo. A próxima edição pode aplicá-lo automaticamente.`);
  }
  async function applyTemplate(){
    const item=templateMap.current.get(templateChoice); if(!item) throw new Error('Escolha um modelo de camada.');
    const url=URL.createObjectURL(item.blob);mediaUrlSet.add(url);mediaFiles.set(url,new File([item.blob],item.name,{type:item.type}));
    const kind=item.type.startsWith('video/')?'video':item.type.startsWith('audio/')?'audio':'image';
    const track=kind==='audio'?getTrack('audio'):kind==='image'||kind==='video'?getTrack('video','Camadas superiores'):null;
    if(!track)throw new Error('Faixa não encontrada.');
    engine.addClip({type:kind,trackId:track.id,startFrame:currentFrame,durationFrames:Math.max(1,Math.round((kind==='image'?5:10)*FPS)),src:url,name:`Modelo: ${item.name}`});
    showStatus(`Modelo “${item.name}” inserido na posição atual.`);
  }
  async function analyzeVideo(){
    const file=selectedClip?.src ? mediaFiles.get(selectedClip.src) : null;
    const candidate=file?.type?.startsWith('video/')?file:Array.from(mediaFiles.values()).find(f=>f.type?.startsWith('video/'));
    if(!candidate)throw new Error('Importe e selecione um vídeo antes de pedir a análise da IA.');
    setAnalysisBusy(true);
    try{const fd=new FormData();fd.append('video',candidate,candidate.name);const result=await api('/video/analyze',{method:'POST',body:fd});setTranscript(result.transcript||'');setTitle(result.title||'');setCaption(result.caption||'');showStatus('Transcrição, título e legenda gerados. Todos os campos permanecem editáveis.');}
    finally{setAnalysisBusy(false);}
  }
  async function lipSync(){
    const videoFile=selectedClip?.src?mediaFiles.get(selectedClip.src):null;
    const candidate=videoFile?.type?.startsWith('video/')?videoFile:Array.from(mediaFiles.values()).find(f=>f.type?.startsWith('video/'));
    if(!candidate)throw new Error('Selecione um clipe de vídeo para sincronizar.');
    if(!audioFile)throw new Error('Escolha o áudio que será sincronizado com o movimento da boca.');
    setLipSyncBusy(true);
    try{
      const fd=new FormData();fd.append('video',candidate,candidate.name);fd.append('audio',audioFile,audioFile.name);
      const result=await api('/video/lipsync',{method:'POST',body:fd});
      const clip=selectedClip?.src&&selectedClip.type==='video'?selectedClip:allClips.find(c=>c.type==='video'&&mediaFiles.has(c.src));
      const response=await fetch(result.videoUrl);if(!response.ok)throw new Error('A saída do Lip Sync foi criada, mas não pôde ser baixada para a timeline.');
      const blob=await response.blob();const url=URL.createObjectURL(blob);mediaUrlSet.add(url);mediaFiles.set(url,new File([blob],result.fileName||'cgn-lipsync.mp4',{type:'video/mp4'}));
      if(clip)engine.updateClip(clip.id,clip.trackId,{src:url,name:'Lip Sync IA - '+candidate.name,durationFrames:Math.max(1,Math.round((result.duration||framesToSeconds(clip.durationFrames))*FPS))});
      else{const tr=getTrack('video','Vídeo principal');engine.addClip({type:'video',trackId:tr.id,startFrame:0,durationFrames:Math.max(1,Math.round((result.duration||10)*FPS)),src:url,name:'Lip Sync IA'});}
      showStatus('Lip Sync concluído. O vídeo sincronizado já está na timeline; confira antes de exportar.');
    }finally{setLipSyncBusy(false);}
  }
  async function addText(){
    const tr=getTrack('elements');if(!tr)throw new Error('A faixa de texto não foi encontrada.');
    engine.addClip({type:'text',trackId:tr.id,startFrame:currentFrame,durationFrames:Math.round(5*FPS),text:{content:title||'Digite seu texto',fontSize:72,color:'#ffffff',fontWeight:'bold',textAlign:'center'}});
    showStatus('Texto adicionado à faixa de elementos. Selecione-o para mover e redimensionar na prévia.');
  }
  function updateSelectedText(prop,value){
    if(!selectedClip) return;
    const valueToUse=prop==='fontSize'?Number(value):value;
    engine.updateClip(selectedClip.id,selectedClip.trackId,{[prop]:valueToUse});
  }
  async function exportVideo(){
    if(!allClips.length) throw new Error('Adicione pelo menos um vídeo, imagem ou áudio à timeline.');
    setExportBusy(true);setExportProgress(0);setError(false);
    try{
      const blob=await lazyExportVideo(engine.getProject(),{videoCodec:'avc',audioCodec:'aac',outputHeight:ASPECTS[ratio].height,onProgress:p=>setExportProgress(p.totalFrames?Math.round(p.frame/p.totalFrames*100):0)});
      if(!blob?.size)throw new Error('O exportador terminou sem gerar um arquivo.');
      lastRenderedVideo=blob;lastRenderedSignature=serializeCurrentProject(engine);window.CGNStudioRenderedVideo=blob;downloadBlob(blob,'cgn-reels.mp4');
      showStatus(`MP4 exportado (${(blob.size/1024/1024).toFixed(1)} MB). A exportação inclui as faixas e posições da prévia.`);
    }catch(e){showStatus(`${e.message||'Falha na exportação.'} Confira se o navegador oferece WebGL2 e WebCodecs e se não há mídia com erro na timeline.`,true);throw e;}
    finally{setExportBusy(false);}
  }
  async function storeProject(){
    if(!allClips.length)throw new Error('Inclua mídia antes de salvar o projeto.');
    let json=serializeCurrentProject(engine);
    const blobUrls=[...new Set(json.match(/blob:[^"\\\s]+/g)||[])];const archive={};
    for(let i=0;i<blobUrls.length;i++){
      const url=blobUrls[i];let blob;
      try{blob=await fetch(url).then(r=>{if(!r.ok)throw new Error();return r.blob();});}catch(_){const f=mediaFiles.get(url);if(f)blob=f;else throw new Error(`Não foi possível incluir a mídia ${i+1} no projeto. Reimporte o arquivo original e salve novamente.`);}
      const mime=(blob.type||'application/octet-stream').split(';')[0].toLowerCase();
      const mimeExt={ 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','audio/mpeg':'mp3','audio/mp3':'mp3','audio/wav':'wav','audio/x-wav':'wav','audio/ogg':'ogg','audio/mp4':'m4a','audio/aac':'aac','audio/webm':'webm','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov','video/x-matroska':'mkv' };
      const ext=mimeExt[mime] || (mime.startsWith('audio/')?'audio':mime.startsWith('image/')?'image':'mp4');const entry=`media/asset-${i+1}.${ext}`;
      archive[entry]=new Uint8Array(await blob.arrayBuffer());json=json.split(url).join(`cgnasset:${entry}`);
    }
    archive['project.json']=strToU8(json);
    archive['meta.json']=strToU8(JSON.stringify({name:projectName||'Edição CGN',fps:FPS,ratio,savedAt:new Date().toISOString(),assets:blobUrls.length}));
    const packed=zipSync(archive,{level:5});const blob=new Blob([packed],{type:'application/x-cgnstudio'});const id=`project-${Date.now()}`;
    await idbPut('projects',{id,name:projectName||'Edição CGN',blob,updatedAt:Date.now(),ratio});
    downloadBlob(blob,`${safeFilename(projectName)}.cgnstudio`);await loadLists();showStatus('Projeto completo salvo com as mídias dentro do arquivo .cgnstudio e armazenado neste navegador.');
  }
  async function loadProjectFromRecord(){
    const row=await idbGet('projects',savedChoice);if(!row?.blob)throw new Error('Projeto local não encontrado.');await restoreProjectBlob(row.blob);
  }
  async function loadProjectFile(file){await restoreProjectBlob(file);}
  async function restoreProjectBlob(file){
    const bytes=new Uint8Array(await file.arrayBuffer());const data=unzipSync(bytes);let json=strFromU8(data['project.json']);
    const re=/cgnasset:(media\/[^"\\\s]+)/g;const matches=[...json.matchAll(re)];
    for(const m of matches){const url=m[1];const bytesForAsset=data[url];if(!bytesForAsset)throw new Error(`O projeto está sem a mídia ${url}.`);const ext=url.split('.').pop().toLowerCase();const mimeMap={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',m4a:'audio/mp4',aac:'audio/aac',mkv:'video/x-matroska',mov:'video/quicktime',mp4:'video/mp4',webm:'video/webm',image:'image/png',audio:'audio/mpeg'};const mime=mimeMap[ext]||'application/octet-stream';const blob=new Blob([bytesForAsset],{type:mime});const objectUrl=URL.createObjectURL(blob);mediaUrlSet.add(objectUrl);const f=new File([blob],url.split('/').pop(),{type:mime});mediaFiles.set(objectUrl,f);json=json.split(`cgnasset:${url}`).join(objectUrl);}
    deserializeProject(engine,json);showStatus('Projeto restaurado. Se o navegador bloquear uma mídia, reimporte somente o arquivo ausente.');
  }
  async function publish(){
    if(!lastRenderedVideo)throw new Error('Exporte o vídeo primeiro e confira o MP4.');
    if (serializeCurrentProject(engine) !== lastRenderedSignature) { lastRenderedVideo=null; throw new Error('A edição mudou depois da última exportação. Exporte novamente para publicar exatamente a prévia atual.'); }
    if(!caption.trim())throw new Error('Preencha a legenda antes de publicar.');
    const profile=getProfile();const label=profile==='padrao'?'Padrão CGN':'Studio Card';if(!confirm(`Publicar o Reels final no Instagram do destino ${label}?`))return;
    const fd=new FormData();fd.append('video',lastRenderedVideo,'cgn-reels.mp4');
    const stored=await api('/video/store-rendered',{method:'POST',body:fd});
    const result=await api('/video/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile,fileName:stored.fileName,caption,title})});
    showStatus(`${result.message||'Reels publicado.'}${result.mediaId?` ID: ${result.mediaId}`:''}`);
  }
  async function saveModelToDisk(){
    await saveCurrentAsTemplate();
  }
  function clearEditor(){ if(confirm('Limpar a timeline? Os arquivos importados continuarão nos seus projetos salvos.')){const project=engine.getProject();for(const track of project.tracks||[])for(const clip of [...(track.clips||[])])engine.removeClip(clip.id,track.id);lastRenderedVideo=null;lastRenderedSignature='';showStatus('Timeline limpa.');} }
  const actualSelectedText = selectedClip?.type==='text' ? (selectedClip.content||selectedClip.text?.content||'') : '';

  return <div className="cgn-pro-panel cgn-video-editor">
    <div className="cgn-panel-head"><div><strong>Editor profissional de Reels</strong><p>Timeline real com faixas, corte por alças, prévia interativa e exportação MP4.</p></div><span className="cgn-chip">30 fps</span></div>
    <div className="cgn-video-toolbar"><label className="cgn-upload-button">Adicionar mídia <input type="file" accept="video/*,audio/*,image/*" multiple onChange={e=>filesAdded(e.target.files).catch(err=>showStatus(err.message,true))}/></label>
      <label className="cgn-field cgn-ratio">Proporção<select value={ratio} onChange={e=>{setRatio(e.target.value);showStatus(`Projeto ajustado para ${e.target.value}. O enquadramento não estica a imagem.`);}}>{Object.entries(ASPECTS).map(([k,v])=><option key={k} value={k}>{k} · {v.width}×{v.height}</option>)}</select></label>
      <button onClick={()=>{const clip=selectedClip;if(!clip)return showStatus('Selecione um clipe na timeline.',true);const f=Math.max(0,Math.min(totalFrames-1,currentFrame));const cut=engine.splitClip(clip.id,clip.trackId,f);if(!cut)showStatus('O corte precisa ficar dentro do clipe selecionado.',true);else showStatus('Clipe dividido no indicador da timeline.');}}>✂ Dividir no cursor</button>
      <button onClick={()=>engine.undo()} disabled={!useTracksStore.getState?.().canUndo}>↶ Desfazer</button><button onClick={()=>engine.redo()} disabled={!useTracksStore.getState?.().canRedo}>↷ Refazer</button>
      <button onClick={()=>togglePlayPause()}>{playing?'⏸ Pausar':'▶ Reproduzir'}</button><button onClick={addText}>+ Texto</button><button className="cgn-danger" onClick={clearEditor}>Limpar</button>
    </div>
    <div className="cgn-video-layout">
      <aside className="cgn-video-assets"><h3>Arquivos e camadas</h3><AssetPanel style={{height:350,width:'100%'}} activateOnTap />
        <div className="cgn-tool-group"><b>Modelos de camada e final</b><label className="cgn-field">Guardar seleção como<select value={templateKind} onChange={e=>setTemplateKind(e.target.value)}><option value="overlay">Camada / logo</option><option value="ending">Final do vídeo</option></select></label><button className="cgn-secondary" onClick={()=>saveCurrentAsTemplate().catch(e=>showStatus(e.message,true))}>Salvar selecionado como padrão</button><label className="cgn-field">Modelos salvos<select value={templateChoice} onChange={e=>setTemplateChoice(e.target.value)}><option value="">Escolher mídia...</option>{savedAssets.map(a=><option key={a.id} value={a.id}>{a.kind==='ending'?'Final':'Camada'} · {a.name}</option>)}</select></label><button className="cgn-secondary" onClick={()=>applyTemplate().catch(e=>showStatus(e.message,true))}>Inserir modelo na timeline</button><label className="cgn-check"><input type="checkbox" checked={autoTemplate} onChange={e=>{setAutoTemplate(e.target.checked);localStorage.setItem('cgn-pro-auto-template',e.target.checked?'1':'0');}}/> Aplicar camada e final padrão a novos vídeos</label></div>
      </aside>
      <main className="cgn-video-main">
        <div className="cgn-preview-toolbar"><span>PRÉVIA DO PROJETO</span><span>{(currentSeconds).toFixed(2)}s / {totalSeconds.toFixed(2)}s</span></div>
        <div className="cgn-elah-root"><Preview demuxerFactory={demuxerFactory} enableAudio style={{height:'100%',width:'100%'}} /></div>
        <div className="cgn-timeline-tools"><span>ARRASTE OS CLIPES E AS ALÇAS PARA EDITAR</span><span>Cursor: {currentFrame} quadros</span></div>
        <Timeline fps={FPS} style={{height:280,width:'100%'}} sidebarWidth={170} />
        <div className="cgn-playhead-slider"><label>Posição no projeto <input type="range" min="0" max={Math.max(1,totalFrames)} value={Math.min(currentFrame,totalFrames)} onChange={e=>setCurrentFrame(Number(e.target.value))}/></label><input type="number" min="0" max={totalSeconds||99999} step="0.1" value={currentSeconds.toFixed(1)} onChange={e=>setCurrentFrame(Math.round(Math.max(0,Number(e.target.value)||0)*FPS))}/></div>
      </main>
    </div>
    <details className="cgn-inspector" open><summary>Propriedades, IA, Lip Sync e publicação</summary>
      {selectedClip&&<div className="cgn-inspector-grid"><div className="cgn-tool-group"><b>Clipe selecionado</b><p className="cgn-note">{selectedClip.name||selectedClip.type} · início {(framesToSeconds(selectedClip.startFrame)).toFixed(2)}s · duração {(framesToSeconds(selectedClip.durationFrames)).toFixed(2)}s</p><button className="cgn-secondary" onClick={()=>{engine.cloneClip(selectedClip.id,selectedClip.trackId);showStatus('Clipe duplicado.');}}>Duplicar clipe</button><button className="cgn-danger" onClick={()=>{engine.removeClip(selectedClip.id,selectedClip.trackId);showStatus('Clipe removido.');}}>Excluir clipe</button></div>
        {selectedClip.type==='text'&&<div className="cgn-tool-group"><b>Texto selecionado</b><label className="cgn-field">Conteúdo<input value={actualSelectedText} onChange={e=>updateSelectedText('content',e.target.value)}/></label><label className="cgn-field">Tamanho<input type="range" min="18" max="180" value={Number(selectedClip.fontSize||72)} onChange={e=>updateSelectedText('fontSize',e.target.value)}/></label><label className="cgn-field">Cor<input type="color" value={selectedClip.color||'#ffffff'} onChange={e=>updateSelectedText('color',e.target.value)}/></label></div>}
      </div>}
      <div className="cgn-inspector-grid">
        <div className="cgn-tool-group"><b>IA do Central Goiano</b><button className="cgn-secondary" disabled={analysisBusy} onClick={()=>analyzeVideo().catch(e=>showStatus(e.message,true))}>{analysisBusy?'Analisando…':'Transcrever vídeo e gerar título/legenda'}</button><label className="cgn-field">Título<input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Título do Reels"/></label><label className="cgn-field">Transcrição<textarea rows="4" value={transcript} onChange={e=>setTranscript(e.target.value)}/></label><label className="cgn-field">Legenda editável<textarea rows="5" value={caption} onChange={e=>setCaption(e.target.value)}/></label></div>
        <div className="cgn-tool-group cgn-lipsync"><b>Sincronização labial com IA</b><p>Envia o vídeo selecionado e um áudio de referência ao modelo de lip sync. O vídeo retornado substitui o clipe na timeline, sem mexer nas outras faixas.</p><label className="cgn-upload-button cgn-audio-upload">Escolher áudio para sincronizar<input type="file" accept="audio/*" onChange={e=>setAudioFile(e.target.files?.[0]||null)}/></label><p className="cgn-note">{audioFile?audioFile.name:'Selecione uma fala/locução. O áudio será usado para orientar o movimento da boca.'}</p><button className="cgn-primary" disabled={lipSyncBusy} onClick={()=>lipSync().catch(e=>showStatus(e.message,true))}>{lipSyncBusy?'Sincronizando… pode levar alguns minutos':'Executar Lip Sync IA'}</button><small>Requer a variável FAL_KEY no Environment do Render. O serviço pode ter cobrança por uso.</small></div>
      </div>
    </details>
    <div className="cgn-project-bar"><label className="cgn-field">Nome do projeto<input value={projectName} onChange={e=>setProjectName(e.target.value)}/></label><button className="cgn-secondary" onClick={()=>storeProject().catch(e=>showStatus(e.message,true))}>Salvar projeto + mídias</button><label className="cgn-field">Projetos salvos<select value={savedChoice} onChange={e=>setSavedChoice(e.target.value)}><option value="">Escolher projeto local</option>{savedProjects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button className="cgn-secondary" onClick={()=>loadProjectFromRecord().catch(e=>showStatus(e.message,true))} disabled={!savedChoice}>Abrir</button><label className="cgn-upload-button">Importar .cgnstudio<input type="file" accept=".cgnstudio,application/x-cgnstudio,application/zip" onChange={e=>e.target.files?.[0]&&loadProjectFile(e.target.files[0]).catch(err=>showStatus(err.message,true))}/></label></div>
    <div className="cgn-video-footer"><div className={error?'cgn-status cgn-status-error':'cgn-status'}>{status}</div>{exportBusy&&<div className="cgn-progress"><span style={{width:`${exportProgress}%`}}/></div>}<div className="cgn-final-actions"><button className="cgn-primary" disabled={exportBusy} onClick={()=>exportVideo().catch(()=>{})}>{exportBusy?`Exportando ${exportProgress}%…`:'Exportar MP4 final'}</button><button className="cgn-publish" disabled={exportBusy} onClick={()=>publish().catch(e=>showStatus(e.message,true))}>Publicar Reels no destino selecionado</button></div></div>
  </div>;
}
function VideoEditorHost(){ return <EditorProvider fps={FPS} stage={ASPECTS['9:16']} initialTracks={TRACKS}><div className="elah-root cgn-elah-shell"><VideoEditor/></div></EditorProvider>; }
function safeFilename(value){return String(value||'cgn-projeto').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9-_]+/gi,'-').replace(/^-|-$/g,'').slice(0,80)||'cgn-projeto';}
function mount(hostId, component) {
  const host=document.getElementById(hostId);if(!host)return false;
  let root=mountedRoots.get(hostId);if(!root){root=createRoot(host);mountedRoots.set(hostId,root);}
  root.render(React.createElement(component));return true;
}
window.CGNStudioEditor={mountArt:()=>mount('cgnArtProEditorMount',ArtEditor),mountVideo:()=>mount('cgnStudioReelsProMount',VideoEditorHost)};
function Root(){return <div className="cgn-embed-root"><p>O editor é carregado dentro do modal do Studio Card. Feche esta página e abra Artes ou Reels no modal original.</p></div>;}
const rootEl=document.getElementById('root');if(rootEl)createRoot(rootEl).render(<Root/>);
