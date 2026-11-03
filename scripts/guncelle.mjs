// Refreshes son-islemler.json with SEC Form 4 insider trades (>= $1M), no dependencies.
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
const GUNLUK = args.includes('--gunluk') || process.env.GUNLUK === 'true';
const li = args.indexOf('--limit');
const LIMIT = li >= 0 ? parseInt(args[li + 1], 10) : Infinity;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const F_REC = path.join(ROOT, 'son-islemler.json');
const F_STATE = path.join(ROOT, 'durum.json');
const FEED = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=100&output=atom';
// type=4 is a prefix filter (424B2, 497K… come too): ~10-15 Form 4 per 100 entries, hence up to 10 pages.
const MAX_PAGES = 10, MAX_RECORDS = 50, MAX_SEEN = 20000, THRESHOLD = 1_000_000;
const MAX_TXT = 1500, GUNLUK_DAYS = 4;

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

// Filing times are stored as UTC with a trailing Z, no milliseconds.
const toUtcZ = (x) => { const t = new Date(x); return Number.isNaN(t.getTime()) ? x : t.toISOString().replace(/\.\d{3}Z$/, 'Z'); };

// US Eastern wall time -> UTC ms (DST-aware via Intl, no hard-coded offset).
const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function etParts(ms) {
  const p = Object.fromEntries(etFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return [+p.year, +p.month, +p.day, +p.hour, +p.minute, +p.second];
}
function etToUtc(y, mo, d, h, mi, sec) {
  const base = Date.UTC(y, mo - 1, d, h, mi, sec);
  for (const off of [4, 5]) {
    const t = base + off * 3600000;
    if (etParts(t).join() === [y, mo, d, h, mi, sec].join()) return t;
  }
  return null;
}

// Accession (dashed) from an index link; falls back to the full link.
const accOf = (link) => ((link || '').match(/(\d{10}-\d{2}-\d{6})-index\.htm/) || [])[1] || link;

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n');

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1].trim()) : ''; };
// Value inside a wrapper tag, e.g. <transactionShares><value>10</value></transactionShares>.
const val = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? tag(m[1], 'value') : ''; };

function parseFeed(xml) {
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const title = decode((e.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '').trim();
    if (!title.startsWith('4 - ')) continue;
    const link = decode((e.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '');
    const updated = ((e.match(/<updated>([\s\S]*?)<\/updated>/) || [])[1] || '').trim();
    const a = link.match(/(\d{10}-?\d{2}-?\d{6})/);
    if (!a) continue;
    const d = a[1].replace(/-/g, '');
    out.push({ acc: `${d.slice(0, 10)}-${d.slice(10, 12)}-${d.slice(12)}`, link, updated });
  }
  return out;
}

function parseFiling(xml) {
  const ticker = tag(xml, 'issuerTradingSymbol').toUpperCase();
  const sirket = tag(xml, 'issuerName');
  const owner = (xml.match(/<reportingOwner>([\s\S]*?)<\/reportingOwner>/) || [])[1] || '';
  const kisi = tag(owner, 'rptOwnerName');
  const isTrue = (n) => /^(1|true)$/i.test(tag(owner, n));
  const unvan = tag(owner, 'officerTitle') || (isTrue('isDirector') ? 'Director' : isTrue('isTenPercentOwner') ? '10% Owner' : tag(owner, 'otherText'));
  const sides = { P: { shares: 0, usd: 0, date: '' }, S: { shares: 0, usd: 0, date: '' } };
  const nd = (xml.match(/<nonDerivativeTable>([\s\S]*?)<\/nonDerivativeTable>/) || [])[1] || '';
  for (const m of nd.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)) {
    const t = m[1];
    const code = tag(t, 'transactionCode');
    if (code !== 'P' && code !== 'S') continue;
    const shares = Number(val(t, 'transactionShares'));
    const price = Number(val(t, 'transactionPricePerShare'));
    if (!Number.isFinite(shares) || !Number.isFinite(price) || price <= 0) continue;
    const s = sides[code];
    s.shares += shares; s.usd += shares * price;
    const d = val(t, 'transactionDate').slice(0, 10);
    if (d > s.date) s.date = d;
  }
  return { ticker, sirket, kisi, unvan, sides };
}

// Builds the record for the dominant side of a parsed filing (logs sides), or null.
function mkRecord(acc, f, dosyalama, link) {
  const buy = f.sides.P, sell = f.sides.S;
  for (const [code, s] of [['P', buy], ['S', sell]]) {
    if (s.shares > 0) console.log(`${acc} ${f.ticker} ${code === 'P' ? 'alim' : 'satim'} ${s.usd.toFixed(2)}`);
  }
  const dom = buy.usd >= sell.usd ? buy : sell;
  // Issuers without a listed symbol report "N/A" / "NONE": not a stock a reader can look up, skip.
  const listed = /^[A-Z0-9.\-]{1,10}$/.test(f.ticker) && f.ticker !== 'NONE';
  if (!(listed && dom.shares > 0 && dom.usd >= THRESHOLD)) return null;
  return {
    tarih: dom.date, dosyalama: toUtcZ(dosyalama), ticker: f.ticker, sirket: f.sirket, kisi: f.kisi, unvan: f.unvan,
    tur: dom === buy ? 'alim' : 'satim', adet: dom.shares,
    fiyat: Math.round((dom.usd / dom.shares) * 1e4) / 1e4, toplam_usd: Math.round(dom.usd * 100) / 100,
    sec_link: link,
  };
}

// Daily completion pass: Form 4 rows of the last days from the EDGAR daily index, full .txt submission per unseen accession.
async function gunlukPass(seen, added) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  let days = 0, rows = 0;
  const todo = new Map(); // acc -> file name, oldest date first
  for (let k = GUNLUK_DAYS; k >= 1; k--) {
    const d = new Date(today.getTime() - k * 86400000);
    const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1;
    const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
    let txt;
    try {
      txt = await get(`https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${Math.ceil(mo / 3)}/form.${ymd}.idx`);
    } catch (e) {
      if (/^HTTP (404|403)$/.test(e.message)) continue; // weekend / holiday
      console.log(`error daily-index ${ymd}: ${e.message}`); continue;
    }
    days++;
    for (const line of txt.split(/\r?\n/)) {
      if (!line.startsWith('4 ')) continue; // exactly form type 4 (not 4/A)
      const m = line.match(/(edgar\/data\/\d+\/(\d{10}-\d{2}-\d{6})\.txt)\s*$/);
      if (!m) continue;
      rows++;
      if (!todo.has(m[2])) todo.set(m[2], m[1]);
    }
  }
  let unseen = [...todo].filter(([acc]) => !seen.has(acc));
  const cap = Math.min(MAX_TXT, LIMIT);
  if (unseen.length > cap) { console.log(`gunluk: capped at ${cap} of ${unseen.length} unseen`); unseen = unseen.slice(0, cap); }
  let fetched = 0, recs = 0;
  for (const [acc, file] of unseen) {
    try {
      const sub = await get('https://www.sec.gov/Archives/' + file);
      fetched++;
      const own = (sub.match(/<ownershipDocument>[\s\S]*?<\/ownershipDocument>/) || [])[0];
      if (own) {
        const am = sub.match(/<ACCEPTANCE-DATETIME>(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
        const ms = am ? etToUtc(+am[1], +am[2], +am[3], +am[4], +am[5], +am[6]) : null;
        if (ms === null) throw new Error('no acceptance time');
        const cik = file.split('/')[2];
        const link = `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}/${acc}-index.htm`;
        const r = mkRecord(acc, parseFiling(own), new Date(ms).toISOString(), link);
        if (r) { added.push(r); recs++; }
      }
      seen.add(acc); // also when there is no ownershipDocument (permanent)
    } catch (err) {
      console.log(`error ${acc}: ${err.message}`);
    }
  }
  console.log(`gunluk: days=${days} rows=${rows} unseen=${unseen.length} fetched=${fetched} records_added=${recs}`);
  return fetched;
}

async function main() {
  const state = readJson(F_STATE, { ilk_kosu_tamam: false, gorulen: [] });
  const store = readJson(F_REC, { guncellendi: null, kayitlar: [] });
  const firstRun = !state.ilk_kosu_tamam && !IGNORE_STATE;
  const seen = new Set(IGNORE_STATE ? [] : state.gorulen);
  // One-time, idempotent migration: filing times to UTC Z.
  let migrated = false;
  for (const r of store.kayitlar) { const z = toUtcZ(r.dosyalama); if (z !== r.dosyalama) { r.dosyalama = z; migrated = true; } }

  // Collect feed entries; stop paging once a page contains an already-seen accession.
  const entries = new Map();
  let pages = 0, reachedSeen = false;
  for (let p = 0; p < MAX_PAGES; p++) {
    const xml = await get(FEED + (p ? `&start=${p * 100}` : ''));
    pages++;
    const list = parseFeed(xml);
    for (const e of list) {
      if (seen.has(e.acc)) reachedSeen = true;
      if (!entries.has(e.acc)) entries.set(e.acc, e);
    }
    if (reachedSeen || !list.length) break;
  }
  if (!firstRun && !IGNORE_STATE && !reachedSeen) console.log(`warning: no known filing within ${pages} pages, some may have been missed`);

  const now = new Date().toISOString();
  if (firstRun) console.log(`first run: processing all ${entries.size} filings on ${pages} pages`);

  // New filings, oldest first (feed is newest first). On the first run that is every filing read, so the list starts filled.
  let fresh = [...entries.values()].filter((e) => !seen.has(e.acc)).reverse();
  if (fresh.length > LIMIT) fresh = fresh.slice(0, LIMIT);
  const added = [];
  let processed = 0;
  for (const e of fresh) {
    try {
      const idx = await get(e.link);
      const hrefs = [...idx.matchAll(/href="([^"]+\.xml)"/gi)].map((m) => m[1]).filter((h) => !h.includes('xslF345'));
      if (!hrefs.length) throw new Error('no xml link in index');
      const xmlUrl = hrefs[0].startsWith('http') ? hrefs[0] : 'https://www.sec.gov' + hrefs[0];
      const f = parseFiling(await get(xmlUrl));
      const r = mkRecord(e.acc, f, e.updated, e.link);
      if (r) added.push(r);
      seen.add(e.acc);
      processed++;
    } catch (err) {
      console.log(`error ${e.acc}: ${err.message}`);
      // A filing without a Form 4 XML never gets one: mark it so it isn't refetched every run.
      if (err.message === 'no xml link in index') { seen.add(e.acc); processed++; }
    }
  }

  if (GUNLUK) processed += await gunlukPass(seen, added);

  console.log(`summary: pages=${pages} new_filings=${fresh.length} records_added=${added.length}`);
  if (DRY) { for (const r of added) console.log(JSON.stringify(r)); return; }
  // Files (and so commits) change only when new filings were processed: no commit noise on quiet runs.
  if (!processed && !migrated) return;

  const byAcc = new Map();
  for (const r of [...added, ...store.kayitlar]) { const k = accOf(r.sec_link); if (!byAcc.has(k)) byAcc.set(k, r); }
  const kayitlar = [...byAcc.values()].sort((a, b) => new Date(b.dosyalama) - new Date(a.dosyalama)).slice(0, MAX_RECORDS);
  writeJson(F_REC, { guncellendi: now, kayitlar });
  writeJson(F_STATE, { ilk_kosu_tamam: true, gorulen: [...seen].slice(-MAX_SEEN) });
}

main().catch((e) => { console.error(e); process.exit(1); });
