import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIRECTORY = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIRECTORY, 'config.json');
const CACHE_DIRECTORY = path.join(DATA_DIRECTORY, 'cache');
const TOSS_BASE_URL = 'https://openapi.tossinvest.com';
const SEC_COMPANY_FACTS_BASE_URL = 'https://data.sec.gov/api/xbrl/companyfacts';
const SP500_CONSTITUENTS_CSV_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';
const ACTUALS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CONSTITUENTS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEC_REQUEST_INTERVAL_MS = 125;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

let tokenCache = { accessToken: null, expiresAt: 0 };
let currentScreenPromise = null;
let nextSecRequestAt = 0;

class ExternalServiceError extends Error {
  constructor(service, message, status) {
    super(message);
    this.name = 'ExternalServiceError';
    this.service = service;
    this.status = status;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.replaceAll(',', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function pickNumber(...values) {
  for (const value of values) {
    if (value && typeof value === 'object') {
      const nested = pickNumber(value.usd, value.USD, value.value, value.amount, value.price, value.close);
      if (nested !== null) return nested;
    }
    const parsed = toNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function getList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.historical)) return payload.historical;
  return [];
}

function publicError(error) {
  if (error instanceof ExternalServiceError) return error.message;
  return error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.';
}

async function ensureDataDirectories() {
  await fs.mkdir(CACHE_DIRECTORY, { recursive: true });
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writePrivateJson(filePath, value) {
  await ensureDataDirectories();
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600);
}

function envConfig() {
  return {
    tossClientId: process.env.TOSS_CLIENT_ID?.trim() || '',
    tossClientSecret: process.env.TOSS_CLIENT_SECRET?.trim() || '',
    fredApiKey: process.env.FRED_API_KEY?.trim() || '',
    secContactEmail: process.env.SEC_CONTACT_EMAIL?.trim() || '',
  };
}

function mergeConfig(saved = {}) {
  const env = envConfig();
  return {
    tossClientId: env.tossClientId || saved.tossClientId || '',
    tossClientSecret: env.tossClientSecret || saved.tossClientSecret || '',
    fredApiKey: env.fredApiKey || saved.fredApiKey || '',
    secContactEmail: env.secContactEmail || saved.secContactEmail || '',
  };
}

async function getConfig() {
  return mergeConfig((await readJsonFile(CONFIG_FILE)) || {});
}

function configurationStatus(config) {
  const secContact = Boolean(config.secContactEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.secContactEmail));
  return {
    toss: Boolean(config.tossClientId && config.tossClientSecret),
    fred: Boolean(config.fredApiKey),
    secContact,
    complete: Boolean(config.tossClientId && config.tossClientSecret && config.fredApiKey && secContact),
  };
}

async function saveConfig(values) {
  const existing = (await readJsonFile(CONFIG_FILE)) || {};
  const next = { ...existing };
  for (const key of ['tossClientId', 'tossClientSecret', 'fredApiKey', 'secContactEmail']) {
    if (typeof values[key] === 'string' && values[key].trim()) next[key] = values[key].trim();
  }
  const status = configurationStatus(mergeConfig(next));
  if (!status.complete) {
    const labels = {
      toss: '토스 Client ID 또는 Client Secret',
      fred: 'FRED API Key',
      secContact: 'SEC 연락처 이메일(유효한 이메일 형식)',
    };
    const missing = Object.entries(status)
      .filter(([key, present]) => key !== 'complete' && !present)
      .map(([key]) => labels[key]);
    throw new Error(`다음 값을 입력해 주세요: ${missing.join(', ')}.`);
  }
  await writePrivateJson(CONFIG_FILE, next);
  tokenCache = { accessToken: null, expiresAt: 0 };
  return status;
}

async function getCached(name, maxAgeMs) {
  const cached = await readJsonFile(path.join(CACHE_DIRECTORY, `${name}.json`));
  if (!cached?.savedAt || !cached.data) return null;
  if (Date.now() - new Date(cached.savedAt).getTime() > maxAgeMs) return null;
  return cached.data;
}

async function setCached(name, data) {
  await writePrivateJson(path.join(CACHE_DIRECTORY, `${name}.json`), {
    savedAt: new Date().toISOString(),
    data,
  });
}

async function fetchJson(url, options, service) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new ExternalServiceError(service, `${service} 서버에 연결하지 못했습니다. 네트워크 연결을 확인해 주세요.`);
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const detail = payload?.error?.message || payload?.['Error Message'] || payload?.message || (typeof payload === 'string' ? payload : '요청이 거부되었습니다.');
    throw new ExternalServiceError(service, `${service} 요청 실패 (${response.status}): ${detail}`, response.status);
  }
  return payload;
}

async function fetchText(url, service) {
  let response;
  try {
    response = await fetch(url);
  } catch {
    throw new ExternalServiceError(service, `${service} 서버에 연결하지 못했습니다. 네트워크 연결을 확인해 주세요.`);
  }
  const text = await response.text();
  if (!response.ok) throw new ExternalServiceError(service, `${service} 요청 실패 (${response.status}): ${text || '요청이 거부되었습니다.'}`, response.status);
  return text;
}

async function getTossToken(config) {
  if (tokenCache.accessToken && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.accessToken;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.tossClientId,
    client_secret: config.tossClientSecret,
  });
  const payload = await fetchJson(`${TOSS_BASE_URL}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }, '토스증권');

  if (!payload?.access_token) throw new ExternalServiceError('토스증권', '액세스 토큰이 응답에 없습니다. Client ID와 Secret을 확인해 주세요.');
  tokenCache = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + Math.max(60, Number(payload.expires_in || 900) - 30) * 1000,
  };
  return tokenCache.accessToken;
}

async function tossRequest(endpoint, token) {
  return fetchJson(`${TOSS_BASE_URL}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, '토스증권');
}

function chunks(values, size) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

async function getTossLiveData(symbols, config) {
  const token = await getTossToken(config);
  const groups = chunks(symbols, 200);
  const priceResponses = await Promise.all(groups.map((group) => tossRequest(`/api/v1/prices?symbols=${encodeURIComponent(group.join(','))}`, token)));
  const stockResponses = await Promise.all(groups.map((group) => tossRequest(`/api/v1/stocks?symbols=${encodeURIComponent(group.join(','))}`, token)));

  const priceBySymbol = new Map();
  for (const item of priceResponses.flatMap(getList)) {
    const symbol = String(item?.symbol || item?.code || '').toUpperCase();
    const price = pickNumber(item?.currentPrice, item?.price, item?.lastPrice, item?.regularMarketPrice, item?.tradePrice, item?.close, item?.quote);
    if (symbol && price !== null && price > 0) priceBySymbol.set(symbol, price);
  }

  const stockBySymbol = new Map();
  for (const item of stockResponses.flatMap(getList)) {
    const symbol = String(item?.symbol || item?.code || '').toUpperCase();
    const sharesOutstanding = pickNumber(item?.sharesOutstanding, item?.shares, item?.outstandingShares);
    if (symbol && sharesOutstanding !== null && sharesOutstanding > 0) stockBySymbol.set(symbol, { sharesOutstanding, raw: item });
  }
  return { priceBySymbol, stockBySymbol };
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  values.push(value);
  return values;
}

async function getConstituents(forceRefresh) {
  if (!forceRefresh) {
    const cached = await getCached('sp500-constituents', CONSTITUENTS_CACHE_TTL_MS);
    if (cached) return cached;
  }
  const csv = await fetchText(SP500_CONSTITUENTS_CSV_URL, 'S&P 500 구성종목 데이터');
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  const columns = parseCsvLine(header);
  const columnIndex = (name) => columns.indexOf(name);
  const symbolIndex = columnIndex('Symbol');
  const nameIndex = columnIndex('Security');
  const sectorIndex = columnIndex('GICS Sector');
  const cikIndex = columnIndex('CIK');
  const seen = new Set();
  const constituents = lines
    .map(parseCsvLine)
    .map((row) => ({
      symbol: String(row[symbolIndex] || '').toUpperCase(),
      name: row[nameIndex] || '',
      sector: row[sectorIndex] || '',
      cik: String(row[cikIndex] || '').replaceAll(/\D/g, '').padStart(10, '0'),
    }))
    .filter((item) => item.symbol && item.cik && !seen.has(item.symbol) && seen.add(item.symbol));
  if (constituents.length < 400) {
    throw new ExternalServiceError('S&P 500 구성종목 데이터', `구성종목을 충분히 받지 못했습니다 (${constituents.length}개).`);
  }
  await setCached('sp500-constituents', constituents);
  return constituents;
}

async function secRequest(cik, config) {
  const scheduledAt = Math.max(Date.now(), nextSecRequestAt);
  nextSecRequestAt = scheduledAt + SEC_REQUEST_INTERVAL_MS;
  await sleep(Math.max(0, scheduledAt - Date.now()));
  return fetchJson(`${SEC_COMPANY_FACTS_BASE_URL}/CIK${cik}.json`, {
    headers: {
      'User-Agent': `sp500-treasury-screener/1.0 ${config.secContactEmail}`,
      'Accept-Encoding': 'gzip, deflate',
    },
  }, 'SEC EDGAR');
}

function extractTtmNetIncome(companyFacts) {
  const facts = companyFacts?.facts?.['us-gaap']?.NetIncomeLoss?.units?.USD;
  if (!Array.isArray(facts)) return null;
  const acceptedForms = new Set(['10-Q', '10-K', '10-Q/A', '10-K/A']);
  const quarterlyByFrame = new Map();
  for (const fact of facts) {
    if (!acceptedForms.has(fact.form) || !/^CY\d{4}Q[1-4]$/.test(fact.frame || '') || toNumber(fact.val) === null) continue;
    const previous = quarterlyByFrame.get(fact.frame);
    if (!previous || String(fact.filed || '') > String(previous.filed || '')) quarterlyByFrame.set(fact.frame, fact);
  }
  const quarters = [...quarterlyByFrame.values()].sort((left, right) => String(left.end).localeCompare(String(right.end)));
  if (quarters.length >= 4) {
    const latestFour = quarters.slice(-4);
    return {
      value: latestFour.reduce((sum, fact) => sum + toNumber(fact.val), 0),
      periodEnd: latestFour.at(-1).end,
      method: 'SEC EDGAR NetIncomeLoss · 최근 4개 분기 합산',
    };
  }

  const annual = facts
    .filter((fact) => acceptedForms.has(fact.form) && fact.fp === 'FY' && /^CY\d{4}$/.test(fact.frame || '') && toNumber(fact.val) !== null)
    .sort((left, right) => String(left.end).localeCompare(String(right.end)));
  const latestAnnual = annual.at(-1);
  if (!latestAnnual) return null;
  return {
    value: toNumber(latestAnnual.val),
    periodEnd: latestAnnual.end,
    method: 'SEC EDGAR NetIncomeLoss · 최근 연간 10-K',
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        results[index] = { error: publicError(error) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

async function getActualIncome(config, forceRefresh) {
  if (!forceRefresh) {
    const cached = await getCached('ttm-net-income', ACTUALS_CACHE_TTL_MS);
    if (cached) return cached;
  }
  const constituents = await getConstituents(forceRefresh);
  const details = await mapWithConcurrency(constituents, 5, async (constituent) => {
    const ttm = extractTtmNetIncome(await secRequest(constituent.cik, config));
    return { ...constituent, ttm };
  });
  const errors = details.filter((item) => item?.error);
  const items = details.filter((item) => !item?.error);
  if (!items.length || errors.length === constituents.length) {
    throw new ExternalServiceError('SEC EDGAR', errors[0]?.error || '실제 순이익 데이터를 받지 못했습니다. SEC 연락처 이메일과 네트워크를 확인해 주세요.');
  }
  const data = { items, failedSymbols: errors.length, generatedAt: new Date().toISOString() };
  await setCached('ttm-net-income', data);
  return data;
}

async function getTreasuryYield(config) {
  const params = new URLSearchParams({
    series_id: 'DGS1',
    api_key: config.fredApiKey,
    file_type: 'json',
    sort_order: 'desc',
    limit: '20',
  });
  const payload = await fetchJson(`https://api.stlouisfed.org/fred/series/observations?${params}`, {}, 'FRED');
  const observation = (payload?.observations || []).find((item) => toNumber(item?.value) !== null);
  if (!observation) throw new ExternalServiceError('FRED', 'DGS1(1년 만기 미국 국채) 관측값을 찾지 못했습니다.');
  return { value: toNumber(observation.value), date: observation.date, seriesId: 'DGS1' };
}

function buildRows(actualIncome, live, treasury) {
  const rows = [];
  let missingActualIncome = 0;
  let missingLiveData = 0;

  for (const item of actualIncome.items) {
    const symbol = item.symbol.toUpperCase();
    const price = live.priceBySymbol.get(symbol);
    const stock = live.stockBySymbol.get(symbol);
    if (!price || !stock?.sharesOutstanding) {
      missingLiveData += 1;
      continue;
    }
    if (!item.ttm || !Number.isFinite(item.ttm.value)) {
      missingActualIncome += 1;
      continue;
    }

    const marketCap = price * stock.sharesOutstanding;
    const earningsYield = item.ttm.value / marketCap;
    rows.push({
      symbol,
      name: item.name || stock.raw?.englishName || stock.raw?.name || symbol,
      sector: item.sector || '—',
      price,
      sharesOutstanding: stock.sharesOutstanding,
      marketCap,
      ttmNetIncome: item.ttm.value,
      earningsYield,
      treasurySpread: earningsYield - treasury.value / 100,
      periodEnd: item.ttm.periodEnd,
      incomeMethod: item.ttm.method,
    });
  }
  return { rows, missingActualIncome, missingLiveData };
}

async function buildScreen(config, forceRefresh) {
  const [actualIncome, treasury] = await Promise.all([
    getActualIncome(config, forceRefresh),
    getTreasuryYield(config),
  ]);
  const live = await getTossLiveData(actualIncome.items.map((item) => item.symbol), config);
  const result = buildRows(actualIncome, live, treasury);
  return {
    generatedAt: new Date().toISOString(),
    treasury,
    coverage: {
      universe: actualIncome.items.length,
      actualIncomeFailed: actualIncome.failedSymbols,
      rowsWithComparableData: result.rows.length,
      missingActualIncome: result.missingActualIncome,
      missingLiveData: result.missingLiveData,
    },
    rows: result.rows.sort((a, b) => b.earningsYield - a.earningsYield),
  };
}

app.get('/api/config', async (_request, response, next) => {
  try {
    response.json({ configured: configurationStatus(await getConfig()) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/config', async (request, response, next) => {
  try {
    const configured = await saveConfig(request.body || {});
    response.status(201).json({ configured, message: '연결 정보를 이 서버에 저장했습니다. 이후에는 다시 입력할 필요가 없습니다.' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/cache/refresh', async (_request, response, next) => {
  try {
    await Promise.all([
      fs.rm(path.join(CACHE_DIRECTORY, 'ttm-net-income.json'), { force: true }),
      fs.rm(path.join(CACHE_DIRECTORY, 'sp500-constituents.json'), { force: true }),
      fs.rm(path.join(CACHE_DIRECTORY, 'forward-estimates.json'), { force: true }),
    ]);
    response.json({ message: '실제 순이익과 구성종목 캐시를 비웠습니다.' });
  } catch (error) {
    next(error);
  }
});

app.get('/api/screen', async (request, response, next) => {
  try {
    const config = await getConfig();
    if (!configurationStatus(config).complete) {
      return response.status(428).json({ error: '먼저 데이터 연결 설정을 완료해 주세요.', code: 'SETUP_REQUIRED' });
    }
    const forceRefresh = request.query.refresh === 'actuals';
    if (!currentScreenPromise || forceRefresh) {
      currentScreenPromise = buildScreen(config, forceRefresh).finally(() => {
        currentScreenPromise = null;
      });
    }
    const screen = await currentScreenPromise;
    const onlyAbove = request.query.filter !== 'all';
    response.json({
      ...screen,
      rows: onlyAbove ? screen.rows.filter((row) => row.earningsYield > screen.treasury.value / 100) : screen.rows,
    });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((error, _request, response, _next) => {
  console.error(error);
  const status = error instanceof ExternalServiceError ? 502 : 400;
  response.status(status).json({ error: publicError(error), service: error?.service || null });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`S&P 500 Treasury Screener is running at http://127.0.0.1:${PORT}`);
});
