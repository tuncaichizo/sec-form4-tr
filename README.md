# sec-form4-tr

SEC Form 4 içeriden alım-satımları (P/S kodlu, ≥1M $), Türkçe alanlarla JSON.

`son-islemler.json`: non-derivative purchases (code P) and sales (code S) from SEC Form 4 filings, aggregated per filing; a filing is listed when its dominant side totals at least $1,000,000. Source: SEC EDGAR (latest filings Atom feed + filing XML), refreshed by a GitHub Action every 10 minutes.

Schema: `{ guncellendi, kayitlar: [ { tarih, dosyalama, ticker, sirket, kisi, unvan, tur ("alim"|"satim"), adet, fiyat, toplam_usd, sec_link } ] }`, at most 50 records, newest filing first. Processing state lives in the Actions cache, not in the repo.

Not investment advice.

## son-13d.json

SEC Schedule 13D / 13G (and /A) beneficial-ownership filings, i.e. stakes above 5 %, for listed stocks. Source: EDGAR latest-filings Atom feeds (SCHEDULE 13D, SCHEDULE 13G) plus each filing's primary XML; the subject company is mapped to a ticker with SEC's company_tickers.json (no ticker: skipped). Refreshed by the same Action.

Schema: `{ guncellendi, kayitlar: [ { tarih, dosyalama, ticker, sirket, bildiren, pay_yuzde, tur ("13D"|"13G"), degisiklik, sec_link } ] }`, at most 50 records per `tur` (50 13D incl. amendments + 50 13G incl. amendments, so up to 100 in total), merged and sorted newest filing first.

- `tarih`: date of the event that requires the filing (from the XML), `null` if absent. `degisiklik`: the form is an amendment (/A).
- `pay_yuzde`: percent of class from the XML. With several reporting persons the MAXIMUM is used. `null` when the filing has no XML or the XML has no percent; it is never computed or guessed. Amendments can report a stake at or below 5 % (a reduced position).
- `bildiren`: the reporting person; several distinct names show as "first name ve diğerleri".
