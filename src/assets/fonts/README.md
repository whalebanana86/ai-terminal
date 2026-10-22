# Haengbang Mono

터미널 글꼴. [D2Coding 1.3.2](https://github.com/naver/d2codingfont) (Copyright (c) 2015 NAVER Corporation)에서 영문·한글 음절·자모·터미널에 쓰는 기호만 남기고(한자 제외) woff2 로 줄인 수정본입니다.
D2Coding 은 영문 한 칸의 정확히 두 배가 한글 폭이라, 한글을 두 칸에 그리는 터미널에서 글자 사이가 벌어지지 않습니다.

SIL Open Font License 1.1 에 따라 예약된 글꼴 이름(D2Coding)을 쓰지 않고 이름을 바꿨습니다. 라이선스 원문: [HaengbangMono-OFL.txt](HaengbangMono-OFL.txt)

만든 방법: `pyftsubset` 로 U+0020-007E, U+00A0-017F, U+02B0-02FF, U+2000-206F, U+20A9, U+20AC, U+2100-214F, U+2190-21FF, U+2200-22FF, U+2300-23FF, U+2460-24FF, U+2500-259F, U+25A0-25FF, U+2600-27BF, U+3000-303F, U+3130-318F, U+1100-11FF, U+AC00-D7A3, U+FF00-FFEF 만 남기고, name 표의 이름(1·3·4·6)을 Haengbang Mono 로 바꿈.
