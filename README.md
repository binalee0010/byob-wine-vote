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

GitHub Actions는 푸시와 PR에서 자동 검사만 수행합니다. 위 배포 명령은 본인의 Cloudflare 계정에서 실행하세요. 로컬 비밀 파일과 Wrangler 상태는 Git에서 제외됩니다.

## 검증

```sh
npm run typecheck
npm test
npm run deploy:check
```

테스트는 격리된 Miniflare에서 실행합니다. `deploy:check`는 프론트를 빌드하고 Worker 패키지를 생성하는 dry run입니다.
