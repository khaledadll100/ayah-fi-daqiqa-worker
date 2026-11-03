// worker.js — العامل المجدول لـ «آية في دقيقة»
// يفحص المهام المستحقة، يفتح المولّد في متصفح بلا شاشة، ينتج الفيديوهات بصيغة MP4
// (التحويل يتم داخل المتصفح نفسه) ويرفعها مباشرة إلى موقع النشر. لا تحويل خارجي ولا curl.
//
// متغيرات البيئة:
//   SITE_URL         رابط المولّد، مثال: https://khaled.elevatefollowers.com
//   AYAH_API_KEY     مفتاح العامل (نفس WORKER_API_KEY في worker-api.php)
//   MAX_RUN_MINUTES  اختياري، أقصى مدة لتنفيذ مهمة واحدة (الافتراضي 150)
const { chromium } = require('playwright');

const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');
const KEY = process.env.AYAH_API_KEY || '';
const MAX_MIN = Number(process.env.MAX_RUN_MINUTES || 150);
if (!SITE_URL || !KEY) { console.error('SITE_URL و AYAH_API_KEY مطلوبان'); process.exit(2); }

async function api(query, opts = {}) {
  const r = await fetch(SITE_URL + '/worker-api.php' + query, {
    ...opts,
    headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('HTTP ' + r.status + ': ' + text.slice(0, 200)); }
  if (!r.ok || j.success === false) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

async function finish(id, status, result) {
  try {
    await api('', { method: 'POST', body: JSON.stringify({ action: 'finish', task_id: id, status, result }) });
  } catch (e) { console.error('تعذر إرسال النتيجة:', e.message); }
}

async function pickByText(page, selector, text) {
  const el = page.locator(selector);
  await el.waitFor({ state: 'visible', timeout: 15000 });
  const opts = await el.locator('option').allTextContents();
  const wanted = String(text || '').trim();
  const m = opts.find((x) => x.trim() === wanted) || opts.find((x) => x.trim().includes(wanted));
  if (!m) throw new Error(`الخيار غير موجود في ${selector}: ${wanted}`);
  await el.selectOption({ label: m.trim() });
}

async function report(id, result) {
  try { await api('', { method: 'POST', body: JSON.stringify({ action: 'progress', task_id: id, result }) }); }
  catch (e) { console.error('تعذر إرسال التقدم:', e.message); }
}

async function runTask(task) {
  const p = task.payload;
  const vpv = Math.max(1, Number(p.verses_per_video || 1));
  const expected = Math.ceil((Number(p.to_ayah) - Number(p.from_ayah) + 1) / vpv);
  const deadline = Date.now() + MAX_MIN * 60 * 1000;

  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1080, height: 1920 } });
    // عدّاد لنتائج الرفع إلى موقع النشر (ok / fail) لنتأكد أن كل فيديو وصل فعلاً
    await context.addInitScript(({ ep }) => {
      window.__up = { ok: 0, fail: 0 };
      const orig = window.fetch.bind(window);
      window.fetch = async (u, o) => {
        const isUp = String(u) === ep && o && o.method === 'POST';
        const res = await orig(u, o).catch((e) => { if (isUp) window.__up.fail++; throw e; });
        if (isUp) {
          res.clone().json()
            .then((j) => { (j && (j.ok || j.success)) ? window.__up.ok++ : window.__up.fail++; })
            .catch(() => { window.__up.fail++; });
        }
        return res;
      };
    }, { ep: p.destination_endpoint });

    const page = await context.newPage();
    page.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'error' || /ffmpeg|upload|رفع/i.test(t)) console.log('[BROWSER]', m.type(), t.slice(0, 300));
    });

    await page.goto(SITE_URL + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(10000);

    // إعدادات الرفع المباشر لموقع النشر (بدون أي نسخة محلية)
    await page.evaluate(({ ep, key }) => {
      const setVal = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
      const setChk = (id, v) => { const e = document.getElementById(id); e.checked = v; e.dispatchEvent(new Event('change', { bubbles: true })); };
      setVal('hostEndpoint', ep);
      setVal('hostApiKey', key);
      setChk('hostAutoUpload', true);
      setChk('hostKeepLocal', false);
    }, { ep: p.destination_endpoint, key: p.destination_api_key });

    // أقسام اللوحة مطوية افتراضياً في أي متصفح جديد، فالزر يكون مخفياً؛ نضغطه برمجياً دون انتظار ظهوره
    await page.locator('#btnOpenAutoGen').waitFor({ state: 'attached', timeout: 30000 });
    await page.evaluate(() => document.getElementById('btnOpenAutoGen').click());
    await page.locator('#autoGenModal').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(1500);

    await page.locator('#agSurah').selectOption(String(p.surah));
    await pickByText(page, '#agReciter', p.reciter);
    await pickByText(page, '#agTranslationSelect', p.translation || 'بدون ترجمة');
    await pickByText(page, '#agTafsirSelect', p.tafsir || 'بدون تفسير');
    await page.locator('#agVpv').selectOption(String(vpv));
    await page.locator('#agFormat').selectOption('mp4');
    if (!p.background_url && !p.random_background && p.background_label && !p.background_label.includes('استخدم الخلفية الحالية')) {
      await pickByText(page, '#agBackgroundSelect', p.background_label.split('·')[0].trim());
    }
    // Restore the design snapshot captured when the task was created.
    // Never assume this fresh browser has the user's original localStorage.
    await page.evaluate(async (p) => {
      const d = p.design_settings || {};
      const select = (id, value) => {
        if (value === undefined || value === null) return;
        const el = document.getElementById(id);
        if (!el || !Array.from(el.options || []).some(o => o.value === String(value)))
          throw new Error(`إعداد غير متاح في المولد: ${id} = ${value}`);
        el.value = String(value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const check = (id, value) => {
        if (value === undefined || value === null) return;
        const el = document.getElementById(id);
        if (!el) throw new Error(`إعداد غير متاح: ${id}`);
        el.checked = Boolean(value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const urlOk = (u, label) => {
        if (u && /^(blob:|data:|file:)/i.test(u)) throw new Error(`رابط ${label} مؤقت ولا يصلح للتشغيل السحابي`);
      };
      if (d.active_template && !p.cinematic_auto_enabled) applyTemplate(d.active_template);
      if (d.text) applyTextSettings(d.text);
      if (d.translation_text) applyTranslationSettings(d.translation_text);
      if (d.tafsir_text) applyTafsirSettings(d.tafsir_text);
      if (d.layout) applyLayoutSettings(d.layout);
      if (d.meta_visibility) applyMetaVisibilitySettings(d.meta_visibility);
      if (d.surah_chip) applySurahChipSettings(d.surah_chip);
      if (d.reciter_chip) applyReciterChipSettings(d.reciter_chip);
      if (d.ayah_card) applyTextCardSettings('ayah', d.ayah_card);
      if (d.translation_card) applyTextCardSettings('translation', d.translation_card);
      if (d.tafsir_card) applyTextCardSettings('tafsir', d.tafsir_card);
      if (d.neon) applyNeonSettings(d.neon);
      if (d.audio) { Object.assign(state.audioSettings, d.audio); applyAudioSettings(d.audio); }
      else if (p.audio_volume != null) applyAudioSettings({volume: Number(p.audio_volume)});
      const ambient = d.ambient || {};
      const ambientOn = p.ambient_audio_enabled ?? ambient.enabled;
      const ambientUrl = p.ambient_audio_url || ambient.url || 'assets/audio/birds-ambience.wav';
      urlOk(ambientOn ? ambientUrl : '', 'الصوت المصاحب');
      if (ambientOn) {
        const response = await fetch(ambientUrl, {method:'GET'});
        if (!response.ok) throw new Error(`تعذر الوصول للصوت المصاحب: HTTP ${response.status}`);
      }
      state.ambientAudio.enabled = !!ambientOn;
      state.ambientAudio.url = ambientUrl;
      state.ambientAudio.volume = Number(p.ambient_audio_volume ?? ambient.volume ?? .18);
      const logo = d.logo || {};
      const logoUrl = p.logo_url || logo.url || '';
      const logoOn = p.logo_enabled ?? logo.enabled;
      urlOk(logoOn ? logoUrl : '', 'الشعار');
      if (logoOn && !logoUrl) throw new Error('الشعار مفعّل لكن رابطه غير محفوظ');
      if (logoOn) await selectStoredLogo(logoUrl);
      Object.assign(state.logoSettings, logo);
      applyLogoSettings({ enabled: !!logoOn,
        size: Number(p.logo_size ?? logo.size ?? 12),
        opacity: Number(p.logo_opacity ?? logo.opacity ?? 90),
        position: p.logo_position || logo.position || 'tr' });
      applyLogoNeonSettings({
        color: p.logo_neon_color ?? logo.neonColor ?? '#21c3a0',
        intensity: Number(p.logo_neon_intensity ?? logo.neonIntensity ?? 60),
        speed: Number(p.logo_neon_speed ?? logo.neonSpeed ?? 4),
        animate: Boolean(p.logo_neon_animate ?? logo.neonAnimate ?? true)
      });
      if (p.cinematic_font) {
        if (!FONT_CHOICES[p.cinematic_font]) throw new Error('الخط المختار لم يعد متاحًا');
        applyChoiceFont(p.cinematic_font, 'cinematic');
      }
      if (p.cinematic_font_size != null) {
        state.cinematicFontSize = Number(p.cinematic_font_size);
        applyTextSettings({size: state.cinematicFontSize});
      }
      if (p.cinematic_ornament) state.cinematicOrnament = p.cinematic_ornament;
      syncDirectFontControls();
      check('agFixedCoverRandom', p.fixed_cover_random);
      select('agFixedCoverStyle', p.fixed_cover_style);
      select('agVisualFxStyle', p.visual_fx_style);
      check('agVisualFxEnabled', p.visual_fx_enabled);
      check('agVisualFxRandom', p.visual_fx_random);
      if (p.visual_fx_intensity != null) {
        const el = document.getElementById('agVisualFxIntensity');
        el.value = String(p.visual_fx_intensity);
        el.dispatchEvent(new Event('input', {bubbles:true}));
      }
      check('agCinematicAutoEnabled', p.cinematic_auto_enabled);
      check('agCinematicFontLock', p.cinematic_font_locked);
      agUpdateCinematicAutoUi();
      // Stable background lookup; do not quietly accept a different background.
      if (!p.random_background && p.background_url) {
        urlOk(p.background_url, 'الخلفية');
        const normalize = url => new URL(url, location.href).href.split('?')[0];
        const idx = agBgPool().findIndex(item => item.src && normalize(item.src) === normalize(p.background_url));
        if (idx < 0) throw new Error('الخلفية المختارة غير موجودة في مكتبة المولد السحابية');
        const bgSelect = document.getElementById('agBackgroundSelect');
        bgSelect.value = String(idx);
        agSelectedBgIndex = idx;
      }
      // Use identical font before recording, not a browser's default fallback.
      const font = state.textSettings?.font || p.cinematic_font;
      if (font) {
        const family = getChoiceFontFamily(font);
        if (family) await document.fonts.load(`40px ${family}`, 'بِسْمِ اللَّهِ');
        await document.fonts.ready;
      }
    }, p);

    await page.locator('#agFrom').fill(String(p.from_ayah));
    await page.locator('#agTo').fill(String(p.to_ayah));
    const randomBtn = page.locator('#agRandomBgBtn');
    if (await randomBtn.count()) {
      const enabled = (await randomBtn.innerText()).includes('مفعّل');
      if (Boolean(p.random_background) !== enabled) await randomBtn.click({ force: true });
    }

    await page.locator('#agBuildQueue').click({ force: true });
    await page.waitForTimeout(12000);
    await page.locator('#agBtnProduce').click({ force: true });

    // انتظار نهاية الإنتاج (رسائل #agProdMsg)
    let finalMsg = '';
    let lastSent = '';
    while (Date.now() < deadline) {
      await page.waitForTimeout(5000);
      const msg = await page.locator('#agProdMsg').innerText().catch(() => '');
      if (/تم إنتاج جميع|اكتمل الإنتاج|تم الإيقاف/.test(msg)) { finalMsg = msg; break; }
      // إرسال التقدم للموقع ليظهر في قائمة المهام (فقط عند تغيّره)
      const upNow = await page.evaluate(() => window.__up).catch(() => ({ ok: 0, fail: 0 }));
      const progress = `جارٍ الإنتاج — تم رفع ${upNow.ok} من ${expected}` + (msg ? ' — ' + msg.replace(/\s+/g, ' ').slice(0, 120) : '');
      if (progress !== lastSent) { lastSent = progress; await report(task.id, { progress, uploaded: upNow.ok, expected }); }
    }
    if (!finalMsg) throw new Error('انتهت المهلة قبل اكتمال الإنتاج');

    // انتظار وصول آخر الفيديوهات إلى موقع النشر (حتى 6 دقائق)
    const upDeadline = Math.min(deadline, Date.now() + 6 * 60 * 1000);
    let up = { ok: 0, fail: 0 };
    while (Date.now() < upDeadline) {
      up = await page.evaluate(() => window.__up);
      if (up.ok >= expected) break;
      await page.waitForTimeout(3000);
    }
    const result = { expected, uploaded: up.ok, failed_attempts: up.fail, message: finalMsg };
    console.log('RESULT', JSON.stringify(result));
    if (up.ok < expected) throw new Error(`رُفع ${up.ok} من ${expected} فيديو. ${finalMsg}`);
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}

(async () => {
  const { task } = await api('?action=claim');
  if (!task) { console.log('لا توجد مهام مستحقة الآن'); return; }
  console.log('تنفيذ المهمة', task.id);
  try {
    const result = await runTask(task);
    await finish(task.id, 'done', result);
  } catch (e) {
    console.error(e);
    await finish(task.id, 'failed', { message: String((e && e.message) || e).slice(0, 1800) });
    process.exitCode = 1;
  }
})();
