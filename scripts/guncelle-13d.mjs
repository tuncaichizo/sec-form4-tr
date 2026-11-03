// Refreshes son-13d.json with SEC Schedule 13D / 13G beneficial-ownership filings (>5 % stakes), no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UA = process.env.SEC_UA;
if (!UA) {
  console.error('SEC_UA is not set (contact string for the SEC User-Agent header)');
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const IGNORE_STATE = args.includes('--ignore-state');
const li = args.indexOf('--limit');
const LIMIT = li >= 0 ? parseInt(args[li + 1], 10) : Infinity;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const F_REC = path.join(ROOT, 'son-13d.json');
const F_STATE = path.join(ROOT, 'durum-13d.json');
const feedUrl = (t) => `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=SCHEDULE%20${t}&dateb=&owner=include&count=100&output=atom`;
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
// type= is a prefix filter, so titles are checked exactly below.
const MAX_PAGES = 3, MAX_RECORDS = 50, MAX_SEEN = 20000;
const FORMS = { 'SCHEDULE 13D - ': ['13D', false], 'SCHEDULE 13D/A - ': ['13D', true], 'SCHEDULE 13G - ': ['13G', false], 'SCHEDULE 13G/A - ': ['13G', true] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One request at a time, 150 ms spacing, one retry after 2 s on 429/5xx/network error.
async function get(url) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(2000);
    await sleep(150);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
      if (res.ok) return await res.text();
      lastErr = new Error(`HTTP ${res.status}`);
      if (!(res.status === 429 || res.status >= 500)) throw lastErr;
    } catch (e) {
      lastErr = e;
      if (/^HTTP (?!429)[1-4]/.test(e.message)) throw e;
    }
  }
  throw lastErr;
}

// Filing times are stored as UTC with a trailing Z, no milliseconds (feed times carry an ET offset).
const toUtcZ = (x) => { const t = new Date(x); return Number.isNaN(t.getTime()) ? x : t.toISOString().replace(/\.\d{3}Z$/, 'Z'); };
const accOf = (link) => ((link || '').match(/(\d{10}-\d{2}-\d{6})-index\.htm/) || [])[1] || link;
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n');

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1].trim()) : ''; };
const blocks = (xml, name) => [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi'))].map((m) => m[1]);

// Feed: one entry per (filing, role); a filing shows up as "(Subject)" and as "(Filed by)".
function parseFeed(xml) {
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const title = decode((e.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '').trim();
    const key = Object.keys(FORMS).find((k) => title.startsWith(k));
    if (!key) continue;
    const link = decode((e.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '');
    const updated = ((e.match(/<updated>([\s\S]*?)<\/updated>/) || [])[1] || '').trim();
    const acc = accOf(link);
    if (!/^\d{10}-\d{2}-\d{6}$/.test(acc)) continue;
    const r = title.slice(key.length).match(/^(.*) \((\d{10})\) \((Subject|Filed by)\)$/);
    if (!r) continue;
    out.push({ acc, tur: FORMS[key][0], degisiklik: FORMS[key][1], updated, name: r[1], cik: String(+r[2]), role: r[3] });
  }
  return out;
}

const mdy = (s) => { const m = (s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };

// Schedule 13D (2024+ XML): cover <dateOfEvent>, <issuerCIK>, <issuerName>, one <reportingPersonInfo> per person
//   with <reportingPersonName> and <percentOfClass>.
// Schedule 13G (2024+ XML): cover <eventDateRequiresFilingThisStatement>, <issuerCik>, <issuerName>, one
//   <coverPageHeaderReportingPersonDetails> per person with <reportingPersonName> and <classPercent>.
// pay_yuzde = the MAXIMUM percent of class over the reporting persons (they often report the same stake or a
// group total); null when the XML has no percent. Nothing is ever computed.
function parseXml(xml, tur) {
  const people = blocks(xml, tur === '13D' ? 'reportingPersonInfo' : 'coverPageHeaderReportingPersonDetails');
  const names = [], pcts = [];
  for (const p of people) {
    const n = tag(p, 'reportingPersonName');
    if (n && !names.includes(n)) names.push(n);
    const v = parseFloat(tag(p, tur === '13D' ? 'percentOfClass' : 'classPercent').replace('%', '').replace(/,/g, ''));
    if (Number.isFinite(v)) pcts.push(v);
  }
  const cover = blocks(xml, 'coverPageHeader')[0] || '';
  return {
    tarih: mdy(tag(cover, tur === '13D' ? 'dateOfEvent' : 'eventDateRequiresFilingThisStatement')),
    cik: String(+(tag(cover, 'issuerCIK') || 0)) || '',
    sirket: tag(cover, 'issuerName'),
    names,
    pay: pcts.length ? Math.max(...pcts) : null,
  };
}

async function loadTickers() {
  const j = JSON.parse(await get(TICKERS_URL));
  const m = new Map();
  for (const v of Object.values(j)) if (v.ticker && !m.has(String(v.cik_str))) m.set(String(v.cik_str), v.ticker);
  return m;
}

async function main() {
  const state = readJson(F_STATE, { ilk_kosu_tamam: false, gorulen: [] });
  const store = readJson(F_REC, { guncellendi: null, kayitlar: [] });
  const firstRun = !state.ilk_kosu_tamam && !IGNORE_STATE;
  const seen = new Set(IGNORE_STATE ? [] : state.gorulen);

  // Per form type: page until a page holds an already-seen accession. Merge Subject/Filed-by rows per accession.
  const filings = new Map();
  let pages = 0;
  for (const t of ['13D', '13G']) {
    let reachedSeen = false;
    for (let p = 0; p < MAX_PAGES; p++) {
      const list = parseFeed(await get(feedUrl(t) + (p ? `&start=${p * 100}` : '')));
      pages++;
      for (const e of list) {
        if (seen.has(e.acc)) reachedSeen = true;
        const f = filings.get(e.acc) || { acc: e.acc, tur: e.tur, degisiklik: e.degisiklik, updated: e.updated };
        if (e.role === 'Subject') { f.subjName = e.name; f.subjCik = e.cik; } else { f.byName = e.name; f.byCik = e.cik; }
        filings.set(e.acc, f);
      }
      if (reachedSeen || !list.length) break;
    }
    if (!firstRun && !IGNORE_STATE && !reachedSeen) console.log(`warning: ${t}: no known filing within ${MAX_PAGES} pages, some may have been missed`);
  }
  if (firstRun) console.log(`first run: processing all ${filings.size} filings`);

  // Oldest first (feed is newest first); a filing with no feed timestamp cannot be placed, skip it unmarked.
  let fresh = [...filings.values()].filter((f) => !seen.has(f.acc) && f.updated).sort((a, b) => new Date(a.updated) - new Date(b.updated));
  if (fresh.length > LIMIT) fresh = fresh.slice(0, LIMIT);
  const tickers = fresh.length ? await loadTickers() : new Map();

  const added = [];
  let processed = 0, skipped = 0;
  for (const f of fresh) {
    try {
      const idxCik = f.subjCik || f.byCik;
      const idxUrl = `https://www.sec.gov/Archives/edgar/data/${idxCik}/${f.acc.replace(/-/g, '')}/${f.acc}-index.htm`;
      const idx = await get(idxUrl);
      const hrefs = [...idx.matchAll(/href="([^"]+\.xml)"/gi)].map((m) => m[1]).filter((h) => !/xsl/i.test(h));
      let x = { tarih: null, cik: '', sirket: '', names: [], pay: null };
      if (hrefs.length) {
        const u = hrefs[0].startsWith('http') ? hrefs[0] : 'https://www.sec.gov' + hrefs[0];
        x = parseXml(await get(u), f.tur);
      }
      const cik = x.cik || f.subjCik || '';
      const ticker = tickers.get(cik);
      seen.add(f.acc); // permanent, also when skipped as not listed
      processed++;
      if (!ticker) { skipped++; continue; }
      const names = x.names.length ? x.names : (f.byName ? [f.byName] : []);
      if (!names.length) { skipped++; continue; }
      added.push({
        tarih: x.tarih, dosyalama: toUtcZ(f.updated), ticker, sirket: x.sirket || f.subjName || '',
        bildiren: names.length > 1 ? `${names[0]} ve diğerleri` : names[0],
        pay_yuzde: x.pay, tur: f.tur, degisiklik: f.degisiklik,
        sec_link: `https://www.sec.gov/Archives/edgar/data/${cik}/${f.acc.replace(/-/g, '')}/${f.acc}-index.htm`,
      });
    } catch (err) {
      console.log(`error ${f.acc}: ${err.message}`);
    }
  }

  console.log(`summary: pages=${pages} new_filings=${fresh.length} no_ticker_skipped=${skipped} records_added=${added.length}`);
  if (DRY) { for (const r of added) console.log(JSON.stringify(r)); return; }
  if (!processed) return;

  const byAcc = new Map();
  for (const r of [...added, ...store.kayitlar]) { const k = accOf(r.sec_link); if (!byAcc.has(k)) byAcc.set(k, r); }
  const kayitlar = [...byAcc.values()].sort((a, b) => new Date(b.dosyalama) - new Date(a.dosyalama)).slice(0, MAX_RECORDS);
  // Write only when the list changed (no commit noise).
  if (JSON.stringify(kayitlar) !== JSON.stringify(store.kayitlar)) writeJson(F_REC, { guncellendi: new Date().toISOString(), kayitlar });
  writeJson(F_STATE, { ilk_kosu_tamam: true, gorulen: [...seen].slice(-MAX_SEEN) });
}

main().catch((e) => { console.error(e); process.exit(1); });
