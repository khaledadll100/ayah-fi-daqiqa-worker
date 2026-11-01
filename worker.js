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
    if (!p.random_background && p.background_label && !p.background_label.includes('استخدم الخلفية الحالية')) {
      await pickByText(page, '#agBackgroundSelect', p.background_label.split('·')[0].trim());
    }
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
