# BYOB 와인 투표

모임에 가져온 와인에 휴대전화로 투표하는 한국어 웹앱입니다. 관리자는 사진을 여러 장 올려 후보를 만들거나 와인 이름만 등록할 수 있습니다. 참가자는 이름을 확인하고 투표하며, 마감 전까지 선택을 바꿀 수 있습니다. 한 사람의 마지막 제출만 집계합니다.

| 방식 | 예시 |
| --- | --- |
| 1개만 선택 | 가장 마음에 든 와인 한 병에 1표 |
| 전체 순위 설정 | 7병이면 1위 7점부터 7위 1점까지. 드래그 또는 위·아래 버튼으로 정렬 |
| N개 선택 | 관리자가 선택 개수와 각 등수의 배점을 지정. 예를 들어 1위 3점, 2위 1점 |

## 내 컴퓨터에서 실행

Node.js 24 이상과 npm이 필요합니다. 아래 명령은 저장소 루트에서 실행하세요. 로컬 실습에는 Cloudflare 로그인이 필요하지 않습니다.

```sh
git clone https://github.com/binalee0010/byob-wine-vote.git
cd byob-wine-vote
npm ci
npm run db:local
npm run password:hash -- --local
npm run dev
```

비밀번호 설정 명령은 터미널에서 새 관리자 비밀번호를 두 번 묻습니다. 10자 이상으로 입력하세요. 입력한 문자는 화면에 표시되지 않습니다. 해시만 로컬 `.dev.vars`에 저장하며 이미 파일이 있으면 덮어쓰지 않습니다. 처음 한 번 설정하면 이후에는 `npm run dev`로 다시 열 수 있습니다.

참가자 페이지는 [localhost:8787](http://localhost:8787/), 관리자 페이지는 [localhost:8787/admin](http://localhost:8787/admin)입니다. 로컬 데이터와 사진은 Wrangler가 `.wrangler/`에 보관합니다.

## 투표 운영

1. `/admin`에 로그인해 모임 이름, 투표 질문, 참가 방식과 배점을 설정하고 저장합니다. 자유 입력 또는 미리 등록된 이름만 허용하는 방식을 선택할 수 있습니다. 동명이인은 서로 다른 표시명을 쓰세요. 이름 확인만으로 참여하므로 등록명을 아는 사람은 그 이름으로 접속할 수 있습니다.
2. **와인 등록**에서 사진 여러 장을 선택하거나 이름으로 후보를 추가합니다. 사진 번호와 이름을 확인한 뒤 투표를 시작합니다.
3. 관리 화면의 참가 링크나 QR 코드를 공유합니다. 참가자가 투표 페이지에서 선택하고 제출하면 관리자가 집계를 확인할 수 있습니다.
4. 마감할 때 결과를 공개하려면 **다 공개하기**를 미리 저장하세요. 같은 점수는 공동 순위입니다. 마감 후 **기록에 저장**하면 지난 투표 기록을 보관할 수 있습니다. 다음 모임을 위해 전체 초기화할 때는 먼저 보관 여부를 확인하세요.
5. **지난 투표**에서 기록을 열어 모임 이름과 와인 이름을 고치거나 선택한 기록을 삭제할 수 있습니다. 이름 수정은 순위·점수·사진을 유지합니다. 기록 삭제는 확인 후 해당 기록만 지우며 사진 파일은 그대로 둡니다. 현재 진행하는 투표와 다른 기록은 바뀌지 않습니다. 다른 화면에서 먼저 수정한 기록은 다시 열어 확인한 뒤 저장하세요.

## 내 Cloudflare 계정에 배포

Worker가 화면과 API를 제공합니다. D1에는 투표와 참가자 데이터를, 비공개 R2 버킷에는 사진을 저장합니다. 관리자 비밀번호의 scrypt 검증에는 SQLite Durable Object를 사용합니다.

1. 자기 계정에서 Workers와 R2를 사용할 수 있는지 확인한 뒤 전용 리소스를 만듭니다.

   ```sh
   npx wrangler login
   npx wrangler whoami
   npx wrangler d1 create byob-wine-vote
   npx wrangler r2 bucket create byob-wine-photos
   ```

2. [wrangler.jsonc](wrangler.jsonc)의 `database_id` 자리표시자를 생성된 D1 ID로 교체합니다. 다른 이름을 사용했다면 Worker의 `name`, `database_name`, `bucket_name`도 맞춥니다. 같은 계정에 이미 사용 중인 리소스가 있으면 새로운 이름을 선택하세요. 이 스키마는 새 데이터베이스용입니다. 바인딩 이름 `DB`, `PHOTOS`, `PASSWORD_VERIFIER`, `ASSETS`는 코드에서 사용합니다.
3. 스키마를 적용하고 배포한 다음 운영 관리자 비밀번호를 설정합니다.

   ```sh
   npx wrangler d1 migrations apply DB --remote
   npm run deploy
   npm run password:hash -- --remote
   ```

4. Wrangler가 출력한 HTTPS 주소에서 `/admin`에 로그인하세요. 참가자에게는 같은 주소의 `/`를 공유합니다. 사용자 지정 도메인은 자기 Worker의 도메인 설정에서 연결할 수 있습니다.

GitHub Actions는 푸시와 PR에서 자동 검사만 수행합니다. 위 배포 명령은 본인의 Cloudflare 계정에서 실행하세요. Cloudflare Workers Builds로 자동 배포하려면 자기 저장소의 운영 브랜치만 연결하고, 저장소 루트에서 `NODE_VERSION=24`, 기본 자동 의존성 설치 `npm ci`, 빌드 명령 `npm run typecheck && npm test`, 배포 명령 `npm run deploy`를 지정합니다. `deploy`가 프론트를 빌드합니다. 기존 운영 Worker를 갱신하는 운영자는 아래의 `deploy:existing` 설정을 사용하세요. 로컬 비밀 파일과 Wrangler 상태는 Git에서 제외됩니다.

## 기존 운영 Worker의 코드만 교체

이미 12개 마이그레이션을 적용해 운영하던 투표 DB는 그대로 연결할 수 있습니다. **기존 DB에 새 설치용 `migrations/0001_initial.sql`을 적용하지 마세요.** 기존 Worker 이름, 계정, D1·R2, `PasswordVerifier` 클래스와 관리자 비밀 `ADMIN_PASSWORD_HASH`를 유지해야 합니다. 기존 비밀번호를 새로 설정하거나 기존 DB를 새 DB로 바꾸지 마세요. 관리자 자격증명 버전·비밀번호 변경 이력과 참가자/관리자 세션은 기존 저장 형식을 그대로 사용합니다.

1. [deploy-existing.example.json](deploy-existing.example.json)을 저장소 루트의 `.deploy-existing.json`으로 복사하고 모든 자리표시자를 기존 운영 값으로 바꿉니다. 이 비공개 파일은 Git에서 제외됩니다. `adminSessionCookie`와 `participantSessionCookie`에는 기존의 정확한 `__Host-` 쿠키 이름을 넣습니다. 값이 달라지면 기존 로그인은 인식되지 않습니다. `publicOrigin`은 정식 참가자 HTTPS origin, `routes`에는 그 호스트와 유지할 기존 별칭 호스트를 넣습니다.
2. 먼저 `npm run deploy:existing:check`로 패키지를 검증한 뒤 `npm run deploy:existing`로 배포합니다. 이 명령은 기존 설정으로 임시 Wrangler 파일을 만들고 실행 후 지웁니다. D1 마이그레이션 명령은 실행하지 않으며 SQL이 없는 `migrations-existing/`만 가리킵니다. 새 설치용 `npm run deploy`와 구분해서 사용하세요.
3. Cloudflare Workers Builds에서 이 저장소의 `main` 브랜치를 기존 운영 Worker에 연결하고 아래처럼 설정합니다. 다른 브랜치의 자동 배포는 끕니다. 다른 사용자는 자기 Cloudflare 계정과 자기 운영 자원의 값으로 구성합니다.

   | 항목 | 값 |
   | --- | --- |
   | 루트 디렉터리 | 저장소 루트 |
   | 빌드 환경변수 | `NODE_VERSION=24` |
   | 의존성 설치 | 기본 자동 설치 `npm ci` |
   | 빌드 명령 | `npm run typecheck && npm test` |
   | 배포 명령 | `npm run deploy:existing` |
   | 빌드 비밀 환경변수 | `VOTE_DEPLOY_CONFIG`에 `.deploy-existing.json`과 같은 JSON 전체 |

   `deploy:existing`이 프론트를 빌드한 뒤 기존 설정으로 배포합니다. 환경변수가 로컬 파일보다 우선합니다. 실제 계정·DB ID·도메인·쿠키 이름을 공개 저장소에 커밋하지 마세요. Worker의 기존 `ADMIN_PASSWORD_HASH` secret은 빌드 JSON에 넣지 않으며 그대로 유지합니다. 배포 권한은 해당 Worker·리소스에 필요한 계정 권한을 사용합니다.

연결 후 `main`에 푸시하면 Cloudflare가 자체 빌드 명령의 타입·테스트 검사를 통과한 커밋을 배포합니다. GitHub Actions의 기존 검사는 유지되며 Cloudflare와 각각 실행됩니다. 연결 설정과 해당 커밋의 Cloudflare 배포 성공을 확인한 뒤 자동 배포 완료로 판단합니다.

공유 링크와 QR은 `PUBLIC_ORIGIN`의 `/`를 가리키며 별칭 호스트로 관리자 페이지를 열어도 같습니다. 경로·쿼리·프래그먼트는 참가 주소에 넣지 않습니다. 이 전용 앱은 BYOB 활동만 노출하며, 기존 DB의 다른 활동에 응답이나 진행 정보가 남아 있으면 공유 참가자 삭제와 전체 초기화를 차단합니다. 빈 대기 상태의 이전 활동은 정상 초기화를 막지 않습니다. 아카이브 수정·삭제에는 새 마이그레이션이 필요하지 않습니다.

운영 배포 전 기존 D1·R2 백업과 설정을 보관하고, 배포 후 기존 쿠키로 참가자 상태·관리자 기록·사진과 정식 QR 주소를 확인하세요. 되돌릴 때도 같은 Worker·DB·R2·secret·쿠키 설정을 사용하면 데이터를 다시 만들 필요가 없습니다.

## 검증

```sh
npm run typecheck
npm test
npm run deploy:check
```

테스트는 격리된 Miniflare에서 실행합니다. `deploy:check`는 프론트를 빌드하고 Worker 패키지를 생성하는 dry run입니다.
기존 스키마 검증은 `tests/fixtures/legacy/`의 12개 마이그레이션을 격리 DB에만 적용합니다. 기존 자격증명·세션·기록을 합성 데이터로 재현하고, 다른 활동 보존과 아카이브 수정 경합을 확인합니다. 실제 운영 데이터에 시험 수정·삭제를 실행하지 않습니다.
