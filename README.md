# AlphaDesk — Russell 1000 리서치 터미널

매 영업일 미국 장 마감 후 자동으로 데이터를 모아 홈페이지를 다시 만듭니다. 사람이 할 일은 없습니다.

- **홈페이지 주소**: `https://<GitHub 아이디>.github.io/<저장소 이름>/`
- **갱신 시각**: 평일 한국시간 오전 7시 17분 시작, 약 20~40분 뒤 반영
- **수동 갱신**: 저장소 → Actions → "Build & deploy AlphaDesk" → Run workflow

## 데이터 출처
| 항목 | 출처 |
|---|---|
| 종목 목록 (Russell 1000) | iShares IWB(Russell 1000 추종 ETF) 보유종목 |
| 주가·수익률·베타·변동성 | Yahoo Finance 일별 종가로 직접 계산 |
| 분기 재무제표·P/E(TTM)·EV/EBITDA | SEC EDGAR XBRL 공시 원본으로 직접 계산 |
| Fwd P/E·회사 설명·시가총액 | Yahoo (하루 300종목씩 순차 갱신, 첫 실행 후 약 4일이면 전 종목 채워짐) |
| Russell 2000 등락 상·하위 | iShares IWM 보유종목 + Yahoo 종가 |
| 차트 | TradingView 위젯(실시간) |

## 선택 설정 (Settings → Secrets and variables → Actions)
- `FINNHUB_API_KEY`: 무료 키를 넣으면 시장·종목 뉴스 헤드라인이 표시됩니다.
- `FMP_API_KEY`: Yahoo가 막힐 때 주가 백업용.
- `SEC_USER_AGENT`: 비워 두면 `AlphaDesk <아이디>@users.noreply.github.com`을 사용합니다.

## 구조
- `build_data.py` 데이터 수집·계산 → `site/data/` (summary.json, hist/, fin/)
- `site/index.html` 홈페이지
- `.github/workflows/deploy.yml` 매일 자동 실행·배포
