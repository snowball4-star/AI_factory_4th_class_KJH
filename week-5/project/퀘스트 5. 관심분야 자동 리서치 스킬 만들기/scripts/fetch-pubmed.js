#!/usr/bin/env node
/**
 * PubMed 주간 수집기
 *
 * PubMed 웹 화면은 자동화 접근에 reCAPTCHA를 걸기 때문에 공식 E-utilities API를 쓴다.
 * 의존성 없이 Node 18+ 내장 fetch만 사용한다.
 *
 * 사용법:
 *   node fetch-pubmed.js --keyword glaucoma --days 7 --out ../data
 *   node fetch-pubmed.js --keyword glaucoma --from 2026/09/14 --to 2026/09/20 --out ../data
 *
 * NCBI_API_KEY 환경변수가 있으면 요청에 붙여 rate limit을 3회/초에서 10회/초로 올린다.
 * 키는 코드에 적지 않고 .env 또는 셸 환경변수에서만 읽는다.
 */

const fs = require('fs');
const path = require('path');

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

function fmt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

function resolveRange(args) {
  if (args.from && args.to) return { from: args.from, to: args.to };
  const days = Number(args.days || 7);
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86400000);
  return { from: fmt(from), to: fmt(to) };
}

function withKey(url) {
  const key = process.env.NCBI_API_KEY;
  return key ? `${url}&api_key=${encodeURIComponent(key)}` : url;
}

async function esearch(keyword, from, to) {
  const term = `${keyword}[Title/Abstract] AND ${from}:${to}[EDAT]`;
  const url = withKey(
    `${EUTILS}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&retmax=500&retmode=json`
  );
  const res = await fetch(url);
  if (!res.ok) throw new Error(`esearch 실패: HTTP ${res.status}`);
  const json = await res.json();
  return { term, ids: json.esearchresult.idlist || [] };
}

async function efetch(ids) {
  const body = new URLSearchParams({
    db: 'pubmed',
    rettype: 'medline',
    retmode: 'text',
    id: ids.join(','),
  });
  const key = process.env.NCBI_API_KEY;
  if (key) body.set('api_key', key);
  const res = await fetch(`${EUTILS}/efetch.fcgi`, { method: 'POST', body });
  if (!res.ok) throw new Error(`efetch 실패: HTTP ${res.status}`);
  return res.text();
}

/** MEDLINE 텍스트를 구조화된 레코드 배열로 바꾼다. 6칸 들여쓴 줄은 이전 필드의 연속이다. */
function parseMedline(text) {
  return text
    .replace(/\r/g, '')
    .split(/\n\n(?=PMID- )/)
    .filter((r) => r.trim())
    .map((record) => {
      const fields = {};
      let key = null;
      for (const line of record.split('\n')) {
        const m = line.match(/^([A-Z]{2,4}|[A-Z]{1,3}\d?)\s*- (.*)$/);
        if (m) {
          key = m[1];
          (fields[key] = fields[key] || []).push(m[2]);
        } else if (/^\s{6}/.test(line) && key) {
          fields[key][fields[key].length - 1] += ' ' + line.trim();
        }
      }
      const join = (k) => (fields[k] || []).join(' ');
      const doi = (fields.LID || []).concat(fields.AID || []).find((x) => /\[doi\]/.test(x));
      return {
        pmid: join('PMID'),
        title: join('TI'),
        abstract: join('AB'),
        journal: join('JT'),
        journalAbbr: join('TA'),
        date: join('DP'),
        types: fields.PT || [],
        authors: fields.FAU || fields.AU || [],
        mesh: fields.MH || [],
        doi: doi ? doi.replace(/\s*\[doi\]/, '') : '',
        url: `https://pubmed.ncbi.nlm.nih.gov/${join('PMID')}/`,
      };
    });
}

async function main() {
  const args = parseArgs(process.argv);
  const keyword = args.keyword || 'glaucoma';
  const { from, to } = resolveRange(args);
  const outDir = path.resolve(args.out || path.join(__dirname, '..', 'data'));
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[1/2] 검색: "${keyword}" ${from} ~ ${to}`);
  const { term, ids } = await esearch(keyword, from, to);
  console.log(`      ${ids.length}편 발견`);

  if (ids.length === 0) {
    console.log('해당 기간에 신규 논문이 없습니다.');
    return;
  }

  console.log('[2/2] 서지정보·초록 수집');
  const medline = await efetch(ids);
  const papers = parseMedline(medline);

  const stamp = to.replace(/\//g, '-');
  const jsonPath = path.join(outDir, `${stamp}_${keyword}_papers.json`);
  const rawPath = path.join(outDir, `${stamp}_${keyword}_medline.txt`);

  fs.writeFileSync(rawPath, medline);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ keyword, term, from, to, count: papers.length, papers }, null, 1)
  );

  const noAbstract = papers.filter((p) => !p.abstract).length;
  console.log(`\n완료: ${papers.length}편 (초록 없음 ${noAbstract}편)`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${rawPath}`);
}

main().catch((err) => {
  console.error('오류:', err.message);
  process.exit(1);
});
