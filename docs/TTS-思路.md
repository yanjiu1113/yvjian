# TTS 接入思路（待做，先存档）

写于测试前，仅记录设计，未实施。

## 结论回顾

- **手机端本地跑 GPT-SoVITS：不可行**（权重 150MB+、只有 PyTorch、手机 CPU 一句要几十秒）
- **手机端跑 VITS/Piper/sherpa-onnx：可行**，但音色是预设说话人，不能克隆任意音色
- **PC 当 TTS 服务、手机当客户端：可行且最省事** —— 本机 `GPT-SoVITS-v2pro-20250604-nvidia50` 已自带 `api_v2.py`

## 方案 A：PC 当服务端（首选）

架构：

```
App(Bridge) --HTTP--> PC:9880/tts --GPU--> wav --> MediaPlayer
```

服务端（已存在，无需改）：

- 启动：`api_start.bat`（默认 9880）
- 合成：`POST /tts`，字段 `text`、`text_lang=zh`、`ref_audio_path`、`prompt_text`、`prompt_lang`、`speed_factor`、`streaming_mode`
- 换音色：`/set_gpt_weights`、`/set_sovits_weights`、`/set_refer_audio`

现有可用的音色权重（本机）：

- `Elysia_v2-e15.ckpt` / `Elysia_v2_e24_s13080.pth`
- `yayi_custom_voice-e15.ckpt` / `yayi_custom_voice_e8_s200.pth`
- `zekai-e15.ckpt` / `zekai_e8_s208.pth`
- 参考音频：`参考音频\my_voice_origin.wav`

App 侧要加的东西（预估 1 天）：

1. `Bridge.speak(String text, String voiceId)`：按音色查配置 → GET/POST `/tts` → 字节写 `cacheDir/tts/xxx.wav` → `MediaPlayer` 播放
2. `Bridge.stopSpeaking()`；`AudioFocus` 申请与释放；`setAudioAttributes(USAGE_MEDIA)`
3. 配置结构（存 meta）：`tts: { enabled, baseUrl, voices: [{id, name, gptWeights, sovitsWeights, refAudio, promptText, promptLang}], speed }`
4. UI：设置里配服务地址 + 音色列表；消息气泡上加「朗读」按钮；可加「自动朗读」开关
5. 文本清洗：朗读前剥 Markdown 标记、代码块、URL
6. 断句：按 `。！？\n` 切分，逐句请求，避免长文本超时

约束：

- PC 需开机、同局域网（或 Tailscale）
- `api_v2.py` 默认无鉴权，暴露公网前必须加 token/反代
- 参考音频是服务端本地路径，手机只能传路径名

## 方案 B：手机端本地（如果以后必须离线）

- 选型：sherpa-onnx（有 Android demo）/ Piper / MeloTTS
- 音色：选说话人编号，不能克隆
- 想用自己的音色：微调 VITS → 导出 ONNX → 本地推理；工程量单独评估

## 待确认

1. 是否接受 PC 常开、App 走局域网
2. 要接几个音色
3. 自动朗读 vs 手动朗读；是否要锁屏/后台继续播（要 ForegroundService + MediaSession，工作量再 +1~2 天）
