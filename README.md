# S&P 500 국채 대비 이익수익률 스크리너

S&P 500 종목의 **다음 회계연도 예상 순이익 ÷ 토스증권 실시간 시가총액**을 1년 만기 미국 국채금리(FRED `DGS1`)와 비교하는 로컬 웹 앱입니다. 국채금리보다 예상이익수익률이 높은 종목을 내림차순으로 표시합니다.

## 필요한 키

| 키 | 용도 | 발급처 |
| --- | --- | --- |
| 토스증권 `client_id` / `client_secret` | 미국 주식 실시간 가격 및 발행주식수 | 토스증권 WTS → 설정 → Open API |
| **FMP API Key** | S&P 500 구성종목과 다음 연도 예상 순이익/EPS 컨센서스 | Financial Modeling Prep 계정 대시보드 |
| FRED API Key | 1년 만기 미국 국채금리 `DGS1` | FRED 계정 |

> FMP 키는 Financial Modeling Prep에서 발급한 일반 API key **한 개**입니다. 이 앱은 `analyst-estimates` 권한을 사용하므로, 선택한 FMP 요금제가 해당 엔드포인트와 충분한 호출량을 지원해야 합니다.

## 실행

```bash
npm install
npm start
```

브라우저에서 `http://127.0.0.1:3000`을 엽니다. 첫 화면의 **API 설정**에서 네 가지 값을 한 번 입력하면 `data/config.json`에 저장됩니다. 그 파일은 Git에서 제외되고 파일 권한이 `0600`으로 설정됩니다. 이후에는 입력 화면이 다시 뜨지 않습니다.

또는 서버 환경변수로 설정할 수 있습니다.

```bash
cp .env.example .env
# .env에 키 입력
npm start
```

환경변수는 저장 파일보다 우선합니다.

## 토스증권 사전 설정

토스증권 OpenAPI는 **허용 IP** 방식입니다. 앱을 실행하는 서버의 공인 IP를 토스증권 WTS의 Open API 허용 IP 관리에서 등록해야 합니다. 이 앱은 안전을 위해 기본적으로 `127.0.0.1`에서만 수신합니다. 외부에 배포할 경우에는 인증, TLS, 비밀 관리 서비스, IP 제한을 별도로 갖춘 서버 환경에서만 운영하세요.

## 계산과 데이터 갱신

```text
예상이익수익률 = 다음 연도 예상 순이익 ÷ (토스 실시간 주가 × 토스 발행주식수)
통과 조건       = 예상이익수익률 > FRED DGS1
```

- 토스 시세와 FRED 금리는 화면을 열거나 60초 자동 갱신 시 새로 조회합니다.
- FMP S&P 500 목록은 7일, 예상 실적은 24시간 캐시합니다. 화면의 **컨센서스 다시 받기**로 캐시를 비운 뒤 다시 불러올 수 있습니다.
- FMP가 예상 순이익을 제공하지 않고 예상 EPS만 제공할 경우, `예상 EPS × 토스 발행주식수`로 예상 순이익을 근사하며 화면에서 산출 방식을 툴팁으로 표시합니다.

## 유의사항

이 앱은 투자 자문이나 매수 추천이 아닙니다. 컨센서스 추정치, 발행주식수, 데이터 공급사별 회계 기준의 차이로 값이 달라질 수 있습니다. 순이익/시가총액만으로 기업의 부채, 현금흐름, 성장성, 일회성 손익, 산업 위험을 평가할 수 없습니다.

## 출처

- [토스증권 Open API](https://developers.tossinvest.com/)
- [FRED API](https://fred.stlouisfed.org/docs/api/fred/)
- [Financial Modeling Prep](https://site.financialmodelingprep.com/developer/docs)

Content was rephrased for compliance with licensing restrictions.
