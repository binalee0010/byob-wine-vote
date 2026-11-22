# 와인 인기투표

모임에서 맛본 와인에 휴대전화로 투표하는 한국어 웹앱입니다. 회원은 여러 장의 사진이나 와인 이름으로 투표를 만들 수 있습니다. 참가자는 이름을 입력해 투표하며, 마감 전까지 선택을 바꿀 수 있습니다. 한 사람의 마지막 제출만 집계합니다.

| 방식 | 예시 |
| --- | --- |
| 1개만 선택 | 가장 마음에 든 후보 하나에 1표 |
| 전체 순위 설정 | 후보가 7개면 1위 7점부터 7위 1점까지. 드래그 또는 위·아래 버튼으로 정렬 |
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

비밀번호 설정 명령은 터미널에서 새 관리자 비밀번호를 두 번 묻습니다. 입력한 문자는 화면에 표시되지 않습니다. 해시만 로컬 `.dev.vars`에 저장하며 이미 파일이 있으면 덮어쓰지 않습니다. 처음 한 번 설정하면 이후에는 `npm run dev`로 다시 열 수 있습니다.

회원제를 시험하려면 비밀번호 설정 후 로컬 `.dev.vars`에 `SUPERADMIN_EMAIL=owner@example.test`를 추가하고 다시 실행하세요. [로그인](http://localhost:8787/admin)에서 이 주소와 방금 정한 비밀번호로 접속합니다. 회원제가 설정되지 않은 단독 설치에서는 `/`가 기존 참가자 화면입니다. 로컬 데이터와 사진은 Wrangler가 `.wrangler/`에 보관합니다.

## 회원 가입과 참가 링크

1. 회원은 `/` 또는 `/admin`에서 이메일과 비밀번호로 가입을 신청합니다. 관리자에게 신청 알림이 발송됩니다.
2. 관리자는 오른쪽 위 **설정 → 가입 승인**에서 승인하거나 거절합니다. 가입을 신청한 회원은 **승인 상태 확인**을 눌러 자기 관리 화면을 엽니다. 이후 같은 이메일과 비밀번호로 접속할 수 있습니다.
3. 승인된 회원은 **내 투표**에서 여러 투표를 만들 수 있습니다. 투표마다 고유한 관리 주소 `/admin/p/<고유주소>`와 짧은 참가 주소 `/v/<8자리 무작위 주소>`가 생깁니다. 회원 설정은 오른쪽 위에서 열 수 있습니다.
4. 로그인 화면의 **비밀번호 재설정**에서 가입한 이메일을 입력합니다. 메일 링크는 30분 동안 한 번만 사용할 수 있습니다. 새 비밀번호를 설정하면 해당 회원은 다시 로그인해야 합니다.
5. 기존 설치에서 관리자가 운영하던 투표도 **내 투표 목록**에서 열 수 있습니다. **투표 진행**의 주소 복사·QR 코드와 **참가자 화면 보기**는 같은 짧은 주소를 사용합니다. 기존에 공유한 긴 참가 주소와 로그인 상태도 유지되며, 삭제한 투표의 주소는 다시 사용하지 않습니다.

## 투표 운영

1. **내 투표 목록**에서 **새 투표 만들기**에 제목을 입력합니다. 각 투표의 **투표 진행 → 투표 정보**에서 제목과 메모를 수정하고 **설정 모두 저장**을 누릅니다. 메모는 관리 화면에서만 보입니다.
2. **후보 등록**에서 사진을 선택하면 바로 등록되며, 등록 후 표시 이름을 수정할 수 있습니다. 사진을 여러 장 선택하거나 이름만 적어 와인을 추가합니다. 기존 후보의 **사진 추가** 또는 **사진 변경**으로 나중에 사진을 등록할 수 있습니다. 와인 번호와 기존 표는 유지됩니다.
3. **투표 진행**에서 참가 주소나 QR 코드를 공유하고 투표를 시작합니다. 같은 화면의 **제출 현황**에 참여한 이름과 제출 여부가 표시됩니다.
4. **결과 공개**는 마감 전에 미리 설정하거나 마감 후 바꿀 수 있습니다. **호스트만 보기**는 관리 화면에서만, **참가자만 보기**는 해당 투표에 참여한 닉네임으로 로그인한 뒤, **전체 공개**는 참가 링크를 연 누구나 마감된 결과를 봅니다.
5. 마감한 투표는 **내 투표 목록 → 해당 투표 → 투표 결과**에서 다시 엽니다. **후보 등록**과 **투표 결과** 양쪽에서 시작 전과 마감 후에 와인 이름을 수정할 수 있습니다. 같은 점수는 공동 순위입니다. 다음 모임에는 새 투표를 만들면 이전 결과가 그대로 남습니다.
6. **현재 투표 전체 초기화**는 참가자·와인·응답을 지우고 같은 투표를 다시 사용합니다. 투표 자체를 삭제하려면 해당 투표의 **투표 진행** 화면 맨 아래에서 **투표 삭제**를 누르고 제목을 확인하세요. 삭제가 끝나면 목록으로 돌아가고 관리 주소와 참가 링크가 닫힙니다. 다른 활동과 데이터를 공유하는 이전 설치의 기본 투표는 삭제 시 공유 원본을 보존합니다.

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

4. 회원제 운영 시 `wrangler.jsonc`의 `vars`에 `PUBLIC_ORIGIN`을 자신의 HTTPS 기본 주소로, `MEMBERSHIP_REQUIRED`를 문자열 `"true"`로 설정합니다. Worker에 두 비밀값을 등록한 후 새 설정을 배포하세요.

   ```sh
   npx wrangler secret put SUPERADMIN_EMAIL
   npx wrangler secret put SMTP_CONFIG
   npm run deploy
   ```

   첫 번째 값은 기존 관리자 비밀번호로 로그인할 유일한 이메일입니다. 두 번째 값은 인증된 발신 계정의 TLS SMTP 설정 JSON입니다. 예시는 `{"host":"smtp.example.com","port":465,"secure":true,"user":"mailer@example.com","pass":"SMTP_APP_PASSWORD","from":"mailer@example.com"}`입니다. 운영 주소와 실제 자격증명은 서버 설정에만 입력하세요. 신청 알림은 가입 직후 전송하며 실패한 건은 10분마다 확인해 재시도합니다.

GitHub Actions는 푸시와 PR에서 자동 검사만 수행합니다. 위 배포 명령은 본인의 Cloudflare 계정에서 실행하세요. Cloudflare Workers Builds로 자동 배포하려면 자기 저장소의 운영 브랜치만 연결하고, 저장소 루트에서 `NODE_VERSION=24`, 기본 자동 의존성 설치 `npm ci`, 빌드 명령 `npm run typecheck && npm test`, 배포 명령 `npm run deploy`를 지정합니다. `deploy`가 프론트를 빌드합니다. 기존 운영 Worker를 갱신할 때는 아래의 `deploy:existing` 설정을 사용하세요. 로컬 비밀 파일과 Wrangler 상태는 Git에서 제외됩니다.

## 기존 운영 Worker를 회원제로 전환

이미 12개 마이그레이션을 적용해 운영하던 투표 DB는 그대로 연결할 수 있습니다. **기존 DB에 새 설치용 `migrations/0001_initial.sql`을 적용하지 마세요.** 기존 Worker 이름, 계정, D1·R2, `PasswordVerifier` 클래스와 관리자 비밀 `ADMIN_PASSWORD_HASH`를 유지해야 합니다. 기존 비밀번호를 새로 설정하거나 기존 DB를 새 DB로 바꾸지 마세요. 관리자 자격증명 버전·비밀번호 변경 이력과 참가자/관리자 세션은 기존 저장 형식을 그대로 사용합니다.

1. [deploy-existing.example.json](deploy-existing.example.json)을 저장소 루트의 `.deploy-existing.json`으로 복사하고 모든 자리표시자를 기존 운영 값으로 바꿉니다. 이 비공개 파일은 Git에서 제외됩니다. `adminSessionCookie`와 `participantSessionCookie`에는 기존의 정확한 `__Host-` 쿠키 이름을 넣습니다. 값이 달라지면 기존 로그인은 인식되지 않습니다. `publicOrigin`은 정식 참가자 HTTPS origin, `routes`에는 그 호스트와 유지할 기존 별칭 호스트를 넣습니다.
2. 기존 Worker의 **Settings → Variables and Secrets**에 위 두 Secret을 추가합니다. D1 복구 지점을 확보한 뒤 `npm run deploy:existing:check`, `node scripts/deploy-existing.mjs --migrate` 순서로 실행합니다. 기존 12개 이력에 회원, 비밀번호 재설정, 후보 설명, 회원별 투표 목록, 참여 기록, 투표 삭제, 메모, 결과 공개 범위, 기존 투표의 고유 주소, 후보 사진 변경과 짧은 참가 주소를 위한 `0013`~`0023` 마이그레이션을 순서대로 적용합니다. 이미 적용한 마이그레이션은 건너뜁니다. 이후 자동 배포는 코드를 갱신합니다. 직접 배포하는 환경에서는 `npm run deploy:existing`을 실행합니다.
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

기존 운영 `vinolog-vote`의 배포 설정만 `vinolog-vote-deploy-failures` Queue를 소비합니다. 이 Queue를 [Workers Builds 실패 이벤트 구독](https://developers.cloudflare.com/workers/ci-cd/builds/event-subscriptions/)에 연결하면 `binalee0010/byob-wine-vote`의 `main` 빌드·배포 실패만 기존 `SMTP_CONFIG`로 `SUPERADMIN_EMAIL`에 알립니다. 메일에는 빌드 화면 링크만 담고, 전송 실패는 5분 간격으로 최대 5회 재시도합니다. Queue 재전달에는 같은 Message-ID를 사용하지만 SMTP 수신 직후 응답이 유실되면 중복 메일이 생길 수 있습니다. 운영 배포 토큰에는 Queue consumer 설정 권한도 필요하며, 공개 설치용 `wrangler.jsonc`에는 이 Queue를 추가하지 않습니다.

공유 링크와 QR은 정식 `PUBLIC_ORIGIN`과 해당 투표의 참가 경로를 사용합니다. 투표별로 참가자·후보·사진·집계가 분리되고, 전체 초기화는 현재 열어 둔 투표에만 적용됩니다. 기존 DB에서 다른 활동과 참가 기록을 공유하는 경우에는 전체 초기화를 차단합니다.

운영 배포 전 기존 D1·R2 백업과 설정을 보관하고, 배포 후 기존 쿠키로 참가자 상태·관리자 기록·사진과 정식 QR 주소를 확인하세요. 되돌릴 때도 같은 Worker·DB·R2·secret·쿠키 설정을 사용하면 데이터를 다시 만들 필요가 없습니다.

## 검증

```sh
npm run typecheck
npm test
npm run deploy:check
```

테스트는 격리된 Miniflare에서 실행합니다. `deploy:check`는 프론트를 빌드하고 Worker 패키지를 생성하는 dry run입니다.
기존 스키마 검증은 `tests/fixtures/legacy/`의 12개 마이그레이션을 격리 DB에만 적용합니다. 기존 자격증명·세션·기록을 합성 데이터로 재현하고, 다른 활동의 데이터 보존과 결과 열람 권한을 확인합니다. 실제 운영 데이터에 시험 수정·삭제를 실행하지 않습니다.
