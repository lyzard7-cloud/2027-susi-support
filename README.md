# 2027학년도 3학년 수시지원 관리 시스템 v1

학생이 지원 예정 대학·학과·전형을 등록하고, 3학년 담임교사가 전체 지원 현황과 중복지원을 확인하는 GitHub Pages + Firebase 기반 웹앱입니다.

## 포함 기능

- 학생: 반/번호/이름 입력
- 대학·학과·전형유형·전형명 복수 등록
- 지원상태: 검토중 / 담임확인 / 최종결정 / 원서접수완료
- 교사: Firebase 이메일/비밀번호 로그인
- 전체 지원현황 실시간 조회
- 중복 자동 탐지
  - 🔴 대학 + 학과 + 전형명 동일
  - 🟠 대학 + 학과 동일, 전형 상이
- 반 / 검색 / 전형유형 / 중복유형 필터
- CSV 내려받기
- 모바일 대응

---

# 중요한 보안 안내

이 프로그램의 소스코드는 GitHub Pages에 공개되어도 되지만 **학생 지원 데이터는 GitHub에 저장하지 않습니다.**
학생 데이터는 Firebase Firestore에 저장됩니다.

학생 페이지는 Firebase **익명 인증(Anonymous Authentication)** 을 사용합니다.
학생은 별도의 아이디나 비밀번호를 입력하지 않지만, 브라우저에는 익명 사용자 UID가 만들어집니다.

- 학생: 자신이 그 브라우저에서 등록한 자료만 조회/수정
- 교사: 이메일/비밀번호 로그인 후 전체 자료 조회
- 다른 학생의 자료: 학생 화면에서 조회 불가

주의: 학생이 다른 휴대폰/PC를 사용하거나 브라우저 데이터를 삭제하면 익명 UID가 달라져 기존 자료를 직접 수정할 수 없습니다. 이 경우 담임교사가 수정하거나, 이후 v2에서 학생별 PIN/학교 계정 로그인을 추가하는 방식이 좋습니다.

# 1. Firebase 만들기

## 1-1. 프로젝트 생성
1. https://console.firebase.google.com 접속
2. `프로젝트 추가`
3. 예: `school-2027-admission`
4. Google Analytics는 이 프로그램에는 필수가 아니므로 끄고 시작해도 됩니다.

## 1-2. 웹 앱 등록
1. Firebase 프로젝트 화면에서 `</>` 웹 아이콘
2. 앱 닉네임 예: `수시지원관리`
3. Firebase Hosting 체크는 하지 않아도 됩니다.
4. 앱 등록
5. 아래처럼 표시되는 firebaseConfig를 복사합니다.

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

6. 이 프로젝트의 `firebase-config.js` 파일을 열어 값을 교체합니다.

## 1-3. Firestore 만들기
1. 왼쪽 메뉴 `빌드` > `Firestore Database`
2. `데이터베이스 만들기`
3. 운영에 가까운 설정을 위해 Production mode 선택
4. 위치 선택 후 생성
5. `Rules` 탭에서 이 프로젝트의 `firestore.rules` 내용을 참고하여 규칙 설정

## 1-4. 교사 로그인 만들기
1. `빌드` > `Authentication`
2. `시작하기`
3. Sign-in method에서 `이메일/비밀번호` 활성화
4. Sign-in method에서 `익명`(Anonymous)도 활성화
5. Users 탭 > 사용자 추가
6. 9명의 담임교사 계정을 각각 생성

예:
- teacher1@school.kr
- teacher2@school.kr
- ...

실제 이메일 주소일 필요는 없지만, 학교에서 관리 가능한 규칙으로 만드는 것을 권장합니다.

---

# 2. GitHub에 올리기

## 2-1. GitHub 계정
1. https://github.com 접속
2. Sign up으로 계정 생성
3. 이메일 인증

## 2-2. 저장소 만들기
1. 우측 상단 `+`
2. `New repository`
3. Repository name: `teamkill`
4. Public 선택
5. `Create repository`

## 2-3. 파일 업로드
1. 생성한 저장소로 들어가기
2. `Add file`
3. `Upload files`
4. 이 폴더 안의 파일을 업로드
5. 아래 `Commit changes`

업로드 대상:
- index.html
- admin.html
- style.css
- firebase-config.js
- student.js
- admin.js
- .nojekyll

`firestore.rules`와 `README.md`도 저장소에 함께 둬도 됩니다. 개인정보 자체는 절대로 저장소에 넣지 마세요.

## 2-4. GitHub Pages 켜기
1. 저장소 상단 `Settings`
2. 왼쪽 `Pages`
3. Build and deployment
4. Source → `Deploy from a branch`
5. Branch → `main`
6. Folder → `/(root)`
7. Save

주소 예:
`https://내아이디.github.io/teamkill/`

학생 페이지:
`https://내아이디.github.io/teamkill/`

교사 페이지:
`https://내아이디.github.io/teamkill/admin.html`

---

# 3. 테스트 순서

1. Firebase 설정 완료
2. firebase-config.js 값 입력
3. GitHub에 업로드
4. GitHub Pages 주소 접속
5. 학생 화면에서 테스트 지원정보 입력
6. 교사용 화면 접속
7. Authentication에 만든 교사 계정으로 로그인
8. 같은 대학·학과·전형을 2명 이상 입력해서 🔴 중복 탐지 확인
9. 대학·학과는 같고 전형만 다르게 입력해서 🟠 표시 확인

---

# 4. 실제 운영 전 추천 개선

학교에서 실제 학생 개인정보와 지원정보를 다루는 경우 v2에서는 다음을 붙이는 것을 추천합니다.

- 학생별 개인 PIN
- 학생은 자기 자료만 조회/수정
- 교사는 전체 조회
- 학생 수정 이력 보관
- 대학/학과 자동완성 마스터 데이터
- 학교장추천 전형 별도 경고
- 추천 가능 인원 설정
- 6장 초과 경고
- 원서접수 여부
- 합격/충원/최종등록 관리

