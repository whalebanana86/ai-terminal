# 작업 기억 PoC

`docs/WORK_MEMORY.md`의 PoC 항목을 재는 시험 프로그램입니다. 앱 코드와 떨어져 있고, 앱 빌드에는 들어가지 않습니다.

구성: EmbeddingGemma 2(ONNX) + ONNX Runtime 1.31(실행 중에 불러오기, `ort` `load-dynamic`) + SQLite FTS5 `trigram` + 전수 내적 + RRF.

## 준비 (저장소 밖 폴더 하나에)

```sh
export WM_DIR=<작업 폴더>          # 모델·라이브러리·색인을 둘 곳(저장소 밖)
export CARGO_TARGET_DIR=$WM_DIR/target

# ONNX Runtime (Apple Silicon, macOS 14 이상)
curl -L https://github.com/microsoft/onnxruntime/releases/download/v1.31.1/onnxruntime-osx-arm64-1.31.1.tgz | tar -xz -C $WM_DIR/ort

# 모델 (커밋 고정)
REV=daa72c51243991dfcaf9f9137d2c573d8f7790c0
B=https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/$REV
for f in tokenizer.json onnx/model_quantized.onnx onnx/model_quantized.onnx_data onnx/model_q4.onnx onnx/model_q4.onnx_data; do
  curl -L --create-dirs -o $WM_DIR/models/eg2/$f $B/$f
done

cargo build --release
```

## 명령

기록 묶음 만들기: `python3 -I build_corpus.py` → `$WM_DIR/data/chunks.jsonl`, `turns.jsonl` (Claude·Codex 기록, 비밀값 가림)

| 명령 | 하는 일 |
|---|---|
| `work-memory-poc info --variant int8` | 모델 입출력, 예문 유사도 |
| `work-memory-poc bench --variant int8 --ep cpu --batch 4` | 불러오기·조각 1개·질의 1개·조각 100개 시간, 최대 메모리 |
| `work-memory-poc index --variant int8 --batch 4 --db $WM_DIR/data/index.sqlite3` | `data/chunks.jsonl` 전체 색인(글 + trigram + 768차원 벡터) |
| `work-memory-poc eval --variant int8 --db … [--queries 파일]` | `data/queries.jsonl` 로 키워드 / 벡터 768·256·256 int8 / RRF 세 가지의 턴 단위 순위 |
| `work-memory-poc scan --n 100000` | 10만 개 × 256차원 전수 내적 시간 |

옵션: `--variant int8|q4|int8t|q4t`(`t`는 멀티모달 입력을 빈 상수로 바꾼 텍스트 전용 구조), `--ep cpu|coreml`, `--threads N`, `--lean 1`(CPU arena 끄기), `--maxtok N`.

`data/chunks.jsonl`(조각)과 `data/queries.jsonl`(질의·정답 턴)은 실제 작업 기록에서 만들기 때문에 **저장소에 넣지 않습니다.** 조각 형식은 `{"id", "turn", "kind": "user|assistant|error|edit", "text"}`이고, 질의 형식은 `{"q", "turns": [정답 턴], "kind": "semantic|keyword"}`입니다.

## 함정
- `ort` 2.0.0-rc.15는 세션을 만들 때 기본으로 '전력 효율 우선' 장치 선택을 켭니다(Apple 칩에서는 Core ML). CPU로 돌리려면 `with_auto_device(PreferCPU)`를 명시해야 합니다.
- 이 모델은 텍스트만 쓸 때도 `image_features`·`video_features`·`audio_features` 입력에 `[0, 512]` 빈 텐서를 넘겨야 합니다. Core ML EP는 빈 텐서를 받지 못해 실패합니다.
  - 텍스트 전용 구조(`*_text.onnx`)는 세 입력을 빈 상수로 바꿔 만듭니다. 가중치 파일은 원래 것을 그대로 씁니다.
    ```python
    import onnx; from onnx import helper, TensorProto
    m = onnx.load("model_quantized.onnx", load_external_data=False); g = m.graph
    names = ["image_features", "video_features", "audio_features"]
    keep = [i for i in g.input if i.name not in names]; del g.input[:]; g.input.extend(keep)
    g.initializer.extend(helper.make_tensor(n, TensorProto.FLOAT, [0, 512], []) for n in names)
    onnx.save(m, "model_quantized_text.onnx")
    ```
  - 이렇게 해도 Core ML은 양자화 모델에서 CPU보다 느렸습니다(`docs/WORK_MEMORY.md` 7.2).
- zsh에서 변수에 담은 인자는 `${=args}`로 나눠야 합니다.

결과는 `docs/WORK_MEMORY.md`의 "PoC 결과"에 적습니다.
