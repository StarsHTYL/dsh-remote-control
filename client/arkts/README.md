# 鸿蒙客户端（ArkTS）

`RemoteTunnel.ets` 是 `docs/PROTOCOL.md` 的 ArkTS 参考实现：配对码解析、X25519 握手、
AES-GCM 分片信道、可靠 UDP、TCP/中继链路、RPC 调用以及文件上传/下载。

## 接进工程

1. 把 `RemoteTunnel.ets` 放进 `entry/src/main/ets/` 下的任意目录。
2. `module.json5` 申请权限：

   ```json
   "requestPermissions": [
     { "name": "ohos.permission.INTERNET" }
   ]
   ```

   读本地相册/文件用于上传时，再按需要加 `ohos.permission.READ_IMAGEVIDEO` 或使用
   `photoAccessHelper` / `picker` 拿到文件 URI。

3. 扫描或粘贴 `dshr1.…` 配对码：

   ```ts
   const tunnel = new RemoteTunnel()
   await tunnel.connect(code)
   const info = await tunnel.call('sys.info')
   tunnel.on('session.frame', (payload) => { /* 实时消息流 */ })
   await tunnel.upload(sandboxPath, path.join(info.roots[0].path, 'photo.jpg'))
   ```

## 状态

* 协议逻辑（握手、分片、序号/ACK/重传、RPC 编解码）与 Node 参考实现逐条对应。
* **未在 DevEco / 真机上构建验证**：`@kit.CryptoArchitectureKit` 的
  `convertPemKeySync`、`createKeyAgreement('X25519')`、`Mac('SHA256')` 等签名在
  API 12/13/14 之间有细微差别，接进工程后请以编译器提示为准。
* 二维码生成/扫描不在本文件内，建议用 `@kit.ScanKit` 的 `scanBarcode` 或
  `@kit.ScanKit` 默认扫码页；配对码本身就是二维码要承载的字符串。
