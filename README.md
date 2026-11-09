# dsh-remote-control

> 把桌面上的 **DeepSeek Harness** 变成可以用手机或另一台电脑远程控制的节点。
> 自带 NAT 打洞、端到端加密隧道、文件会话 RPC —— 不依赖 EasyTier、WireGuard、Tailscale 或任何中转服务。

![license](https://img.shields.io/badge/license-MIT-blue)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![node](https://img.shields.io/badge/node-%E2%89%A520-339933)
![status](https://img.shields.io/badge/status-experimental-orange)

> [!WARNING]
> 这个插件会把本机一部分文件和 Harness 会话**开放给持有配对码的设备**。它是实验性项目，
> 默认没有设备审批、没有访问日志。先用后读 [安全模型](#安全模型)。

---

## 目录

- [为什么需要它](#为什么需要它)
- [功能](#功能)
- [工作方式](#工作方式)
- [快速开始](#快速开始)
- [客户端](#客户端)
- [配置](#配置)
- [中继兜底](#中继兜底)
- [安全模型](#安全模型)
- [已知限制与路线图](#已知限制与路线图)
- [开发与测试](#开发与测试)
- [目录结构](#目录结构)
- [License](#license)

## 为什么需要它

Harness 的 Web UI 只监听 `127.0.0.1`，出了这台电脑就够不着。常见的做法是装一套组网工具（EasyTier / Tailscale）+ 反向代理 + 自己处理鉴权，链路长、依赖多、手机端还得装 App。

这个插件把整件事收进一个 Host 插件里：

* 用 **STUN + UDP 打洞** 直连，打不通才退回 **TCP 中继**；
* 隧道用 **X25519 + AES-256-GCM** 端到端加密，中继只转发密文；
* 对客户端暴露一套 **JSON-RPC**（文件、会话、端口转发），自己实现客户端只需照 [协议文档](docs/PROTOCOL.md) 走；
* 需要完整 UI 时，也能把原生 Harness 界面通过隧道搬进手机 WebView。

## 功能

| 能力 | RPC | 说明 |
| --- | --- | --- |
| 主机信息 | `sys.info` | 指纹、可浏览根目录、带 token 的 Web UI 地址 |
| 文件浏览 | `fs.list` / `fs.stat` / `fs.roots` | 默认根目录 = 所有会话工作区 + 家目录，可用 `roots` 收紧 |
| 文件下载 | `fs.read` | 分块读取，带 `offset` / `eof` |
| 文件上传 | `fs.write` | 偏移必须等于当前大小，**天然支持断点续传** |
| 目录操作 | `fs.mkdir` / `fs.remove` / `fs.rename` | |
| 会话列表 | `session.list` | 标题、运行状态、工作目录 |
| 会话控制 | `session.create` / `session.prompt` / `session.cancel` | 远程给 Agent 下指令 |
| 实时跟随 | `session.watch` / `session.unwatch` | 推送 `session.frame` 事件 |
| 端口转发 | `tunnel.open` / `tunnel.write` / `tunnel.close` | 把原生 Web UI 搬进 WebView |

Agent 侧还注册了 6 个工具（`remote_control_status` / `_start` / `_stop` / `_pair` / `_clients` / `_disconnect`），可以直接在对话里让 Agent 生成配对码。

设置页（设置 → **远程访问**）提供状态、**配对二维码**、已连接设备、可访问目录与撤销配对。二维码由内置编码器实时生成（byte 模式、ECC L、版本自适应），手机客户端直接扫即可，不需要联网、不调用任何第三方服务。

## 工作方式

```
手机 App / 浏览器 ──┐
                    ├─ 局域网 TCP ─────┐
另一台电脑 CLI ─────┘                  ├──> Harness Host 进程
                    UDP 打洞（STUN）───┤     ├ tcp 45871  直连
                    └─ TCP 中继（可选）─┘     ├ udp 45873  打洞
                                             └ /dsh-remote 设置页 API
```

分层：

```
JSON-RPC                    文件 / 会话 / 隧道
AES-256-GCM + 分片           每帧独立 nonce，分片重组
X25519 + HMAC 握手           HKDF(ECDH ‖ 配对密钥)，双向校验
可靠 UDP / TCP              序号 + ACK + 重传 + 乱序缓存 + 保活
STUN + 打洞                 公网映射探测，双向 PUNCH
```

## 快速开始

### 1. 安装

把仓库放到任意目录，然后在 Harness 里把它作为**本地 bundle** 安装：

```text
设置 → 插件 → 添加 → 本地目录（选择本仓库根目录）
```

或让 Agent 调用 `plugin_manager` 的 `install_bundle`，`target` 指向本仓库绝对路径。安装后插件立即激活，默认自启监听。

### 2. 生成配对码

设置 → **远程访问** → **生成配对码**，得到一串 `dshr1.…` 和一个二维码；也可以让 Agent 直接调用 `remote_control_pair`。

二维码里就是那串文本（870 字节 → 101×101 模块的 v21 符号），手机端用 `@kit.ScanKit` 扫出来直接喂给客户端即可。

### 3. 连接

```powershell
node tools/remote-client.mjs --pair "dshr1.…" info
node tools/remote-client.mjs --pair "dshr1.…" sessions
node tools/remote-client.mjs --pair "dshr1.…" ls "E:\HarmonyOS"
node tools/remote-client.mjs --pair "dshr1.…" put .\photo.jpg "E:\Uploads\photo.jpg"
node tools/remote-client.mjs --pair "dshr1.…" prompt <sessionId> "跑一下测试"
```

## 客户端

### 命令行（Node，任意系统）

[tools/remote-client.mjs](tools/remote-client.mjs)：`info` `sessions` `prompt` `cancel` `ls` `get` `put` `mkdir` `rm`。它同时是**可执行的协议规范**。

### 鸿蒙（ArkTS）

[client/arkts/RemoteTunnel.ets](client/arkts/RemoteTunnel.ets)：配对码解析、X25519 握手、AEAD 分片、可靠 UDP、TCP/中继链路、RPC 与上传下载。接进 DevEco 工程即可（`ohos.permission.INTERNET`）。

### 完整 Web UI

`sys.info` 返回 `web.url`（带 token 的 Harness 地址）。把它配合 `tunnel.open` 转发到本机端口，就能在手机 WebView 里打开完整的 Harness 界面——不需要重写聊天 UI。

### 自己实现

读 [docs/PROTOCOL.md](docs/PROTOCOL.md)：链路格式、握手证明、AEAD 帧、RPC 清单、打洞步骤、中继协议、错误码，全在里面。

## 配置

在 `cordis.patch.yml` 里覆盖 `config`：

```yaml
- insert:
    - id: dsh-remote-control
      name: '@local/dsh-remote-control'
      config:
        name: '我的主机'          # 客户端看到的名字
        bindHost: '0.0.0.0'       # 只在局域网用可改成具体网卡地址
        tcpPort: 45871            # 直连 / 中继端口
        udpPort: 45873            # 打洞端口
        autoStart: true
        roots: []                 # 留空 = 所有会话工作区 + 家目录；填了就只开放这些目录
        relay:
          host: ''                # 中继服务器（见下）
          port: 45880
          token: ''
        stunServers: []           # 留空 = 内置公共 STUN
        offerTtlMs: 1800000       # 配对码有效期（仅提示）
        dataDir: ''               # 默认 <DSH_HOME>/remote-control
```

Windows 首次监听会弹防火墙提示，需要放行 `45871/tcp` 与 `45873/udp`。

## 中继兜底

双方都在对称 NAT / CGNAT 后面时打洞会失败。在一台公网可达的机器上跑自带中继（纯 Node，无依赖）：

```powershell
node relay/relay.js --port 45880 --token <共享口令>
```

把地址与口令填进 `config.relay`，重新生成配对码即可。中继只转发密文。

## 安全模型

* **握手**：X25519 ECDH，`HMAC-SHA256(配对密钥, "dshr1/c" ‖ …)` 双向证明；密钥 `= HKDF(ECDH ‖ 配对密钥)`。中继与中间人都无法伪造或解密。
* **传输**：AES-256-GCM，每帧独立随机 nonce 与认证标签；分片认证失败即丢弃。
* **路径**：所有文件路径限制在 `roots` 内，越界返回 `forbidden-path`。
* **设置页 API**：复用 Harness 自身鉴权（`connection.requestRejection`），未登录请求 401。
* **撤销**：轮换配对密钥并断开全部客户端，旧配对码立即失效。

边界（请务必知晓）：

* 配对码是**长期共享密钥**（存于 `dataDir/identity.json`），不是每设备密钥；拿到码的人在你撤销之前都能连；
* 没有设备审批弹窗、没有访问日志、没有频率限制；
* 协议版本固定为 1，没有重协商或前向保密的密钥更新。

## 已知限制与路线图

| | 状态 |
| --- | --- |
| TCP 直连、UDP 打洞、TCP 中继三条链路 | 已自动化测试（`test/e2e.mjs`） |
| 真实公网 STUN 探测（cone NAT） | 已在本机实测 |
| 跨两个不同 NAT 的真实打洞 | **未验证**（只有回环验证） |
| 中继跑在真实公网机 | **未验证** |
| 设置页渲染 | 用极简 React 运行时做过无头渲染断言，**未做像素级验证** |
| 配对二维码 | 无头测试里用 jsQR 反向解码成功（含 870 字节真实配对码） |
| 鸿蒙 SDK | 未在 DevEco 编译验证 |

路线图：

- [x] 设置页内直接渲染配对二维码（内置 QR 编码器，无依赖）
- [ ] 每设备密钥 + 首次连接审批 + 访问日志
- [ ] 文件传输的并行流 / 压缩
- [ ] 侧边栏一键入口与「远程在线」状态胶囊
- [ ] 公网中继的 Dockerfile 与一键部署脚本

## 开发与测试

```powershell
node test/e2e.mjs           # TCP / UDP 打洞 / 中继 三条路径
node test/plugin-smoke.mjs  # 插件入口、6 个工具、HTTP 路由
node test/panel-render.mjs  # 设置页无头渲染（首屏 + 空状态，中文）
$env:PANEL_LANG='en'; node test/panel-render.mjs   # 英文文案
node test/qr.mjs            # 配对二维码的结构与版本

# 可选：用 jsQR 把生成的位图反向解码，证明真能扫
$env:JSQR_PATH="$env:TEMP\jsqr.js"; node test/qr.mjs
```

无构建步骤、无运行时依赖：全部是 Node 标准库（`node:crypto` / `node:dgram` / `node:net`）。浏览器侧只有一个不打包的 `client.js`。

## 目录结构

```
index.js                 Host 插件入口：配置、6 个工具、/dsh-remote HTTP API
client.js                设置页「远程访问」（不打包的浏览器模块）
lib/channel.js           握手 + AEAD 帧 + 分片
lib/link-tcp.js          TCP 消息链路
lib/link-udp.js          可靠 UDP（序号/ACK/重传/乱序缓存/保活）
lib/stun.js              STUN 公网端点探测
lib/server.js            监听、配对、打洞、中继、peer 管理
lib/rpc.js               文件 / 会话 / 隧道 RPC
lib/client.js            参考客户端（连接编排 + RPC）
relay/relay.js           独立中继进程
tools/remote-client.mjs  CLI 客户端
client/arkts/            鸿蒙（ArkTS）客户端 SDK
docs/PROTOCOL.md         完整线协议
test/                    传输、插件入口、设置页渲染测试
```

## License

[MIT](LICENSE) © 2026 StarsHTYL

---

## English

`dsh-remote-control` turns a desktop DeepSeek Harness into a remotely controllable node. It ships its own NAT traversal (STUN discovery + UDP hole punching), an end-to-end encrypted tunnel (X25519 + AES-256-GCM), and a JSON-RPC surface for files, sessions and raw port forwarding — no EasyTier, WireGuard or Tailscale required.

Pair once with a `dshr1.…` code, then drive the machine from the reference Node client, a HarmonyOS app ([ArkTS SDK](client/arkts/RemoteTunnel.ets)), or the full Harness UI inside a WebView. The wire protocol is documented in [docs/PROTOCOL.md](docs/PROTOCOL.md).

Licensed under MIT.
