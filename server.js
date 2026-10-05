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
const FMP_BASE_URL = 'https://financialmodelingprep.com';
const TOSS_BASE_URL = 'https://openapi.tossinvest.com';
const FUNDAMENTALS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CONSTITUENTS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

let tokenCache = { accessToken: null, expiresAt: 0 };
let currentScreenPromise = null;

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
    fmpApiKey: process.env.FMP_API_KEY?.trim() || '',
    fredApiKey: process.env.FRED_API_KEY?.trim() || '',
  };
}

function mergeConfig(saved = {}) {
  const env = envConfig();
  return {
    tossClientId: env.tossClientId || saved.tossClientId || '',
    tossClientSecret: env.tossClientSecret || saved.tossClientSecret || '',
    fmpApiKey: env.fmpApiKey || saved.fmpApiKey || '',
    fredApiKey: env.fredApiKey || saved.fredApiKey || '',
  };
}

async function getConfig() {
  return mergeConfig((await readJsonFile(CONFIG_FILE)) || {});
}

function configurationStatus(config) {
  return {
    toss: Boolean(config.tossClientId && config.tossClientSecret),
    fmp: Boolean(config.fmpApiKey),
    fred: Boolean(config.fredApiKey),
    complete: Boolean(config.tossClientId && config.tossClientSecret && config.fmpApiKey && config.fredApiKey),
  };
}

async function saveConfig(values) {
  const existing = (await readJsonFile(CONFIG_FILE)) || {};
  const next = { ...existing };
  for (const key of ['tossClientId', 'tossClientSecret', 'fmpApiKey', 'fredApiKey']) {
    if (typeof values[key] === 'string' && values[key].trim()) next[key] = values[key].trim();
  }
  const effectiveConfig = mergeConfig(next);
  const status = configurationStatus(effectiveConfig);
  if (!status.complete) {
    const labels = {
      toss: '토스 Client ID 또는 Client Secret',
      fmp: 'FMP API Key',
      fred: 'FRED API Key',
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

async function fmpRequest(config, stablePath, legacyPath) {
  const urls = [
    `${FMP_BASE_URL}${stablePath}${stablePath.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(config.fmpApiKey)}`,
    ...(legacyPath ? [`${FMP_BASE_URL}${legacyPath}${legacyPath.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(config.fmpApiKey)}`] : []),
  ];
  let lastError;
  for (const url of urls) {
    try {
      return await fetchJson(url, {}, 'FMP');
    } catch (error) {
      lastError = error;
      if (!(error instanceof ExternalServiceError) || ![404, 405].includes(error.status)) break;
    }
  }
  throw lastError;
}

async function getConstituents(config, forceRefresh) {
  if (!forceRefresh) {
    const cached = await getCached('sp500-constituents', CONSTITUENTS_CACHE_TTL_MS);
    if (cached) return cached;
  }
  const payload = await fmpRequest(config, '/stable/sp500-constituent', '/api/v3/sp500_constituent');
  const seen = new Set();
  const constituents = getList(payload)
    .map((item) => ({
      symbol: String(item?.symbol || '').toUpperCase(),
      name: item?.name || item?.companyName || item?.security || '',
      sector: item?.sector || '',
    }))
    .filter((item) => item.symbol && !seen.has(item.symbol) && seen.add(item.symbol));
  if (constituents.length < 400) {
    throw new ExternalServiceError('FMP', `S&P 500 구성종목을 충분히 받지 못했습니다 (${constituents.length}개). FMP 구독 권한과 API 키를 확인해 주세요.`);
  }
  await setCached('sp500-constituents', constituents);
  return constituents;
}

function dateYear(value) {
  const match = String(value || '').match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

function getForecastNetIncome(record) {
  return pickNumber(
    record?.estimatedNetIncomeAvg,
    record?.estimatedNetIncome,
    record?.netIncomeAvg,
    record?.netIncome,
    record?.estimatedNetIncomeLow,
  );
}

function getForecastEps(record) {
  return pickNumber(
    record?.estimatedEpsAvg,
    record?.estimatedEPSAvg,
    record?.epsAvg,
    record?.eps,
    record?.estimatedEpsLow,
  );
}

function chooseNextYearForecast(payload) {
  const nextYear = new Date().getUTCFullYear() + 1;
  const records = getList(payload).filter((record) => record && typeof record === 'object');
  const annual = records.filter((record) => {
    const period = String(record.period || record.frequency || '').toUpperCase();
    return !period || period === 'FY' || period === 'ANNUAL';
  });
  const candidates = annual.length ? annual : records;
  const exact = candidates.filter((record) => Number(record.calendarYear) === nextYear || dateYear(record.date || record.fiscalDateEnding) === nextYear);
  const chronological = (exact.length ? exact : candidates)
    .slice()
    .sort((a, b) => String(a.date || a.fiscalDateEnding || '').localeCompare(String(b.date || b.fiscalDateEnding || '')));
  return chronological[0] || null;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error: publicError(error) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

async function getFundamentals(config, forceRefresh) {
  if (!forceRefresh) {
    const cached = await getCached('forward-estimates', FUNDAMENTALS_CACHE_TTL_MS);
    if (cached) return cached;
  }
  const constituents = await getConstituents(config, forceRefresh);
  const details = await mapWithConcurrency(constituents, 5, async (constituent) => {
    const payload = await fmpRequest(config, `/stable/analyst-estimates?symbol=${encodeURIComponent(constituent.symbol)}`, `/api/v3/analyst-estimates/${encodeURIComponent(constituent.symbol)}`);
    const forecast = chooseNextYearForecast(payload);
    if (!forecast) return { ...constituent, forecast: null };
    return {
      ...constituent,
      forecast: {
        date: forecast.date || forecast.fiscalDateEnding || null,
        netIncome: getForecastNetIncome(forecast),
        eps: getForecastEps(forecast),
      },
    };
  });

  const errors = details.filter((item) => item?.error);
  const items = details.filter((item) => !item?.error);
  if (!items.length || errors.length === constituents.length) {
    throw new ExternalServiceError('FMP', errors[0]?.error || '예상 실적 데이터를 받지 못했습니다. FMP API 요금제의 Analyst Estimates 권한을 확인해 주세요.');
  }
  const data = { items, failedSymbols: errors.length, generatedAt: new Date().toISOString() };
  await setCached('forward-estimates', data);
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

function buildRows(fundamentals, live, treasury) {
  const rows = [];
  let noForecast = 0;
  let noLivePrice = 0;

  for (const item of fundamentals.items) {
    const symbol = item.symbol.toUpperCase();
    const price = live.priceBySymbol.get(symbol);
    const stock = live.stockBySymbol.get(symbol);
    if (!price || !stock?.sharesOutstanding) {
      noLivePrice += 1;
      continue;
    }

    const marketCap = price * stock.sharesOutstanding;
    let expectedNetIncome = item.forecast?.netIncome;
    let estimateMethod = 'FMP 예상 순이익 평균';
    if ((expectedNetIncome === null || expectedNetIncome === undefined) && item.forecast?.eps !== null && item.forecast?.eps !== undefined) {
      expectedNetIncome = item.forecast.eps * stock.sharesOutstanding;
      estimateMethod = 'FMP 예상 EPS 평균 × 토스 발행주식수';
    }
    if (expectedNetIncome === null || expectedNetIncome === undefined || !Number.isFinite(expectedNetIncome)) {
      noForecast += 1;
      continue;
    }

    const earningsYield = expectedNetIncome / marketCap;
    rows.push({
      symbol,
      name: item.name || stock.raw?.englishName || stock.raw?.name || symbol,
      sector: item.sector || '—',
      price,
      sharesOutstanding: stock.sharesOutstanding,
      marketCap,
      expectedNetIncome,
      earningsYield,
      treasurySpread: earningsYield - treasury.value / 100,
      estimateDate: item.forecast?.date || null,
      estimateMethod,
    });
  }
  return { rows, noForecast, noLivePrice };
}

async function buildScreen(config, forceRefresh) {
  const [fundamentals, treasury] = await Promise.all([
    getFundamentals(config, forceRefresh),
    getTreasuryYield(config),
  ]);
  const live = await getTossLiveData(fundamentals.items.map((item) => item.symbol), config);
  const result = buildRows(fundamentals, live, treasury);
  return {
    generatedAt: new Date().toISOString(),
    treasury,
    coverage: {
      universe: fundamentals.items.length,
      forwardEstimatesFailed: fundamentals.failedSymbols,
      rowsWithComparableData: result.rows.length,
      missingForecast: result.noForecast,
      missingLiveData: result.noLivePrice,
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
    response.status(201).json({ configured, message: 'API 키를 이 서버에 저장했습니다. 이후에는 다시 입력할 필요가 없습니다.' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/cache/refresh', async (_request, response, next) => {
  try {
    await fs.rm(path.join(CACHE_DIRECTORY, 'forward-estimates.json'), { force: true });
    await fs.rm(path.join(CACHE_DIRECTORY, 'sp500-constituents.json'), { force: true });
    response.json({ message: '컨센서스 및 구성종목 캐시를 비웠습니다.' });
  } catch (error) {
    next(error);
  }
});

app.get('/api/screen', async (request, response, next) => {
  try {
    const config = await getConfig();
    if (!configurationStatus(config).complete) {
      return response.status(428).json({ error: '먼저 API 키 설정을 완료해 주세요.', code: 'SETUP_REQUIRED' });
    }
    const forceRefresh = request.query.refresh === 'fundamentals';
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
