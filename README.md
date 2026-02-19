# word_web

오픈소스 우선(Open-Source-First) 웹 문서 편집기 MVP입니다.

핵심 전략:
- 문서 편집 엔진: **ONLYOFFICE Document Server (Community, AGPL)**
- 웹 API/파일관리: **Node.js + Express (MIT)**
- 프런트엔드: **Vanilla JS + Tabler UI style system (MIT)**

## 왜 이 조합인가

`HWP/HWPX/PDF`를 웹에서 다루려면 렌더링/편집 엔진이 핵심입니다. 이를 직접 구현하는 대신,
검증된 오픈소스 문서 엔진(ONLYOFFICE)을 붙이고 우리 서비스 레이어(업로드/저장/권한/콜백)를 구현했습니다.

## 오픈소스 구성

- ONLYOFFICE Document Server: https://github.com/ONLYOFFICE/DocumentServer
- ONLYOFFICE Docs API: https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/
- ONLYOFFICE integration samples: https://github.com/ONLYOFFICE/document-server-integration
- Tabler UI Kit: https://github.com/tabler/tabler
- Express: https://github.com/expressjs/express
- Multer: https://github.com/expressjs/multer
- jsonwebtoken: https://github.com/auth0/node-jsonwebtoken

## 프로젝트 구조

```
word_web/
  public/
    index.html        # 업로드/문서목록
    editor.html       # 편집 화면
    app.js            # 목록/업로드 UI 로직
    editor.js         # ONLYOFFICE 에디터 로더
    styles.css
  data/files/         # 업로드 파일 저장소
  server.js           # API + ONLYOFFICE config/callback
  docker-compose.yml  # app + documentserver
  Dockerfile
  .env.example
```

## 빠른 시작 (권장: Docker Compose)

1. 환경 변수 파일 생성

```bash
cd /home/yadoo/word_web
cp .env.example .env
# .env에서 JWT_SECRET을 강한 값으로 변경
```

2. 실행

```bash
docker compose up --build
```

3. 접속
- 앱: http://localhost:3000
- Document Server: http://localhost:8082

## 동작 방식

1. 파일 업로드 (`POST /api/upload`)
2. 업로드 파일 목록 조회 (`GET /api/files`)
3. 문서 편집 진입 시 ONLYOFFICE Config 발급 (`GET /api/editor-config/:id`)
4. 편집 중 저장 이벤트가 콜백으로 들어오면 최신 파일 반영 (`POST /api/callback/:id`)

## 지원 확장자 (MVP)

- 문서(Word 계열): `hwp`, `hwpx`, `doc/docx`, `odt`, `rtf`, `txt` 등
- 스프레드시트: `xls/xlsx`, `ods`, `csv`
- 프레젠테이션: `ppt/pptx`, `odp`
- PDF: `pdf`, `xps`

실제 편집/호환 수준은 Document Server 버전과 파일 복잡도에 따라 달라집니다.

## 환경 변수

- `PORT` (기본 `3000`)
- `PUBLIC_BASE_URL` (브라우저 접근 URL)
- `INTERNAL_BASE_URL` (Document Server가 API 파일/콜백에 접근할 URL)
- `DOCUMENT_SERVER_PUBLIC_URL` (선택: 브라우저에서 로드할 Document Server URL 직접 지정)
- `DOCUMENT_SERVER_INTERNAL_URL` (앱 서버가 프록시할 내부 Document Server 주소, Docker에선 `http://documentserver`)
- `DOCUMENT_SERVER_PROXY_PATH` (브라우저가 접근하는 프록시 경로, 기본 `/ds`)
- `JWT_ENABLED` (기본 `true`)
- `JWT_SECRET` (Document Server와 동일해야 함)
- `STORAGE_DIR` (기본 `./data/files`)
- `MAX_UPLOAD_SIZE_MB` (기본 `200`)

## 제한/주의

- HWP/HWPX는 복잡한 서식/매크로/특수 객체에서 일부 호환 이슈가 있을 수 있습니다.
- PDF 편집 기능 범위는 Document Server 버전에 의존합니다.
- 현재는 로컬 파일 저장 중심 MVP이며, 사용자 인증/권한 분리/버전관리/감사는 포함하지 않았습니다.

## 다음 확장 추천

1. 사용자 인증 + 문서별 권한(보기/편집)
2. 파일 버전 히스토리 및 되돌리기
3. MinIO/S3 스토리지 연동
4. Redis 큐 기반 비동기 변환 파이프라인
5. 감사 로그/접속 로그/보안 정책 강화
