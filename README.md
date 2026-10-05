# S&P 500 국채 대비 실제 이익수익률 스크리너

S&P 500 종목의 **최근 12개월(TTM) 실제 순이익 ÷ 토스증권 실시간 시가총액**을 1년 만기 미국 국채금리(FRED `DGS1`)와 비교하는 로컬 웹 앱입니다. 국채금리보다 실제 이익수익률이 높은 종목을 내림차순으로 표시합니다.

## 데이터 출처

| 데이터 | 출처 | 갱신 방식 |
| --- | --- | --- |
| 실시간 주가·발행주식수·시가총액 | 토스증권 OpenAPI | 화면 갱신 및 60초 자동 갱신 |
| S&P 500 구성종목 | 공개 S&P 500 구성종목 데이터셋 | 7일 캐시 |
| TTM 실제 순이익 | SEC EDGAR 기업 공시 `us-gaap:NetIncomeLoss` | 24시간 캐시 |
| 1년 만기 미국 국채금리 | FRED `DGS1` | 화면 갱신 및 60초 자동 갱신 |

> 토스증권 OpenAPI에는 미국 기업의 재무제표·TTM 순이익 및 미국 국채 기준금리 API가 공개되어 있지 않아, 해당 두 데이터에는 공식 공개 데이터 소스를 사용합니다. 토스 가격 데이터는 계속 실시간으로 사용합니다.

## 필요한 값

| 값 | 용도 | 발급처 |
| --- | --- | --- |
| 토스증권 `client_id` / `client_secret` | 미국 주식 실시간 가격 및 발행주식수 | 토스증권 WTS → 설정 → Open API |
| FRED API Key | 1년 만기 미국 국채금리 `DGS1` | FRED 계정 |
| SEC 연락처 이메일 | SEC EDGAR 요청의 식별 User-Agent | 본인 이메일 (API 키 아님) |

FMP API 키와 유료 애널리스트 컨센서스 데이터는 필요하지 않습니다.

## 실행

```bash
npm install
npm start
```

브라우저에서 `http://127.0.0.1:3000`을 엽니다. 최초 화면의 **데이터 설정**에 토스 Client ID·Secret, FRED 키, SEC 연락처 이메일을 한 번 입력하면 `data/config.json`에 저장됩니다. 이 파일은 Git에서 제외되고 파일 권한이 `0600`으로 설정됩니다. 이후에는 입력 화면이 다시 뜨지 않습니다.

또는 서버 환경변수로 설정할 수 있습니다.

```bash
cp .env.example .env
# .env에 값 입력
npm start
```

환경변수는 저장 파일보다 우선합니다.

## 토스증권 사전 설정

토스증권 OpenAPI는 **허용 IP** 방식입니다. 앱을 실행하는 서버의 공인 IP를 토스증권 WTS의 Open API 허용 IP 관리에서 등록해야 합니다. 이 앱은 안전을 위해 기본적으로 `127.0.0.1`에서만 수신합니다. 외부에 배포할 경우에는 인증, TLS, 비밀 관리 서비스, IP 제한을 별도로 갖춘 서버 환경에서만 운영하세요.

## 계산과 갱신

```text
실제 이익수익률 = 최근 12개월 실제 순이익 ÷ (토스 실시간 주가 × 토스 발행주식수)
통과 조건       = 실제 이익수익률 > FRED DGS1
```

- SEC EDGAR 분기 공시의 `NetIncomeLoss`를 최근 4개 분기로 합산해 TTM 실제 순이익을 계산합니다.
- 최근 4개 분기를 확보할 수 없는 경우 최신 연간 10-K 실제 순이익을 사용하며, 표의 `i` 표시에서 산출 방식을 확인할 수 있습니다.
- 최초 실적 수집 또는 **실제 실적 다시 받기**는 SEC 요청 한도를 준수하므로 약 1~2분이 걸릴 수 있습니다. 이후에는 24시간 캐시를 사용합니다.
- 화면의 **실시간 가격 새로고침**과 60초 자동 갱신은 캐시된 실제 실적에 토스 실시간 가격과 최신 FRED 금리를 다시 결합합니다.

## 유의사항

이 앱은 투자 자문이나 매수 추천이 아닙니다. 실제 순이익은 미래 수익을 보장하지 않으며, 부채·현금흐름·성장률·일회성 손익·산업별 위험은 이 계산에 반영되지 않습니다. SEC 공시의 분기 구분, 회계 기준, 토스 발행주식수와 공시 기준의 차이로 값이 달라질 수 있습니다.

## 출처

- [토스증권 Open API](https://developers.tossinvest.com/)
- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [FRED API](https://fred.stlouisfed.org/docs/api/fred/)
- [S&P 500 구성종목 데이터셋](https://github.com/datasets/s-and-p-500-companies)

Content was rephrased for compliance with licensing restrictions.
