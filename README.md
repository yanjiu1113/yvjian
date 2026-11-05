# 语见（Yujian）

一个跑在 Android 上的极简聊天客户端，连接你自己的 OpenAI 兼容接口。

**只做「填地址 + 填 Key + 收发消息 + 本地保存」**，客户端不做内容审查、不注入审查提示词、不改写你的输入。

> 审查与过滤取决于你调用的模型和服务端策略，不在这个客户端里。

[MIT](LICENSE) · Android 8.0+ · 约 0.5 MB

- 安装包 **不到 0.5 MB**，不内置模型、无第三方埋点
- `minSdk 26`（Android 8.0+），`targetSdk 34`
- 协议：OpenAI 兼容（`{baseUrl}/chat/completions`、`{baseUrl}/models`）
- 已验证：OpenRouter、DeepSeek 官方，以及任意兼容端点（one-api / new-api 中转、Ollama、LM Studio、自建网关）

<p align="center">
  <img src="app/src/main/assets/mascot-empty.webp" width="180" alt="语见小狐狸">
</p>

## 功能

| 功能 | 说明 |
| --- | --- |
| 多服务商 | OpenRouter / DeepSeek / 任意兼容地址，可并存，会话间独立 |
| 流式输出 | SSE 逐字渲染，可中断；`reasoning_content` 折叠为「思考过程」 |
| 对话设置 | 温度、max_tokens、top_p、上下文条数、系统提示词、流式开关，随时可调 |
| 联网搜索 | **由模型自主决定是否搜索**，支持 Tavily / Serper / Brave（需 Key）与 DuckDuckGo / Bing / 百度（免 Key） |
| 表情包 | 文件夹导入（子文件夹=情绪分类），支持 GIF、按分类设概率、可删单张/整类 |
| 语音朗读 | 优先调用 CloneTTS 本地接口，失败回落系统 TTS；句级切分、可调速、可自动朗读 |
| 头像 | 我和 AI 分开设置，相册选图（裁方形 192px） |
| 气泡样式 | 我和 AI 分开选（经典红 / 奶白；深色 / 奶白），即时生效 |
| 聊天背景 | 5 套预设 + 自定义图片（可调遮罩），含「语见」狐狸背景 |
| 会话管理 | 按今天/昨天/本周/更早分组，重命名、删除、单条导出 |
| 导入导出 | 单个或全部会话导出 JSON，可再导入；导出不含 Key |
| Key 安全 | 服务商 Key 与搜索 Key 用 Android Keystore（AES-256-GCM）加密，JS 层拿不到明文 |
| 诊断 | 内置可复制日志（`[chat]` `[search-start]` `[tts]` 等），排障用 |

## 安装

1. 下载 Releases 里的 APK 传到手机安装
2. 首次安装需允许「安装未知来源应用」
3. 覆盖安装旧版本即可升级（签名一致，配置与会话保留）

## 首次使用

1. 打开 App → 右上角齿轮 → **服务商** → 点 `OpenRouter` 或 `DeepSeek`（或「自定义」）
2. 点该服务商的「编辑」，粘贴 API Key，保存
3. 点「拉取模型」，选择一个；或手动填模型 ID
4. 回聊天页开聊。回车是换行，`Ctrl+回车` 或点发送按钮才发出

## 从源码构建

不依赖 Gradle / AGP，直接用 SDK 工具链：`aapt2` → `javac` → `d8` → `zip` → `zipalign` → `apksigner`。

需要：

- JDK 17
- Android SDK（build-tools 34.0.0、platform android-34）

```powershell
# 把 JDK 与 SDK 放到 .toolchain/ 下（或用环境变量指向）
#   .toolchain/jdk-17/
#   .toolchain/android-sdk/
powershell -ExecutionPolicy Bypass -File build.ps1
# 产物：dist/Yujian-<版本>.apk
```

首次构建会自动生成签名密钥到 `keystore/`（口令 `llmchat-local`）——**这个目录不要提交**。

## 测试

```bash
node test/run-tests.mjs      # 155 条行为断言（vm + 假 DOM）
node test/wiring-check.mjs   # 检查 JS 用到的 id / 原生方法 / CSS 类是否存在
```

Java 侧搜索解析器有独立用例：`test/java/dev/local/llmchat/SearchTest.java`（52 条）。

## 项目结构

```
app/src/main/assets/    界面（HTML/CSS/JS）与素材
app/src/main/java/      原生层：HTTP、SSE、搜索、TTS、Keystore、存储
pet/                    情趣版（独立 APK，语见的插件）
test/                   Node 行为测试 + Java 搜索解析测试
tools/                  SDK 抓取脚本
build.ps1               构建脚本
语见-说明.txt             完整文档（定位 / 免责 / 用法 / 角色设定）
```

## 情趣版（pet/）

同一个仓库里的第二个 APK：把 BLE 成人设备接进对话，由模型按情绪决定输出。支持郊狼 3.0、役次元榨精杯、役次元电击器二代。

- 独立包名 `dev.local.yujian.pet`，与语见分开安装
- 三模式护栏（1–20 / 1–50 / 1–100），起始归零、强度硬上限、急停、看门狗都在原生层
- 构建：`powershell -File pet\build.ps1`，工具链共用根目录 `.toolchain`
- **18+**，细节与免责见 [pet/README.md](pet/README.md)

## 免责声明（摘要）

- 本软件**不提供模型服务**，需自备 API Key，费用由服务商收取
- 对话内容由模型生成，作者无法控制、不为其内容背书
- 客户端**不做内容审查**，出现不当内容不会被本软件拦截
- 请遵守所在地法律法规与服务商条款，违规使用后果自负
- 语音克隆**仅限本人或已获授权的声音**；表情包素材版权由使用者负责
- 本软件按「现状」提供，不附带任何担保

完整条款见 [语见-说明.txt](语见-说明.txt) 第二节，**使用即视为同意**。

## 致谢

- [CloneTTS](https://github.com/sipeter/clonetts) — 离线音色克隆 TTS（sherpa-onnx / ZipVoice / ONNX Runtime）
- Tavily / Serper / Brave — 搜索 API

## 许可证

[MIT](LICENSE) © 2026 yanjiu1113

简单说：随便用、随便改、随便分发，包括商用；保留版权声明即可，出了事别找我。
