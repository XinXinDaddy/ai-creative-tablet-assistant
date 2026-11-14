# 🎨 AI 创作平板助手 (AI Creative Tablet Assistant)

一个专为 **多模态 AI Agent 协同对话** 打造的跨端视觉标注与手绘工具。  
通过 **Windows 剪贴板 ⇄ 局域网 WebSocket ⇄ 安卓平板全屏 PWA 画布**，把你的安卓平板变成 PC 的无线手绘交互屏：

> **PC 截图 (`Win+Shift+S`) / 复制图片 ➔ 平板手写笔圈注、填色、连续折线、①②③ 编号 ➔ 自动写回 PC 系统剪贴板 ➔ 在 AI 聊天框直接 `Ctrl + V` 粘贴发送！**

---

## ✨ 核心特性

- **零安装门槛**：安卓平板无需安装 APK，使用 Chrome / Edge 扫码即用，支持「添加到主屏幕」以全屏 PWA 模式运行。
- **双向剪贴板无缝接力**：
  - **PC ➔ 平板**：支持一键读取 Windows 剪贴板图片、一键唤起 `Win+Shift+S` 区域截图直达平板、拖拽/`Ctrl+V` 传图，以及可选的「自动同步 PC 剪贴板新图片」。
  - **平板 ➔ PC**：支持「落笔自动同步」（停笔 0.45s 自动覆盖更新当前工程并写入 PC 剪贴板）与右下角悬浮按钮手动同步。
  - **防回环机制**：基于 Win32 `GetClipboardSequenceNumber()` 序列号 + GDI+ PNG 哈希校验与锁冲突自动重试，支持同时开启 PC 与平板双向自动同步而不产生死循环。
- **专为 AI 视觉提示词 (Visual Prompt) 优化的画布**：
  - **基础绘图**：压感画笔、荧光马克笔、直线、箭头、矩形框、椭圆框、橡皮擦、抓手平移。
  - **连续折线与磁吸闭合收口**：支持连续点击添加顶点，顶点数 `>= 3` 时点击绿色起点靶心自动闭合收口，可直接配合油漆桶填色。
  - **扫描线油漆桶填充**：自动识别底图与手绘层合成边界并支持容差调节。
  - **交互式裁剪**：框选并无损裁剪画布。
  - **AI 标注套件**：自动递增的 `① ② ③` 序号标记、高对比度文字批注标签，回传后在 PC 控制台自动生成 Prompt 草稿模板。
  - **手写笔防误触**：开启后仅手写笔可绘画，单指触摸自动变为平移画布，双指捏合自由缩放。
- **非破坏性分层工程保存**：
  - 本地 `history/projects/<projectId>/` 自动分 4 份保存：
    - `base.png`：原始纯净底图
    - `draw.png`：额外绘制透明图层
    - `merged.png`：叠加合成图（专用于写入 PC 系统剪贴板）
    - `meta.json`：元数据与独立矢量笔画栈 (`strokeRecords`)
  - 再次发回平板编辑时，可在平板「📑 笔画与标记」面板**逐条移除之前添加的笔画/标记**，或在 PC 端一键「🧹 仅发纯净底图到平板」。

---

## 🚀 快速开始

### 环境要求
- **PC 端**：Windows 10 / 11（内置 PowerShell）+ [Node.js](https://nodejs.org/)（推荐 v18+）
- **平板端**：安卓平板（与 PC 处于同一局域网 / Wi-Fi 下），内置 Chrome / Edge 等现代浏览器

### 安装与启动

```bash
# 1. 克隆仓库
git clone <你的仓库地址>
cd AI创作平板助手

# 2. 安装依赖
npm install

# 3. 启动服务（或直接双击根目录下的 启动AI创作助手.bat）
npm start
```

启动后：
1. 在 PC 浏览器访问 `http://localhost:3680/pc` 打开 **PC 协同控制台**；
2. 用安卓平板浏览器扫描控制台左侧二维码（或访问控制台显示的局域网地址 `http://<你的局域网IP>:3680/tablet`）；
3. 开始截图、手绘标注，完成后直接切换到你的 AI Agent 聊天框按 `Ctrl + V` 粘贴图片即可。

---

## 📁 项目结构

```text
├── server.js                 # Node.js HTTP + WebSocket 服务、分层工程存储与剪贴板调度
├── clipboard-bridge.ps1      # 常驻内存的 Windows -STA PowerShell 剪贴板高速桥接器
├── 启动AI创作助手.bat          # Windows 一键启动脚本
├── package.json              # 项目依赖配置 (ws, qrcode)
└── public/
    ├── pc.html               # PC 端协同控制台
    ├── tablet.html           # 安卓平板端全屏画布 PWA
    └── manifest.json         # PWA 清单配置
```

---

## ⚠️ 安全与隐私提示

- 本工具为本地局域网明文 HTTP / WebSocket 服务（默认端口 `3680`），**请仅在个人或受信任的局域网 Wi-Fi 环境下使用**，勿将端口直接暴露至公网。
- `.gitignore` 已默认忽略 `history/` 与 `node_modules/`，不会将本地截图与工程缓存提交到 Git 仓库。

## 📄 License

[MIT](LICENSE)
